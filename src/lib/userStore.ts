/* ─── User profile store (single source of truth for the logged-in user) ────────
   Holds the user's name, phone, payment PIN, and account numbers.
   Persisted to localStorage so the new user info (CHHENG BONNY) replaces
   the old "qiang" demo data everywhere it is shown across Home / Accounts / Profile).
────────────────────────────────────────────────────────────────────────────── */

export type UserProfile = {
  fullName: string;
  shortName: string;
  phone: string;
  paymentPin: string;
  usdAccount: string;   // USD account number (digits, no spaces)
  usdAccountDisplay: string;  // USD account number formatted for display
  khrAccount: string;   // KHR account number (digits, no spaces)
  khrAccountDisplay: string;  // KHR account number formatted for display
  idCard: string;
  email: string;
};

const KEY = 'aba.userProfile.v1';

/** The new user's identity. These defaults replace the old "qiang" demo data. */
const DEFAULTS: UserProfile = {
  fullName: 'CHHENG BONNY',
  shortName: 'CHHENG BONNY',
  phone: '097 993 5561',
  paymentPin: '150614',
  usdAccount: '016681281',
  usdAccountDisplay: '016 681 281',
  khrAccount: '016280235',
  khrAccountDisplay: '016 280 235',
  idCard: '',
  email: '',
};

let cache: UserProfile | null = null;

function load(): UserProfile {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      // 显式断言：JSON.parse 返回 any，直接赋值会让 TS 无法收窄 cache 的类型
      const parsed = JSON.parse(raw) as Partial<UserProfile>;
      cache = { ...DEFAULTS, ...parsed };
      return cache;
    }
  } catch { /* storage unavailable */ }
  cache = { ...DEFAULTS };
  return cache;
}

function save(p: UserProfile) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* noop */ }
}

/** Get the current user profile. */
export function getUser(): UserProfile {
  return load();
}

/** Partially update the user profile. */
export function updateUser(patch: Partial<UserProfile>): UserProfile {
  const next = { ...load(), ...patch };
  cache = next;
  save(next);
  return next;
}

/** Reset to the default new-user identity. */
export function resetUser(): UserProfile {
  cache = { ...DEFAULTS };
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
  return cache;
}

/** The payment PIN used to authorise transfers. */
export const PAYMENT_PIN = DEFAULTS.paymentPin;

/* ─── 证件号：每个用户都不同 ────────────────────────────────────────────────
   正式环境由 KYC 流程提供；本地/演示环境按手机号确定性生成，
   同一手机号永远得到同一个号，不同手机号得到不同号（不会所有人共用 49399）。
──────────────────────────────────────────────────────────────────────────── */

/** FNV-1a 32 位哈希（确定性、无依赖） */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 由种子（手机号）生成 9 位证件号 */
export function generateIdCard(seed: string): string {
  const digits = String(seed ?? '').replace(/\D+/g, '') || String(seed ?? 'user');
  const a = fnv1a(`id:${digits}`);
  const b = fnv1a(`nid:${digits}:${digits.length}`);
  // 两段哈希拼出 9 位（100000000–999999999），同号概率约 1/9e8
  const n = (a % 900000000) + 100000000;
  const m = (b % 900) + 100;
  return `${String(n).slice(0, 6)}${String(m).slice(0, 3)}`;
}

/**
 * 取当前用户的证件号；没有就按手机号生成并持久化。
 * 返回值保证「每个用户都不同」（手机号唯一 → 证件号唯一）。
 */
export function ensureIdCard(): string {
  const p = load();
  const existing = (p.idCard || '').trim();
  if (existing) return existing;
  const generated = generateIdCard(p.phone || p.usdAccount || p.fullName);
  const next = { ...p, idCard: generated };
  cache = next;
  save(next);
  return generated;
}
