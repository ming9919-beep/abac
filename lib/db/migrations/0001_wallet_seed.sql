-- =====================================================================
-- 0001_wallet_seed.sql — 种子数据（幂等，可重复执行）
--
-- 1. 资产：USD(2 位小数) / KHR(0 位小数)
-- 2. 每个币种一套系统钱包：暂存 / 手续费 / 收入 / 结算
-- 3. 默认限额（按币种 + KYC 等级；单位是「元」）
--
-- 规则：新增币种 = 插一行 assets + 插四个系统钱包，不需要改表结构。
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 资产
-- ---------------------------------------------------------------------
INSERT INTO assets (code, name, symbol, decimals, min_deposit, min_withdrawal, is_active)
VALUES
  ('USD', 'US Dollar',        '$',  2, '0.01',   '1.00',     true),
  ('KHR', 'Cambodian Riel',   '៛',  0, '100',    '4000',     true)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 系统钱包（user_id 必须为 NULL，见 wallets_owner_check）
--   suspense : 渠道待入账/出款在途资金
--   fee      : 手续费归集
--   revenue  : 平台收入
--   settlement: 备付金/结算
-- ---------------------------------------------------------------------
INSERT INTO wallets (wallet_no, user_id, asset_code, wallet_type, status, balance, locked_balance)
SELECT v.wallet_no::varchar, NULL::uuid, v.asset_code::varchar,
       v.wallet_type::wallet_type, 'active', 0::numeric, 0::numeric
FROM (VALUES
  ('SYS-USD-SUSPENSE',   'USD', 'system_suspense'),
  ('SYS-USD-FEE',        'USD', 'system_fee'),
  ('SYS-USD-REVENUE',    'USD', 'system_revenue'),
  ('SYS-USD-SETTLEMENT', 'USD', 'system_settlement'),
  ('SYS-KHR-SUSPENSE',   'KHR', 'system_suspense'),
  ('SYS-KHR-FEE',        'KHR', 'system_fee'),
  ('SYS-KHR-REVENUE',    'KHR', 'system_revenue'),
  ('SYS-KHR-SETTLEMENT', 'KHR', 'system_settlement')
) AS v(wallet_no, asset_code, wallet_type)
WHERE NOT EXISTS (
  SELECT 1 FROM wallets w
  WHERE w.wallet_type <> 'user'
    AND w.asset_code = v.asset_code
    AND w.wallet_type = v.wallet_type::wallet_type
);

-- ---------------------------------------------------------------------
-- 默认限额（仅 Kyc Level 0；上线前按业务复核）
-- 金额单位为「元」：USD 与 KHR 分开配置，避免混用数量级。
-- ---------------------------------------------------------------------
INSERT INTO transaction_limits
  (tx_type, asset_code, kyc_level, min_amount, max_amount,
   daily_amount, daily_count, monthly_amount, is_active, note)
SELECT v.tx_type::transaction_type, v.asset_code::varchar, 0,
       v.min_amount::numeric, v.max_amount::numeric,
       v.daily_amount::numeric, v.daily_count, v.monthly_amount::numeric,
       true, v.note::text
FROM (VALUES
  -- 币种, 类型,        单笔下限,   单笔上限,      日累计,        日笔数, 月累计
  ('USD','withdrawal','1.00','1000.00','2000.00',   10, '20000.00',  'KYC0 提现限额'),
  ('KHR','withdrawal','4000','4100000','8200000',    10, '82000000',  'KYC0 提现限额'),
  ('USD','transfer',  '0.01','2000.00','5000.00',    50, '50000.00',  'KYC0 转账限额'),
  ('KHR','transfer',  '100','8200000','20500000',   200, '205000000', 'KYC0 转账限额'),
  ('USD','deposit',   '0.01', NULL,    NULL,       NULL, NULL,        '充值仅校验最小金额'),
  ('KHR','deposit',   '100',  NULL,    NULL,       NULL, NULL,        '充值仅校验最小金额')
) AS v(asset_code, tx_type, min_amount, max_amount, daily_amount, daily_count, monthly_amount, note)
WHERE NOT EXISTS (
  SELECT 1 FROM transaction_limits l
  WHERE l.tx_type = v.tx_type::transaction_type
    AND l.asset_code = v.asset_code::varchar
    AND l.kyc_level = 0
    AND l.is_active
);

COMMIT;
