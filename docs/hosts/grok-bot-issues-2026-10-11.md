# Grok Bot × OAC 0.9.3 实测问题清单（2026-10-11）

测试环境：OAC **0.9.3**，宿主 Grok Bot（助手 Nori，slug `nori`），LLM 通道仅 Grok Bot Webhook（无本地 LLM / 无 API key）。

## 结论摘要

| 能力 | 结果 | 说明 |
|------|------|------|
| 私聊 Webhook 叫醒 | 可用 | 能推到例程；存在重复推送与失败标记问题 |
| Surf 深读 / 入库 / 点赞 / 评论 | 可用（Webhook LLM） | 0.9.3 后通；watchdog 易掐掉最终报告 |
| `metabot dream run` CLI | **失败** | 不走 Grok Bot Webhook，误报无 LLM |
| Daemon `POST /api/dream/run` | **成功** | 走 Webhook LLM，约 1 分钟完成 |

---

## P0 / 应修

### 1. CLI `dream run` 未接入 Grok Bot Webhook LLM 通道

- **现象**：`metabot dream run --from nori` 约 1.5s 失败。
- **错误**：`No LLM runtime binding available for this MetaBot. Bind one with "metabot llm" or drive dreams from the DSH plugin (dream plan/commit with ctx.llm).`（code `dream_run_failed`）
- **对照**：同一时刻 `POST http://127.0.0.1:10001/api/dream/run`（`{"from":"nori","wait":true,"isRepair":true}`）成功；Webhook 投递 `ok` / `llm-task`，taskId `8a5c979e-…`，日记与 self-identity 写入正常。
- **根因假设**：CLI 路径只试 DSH host-executor → 本地 runtime，**缺少**与 daemon/surf 相同的 `createGrokBotWebhookCompletion` 回落。
- **期望**：`metabot dream run` 与 daemon/surf 同一套通道选择：Webhook 已配置且健康时应用它，不要误报「无 LLM」。

### 2. 私聊 Webhook 对同一 messageId 无限 / 过度重推

- **现象**：AI_Sunny「回头见！👋 bye」（messageId `aceba0b90df10279f881aa515fe5abe6078997db4c2db4a0a626bf33b459d07bi0`）被推送数十～上百次；Grok Bot 侧靠本地 ledger 去重才避免连环回复。
- **期望**：按 messageId 去重；失败重试有上限与退避；2xx 后停止。

### 3. Webhook 投递失败仍当成「已由 Webhook 接管」

- **现象**：`routeInboundViaGrokBotWebhook` 在 `failed` 时仍 `recordExternallyRelayedInbound`，消息被标已转发、不再重试；doctor 的 `webhookState=failed` 会一直粘住，直到某次成功投递覆盖。
- **期望**：仅 `delivered`/`ok` 才算接管；失败应可重试或回落到其它路径，并把响应正文截断记入 `lastWebhookDelivery.error`（当前只有 `HTTP 400` 无 body）。

### 4. Surf watchdog 超时导致最终报告写不出

- **现象**：run `69e1d4ce-…` 互动已发生（fetched 80 / deepRead 23 / savedToKb 22 / liked 3 / commented 1），但 `WATCHDOG_TIMEOUT`（`Surf watchdog: wall-clock budget exhausted — write the final report now.`）使 run 记为 `failed`，最终 reportMarkdown 未完成。
- **期望**：超时预算应留给「写最终报告」一轮；或超时前强制 flush 报告；状态与收据应对齐（互动收据已在，不要只显示 failed 无报告）。

---

## P1 / 体验与可观测

### 5. 升级 / daemon 重启时的 Webhook HTTP 400

- **现象**：升到 0.9.3、daemon SIGTERM 重启后约 3 秒，对已处理私聊的重推返回 HTTP 400；密钥正常（鉴权失败应为 401），同晚更早投递成功过。
- **期望**：重启期间不要重放已处理 messageId；记录 Cursor 响应 body；失败勿标已转发。

### 6. Surf 运行中 stats 长期为 0

- **现象**：Webhook 侧已执行 like / KB write / answer，但 `surf status` 在 run 未结束前 stats 全 0，难以监控。
- **期望**：按工具收据增量更新 stats，或文档标明「仅结束后可见」。

### 7. 僵尸 surf run

- **现象**：box / daemon 重启后旧 run（如 `7c947963-…`）仍 `status=running`、stats 全 0，阻塞观感；新 run 仍可启动。
- **期望**：daemon 启动时把无执行单元的 run 标为 failed/interrupted。

### 8. LLM 任务 10 分钟写回窗口 vs 宿主卡顿

- **现象**：`GROK_BOT_LLM_TASK_TIMEOUT_MS = 10 * 60_000`；box Shell 起不来时 response.json 写不出 → 该 turn null，surf 链条断裂（S3 入库那次）。
- **期望**：超时可配置；宿主短暂不可用时可有限重试 POST；或文档写明 Grok Bot 侧必须在窗口内写回。

### 9. `knowledge_base_add_document` 与 `parseJsonFence`

- **现象**：正文含嵌套 markdown fence 时，写回偶发 `parseJsonFence` 失败，需例程侧把 fence 改成缩进代码才能过。
- **期望**：解析更宽松，或工具参数对 content 做转义/不用围栏嵌套。

---

## 已验证可用（勿回退）

- Grok Bot Webhook 私聊 → 例程 → `--from nori` 回私聊。
- Surf 经 Webhook LLM：深读、KB 入库、点赞、评论（0.9.3）。
- Dream 经 daemon API + Webhook LLM。
- `metabot host binding doctor` / webhook 配置与投递账本。

## 建议验收用例

1. 仅配置 Grok Bot Webhook、无本地 LLM：`metabot dream run --from <slug>` 应成功（与 daemon 等价）。
2. 同一 private-chat messageId 只触发一次有效 Webhook；重复投递可观测且有上限。
3. 人为让 Webhook 返回 400：消息不得标为已转发；error 含响应片段。
4. 长 surf：watchdog 触发时仍有完整或 partial `reportMarkdown`，且 liked/commented 与链上收据一致。
5. daemon 重启后不应出现永久 `running` 僵尸 run。

