-- =====================================================================
-- 0000_wallet_core.sql — 钱包数据库核心结构（PostgreSQL 15+）
--
-- 对应 docs/wallet/02-data-model.md
-- 幂等：可重复执行（枚举用 DO 块、表用 IF NOT EXISTS、触发器先 DROP 后 CREATE）
-- 事务：整文件在一个事务里，失败自动回滚
--
-- 关键不变式（数据库层强制）：
--   1. 钱包余额永不为负：CHECK (balance >= 0)
--   2. 冻结不超过余额：CHECK (locked_balance <= balance)
--   3. 每笔交易的分录借贷平衡（COMMIT 时校验，不平衡即回滚）
--   4. ledger_entries / transaction_events / audit_logs 只追加，禁止 UPDATE/DELETE
--   5. 手机号唯一（排除已注销）；证件号哈希唯一（每个用户都不同）
-- =====================================================================

BEGIN;

-- gen_random_uuid() 从 PostgreSQL 13 起是内核自带函数；
-- 若目标库版本更老或运行在受限环境（如 PGlite），尽力启用 pgcrypto 失败也不中断。
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'skip pgcrypto extension: %', SQLERRM;
  END;
END;
$$;

-- ---------------------------------------------------------------------
-- 枚举
-- ---------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE user_status AS ENUM
  ('pending_verification','active','suspended','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE wallet_type AS ENUM
  ('user','system_suspense','system_fee','system_revenue','system_settlement');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE wallet_status AS ENUM
  ('active','frozen','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE transaction_type AS ENUM
  ('deposit','withdrawal','transfer','refund','reversal','fee','adjustment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE transaction_status AS ENUM
  ('created','pending','processing','requires_review','succeeded',
   'failed','canceled','expired','reversed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE ledger_direction AS ENUM ('debit','credit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE ledger_entry_type AS ENUM
  ('principal','fee','refund','reversal','adjustment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE hold_status AS ENUM
  ('active','released','captured','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE idempotency_status AS ENUM
  ('in_progress','completed','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE actor_type AS ENUM
  ('user','admin','system','provider');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE approval_status AS ENUM
  ('pending','approved','rejected','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE reconciliation_status AS ENUM
  ('running','completed','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE reconciliation_item_status AS ENUM
  ('matched','mismatched','resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 通用触发器函数
-- ---------------------------------------------------------------------
-- 自动维护 updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 只追加表：拒绝任何 UPDATE / DELETE
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- 账本分录组借贷平衡校验（延迟到 COMMIT 时执行）
CREATE OR REPLACE FUNCTION check_ledger_group_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad_group uuid;
  bad_asset text;
  diff numeric;
BEGIN
  SELECT le.entry_group_id, le.asset_code,
         SUM(CASE WHEN le.direction = 'debit' THEN le.amount ELSE -le.amount END)
    INTO bad_group, bad_asset, diff
    FROM ledger_entries le
   WHERE le.entry_group_id = NEW.entry_group_id
   GROUP BY le.entry_group_id, le.asset_code
  HAVING SUM(CASE WHEN le.direction = 'debit' THEN le.amount ELSE -le.amount END) <> 0
  LIMIT 1;

  IF bad_group IS NOT NULL THEN
    RAISE EXCEPTION 'unbalanced ledger group % (asset %, diff %)',
      bad_group, bad_asset, diff
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------
-- users — 用户（手机号未注册即无法登录）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_no                 varchar(20) NOT NULL,
  phone                   varchar(20) NOT NULL,
  phone_country           char(2) NOT NULL DEFAULT 'KH',
  email                   varchar(255),
  password_hash           text NOT NULL,            -- 只存 scrypt 哈希，绝不存明文
  status                  user_status NOT NULL DEFAULT 'pending_verification',
  phone_verified_at       timestamptz,
  kyc_level               smallint NOT NULL DEFAULT 0,
  last_login_at           timestamptz,
  failed_login_attempts   integer NOT NULL DEFAULT 0,
  locked_until            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT users_kyc_level_check CHECK (kyc_level BETWEEN 0 AND 3),
  CONSTRAINT users_failed_login_attempts_check CHECK (failed_login_attempts >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_user_no_uidx ON users (user_no);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uidx ON users (phone)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users (lower(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status, created_at);

-- ---------------------------------------------------------------------
-- user_profiles — 用户资料（一人一行，证件号一人一号）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id                     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name                   varchar(200) NOT NULL,
  full_name_kh                varchar(200),
  date_of_birth               date,
  gender                      varchar(20),
  national_id_no_encrypted    text,                  -- AES-256-GCM 密文
  national_id_no_hash         char(64),              -- HMAC-SHA256，唯一
  national_id_no_last4        char(4),               -- 展示用后 4 位
  address                     text,
  avatar_url                  text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_profiles_national_id_last4_check
    CHECK (national_id_no_last4 IS NULL OR length(national_id_no_last4) = 4)
);

-- 同一个证件号只能绑定一个用户 → 每个用户的证件号天然不同
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_national_id_hash_uidx
  ON user_profiles (national_id_no_hash)
  WHERE national_id_no_hash IS NOT NULL;

-- ---------------------------------------------------------------------
-- user_sessions / login_attempts — 会话与登录留痕
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    char(64) NOT NULL,                   -- 只存 token 的 SHA-256
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_hash_uidx
  ON user_sessions (token_hash);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       varchar(20) NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  outcome     varchar(40) NOT NULL,   -- success / bad_password / phone_not_registered /
                                      -- account_locked / account_suspended
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_phone_time_idx ON login_attempts (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_time_idx ON login_attempts (created_at DESC);

-- ---------------------------------------------------------------------
-- assets — 资产（币种；多链字段预留在 network / contract_address）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  code              varchar(10) PRIMARY KEY,
  name              varchar(100) NOT NULL,
  symbol            varchar(10) NOT NULL,
  decimals          smallint NOT NULL,
  network           varchar(30),
  contract_address  varchar(128),
  min_deposit       numeric(38,18) NOT NULL DEFAULT 0,
  min_withdrawal    numeric(38,18) NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_decimals_check CHECK (decimals BETWEEN 0 AND 18),
  CONSTRAINT assets_min_deposit_check CHECK (min_deposit >= 0),
  CONSTRAINT assets_min_withdrawal_check CHECK (min_withdrawal >= 0)
);

-- ---------------------------------------------------------------------
-- wallets — 钱包账户
--   balance     = 已结算总额（账本汇总快照）
--   locked      = 冻结中金额
--   可用余额     = balance - locked（查询时计算）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_no       varchar(32) NOT NULL,
  user_id         uuid REFERENCES users(id) ON DELETE RESTRICT,
  asset_code      varchar(10) NOT NULL REFERENCES assets(code) ON DELETE RESTRICT,
  wallet_type     wallet_type NOT NULL DEFAULT 'user',
  status          wallet_status NOT NULL DEFAULT 'active',
  balance         numeric(38,18) NOT NULL DEFAULT 0,
  locked_balance  numeric(38,18) NOT NULL DEFAULT 0,
  version         bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_wallet_no_uidx UNIQUE (wallet_no),
  -- 用户钱包余额必须非负；系统钱包（暂存/手续费/收入/结算）允许为负，
  -- 表示「资金在途/对外头寸」，全局守恒由对账保证
  CONSTRAINT wallets_balance_check CHECK (wallet_type <> 'user' OR balance >= 0),
  CONSTRAINT wallets_locked_balance_check CHECK (locked_balance >= 0),
  CONSTRAINT wallets_locked_lte_balance_check
    CHECK (wallet_type <> 'user' OR locked_balance <= balance),
  CONSTRAINT wallets_owner_check CHECK (
    (wallet_type = 'user' AND user_id IS NOT NULL)
    OR (wallet_type <> 'user' AND user_id IS NULL)
  )
);

-- 用户钱包：一人一币种一个
CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_asset_uidx
  ON wallets (user_id, asset_code) WHERE wallet_type = 'user';
-- 系统钱包：每币种一套
CREATE UNIQUE INDEX IF NOT EXISTS wallets_system_asset_uidx
  ON wallets (wallet_type, asset_code) WHERE wallet_type <> 'user';
CREATE INDEX IF NOT EXISTS wallets_asset_idx ON wallets (asset_code);

-- ---------------------------------------------------------------------
-- transactions — 业务交易单
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_no                  varchar(32) NOT NULL,
  type                   transaction_type NOT NULL,
  status                 transaction_status NOT NULL DEFAULT 'created',
  asset_code             varchar(10) NOT NULL REFERENCES assets(code) ON DELETE RESTRICT,
  amount                 numeric(38,18) NOT NULL,
  fee_amount             numeric(38,18) NOT NULL DEFAULT 0,
  net_amount             numeric(38,18) NOT NULL,
  initiator_user_id      uuid REFERENCES users(id) ON DELETE RESTRICT,
  from_wallet_id         uuid REFERENCES wallets(id) ON DELETE RESTRICT,
  to_wallet_id           uuid REFERENCES wallets(id) ON DELETE RESTRICT,
  parent_transaction_id  uuid REFERENCES transactions(id) ON DELETE RESTRICT,
  idempotency_key        varchar(128),
  provider               varchar(30),
  provider_ref           varchar(128),
  external_ref           varchar(128),
  description            text,
  failure_code           varchar(50),
  failure_reason         text,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  requires_approval      boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  CONSTRAINT transactions_tx_no_uidx UNIQUE (tx_no),
  CONSTRAINT transactions_amount_check CHECK (amount > 0),
  CONSTRAINT transactions_fee_amount_check CHECK (fee_amount >= 0),
  CONSTRAINT transactions_net_amount_check CHECK (net_amount > 0 AND net_amount <= amount),
  CONSTRAINT transactions_initiator_check CHECK (
    initiator_user_id IS NOT NULL OR type IN ('deposit','adjustment')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS transactions_idempotency_uidx
  ON transactions (initiator_user_id, type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_user_created_idx
  ON transactions (initiator_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_status_created_idx
  ON transactions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_provider_ref_idx
  ON transactions (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_parent_idx ON transactions (parent_transaction_id);
CREATE INDEX IF NOT EXISTS transactions_type_created_idx
  ON transactions (type, created_at DESC);

-- ---------------------------------------------------------------------
-- transaction_events — 状态流转留痕（只追加）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_events (
  id              bigserial PRIMARY KEY,
  transaction_id  uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  from_status     transaction_status,
  to_status       transaction_status NOT NULL,
  actor_type      actor_type NOT NULL DEFAULT 'system',
  actor_id        uuid,
  reason          text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transaction_events_tx_time_idx
  ON transaction_events (transaction_id, created_at);

-- ---------------------------------------------------------------------
-- holds — 冻结记录
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  wallet_id       uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  asset_code      varchar(10) NOT NULL REFERENCES assets(code) ON DELETE RESTRICT,
  amount          numeric(38,18) NOT NULL,
  status          hold_status NOT NULL DEFAULT 'active',
  reason          text,
  expires_at      timestamptz,
  released_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holds_amount_check CHECK (amount > 0)
);

-- 同一单据同一钱包只能有一条有效冻结
CREATE UNIQUE INDEX IF NOT EXISTS holds_active_tx_wallet_uidx
  ON holds (transaction_id, wallet_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS holds_wallet_status_idx ON holds (wallet_id, status);
CREATE INDEX IF NOT EXISTS holds_expires_idx ON holds (expires_at)
  WHERE status = 'active';

-- ---------------------------------------------------------------------
-- ledger_entries — 账本流水（只追加 · 复式记账 · 资金变化的唯一依据）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id               bigserial PRIMARY KEY,
  entry_group_id   uuid NOT NULL,
  transaction_id   uuid NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  wallet_id        uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  asset_code       varchar(10) NOT NULL REFERENCES assets(code) ON DELETE RESTRICT,
  direction        ledger_direction NOT NULL,
  entry_type       ledger_entry_type NOT NULL DEFAULT 'principal',
  amount           numeric(38,18) NOT NULL,
  balance_before   numeric(38,18) NOT NULL,
  balance_after    numeric(38,18) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_amount_check CHECK (amount > 0)
  -- balance_after 的非负性由 wallets.balance 的 CHECK 保证
  -- （系统钱包的 balance_after 允许为负：表示在途/对外头寸）
);

CREATE INDEX IF NOT EXISTS ledger_entries_wallet_time_idx
  ON ledger_entries (wallet_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ledger_entries_tx_idx ON ledger_entries (transaction_id);
CREATE INDEX IF NOT EXISTS ledger_entries_group_idx ON ledger_entries (entry_group_id);
CREATE INDEX IF NOT EXISTS ledger_entries_asset_wallet_idx
  ON ledger_entries (asset_code, wallet_id);
CREATE INDEX IF NOT EXISTS ledger_entries_created_idx ON ledger_entries (created_at DESC);

-- ---------------------------------------------------------------------
-- idempotency_keys — 幂等记录
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            varchar(40) NOT NULL,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  key              varchar(128) NOT NULL,
  request_hash     char(64) NOT NULL,
  status           idempotency_status NOT NULL DEFAULT 'in_progress',
  response_status  integer,
  response_body    jsonb,
  transaction_id   uuid REFERENCES transactions(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_scope_user_key_uidx
  ON idempotency_keys (
    scope,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    key
  );
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx ON idempotency_keys (expires_at);
CREATE INDEX IF NOT EXISTS idempotency_keys_status_idx ON idempotency_keys (status, created_at);

-- ---------------------------------------------------------------------
-- audit_logs — 操作审计（只追加）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          bigserial PRIMARY KEY,
  actor_type  actor_type NOT NULL,
  actor_id    uuid,
  action      varchar(80) NOT NULL,
  entity_type varchar(50) NOT NULL,
  entity_id   varchar(64) NOT NULL,
  before      jsonb,
  after       jsonb,
  ip          inet,
  user_agent  text,
  request_id  varchar(64),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_entity_idx
  ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx
  ON audit_logs (actor_type, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action, created_at DESC);

-- ---------------------------------------------------------------------
-- transaction_limits / approval_requests
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_limits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_type         transaction_type NOT NULL,
  asset_code      varchar(10) REFERENCES assets(code) ON DELETE CASCADE,
  kyc_level       smallint NOT NULL DEFAULT 0,
  min_amount      numeric(38,18) NOT NULL DEFAULT 0,
  max_amount      numeric(38,18),
  daily_amount    numeric(38,18),
  daily_count     integer,
  monthly_amount  numeric(38,18),
  is_active       boolean NOT NULL DEFAULT true,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_limits_kyc_check CHECK (kyc_level BETWEEN 0 AND 3),
  CONSTRAINT transaction_limits_min_check CHECK (min_amount >= 0),
  CONSTRAINT transaction_limits_max_check
    CHECK (max_amount IS NULL OR max_amount >= min_amount),
  CONSTRAINT transaction_limits_daily_count_check
    CHECK (daily_count IS NULL OR daily_count > 0)
);

-- 每个作用域只能有一条启用的限额配置
CREATE UNIQUE INDEX IF NOT EXISTS transaction_limits_scope_uidx
  ON transaction_limits (tx_type, coalesce(asset_code, '*'), kyc_level)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS approval_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  status          approval_status NOT NULL DEFAULT 'pending',
  reason          text,
  decision_note   text,
  expires_at      timestamptz,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_requests_status_idx
  ON approval_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS approval_requests_tx_idx ON approval_requests (transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_pending_tx_uidx
  ON approval_requests (transaction_id) WHERE status = 'pending';

-- ---------------------------------------------------------------------
-- reconciliation_runs / reconciliation_items — 对账
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code      varchar(10) NOT NULL REFERENCES assets(code) ON DELETE RESTRICT,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  status          reconciliation_status NOT NULL DEFAULT 'running',
  total_debits    numeric(38,18) NOT NULL DEFAULT 0,
  total_credits   numeric(38,18) NOT NULL DEFAULT 0,
  wallet_count    integer NOT NULL DEFAULT 0,
  mismatch_count  integer NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  error           text,
  CONSTRAINT reconciliation_runs_period_check CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_asset_period_idx
  ON reconciliation_runs (asset_code, period_start DESC);
CREATE INDEX IF NOT EXISTS reconciliation_runs_status_idx
  ON reconciliation_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id              bigserial PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  wallet_id       uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  stored_balance  numeric(38,18) NOT NULL,
  ledger_balance  numeric(38,18) NOT NULL,
  difference      numeric(38,18) NOT NULL,
  status          reconciliation_item_status NOT NULL,
  resolved_by     uuid,
  resolved_at     timestamptz,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_items_difference_check
    CHECK (difference = stored_balance - ledger_balance)
);

CREATE INDEX IF NOT EXISTS reconciliation_items_run_status_idx
  ON reconciliation_items (run_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_items_run_wallet_uidx
  ON reconciliation_items (run_id, wallet_id);

-- ---------------------------------------------------------------------
-- 触发器
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS user_profiles_updated_at ON user_profiles;
CREATE TRIGGER user_profiles_updated_at BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS assets_updated_at ON assets;
CREATE TRIGGER assets_updated_at BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS wallets_updated_at ON wallets;
CREATE TRIGGER wallets_updated_at BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS transactions_updated_at ON transactions;
CREATE TRIGGER transactions_updated_at BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS holds_updated_at ON holds;
CREATE TRIGGER holds_updated_at BEFORE UPDATE ON holds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS idempotency_keys_updated_at ON idempotency_keys;
CREATE TRIGGER idempotency_keys_updated_at BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS transaction_limits_updated_at ON transaction_limits;
CREATE TRIGGER transaction_limits_updated_at BEFORE UPDATE ON transaction_limits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS approval_requests_updated_at ON approval_requests;
CREATE TRIGGER approval_requests_updated_at BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 只追加表：禁止 UPDATE / DELETE
DROP TRIGGER IF EXISTS ledger_entries_no_mutation ON ledger_entries;
CREATE TRIGGER ledger_entries_no_mutation
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

DROP TRIGGER IF EXISTS transaction_events_no_mutation ON transaction_events;
CREATE TRIGGER transaction_events_no_mutation
  BEFORE UPDATE OR DELETE ON transaction_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_mutation ON audit_logs;
CREATE TRIGGER audit_logs_no_mutation
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- 借贷平衡：延迟到 COMMIT 时校验
DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_ledger_group_balanced();

-- ---------------------------------------------------------------------
-- 视图：账本聚合余额（对账与查询复用）
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ledger_balance AS
SELECT w.id            AS wallet_id,
       w.wallet_no,
       w.user_id,
       w.asset_code,
       w.wallet_type,
       w.balance       AS stored_balance,
       COALESCE(l.ledger_balance, 0)             AS ledger_balance,
       w.balance - COALESCE(l.ledger_balance, 0) AS difference,
       w.locked_balance,
       w.balance - w.locked_balance              AS available_balance
FROM wallets w
LEFT JOIN (
  SELECT wallet_id,
         SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS ledger_balance
  FROM ledger_entries
  GROUP BY wallet_id
) l ON l.wallet_id = w.id;

-- 每笔单据的分录借贷差（应全部为 0）
CREATE OR REPLACE VIEW v_transaction_ledger_diff AS
SELECT transaction_id,
       asset_code,
       SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS diff
FROM ledger_entries
GROUP BY transaction_id, asset_code;

-- ---------------------------------------------------------------------
-- 角色（可选：仅在有权限时创建；受限环境/PGlite 自动跳过）
--   wallet_admin    : 迁移与维护（仅发布机）
--   wallet_app      : 业务 DML，不能 UPDATE/DELETE 只追加表
--   wallet_readonly : 全部只读（对账/审计查询）
-- 说明：GRANT 是对「当前已存在的表」生效；新增表后需重新授权或配置
--       ALTER DEFAULT PRIVILEGES（见 docs/wallet/06-security-and-deployment.md）
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallet_app') THEN
      EXECUTE 'CREATE ROLE wallet_app LOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallet_readonly') THEN
      EXECUTE 'CREATE ROLE wallet_readonly LOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallet_admin') THEN
      EXECUTE 'CREATE ROLE wallet_admin LOGIN';
    END IF;

    EXECUTE 'GRANT USAGE ON SCHEMA public TO wallet_app, wallet_readonly, wallet_admin';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wallet_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wallet_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON ledger_entries, transaction_events, audit_logs FROM wallet_app';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO wallet_readonly';
  EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
    RAISE NOTICE 'skip database role setup: %', SQLERRM;
  END;
END;
$$;

COMMIT;
