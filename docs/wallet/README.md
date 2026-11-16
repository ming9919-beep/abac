# 钱包数据库（Wallet Database）— 交付说明

对应你的「项目目标 / 分阶段实施 / 初期交付物」，本目录是第一版完整交付。

## 交付物对照表

| 你的要求 | 文件 |
| --- | --- |
| 业务规则说明（阶段一） | [01-business-rules.md](./01-business-rules.md) |
| 数据库表结构和字段说明（阶段二） | [02-data-model.md](./02-data-model.md) |
| 充值、提现、转账的状态流转图（阶段四 / 交付物） | [03-state-machines.md](./03-state-machines.md) |
| 核心资金处理接口（阶段四 / 交付物） | [04-api.md](./04-api.md) |
| 账本查询与对账机制（阶段四 / 交付物） | [05-reconciliation-and-ops.md](./05-reconciliation-and-ops.md) |
| 技术与安全方案（阶段三） | [06-security-and-deployment.md](./06-security-and-deployment.md) |
| 上线前验证清单（阶段五） | [07-verification-checklist.md](./07-verification-checklist.md) |

## 代码位置

```
lib/db/src/schema/            Drizzle 表定义（TypeScript，供应用读写）
  enums.ts                    所有枚举
  users.ts                    用户、资料、会话、登录尝试
  assets.ts                   资产（币种/链）、钱包账户
  transactions.ts             交易单、状态事件、冻结
  ledger.ts                   账本流水（复式记账，只追加）
  idempotency.ts              幂等记录
  audit.ts                    操作审计
  limits.ts                   限额、审批
  reconciliation.ts           对账批次与明细
  index.ts                    统一导出

lib/db/migrations/            PostgreSQL 迁移脚本（DDL 权威来源）
  0000_wallet_core.sql        建库建表、约束、索引、触发器
  0001_wallet_seed.sql        币种、系统钱包、默认限额种子数据
  run-migrations.mjs          只依赖 pg 的迁移执行器（不依赖 drizzle-kit）

artifacts/api-server/src/lib/wallet/
  money.ts                    金额计算（BigInt 基本单位，无浮点）
  errors.ts                   统一错误码
  password.ts                 scrypt 密码哈希（只存哈希）
  identity.ts                 手机号规范化、证件号 HMAC/加密
  auth.ts                     注册 / 登录 / 手机号注册校验 / 会话
  service.ts                  资金核心：入账、冻结、记账、退款、对账
  routes 内联在 ../../routes/wallet.ts

src/lib/phoneRegistry.ts      前端手机号「是否已注册」校验（离线兜底）
src/pages/auth/PhoneRegister.tsx  未注册手机号的拦截提示
```

## 本地快速开始

```bash
# 1) 准备数据库（任选其一）
docker compose up -d postgres          # 仓库根或本目录提供 docker-compose.yml
# 或自备 PostgreSQL 15+，创建空库

# 2) 配置连接
cp artifacts/api-server/.env.example artifacts/api-server/.env
# 编辑 DATABASE_URL=postgresql://wallet_app:...@127.0.0.1:5432/wallet_dev

# 3) 执行迁移 + 种子（不需要 drizzle-kit）
node lib/db/migrations/run-migrations.mjs

# 4) 启动 API（需要先 pnpm install）
pnpm --filter @workspace/api-server dev   # 默认 :5200

# 4') 没有 PostgreSQL？用嵌入式 PGlite 直接把接口跑起来（零安装，本机已验证）
cd artifacts/api-server
PORT=5200 WALLET_DB_DRIVER=pglite \
  WALLET_PGDATA=/tmp/wallet-pglite WALLET_AUTO_MIGRATE=true \
  node --import tsx src/index.ts          # 首次启动自动执行 lib/db/migrations/*.sql

# 5) 接口冒烟（阶段五，直接打 HTTP，32 项断言；余额按起始值算增量，可重复跑）
node artifacts/api-server/scripts/smoke-wallet.mjs   # 期望：通过 32 项，失败 0 项

# 6) 跑测试（不需要数据库，本地直接可跑）
node lib/db/pglite-check/run.mjs          # DDL + 资金闭环断言（PGlite 内存库，105 项）
pnpm test                                  # 前端 + 钱包纯逻辑测试（vitest）
pnpm typecheck                             # tsc --noEmit（根 + api-server 各自的 tsconfig）
```

## 环境说明

- 技术栈沿用现有后端：**PostgreSQL + Drizzle ORM + Express**。
- 本机没有真实 PostgreSQL / Docker / drizzle-kit，因此提供 **PGlite 嵌入式驱动**
  （`WALLET_DB_DRIVER=pglite`）在本地把接口完整跑起来：自动执行 `lib/db/migrations/*.sql`，
  然后用 `scripts/smoke-wallet.mjs` 打真实 HTTP 做资金闭环冒烟（31 项，本机已全绿）。
  生产/联调仍走 `DATABASE_URL` 指向真正的 PostgreSQL（`WALLET_DB_DRIVER=postgres`，默认值）。
- `pnpm test` 中 `src/lib/tts|khqr|txnStore`、`src/pages/Home|TransactionDetail`、
  `src/components/BankLogo` 共 23 项为**既有基线失败**（文案/断言与本次钱包改动无关），
  钱包相关 40 项（`phoneRegistry` / `walletMoney` / `PhoneRegister` / `password` / `identity`）全部通过。

## 验证结果（本机 2026-11-15）

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| DDL + 资金闭环断言 | `node lib/db/pglite-check/run.mjs` | 通过 105 项，失败 0 |
| 接口冒烟（真实 HTTP） | `node artifacts/api-server/scripts/smoke-wallet.mjs` | 通过 32 项，失败 0（可重复跑） |
| 前端 + 钱包逻辑测试 | `pnpm test` | 钱包 44 项全过；23 项既有基线失败 |
| 类型检查 | `pnpm typecheck`（根 / api-server / lib） | 全部 exit=0 |
