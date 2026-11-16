import { describe, it, expect } from 'vitest';
import {
  formatForDisplay,
  formatNumeric18,
  fromMinor,
  fromScale18,
  normalizeAmount,
  parseNumeric18,
  toAssetString,
  toMinor,
  toPositiveMinor,
  toScale18,
} from '../../artifacts/api-server/src/lib/wallet/money';

describe('money: 最小单位换算（BigInt，无浮点）', () => {
  it('USD 两位小数', () => {
    expect(toMinor('12.34', 2)).toBe(1234n);
    expect(toMinor('100', 2)).toBe(10000n);
    expect(toMinor('0.01', 2)).toBe(1n);
    expect(fromMinor(1234n, 2)).toBe('12.34');
    expect(fromMinor(10000n, 2)).toBe('100.00');
  });

  it('KHR 零位小数', () => {
    expect(toMinor('10000', 0)).toBe(10000n);
    expect(fromMinor(10000n, 0)).toBe('10000');
  });

  it('拒绝非法格式与超精度', () => {
    expect(() => toMinor('-1', 2)).toThrow();
    expect(() => toMinor('1e3', 2)).toThrow();
    expect(() => toMinor('abc', 2)).toThrow();
    expect(() => toMinor('1.234', 2)).toThrow(); // USD 只允许 2 位小数
  });

  it('拒绝非正数金额', () => {
    expect(() => toPositiveMinor('0', 2)).toThrow();
    expect(() => toPositiveMinor('-5', 2)).toThrow();
  });

  it('大量金额不会丢精度（浮点会出错的场景）', () => {
    // 0.1 + 0.2 !== 0.3 的经典问题
    const a = toMinor('0.1', 2);
    const b = toMinor('0.2', 2);
    expect(fromMinor(a + b, 2)).toBe('0.30'); // 0.10 + 0.20，绝不等于 0.30000000000000004
    // 超大金额
    expect(toMinor('9999999999999999.99', 2)).toBe(999999999999999999n);
    expect(fromMinor(999999999999999999n, 2)).toBe('9999999999999999.99');
  });

  it('normalizeAmount 规范化落库字符串', () => {
    expect(normalizeAmount('100.5', 2)).toBe('100.50');
    expect(normalizeAmount('100', 0)).toBe('100');
  });

  it('formatForDisplay 加千分位（仅展示）', () => {
    expect(formatForDisplay('1234.5', 2)).toBe('1,234.50');
    expect(formatForDisplay('1234567', 0)).toBe('1,234,567');
  });
});

describe('money: numeric(38,18) ↔ 最小单位', () => {
  it('解析数据库读出的 18 位小数字符串', () => {
    expect(parseNumeric18('100.000000000000000000')).toBe(100n * 10n ** 18n);
    expect(parseNumeric18('0')).toBe(0n);
    expect(parseNumeric18(null)).toBe(0n);
    expect(parseNumeric18('-1.5')).toBe(-15n * 10n ** 17n);
  });

  it('formatNumeric18 写回 18 位小数', () => {
    expect(formatNumeric18(100n * 10n ** 18n)).toBe('100.000000000000000000');
  });

  it('toScale18 / fromScale18 与币种精度互转', () => {
    // USD 100.00 → 最小单位 10000n → 18 位定点
    const minor = toMinor('100.00', 2);
    const s18 = toScale18(minor, 2);
    expect(s18).toBe(100n * 10n ** 18n);
    expect(fromScale18(s18, 2)).toBe(minor);
    // KHR 0 位小数
    expect(toScale18(4000n, 0)).toBe(4000n * 10n ** 18n);
  });

  it('toAssetString 直接把库里的值变成 API 字符串', () => {
    expect(toAssetString('100.000000000000000000', 2)).toBe('100.00');
    expect(toAssetString('4000.000000000000000000', 0)).toBe('4000');
    expect(toAssetString('0.010000000000000000', 2)).toBe('0.01');
  });

  it('精度不匹配时明确报错，而不是悄悄截断', () => {
    // USD 账户里出现 0.005 → 非法，必须抛错
    expect(() => toAssetString('0.005', 2)).toThrow();
  });
});
