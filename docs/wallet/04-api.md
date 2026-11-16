# 04 · 核心资金处理接口

- 基址：`/api/wallet`（由 `artifacts/api-server/src/routes/wallet.ts` 挂载）
- 认证：`Authorization: Bearer <token>`（登录/注册返回），管理员接口额外需要 `X-Admin-Key`
- 幂等：**所有创建类接口必须带 `Idempotency-Key` 请求头**（建议 UUID，重试必须复用同一个）
- 金额：**字符串十进制**（如 `"12.50"`、`"10000"`），不要传 number；响应同样返回字符串
- 时间：ISO-8601 UTC

错误响应统一结构：

```json
{ "code": "BALANCE_INSUFFICIENT", "message": "可用余额不足", "details": { "available": "10.00" } }
```

---

## 1. 身份与登录

### 1.1 `POST /auth/phone-check` — 手机号是否已注册（登录前置校验）

```bash
curl -X POST /api/wallet/auth/phone-check \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+855979935561"}'
```

```json
{ "registered": false, "status": null, "message": "你手机号码目前还没注册本银行使用 / This phone number is not registered with this bank yet" }
```

| code | HTTP | 含义 |
| --- | --- | --- |
| `PHONE_NOT_REGISTERED` | 404 | 手机号未在 `users` 表注册，**不允许登录** |
| `ACCOUNT_SUSPENDED` | 403 | 已注册但被冻结 |
| `ACCOUNT_LOCKED` | 423 | 连续失败次数过多，`locked_until` 未到 |

### 1.2 `POST /auth/register` — 注册（创建用户 + 钱包账户）

```json
{
  "phone": "+855979935561",
  "password": "••••••",
  "fullName": "CHHENG BONNY",
  "nationalIdNo": "493991234",
  "currencies": ["USD", "KHR"]
}
```
响应 `201`：`{ "token": "...", "user": {...}, "wallets": [{...}] }`

- **`nationalIdNo`（身份证号）必填**：开户必须完成身份证信息，缺失直接 `400 VALIDATION_ERROR`。
  服务端只存 AES-256-GCM 密文 + HMAC 哈希（唯一索引）+ 后 4 位，业务表不存明文；
  每个用户证件号必须不同，重号由 `national_id_no_hash` 唯一索引兜底拒绝。
- 前端入口：`/auth/start` →「បើកគណនីរហ័ស · 快速开户」→ `/auth/signup`（身份证字段必填，带 * 标记）。

| code | HTTP | 含义 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | **未填证件号** / 证件号长度不合法（4-32 位）/ 姓名过短 |
| `PHONE_ALREADY_REGISTERED` | 409 | 手机号已存在（唯一索引兜底） |
| `ID_CARD_ALREADY_USED` | 409 | **证件号已被其他用户绑定**（`national_id_no_hash` 唯一） |
| `WEAK_PASSWORD` | 400 | 密码强度不足（≥8 位且至少两类字符） |

### 1.3 `POST /auth/login` — 登录

```json
{ "phone": "+855979935561", "password": "..." }
```

- **手机号不存在 → `404 PHONE_NOT_REGISTERED`**，`message` 即前端要展示的那句话。
- 密码错误 → `401 BAD_PASSWORD`（不区分「用户不存在」与「密码错」之外的信息泄露，但注册状态本身按需求明确提示）。
- 成功 → `{ token, user, expiresAt }`；服务端只存 token 哈希。

### 1.4 `POST /auth/logout` · `GET /me`

`logout` 使 `user_sessions.revoked_at` 生效；`me` 返回用户、资料（证件号只回 `last4`）、钱包列表。

---

## 2. 钱包与账本查询

### 2.1 `GET /wallets`
```json
[{ "walletId": "…", "walletNo": "ABAUSD…", "asset": "USD",
   "balance": "120.50", "locked": "20.00", "available": "100.50" }]
```

### 2.2 `GET /ledger?walletId=&limit=50&cursor=`
倒序分页，`cursor` 为上一页最后一条的 `id`。

```json
{
  "entries": [
    { "id": 10021, "txNo": "TX20261114000012", "type": "transfer",
      "direction": "debit", "entryType": "principal", "amount": "20.00",
      "balanceBefore": "120.50", "balanceAfter": "100.50", "createdAt": "…" }
  ],
  "nextCursor": 10021
}
```

> 只返回分录，余额变化一定来自这些分录；每条都能通过 `txNo` 回到业务单据。

---

## 3. 充值

### `POST /deposits`
```bash
-H 'Idempotency-Key: 5f0c…' -H 'Authorization: Bearer …'
-d { "asset": "USD", "amount": "100.00", "provider": "bakong", "externalRef": "…" }
```
`201 { txNo, status: "pending" }`

### `POST /deposits/:id/confirm` — 渠道回调 / 内部确认
```bash
-H 'X-Provider-Signature: <rsa-or-hmac>' -d { "providerRef": "…", "amount": "100.00", "asset": "USD" }
```
- 验签失败 → `401 SIGNATURE_INVALID`（不落库）
- 重复通知 → `200`，返回同一 `txNo`，**不重复入账**
- 金额/币种与单据不符 → `409 AMOUNT_MISMATCH`，转人工复核
- 成功 → 内部完成「借 暂存钱包 / 贷 用户钱包」双分录

### `POST /deposits/:id/fail`
`pending → failed`，不写分录。

---

## 4. 提现

### `POST /withdrawals`
```json
{ "asset": "USD", "amount": "50.00", "feeAmount": "0.50",
  "destination": { "bank": "ABA", "accountNo": "…" }, "note": "" }
```
创建即冻结 `50.50`，响应 `201 { txNo, status: "pending", available: "…" }`

| code | HTTP | 含义 |
| --- | --- | --- |
| `BALANCE_INSUFFICIENT` | 422 | `available < amount + fee` |
| `LIMIT_EXCEEDED` | 422 | 超单笔/日/月限额，`details` 给出上限 |
| `WALLET_FROZEN` | 403 | 钱包 `status != active` |
| `REQUIRES_APPROVAL` | 202 | 返回 `status: requires_review`，等待审批 |

### `POST /withdrawals/:id/confirm` · `/fail`
- confirm：**同一事务** 锁钱包 → 写「借 用户钱包 / 贷 暂存钱包 + 手续费钱包」→ 扣余额、释放冻结、置 `succeeded`
- fail：释放冻结回可用余额，置 `failed`，不写分录

---

## 5. 转账

### `POST /transfers`
```json
{ "asset": "USD", "amount": "20.00", "feeAmount": "0",
  "toWalletId": "…", "note": "rent" }
```
| code | HTTP | 含义 |
| --- | --- | --- |
| `SELF_TRANSFER` | 400 | 付方=收方 |
| `CROSS_ASSET_UNSUPPORTED` | 400 | 付收币种不同 |
| `WALLET_NOT_FOUND` | 404 | 收款钱包不存在或已关闭 |
| `BALANCE_INSUFFICIENT` | 422 | 可用余额不足 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | 缺 `Idempotency-Key` |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 同 key 不同请求体 |
| `REQUEST_IN_PROGRESS` | 409 | 同 key 请求正在处理中（并发重复提交） |

### `POST /transfers/:id/confirm` · `POST /transactions/:id/cancel`
- confirm：锁双方（按 wallet id 升序）→ 写分录 → 付方扣减、收方增加、释放冻结 → `succeeded`
- cancel（通用取消接口，充值/提现/转账都用它）：释放冻结 → `canceled`，不写分录

---

## 6. 退款 / 冲正

### `POST /transactions/:id/refund`
```json
{ "amount": "10.00", "reason": "customer request" }
```
- `amount` 缺省 = 全额退；累计退款不得超过原单可退余额 → `REFUND_EXCEEDS_ORIGINAL`
- 原单必须是 `succeeded` → `INVALID_STATE`
- 生成子单 + 反向分录，原单保持不可变

---

## 7. 单据查询

- `GET /transactions/:id` → 单据 + 状态事件 + 关联分录 + 冻结 + 审批记录
- `GET /transactions?status=&type=&from=&to=&limit=&cursor=` → 按发起人过滤的分页列表

---

## 8. 管理端（需 `X-Admin-Key`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/admin/transactions/:id/approve` | `{ decision: "approve"\|"reject", note }`，写 `audit_logs` |
| `POST` | `/admin/transactions/:id/complete` | 强制结算/重试，必须带 `note` |
| `POST` | `/admin/reconciliations` | `{ asset, periodStart, periodEnd }` 立即跑一次对账 |
| `GET` | `/admin/reconciliations` / `/admin/reconciliations/:id` | 批次与差异明细 |
| `POST` | `/admin/reconciliations/:id/items/:itemId/resolve` | 差异处理留痕 |
| `GET` | `/admin/audit-logs?entityType=&entityId=&limit=` | 审计查询（只读） |

---

## 9. 幂等与并发约定（调用方必须遵守）

1. 创建类请求生成一次 `Idempotency-Key`，**超时重试复用同一个 key**。
2. 同 key 不同请求体 → `409 IDEMPOTENCY_KEY_REUSED`，必须换 key 或复用原请求。
3. 同 key 并发重复 → 一方成功，另一方要么拿到原结果，要么 `409 REQUEST_IN_PROGRESS`。
4. 回调重放是安全的：以单据状态机为准，已 `succeeded` 直接返回成功。
5. 拿到 `2xx` 但响应体丢失时，用 `GET /transactions/:id` 或同 key 重放确认结果，**不要新开单据**。
