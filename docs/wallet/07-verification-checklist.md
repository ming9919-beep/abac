# 07 · 验证与上线检查清单（阶段五）

> 勾选 = 有自动化测试或可复现步骤。**当前环境**列说明在本机（无 PostgreSQL/Docker）能否直接验证。

## A. 资金安全

| # | 检查项 | 验证方式 | 当前状态 |
| --- | --- | --- | --- |
| A1 | 并发转账不会重复扣款 / 负余额 | 行锁（按钱包 id 升序 `FOR UPDATE`）+ `CHECK(用户钱包 balance>=0)`；压测 200 并发同账户 | ✅ 代码+约束已就位；⏳ 需真实库压测 |
| A2 | 重复提交不会重复入账 | `idempotency_keys` 同事务抢占 + `UNIQUE(scope,user,key)`；单测 `wallet.service.test` 断言重放返回同一 txNo | ✅ 纯逻辑单测通过 |
| A3 | 重复回调不会重复入账 | 单据状态机：已 `succeeded` 直接 200 幂等 | ✅ 代码已就位 |
| A4 | 借贷必须平衡 | 延迟约束触发器，COMMIT 时校验，不平衡回滚 | ✅ DDL 断言测试覆盖 |
| A5 | 账本不可篡改 | `reject_mutation()` 触发器拒绝 UPDATE/DELETE | ✅ DDL 断言测试覆盖 |
| A6 | 余额 = 账本汇总 | `runReconciliation` + `/admin/reconciliations` | ✅ 代码已就位；⏳ 需真实库跑 |
| A7 | 冻结不会超过余额 | `CHECK(locked_balance <= balance)`（用户钱包） | ✅ DDL 断言测试覆盖 |

## B. 失败 / 超时 / 退款 / 部分成功

| # | 检查项 | 方式 | 状态 |
| --- | --- | --- | --- |
| B1 | 失败释放冻结、不写分录 | `failWithdrawal/failTransfer` 路径 + 单测 | ✅ |
| B2 | 超时进入 `expired`，由对账补确认或释放 | 状态机 + 作业扫描 | ✅ 代码已就位 |
| B3 | 退款不超原单、原单不可改 | `REFUND_EXCEEDS_ORIGINAL` + `parent_transaction_id` | ✅ |
| B4 | 部分成功拆子单 | 父单等子单全终态 | ✅ 设计已覆盖 |
| B5 | 部分错误信息可排查 | `failure_code/failure_reason` + `transaction_events` + pino | ✅ |

## C. 备份 / 恢复

| # | 检查项 | 方式 | 状态 |
| --- | --- | --- | --- |
| C1 | 每日备份任务 | `pg_dump -Fc` + WAL 归档 | ⏳ 需在有库环境配置 |
| C2 | 恢复演练通过 | 恢复到临时库 → 跑 DDL 断言 → 对账 `mismatch=0` | ⏳ |
| C3 | RTO/RPO 记录在案 | 演练报告 | ⏳ |

## D. 审计与合规

| # | 检查项 | 方式 | 状态 |
| --- | --- | --- | --- |
| D1 | 管理员操作留痕 | `audit_logs`（只追加），管理端接口全部写入 | ✅ |
| D2 | 证件号一人一号 | `user_profiles.national_id_no_hash` 唯一索引 | ✅ DDL 断言测试覆盖 |
| D3 | 手机号唯一 + 未注册不可登录 | 部分唯一索引 + `/auth/phone-check` + `PHONE_NOT_REGISTERED` | ✅ 前后端联调可见 |
| D4 | 无明文密码 / 完整卡号 / 私钥入业务表 | `password_hash` 只存哈希；schema 无卡号与私钥列 | ✅ |
| D5 | 只追加表不可改删 | 触发器断言测试 | ✅ |

## E. 对账差异

| # | 检查项 | 方式 | 状态 |
| --- | --- | --- | --- |
| E1 | 差异能及时发现 | 手动 + 定时 `/admin/reconciliations`，`mismatch_count>0` 告警 | ✅ |
| E2 | 差异处理留痕 | `reconciliation_items.resolve` + `audit_logs` | ✅ |
| E3 | 补账走 adjustment 单 | 服务层不提供「直接改余额」入口 | ✅ |

---

## 已可执行的本地验证

```bash
# 1) DDL + 资金闭环断言（PGlite 内存库，执行全部迁移并验证约束/触发器/索引）
node lib/db/pglite-check/run.mjs        # 期望：通过 105 项，失败 0 项

# 2) 钱包纯逻辑 + 登录拦截测试（金额精度、密码哈希、证件号、未注册手机号拦截）
pnpm test                               # 钱包相关 40 项应全过；
                                        # 另有 23 项既有基线失败与本次改动无关

# 3) 类型检查（根 tsconfig + api-server tsconfig，均须 exit=0）
pnpm typecheck
```

## 接口冒烟（无需真实 PostgreSQL）

```bash
# 用嵌入式 PGlite 把 API 起在 :5200（首次启动自动跑 lib/db/migrations/*.sql）
cd artifacts/api-server
PORT=5200 WALLET_DB_DRIVER=pglite WALLET_PGDATA=/tmp/wallet-pglite \
  WALLET_AUTO_MIGRATE=true node --import tsx src/index.ts &

node scripts/smoke-wallet.mjs           # 期望：通过 32 项，失败 0 项（可重复跑）
```

已验证覆盖（本机 2026-11-15 实测全绿）：

- [x] `GET /healthz` 200
- [x] 未注册手机号 `phone-check` / `login` → 404 `PHONE_NOT_REGISTERED`，文案含「还没注册本银行使用」
- [x] 注册 → 登录 → 密码错误 401 → `GET /me` 返回 USD/KHR 双钱包
- [x] 同 `Idempotency-Key` 重放返回同一 `txNo`（不重复开单）
- [x] 渠道回调入账 `succeeded`；**重复回调幂等，不重复入账**（余额仍 100.00）
- [x] 提现创建即冻结：`balance=100.00 / locked=31.00 / available=69.00`；出款后 `69.00 / locked=0.00`
- [x] 转账后付方 58.50、收方 10.00（金额 + 手续费精确）
- [x] 账本流水借贷净额 = 余额 58.50，每条分录可追溯到 `txNo`
- [x] 单据详情含状态事件 + 分录
- [x] 管理端对账 `mismatch_count=0`；审计日志只读可查；无 token → 401
- [x] 注册缺证件号 → 被拒（开户必须完成身份证信息）；证件号必填前后端一致

## 需要有 PostgreSQL 的环境执行

```bash
node lib/db/migrations/run-migrations.mjs
pnpm --filter @workspace/api-server dev
# 然后跑 docs/wallet/04-api.md 里的 curl 冒烟清单
```

## 上线前必须完成（阻塞项）

- [ ] 生产库三角色分离、连接串走密钥管理
- [ ] `cors()` 收敛白名单；管理端加 IP 白名单
- [ ] 备份 + 恢复演练通过
- [ ] 200 并发转账压测无负余额、无重复入账
- [ ] 渠道回调验签在生产密钥下真实联调
- [ ] 对账定时任务接入告警通道
- [ ] 监控指标上线并演练一次告警
