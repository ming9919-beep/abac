import {
  bigint,
  boolean,
  check,
  index,
  numeric,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { walletStatusEnum, walletTypeEnum } from "./enums";
import { users } from "./users";

/* ────────────────────────────────────────────────────────────────────────────
   assets — 资产（币种；将来扩展多链时填 network/contract_address）
   decimals 决定 money.ts 的基本单位换算：USD=2、KHR=0。
   ──────────────────────────────────────────────────────────────────────────── */
export const assets = pgTable(
  "assets",
  {
    /** 代号即主键：USD / KHR */
    code: varchar("code", { length: 10 }).primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    symbol: varchar("symbol", { length: 10 }).notNull(),
    decimals: smallint("decimals").notNull(),
    /** 预留：启用多链后填，如 'bep20' / 'erc20' */
    network: varchar("network", { length: 30 }),
    /** 预留：链上合约地址 */
    contractAddress: varchar("contract_address", { length: 128 }),
    minDeposit: numeric("min_deposit", { precision: 38, scale: 18 })
      .notNull()
      .default("0"),
    minWithdrawal: numeric("min_withdrawal", { precision: 38, scale: 18 })
      .notNull()
      .default("0"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    decimalsCheck: check(
      "assets_decimals_check",
      sql`${t.decimals} >= 0 AND ${t.decimals} <= 18`,
    ),
    minDepositCheck: check(
      "assets_min_deposit_check",
      sql`${t.minDeposit} >= 0`,
    ),
    minWithdrawalCheck: check(
      "assets_min_withdrawal_check",
      sql`${t.minWithdrawal} >= 0`,
    ),
  }),
);

/* ────────────────────────────────────────────────────────────────────────────
   wallets — 钱包账户
   balance     ：已结算总额（账本汇总的快照，只用于快速查询）
   locked      ：冻结中金额
   可用余额 = balance - locked（查询时计算，不落字段）
   约束：balance >= 0、locked >= 0、locked <= balance
   ──────────────────────────────────────────────────────────────────────────── */
export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 对外账户号，例如 ABAUSD1234567890 */
    walletNo: varchar("wallet_no", { length: 32 }).notNull(),
    /** 系统钱包为 NULL */
    userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
    assetCode: varchar("asset_code", { length: 10 })
      .notNull()
      .references(() => assets.code, { onDelete: "restrict" }),
    walletType: walletTypeEnum("wallet_type")
      .notNull()
      .default("user"),
    status: walletStatusEnum("status").notNull().default("active"),
    /** numeric 字符串，单位「元」；计算走 BigInt 基本单位 */
    balance: numeric("balance", { precision: 38, scale: 18 })
      .notNull()
      .default("0"),
    lockedBalance: numeric("locked_balance", { precision: 38, scale: 18 })
      .notNull()
      .default("0"),
    /** 每次变更 +1，便于排查并发问题 */
    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    walletNoIdx: uniqueIndex("wallets_wallet_no_uidx").on(t.walletNo),
    /** 一个用户每个币种只有一个钱包 */
    userAssetIdx: uniqueIndex("wallets_user_asset_uidx")
      .on(t.userId, t.assetCode)
      .where(sql`${t.walletType} = 'user'`),
    /** 每个币种只有一套系统钱包 */
    systemAssetIdx: uniqueIndex("wallets_system_asset_uidx")
      .on(t.walletType, t.assetCode)
      .where(sql`${t.walletType} <> 'user'`),
    assetIdx: index("wallets_asset_idx").on(t.assetCode),
    /** 用户钱包非负；系统钱包允许为负（在途/对外头寸） */
    balanceCheck: check(
      "wallets_balance_check",
      sql`${t.walletType} <> 'user' OR ${t.balance} >= 0`,
    ),
    lockedCheck: check("wallets_locked_balance_check", sql`${t.lockedBalance} >= 0`),
    lockedAtMostBalanceCheck: check(
      "wallets_locked_lte_balance_check",
      sql`${t.walletType} <> 'user' OR ${t.lockedBalance} <= ${t.balance}`,
    ),
    ownerCheck: check(
      "wallets_owner_check",
      sql`(${t.walletType} = 'user' AND ${t.userId} IS NOT NULL)
          OR (${t.walletType} <> 'user' AND ${t.userId} IS NULL)`,
    ),
  }),
);

export type Asset = typeof assets.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
