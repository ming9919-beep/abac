# 05 · 账本查询与对账机制（含备份/监控/保留）

## 1. 账本查询

### 1.1 三条查询口径

| 口径 | SQL 语义 | 用途 |
| --- | --- | --- |
| 某钱包流水 | `ledger_entries WHERE wallet_id=? ORDER BY created_at DESC, id DESC` | 用户账单页、客服核查 |
| 某单据分录 | `ledger_entries WHERE transaction_id=?` | 追溯「这笔钱怎么动的」 |
| 某时点余额 | `balance_after` 取该钱包最后一条分录 | 对账、审计复算 |

### 1.2 余额与账本的关系

```
wallets.balance(快照) == SUM(credit) - SUM(debit)  WHERE wallet_id = w
wallets.balance(快照) <= walletS 汇总 必须逐币种相等
```

- `wallets.balance` 是**冗余快照**，只为免去全表聚合。
- 任何对不上的情况都按**事故**处理：停写 → 跑对账 → 出差异 → 人工裁决。
- 冻结金额不进账本，只体现在 `locked_balance`；因此对账比较的是 `balance`（不是 available）。

### 1.3 汇总 SQL（服务层 `service.ts` 中 `runReconciliation` 使用）

```sql
SELECT w.id, w.asset_code,
       w.balance                                    AS stored_balance,
       COALESCE(l.ledger_balance, 0)                AS ledger_balance,
       w.balance - COALESCE(l.ledger_balance, 0)    AS difference
FROM wallets w
LEFT JOIN (
  SELECT wallet_id,
         SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS ledger_balance
  FROM ledger_entries GROUP BY wallet_id
) l ON l.wallet_id = w.id
WHERE w.asset_code = $1;
```

---

## 2. 对账（Reconciliation）

### 2.1 三种对账

| 类型 | 频率 | 比对双方 |
| --- | --- | --- |
| **内部对账**（已实现） | 每日 + 手动 | `wallets.balance` ↔ `SUM(ledger_entries)`，逐钱包、逐币种 |
| **渠道对账** | T+1 | `transactions` ↔ 外部渠道流水（`provider_ref`、金额、状态） |
| **资金账户对账** | 每日 | 平台暂存/手续费钱包合计 ↔ 银行或链上实际余额 |

### 2.2 流程

```
POST /api/wallet/admin/reconciliations {asset:"USD"}
  1. INSERT reconciliation_runs (status=running, period_start/end)
  2. 逐钱包比对 stored_balance vs ledger_balance
  3. 一致 → reconciliation_items(matched)
     不一致 → reconciliation_items(mismatched) + difference + 告警
  4. 汇总 total_debits/total_credits/wallet_count/mismatch_count
  5. status=completed；有差异则 mismatch_count>0 触发告警
  6. 人工在差异项上 resolve（写 note/resolved_by + audit_logs）
```

**差异处理原则**：
- 一律走 `adjustment` 交易单补账，**绝不直接改余额字段**。
- 差异超过阈值 → 自动创建 `approval_requests`，财务双人复核。
- 差异单据必须关联 `reconciliation_items.id`。

### 2.3 借贷平衡的自动校验（数据库层）

迁移脚本里定义了延迟约束触发器 `ledger_entries_balanced`：
每个 `entry_group_id + asset_code` 在 **COMMIT 时** 满足 `SUM(debit) = SUM(credit)`，
否则整个事务回滚 → 应用写错账根本提交不进去。

另有 `reject_mutation()` 触发器：`ledger_entries` / `audit_logs` / `transaction_events` 一旦 UPDATE/DELETE 直接抛异常。

---

## 3. 备份与恢复演练

```bash
# 每日全备（自定义格式，可单表恢复）
pg_dump -Fc -d wallet_prod -f wallet_$(date +%F).dump

# WAL 归档（PITR）
archive_mode = on
archive_command = 'wal-g wal-push %p'   # 或 pgBackRest / 云厂商

# 恢复演练（每季度至少一次，恢复到临时库验证）
pg_restore -d wallet_restore wallet_2026-11-14.dump --clean --if-exists

# 结构核对：迁移记录与文件一致
node lib/db/migrations/run-migrations.mjs --database-url $RESTORE_URL --status

# 数据核对：对账必须 0 差异（走管理端接口，或 psql 跑 v_transaction_ledger_diff）
node lib/db/pglite-check/run.mjs   # 另外在本机复跑 DDL 断言（不依赖真实库）
```

演练验收标准：
1. 恢复后能跑完全部 DDL 断言 + 对账 `mismatch_count = 0`
2. 恢复耗时记录在案（RTO），恢复点（RPO）≤ 5 分钟
3. 每次演练写入 `audit_logs`（用管理端或人工记录）

---

## 4. 监控与告警

| 指标 | 阈值 | 说明 |
| --- | --- | --- |
| `wallet.reconciliation.mismatch_count` | > 0 立即 P1 | 对账差异 |
| `wallet.tx.failed_rate` | 5 分钟 > 5% 告警 | 单据失败率 |
| `wallet.tx.pending_oldest_age` | > 30 分钟 | 卡单 |
| `wallet.ledger.unbalanced_rollbacks` | 任意一次 P1 | 借贷不平衡被数据库拒绝（说明有 bug） |
| `wallet.auth.phone_not_registered_total` | 观察趋势 | 未注册手机号登录尝试（撞库信号） |
| `wallet.auth.login_failed_rate` | > 10% 且集中某 IP P1 | 暴力破解 |
| `wallet.holds.active_oldest_age` | > 24 小时 | 冻结超时未释放 |
| 数据库连接池使用率 / 复制延迟 / 磁盘 | 常规 | |

日志：`pino` 结构化日志，必须带 `requestId`、`txNo`、`userId`（脱敏），**禁止输出密码、完整证件号、token**。

---

## 5. 数据保留

| 数据 | 保留期 | 依据 |
| --- | --- | --- |
| `ledger_entries` / `transactions` / `audit_logs` | **永久**（不删） | 资金与合规审计要求 |
| `reconciliation_*` | ≥ 7 年 | 对账留痕 |
| `login_attempts` | 180 天后归档 | 风控 |
| `user_sessions` | 过期 30 天清理 | |
| `transaction_events` | 与单据同寿命 | |

清理只能由 `wallet_admin` 角色执行，且清理动作本身写 `audit_logs`；**资金类表永不物理删除**。

---

## 6. 生产 / 测试隔离

| 项 | 要求 |
| --- | --- |
| 数据库 | 生产与测试**不同实例**（至少不同 database + 不同账号），测试库禁止承载真实资金接口 |
| 连接串 | 通过环境变量注入，**绝不提交仓库**（`.env` 在 `.gitignore`） |
| 应用配置 | `NODE_ENV=production` 时才允许 `PAYWAY_MODE=live` / `BAKONG_MODE=live`；mock 与 live 账号不能混用 |
| 数据 | 测试环境不导入生产真实用户数据；需要时只导脱敏样本 |
| 访问 | 生产库仅白名单 IP + 跳板机；DBA 操作走审计 |
| 密钥 | 渠道 RSA 私钥、加密主密钥放 KMS/Secrets，不进业务表、不进代码 |
