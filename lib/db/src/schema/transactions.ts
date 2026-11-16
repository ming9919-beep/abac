import {
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  actorTypeEnum,
  holdStatusEnum,
  transactionStatusEnum,
  transactionTypeEnum,
} from "./enums";
import { assets, wallets } from "./assets";
import { users } from "./users";

/* ────────────────────────────────────────────────────────────────────────────
   transactions — 业务交易单（充值/提现/转账/退款/冲正/调账）
   创建单据不改余额；只有结算（succeeded）才写账本分录。
   ──────────────────────────────────────────────────────────────────────────── */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 对外单号，例如 TX20261114000012 */
    txNo: varchar("tx_no", { length: 32 }).notNull(),
    type: transactionTypeEnum("type").notNull(),
    status: transactionStatusEnum("status").notNull().default("created"),
    assetCode: varchar("asset_code", { length: 10 })
      .notNull()
      .references(() => assets.code, { onDelete: "restrict" }),
    /** 本金（不含手续费），单位「元」 */
    amount: numeric("amount", { precision: 38, scale: 18 }).notNull(),
    feeAmount: numeric("fee_amount", { precision: 38, scale: 18 })
      .notNull()
      .default("0"),
    /** amount - feeAmount（充值/收款方视角为 amount） */
    netAmount: numeric("net_amount", { precision: 38, scale: 18 }).notNull(),
    initiatorUserId: uuid("initiator_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    fromWalletId: uuid("from_wallet_id").references(() => wallets.id, {
      onDelete: "restrict",
    }),
    toWalletId: uuid("to_wallet_id").references(() => wallets.id, {
      onDelete: "restrict",
    }),
    /** 退款 / 冲正 指向原单，原单永不可改
     *  自引用本表必须写成 `(): AnyPgColumn => ...`，
     *  否则 TS 会在初始化表达式里循环推断（TS7022） */
    parentTransactionId: uuid("parent_transaction_id").references(
      (): AnyPgColumn => transactions.id,
      { onDelete: "restrict" },
    ),
    /** 与 initiator + type 组成唯一索引，防重复入账的第一道闸 */
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    provider: varchar("provider", { length: 30 }),
    /** 渠道侧单号（回调/对账用） */
    providerRef: varchar("provider_ref", { length: 128 }),
    /** 外部业务引用（银行/链上） */
    externalRef: varchar("external_ref", { length: 128 }),
    description: text("description"),
    failureCode: varchar("failure_code", { length: 50 }),
    failureReason: text("failure_reason"),
    /** 扩展：confirmations、risk_flags、渠道回执摘要 */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    txNoIdx: uniqueIndex("transactions_tx_no_uidx").on(t.txNo),
    idemIdx: uniqueIndex("transactions_idempotency_uidx")
      .on(t.initiatorUserId, t.type, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    userTimeIdx: index("transactions_user_created_idx").on(
      t.initiatorUserId,
      t.createdAt,
    ),
    statusTimeIdx: index("transactions_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    providerRefIdx: index("transactions_provider_ref_idx").on(
      t.provider,
      t.providerRef,
    ).where(sql`${t.providerRef} IS NOT NULL`),
    parentIdx: index("transactions_parent_idx").on(t.parentTransactionId),
    amountCheck: check("transactions_amount_check", sql`${t.amount} > 0`),
    feeCheck: check("transactions_fee_amount_check", sql`${t.feeAmount} >= 0`),
    netCheck: check(
      "transactions_net_amount_check",
      sql`${t.netAmount} > 0 AND ${t.netAmount} <= ${t.amount}`,
    ),
    /** 系统单据（充值入账等）也必须能追溯到发起人或外部渠道 */
    initiatorCheck: check(
      "transactions_initiator_check",
      sql`${t.initiatorUserId} IS NOT NULL
          OR ${t.type} = 'deposit'
          OR ${t.type} = 'adjustment'`,
    ),
  }),
);

/* ────────────────────────────────────────────────────────────────────────────
   transaction_events — 状态流转留痕（只追加）
   回答「这笔单为什么变成 failed」
   ──────────────────────────────────────────────────────────────────────────── */
export const transactionEvents = pgTable(
  "transaction_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    fromStatus: transactionStatusEnum("from_status"),
    toStatus: transactionStatusEnum("to_status").notNull(),
    actorType: actorTypeEnum("actor_type").notNull().default("system"),
    actorId: uuid("actor_id"),
    reason: text("reason"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    txTimeIdx: index("transaction_events_tx_time_idx").on(
      t.transactionId,
      t.createdAt,
    ),
  }),
);

/* ────────────────────────────────────────────────────────────────────────────
   holds — 冻结记录
   出账方向（提现/转账）创建时冻结 amount + fee；结算转出账，失败/取消/超时解冻。
   冻结只改 wallets.locked_balance，不写账本分录。
   ──────────────────────────────────────────────────────────────────────────── */
export const holds = pgTable(
  "holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "restrict" }),
    assetCode: varchar("asset_code", { length: 10 })
      .notNull()
      .references(() => assets.code, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 38, scale: 18 }).notNull(),
    status: holdStatusEnum("status").notNull().default("active"),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /** 同一单据同一钱包只能有一条有效冻结 */
    activeUniqueIdx: uniqueIndex("holds_active_tx_wallet_uidx")
      .on(t.transactionId, t.walletId)
      .where(sql`${t.status} = 'active'`),
    walletStatusIdx: index("holds_wallet_status_idx").on(t.walletId, t.status),
    amountCheck: check("holds_amount_check", sql`${t.amount} > 0`),
  }),
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type TransactionEvent = typeof transactionEvents.$inferSelect;
export type Hold = typeof holds.$inferSelect;
export type NewHold = typeof holds.$inferInsert;
