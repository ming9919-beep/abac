import { describe, it, expect } from 'vitest';
import {
  decryptNationalId,
  encryptNationalId,
  formatPhoneForDisplay,
  hashNationalId,
  isValidPhone,
  nationalIdLast4,
  nationalIdMatches,
  normalizeNationalId,
  normalizePhone,
} from './identity';

describe('identity: 手机号', () => {
  it('规范化为 855 + 9 位', () => {
    expect(normalizePhone('097 993 5561')).toBe('855979935561');
    expect(normalizePhone('+855979935561')).toBe('855979935561');
    expect(normalizePhone('979935561')).toBe('855979935561');
  });

  it('非法号码被拒绝', () => {
    expect(() => normalizePhone('abc')).toThrow();
    expect(() => normalizePhone('')).toThrow();
    expect(isValidPhone('123')).toBe(false);
    expect(isValidPhone('0979935561')).toBe(true);
  });

  it('展示格式', () => {
    expect(formatPhoneForDisplay('855979935561')).toBe('+855 97 993 5561');
  });
});

describe('identity: 证件号每人不同', () => {
  it('规范化去掉空格/横线并大写（同一证件号各种写法一致）', () => {
    expect(normalizeNationalId('ab-c 12 3')).toBe('ABC123');
    expect(normalizeNationalId('abc123')).toBe('ABC123');
    expect(() => normalizeNationalId('1')).toThrow(); // 太短
    expect(() => normalizeNationalId('x'.repeat(40))).toThrow(); // 太长
  });

  it('不同用户的证件号哈希一定不同（唯一索引的基础）', () => {
    const a = hashNationalId('493991234');
    const b = hashNationalId('493995678');
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64); // HMAC-SHA256 hex
    expect(a).not.toContain('493991234'); // 不可反推
  });

  it('同一证件号哈希稳定（可做唯一索引）', () => {
    expect(hashNationalId('493991234')).toBe(hashNationalId('49399 1234'));
    expect(hashNationalId('493991234')).toBe(hashNationalId('49399-1234'));
  });

  it('pepper 参与哈希：换 pepper 后不可关联（跨库脱敏）', () => {
    const before = process.env.WALLET_ID_PEPPER;
    try {
      process.env.WALLET_ID_PEPPER = 'pepper-A';
      const a = hashNationalId('493991234');
      process.env.WALLET_ID_PEPPER = 'pepper-B';
      const b = hashNationalId('493991234');
      expect(a).not.toBe(b);
    } finally {
      if (before === undefined) delete process.env.WALLET_ID_PEPPER;
      else process.env.WALLET_ID_PEPPER = before;
    }
  });

  it('密文可还原，且密文里不含明文', () => {
    const plain = '493991234';
    const enc = encryptNationalId(plain);
    expect(enc).not.toContain(plain);
    expect(decryptNationalId(enc)).toBe(plain);
    // 密文每次不同（随机 IV）
    expect(encryptNationalId(plain)).not.toBe(enc);
  });

  it('篡改密文会导致解密失败（AES-GCM 认证）', () => {
    const enc = encryptNationalId('493991234');
    const [iv, tag, data] = enc.split('.');
    const tampered = `${iv}.${tag}.${Buffer.from('deadbeef', 'hex').toString('base64')}`;
    expect(() => decryptNationalId(tampered)).toThrow();
    void data;
  });

  it('只展示后 4 位', () => {
    expect(nationalIdLast4('493991234')).toBe('1234');
  });

  it('完整性校验：明文与哈希是否对应', () => {
    const hash = hashNationalId('493991234');
    expect(nationalIdMatches('493991234', hash)).toBe(true);
    expect(nationalIdMatches('493995678', hash)).toBe(false);
  });
});
