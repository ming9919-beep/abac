# 01 · 业务规则说明（阶段一）

> 简短版业务说明：钱包怎么运作，以及这些规则如何决定数据结构。

---

## 1. 支持的资产与地区

| 项 | 现阶段规则 | 数据结构落点 |
| --- | --- | --- |
| 币种 | USD（2 位小数）、KHR（0 位小数），后续可扩展 | `assets` 表，`decimals` 决定最小单位 |
| 地区 | 柬埔寨（KH），单区域运营 | `users.phone_country`；限额按 `kyc_level` 而非地区切分 |
| 多链/多币 | **暂不启用**，但预留字段 | `assets.network`、`assets.contract_address` |
| 精度 | 金额一律按最小单位整数（BigInt）计算，存储用 `numeric(38,18)` | 不允许任何浮点参与金额计算 |

规则：**新增币种 = 往 `assets` 插一行 + 建一个系统钱包**，不需要改表结构。

---

## 2. 交易类型

| 类型 | 枚举值 | 方向 | 是否产生账本分录 |
| --- | --- | --- | --- |
| 充值 | `deposit` | 外部 → 用户钱包 | 确认时产生 |
| 提现 | `withdrawal` | 用户钱包 → 外部 | 结算时产生 |
| 转账 | `transfer` | 用户 → 用户 | 结算时产生 |
| 退款 | `refund` | 原路退回，可部分退 | 产生（原方向的反向分录） |
| 冲正 | `reversal` | 全额反向（渠道事后撤销） | 产生 |
| 手续费 | `fee` | 计入手续费钱包（作为其他类型的分录） | 作为独立分录 |
| 调账 | `adjustment` | 人工调账，必须审批 | 产生 |

---

## 3. 余额什么时候更新（核心规则）

**账本流水是资金变化的唯一依据，余额字段只是为了查询快。**

1. **创建交易单不改余额**，只做校验 + 写入 `transactions` + 对出账方向创建 `holds` 冻结。
   - 提现/转账：冻结 `amount + fee_amount`，`available = balance - locked_balance` 减少。
2. **结算（confirm）时才改余额**，并且必须在**同一个数据库事务**里完成：
   - 锁定涉及的钱包行（`SELECT ... FOR UPDATE`，按钱包 id 排序避免死锁）
   - 写入成对的 `ledger_entries`（借 = 贷，同一资产内平衡）
   - 更新 `wallets.balance` / `locked_balance`
   - 更新 `transactions.status = 'succeeded'`
   - 写 `transaction_events`、必要时写 `audit_logs`
3. **失败 / 取消 / 超时**：
   - 未结算：释放冻结，`status = failed|canceled|expired`，**不产生任何账本分录**。
   - 已结算但渠道事后失败：不允许改历史，必须新开 `reversal` 单据 + 反向分录。
4. **事务失败整体回滚**，错误码与原始信息写入 `transactions.failure_code/failure_reason` 与服务端日志。

数据库兜底约束（见迁移脚本）：
- `CHECK (用户钱包 balance >= 0)`、`CHECK (locked_balance >= 0)`、`CHECK (用户钱包 locked_balance <= balance)`
  —— 系统钱包（暂存/手续费/收入/结算）允许为负，表示「资金在途 / 对外头寸」，全局守恒由对账保证。
- 每个分录组在**提交时**校验借贷平衡（延迟约束触发器），不平衡则整个事务回滚。
- `ledger_entries` / `audit_logs` 为**只追加表**，UPDATE / DELETE 触发器直接抛异常。

---

## 4. 冻结（holds）

| 规则 | 说明 |
| --- | --- |
| 何时冻结 | 提现、转账在创建时冻结 `amount + fee_amount` |
| 何时解冻 | 结算（capture）→ 冻结转出账；失败/取消/超时（release/expire）→ 解冻回可用 |
| 同一单据同一钱包 | 只允许一条 active 冻结（部分唯一索引） |
| 冻结不进账本 | 冻结只改 `locked_balance`；资金真正移动才写 `ledger_entries` |

---

## 5. 手续费、限额、审批

- **手续费**：`transactions.fee_amount`；结算时独立写一条 `entry_type = 'fee'` 分录，收款方是该币种的手续费钱包。
- **限额**：`transaction_limits` 按 `交易类型 + 币种(可空=全部) + KYC 等级` 配置单笔最小/最大、日累计金额/笔数、月累计金额。创建交易单时校验。
- **审批**：满足以下任一条件写入 `approval_requests` 并把交易置为 `requires_review`：
  - 单笔金额 ≥ `WALLET_REVIEW_THRESHOLD`
  - `transaction_limits` 命中风控规则
  - 人工调账 `adjustment`
  审批通过后才允许结算；审批动作本身写 `audit_logs`。

---

## 6. 谁能看、谁能改（权限）

| 角色 | 权限 | 备注 |
| --- | --- | --- |
| 用户 | 只能读写**自己的**钱包、流水、交易 | 路由层按 `session.user_id` 过滤 |
| 客服（read-only） | 查询用户与交易，**证件号只显示后 4 位** | DB 只授 SELECT |
| 运营（operator） | 普通调账、重试失败单 | 关键操作必须填原因 |
| 财务/风控审批人 | 审批超阈值交易 | 与操作人分离（四眼原则） |
| 审计（auditor） | 只读 + 只读 `audit_logs` | 不可写业务表 |
| 系统服务账号 | 资金核心逻辑、对账作业 | 密钥在环境变量，不入库 |

数据库角色分离：
- `wallet_admin`：DDL / 迁移（只在发布机使用）
- `wallet_app`：业务 DML，**无 DDL 权限、无 `ledger_entries` 的 UPDATE/DELETE 权限**
- `wallet_readonly`：全部只读

> 应用层不允许出现「管理员直接改余额字段」的路径，任何人工修正只能是 `adjustment` 交易单。

---

## 7. 登录与身份规则

| 规则 | 实现 |
| --- | --- |
| **手机号必须已注册才能登录** | 登录前先查 `users.phone`；不存在则返回 `PHONE_NOT_REGISTERED`，前端提示「你手机号码目前还没注册本银行使用 / This phone number is not registered with this bank yet」 |
| **开户必须完成身份证信息** | `POST /auth/register` 的 `nationalIdNo` **必填**：缺失返回 `VALIDATION_ERROR`，前端 `/auth/signup`（「快速开户」入口）证件号字段带 `*` 且校验不通过禁用提交按钮 |
| 手机号唯一 | `users(phone)` 部分唯一索引（排除已注销 `deleted_at`） |
| 密码只存哈希 | `users.password_hash` = `scrypt$N$r$p$salt$hash`（生产可换 argon2id），**不存明文** |
| **证件号每个用户都不同** | `user_profiles.national_id_no_hash`（HMAC-SHA256）唯一索引 + 密文存储 + 仅留后 4 位用于展示 |
| 登录失败限流 | `login_attempts` 记录每次结果；连续失败超过阈值临时锁定（`users.locked_until`） |
| 会话 | 只存 token 的 SHA-256（`user_sessions.token_hash`），明文 token 只在登录响应里出现一次 |

### 为什么证件号用「密文 + 哈希 + 后 4 位」

- 密文 `national_id_no_encrypted`：需要还原原始号码时用服务端密钥解密（AES-256-GCM）。
- 哈希 `national_id_no_hash`：用带密钥的 HMAC，既能**唯一索引防重号**，又无法反推号码。
- 后 4 位 `national_id_no_last4`：客服展示场景只给这个，避免全量泄露。
- 三者都在 `user_profiles`，**每个用户一行，互不相同**。

---

## 8. 外部渠道回调规则

- 回调必须**验签**（渠道公钥/RSA 签名或 HMAC），验签失败直接 401，不落库。
- 回调必须**幂等**：同一 `provider + provider_ref` 多次通知只入账一次（事务内检查状态机，重复通知直接返回上次结果）。
- 回调与主动查询（轮询）竞争时，靠 `transactions` 行锁 + 状态机保证只有一个赢家。
- 超时未确认的提现进入 `expired`，由对账作业扫描后要么补确认、要么释放并标记人工复核。
- 链上交易需要 `confirmation` 数达标才可入账（字段在 `transactions.metadata.confirmations`）。

---

## 9. 规则 → 数据结构 的映射速查

| 业务规则 | 表 |
| --- | --- |
| 用户登录标识与状态 | `users` |
| 用户资料 / 证件号一人一号 | `user_profiles` |
| 用户与某资产的账户 | `wallets` + `assets` |
| 资金变动依据 | `ledger_entries`（只追加） |
| 业务订单与处理状态 | `transactions` + `transaction_events` |
| 冻结 | `holds` |
| 幂等、防重复入账 | `idempotency_keys` |
| 管理员/系统操作留痕 | `audit_logs` |
| 限额 / 审批 | `transaction_limits` / `approval_requests` |
| 对账 | `reconciliation_runs` / `reconciliation_items` |
| 手机号是否注册、登录留痕 | `users` / `login_attempts` / `user_sessions` |
