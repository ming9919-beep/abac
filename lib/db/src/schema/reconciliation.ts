import {
  bigserial,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  reconciliationItemStatusEnum,
  reconciliationStatusEnum,
} from "./enums";
import { assets, wallets } from "./assets";

/* ────────────────────────────────────────────────────────────────────────────
   reconciliation_runs — 对账批次
   内部对账：wallets.balance  vs  SUM(ledger_entries)（逐钱包逐币种）
   ──────────────────────────────────────────────────────────────────────────── */
export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetCode: varchar("asset_code", { length: 10 })
      .notNull()
      .references(() => assets.code, { onDelete: "restrict" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    status: reconciliationStatusEnum("status").notNull().default("running"),
    /** 该批次账本借方合计 / 贷方合计（应相等） */
    totalDebits: numeric("total_debits", { precision: 38, scale: 18 })
      .notNull()
      .default("0"),
    totalCredits: numeric("total_credits", { precision: 38, scale: 18 })
      .notNull()
      .default("0"),
    walletCount: integer("wallet_count").notNull().default(0),
    /** > 0 立即告警 */
    mismatchCount: integer("mismatch_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => ({
    assetPeriodIdx: index("reconciliation_runs_asset_period_idx").on(
      t.assetCode,
      t.periodStart,
    ),
    statusIdx: index("reconciliation_runs_status_idx").on(
      t.status,
      t.startedAt,
    ),
    periodCheck: check(
      "reconciliation_runs_period_check",
      sql`${t.periodEnd} >= ${t.periodStart}`,
    ),
  }),
);

/* ────────────────────────────────────────────────────────────────────────────
   reconciliation_items — 每个钱包的对账明细
   difference = stored_balance - ledger_balance；≠0 即差异，走 adjustment 补账并留痕。
   ──────────────────────────────────────────────────────────────────────────── */
export const reconciliationItems = pgTable(
  "reconciliation_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => reconciliationRuns.id, { onDelete: "cascade" }),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "restrict" }),
    /** 钱包表里的余额快照 */
    storedBalance: numeric("stored_balance", { precision: 38, scale: 18 }).notNull(),
    /** 账本聚合出来的余额 */
    ledgerBalance: numeric("ledger_balance", { precision: 38, scale: 18 }).notNull(),
    difference: numeric("difference", { precision: 38, scale: 18 }).notNull(),
    status: reconciliationItemStatusEnum("status").notNull(),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runStatusIdx: index("reconciliation_items_run_status_idx").on(
      t.runId,
      t.status,
    ),
    walletIdx: index("reconciliation_items_wallet_idx").on(t.walletId),
    /** 同一批次内每个钱包只有一条明细 */
    runWalletIdx: index("reconciliation_items_run_wallet_idx").on(
      t.runId,
      t.walletId,
    ),
    /** matched 时 difference 必须为 0（服务层保证），此处只做基本校验 */
    differenceCheck: check(
      "reconciliation_items_difference_check",
      sql`${t.difference} = ${t.storedBalance} - ${t.ledgerBalance}`,
    ),
  }),
);

export type ReconciliationRun = typeof reconciliationRuns.$inferSelect;
export type ReconciliationItem = typeof reconciliationItems.$inferSelect;
