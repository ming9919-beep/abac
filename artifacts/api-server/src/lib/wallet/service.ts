/**
 * 资金核心服务（阶段四）。
 *
 * 不变式（docs/wallet/01-business-rules.md §3）：
 *   1. 账本流水是资金变化的**唯一依据**；wallets.balance 只是快照
 *   2. 创建单据**不改余额**，只校验 + 写 transactions + 建冻结
 *   3. 结算（confirm）时在**同一个数据库事务**里：
 *      锁钱包行 → 写成对分录 → 更新 balance/locked → 更新状态 → 写事件
 *   4. 失败/取消/超时：释放冻结，**不写任何分录**
 *   5. succeeded 是终态，冲正/退款只能开新单据，原单不可改
 *   6. 幂等：Idempotency-Key 与业务写入同事务抢占
 *
 * 记账方向（资产视角，同一资产内借贷必须相等）：
 *   用户收入 → 用户钱包 credit，来源钱包 debit
 *   用户支出 → 用户钱包 debit，接收方 credit
 */
import type { PoolClient } from "pg";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  lockWallets,
  query,
  queryOne,
  txQuery,
  txQueryOne,
  withTransaction,
} from "./db";
import { WalletError } from "./errors";
import {
  formatNumeric18,
  fromMinor,
  fromScale18,
  NUMERIC_SCALE,
  parseNumeric18,
  toAssetString,
  toPositiveMinor,
  toScale18,
} from "./money";
import { sha256Hex } from "./auth";

/** 18 位定点 → 币种精度字符串（API 响应用） */
function a18(value: bigint, decimals: number): string {
  return fromMinor(fromScale18(value, decimals), decimals);
}

/* ═══════════════════════════════════════════════════════════════
   公共类型
   ═══════════════════════════════════════════════════════════════ */

export interface TxView {
  txNo: string;
  id: string;
  type: string;
  status: string;
  asset: string;
  amount: string;
  feeAmount: string;
  netAmount: string;
  description: string | null;
  failureCode: string | null;
  failureReason: string | null;
  requiresApproval: boolean;
  createdAt: string;
  completedAt: string | null;
  parentTxNo: string | null;
  metadata: Record<string, unknown>;
}

export interface LedgerEntryView {
  id: number;
  txNo: string;
  type: string;
  direction: string;
  entryType: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  asset: string;
  createdAt: string;
}

export interface CreateResult {
  txNo: string;
  status: string;
  available?: string;
  /** 幂等重放：返回的是首次请求的结果 */
  replayed?: boolean;
}

type EntrySpec = {
  walletId: string;
  direction: "debit" | "credit";
  /** 18 位定点金额 */
  amount18: bigint;
  entryType?: "principal" | "fee" | "refund" | "reversal" | "adjustment";
};

/* ═══════════════════════════════════════════════════════════════
   小工具
   ═══════════════════════════════════════════════════════════════ */

function newTxNo(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  const stamp =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `TX${stamp}${rand}`.slice(0, 32);
}

/** 请求体规范化后哈希，用于识别「同 key 不同请求」 */
export function requestHashOf(body: unknown): string {
  return sha256Hex(stableStringify(body));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/* ═══════════════════════════════════════════════════════════════
   幂等
   ═══════════════════════════════════════════════════════════════ */

export type IdempotencyOutcome =
  | { kind: "new"; id: string }
  | { kind: "replay"; status: number; body: Record<string, unknown> }
  | { kind: "in_progress" };

/**
 * 在业务事务内抢占幂等键。
 * 插入成功 → 我是第一个请求；冲突 → 比对 request_hash 判定重放或 409。
 */
export async function beginIdempotency(
  client: PoolClient,
  opts: {
    scope: string;
    userId: string | null;
    key: string | null;
    requestHash: string;
  },
): Promise<IdempotencyOutcome> {
  const { scope, userId, key, requestHash } = opts;
  if (!key) throw new WalletError("IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key 请求头");

  const inserted = await txQueryOne<{ id: string }>(
    client,
    `INSERT INTO idempotency_keys (scope, user_id, key, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '24 hours')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [scope, userId, key, requestHash],
  );
  if (inserted) return { kind: "new", id: inserted.id };

  const existing = await txQueryOne<{
    request_hash: string;
    status: string;
    response_status: number | null;
    response_body: Record<string, unknown> | null;
  }>(
    client,
    `SELECT request_hash, status, response_status, response_body
       FROM idempotency_keys
      WHERE scope = $1
        AND coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid) =
            coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND key = $3`,
    [scope, userId, key],
  );

  if (!existing) {
    // 极罕见：并发下对端已回滚，重试一次由调用方处理
    throw new WalletError("REQUEST_IN_PROGRESS", "请求正在处理中，请稍后用同一 Key 重试");
  }

  const same = Buffer.from(String(existing.request_hash).trim(), "utf8").equals(
    Buffer.from(requestHash, "utf8"),
  );
  if (!same) {
    throw new WalletError(
      "IDEMPOTENCY_KEY_REUSED",
      "同一个 Idempotency-Key 不能用于不同的请求体",
      { scope, key },
    );
  }

  if (existing.status === "completed" && existing.response_body) {
    return {
      kind: "replay",
      status: existing.response_status ?? 200,
      body: existing.response_body,
    };
  }
  return { kind: "in_progress" };
}

async function completeIdempotency(
  client: PoolClient,
  scope: string,
  userId: string | null,
  key: string | null,
  status: number,
  body: Record<string, unknown>,
  transactionId?: string,
): Promise<void> {
  if (!key) return;
  await txQuery(
    client,
    `UPDATE idempotency_keys
        SET status = 'completed',
            response_status = $4,
            response_body = $5::jsonb,
            transaction_id = coalesce($6::uuid, transaction_id),
            updated_at = now()
      WHERE scope = $1
        AND coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid) =
            coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND key = $3`,
    [scope, userId, key, status, JSON.stringify(body), transactionId ?? null],
  );
}

/* ═══════════════════════════════════════════════════════════════
   记账（结算时唯一改余额的入口）
   ═══════════════════════════════════════════════════════════════ */

/**
 * 在当前事务内写分录并同步余额。
 * - 按 wallet_id 升序处理（调用方必须先 lockWallets，保证顺序一致）
 * - 借/贷合计必须相等，否则数据库的延迟约束触发器会在 COMMIT 时回滚
 */
export async function postEntries(
  client: PoolClient,
  txId: string,
  entries: EntrySpec[],
): Promise<void> {
  if (entries.length === 0) return;

  const group = randomUUID();
  const debitSum = entries
    .filter((e) => e.direction === "debit")
    .reduce((s, e) => s + e.amount18, 0n);
  const creditSum = entries
    .filter((e) => e.direction === "credit")
    .reduce((s, e) => s + e.amount18, 0n);
  if (debitSum !== creditSum) {
    // 应用层先挡一道；数据库延迟触发器是最后防线
    throw new WalletError(
      "INTERNAL_ERROR",
      `借贷不平衡（debit=${debitSum} credit=${creditSum}）`,
    );
  }

  const ordered = [...entries].sort((a, b) =>
    a.walletId < b.walletId ? -1 : a.walletId > b.walletId ? 1 : 0,
  );

  for (const e of ordered) {
    const before = await txQueryOne<{ balance: string; asset_code: string }>(
      client,
      `SELECT balance, asset_code FROM wallets WHERE id = $1 FOR UPDATE`,
      [e.walletId],
    );
    if (!before) throw new WalletError("WALLET_NOT_FOUND", "钱包不存在");

    const sign = e.direction === "debit" ? "-" : "+";
    const updated = await txQueryOne<{ balance: string }>(
      client,
      `UPDATE wallets
          SET balance = balance ${sign} $2::numeric,
              version = version + 1
        WHERE id = $1
        RETURNING balance`,
      [e.walletId, formatNumeric18(e.amount18)],
    );
    if (!updated) throw new WalletError("WALLET_NOT_FOUND", "钱包不存在");

    await txQuery(
      client,
      `INSERT INTO ledger_entries
         (entry_group_id, transaction_id, wallet_id, asset_code, direction,
          entry_type, amount, balance_before, balance_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric)`,
      [
        group,
        txId,
        e.walletId,
        before.asset_code,
        e.direction,
        e.entryType ?? "principal",
        formatNumeric18(e.amount18),
        before.balance,
        updated.balance,
      ],
    );
  }
}

/* ═══════════════════════════════════════════════════════════════
   冻结
   ═══════════════════════════════════════════════════════════════ */

async function createHold(
  client: PoolClient,
  txId: string,
  walletId: string,
  asset: string,
  amount18: bigint,
): Promise<void> {
  await txQuery(
    client,
    `INSERT INTO holds (transaction_id, wallet_id, asset_code, amount)
     VALUES ($1, $2, $3, $4::numeric)`,
    [txId, walletId, asset, formatNumeric18(amount18)],
  );
  const res = await txQuery(
    client,
    `UPDATE wallets
        SET locked_balance = locked_balance + $2::numeric,
            version = version + 1
      WHERE id = $1
        AND (wallet_type <> 'user' OR balance >= locked_balance + $2::numeric)
      RETURNING id`,
    [walletId, formatNumeric18(amount18)],
  );
  if (res.length === 0) {
    throw new WalletError("BALANCE_INSUFFICIENT", "可用余额不足");
  }
}

/** 释放冻结（失败/取消/超时路径；不写任何分录） */
async function releaseHold(
  client: PoolClient,
  txId: string,
  target: "released" | "captured" | "expired" = "released",
): Promise<void> {
  const holds = await txQuery<{ wallet_id: string; amount: string }>(
    client,
    `UPDATE holds
        SET status = $2,
            released_at = now(),
            updated_at = now()
      WHERE transaction_id = $1 AND status = 'active'
      RETURNING wallet_id, amount`,
    [txId, target],
  );
  for (const h of holds) {
    await txQuery(
      client,
      `UPDATE wallets
          SET locked_balance = greatest(0, locked_balance - $2::numeric),
              version = version + 1
        WHERE id = $1`,
      [h.wallet_id, h.amount],
    );
  }
}

/* ═══════════════════════════════════════════════════════════════
   状态机
   ═══════════════════════════════════════════════════════════════ */

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  created: ["pending", "canceled", "failed"],
  pending: ["processing", "requires_review", "canceled", "failed", "expired"],
  processing: ["succeeded", "failed", "expired"],
  requires_review: ["processing", "failed", "canceled"],
  expired: ["processing", "canceled", "succeeded"],
  succeeded: ["reversed"],
  failed: [],
  canceled: [],
  reversed: [],
};

/**
 * 确认入账/出款/结算前，把单据从 pending / requires_review / expired 推进到 processing。
 * 状态机规定 succeeded 只能从 processing 到达，渠道回调不能跳级。
 */
async function ensureProcessing(client: PoolClient, tx: { id: string; status: string }): Promise<void> {
  if (tx.status === "processing") return;
  await transition(client, tx.id, "processing", {
    actorType: "system",
    reason: "渠道确认，进入结算处理",
  });
}

async function transition(
  client: PoolClient,
  txId: string,
  to: string,
  opts: {
    actorType?: "user" | "admin" | "system" | "provider";
    actorId?: string | null;
    reason?: string | null;
    failureCode?: string | null;
    failureReason?: string | null;
    completed?: boolean;
  } = {},
): Promise<{ from: string; to: string }> {
  const row = await txQueryOne<{ status: string }>(
    client,
    `SELECT status FROM transactions WHERE id = $1 FOR UPDATE`,
    [txId],
  );
  if (!row) throw new WalletError("NOT_FOUND", "交易单不存在");

  const from = row.status;
  if (from === to) {
    // 幂等：重复回调直接返回当前状态，不再写事件
    return { from, to };
  }
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new WalletError(
      "INVALID_STATE",
      `交易状态不允许从 ${from} 变为 ${to}`,
      { from, to },
    );
  }

  await txQuery(
    client,
    `UPDATE transactions
        SET status = $2::transaction_status,
            completed_at = CASE WHEN $3::boolean THEN now() ELSE completed_at END,
            failure_code = coalesce($4::varchar, failure_code),
            failure_reason = coalesce($5::text, failure_reason)
      WHERE id = $1`,
    [txId, to, opts.completed ?? false, opts.failureCode ?? null, opts.failureReason ?? null],
  );
  await txQuery(
    client,
    `INSERT INTO transaction_events
       (transaction_id, from_status, to_status, actor_type, actor_id, reason)
     VALUES ($1, $2::transaction_status, $3::transaction_status, $4, $5, $6)`,
    [
      txId,
      from,
      to,
      opts.actorType ?? "system",
      opts.actorId ?? null,
      opts.reason ?? null,
    ],
  );
  return { from, to };
}

/* ═══════════════════════════════════════════════════════════════
   审计
   ═══════════════════════════════════════════════════════════════ */

export interface AuditInput {
  actorType: "user" | "admin" | "system" | "provider";
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function writeAudit(
  client: PoolClient | null,
  input: AuditInput,
): Promise<void> {
  const sql = `INSERT INTO audit_logs
       (actor_type, actor_id, action, entity_type, entity_id,
        before, after, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::inet, $9, $10)`;
  const params = [
    input.actorType,
    input.actorId ?? null,
    input.action,
    input.entityType,
    input.entityId,
    input.before ? JSON.stringify(input.before) : null,
    input.after ? JSON.stringify(input.after) : null,
    input.ip ?? null,
    input.userAgent ?? null,
    input.requestId ?? null,
  ];
  if (client) await txQuery(client, sql, params);
  else await query(sql, params);
}

/* ═══════════════════════════════════════════════════════════════
   限额与审批阈值
   ═══════════════════════════════════════════════════════════════ */

interface LimitRow {
  min_amount: string | null;
  max_amount: string | null;
  daily_amount: string | null;
  daily_count: number | null;
  monthly_amount: string | null;
}

async function checkLimits(
  client: PoolClient,
  input: {
    txType: string;
    asset: string;
    kycLevel: number;
    amount18: bigint;
    userId: string;
    decimals: number;
  },
): Promise<void> {
  const limit = await txQueryOne<LimitRow>(
    client,
    `SELECT min_amount, max_amount, daily_amount, daily_count, monthly_amount
       FROM transaction_limits
      WHERE tx_type = $1::transaction_type
        AND is_active
        AND kyc_level <= $2
        AND (asset_code = $3 OR asset_code IS NULL)
      ORDER BY (asset_code = $3) DESC, kyc_level DESC
      LIMIT 1`,
    [input.txType, input.kycLevel, input.asset],
  );
  if (!limit) return;

  const min = limit.min_amount ? parseNumeric18(limit.min_amount) : 0n;  const max = limit.max_amount ? parseNumeric18(limit.max_amount) : null;

  if (input.amount18 < min) {
    throw new WalletError(
      "LIMIT_EXCEEDED",
      `低于单笔最小金额 ${toAssetString(limit.min_amount, input.decimals)}`,
      { min: toAssetString(limit.min_amount, input.decimals), asset: input.asset },
    );
  }
  if (max !== null && input.amount18 > max) {
    throw new WalletError(
      "LIMIT_EXCEEDED",
      `超过单笔最大金额 ${toAssetString(limit.max_amount, input.decimals)}`,
      { max: toAssetString(limit.max_amount, input.decimals), asset: input.asset },
    );
  }

  // 日累计（金额 + 笔数）
  if (limit.daily_amount || limit.daily_count) {
    const daily = await txQueryOne<{ total: string; cnt: number }>(
      client,
      `SELECT COALESCE(SUM(amount), 0)::text AS total, COUNT(*)::int AS cnt
         FROM transactions
        WHERE initiator_user_id = $1
          AND type = $2::transaction_type
          AND asset_code = $3
          AND status NOT IN ('failed', 'canceled', 'expired')
          AND created_at >= date_trunc('day', now())`,
      [input.userId, input.txType, input.asset],
    );
    const total = parseNumeric18(daily?.total ?? "0");
    const dailyMax = limit.daily_amount ? parseNumeric18(limit.daily_amount) : null;
    if (dailyMax !== null && total + input.amount18 > dailyMax) {
      throw new WalletError(
        "LIMIT_EXCEEDED",
        `超过每日累计限额 ${toAssetString(limit.daily_amount, input.decimals)}`,
        { daily: toAssetString(limit.daily_amount, input.decimals), used: toAssetString(daily?.total ?? "0", input.decimals) },
      );
    }
    if (limit.daily_count && Number(daily?.cnt ?? 0) >= limit.daily_count) {
      throw new WalletError("LIMIT_EXCEEDED", `超过每日交易笔数 ${limit.daily_count}`, {
        dailyCount: limit.daily_count,
      });
    }
  }

  // 月累计
  if (limit.monthly_amount) {
    const monthly = await txQueryOne<{ total: string }>(
      client,
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM transactions
        WHERE initiator_user_id = $1
          AND type = $2::transaction_type
          AND asset_code = $3
          AND status NOT IN ('failed', 'canceled', 'expired')
          AND created_at >= date_trunc('month', now())`,
      [input.userId, input.txType, input.asset],
    );
    const total = parseNumeric18(monthly?.total ?? "0");
    const monthMax = parseNumeric18(limit.monthly_amount);
    if (total + input.amount18 > monthMax) {
      throw new WalletError(
        "LIMIT_EXCEEDED",
        `超过每月累计限额 ${toAssetString(limit.monthly_amount, input.decimals)}`,
        { monthly: toAssetString(limit.monthly_amount, input.decimals) },
      );
    }
  }
}

function reviewThreshold18(): bigint {
  const raw = process.env.WALLET_REVIEW_THRESHOLD ?? "1000";
  try {
    // 阈值按「元」配置，统一到 18 位定点
    return toScale18(toPositiveMinor(raw, 2), 2);
  } catch {
    return 1000n * 10n ** 16n;
  }
}

/* ═══════════════════════════════════════════════════════════════
   通用：读单据 / 钱包
   ═══════════════════════════════════════════════════════════════ */

interface TxRow {
  id: string;
  tx_no: string;
  type: string;
  status: string;
  asset_code: string;
  amount: string;
  fee_amount: string;
  net_amount: string;
  initiator_user_id: string | null;
  from_wallet_id: string | null;
  to_wallet_id: string | null;
  parent_transaction_id: string | null;
  description: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  requires_approval: boolean;
  created_at: Date | string;
  completed_at: Date | string | null;
  metadata: Record<string, unknown>;
  parent_tx_no?: string | null;
}

const TX_COLUMNS = `
  t.id, t.tx_no, t.type, t.status, t.asset_code, t.amount, t.fee_amount,
  t.net_amount, t.initiator_user_id, t.from_wallet_id, t.to_wallet_id,
  t.parent_transaction_id, t.description, t.failure_code, t.failure_reason,
  t.requires_approval, t.created_at, t.completed_at, t.metadata,
  p.tx_no AS parent_tx_no
`;

function toTxView(row: TxRow, decimals: number): TxView {
  return {
    id: row.id,
    txNo: row.tx_no,
    type: row.type,
    status: row.status,
    asset: row.asset_code,
    amount: toAssetString(row.amount, decimals),
    feeAmount: toAssetString(row.fee_amount, decimals),
    netAmount: toAssetString(row.net_amount, decimals),
    description: row.description,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    requiresApproval: Boolean(row.requires_approval),
    createdAt: iso(row.created_at)!,
    completedAt: iso(row.completed_at),
    parentTxNo: row.parent_tx_no ?? null,
    metadata: row.metadata ?? {},
  };
}

async function getTxRow(client: PoolClient, txId: string): Promise<TxRow> {
  const row = await txQueryOne<TxRow>(
    client,
    `SELECT ${TX_COLUMNS}
       FROM transactions t
       LEFT JOIN transactions p ON p.id = t.parent_transaction_id
      WHERE t.id::text = $1 OR t.tx_no = $1
      FOR UPDATE OF t`,
    [txId],
  );
  if (!row) throw new WalletError("NOT_FOUND", "交易单不存在");
  return row;
}

async function assetDecimals(client: PoolClient, asset: string): Promise<number> {
  const row = await txQueryOne<{ decimals: number }>(
    client,
    `SELECT decimals FROM assets WHERE code = $1 AND is_active`,
    [asset],
  );
  if (!row) throw new WalletError("ASSET_NOT_ACTIVE", `不支持的币种: ${asset}`);
  return Number(row.decimals);
}

interface WalletRow {
  id: string;
  wallet_no: string;
  user_id: string | null;
  asset_code: string;
  status: string;
  balance: string;
  locked_balance: string;
}

async function getUserWallet(
  client: PoolClient,
  userId: string,
  asset: string,
): Promise<WalletRow> {
  const row = await txQueryOne<WalletRow>(
    client,
    `SELECT id, wallet_no, user_id, asset_code, status, balance, locked_balance
       FROM wallets
      WHERE user_id = $1 AND asset_code = $2 AND wallet_type = 'user'
      FOR UPDATE`,
    [userId, asset],
  );
  if (!row) {
    throw new WalletError("WALLET_NOT_FOUND", `没有 ${asset} 钱包账户`);
  }
  if (row.status !== "active") {
    throw new WalletError("WALLET_FROZEN", "钱包账户状态异常，无法发起交易", {
      status: row.status,
    });
  }
  return row;
}

async function getSystemWallet(
  client: PoolClient,
  type: "system_suspense" | "system_fee" | "system_revenue" | "system_settlement",
  asset: string,
): Promise<WalletRow> {
  const row = await txQueryOne<WalletRow>(
    client,
    `SELECT id, wallet_no, user_id, asset_code, status, balance, locked_balance
       FROM wallets
      WHERE wallet_type = $1 AND asset_code = $2
      FOR UPDATE`,
    [type, asset],
  );
  if (!row) {
    throw new WalletError("WALLET_NOT_FOUND", `缺少系统钱包 ${type}/${asset}`);
  }
  return row;
}

function assertAvailable(row: WalletRow, needed18: bigint): void {
  const balance = parseNumeric18(row.balance);
  const locked = parseNumeric18(row.locked_balance);
  const available = balance - locked;
  if (available < needed18) {
    throw new WalletError("BALANCE_INSUFFICIENT", "可用余额不足", {
      available: formatNumeric18(available),
      required: formatNumeric18(needed18),
    });
  }
}

/* ═══════════════════════════════════════════════════════════════
   1. 充值
   ═══════════════════════════════════════════════════════════════ */

export interface CreateDepositInput {
  userId: string;
  asset: string;
  amount: string;
  provider?: string | null;
  externalRef?: string | null;
  description?: string | null;
  idempotencyKey?: string | null;
  requestHash: string;
}

export async function createDeposit(input: CreateDepositInput): Promise<CreateResult> {
  return withTransaction(async (client) => {
    const idem = await beginIdempotency(client, {
      scope: "deposit.create",
      userId: input.userId,
      key: input.idempotencyKey ?? null,
      requestHash: input.requestHash,
    });
    if (idem.kind === "replay") {
      return {
        txNo: String(idem.body.txNo ?? ""),
        status: String(idem.body.status ?? "pending"),
        replayed: true,
      };
    }
    if (idem.kind === "in_progress") {
      throw new WalletError("REQUEST_IN_PROGRESS", "相同请求正在处理中，请稍后重试");
    }

    const decimals = await assetDecimals(client, input.asset);
    const minor = toPositiveMinor(input.amount, decimals);
    const amount18 = toScale18(minor, decimals);

    // 最低充值门槛
    const assetRow = await txQueryOne<{ min_deposit: string }>(
      client,
      `SELECT min_deposit FROM assets WHERE code = $1`,
      [input.asset],
    );
    if (assetRow && amount18 < parseNumeric18(assetRow.min_deposit)) {
      throw new WalletError(
        "LIMIT_EXCEEDED",
        `低于最低充值金额 ${toAssetString(assetRow.min_deposit, decimals)}`,
        { min: toAssetString(assetRow.min_deposit, decimals) },
      );
    }

    const user = await txQueryOne<{ kyc_level: number }>(
      client,
      `SELECT kyc_level FROM users WHERE id = $1`,
      [input.userId],
    );
    if (!user) throw new WalletError("NOT_FOUND", "用户不存在");

    await checkLimits(client, {
      txType: "deposit",
      asset: input.asset,
      kycLevel: Number(user.kyc_level),
      amount18,
      userId: input.userId,
      decimals,
    });

    const wallet = await getUserWallet(client, input.userId, input.asset);
    const txId = randomUUID();
    const txNo = newTxNo();
    const needsApproval = amount18 >= reviewThreshold18();

    await txQuery(
      client,
      `INSERT INTO transactions
         (id, tx_no, type, status, asset_code, amount, fee_amount, net_amount,
          initiator_user_id, to_wallet_id, idempotency_key, provider, external_ref,
          description, requires_approval, metadata)
       VALUES ($1, $2, 'deposit', $3::transaction_status, $4, $5::numeric, 0::numeric,
               $5::numeric, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        txId,
        txNo,
        needsApproval ? "requires_review" : "pending",
        input.asset,
        formatNumeric18(amount18),
        input.userId,
        wallet.id,
        input.idempotencyKey ?? null,
        input.provider ?? null,
        input.externalRef ?? null,
        input.description ?? null,
        needsApproval,
        JSON.stringify({ origin: "api" }),
      ],
    );
    await txQuery(
      client,
      `INSERT INTO transaction_events (transaction_id, from_status, to_status, actor_type, actor_id)
       VALUES ($1, 'created', $2::transaction_status, 'user', $3)`,
      [txId, needsApproval ? "requires_review" : "pending", input.userId],
    );

    const body = { txNo, status: needsApproval ? "requires_review" : "pending" };
    await completeIdempotency(
      client,
      "deposit.create",
      input.userId,
      input.idempotencyKey ?? null,
      201,
      body,
      txId,
    );
    return { ...body, available: a18(parseNumeric18(wallet.balance), decimals) };
  });
}

export interface ConfirmDepositInput {
  txId: string;
  amount?: string;
  providerRef?: string | null;
  signature?: string | null;
  actorType?: "provider" | "admin" | "system";
}

/** 渠道回调：验签 → 幂等 → 借暂存/贷用户 → succeeded */
export async function confirmDeposit(input: ConfirmDepositInput): Promise<TxView> {
  verifyProviderSignature(input.signature, {
    txId: input.txId,
    amount: input.amount ?? "",
    providerRef: input.providerRef ?? "",
  });

  return withTransaction(async (client) => {
    const tx = await getTxRow(client, input.txId);
    const decimals = await assetDecimals(client, tx.asset_code);

    // 重复回调：已成功 → 幂等返回，不重复入账
    if (tx.status === "succeeded") return toTxView(tx, decimals);
    if (tx.type !== "deposit") {
      throw new WalletError("INVALID_STATE", "只有充值单可以确认入账");
    }
    if (!["pending", "processing", "requires_review", "expired"].includes(tx.status)) {
      throw new WalletError("INVALID_STATE", `充值单当前状态 ${tx.status} 无法确认`, {
        status: tx.status,
      });
    }

    // 金额/币种比对
    if (input.amount) {
      const expected = parseNumeric18(tx.amount);
      const got = parseNumeric18(input.amount);
      if (expected !== got) {
        await transition(client, tx.id, "failed", {
          actorType: "system",
          reason: "回调金额与单据不符",
          failureCode: "AMOUNT_MISMATCH",
          failureReason: `expected=${tx.amount} got=${input.amount}`,
        });
        throw new WalletError(
          "AMOUNT_MISMATCH",
          "回调金额与单据不一致，已转人工复核",
          { expected: tx.amount, got: input.amount },
        );
      }
    }

    const amount18 = parseNumeric18(tx.amount);
    // pending → processing → succeeded（状态机不允许跳级）
    await ensureProcessing(client, tx);
    // 加锁顺序与提现/转账保持一致：先用户钱包，后系统钱包，避免互相等待
    const wallet = await getUserWallet(client, tx.initiator_user_id!, tx.asset_code);
    const suspense = await getSystemWallet(client, "system_suspense", tx.asset_code);

    await lockWallets(client, [wallet.id, suspense.id]);
    await postEntries(client, tx.id, [
      { walletId: suspense.id, direction: "debit", amount18 },
      { walletId: wallet.id, direction: "credit", amount18 },
    ]);

    if (input.providerRef) {
      await txQuery(
        client,
        `UPDATE transactions SET provider_ref = $2 WHERE id = $1`,
        [tx.id, input.providerRef],
      );
    }
    await transition(client, tx.id, "succeeded", {
      actorType: input.actorType ?? "provider",
      reason: "充值入账成功",
      completed: true,
    });

    return toTxView(await getTxRow(client, tx.id), decimals);
  });
}

/** 渠道失败回调：pending → failed，不写分录（无冻结可释放） */
export async function failDeposit(
  txId: string,
  reason: string,
  code = "CHANNEL_DECLINED",
): Promise<TxView> {
  return withTransaction(async (client) => {
    const tx = await getTxRow(client, txId);
    const decimals = await assetDecimals(client, tx.asset_code);
    if (tx.status === "succeeded") {
      throw new WalletError("INVALID_STATE", "充值单已入账，无法标记失败（请走退款/冲正）");
    }
    if (tx.status !== "failed") {
      await transition(client, tx.id, "failed", {
        actorType: "provider",
        reason,
        failureCode: code,
        failureReason: reason,
      });
    }
    return toTxView(await getTxRow(client, tx.id), decimals);
  });
}

/**
 * 渠道回调验签：HMAC-SHA256(WALLET_PROVIDER_WEBHOOK_SECRET, txId.amount.providerRef)
 * 未配置密钥的环境（本地 mock）直接放行；生产必须配置，否则一律拒绝。
 */
function verifyProviderSignature(
  signature: string | null | undefined,
  payload: { txId: string; amount: string; providerRef: string },
): void {
  const secret = process.env.WALLET_PROVIDER_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new WalletError(
        "SIGNATURE_INVALID",
        "生产环境必须配置 WALLET_PROVIDER_WEBHOOK_SECRET",
      );
    }
    return; // 本地 mock 模式
  }
  if (!signature) {
    throw new WalletError("SIGNATURE_INVALID", "缺少回调签名");
  }
  const expected = createHash("sha256") // 占位：生产应改用渠道公钥验签
    .update(`${secret}|${payload.txId}|${payload.amount}|${payload.providerRef}`)
    .digest("hex");
  const a = Buffer.from(String(signature).slice(0, 64), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WalletError("SIGNATURE_INVALID", "回调验签失败");
  }
}

/* ═══════════════════════════════════════════════════════════════
   2. 提现
   ═══════════════════════════════════════════════════════════════ */

export interface CreateWithdrawalInput {
  userId: string;
  asset: string;
  amount: string;
  feeAmount?: string;
  destination?: Record<string, unknown> | null;
  note?: string | null;
  idempotencyKey?: string | null;
  requestHash: string;
}

export async function createWithdrawal(
  input: CreateWithdrawalInput,
): Promise<CreateResult> {
  return withTransaction(async (client) => {
    const idem = await beginIdempotency(client, {
      scope: "withdrawal.create",
      userId: input.userId,
      key: input.idempotencyKey ?? null,
      requestHash: input.requestHash,
    });
    if (idem.kind === "replay") {
      return {
        txNo: String(idem.body.txNo ?? ""),
        status: String(idem.body.status ?? "pending"),
        replayed: true,
      };
    }
    if (idem.kind === "in_progress") {
      throw new WalletError("REQUEST_IN_PROGRESS", "相同请求正在处理中，请稍后重试");
    }

    const decimals = await assetDecimals(client, input.asset);
    const amount18 = toScale18(toPositiveMinor(input.amount, decimals), decimals);
    const fee18 = input.feeAmount
      ? toScale18(toPositiveMinor(input.feeAmount, decimals), decimals)
      : 0n;
    const total18 = amount18 + fee18;

    const assetRow = await txQueryOne<{ min_withdrawal: string }>(
      client,
      `SELECT min_withdrawal FROM assets WHERE code = $1`,
      [input.asset],
    );
    if (assetRow && amount18 < parseNumeric18(assetRow.min_withdrawal)) {
      throw new WalletError(
        "LIMIT_EXCEEDED",
        `低于最低提现金额 ${toAssetString(assetRow.min_withdrawal, decimals)}`,
        { min: toAssetString(assetRow.min_withdrawal, decimals) },
      );
    }

    const user = await txQueryOne<{ kyc_level: number }>(
      client,
      `SELECT kyc_level FROM users WHERE id = $1`,
      [input.userId],
    );
    if (!user) throw new WalletError("NOT_FOUND", "用户不存在");

    await checkLimits(client, {
      txType: "withdrawal",
      asset: input.asset,
      kycLevel: Number(user.kyc_level),
      amount18,
      userId: input.userId,
      decimals,
    });

    const wallet = await getUserWallet(client, input.userId, input.asset);
    assertAvailable(wallet, total18); // 可用余额不足 → 422

    const needsApproval = total18 >= reviewThreshold18();
    const txId = randomUUID();
    const txNo = newTxNo();

    await txQuery(
      client,
      `INSERT INTO transactions
         (id, tx_no, type, status, asset_code, amount, fee_amount, net_amount,
          initiator_user_id, from_wallet_id, idempotency_key, description,
          requires_approval, metadata)
       VALUES ($1, $2, 'withdrawal', $3::transaction_status, $4, $5::numeric,
               $6::numeric, $5::numeric, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        txId,
        txNo,
        needsApproval ? "requires_review" : "pending",
        input.asset,
        formatNumeric18(amount18),
        formatNumeric18(fee18),
        input.userId,
        wallet.id,
        input.idempotencyKey ?? null,
        input.note ?? null,
        needsApproval,
        JSON.stringify({ destination: input.destination ?? null }),
      ],
    );

    // 创建即冻结 amount + fee（可用余额减少，余额不变）
    await createHold(client, txId, wallet.id, input.asset, total18);

    await txQuery(
      client,
      `INSERT INTO transaction_events (transaction_id, from_status, to_status, actor_type, actor_id)
       VALUES ($1, 'created', $2::transaction_status, 'user', $3)`,
      [txId, needsApproval ? "requires_review" : "pending", input.userId],
    );

    const after = await txQueryOne<{ balance: string; locked_balance: string }>(
      client,
      `SELECT balance, locked_balance FROM wallets WHERE id = $1`,
      [wallet.id],
    );
    const available18 =
      parseNumeric18(after!.balance) - parseNumeric18(after!.locked_balance);

    const body = {
      txNo,
      status: needsApproval ? "requires_review" : "pending",
      available: a18(available18, decimals),
    };
    await completeIdempotency(
      client,
      "withdrawal.create",
      input.userId,
      input.idempotencyKey ?? null,
      201,
      body,
      txId,
    );
    return body;
  });
}

/** 提现出款成功：借 用户 / 贷 暂存 + 手续费；释放冻结 */
export async function confirmWithdrawal(txId: string): Promise<TxView> {
  return withTransaction(async (client) => {
    const tx = await getTxRow(client, txId);
    const decimals = await assetDecimals(client, tx.asset_code);
    if (tx.status === "succeeded") return toTxView(tx, decimals); // 重复回调
    if (tx.type !== "withdrawal") {
      throw new WalletError("INVALID_STATE", "只有提现单可以确认出款");
    }
    if (!["pending", "processing", "requires_review", "expired"].includes(tx.status)) {
      throw new WalletError("INVALID_STATE", `提现单当前状态 ${tx.status} 无法确认`);
    }

    const amount18 = parseNumeric18(tx.amount);
    const fee18 = parseNumeric18(tx.fee_amount);
    // pending → processing → succeeded（状态机不允许跳级）
    await ensureProcessing(client, tx);
    const from = await getUserWallet(client, tx.initiator_user_id!, tx.asset_code);
    const suspense = await getSystemWallet(client, "system_suspense", tx.asset_code);

    await lockWallets(client, [from.id, suspense.id]);

    const entries: EntrySpec[] = [
      { walletId: from.id, direction: "debit", amount18 },
      { walletId: suspense.id, direction: "credit", amount18 },
    ];
    if (fee18 > 0n) {
      const feeWallet = await getSystemWallet(client, "system_fee", tx.asset_code);
      await lockWallets(client, [feeWallet.id]);
      entries.push({
        walletId: feeWallet.id,
        direction: "credit",
        amount18: fee18,
        entryType: "fee",
      });
      entries.push({
        walletId: from.id,
        direction: "debit",
        amount18: fee18,
        entryType: "fee",
      });
    }

    await postEntries(client, tx.id, entries);
    await releaseHold(client, tx.id, "captured");
    await transition(client, tx.id, "succeeded", {
      actorType: "system",
      reason: "提现出款成功",
      completed: true,
    });

    return toTxView(await getTxRow(client, tx.id), decimals);
  });
}

/** 提现出款失败：释放冻结，回可用余额，不写分录 */
export async function failWithdrawal(
  txId: string,
  reason: string,
  code = "CHANNEL_DECLINED",
): Promise<TxView> {
  return withTransaction(async (client) => {
    const tx = await getTxRow(client, txId);
    const decimals = await assetDecimals(client, tx.asset_code);
    if (tx.status === "succeeded") {
      throw new WalletError("INVALID_STATE", "提现已成功，无法标记失败（请走冲正）");
    }
    if (tx.status !== "failed") {
      await releaseHold(client, tx.id, "released");
      await transition(client, tx.id, "failed", {
        actorType: "system",
        reason,
        failureCode: code,
        failureReason: reason,
      });
    }
    return toTxView(await getTxRow(client, tx.id), decimals);
  });
}

export async function cancelTransaction(
  txId: string,
  userId: string,
  reason = "用户取消",
): Promise<TxView> {
  return withTransaction(async (client) => {
    const tx = await getTxRow(client, txId);
    const decimals = await assetDecimals(client, tx.asset_code);
    if (tx.initiator_user_id !== userId) {
      throw new WalletError("UNAUTHORIZED", "只能取消自己发起的交易");
    }
    if (!["created", "pending", "requires_review"].includes(tx.status)) {
      throw new WalletError("INVALID_STATE", `当前状态 ${tx.status} 不允许取消`);
    }
    await releaseHold(client, tx.id, "released");
    await transition(client, tx.id, "canceled", {
      actorType: "user",
      actorId: userId,
      reason,
    });
    return toTxView(await getTxRow(client, tx.id), decimals);
  });
}

/* ═══════════════════════════════════════════════════════════════
   3. 转账
   ═══════════════════════════════════════════════════════════════ */

export interface CreateTransferInput {
  userId: string;
  asset: string;
  amount: string;
  feeAmount?: string;
  toWalletId: string;
  note?: string | null;
  idempotencyKey?: string | null;
  requestHash: string;
}

export async function createTransfer(input: CreateTransferInput): Promise<CreateResult> {
  if (!input.toWalletId) {
    throw new WalletError("VALIDATION_ERROR", "请选择收款方");
  }
  return withTransaction(async (client) => {
    const idem = await beginIdempotency(client, {
      scope: "transfer.create",
      userId: input.userId,
      key: input.idempotencyKey ?? null,
      requestHash: input.requestHash,
    });
    if (idem.kind === "replay") {
      return {
        txNo: String(idem.body.txNo ?? ""),
        status: String(idem.body.status ?? "pending"),
        replayed: true,
      };
    }
    if (idem.kind === "in_progress") {
      throw new WalletError("REQUEST_IN_PROGRESS", "相同请求正在处理中，请稍后重试");
    }

    const decimals = await assetDecimals(client, input.asset);
    const amount18 = toScale18(toPositiveMinor(input.amount, decimals), decimals);
    const fee18 = input.feeAmount
      ? toScale18(toPositiveMinor(input.feeAmount, decimals), decimals)
      : 0n;
    const total18 = amount18 + fee18;

    const from = await getUserWallet(client, input.userId, input.asset);

    const toRow = await txQueryOne<WalletRow>(
      client,
      `SELECT id, wallet_no, user_id, asset_code, status, balance, locked_balance
         FROM wallets WHERE id = $1`,
      [input.toWalletId],
    );
    if (!toRow || toRow.status === "closed") {
      throw new WalletError("WALLET_NOT_FOUND", "收款钱包不存在或已关闭");
    }
    if (toRow.id === from.id) {
      throw new WalletError("SELF_TRANSFER", "不能给自己转账");
    }
    if (toRow.asset_code !== input.asset) {
      throw new WalletError(
        "CROSS_ASSET_UNSUPPORTED",
        "收款钱包币种不同，暂不支持跨币种转账",
        { from: input.asset, to: toRow.asset_code },
      );
    }

    const user = await txQueryOne<{ kyc_level: number }>(
      client,
      `SELECT kyc_level FROM users WHERE id = $1`,
      [input.userId],
    );
    if (!user) throw new WalletError("NOT_FOUND", "用户不存在");

    await checkLimits(client, {
      txType: "transfer",
      asset: input.asset,
      kycLevel: Number(user.kyc_level),
      amount18,
      userId: input.userId,
      decimals,
    });

    assertAvailable(from, total18);

    const needsApproval = total18 >= reviewThreshold18();
    const txId = randomUUID();
    const txNo = newTxNo();

    await txQuery(
      client,
      `INSERT INTO transactions
         (id, tx_no, type, status, asset_code, amount, fee_amount, net_amount,
          initiator_user_id, from_wallet_id, to_wallet_id, idempotency_key,
          description, requires_approval, metadata)
       VALUES ($1, $2, 'transfer', $3::transaction_status, $4, $5::numeric,
               $6::numeric, $5::numeric, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        txId,
        txNo,
        needsApproval ? "requires_review" : "pending",
        input.asset,
        formatNumeric18(amount18),
        formatNumeric18(fee18),
        input.userId,
        from.id,
        toRow.id,
        input.idempotencyKey ?? null,
        input.note ?? null,
        needsApproval,
        JSON.stringify({ toWalletNo: toRow.wallet_no }),
      ],
    );

    await createHold(client, txId, from.id, input.asset, total18);

    await txQuery(
      client,
      `INSERT INTO transaction_events (transaction_id, from_status, to_status, actor_type, actor_id)
       VALUES ($1, 'created', $2::transaction_status, 'user', $3)`,
      [txId, needsApproval ? "requires_review" : "pending", input.userId],
    );

    const after = await txQueryOne<{ balance: string; locked_balance: string }>(
      client,
      `SELECT balance, locked_balance FROM wallets WHERE id = $1`,
      [from.id],
    );
    const available18 =
      parseNumeric18(after!.balance) - parseNumeric18(after!.locked_balance);

    const body = {
      txNo,
      status: needsApproval ? "requires_review" : "pending",
      available: a18(available18, decimals),
    };
    await completeIdempotency(
      client,
      "transfer.create",
      input.userId,
      input.idempotencyKey ?? null,
      201,
      body,
      txId,
    );
    return body;
  });
}

/** 转账成功：锁双方（按 id 升序）→ 借付方 / 贷收方 (+手续费) → 释放冻结 */
export async function confirmTransfer(txId: string): Promise<TxView> {
  return withTransaction(async (client) => {
    const tx = await getTxRow(client, txId);
    const decimals = await assetDecimals(client, tx.asset_code);
    if (tx.status === "succeeded") return toTxView(tx, decimals); // 重复回调
    if (tx.type !== "transfer") {
      throw new WalletError("INVALID_STATE", "只有转账单可以确认");
    }
    if (!["pending", "processing", "requires_review", "expired"].includes(tx.status)) {
      throw new WalletError("INVALID_STATE", `转账单当前状态 ${tx.status} 无法确认`);
    }
    if (!tx.from_wallet_id || !tx.to_wallet_id) {
      throw new WalletError("INTERNAL_ERROR", "转账单缺少钱包信息");
    }

    const amount18 = parseNumeric18(tx.amount);
    const fee18 = parseNumeric18(tx.fee_amount);

    // pending → processing → succeeded（状态机不允许跳级）
    await ensureProcessing(client, tx);

    // ★ 固定按 wallet id 升序加锁，避免并发死锁
    await lockWallets(client, [tx.from_wallet_id, tx.to_wallet_id]);

    const entries: EntrySpec[] = [
      { walletId: tx.from_wallet_id, direction: "debit", amount18 },
      { walletId: tx.to_wallet_id, direction: "credit", amount18 },
    ];
    if (fee18 > 0n) {
      const feeWallet = await getSystemWallet(client, "system_fee", tx.asset_code);
      await lockWallets(client, [feeWallet.id]);
      entries.push(
        { walletId: tx.from_wallet_id, direction: "debit", amount18: fee18, entryType: "fee" },
        { walletId: feeWallet.id, direction: "credit", amount18: fee18, entryType: "fee" },
      );
    }

    await postEntries(client, tx.id, entries);
    await releaseHold(client, tx.id, "captured");
    await transition(client, tx.id, "succeeded", {
      actorType: "system",
      reason: "转账结算成功",
      completed: true,
    });

    return toTxView(await getTxRow(client, tx.id), decimals);
  });
}

/** 转账失败：释放冻结，不写分录 */
export async function failTransfer(
  txId: string,
  reason: string,
  code = "CHANNEL_DECLINED",
): Promise<TxView> {
  return withTransaction(async (client) => {
    const tx = await getTxRow(client, txId);
    const decimals = await assetDecimals(client, tx.asset_code);
    if (tx.status === "succeeded") {
      throw new WalletError("INVALID_STATE", "转账已成功，无法标记失败（请走退款）");
    }
    if (tx.status !== "failed") {
      await releaseHold(client, tx.id, "released");
      await transition(client, tx.id, "failed", {
        actorType: "system",
        reason,
        failureCode: code,
        failureReason: reason,
      });
    }
    return toTxView(await getTxRow(client, tx.id), decimals);
  });
}

/* ═══════════════════════════════════════════════════════════════
   4. 退款 / 冲正
   ═══════════════════════════════════════════════════════════════ */

export interface RefundInput {
  txId: string;
  amount?: string | null;
  reason?: string | null;
  actorId?: string | null;
  actorType?: "user" | "admin" | "system";
}

export async function refundTransaction(input: RefundInput): Promise<TxView> {
  return withTransaction(async (client) => {
    const original = await getTxRow(client, input.txId);
    const decimals = await assetDecimals(client, original.asset_code);

    if (original.status !== "succeeded") {
      throw new WalletError("INVALID_STATE", "只有成功的交易才能退款", {
        status: original.status,
      });
    }
    if (!["transfer", "deposit", "withdrawal"].includes(original.type)) {
      throw new WalletError("INVALID_STATE", "该类型不支持退款");
    }

    // 已退金额（子单累计）
    const refunded = await txQueryOne<{ total: string }>(
      client,
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM transactions
        WHERE parent_transaction_id = $1
          AND type = 'refund'
          AND status = 'succeeded'`,
      [original.id],
    );
    const refunded18 = parseNumeric18(refunded?.total ?? "0");
    const original18 = parseNumeric18(original.amount);

    const refund18 = input.amount
      ? toScale18(toPositiveMinor(input.amount, decimals), decimals)
      : original18 - refunded18;

    if (refund18 <= 0n) {
      throw new WalletError(
        "REFUND_EXCEEDS_ORIGINAL",
        "该交易已全额退款，无可退余额",
        { refunded: toAssetString(refunded?.total ?? "0", decimals) },
      );
    }
    if (refunded18 + refund18 > original18) {
      throw new WalletError(
        "REFUND_EXCEEDS_ORIGINAL",
        "退款金额超过原单可退余额",
        {
          original: toAssetString(original.amount, decimals),
          refunded: toAssetString(refunded?.total ?? "0", decimals),
          maxRefund: toAssetString(original.amount, decimals),
        },
      );
    }

    // 反向分录：原方向反过来。
    // 充值单只有收款方（from 为空）→ 出资方取暂存钱包；
    // 提现单只有付款方（to 为空）→ 接收方取暂存钱包；
    // 转账单两端齐全，直接原路退回。
    let fromWallet = original.from_wallet_id;
    let toWallet = original.to_wallet_id;
    if (original.type === "deposit") {
      const suspense = await getSystemWallet(
        client,
        "system_suspense",
        original.asset_code,
      );
      fromWallet = suspense.id;
      toWallet = toWallet ?? original.to_wallet_id;
    } else if (original.type === "withdrawal") {
      const suspense = await getSystemWallet(
        client,
        "system_suspense",
        original.asset_code,
      );
      fromWallet = fromWallet ?? original.from_wallet_id;
      toWallet = suspense.id;
    }
    if (!fromWallet || !toWallet) {
      throw new WalletError("INVALID_STATE", "原单缺少资金两端，无法自动退款");
    }
    await lockWallets(client, [fromWallet, toWallet]);

    const refundTxId = randomUUID();
    const refundTxNo = newTxNo();

    await txQuery(
      client,
      `INSERT INTO transactions
         (id, tx_no, type, status, asset_code, amount, fee_amount, net_amount,
          initiator_user_id, from_wallet_id, to_wallet_id, parent_transaction_id,
          description, metadata)
       VALUES ($1, $2, 'refund', 'succeeded', $3, $4::numeric, 0::numeric,
               $4::numeric, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        refundTxId,
        refundTxNo,
        original.asset_code,
        formatNumeric18(refund18),
        input.actorId ?? original.initiator_user_id,
        toWallet, // 退款：原接收方出，原付出方收
        fromWallet,
        original.id,
        input.reason ?? "退款",
        JSON.stringify({ refundOf: original.tx_no }),
      ],
    );

    await postEntries(client, refundTxId, [
      { walletId: toWallet, direction: "debit", amount18: refund18, entryType: "refund" },
      { walletId: fromWallet, direction: "credit", amount18: refund18, entryType: "refund" },
    ]);

    await txQuery(
      client,
      `INSERT INTO transaction_events (transaction_id, from_status, to_status, actor_type, actor_id, reason)
       VALUES ($1, 'succeeded', 'succeeded', $2, $3, $4)`,
      [refundTxId, input.actorType ?? "system", input.actorId ?? null, input.reason ?? "退款"],
    );

    await writeAudit(client, {
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? null,
      action: "transaction.refund",
      entityType: "transaction",
      entityId: original.id,
      before: { txNo: original.tx_no, status: original.status },
      after: { refundTxNo, amount: a18(refund18, decimals) },
    });

    return toTxView(
      (await txQueryOne<TxRow>(
        client,
        `SELECT ${TX_COLUMNS}
           FROM transactions t
           LEFT JOIN transactions p ON p.id = t.parent_transaction_id
          WHERE t.id = $1`,
        [refundTxId],
      ))!,
      decimals,
    );
  });
}

/* ═══════════════════════════════════════════════════════════════
   5. 查询：单据 / 列表 / 账本
   ═══════════════════════════════════════════════════════════════ */

export async function getTransaction(
  txId: string,
  userId?: string,
): Promise<
  TxView & {
    events: Array<Record<string, unknown>>;
    entries: LedgerEntryView[];
    holds: Array<Record<string, unknown>>;
    approvals: Array<Record<string, unknown>>;
  }
> {
  const row = await queryOne<TxRow>(
    `SELECT ${TX_COLUMNS}
       FROM transactions t
       LEFT JOIN transactions p ON p.id = t.parent_transaction_id
      WHERE t.id::text = $1 OR t.tx_no = $1`,
    [txId],
  );
  if (!row) throw new WalletError("NOT_FOUND", "交易单不存在");
  if (userId && row.initiator_user_id !== userId) {
    throw new WalletError("UNAUTHORIZED", "无权查看该交易");
  }

  const decimalsRow = await queryOne<{ decimals: number }>(
    `SELECT decimals FROM assets WHERE code = $1`,
    [row.asset_code],
  );
  const decimals = Number(decimalsRow?.decimals ?? 2);

  const [events, entries, holds, approvals] = await Promise.all([
    query(
      `SELECT from_status, to_status, actor_type, actor_id, reason, created_at
         FROM transaction_events WHERE transaction_id = $1 ORDER BY created_at, id`,
      [row.id],
    ),
    query(
      `SELECT l.id, l.direction, l.entry_type, l.amount, l.balance_before,
              l.balance_after, l.asset_code, l.created_at, t.tx_no, t.type
         FROM ledger_entries l
         JOIN transactions t ON t.id = l.transaction_id
        WHERE l.transaction_id = $1 ORDER BY l.id`,
      [row.id],
    ),
    query(
      `SELECT id, wallet_id, amount, status, reason, expires_at, released_at, created_at
         FROM holds WHERE transaction_id = $1 ORDER BY created_at`,
      [row.id],
    ),
    query(
      `SELECT id, status, reason, decision_note, requested_by, approved_by, decided_at
         FROM approval_requests WHERE transaction_id = $1 ORDER BY created_at`,
      [row.id],
    ),
  ]);

  return {
    ...toTxView(row, decimals),
    events: events.map((e) => ({ ...e, created_at: iso(e.created_at as Date) })),
    entries: entries.map((e) => ({
      id: Number(e.id),
      txNo: String(e.tx_no),
      type: String(e.type),
      direction: String(e.direction),
      entryType: String(e.entry_type),
      amount: toAssetString(String(e.amount), decimals),
      balanceBefore: toAssetString(String(e.balance_before), decimals),
      balanceAfter: toAssetString(String(e.balance_after), decimals),
      asset: String(e.asset_code),
      createdAt: iso(e.created_at as Date)!,
    })),
    holds: holds.map((h) => ({ ...h, created_at: iso(h.created_at as Date) })),
    approvals: approvals.map((a) => ({ ...a, decided_at: iso(a.decided_at as Date) })),
  };
}

export async function listTransactions(opts: {
  userId: string;
  status?: string | null;
  type?: string | null;
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: TxView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const params: unknown[] = [opts.userId];
  let where = `t.initiator_user_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    where += ` AND t.status = $${params.length}::transaction_status`;
  }
  if (opts.type) {
    params.push(opts.type);
    where += ` AND t.type = $${params.length}::transaction_type`;
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    where += ` AND t.created_at < (SELECT created_at FROM transactions WHERE id = $${params.length} OR tx_no = $${params.length})`;
  }
  params.push(limit);

  const rows = await query<TxRow & { decimals: number }>(
    `SELECT ${TX_COLUMNS}, a.decimals
       FROM transactions t
       LEFT JOIN transactions p ON p.id = t.parent_transaction_id
       JOIN assets a ON a.code = t.asset_code
      WHERE ${where}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $${params.length}`,
    params,
  );

  return {
    items: rows.map((r) => toTxView(r, Number(r.decimals))),
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
  };
}

export async function getLedger(opts: {
  userId?: string;
  walletId: string;
  limit?: number;
  cursor?: number | null;
}): Promise<{ entries: LedgerEntryView[]; nextCursor: number | null }> {
  // 归属校验：只有钱包主人才能看自己的流水
  const wallet = await queryOne<{ id: string; user_id: string | null; asset_code: string }>(
    `SELECT id, user_id, asset_code FROM wallets WHERE id = $1`,
    [opts.walletId],
  );
  if (!wallet) throw new WalletError("WALLET_NOT_FOUND", "钱包不存在");
  if (opts.userId && wallet.user_id !== opts.userId) {
    throw new WalletError("UNAUTHORIZED", "无权查看该钱包流水");
  }

  const decimalsRow = await queryOne<{ decimals: number }>(
    `SELECT decimals FROM assets WHERE code = $1`,
    [wallet.asset_code],
  );
  const decimals = Number(decimalsRow?.decimals ?? 2);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const params: unknown[] = [opts.walletId];
  let where = `l.wallet_id = $1`;
  if (opts.cursor) {
    params.push(opts.cursor);
    where += ` AND l.id < $${params.length}`;
  }
  params.push(limit);

  const rows = await query<{
    id: number;
    tx_no: string;
    type: string;
    direction: string;
    entry_type: string;
    amount: string;
    balance_before: string;
    balance_after: string;
    asset_code: string;
    created_at: Date;
  }>(
    `SELECT l.id, l.direction, l.entry_type, l.amount, l.balance_before,
            l.balance_after, l.asset_code, l.created_at, t.tx_no, t.type
       FROM ledger_entries l
       JOIN transactions t ON t.id = l.transaction_id
      WHERE ${where}
      ORDER BY l.id DESC
      LIMIT $${params.length}`,
    params,
  );

  return {
    entries: rows.map((r) => ({
      id: Number(r.id),
      txNo: r.tx_no,
      type: r.type,
      direction: r.direction,
      entryType: r.entry_type,
      amount: toAssetString(r.amount, decimals),
      balanceBefore: toAssetString(r.balance_before, decimals),
      balanceAfter: toAssetString(r.balance_after, decimals),
      asset: r.asset_code,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })),
    nextCursor: rows.length === limit ? Number(rows[rows.length - 1].id) : null,
  };
}

/* ═══════════════════════════════════════════════════════════════
   6. 审批（管理员）
   ═══════════════════════════════════════════════════════════════ */

export async function decideTransaction(opts: {
  txId: string;
  decision: "approve" | "reject";
  note: string;
  adminId: string;
  ip?: string | null;
}): Promise<TxView> {
  if (!opts.note || opts.note.trim().length < 2) {
    throw new WalletError("VALIDATION_ERROR", "审批必须填写意见");
  }
  return withTransaction(async (client) => {
    const tx = await getTxRow(client, opts.txId);
    const decimals = await assetDecimals(client, tx.asset_code);

    if (tx.status !== "requires_review") {
      throw new WalletError("INVALID_STATE", "该交易不在待审批状态", {
        status: tx.status,
      });
    }

    if (opts.decision === "approve") {
      await txQuery(
        client,
        `UPDATE approval_requests
            SET status = 'approved', approved_by = $2, decision_note = $3,
                decided_at = now(), updated_at = now()
          WHERE transaction_id = $1 AND status = 'pending'`,
        [tx.id, opts.adminId, opts.note],
      );
      await txQuery(
        client,
        `UPDATE transactions SET requires_approval = false WHERE id = $1`,
        [tx.id],
      );
      await transition(client, tx.id, "processing", {
        actorType: "admin",
        actorId: opts.adminId,
        reason: opts.note,
      });
    } else {
      // 驳回：释放冻结（提现/转账）
      await releaseHold(client, tx.id, "released");
      await txQuery(
        client,
        `UPDATE approval_requests
            SET status = 'rejected', approved_by = $2, decision_note = $3,
                decided_at = now(), updated_at = now()
          WHERE transaction_id = $1 AND status = 'pending'`,
        [tx.id, opts.adminId, opts.note],
      );
      await transition(client, tx.id, "failed", {
        actorType: "admin",
        actorId: opts.adminId,
        reason: opts.note,
        failureCode: "APPROVAL_REJECTED",
        failureReason: opts.note,
      });
    }

    await writeAudit(client, {
      actorType: "admin",
      actorId: opts.adminId,
      action: `transaction.${opts.decision}`,
      entityType: "transaction",
      entityId: tx.id,
      before: { status: tx.status },
      after: { decision: opts.decision, note: opts.note },
      ip: opts.ip ?? null,
    });

    return toTxView(await getTxRow(client, tx.id), decimals);
  });
}

/* ═══════════════════════════════════════════════════════════════
   7. 对账（余额快照 vs 账本汇总）
   ═══════════════════════════════════════════════════════════════ */

export async function runReconciliation(opts: {
  asset: string;
  adminId?: string | null;
  periodStart?: string;
  periodEnd?: string;
}): Promise<{
  runId: string;
  asset: string;
  walletCount: number;
  mismatchCount: number;
  totalDebits: string;
  totalCredits: string;
  items: Array<Record<string, unknown>>;
}> {
  const decimalsRow = await queryOne<{ decimals: number }>(
    `SELECT decimals FROM assets WHERE code = $1`,
    [opts.asset],
  );
  if (!decimalsRow) throw new WalletError("ASSET_NOT_ACTIVE", `不支持的币种: ${opts.asset}`);
  const decimals = Number(decimalsRow.decimals);

  const runId = randomUUID();
  const periodStart = opts.periodStart ?? new Date(0).toISOString();
  const periodEnd = opts.periodEnd ?? new Date().toISOString();

  return withTransaction(async (client) => {
    await txQuery(
      client,
      `INSERT INTO reconciliation_runs
         (id, asset_code, period_start, period_end, status)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 'running')`,
      [runId, opts.asset, periodStart, periodEnd],
    );

    // 逐钱包：wallets.balance（快照） vs SUM(ledger_entries)（唯一依据）
    const rows = await txQuery<{
      wallet_id: string;
      wallet_no: string;
      wallet_type: string;
      stored_balance: string;
      ledger_balance: string | null;
      difference: string;
    }>(
      client,
      `SELECT w.id AS wallet_id, w.wallet_no, w.wallet_type,
              w.balance AS stored_balance,
              COALESCE(l.ledger_balance, 0)::text AS ledger_balance,
              (w.balance - COALESCE(l.ledger_balance, 0))::text AS difference
         FROM wallets w
         LEFT JOIN (
           SELECT wallet_id,
                  SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS ledger_balance
             FROM ledger_entries
            WHERE asset_code = $1
            GROUP BY wallet_id
         ) l ON l.wallet_id = w.id
        WHERE w.asset_code = $1`,
      [opts.asset],
    );

    let mismatchCount = 0;
    let totalDebits18 = 0n;
    let totalCredits18 = 0n;

    const sums = await txQueryOne<{ d: string; c: string }>(
      client,
      `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount ELSE 0 END),0)::text AS d,
              COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE 0 END),0)::text AS c
         FROM ledger_entries WHERE asset_code = $1`,
      [opts.asset],
    );
    totalDebits18 = parseNumeric18(sums?.d ?? "0");
    totalCredits18 = parseNumeric18(sums?.c ?? "0");

    for (const r of rows) {
      const diff = parseNumeric18(r.difference);
      const matched = diff === 0n;
      if (!matched) mismatchCount += 1;
      await txQuery(
        client,
        `INSERT INTO reconciliation_items
           (run_id, wallet_id, stored_balance, ledger_balance, difference, status)
         VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6::reconciliation_item_status)`,
        [
          runId,
          r.wallet_id,
          r.stored_balance,
          r.ledger_balance ?? "0",
          r.difference,
          matched ? "matched" : "mismatched",
        ],
      );
    }

    await txQuery(
      client,
      `UPDATE reconciliation_runs
          SET status = 'completed',
              total_debits = $2::numeric,
              total_credits = $3::numeric,
              wallet_count = $4,
              mismatch_count = $5,
              completed_at = now()
        WHERE id = $1`,
      [
        runId,
        formatNumeric18(totalDebits18),
        formatNumeric18(totalCredits18),
        rows.length,
        mismatchCount,
      ],
    );

    await writeAudit(client, {
      actorType: "admin",
      actorId: opts.adminId ?? null,
      action: "reconciliation.run",
      entityType: "reconciliation_run",
      entityId: runId,
      after: { asset: opts.asset, walletCount: rows.length, mismatchCount },
    });

    return {
      runId,
      asset: opts.asset,
      walletCount: rows.length,
      mismatchCount,
      totalDebits: toAssetString(formatNumeric18(totalDebits18), decimals),
      totalCredits: toAssetString(formatNumeric18(totalCredits18), decimals),
      items: rows.map((r) => ({
        walletId: r.wallet_id,
        walletNo: r.wallet_no,
        walletType: r.wallet_type,
        storedBalance: toAssetString(r.stored_balance, decimals),
        ledgerBalance: toAssetString(r.ledger_balance ?? "0", decimals),
        difference: toAssetString(r.difference, decimals),
        status: parseNumeric18(r.difference) === 0n ? "matched" : "mismatched",
      })),
    };
  });
}

export async function resolveReconciliationItem(opts: {
  itemId: string;
  note: string;
  adminId: string;
}): Promise<{ id: number; status: string }> {
  if (!opts.note?.trim()) {
    throw new WalletError("VALIDATION_ERROR", "差异处理必须填写说明");
  }
  return withTransaction(async (client) => {
    const item = await txQueryOne<{ id: number; run_id: string; status: string }>(
      client,
      `SELECT id, run_id, status FROM reconciliation_items WHERE id = $1 FOR UPDATE`,
      [opts.itemId],
    );
    if (!item) throw new WalletError("NOT_FOUND", "对账明细不存在");
    if (item.status === "resolved") {
      throw new WalletError("INVALID_STATE", "该差异已处理");
    }

    const updated = await txQueryOne<{ id: number; status: string }>(
      client,
      `UPDATE reconciliation_items
          SET status = 'resolved', resolved_by = $2, resolved_at = now(), note = $3
        WHERE id = $1
        RETURNING id, status`,
      [item.id, opts.adminId, opts.note],
    );

    await writeAudit(client, {
      actorType: "admin",
      actorId: opts.adminId,
      action: "reconciliation.resolve",
      entityType: "reconciliation_item",
      entityId: String(item.id),
      before: { status: item.status },
      after: { status: "resolved", note: opts.note },
    });

    return updated!;
  });
}

export { NUMERIC_SCALE };
