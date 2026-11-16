/**
 * 身份认证：注册 / 登录 / 手机号注册校验 / 会话。
 *
 * 核心规则（docs/wallet/01-business-rules.md §7）：
 *   1. **手机号未注册 → 无法登录**，返回 PHONE_NOT_REGISTERED + 固定文案
 *   2. 密码只存 scrypt 哈希
 *   3. 证件号每人不同：HMAC 哈希唯一索引兜底
 *   4. 会话只存 token 的 SHA-256，明文 token 只在响应里出现一次
 *   5. 连续失败限流 → locked_until
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction, queryOne, query, txQueryOne, txQuery } from "./db";
import {
  PHONE_NOT_REGISTERED_MESSAGE,
  WalletError,
} from "./errors";
import { hashPassword, isStrongPassword, verifyPassword } from "./password";
import {
  encryptNationalId,
  formatPhoneForDisplay,
  hashNationalId,
  nationalIdLast4,
  normalizeNationalId,
  normalizePhone,
} from "./identity";
import { decimalsOf, fromMinor } from "./money";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

/* ────────────────────────────────────────────────────────────────
   类型
   ──────────────────────────────────────────────────────────────── */

export interface PublicUser {
  id: string;
  userNo: string;
  phone: string;
  phoneDisplay: string;
  fullName: string;
  status: string;
  kycLevel: number;
  nationalIdLast4: string | null;
  createdAt: string;
}

export interface SessionResult {
  token: string;
  expiresAt: string;
  user: PublicUser;
}

interface UserRow {
  id: string;
  user_no: string;
  phone: string;
  password_hash: string;
  status: string;
  kyc_level: number;
  created_at: Date | string;
  full_name: string | null;
  national_id_no_last4: string | null;
}

/* ────────────────────────────────────────────────────────────────
   工具
   ──────────────────────────────────────────────────────────────── */

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 会话 token：32 字节随机数，服务端只存它的 SHA-256 */
function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256Hex(token) };
}

function sessionTtlHours(): number {
  const raw = Number(process.env.WALLET_SESSION_TTL_HOURS ?? 72);
  return Number.isFinite(raw) && raw > 0 ? raw : 72;
}

async function nextUserNo(client: PoolClient): Promise<string> {
  // U + yyyymmdd + 4 位随机；唯一索引兜底，冲突则重试
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  for (let i = 0; i < 5; i++) {
    const candidate = `U${ymd}${Math.floor(1000 + Math.random() * 9000)}`;
    const dup = await txQuery(
      client,
      `SELECT 1 FROM users WHERE user_no = $1`,
      [candidate],
    );
    if (dup.length === 0) return candidate;
  }
  throw new WalletError("INTERNAL_ERROR", "生成用户编号失败");
}

async function nextWalletNo(assetCode: string): Promise<string> {
  const prefix = `ABA${assetCode}`;
  for (let i = 0; i < 8; i++) {
    const suffix = randomBytes(5).toString("hex").toUpperCase().slice(0, 10);
    const candidate = `${prefix}${suffix}`;
    const dup = await query(`SELECT 1 FROM wallets WHERE wallet_no = $1`, [
      candidate,
    ]);
    if (dup.length === 0) return candidate;
  }
  throw new WalletError("INTERNAL_ERROR", "生成钱包账号失败");
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    userNo: row.user_no,
    phone: row.phone,
    phoneDisplay: formatPhoneForDisplay(row.phone),
    fullName: row.full_name ?? "",
    status: row.status,
    kycLevel: Number(row.kyc_level),
    nationalIdLast4: row.national_id_no_last4
      ? String(row.national_id_no_last4).trim()
      : null,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}

/* ────────────────────────────────────────────────────────────────
   1. 手机号是否已注册（登录前置校验）
   ──────────────────────────────────────────────────────────────── */

export interface PhoneCheckResult {
  registered: boolean;
  status: string | null;
  message: string;
}

/**
 * 登录前必须先调用：
 *   - 已注册 → { registered: true, status }
 *   - 未注册 → 抛 PHONE_NOT_REGISTERED（HTTP 404）+ 固定文案，
 *              前端据此显示「你手机号码目前还没注册本银行使用」
 */
export async function checkPhoneRegistered(
  phoneInput: string,
): Promise<PhoneCheckResult> {
  const phone = normalizePhone(phoneInput);
  const row = await queryOne<{
    status: string;
    locked_until: Date | string | null;
    deleted_at: Date | string | null;
  }>(
    `SELECT status, locked_until, deleted_at
       FROM users
      WHERE phone = $1 AND deleted_at IS NULL`,
    [phone],
  );

  if (!row) {
    throw new WalletError("PHONE_NOT_REGISTERED", PHONE_NOT_REGISTERED_MESSAGE, {
      phone,
      message: PHONE_NOT_REGISTERED_MESSAGE,
    });
  }
  return {
    registered: true,
    status: row.status,
    message: "手机号已注册本银行使用 / This phone number is registered",
  };
}

/** 查询但不抛错（用于前端兜底逻辑） */
export async function findPhoneStatus(
  phoneInput: string,
): Promise<PhoneCheckResult | null> {
  try {
    return await checkPhoneRegistered(phoneInput);
  } catch (err) {
    if (err instanceof WalletError && err.code === "PHONE_NOT_REGISTERED") {
      return {
        registered: false,
        status: null,
        message: PHONE_NOT_REGISTERED_MESSAGE,
      };
    }
    throw err;
  }
}

/* ────────────────────────────────────────────────────────────────
   2. 注册
   ──────────────────────────────────────────────────────────────── */

export interface RegisterInput {
  phone: string;
  password: string;
  fullName: string;
  /** 证件号 —— 注册必填（每个用户都不同，只存密文+哈希+后4位） */
  nationalIdNo?: string;
  dateOfBirth?: string;
  currencies?: string[];
  ip?: string | null;
  userAgent?: string | null;
}

export async function registerUser(input: RegisterInput): Promise<SessionResult> {
  if (String(process.env.WALLET_ALLOW_REGISTRATION ?? "true") === "false") {
    throw new WalletError(
      "REGISTRATION_DISABLED",
      "当前仅允许已注册手机号登录 / Registration is currently disabled",
    );
  }

  const phone = normalizePhone(input.phone);
  const fullName = String(input.fullName ?? "").trim();
  if (fullName.length < 2) {
    throw new WalletError("VALIDATION_ERROR", "请填写姓名");
  }
  if (!isStrongPassword(input.password)) {
    throw new WalletError(
      "WEAK_PASSWORD",
      "密码至少 8 位，且需包含字母与数字（不能是纯数字）",
    );
  }

  // 证件号：开户必须完成身份证信息（业务规则见 docs/wallet/01-business-rules.md §7）
  const nationalIdNo = String(input.nationalIdNo ?? "").trim();
  if (!nationalIdNo) {
    throw new WalletError(
      "VALIDATION_ERROR",
      "请填写证件号码（开户必须完成身份证信息）",
    );
  }
  // 规范化并校验长度（4-32），非法直接拒绝，不进库
  normalizeNationalId(nationalIdNo);

  const passwordHash = await hashPassword(input.password);
  const currencies = (input.currencies?.length ? input.currencies : ["USD", "KHR"])
    .map((c) => String(c).toUpperCase())
    .slice(0, 4);

  // 证件号：每人不同（哈希唯一索引兜底），只存密文 + 哈希 + 后 4 位
  const nidNormalized = normalizeNationalId(nationalIdNo);
  const nidHash = hashNationalId(nidNormalized);
  const nidEncrypted = encryptNationalId(nidNormalized);
  const nidLast4 = nationalIdLast4(nidNormalized);

  const userId = randomUUID();
  const tokenBundle = newSessionToken();
  const ttlHours = sessionTtlHours();

  const created = await withTransaction(async (client) => {
    // 唯一性预检（真正的兜底是唯一索引，冲突会被 toWalletError 翻译）
    const dupPhone = await txQueryOne(
      client,
      `SELECT 1 FROM users WHERE phone = $1 AND deleted_at IS NULL`,
      [phone],
    );
    if (dupPhone) throw new WalletError("PHONE_ALREADY_REGISTERED");

    const userNo = await nextUserNo(client);

    const [userRow] = await txQuery<{ id: string }>(
      client,
      `INSERT INTO users
         (id, user_no, phone, phone_country, password_hash, status,
          phone_verified_at, kyc_level, failed_login_attempts)
       VALUES ($1, $2, $3, 'KH', $4, 'active', now(), 0, 0)
       RETURNING id`,
      [userId, userNo, phone, passwordHash],
    );

    await txQuery(
      client,
      `INSERT INTO user_profiles
         (user_id, full_name, date_of_birth,
          national_id_no_encrypted, national_id_no_hash, national_id_no_last4)
       VALUES ($1, $2, $3::date, $4, $5, $6)`,
      [
        userRow.id,
        fullName,
        input.dateOfBirth ?? null,
        nidEncrypted,
        nidHash,
        nidLast4,
      ],
    );

    // 每个币种一个钱包（assets.decimals 决定金额精度）
    for (const asset of currencies) {
      const assetRow = await txQueryOne<{ code: string }>(
        client,
        `SELECT code FROM assets WHERE code = $1 AND is_active`,
        [asset],
      );
      if (!assetRow) {
        throw new WalletError("ASSET_NOT_ACTIVE", `不支持的币种: ${asset}`);
      }
      const walletNo = await nextWalletNo(asset);
      await txQuery(
        client,
        `INSERT INTO wallets (wallet_no, user_id, asset_code, wallet_type, status)
         VALUES ($1, $2, $3, 'user', 'active')`,
        [walletNo, userRow.id, asset],
      );
    }

    // 会话：只存 token 哈希
    await txQuery(
      client,
      `INSERT INTO user_sessions (user_id, token_hash, ip, user_agent, expires_at)
       VALUES ($1, $2, $3::inet, $4, now() + ($5 || ' hours')::interval)`,
      [userRow.id, tokenBundle.tokenHash, input.ip ?? null, input.userAgent ?? null, String(ttlHours)],
    );

    await txQuery(
      client,
      `INSERT INTO login_attempts (phone, user_id, outcome, ip, user_agent)
       VALUES ($1, $2, 'success', $3::inet, $4)`,
      [phone, userRow.id, input.ip ?? null, input.userAgent ?? null],
    );

    return txQueryOne<UserRow>(
      client,
      `SELECT u.id, u.user_no, u.phone, u.password_hash, u.status,
              u.kyc_level, u.created_at,
              p.full_name, p.national_id_no_last4
         FROM users u
         LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [userRow.id],
    );
  });

  if (!created) throw new WalletError("INTERNAL_ERROR", "注册失败");

  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  return { token: tokenBundle.token, expiresAt, user: toPublicUser(created) };
}

/* ────────────────────────────────────────────────────────────────
   3. 登录
   ──────────────────────────────────────────────────────────────── */

export interface LoginInput {
  phone: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function loginUser(input: LoginInput): Promise<SessionResult> {
  const phone = normalizePhone(input.phone);

  const row = await queryOne<UserRow & { locked_until: Date | string | null }>(
    `SELECT u.id, u.user_no, u.phone, u.password_hash, u.status,
            u.kyc_level, u.created_at, u.locked_until,
            p.full_name, p.national_id_no_last4
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.phone = $1 AND u.deleted_at IS NULL`,
    [phone],
  );

  // ★ 手机号未注册 → 不允许登录
  if (!row) {
    await query(
      `INSERT INTO login_attempts (phone, outcome, ip, user_agent)
       VALUES ($1, 'phone_not_registered', $2::inet, $3)`,
      [phone, input.ip ?? null, input.userAgent ?? null],
    );
    throw new WalletError("PHONE_NOT_REGISTERED", PHONE_NOT_REGISTERED_MESSAGE, {
      phone,
      message: PHONE_NOT_REGISTERED_MESSAGE,
    });
  }

  const recordAttempt = async (outcome: string, userId: string | null = null) =>
    query(
      `INSERT INTO login_attempts (phone, user_id, outcome, ip, user_agent)
       VALUES ($1, $2, $3, $4::inet, $5)`,
      [phone, userId, outcome, input.ip ?? null, input.userAgent ?? null],
    );

  if (row.status === "suspended") {
    await recordAttempt("account_suspended", row.id);
    throw new WalletError(
      "ACCOUNT_SUSPENDED",
      "账户已被冻结，请联系客服 / This account is suspended",
    );
  }
  if (row.status === "closed") {
    await recordAttempt("account_suspended", row.id);
    throw new WalletError("ACCOUNT_CLOSED", "账户已注销 / This account is closed");
  }

  const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0;
  if (lockedUntil > Date.now()) {
    await recordAttempt("account_locked", row.id);
    throw new WalletError(
      "ACCOUNT_LOCKED",
      `连续登录失败次数过多，请 ${LOCK_MINUTES} 分钟后再试 / Account temporarily locked`,
      { lockedUntil: new Date(lockedUntil).toISOString() },
    );
  }

  const ok = await verifyPassword(input.password, row.password_hash);
  if (!ok) {
    await query(
      `UPDATE users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = CASE
                WHEN failed_login_attempts + 1 >= $2
                  THEN now() + ($3 || ' minutes')::interval
                ELSE locked_until
              END
        WHERE id = $1`,
      [row.id, MAX_FAILED_LOGINS, String(LOCK_MINUTES)],
    );
    await recordAttempt("bad_password", row.id);
    throw new WalletError("BAD_PASSWORD", "密码不正确 / Incorrect password");
  }

  // 登录成功：清零计数并开新会话
  const tokenBundle = newSessionToken();
  const ttlHours = sessionTtlHours();

  await withTransaction(async (client) => {
    await txQuery(
      client,
      `UPDATE users
          SET failed_login_attempts = 0,
              locked_until = NULL,
              last_login_at = now(),
              status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END
        WHERE id = $1`,
      [row.id],
    );
    await txQuery(
      client,
      `INSERT INTO user_sessions (user_id, token_hash, ip, user_agent, expires_at)
       VALUES ($1, $2, $3::inet, $4, now() + ($5 || ' hours')::interval)`,
      [row.id, tokenBundle.tokenHash, input.ip ?? null, input.userAgent ?? null, String(ttlHours)],
    );
    await txQuery(
      client,
      `INSERT INTO login_attempts (phone, user_id, outcome, ip, user_agent)
       VALUES ($1, $2, 'success', $3::inet, $4)`,
      [phone, row.id, input.ip ?? null, input.userAgent ?? null],
    );
  });

  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  return { token: tokenBundle.token, expiresAt, user: toPublicUser(row) };
}

/* ────────────────────────────────────────────────────────────────
   4. 会话
   ──────────────────────────────────────────────────────────────── */

export interface AuthContext {
  userId: string;
  sessionId: string;
  user: PublicUser;
}

/** 校验 Bearer token → 用户；失效/过期一律 UNAUTHORIZED */
export async function authenticate(token: string): Promise<AuthContext> {
  if (!token) throw new WalletError("UNAUTHORIZED", "缺少访问令牌");
  const tokenHash = sha256Hex(token);

  const row = await queryOne<{
    session_id: string;
    user_id: string;
    user_no: string;
    phone: string;
    status: string;
    kyc_level: number;
    created_at: Date | string;
    full_name: string | null;
    national_id_no_last4: string | null;
  }>(
    `SELECT s.id AS session_id, s.user_id,
            u.user_no, u.phone, u.status, u.kyc_level, u.created_at,
            p.full_name, p.national_id_no_last4
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.deleted_at IS NULL`,
    [tokenHash],
  );

  if (!row) throw new WalletError("SESSION_EXPIRED", "登录已失效，请重新登录");
  if (row.status === "suspended") {
    throw new WalletError("ACCOUNT_SUSPENDED", "账户已被冻结 / Account suspended");
  }
  if (row.status === "closed") {
    throw new WalletError("ACCOUNT_CLOSED", "账户已注销 / Account closed");
  }

  // 记录最近使用时间（尽力而为，失败不影响鉴权）
  query(`UPDATE user_sessions SET last_used_at = now() WHERE id = $1`, [
    row.session_id,
  ]).catch(() => undefined);

  return {
    userId: row.user_id,
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      userNo: row.user_no,
      phone: row.phone,
      phoneDisplay: formatPhoneForDisplay(row.phone),
      fullName: row.full_name ?? "",
      status: row.status,
      kycLevel: Number(row.kyc_level),
      nationalIdLast4: row.national_id_no_last4
        ? String(row.national_id_no_last4).trim()
        : null,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    },
  };
}

export async function logout(sessionId: string): Promise<void> {
  await query(
    `UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

/* ────────────────────────────────────────────────────────────────
   5. 当前用户 + 钱包列表
   ──────────────────────────────────────────────────────────────── */

export interface WalletView {
  walletId: string;
  walletNo: string;
  asset: string;
  decimals: number;
  balance: string;
  locked: string;
  available: string;
}

export async function getWallets(userId: string): Promise<WalletView[]> {
  const rows = await query<{
    id: string;
    wallet_no: string;
    asset_code: string;
    balance: string;
    locked_balance: string;
    decimals: number;
  }>(
    `SELECT w.id, w.wallet_no, w.asset_code, w.balance, w.locked_balance, a.decimals
       FROM wallets w
       JOIN assets a ON a.code = w.asset_code
      WHERE w.user_id = $1 AND w.wallet_type = 'user' AND w.status <> 'closed'
      ORDER BY w.asset_code`,
    [userId],
  );

  return rows.map((r) => {
    const decimals = Number(r.decimals);
    const balanceMinor = safeMinor(r.balance, decimals);
    const lockedMinor = safeMinor(r.locked_balance, decimals);
    return {
      walletId: r.id,
      walletNo: r.wallet_no,
      asset: r.asset_code,
      decimals,
      balance: fromMinor(balanceMinor, decimals),
      locked: fromMinor(lockedMinor, decimals),
      available: fromMinor(balanceMinor - lockedMinor, decimals),
    };
  });
}

/** numeric 字符串 → BigInt（用户钱包不会为负；负数只可能来自系统钱包，此处直接截断为 0 以上） */
function safeMinor(value: string, decimals: number): bigint {
  const raw = String(value ?? "0").trim();
  const neg = raw.startsWith("-");
  const [intPart, fracPart = ""] = (neg ? raw.slice(1) : raw).split(".");
  const padded = fracPart.padEnd(decimals, "0").slice(0, decimals);
  const digits = `${intPart}${padded}`.replace(/^0+(?=\d)/, "");
  const v = BigInt(digits || "0");
  return neg ? -v : v;
}

export async function getMe(userId: string): Promise<{
  user: PublicUser;
  wallets: WalletView[];
}> {
  const row = await queryOne<UserRow>(
    `SELECT u.id, u.user_no, u.phone, u.password_hash, u.status,
            u.kyc_level, u.created_at,
            p.full_name, p.national_id_no_last4
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId],
  );
  if (!row) throw new WalletError("NOT_FOUND", "用户不存在");
  return { user: toPublicUser(row), wallets: await getWallets(userId) };
}

export { decimalsOf };
