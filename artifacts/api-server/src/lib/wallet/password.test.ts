import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  isStrongPassword,
  verifyPassword,
} from './password';

describe('password: 只存哈希', () => {
  it('哈希串不是明文，且带算法参数', async () => {
    const stored = await hashPassword('Correct#Horse9');
    expect(stored).not.toContain('Correct#Horse9');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored.split('$').length).toBe(6);
  });

  it('同一密码两次哈希不同（随机 salt），但都能校验通过', async () => {
    const a = await hashPassword('Correct#Horse9');
    const b = await hashPassword('Correct#Horse9');
    expect(a).not.toBe(b);
    expect(await verifyPassword('Correct#Horse9', a)).toBe(true);
    expect(await verifyPassword('Correct#Horse9', b)).toBe(true);
  });

  it('错误密码校验失败', async () => {
    const stored = await hashPassword('Correct#Horse9');
    expect(await verifyPassword('Wrong#Horse9', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('损坏/伪造的哈希串不会抛异常，只返回 false', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$bad$format')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});

describe('password: 强度规则', () => {
  it('拒绝纯数字与过短密码（演示 PIN 123456 不能当登录密码）', () => {
    expect(isStrongPassword('123456')).toBe(false);
    expect(isStrongPassword('12345678')).toBe(false);
    expect(isStrongPassword('password')).toBe(false); // 单一类别
  });

  it('接受字母+数字/符号的组合', () => {
    expect(isStrongPassword('Correct#Horse9')).toBe(true);
    expect(isStrongPassword('abaPay2026')).toBe(true);
    expect(isStrongPassword('ខ្មែរabc123')).toBe(true);
  });

  it('拒绝超长密码（防 DoS）', () => {
    expect(isStrongPassword('Aa1'.repeat(100))).toBe(false);
  });
});
