/**
 * 密码哈希 —— 只存哈希，永不明文。
 *
 * 算法 scrypt（Node 内置，无需原生依赖）：
 *   格式: scrypt$N$r$p$<saltBase64>$<hashBase64>
 *   N=16384, r=8, p=1, keylen=64, salt=16 字节
 * 生产可平滑替换为 argon2id：新增一个前缀即可，老记录登录时按原算法校验后重新哈希。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
// scrypt 默认 maxmem=32MB，N=16384/r=8 刚好在限制内，留出余量
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** 生成密码哈希（异步，不阻塞事件循环） */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordLength(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/** 校验密码（常数时间比较，避免时序侧信道） */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    if (expected.length === 0) return false;
    const actual = await scrypt(password, salt, expected.length, {
      N: n, r, p, maxmem: MAXMEM,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 密码强度：长度 + 至少两种字符类别 */
export function isStrongPassword(password: string): boolean {
  if (typeof password !== "string") return false;
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  // 纯数字（如 123456）一律拒绝
  return classes >= 2;
}

function assertPasswordLength(password: string): void {
  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new Error("password length out of range");
  }
}
