-- 0002_customer_transactions.sql
-- 客户转账/入账记录：每笔转出、入账都按手机号持久化，供通知中心与账单查询。
-- 独立于核心 transactions 表（避免 hold/ledger/外键约束耦合），原型期足够。
CREATE TABLE IF NOT EXISTS customer_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         varchar(32) NOT NULL,           -- 客户手机号（关联 users.phone）
  direction     varchar(10) NOT NULL,           -- 'debit' 转出 | 'credit' 入账
  counterparty  varchar(120) NOT NULL,          -- 对方名称
  amount        numeric(38,2) NOT NULL,
  currency      varchar(5) NOT NULL,            -- 'USD' | 'KHR'
  reference     varchar(64),                    -- 交易参考号
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_tx_phone_idx ON customer_transactions (phone, created_at DESC);
