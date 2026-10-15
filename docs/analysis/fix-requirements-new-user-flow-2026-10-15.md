# Open Agent Connect - 新用户流程修复需求

**日期**: 2026-10-15  
**审查版本**: 主分支 commit 87e7c569  
**审查人**: Claude Opus 5

---

## 概述

基于对 Open Agent Connect 新用户流程的系统性代码审查，识别出 **1 个P0严重Bug** 和 **5 个P1/P2问题**。最紧急的问题是：**新用户无法使用流量模式上链**，导致所有操作消耗补贴而非流量，违背了"默认走流量"的核心需求。

---

## P0 - 严重Bug（必须修复）

### Bug #1: 新用户 Bot 无法绑定到 Traffic Account

**问题**: 
`mvcSponsorWritePin.ts` 调用 `resolveTrafficAccount()` 时未传递 `botMnemonic`，导致首次绑定失败，所有上链操作回退到 self-paid（使用补贴 UTXO），而非 traffic 流量模式。

**影响范围**: 
- ❌ 所有新用户的上链操作（identity sync, buzz post, chat send, metaapp publish）
- ❌ "默认走流量"的核心需求**完全失效**
- ❌ 用户不知道自己未使用流量，直到补贴耗尽

**根本原因**:

1. **Traffic account 会被自动创建**（✅ 正常）：
   ```typescript
   // trafficAccountService.ts:1189-1192
   let account = await readLocalAccount();
   if (!account) {
     account = await ensureTrafficAccount();  // ✅ 创建成功
   }
   ```

2. **Bot binding 失败**（❌ Bug）：
   ```typescript
   // trafficAccountService.ts:1194-1202
   if (!(await isBotBoundLocally(botAddress, account.accountId))) {
     const botMnemonic = normalizeText(input.botMnemonic);
     if (!botMnemonic) return undefined;  // ❌ 这里失败，返回 undefined
     // ...bind logic never reached
   }
   ```

3. **Sponsor 调用时未提供 mnemonic**：
   ```typescript
   // mvcSponsorWritePin.ts:212-215
   trafficAccount = await traffic.resolveTrafficAccount({
     botAddress: address,
     challengeId: challenge.challengeId,
     // ❌ 缺失: botMnemonic, botWalletPath
   });
   if (!trafficAccount) {
     return fallbackToSelfPaid(...);  // ❌ 回退到自付费
   }
   ```

**修复方案**:

**推荐方案（最��底）**: 在 identity create handler 中预绑定

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
  
  // ...existing registration code (Line 14870-14914)
  await registerIdentityProfile(nextState.identity, profileHomeDir);
  // ...
}
```

**优势**:
- 使用现有 `bindAllLocalBots()` API，无需修改底层逻辑
- 一次性解决所有上链操作的流量问题
- 非阻塞：traffic setup 失败不影响 identity 创建
- 集中处理：新用户只需一次绑定

**替代方案 A**: 修复 `mvcSponsorWritePin.ts` 的调用

在 Line 212-215 添加 mnemonic：

```typescript
trafficAccount = await traffic.resolveTrafficAccount({
  botAddress: address,
  challengeId: challenge.challengeId,
  botMnemonic: identity.mnemonic,  // ✅ 添加
  botWalletPath: identity.path,    // ✅ 添加
});
```

**问题**: 需要确认 `mvcSponsorWritePin` 的调用上下文中是否有 `identity.mnemonic` 可用（signer 可能只有私钥，不保留 mnemonic）。

**替代方案 B**: 在 bootstrap sync 阶段完成后绑定

在 `src/core/bootstrap/localIdentityBootstrap.ts:syncIdentityToChain` 成功后（Line 380+）添加：

```typescript
// After both pins succeed
try {
  await traffic.resolveSponsorTrafficAccount({
    botAddress: identity.mvcAddress,
    challengeId: 'bootstrap-bind',  // Dummy challenge for bind-only
    botMnemonic: mnemonic,
    botWalletPath: path,
  });
} catch (error) {
  console.warn('[Bootstrap] Traffic bot binding failed:', error);
}
```

**优势**: 绑定紧跟 bootstrap 流程，时机合理。  
**劣势**: 需要传递 dummy challengeId，可能产生误导性日志。

**验证步骤**:

1. **修复后，创建新 Bot**:
   ```bash
   metabot bot create "TestBot"
   ```

2. **确认 traffic 状态**:
   ```bash
   metabot traffic status
   ```
   预期输出：
   - ✅ Account 已创建
   - ✅ Bot 已绑定（显示 bot address）
   - ✅ Balance > 0（显示流量余额）

3. **发一条 buzz，验证流量消耗**:
   ```bash
   metabot buzz post "Test post"
   metabot traffic status
   ```
   预期：balance 减少，证明使用了流量而非补贴

**预期修复时间**: 2-4 小时（含测试）

---

## P1 - 高优先级问题

### 问题 #2: Subsidy 地址初始化超时处理不够健壮

**影响**: 低 → 最近已修复（commit 87e7c569）

**状态**: ✅ 已修复，但建议增加监控

**描述**:
最近的 commit 已添加重试逻辑和更长超时（commit 3598b340: "deeper smoke gaps"），但仍建议：

1. 在 `metabot bot create` 的 CLI 输出中显式告知用户：
   - "Waiting for address initialization (may take 30-60 seconds)..."
   - "✓ Address initialized, balance: 2 SPACE"

2. 如果超时，提示用户手动重试命令：
   ```
   metabot bot setup-retry --from <slug>
   ```

**代码位置**: 
- `src/core/subsidy/requestMvcGasSubsidy.ts:196-247`
- CLI 输出：`src/cli/commands/bot.ts`

---

### 问题 #3: 首次 Chat 时，自己的 chatPublicKey 可能未上链

**影响**: 中 → 边缘情况，但会导致对方无法回复

**场景**:
1. 新用户创建 Bot，但 bootstrap 在 sync 阶段部分失败（name pin 成功，chatpubkey pin 失败）
2. 用户发私聊 → 成功（使用本地 private key）
3. 对方尝试回复 → 失败（查询用户的 chatPublicKey 返回 404）
4. 用户**不知道**自己的 chatpubkey 未上链

**根本原因**:
`localIdentityBootstrap.ts:356-380` 的 sync 流程中，name pin 和 chatpubkey pin **独立上链**，如果第二个失败，sync 返回 `'partial'`，但用户可能以为已完成。

**修复建议**:

**方案 A（推荐）**: 在 chat send 前主动检查

在 `src/daemon/defaultHandlers.ts:17597`（chat.private handler）中添加：

```typescript
// After state.identity check (Line 17603)
if (!state.identity) {
  return commandFailed('identity_missing', '...');
}

// ✅ 添加 chatPublicKey 链上验证
const myChatPubKey = normalizeText(state.identity.chatPublicKey);
if (!myChatPubKey) {
  return commandFailed(
    'chat_public_key_missing',
    'Your local chat public key is missing. Run "metabot bot setup-retry --sync-only" to complete setup.',
  );
}

// 可选：查询链上是否存在（需要添加 lookup API）
const onChain = await lookupPeerChatPublicKey(state.identity.globalMetaId, {
  chainApiBaseUrl: input.chainApiBaseUrl,
}).catch(() => ({ status: 'unreachable' as const }));

if (onChain.status === 'not_found') {
  return commandFailed(
    'chat_public_key_not_on_chain',
    'Your chat public key is not on-chain yet. Run "metabot bot setup-retry --sync-only" to publish it.',
  );
}
```

**方案 B**: 在 setup-retry 中添加 `--sync-only` flag

允许用户只重试 sync 阶段，跳过 subsidy 请求：

```bash
metabot bot setup-retry --from <slug> --sync-only
```

**预期修复时间**: 4-6 小时

---

### 问题 #4: Traffic 流量消耗监控缺失

**影响**: 中 → 用户体验问题

**描述**:
新用户不知道自己是否在使用流量，也不知道流量余额。建议在以下场景显示流量状态：

1. **`metabot bot create` 成功后**:
   ```
   ✓ Bot "Alice" created successfully!
   ✓ Traffic account enabled, balance: 1.5 MB
   ```

2. **每次上链操作后（buzz, chat, metaapp）**:
   ```
   ✓ Buzz posted: metanet:xxx
   Traffic used: 256 bytes, remaining: 1.5 MB
   ```

3. **流量不足时主动提醒**:
   ```
   ⚠ Traffic balance low: 0.1 MB remaining
   Run "metabot traffic recharge" to top up
   ```

**修复建议**:

在 `src/daemon/defaultHandlers.ts` 的所有上链操作 handler 中，添加流量消耗记录并返回：

```typescript
// After commandSuccess
const trafficBalance = await trafficAccountService.getTrafficBalance();
return commandSuccess({
  ...result,
  traffic: {
    used: txSize,
    remaining: trafficBalance.balanceBytes,
  },
});
```

**预期修复时间**: 2-3 小时

---

## P2 - 中优先级改进

### 改进 #1: Bootstrap 进度可视化

**建议**:
在 `metabot bot create` 过程中显示实时进度：

```
Creating Bot "Alice"...
[1/4] ✓ Generating identity
[2/4] ⏳ Requesting subsidy (30s timeout)...
[2/4] ✓ Subsidy received: 2 SPACE
[3/4] ⏳ Publishing name to chain...
[3/4] ✓ Name published
[4/4] ⏳ Publishing chat public key...
[4/4] ✓ Chat public key published
✓ Bot "Alice" is ready!
```

**代码位置**: `src/cli/commands/bot.ts`

---

### 改进 #2: 补贴余额显示

**建议**:
在 `metabot bot status` 或 `metabot wallet balance` 中显示补贴 UTXO 余额，而非只显示 traffic balance：

```bash
$ metabot wallet balance
Subsidy: 1.8 SPACE (2 UTXOs)
Traffic: 1.5 MB
```

---

### 改进 #3: Setup-retry 自动检测失败阶段

**建议**:
`metabot bot setup-retry` 应自动检测哪个阶段失败，只重试必要的步骤：

```bash
$ metabot bot setup-retry --from alice
Checking setup status...
✓ Identity created
✓ Subsidy received
✗ Name pin not on-chain
✗ ChatPubKey pin not on-chain

Retrying sync only...
✓ Setup complete!
```

**代码位置**: `src/core/bootstrap/bootstrapFlow.ts`

---

### 改进 #4: Daemon 健康检查

**建议**:
添加 `/api/health` 端点，返回：
- Daemon 版本
- Identity 状态（ready / partial / missing）
- Traffic 状态（enabled / disabled / balance）
- Subsidy 余额

用于 CLI 命令和 UI 快速诊断。

---

### 改进 #5: 测试覆盖扩展

**建议**:
添加端到端测试覆盖新用户完整流程：

1. `tests/e2e/new-user-full-flow.test.mjs`:
   - Bot create → subsidy → sync → traffic bind
   - Buzz post（验证走流量）
   - Chat send（验证走流量）
   - Balance check（流量减少，补贴未动）

2. `tests/e2e/bootstrap-failure-recovery.test.mjs`:
   - Subsidy 失败场景
   - Sync partial 场景
   - Setup-retry 场景

**预期时间**: 6-8 小时

---

## 修复优先级总结

| 问题 | 优先级 | 预估时间 | 依赖 |
|------|--------|----------|------|
| Bug #1: Bot 无法绑定 traffic | **P0** | 2-4h | 无 |
| 问题 #3: chatPublicKey 链上验证 | **P1** | 4-6h | 无 |
| 问题 #4: 流量消耗监控 | **P1** | 2-3h | Bug #1 修复后 |
| 改进 #1: 进度可视化 | **P2** | 2h | 无 |
| 改进 #2: 补贴余额显示 | **P2** | 1h | 无 |
| 改进 #3: Setup-retry 自动检测 | **P2** | 3-4h | 无 |
| 改进 #5: 测试覆盖 | **P2** | 6-8h | Bug #1 修复后 |

**关键路径**: Bug #1（P0）→ 问题 #4（P1）→ 改进 #5（P2）

**建议第一轮修复**: Bug #1 + 问题 #4，预计 4-7 小时，完成后立即验证。

---

## 附录：相关文档

- 完整代码审查报告：`docs/analysis/new-user-flow-analysis-2026-10-15.md`
- Bootstrap 流程设计：`docs/superpowers/specs/*-bootstrap-*.md`
- Traffic Account 设计：查找 traffic 相关 spec 文档
- 测试覆盖现状：`tests/bootstrap/*.test.mjs`, `tests/e2e/*.test.mjs`

---

**生成时间**: 2026-10-15  
**下次审查**: 修复 Bug #1 后重新验证完整流程
