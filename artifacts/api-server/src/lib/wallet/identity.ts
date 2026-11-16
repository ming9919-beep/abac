/**
 * 身份敏感数据处理：
 *   - 手机号规范化（登录标识必须唯一且格式稳定）
 *   - 证件号：密文（AES-256-GCM）+ HMAC 哈希（唯一索引）+ 后 4 位（展示）
 *
 * 规则（见 docs/wallet/01-business-rules.md §7）：
 *   证件号**每个用户都不同** —— 哈希列上有唯一索引，重号直接被数据库拒绝。
 *   业务表不放明文证件号、不放完整卡号、不放私钥。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { WalletError } from "./errors";

/* ────────────────────────────────────────────────────────────────
   环境密钥
   ──────────────────────────────────────────────────────────────── */

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function devSecret(name: string): string {
  // 非生产环境允许缺失：用固定值兜底，保证本地/演示可跑；启动时告警一次
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(
      `[wallet] 环境变量 ${name} 未设置，使用开发用占位密钥。生产环境必须配置！`,
    );
  }
  return `dev-only-${name}`;
}
const warned = new Set<string>();

function requiredSecret(name: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (isProduction()) {
    throw new WalletError(
      "INTERNAL_ERROR",
      `缺少必需的环境变量 ${name}`,
    );
  }
  return devSecret(name);
}

/** AES-256-GCM 主密钥（32 字节 base64） */
function encryptionKey(): Buffer {
  const raw = requiredSecret("WALLET_ENCRYPTION_KEY");
  const buf = Buffer.from(raw, "base64");
  if (buf.length === 32) return buf;
  if (isProduction()) {
    throw new WalletError(
      "INTERNAL_ERROR",
      "WALLET_ENCRYPTION_KEY 必须是 32 字节的 base64",
    );
  }
  // 开发环境：由任意长度字符串确定性派生 32 字节（仅开发用）
  return createHmac("sha256", "dev-encryption-key").update(raw).digest();
}

/** HMAC pepper（证件号唯一哈希用） */
function idPepper(): string {
  return requiredSecret("WALLET_ID_PEPPER");
}

/* ────────────────────────────────────────────────────────────────
   手机号
   ──────────────────────────────────────────────────────────────── */

/** 去掉所有非数字，再补国家码 → `855979935561` */
export function normalizePhone(input: string): string {
  if (typeof input !== "string") {
    throw new WalletError("INVALID_PHONE", "手机号格式不正确");
  }
  let digits = input.replace(/\D+/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2); // +855 → 00855

  if (digits.startsWith("855")) {
    // 兼容「+855 097 993 5561」这种把本地前导 0 也写进来的写法：
    // 855 + 10 位且以 0 开头 → 去掉那个 0，得到 855 + 9 位
    const rest = digits.slice(3);
    if (rest.startsWith("0") && rest.length === 10) {
      digits = `855${rest.slice(1)}`;
    }
  } else if (digits.startsWith("0")) {
    digits = `855${digits.slice(1)}`;
  } else if (digits.length === 9) {
    digits = `855${digits}`;
  }

  if (!/^\d{8,15}$/.test(digits)) {
    throw new WalletError("INVALID_PHONE", "手机号格式不正确");
  }
  return digits;
}

/** 展示用：855979935561 → +855 97 993 5561 */
export function formatPhoneForDisplay(phone: string): string {
  if (!phone.startsWith("855") || phone.length !== 12) return `+${phone}`;
  return `+855 ${phone.slice(3, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}`;
}

/** 是否是可接受的手机号（登录前置校验用，不抛异常） */
export function isValidPhone(input: string): boolean {
  try {
    normalizePhone(input);
    return true;
  } catch {
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────
   证件号
   ──────────────────────────────────────────────────────────────── */

/** 规范化：去掉空格/横线，统一大写（同一证件号的任何写法都算同一个） */
export function normalizeNationalId(input: string): string {
  if (typeof input !== "string") {
    throw new WalletError("VALIDATION_ERROR", "证件号格式不正确");
  }
  const normalized = input.replace(/[\s\-.]/g, "").toUpperCase();
  if (normalized.length < 4 || normalized.length > 32) {
    throw new WalletError("VALIDATION_ERROR", "证件号长度不合法");
  }
  return normalized;
}

/** HMAC-SHA256(pepper, 规范化证件号) → 64 位 hex，用于唯一索引（不可反推） */
export function hashNationalId(input: string): string {
  return createHmac("sha256", idPepper())
    .update(normalizeNationalId(input), "utf8")
    .digest("hex");
}

/** AES-256-GCM 加密 → base64(iv).base64(tag).base64(ciphertext) */
export function encryptNationalId(input: string): string {
  const normalized = normalizeNationalId(input);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(normalized, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/** 解密（只有服务端密钥能还原；失败说明被篡改或密钥不对） */
export function decryptNationalId(payload: string): string {
  const parts = String(payload).split(".");
  if (parts.length !== 3) {
    throw new WalletError("INTERNAL_ERROR", "证件号密文格式不合法");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** 后 4 位（客服/用户界面唯一允许的展示形式） */
export function nationalIdLast4(input: string): string {
  const normalized = normalizeNationalId(input);
  return normalized.slice(-4);
}

/** 校验保存的密文与哈希是否对应（用于完整性抽查） */
export function nationalIdMatches(
  plain: string,
  hash: string,
): boolean {
  const a = Buffer.from(hashNationalId(plain), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
