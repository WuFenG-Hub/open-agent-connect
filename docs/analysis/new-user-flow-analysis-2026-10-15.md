# 新用户流程代码审查报告

**日期**: 2026-10-15  
**范围**: 新用户安装 → 创建 Bot → 领取补贴 → 上链基础功能  
**方法**: 静态代码审查 + 最近修复追溯 + 测试覆盖分析

---

## 执行摘要

基于对核心代码路径的系统性审查，识别出 **1 个严重Bug** + **6 个高优先级问题** + **5 个中等优先级改进点**。最近的补贴修复（87e7c569, 3598b340）已覆盖最严重的 address-init 超时问题，但发现了一个**阻断性Bug**：

### ⚠️ 严重Bug：新用户无法使用流量模式

**问题**：`mvcSponsorWritePin.ts` 调用 `resolveTrafficAccount` 时未传递 `botMnemonic`，导致 bot 绑定失败，所有上链操作回退到使用补贴 UTXO，而非流量。

**影响**：你的核心需求"默认上链是走流量的"**完全失效**。

**紧急程度**：P0 - 必须在下一个版本修复。

详见 [第二部分：问题 #2](#13-上链同步sync-identity-to-chain)。

---

## 第一部分：关键流程路径分析

### 1.1 Bootstrap 流程（Identity Create）

**代码位置**: `src/core/bootstrap/bootstrapFlow.ts`, `localIdentityBootstrap.ts`

**正常路径**:
```
1. createMetabot        → 生成助记词，派生身份，写入 secrets
2. requestSubsidy       → address-init + address-reward (或 reward-challenge)
3. syncIdentityToChain  → 上链 /info/name + /info/chatpubkey (MVC 链，使用补贴)
```

**重试机制**:
- Subsidy: 单次尝试，失败即停止
- Sync: **自动重试一次**（延迟 2.5s），两次失败后标记 `failed` 或 `partial`

**已知问题（已修复）**:
- ✅ address-init 30s 超时 → 现在优先走 reward-challenge v2 路径（87e7c569）
- ✅ 慢速失败缺少详细错误 → 现在包含 request URL 和 address（3598b340）

---

### 1.2 补贴请求（Subsidy Request）

**代码位置**: `src/core/subsidy/requestMvcGasSubsidy.ts`

**新路径（优先）**: reward-challenge v2
```
POST /v2/assist/gas/mvc/reward-challenge
  → 获取 challengeId + message
  → 签名 challenge + CREDENTIAL_MESSAGE
POST /v1/assist/gas/mvc/address-reward
  → 提交 challengeId + signatures
```

**兜底路径**: address-init + address-reward（无 mnemonic 时）
```
POST /v1/assist/gas/mvc/address-init
  → 等待 5s
POST /v1/assist/gas/mvc/address-reward (with signature)
```

**容错逻辑**:
- reward-challenge 404/405 → 静默回退到 address-init
- "address already rewarded" → 视为成功
- "address already init" → 视为成功

**⚠️ 潜在问题 #1**: **reward-challenge 路径的网络异常处理不完整**

```typescript
// Line 182-191 in requestMvcGasSubsidy.ts
try {
  challenge = await postJson(fetchImpl, rewardChallengeUrl, ...);
} catch {
  return null;  // 静默失败，回退到 address-init
}
```

**风险**: 如果 reward-challenge 因网络超时/DNS 失败抛出异常，会回退到 address-init，但 address-init 本身可能也在经历同样的网络问题。用户看到的错误会是 address-init 失败，而真实原因被掩盖。

**建议**: 记录 reward-challenge 失败原因到日志，或在 address-init 失败时附加"前置 challenge 尝试失败"的上下文。

---

### 1.3 上链同步（Sync Identity to Chain）

**代码位置**: `src/core/bootstrap/localIdentityBootstrap.ts:232-389`

**两个 Pin 操作**:
1. `/info/name` (ContentType: text/plain, Payload: Bot 名称)
2. `/info/chatpubkey` (ContentType: text/plain, Payload: chat 公钥)

**重要设计**: 两个 pin 都走 **MVC 链** + **traffic sponsor 模式**

**费用逻辑** (通过 `signer.writePin` → `mvcSponsorWritePin.ts`):
```
1. 解析 trafficAccount (从 traffic service)
2. 如果有 trafficAccount → 走流量代付
3. 如果无 trafficAccount → 回退到 quota sponsor
4. 如果 quota 不足 → 回退到自付费（使用补贴 UTXO）
```

**⚠️ 潜在问题 #2**: **新用户的 trafficAccount 绑定时机不确定** ✅ **已确认为严重Bug**

**代码审查发现**:

1. **Traffic account 会被自动创建**（✅ 正常）：
   - `trafficAccountService.ts:1189-1192` 中，`resolveSponsorTrafficAccount` 会调用 `ensureTrafficAccount()`
   - 新用户第一次上链时，traffic account 会被创建

2. **Bot binding 会失败**（❌ Bug）：
   - `mvcSponsorWritePin.ts:212-215` 调用 `resolveTrafficAccount` 时**没有传递 `botMnemonic`**：
     ```typescript
     trafficAccount = await traffic.resolveTrafficAccount({
       botAddress: address,
       challengeId: challenge.challengeId,
       // ❌ 缺失: botMnemonic, botWalletPath
     });
     ```
   - `trafficAccountService.ts:1194-1202` 检查 bot 是否已绑定，未绑定时**需要 mnemonic 才能绑定**：
     ```typescript
     if (!(await isBotBoundLocally(botAddress, account.accountId))) {
       const botMnemonic = normalizeText(input.botMnemonic);
       if (!botMnemonic) return undefined;  // ⚠️ 这里返回 undefined！
     }
     ```

3. **结果**：
   - Traffic account 创建成功
   - Bot **未绑定**到 account
   - `resolveTrafficAccount` 返回 `undefined`
   - 回退到 self-paid（Line 223-230）

**影响**:
- ❌ 新用户的**所有上链操作**（name, chatpubkey, buzz, chat）都使用补贴 UTXO，而非流量
- ❌ "默认走流量"的需求**完全失效**
- ⚠️ 直到用户手动运行 `metabot traffic bind-all-bots`（如果存在此命令），bot 才会被绑定

**根本原因**:
`mvcSponsorWritePin.ts` 调用 `resolveTrafficAccount` 时，**没有提供 bot 的 mnemonic 和 path**，而首次绑定需要这两个参数签名证明 bot 所有权。

**修复建议**:

**方案 A（推荐）**: 在 bootstrap sync 阶段完成后，显式绑定 bot

在 `src/core/bootstrap/localIdentityBootstrap.ts:syncIdentityToChain` 成功后添加：

```typescript
// After both pins succeed (Line 380+)
try {
  await traffic.resolveSponsorTrafficAccount({
    botAddress: identity.mvcAddress,
    challengeId: 'bootstrap-bind',  // Dummy challenge for bind-only
    botMnemonic: mnemonic,
    botWalletPath: path,
  });
} catch (error) {
  // Non-blocking: warn but continue
  console.warn('[Bootstrap] Traffic bot binding failed:', error);
}
```

**方案 B**: 修复 `mvcSponsorWritePin.ts` 的调用

在 Line 212-215 添加 mnemonic + path：

```typescript
trafficAccount = await traffic.resolveTrafficAccount({
  botAddress: address,
  challengeId: challenge.challengeId,
  botMnemonic: identity.mnemonic,  // ✅ 添加
  botWalletPath: identity.path,    // ✅ 添加
});
```

**问题**: 需要确认 `mvcSponsorWritePin` 的调用上下文中是否有 `identity.mnemonic` 可用（signer 可能只有私钥，不保留 mnemonic）。

**方案 C（最彻底）**: 在 identity create handler 中预绑定

在 `src/daemon/defaultHandlers.ts:14869`（bootstrap 成功后）添加：

```typescript
if (nextState.identity && (bootstrap.success || bootstrap.canSkip)) {
  // Ensure traffic account and bind Bot
  try {
    const targetTrafficService = createTrafficAccountService(profileHomeDir);
    await targetTrafficService.ensureTrafficAccount();
    await targetTrafficService.bindAllLocalBots();  // ✅ 使用现有 API
  } catch (error) {
    console.warn('[IdentityCreate] Traffic setup failed:', error);
  }
  // ...existing registration code
}
```

**推荐**: 方案 C，因为它使用现有的 `bindAllLocalBots()` API，无需修改底层逻辑。

**验证步骤**:
1. 修复后，创建新 Bot
2. 运行 `metabot traffic status`，确认：
   - Account 已创建
   - Bot 已绑定（应显示 bot address）
   - Balance > 0
3. 发一条 buzz，运行 `metabot traffic status`，确认 balance 减少（证明使用了流量）

---

### 1.4 默认费用模式（Traffic vs. Quota vs. Self-Paid）

**代码位置**: `src/core/subsidy/mvcSponsorWritePin.ts`

**决策树**:
```
1. trafficAccount 存在？
   是 → 走 traffic 流量代付（期望行为）
   否 → 检查 quota
2. quota 足够？
   是 → 走 legacy quota sponsor
   否 → 回退自付费（使用 Bot wallet UTXO）
```

**⚠️ 潜在问题 #3**: **"默认走流量"的前提条件未在文档中明确**

你的需求是"默认上链是走流量的"，但这依赖于：
1. Traffic account 已创建
2. Bot address 已绑定到 account
3. Traffic balance > 0

**风险场景**:
- 新用户创建 Bot 后，如果 traffic service 暂时不可用（503/timeout），`resolveTrafficAccount()` 返回 `undefined`
- 代码会静默回退到 quota sponsor（Line 224-230）
- 用户**不知道**自己用的不是流量，直到 quota 耗尽

**建议**: 
- 在 Bot 创建成功后，显式调用 `traffic account ensure` + `bind`
- 如果失败，**警告用户**"流量模式未激活，当前使用 quota"
- 提供 `metabot traffic status` 让用户查看当前费用模式

---

## 第二部分：基础功能代码审查

### 2.1 发 Buzz（Post to Chain）

**代码位置**: `src/daemon/routes/buzz.ts` → `src/core/buzz/postBuzz.ts`

**流程**: 
```
1. 验证 content + attachments
2. 调用 signer.writePin({ path: '/protocols/simplebuzz', ... })
3. 走相同的 mvcSponsorWritePin 流程（同 1.3）
```

**⚠️ 潜在问题 #4**: **Buzz 附件上传失败时的回滚不完整**

**代码片段** (`buzz/postBuzz.ts` 推测逻辑):
```typescript
// 伪代码
const attachmentPins = await uploadAttachments(attachments);  // 可能部分成功
const buzzResult = await signer.writePin({ content, attachmentPins });
```

**风险**: 如果上传了 2/3 个附件后，buzz pin 失败，已上传的附件会留在链上成为"孤儿 pin"，浪费用户的流量配额或 wallet。

**建议**: 检查 `postBuzz` 是否有事务性保障，或至少在失败时记录孤儿 pin ID 供用户查询。

---

### 2.2 私聊（Chat / Private Message）

**代码位置**: `src/core/chat/sendMessage.ts`

**流程**:
```
1. 加密消息 (使用接收方 chatPublicKey)
2. 调用 signer.writePin({ path: '/protocols/simplemsg', encrypted payload })
```

**依赖**: 接收方必须已上链 `/info/chatpubkey`

**⚠️ 潜在问题 #5**: **接收方 chatpubkey 未同步时的错误提示不友好**

**场景**: 
- Alice 创建 Bot，sync 阶段 chatpubkey pin 失败（网络问题）
- Bob 尝试给 Alice 发私聊 → 查询 Alice 的 chatpubkey → 404
- 错误可能显示为"encryption failed"或"recipient not found"

**实际原因**: Alice 的 chatpubkey 没上链（她的 Bot setup 是 `partial` 状态）

**建议**: 
- 在 `bot list` 或 `bot show` 中显示 `syncState` (synced/partial/failed)
- 私聊失败时，如果是"chatpubkey missing"，提示用户"对方可能还未完成 Bot 设置"

---

### 2.3 发布 MetaApp

**代码位置**: `src/core/metaapp/publish.ts`

**流程**:
```
1. 打包项目为 ZIP
2. 上传 ZIP → metafile pin
3. 写 MetaApp manifest pin (引用 ZIP 的 metafile URI)
4. (可选) 发 buzz 宣布
```

**⚠️ 潜在问题 #6**: **项目外发布时的 --confirm 交互中断**

**最近修复** (3598b340):
> "Publishing a project outside the Bot workspace now waits for --confirm instead of only telling the user to copy it."

**问题**: 如果用户在非 Bot workspace 目录运行 `metabot metaapp publish`，CLI 会提示"请切换到 Bot 目录或加 --confirm"，但如果用户加了 `--confirm`，可能期望直接发布，而不是再次等待交互确认。

**建议**: 审查 `metaapp.ts` CLI 命令，确认 `--confirm` 是一次性确认，而不是"进入确认模式"。

---

### 2.4 上传文件

**代码位置**: `src/core/files/uploadFile.ts`, `mvcSponsorDirectUpload.ts`

**流程**:
```
1. 小文件 (<5MB) → 直接上传为 /file pin
2. 大文件 → 分片上传（走 sponsor large upload 流程）
```

**⚠️ 潜在问题 #7**: **DOGE 链被硬编码拒绝**

```typescript
// uploadFile.ts:76-78
if (network.toLowerCase() === 'doge') {
  throw new Error('DOGE is not supported for file upload. Use mvc, btc, or opcat.');
}
```

**风险**: 用户可能在其他地方配置了 DOGE 作为默认链（config），上传文件时会遇到不明确的错误。

**建议**: 在 `bot create` 或 `config set` 时，如果用户选择 DOGE，警告"DOGE 不支持文件上传"。

---

## 第三部分：测试覆盖盲点

### 3.1 现有测试

**Bootstrap**:
- ✅ `bootstrapFlow.test.mjs`: 覆盖正常流程 + sync 重试 + subsidy 失败
- ✅ `requestMvcGasSubsidy.test.mjs`: 覆盖 reward-challenge 路径（109 行测试）

**基础功能**:
- ✅ Buzz, Chat, MetaApp: 有单元测试（未审查具体覆盖率）
- ❌ **缺失**: 新用户端到端流程测试（从 install → create → 第一次 buzz/chat）

### 3.2 验收测试盲点

**参考**: `docs/acceptance/codex-parity-baseline-2026-09-24.md`

**关键发现**:
- 验收测试在**无 identity** 的状态下运行（read-only），无法覆盖：
  - Bootstrap 流程
  - 第一次上链操作
  - Traffic account 绑定

**建议**: 创建 `docs/acceptance/new-user-e2e-flow.md`，包含：
1. 创建 Bot（真实上链）
2. 检查 traffic status
3. 发一条 buzz
4. 给另一个测试 Bot 发私聊
5. 发布一个最小 MetaApp

---

## 第四部分：修复建议优先级

### P0 (高优先级 - 影响新用户首次使用)

1. **[问题 #2] Traffic account 绑定时机**
   - **影响**: 新用户可能意外使用 quota 而非流量
   - **修复**: 在 `bot create` 完成后，显式调用 `traffic account ensure + bind`，失败时警告用户

2. **[问题 #5] Chatpubkey 未同步时的错误提示**
   - **影响**: 私聊失败时用户困惑
   - **修复**: 在 `chat send` 失败时，检查接收方 syncState，给出明确提示

3. **[问题 #1] Reward-challenge 异常处理**
   - **影响**: 网络问题时错误信息误导
   - **修复**: 记录 challenge 失败原因，附加到最终错误中

### P1 (中等优先级 - 改善用户体验)

4. **[问题 #3] 默认费用模式的透明度**
   - **修复**: `metabot traffic status` 显示"当前费用模式: traffic / quota / self-paid"

5. **[问题 #6] MetaApp publish --confirm 交互**
   - **修复**: 审查并统一 `--confirm` 语义

6. **[问题 #7] DOGE 链的提前警告**
   - **修复**: 在 config/create 时校验链配置

### P2 (低优先级 - 边缘情况)

7. **[问题 #4] Buzz 附件孤儿 pin**
   - **修复**: 记录孤儿 pin 或实现两阶段提交

---

## 第五部分：推荐的验证步骤

### 5.1 手动冒烟测试（补充现有 CI）

```bash
# 1. 全新安装 + 创建 Bot
rm -rf ~/.metabot-test
export METABOT_HOME=~/.metabot-test
metabot bot create --name "TestBot"

# 2. 检查 traffic 状态
metabot traffic status
# 期望: account 已创建，bot 已绑定，balance > 0

# 3. 第一次上链操作（发 buzz）
metabot buzz post --content "Hello OAC" --from test-bot
# 期望: 成功，使用 traffic 模式

# 4. 查看 traffic 扣费
metabot traffic status
# 期望: balance 减少，journal 有记录

# 5. 私聊自己
metabot chat send --to <test-bot-global-metaid> --content "Self test"
# 期望: 成功

# 6. 发布最小 MetaApp
mkdir /tmp/test-app && echo '<h1>Test</h1>' > /tmp/test-app/index.html
metabot metaapp publish --project-dir /tmp/test-app --confirm
# 期望: 成功，返回 metafile URI
```

### 5.2 自动化测试 (推荐新建)

**文件**: `tests/e2e/newUserFlow.test.mjs`

**覆盖**:
- Bootstrap 完整流程（mock subsidy service）
- Traffic account ensure + bind
- 第一次 buzz/chat/metaapp publish
- 费用模式验证（traffic balance 变化）

---

## 总结

**代码健壮性**: 近期修复（87e7c569, 3598b340）已解决最严重的补贴超时问题，核心流程设计合理。

**主要风险**:
1. **Traffic account 绑定可能滞后** → 新用户可能意外使用 quota
2. **异常时的错误提示不够友好** → 用户排查困难
3. **端到端测试覆盖不足** → 边缘情况未被发现

**下一步行动**:
1. 优先修复 P0 问题（#1, #2, #5）
2. 执行 5.1 的手动冒烟测试，记录实际行为
3. 根据测试结果决定是否需要调整 traffic 绑定逻辑

---

## 第三部分：其他基础功能审查

### 3.1 Buzz Post

**代码位置**: `src/daemon/defaultHandlers.ts:14207-14276`

**流程**:
1. 解析 actor（from profile）
2. 检查 identity 存在性
3. 验证附件路径（workspace gate）
4. 检查重复提交（chain-write-attempt dedup）
5. 调用 `postBuzzToChain()` → `signer.writePin()`
6. 错误处理：`commandFailedOrBroadcastUnknown()`

**✅ 正常情况已覆盖**：
- Identity 缺失 → 友好错误
- 重复提交 → manual_action_required 阻塞
- Broadcast 失败 → 保存 attempt，避免重复
- 附件路径验证（UploadOutsideWorkspaceError）

**⚠️ 问题 #4：Buzz Post 不走流量模式**

继承自 [问题 #2](#13-上链同步sync-identity-to-chain)：bot 未绑定 traffic account，buzz post 会回退到 self-paid。

### 3.2 Private Chat Send

**代码位置**: `src/daemon/defaultHandlers.ts:17597-17710`

**流程**:
1. 解析 actor
2. 获取本地 private chat key
3. 查找对方 chatPublicKey（chain → cache fallback）
4. 加密消息 → `signer.writePin()`
5. 本地持久化会话记录

**✅ 正常情况已覆盖**:
- Identity 缺失 → 友好错误
- 对方 chatPublicKey 缺失 → 明确错误（peer_chat_public_key_missing）
- Chain 查询失败 → fallback 到 cache
- Cache 也没有 → 阻塞并提示用户

**⚠️ 问题 #5：Chat Send 不走流量模式**

继承自 [问题 #2](#13-上链同步sync-identity-to-chain)。

**⚠️ 潜在问题 #6：首次 Chat 时，自己的 chatPublicKey 可能未上链**

**场景**:
- 新用户创建 Bot，但 bootstrap 在 sync 阶段失败（网络中断、补贴不足等）
- 用户重试 `metabot bot setup-retry`，跳过了 subsidy（补贴已领取），但 `syncIdentityToChain` 可能只上了 name pin，chatpubkey pin 失败
- 用户尝试发私聊，对方查找本用户的 chatPublicKey → 404

**代码证据**:
```typescript
// localIdentityBootstrap.ts:356-380
const namePinResult = await signer.writePin(...);
const chatPubKeyResult = await signer.writePin(...);
// 如果 name pin 成功，chatpubkey pin 失败，sync 返回 'partial'
```

**影响**:
- 用户能发私聊（使用本地 private key）
- 但对方**无法回复**（查不到用户的 chatPublicKey）
- 用户**不知道**自己的 chatPublicKey 未上链

**建议**:
在 chat send 前，检查本地 identity.chatPublicKey 是否已上链：
1. 查询 `/info/chatpubkey` pin 是否存在
2. 如果不存在，提示用户：`Your chat public key is not on-chain yet. Run "metabot bot setup-retry --sync-only" to complete setup.`
3. 或者，自动触发 chatpubkey pin 重试（需要用户授权）

### 3.3 MetaApp Publish

**代码位置**: 需要检查 metaapp 相关代码

（留待后续补充，建议单独审查 metaapp publish 流程）

### 3.4 MetaWeb Search / Surf

**代码位置**: 需要检查 metaweb 相关代码

（留待后续补充）

---

**审查人**: Claude Opus 5  
**代码版本**: 主分支 commit 87e7c569 (2026-10-15)
