# 06 · 技术与安全方案（阶段三）+ 部署

## 1. 技术选型

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 数据库 | **PostgreSQL 15+** | 行级锁、延迟约束触发器、`numeric` 精确、分区与部分索引能力 |
| ORM | **Drizzle ORM**（项目已有 `lib/db`） | 轻量、类型安全，schema 即类型 |
| 迁移 | 手写 SQL（`lib/db/migrations/*.sql`）+ 只依赖 `pg` 的执行器 | 不依赖 `drizzle-kit` 也能建库；DDL 可评审 |
| 服务 | Express（项目已有 `artifacts/api-server`） | 沿用现有技术栈 |
| 金额 | `numeric(38,18)` 存储 + **BigInt 最小单位计算** | 彻底杜绝浮点误差 |

## 2. 安全设计

### 2.1 敏感数据

| 数据 | 存储方式 | 位置 |
| --- | --- | --- |
| 密码 | `scrypt$N$r$p$salt$hash`（生产可用 argon2id），**永不明文** | `users.password_hash` |
| 会话 token | 只存 SHA-256 哈希 | `user_sessions.token_hash` |
| 证件号 | 密文（AES-256-GCM）+ HMAC 哈希 + 后 4 位 | `user_profiles` 三列 |
| 完整卡号 / 银行卡 | **不入库**，只存掩码与后 4 位 | 业务表外的收单配置 |
| 私钥 / 渠道密钥 | 环境变量 / KMS，不入库、不进代码 | `.env`（已 gitignore） |

密钥来源：`WALLET_ENCRYPTION_KEY`（32 字节 base64，AES-GCM）、`WALLET_ID_PEPPER`（证件号 HMAC）、`WALLET_ADMIN_KEY`。

### 2.2 数据库权限（三角色）

```sql
CREATE ROLE wallet_app      LOGIN;  -- 业务 DML，无 DDL，不能 UPDATE/DELETE ledger_entries/audit_logs
CREATE ROLE wallet_readonly LOGIN;  -- 只读
CREATE ROLE wallet_admin    LOGIN;  -- 迁移与维护（仅发布机）
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO wallet_app;
REVOKE UPDATE,DELETE ON ledger_entries, audit_logs, transaction_events FROM wallet_app;
```

> 应用连接串用 `wallet_app`；对账与运维只读查询用 `wallet_readonly`。

### 2.3 应用层防护

1. **行锁 + 检查约束**双保险：并发转账先 `SELECT … FOR UPDATE`（按钱包 id 升序），数据库再用 `CHECK(balance >= 0)` 兜底。
2. **幂等表**在业务事务内先抢占，重复提交不会重复入账。
3. 回调**验签**、**金额比对**、**单据状态机**三道关。
4. 输入校验（zod）+ 参数化 SQL（Drizzle 全程参数绑定），无字符串拼接 SQL。
5. 登录限流与锁定（`login_attempts` + `locked_until`）。
6. 错误不泄露内部信息：对外只给 `code + message`，原始堆栈进 pino 日志。
7. 审计：所有管理员写操作必落 `audit_logs`（只追加表，DB 层禁止改删）。

### 2.4 传输与边界

- 生产全站 HTTPS/HSTS；内部服务间 mTLS 或私网。
- `cors()` 生产收紧到白名单域名（当前代码为放开状态，**上线前必须改**）。
- 管理端接口要求 `X-Admin-Key` + 内网/VPN 来源；建议接入网关做 IP 白名单。

---

## 3. 部署

### 3.1 目录与依赖

```bash
pnpm install                     # 工作区依赖（drizzle-orm / pg / express / drizzle-kit）
pnpm --filter @workspace/db run typecheck
pnpm --filter @workspace/api-server run typecheck
```

### 3.2 环境变量（`artifacts/api-server/.env`）

```dotenv
DATABASE_URL=postgresql://wallet_app:CHANGE_ME@127.0.0.1:5432/wallet_dev
WALLET_ENCRYPTION_KEY=          # 32 字节 base64（证件号加密）
WALLET_ID_PEPPER=               # HMAC pepper（证件号唯一哈希）
WALLET_ADMIN_KEY=               # 管理端 X-Admin-Key
WALLET_REVIEW_THRESHOLD=1000    # 超过该金额需审批
WALLET_SESSION_TTL_HOURS=72
WALLET_ALLOW_REGISTRATION=true  # 关闭注册后只允许已注册手机号登录
PORT=5200
```

### 3.3 迁移

```bash
node lib/db/migrations/run-migrations.mjs            # 应用 migrations/*.sql（事务 + 记录到 schema_migrations）
node lib/db/migrations/run-migrations.mjs --status   # 查看状态
```

> 迁移只向前；每次发布前自动备份。回滚脚本单独评审，**数据表不做自动回滚**。

### 3.4 Docker（本机起库）

```bash
docker compose -f lib/db/docker-compose.yml up -d     # postgres:16 + 健康检查
```

### 3.5 冒烟

```bash
curl -s localhost:5200/api/healthz
curl -s -X POST localhost:5200/api/wallet/auth/phone-check \
     -H 'Content-Type: application/json' -d '{"phone":"+855111000111"}'
# 期望: registered:false + 未注册提示文案
```

---

## 4. 前端「手机号未注册」的呈现

- 拦截入口：`src/pages/auth/PhoneRegister.tsx` 点「បន្ទាប់ / Continue」时先调
  `POST /api/wallet/auth/phone-check`。
- 服务端可达 → 以服务端结果为准；服务端不可达（本地无库/离线）→ 用
  `src/lib/phoneRegistry.ts` 本地注册表兜底，保证演示可复现。
- 展示文案（三语）：
  - 中文：**你手机号码目前还没注册本银行使用**
  - English：*This phone number is not registered with this bank yet.*
  - ខ្មែរ：*លេខទូរស័ព្ទរបស់អ្នកមិនទាន់បានចុះឈ្មោះជាមួយធនាគារនេះទេ។*
- 未注册 → **不允许进入 OTP**；先去「បើកគណនីរហ័ស」注册。
