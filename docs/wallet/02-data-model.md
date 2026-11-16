# 02 · 数据库表结构与字段说明（阶段二）

> 权威 DDL 见 `lib/db/migrations/0000_wallet_core.sql`；TS 类型见 `lib/db/src/schema/`。
> 金额列统一 `numeric(38,18)`，**单位是「元」而不是最小单位**；服务层换算成 BigInt 最小单位计算。
> 时间列统一 `timestamptz`。

---

## 0. ER 总览

```
users 1 ──── 1 user_profiles
users 1 ──── n user_sessions / login_attempts
users 1 ──── n wallets ──── 1 assets
transactions n ──── 1 assets
transactions n ──── 1..n ledger_entries n ──── 1 wallets
transactions n ──── 0..n holds / transaction_events / approval_requests
transactions 1 ──── 0..1 idempotency_keys
audit_logs（独立）
reconciliation_runs 1 ──── n reconciliation_items n ──── 1 wallets
```

---

## 1. `users` — 用户

登录入口表。**手机号未注册即无法登录**的判定依据。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid PK | 内部主键 |
| `user_no` | varchar(20) UNIQUE | 对外用户编号，如 `U202611140001` |
| `phone` | varchar(20) NOT NULL | 登录标识，规范化存储（`855979935561`） |
| `phone_country` | char(2) | 默认 `KH` |
| `email` | varchar(255) NULL | 可选，小写唯一 |
| `password_hash` | text NOT NULL | 仅哈希：`scrypt$...` |
| `status` | `user_status` | `pending_verification / active / suspended / closed` |
| `phone_verified_at` | timestamptz NULL | 手机号验证通过时间 |
| `kyc_level` | smallint 0–3 | 影响限额 |
| `last_login_at` | timestamptz NULL | |
| `failed_login_attempts` | integer | 连续失败次数 |
| `locked_until` | timestamptz NULL | 临时锁定到期 |
| `created_at` / `updated_at` | timestamptz | `updated_at` 由触发器维护 |
| `deleted_at` | timestamptz NULL | 软删除；唯一索引排除已删除行 |

索引：`users_phone_uidx(phone) WHERE deleted_at IS NULL`、`users_email_uidx(lower(email))`。

---

## 2. `user_profiles` — 用户资料（一人一行）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | uuid PK/FK → users | 一个人一条 |
| `full_name` | varchar(200) | 展示名 |
| `full_name_kh` | varchar(200) NULL | 高棉文名 |
| `date_of_birth` / `gender` | date / varchar | |
| `national_id_no_encrypted` | text NULL | **证件号密文**（AES-256-GCM base64） |
| `national_id_no_hash` | char(64) NULL | **HMAC-SHA256，唯一索引 → 每个用户都不同** |
| `national_id_no_last4` | char(4) NULL | 客服展示用后 4 位 |
| `address` | text | |
| `created_at` / `updated_at` | timestamptz | |

**唯一索引**：`user_profiles_nid_hash_uidx(national_id_no_hash) WHERE ... IS NOT NULL`
→ 同一证件号不可能绑两个用户；不同用户天然不同号。

---

## 3. `user_sessions` / `login_attempts` — 会话与登录留痕

`user_sessions`：`id, user_id, token_hash(char64, UNIQUE), ip, user_agent, created_at, last_used_at, expires_at, revoked_at`
→ 只存 token 哈希，明文 token 仅登录响应返回一次。

`login_attempts`：`id, phone, user_id, outcome, ip, user_agent, created_at`
→ `outcome ∈ {success, bad_password, phone_not_registered, account_locked, account_suspended}`，
   用于限流与「谁在尝试登录我的号码」的风控报表。

---

## 4. `assets` — 资产（币种 / 将来的链）

| 字段 | 说明 |
| --- | --- |
| `code` PK | `USD` / `KHR` |
| `decimals` | USD=2、KHR=0，决定 `money.ts` 的基本单位换算 |
| `network` / `contract_address` | 预留：多链启用时填 |
| `min_deposit` / `min_withdrawal` | 资产级门槛 |
| `is_active` | 下架币种后不可新建交易 |

种子：USD、KHR。

---

## 5. `wallets` — 钱包账户

| 字段 | 说明 |
| --- | --- |
| `id` uuid PK / `wallet_no` varchar(32) UNIQUE | 对外账户号 |
| `user_id` uuid NULL | 系统钱包为 NULL |
| `asset_code` FK | |
| `wallet_type` | `user / system_suspense / system_fee / system_revenue / system_settlement` |
| `status` | `active / frozen / closed` |
| `balance` | 已结算总额（账本汇总的快照） |
| `locked_balance` | 冻结中金额 |
| **可用余额** | **`balance - locked_balance`（查询时计算）** |
| `version` | 每次变更 +1，便于排查 |

约束：
- `CHECK (wallet_type <> 'user' OR balance >= 0)` —— **用户钱包余额永不为负**
- `CHECK (locked_balance >= 0)`、`CHECK (wallet_type <> 'user' OR locked_balance <= balance)`
- 系统钱包余额允许为负（表示资金在途/对外头寸），全局守恒由对账保证
- 用户钱包 `user_id` 必填，系统钱包 `user_id` 必须为 NULL
- 部分唯一索引：`UNIQUE(user_id, asset_code) WHERE wallet_type='user'`
- 部分唯一索引：`UNIQUE(wallet_type, asset_code) WHERE wallet_type <> 'user'`（每币种一套系统钱包）

---

## 6. `transactions` — 交易单

| 字段 | 说明 |
| --- | --- |
| `id` / `tx_no` UNIQUE | `TX` + 时间 + 序号，可对外展示 |
| `type` | `deposit / withdrawal / transfer / refund / reversal / fee / adjustment` |
| `status` | 见 03 状态机 |
| `asset_code` / `amount` / `fee_amount` / `net_amount` | `amount>0`，`fee_amount>=0`，`net_amount = amount - fee_amount`（充值为 amount） |
| `initiator_user_id` | 发起人 |
| `from_wallet_id` / `to_wallet_id` | 资金两端（充值时 from 为空，到账时用系统钱包补齐） |
| `parent_transaction_id` | 退款/冲正指向原单 |
| `idempotency_key` | 与发起人+类型构成唯一索引 |
| `provider` / `provider_ref` / `external_ref` | 渠道方与外部单号（对账用） |
| `description` / `failure_code` / `failure_reason` | 展示与排障 |
| `metadata` jsonb | 扩展：`confirmations`、`risk_flags`、渠道原始回执摘要 |
| `requires_approval` | 是否需要审批 |
| `created_at` / `updated_at` / `completed_at` | |

索引：`(initiator_user_id, created_at DESC)`、`(status, created_at)`、`(provider, provider_ref)`。
唯一：`UNIQUE(initiator_user_id, type, idempotency_key) WHERE idempotency_key IS NOT NULL`。

---

## 7. `ledger_entries` — 账本流水（**资金变化的唯一依据**）

| 字段 | 说明 |
| --- | --- |
| `id` bigserial PK | 全局单调 |
| `entry_group_id` uuid | 一笔交易的所有分录共享，用于提交时校验借贷平衡 |
| `transaction_id` FK | **每笔资金变动都能追溯到业务单据** |
| `wallet_id` FK / `asset_code` | 分录落在哪个钱包 |
| `direction` | `debit` 借 / `credit` 贷（资产视角：借=出，贷=入；具体以文档 03 的记账规则为准） |
| `entry_type` | `principal / fee / refund / reversal / adjustment` |
| `amount` | `> 0` |
| `balance_before` / `balance_after` | 记账时钱包余额快照，便于审计复算（`balance_after >= 0`） |
| `created_at` | |

索引：`(wallet_id, created_at DESC, id DESC)`（分页流水）、`(transaction_id)`、`(entry_group_id)`、`(asset_code, wallet_id)`（对账）。

**只追加**：`UPDATE/DELETE` 由触发器拒绝。
**借贷平衡**：延迟约束触发器在 COMMIT 时校验 `SUM(debit) - SUM(credit) = 0`（按 entry_group_id + asset_code），不平衡回滚。

> 记账方向约定：**用户钱包 = 负债（对平台而言）**，所以
> 用户收入 → 用户钱包 `credit`，资金来源（系统暂存/对方钱包）`debit`；
> 用户支出 → 用户钱包 `debit`，接收方 `credit`。同一笔交易分录合计为 0。

---

## 8. `holds` — 冻结记录

`id, transaction_id, wallet_id, asset_code, amount(>0), status(active/released/captured/expired), reason, expires_at, released_at, created_at, updated_at`

部分唯一：`UNIQUE(transaction_id, wallet_id) WHERE status='active'` → 同单同钱包只有一条有效冻结。

---

## 9. `idempotency_keys` — 幂等记录

`scope`(如 `transfer.create`) + `user_id` + `key` 唯一（表达式唯一索引，`user_id` 为空时用固定 uuid 兜底）；
`request_hash` 用于识别「同 key 不同请求」；`status = in_progress / completed / failed`；
`response_status` + `response_body` 存首次成功的响应，重放时原样返回。

**用法**：与业务写入在**同一个事务**内先 `INSERT ... ON CONFLICT DO NOTHING`，拿不到行说明是重复请求。

---

## 10. `transaction_events` — 状态流转留痕

`id, transaction_id, from_status, to_status, actor_type(user/admin/system/provider), actor_id, reason, metadata, created_at`

只追加；用来回答「这笔单为什么变成 failed」。

---

## 11. `audit_logs` — 操作审计

`id, actor_type, actor_id, action, entity_type, entity_id, before, after, ip, user_agent, request_id, created_at`

**只追加**（同 `ledger_entries` 触发器）。所有管理员/系统对关键数据的写操作都要写这里。

---

## 12. `transaction_limits` / `approval_requests`

`transaction_limits`：`tx_type + COALESCE(asset_code,'*') + kyc_level` 唯一（仅启用行唯一）；
字段 `min_amount, max_amount, daily_amount, daily_count, monthly_amount, is_active`。

`approval_requests`：`transaction_id, requested_by, approved_by, status(pending/approved/rejected/expired), reason, decision_note, expires_at, decided_at`。

---

## 13. `reconciliation_runs` / `reconciliation_items`

`reconciliation_runs`：`id, asset_code, period_start/end, status, total_debits, total_credits, wallet_count, mismatch_count, started_at, completed_at, error`

`reconciliation_items`：`run_id, wallet_id, stored_balance, ledger_balance, difference, status(matched/mismatched/resolved), resolved_by, resolved_at, note`

---

## 14. 字段命名与约定

- 列名 `snake_case`，时间 `*_at`，布尔 `is_*` / `has_*`。
- 所有枚举用 PostgreSQL `CREATE TYPE`，**新增取值必须用 `ALTER TYPE ... ADD VALUE`，不许改历史值含义**。
- 所有表都有 `created_at`，可变表都有 `updated_at`（触发器维护）。
- 金额列禁止 `float/double`；应用层禁止 `Number` 参与金额运算。
