import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { approvalStatusEnum, transactionTypeEnum } from "./enums";
import { assets } from "./assets";
import { transactions } from "./transactions";
import { users } from "./users";

/* ────────────────────────────────────────────────────────────────────────────
   transaction_limits — 限额配置
   唯一作用域：(tx_type, COALESCE(asset_code,'*'), kyc_level)，且只对启用行唯一。
   ──────────────────────────────────────────────────────────────────────────── */
export const transactionLimits = pgTable(
  "transaction_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    txType: transactionTypeEnum("tx_type").notNull(),
    /** NULL = 所有币种 */
    assetCode: varchar("asset_code", { length: 10 }).references(
      () => assets.code,
      { onDelete: "cascade" },
    ),
    kycLevel: smallint("kyc_level").notNull().default(0),
    minAmount: numeric("min_amount", { precision: 38, scale: 18 })
      .notNull()
      .default("0"),
    maxAmount: numeric("max_amount", { precision: 38, scale: 18 }),
    dailyAmount: numeric("daily_amount", { precision: 38, scale: 18 }),
    dailyCount: integer("daily_count"),
    monthlyAmount: numeric("monthly_amount", { precision: 38, scale: 18 }),
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    scopeIdx: uniqueIndex("transaction_limits_scope_uidx")
      .on(
        t.txType,
        sql`coalesce(${t.assetCode}, '*')`,
        t.kycLevel,
      )
      .where(sql`${t.isActive}`),
    kycCheck: check(
      "transaction_limits_kyc_check",
      sql`${t.kycLevel} >= 0 AND ${t.kycLevel} <= 3`,
    ),
    minCheck: check("transaction_limits_min_check", sql`${t.minAmount} >= 0`),
    maxCheck: check(
      "transaction_limits_max_check",
      sql`${t.maxAmount} IS NULL OR ${t.maxAmount} >= ${t.minAmount}`,
    ),
    dailyCountCheck: check(
      "transaction_limits_daily_count_check",
      sql`${t.dailyCount} IS NULL OR ${t.dailyCount} > 0`,
    ),
  }),
);

/* ────────────────────────────────────────────────────────────────────────────
   approval_requests — 审批（超阈值 / 风控命中 / 人工调账）
   操作人与审批人分离：requested_by ≠ approved_by（服务层校验，四眼原则）。
   ──────────────────────────────────────────────────────────────────────────── */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    status: approvalStatusEnum("status").notNull().default("pending"),
    /** 为什么需要审批（系统自动填风控原因或人工填写） */
    reason: text("reason"),
    /** 审批意见（必填，写入 audit_logs） */
    decisionNote: text("decision_note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index("approval_requests_status_idx").on(t.status, t.createdAt),
    txIdx: index("approval_requests_tx_idx").on(t.transactionId),
    pendingUniqueIdx: uniqueIndex("approval_requests_pending_tx_uidx")
      .on(t.transactionId)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export type TransactionLimit = typeof transactionLimits.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
