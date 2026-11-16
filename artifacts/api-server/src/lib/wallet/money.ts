/**
 * 金额计算 —— 全程 BigInt 最小单位，禁止任何浮点参与。
 *
 * 约定：
 *   - 数据库存的是「元」的 numeric(38,18) 字符串，例如 "12.34"、"10000"
 *   - 服务层换算成最小单位 BigInt 计算（USD=2 位 → 12.34 元 = 1234n）
 *   - 对外 API 一律传/收**十进制字符串**，不收 number
 *
 * 例子（USD, decimals=2）：
 *   toMinor("12.34") === 1234n
 *   fromMinor(1234n, 2) === "12.34"
 *   fromMinor(10000n, 2) === "100.00"   ← 库里存这个
 */

/** 金额格式：整数部分 1–18 位，小数部分 0–18 位；不允许负号、不允许科学计数法 */
const AMOUNT_RE = /^\d{1,18}(\.\d{1,18})?$/;

export class MoneyError extends Error {
  readonly code = "INVALID_AMOUNT";
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** 十进制字符串 → BigInt 最小单位 */
export function toMinor(amount: string, decimals: number): bigint {
  if (typeof amount !== "string") {
    throw new MoneyError("金额必须是字符串（不要传 number）");
  }
  const raw = amount.trim();
  if (!AMOUNT_RE.test(raw)) {
    throw new MoneyError(`金额格式不合法: ${amount}`);
  }
  const [intPart, fracPart = ""] = raw.split(".");
  if (fracPart.length > decimals) {
    throw new MoneyError(
      `金额小数位超过币种精度（${decimals} 位）: ${amount}`,
    );
  }
  const padded = fracPart.padEnd(decimals, "0");
  const digits = `${intPart}${padded}`.replace(/^0+(?=\d)/, "");
  return BigInt(digits === "" ? "0" : digits);
}

/** BigInt 最小单位 → 十进制字符串（补齐小数位，库里就存这个） */
export function fromMinor(minor: bigint, decimals: number): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  if (decimals <= 0) return `${negative ? "-" : ""}${abs.toString()}`;
  const s = abs.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals);
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

/** 十进制字符串原样规范化（用于落库前的 numeric 列），不改变数值 */
export function normalizeAmount(amount: string, decimals: number): string {
  return fromMinor(toMinor(amount, decimals), decimals);
}

/** 解析并要求 > 0（业务上的「金额必须为正」） */
export function toPositiveMinor(amount: string, decimals: number): bigint {
  const v = toMinor(amount, decimals);
  if (v <= 0n) throw new MoneyError("金额必须大于 0");
  return v;
}

/** 解析允许为 0 的金额（手续费可以是 0） */
export function toNonNegativeMinor(amount: string, decimals: number): bigint {
  const v = toMinor(amount, decimals);
  if (v < 0n) throw new MoneyError("金额不能为负");
  return v;
}

export function add(a: bigint, b: bigint): bigint {
  return a + b;
}
export function sub(a: bigint, b: bigint): bigint {
  return a - b;
}
export function cmp(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 展示用：USD → "1,234.56"（不参与任何计算） */
export function formatForDisplay(amount: string, decimals: number): string {
  const minor = toMinor(amount, decimals);
  const plain = fromMinor(minor, decimals);
  const [i, f] = plain.split(".");
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return f ? `${grouped}.${f}` : grouped;
}

/** 币种 → 小数位（与 assets.decimals 一致；USD=2、KHR=0） */
export const ASSET_DECIMALS: Record<string, number> = {
  USD: 2,
  KHR: 0,
};

export function decimalsOf(assetCode: string): number {
  const d = ASSET_DECIMALS[assetCode];
  if (d === undefined) {
    throw new MoneyError(`未知币种: ${assetCode}`);
  }
  return d;
}

/* ────────────────────────────────────────────────────────────────
   numeric(38,18) 与最小单位的换算

   数据库 numeric 列固定是 18 位小数（"100.000000000000000000"），
   而业务上的最小单位是币种精度（USD=2 → 10000n 表示 100.00）。
   服务层统一用**18 位定点 BigInt**做所有运算：
     parseNumeric18("100.000000000000000000") === 100_000000000000000000n
   对外展示时再用 toAssetString 换回币种精度。
   ──────────────────────────────────────────────────────────────── */

export const NUMERIC_SCALE = 18;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** 库里读出的 numeric 字符串 → 18 位定点 BigInt */
export function parseNumeric18(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  const raw = String(value).trim();
  if (raw === "") return 0n;
  const neg = raw.startsWith("-");
  const [intPart, fracPart = ""] = (neg ? raw.slice(1) : raw).split(".");
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) {
    throw new MoneyError(`numeric 格式不合法: ${value}`);
  }
  const padded = fracPart.padEnd(NUMERIC_SCALE, "0").slice(0, NUMERIC_SCALE);
  const digits = `${intPart || "0"}${padded}`.replace(/^0+(?=\d)/, "");
  const v = BigInt(digits || "0");
  return neg ? -v : v;
}

/** 18 位定点 BigInt → 库里要写入的 numeric 字符串 */
export function formatNumeric18(value: bigint): string {
  return fromMinor(value, NUMERIC_SCALE);
}

/** 币种精度的最小单位 → 18 位定点（用于与库内数值相加减） */
export function toScale18(minor: bigint, decimals: number): bigint {
  return minor * pow10(NUMERIC_SCALE - decimals);
}

/** 18 位定点 → 币种精度的最小单位（输入必须是币种精度的整数倍） */
export function fromScale18(value: bigint, decimals: number): bigint {
  const factor = pow10(NUMERIC_SCALE - decimals);
  const q = value / factor;
  const r = value % factor;
  if (r !== 0n) {
    throw new MoneyError("金额精度超过币种允许的小数位");
  }
  return q;
}

/** 库里读出的 numeric → 币种精度的十进制字符串（API 响应用） */
export function toAssetString(
  value: string | number | null | undefined,
  decimals: number,
): string {
  return fromMinor(fromScale18(parseNumeric18(value), decimals), decimals);
}
