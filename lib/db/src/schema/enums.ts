import { pgEnum } from "drizzle-orm/pg-core";

/* ────────────────────────────────────────────────────────────────────────────
   钱包数据库的所有枚举。
   注意：新增取值必须用 `ALTER TYPE ... ADD VALUE`，历史值含义不可更改。
   ──────────────────────────────────────────────────────────────────────────── */

/** 用户状态：待验证 / 正常 / 冻结 / 已注销 */
export const userStatusEnum = pgEnum("user_status", [
  "pending_verification",
  "active",
  "suspended",
  "closed",
]);

/** 钱包类型：用户钱包 + 四类系统钱包（暂存/手续费/收入/结算） */
export const walletTypeEnum = pgEnum("wallet_type", [
  "user",
  "system_suspense",
  "system_fee",
  "system_revenue",
  "system_settlement",
]);

/** 钱包状态 */
export const walletStatusEnum = pgEnum("wallet_status", [
  "active",
  "frozen",
  "closed",
]);

/** 交易类型 */
export const transactionTypeEnum = pgEnum("transaction_type", [
  "deposit",
  "withdrawal",
  "transfer",
  "refund",
  "reversal",
  "fee",
  "adjustment",
]);

/** 交易状态（详见 docs/wallet/03-state-machines.md） */
export const transactionStatusEnum = pgEnum("transaction_status", [
  "created",
  "pending",
  "processing",
  "requires_review",
  "succeeded",
  "failed",
  "canceled",
  "expired",
  "reversed",
]);

/** 账本方向：借 / 贷 */
export const ledgerDirectionEnum = pgEnum("ledger_direction", [
  "debit",
  "credit",
]);

/** 分录类型：本金 / 手续费 / 退款 / 冲正 / 调账 */
export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", [
  "principal",
  "fee",
  "refund",
  "reversal",
  "adjustment",
]);

/** 冻结状态 */
export const holdStatusEnum = pgEnum("hold_status", [
  "active",
  "released",
  "captured",
  "expired",
]);

/** 幂等记录状态 */
export const idempotencyStatusEnum = pgEnum("idempotency_status", [
  "in_progress",
  "completed",
  "failed",
]);

/** 操作主体 */
export const actorTypeEnum = pgEnum("actor_type", [
  "user",
  "admin",
  "system",
  "provider",
]);

/** 审批状态 */
export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);

/** 对账批次状态 */
export const reconciliationStatusEnum = pgEnum("reconciliation_status", [
  "running",
  "completed",
  "failed",
]);

/** 对账明细状态 */
export const reconciliationItemStatusEnum = pgEnum(
  "reconciliation_item_status",
  ["matched", "mismatched", "resolved"],
);

export type UserStatus = (typeof userStatusEnum.enumValues)[number];
export type WalletType = (typeof walletTypeEnum.enumValues)[number];
export type WalletStatus = (typeof walletStatusEnum.enumValues)[number];
export type TransactionType = (typeof transactionTypeEnum.enumValues)[number];
export type TransactionStatus =
  (typeof transactionStatusEnum.enumValues)[number];
export type LedgerDirection = (typeof ledgerDirectionEnum.enumValues)[number];
export type LedgerEntryType = (typeof ledgerEntryTypeEnum.enumValues)[number];
export type HoldStatus = (typeof holdStatusEnum.enumValues)[number];
export type IdempotencyStatus = (typeof idempotencyStatusEnum.enumValues)[number];
export type ActorType = (typeof actorTypeEnum.enumValues)[number];
export type ApprovalStatus = (typeof approvalStatusEnum.enumValues)[number];
export type ReconciliationStatus =
  (typeof reconciliationStatusEnum.enumValues)[number];
export type ReconciliationItemStatus =
  (typeof reconciliationItemStatusEnum.enumValues)[number];
