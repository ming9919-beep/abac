/**
 * 钱包接口统一错误。
 *
 * 对外只返回 { code, message, details? }，原始堆栈进 pino 日志，
 * 不泄露 SQL、内部路径或用户敏感信息。
 */

export type WalletErrorCode =
  // 身份 / 登录
  | "PHONE_NOT_REGISTERED"
  | "PHONE_ALREADY_REGISTERED"
  | "ID_CARD_ALREADY_USED"
  | "BAD_PASSWORD"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_CLOSED"
  | "WEAK_PASSWORD"
  | "INVALID_PHONE"
  | "UNAUTHORIZED"
  | "SESSION_EXPIRED"
  // 参数
  | "VALIDATION_ERROR"
  | "INVALID_AMOUNT"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "REQUEST_IN_PROGRESS"
  // 钱包 / 资金
  | "WALLET_NOT_FOUND"
  | "WALLET_FROZEN"
  | "ASSET_NOT_ACTIVE"
  | "BALANCE_INSUFFICIENT"
  | "LIMIT_EXCEEDED"
  | "SELF_TRANSFER"
  | "CROSS_ASSET_UNSUPPORTED"
  | "REQUIRES_APPROVAL"
  | "REFUND_EXCEEDS_ORIGINAL"
  | "INVALID_STATE"
  | "AMOUNT_MISMATCH"
  | "SIGNATURE_INVALID"
  | "NOT_FOUND"
  | "ADMIN_KEY_REQUIRED"
  | "REGISTRATION_DISABLED"
  // 系统
  | "INTERNAL_ERROR"
  | "DATABASE_UNAVAILABLE";

const STATUS_BY_CODE: Record<WalletErrorCode, number> = {
  PHONE_NOT_REGISTERED: 404,
  PHONE_ALREADY_REGISTERED: 409,
  ID_CARD_ALREADY_USED: 409,
  BAD_PASSWORD: 401,
  ACCOUNT_LOCKED: 423,
  ACCOUNT_SUSPENDED: 403,
  ACCOUNT_CLOSED: 403,
  WEAK_PASSWORD: 400,
  INVALID_PHONE: 400,
  UNAUTHORIZED: 401,
  SESSION_EXPIRED: 401,

  VALIDATION_ERROR: 400,
  INVALID_AMOUNT: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  REQUEST_IN_PROGRESS: 409,

  WALLET_NOT_FOUND: 404,
  WALLET_FROZEN: 403,
  ASSET_NOT_ACTIVE: 404,
  BALANCE_INSUFFICIENT: 422,
  LIMIT_EXCEEDED: 422,
  SELF_TRANSFER: 400,
  CROSS_ASSET_UNSUPPORTED: 400,
  REQUIRES_APPROVAL: 202,
  REFUND_EXCEEDS_ORIGINAL: 422,
  INVALID_STATE: 409,
  AMOUNT_MISMATCH: 409,
  SIGNATURE_INVALID: 401,
  NOT_FOUND: 404,
  ADMIN_KEY_REQUIRED: 401,
  REGISTRATION_DISABLED: 403,

  INTERNAL_ERROR: 500,
  DATABASE_UNAVAILABLE: 503,
};

/** 手机号未注册的固定文案（前后端一致，见 docs/wallet/04-api.md） */
export const PHONE_NOT_REGISTERED_MESSAGE =
  "你手机号码目前还没注册本银行使用 / This phone number is not registered with this bank yet";

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: WalletErrorCode,
    message?: string,
    details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "WalletError";
    this.code = code;
    this.status = STATUS_BY_CODE[code] ?? 500;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** 把任意异常统一成 WalletError（未知错误 → 500，不泄露内部信息） */
export function toWalletError(err: unknown): WalletError {
  if (err instanceof WalletError) return err;
  const anyErr = err as { code?: string; constraint?: string; message?: string };
  // 数据库唯一约束 → 业务错误
  if (anyErr?.constraint === "users_phone_uidx") {
    return new WalletError("PHONE_ALREADY_REGISTERED");
  }
  if (anyErr?.constraint === "user_profiles_national_id_hash_uidx") {
    return new WalletError("ID_CARD_ALREADY_USED");
  }
  if (anyErr?.code === "23505") {
    return new WalletError("IDEMPOTENCY_KEY_REUSED");
  }
  if (anyErr?.code === "57014" || anyErr?.code === "ECONNREFUSED") {
    return new WalletError("DATABASE_UNAVAILABLE", "数据库暂时不可用，请稍后重试");
  }
  return new WalletError(
    "INTERNAL_ERROR",
    anyErr?.message || "internal error",
  );
}
