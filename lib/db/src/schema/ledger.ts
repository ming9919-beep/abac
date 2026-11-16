import {
  bigserial,
  check,
  index,
  numeric,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ledgerDirectionEnum, ledgerEntryTypeEnum } from "./enums";
import { assets, wallets } from "./assets";
import { transactions } from "./transactions";

/* ────────────────────────────────────────────────────────────────────────────
   ledger_entries — 账本流水（复式记账 · 只追加）

   这是资金变化的**唯一依据**；wallets.balance 只是便于查询的快照。
   - 每笔资金变动都通过 transaction_id 追溯到业务单据。
   - 同一笔交易的所有分录共享 entry_group_id；
     数据库在 COMMIT 时校验 SUM(debit) = SUM(credit)，不平衡整个事务回滚。
   - UPDATE / DELETE 由触发器 reject_mutation() 直接拒绝。
   ──────────────────────────────────────────────────────────────────────────── */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** 同一笔交易的全部分录共享，用于提交时借贷平衡校验 */
    entryGroupId: uuid("entry_group_id").notNull(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "restrict" }),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "restrict" }),
    assetCode: varchar("asset_code", { length: 10 })
      .notNull()
      .references(() => assets.code, { onDelete: "restrict" }),
    /** 借 = 资金流出该钱包；贷 = 资金流入该钱包（同一资产内借贷必须相等） */
    direction: ledgerDirectionEnum("direction").notNull(),
    entryType: ledgerEntryTypeEnum("entry_type").notNull().default("principal"),
    amount: numeric("amount", { precision: 38, scale: 18 }).notNull(),
    /** 记账前该钱包余额，便于审计复算 */
    balanceBefore: numeric("balance_before", { precision: 38, scale: 18 }).notNull(),
    balanceAfter: numeric("balance_after", { precision: 38, scale: 18 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    walletTimeIdx: index("ledger_entries_wallet_time_idx").on(
      t.walletId,
      t.createdAt,
      t.id,
    ),
    txIdx: index("ledger_entries_tx_idx").on(t.transactionId),
    groupIdx: index("ledger_entries_group_idx").on(t.entryGroupId),
    assetWalletIdx: index("ledger_entries_asset_wallet_idx").on(
      t.assetCode,
      t.walletId,
    ),
    amountCheck: check("ledger_entries_amount_check", sql`${t.amount} > 0`),
    // balance_after 的非负性由 wallets.balance 的 CHECK 保证：
    // 用户钱包必须 >= 0；系统钱包（暂存/手续费等）允许为负，表示在途/对外头寸
  }),
);

export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
