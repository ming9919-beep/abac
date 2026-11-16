import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PHONE_NOT_REGISTERED_I18N,
  PHONE_NOT_REGISTERED_MESSAGE,
  checkPhoneRegistered,
  isLocallyRegistered,
  isNotRegistered,
  normalizePhone,
  rememberRegisteredPhone,
} from './phoneRegistry';

describe('phoneRegistry: 手机号规范化', () => {
  it('各种写法都归一到 855XXXXXXXXX', () => {
    expect(normalizePhone('+855 097 993 5561')).toBe('855979935561');
    expect(normalizePhone('097 993 5561')).toBe('855979935561');
    expect(normalizePhone('855979935561')).toBe('855979935561');
    expect(normalizePhone('0979935561')).toBe('855979935561');
    expect(normalizePhone('979935561')).toBe('855979935561');
    expect(normalizePhone('00855979935561')).toBe('855979935561');
  });

  it('演示手机号在本地注册表里（服务端不可达时不会被误拦）', () => {
    expect(isLocallyRegistered('+855 097 993 5561')).toBe(true);
    expect(isLocallyRegistered('097 993 5561')).toBe(true);
  });

  it('未登记的号码默认不在注册表', () => {
    expect(isLocallyRegistered('011222333')).toBe(false);
  });
});

describe('phoneRegistry: 未注册手机号必须被拦截', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('服务端返回 404 → registered=false + 固定文案', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          registered: false,
          code: 'PHONE_NOT_REGISTERED',
          message: PHONE_NOT_REGISTERED_MESSAGE,
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const result = await checkPhoneRegistered('011222333');
    expect(result.registered).toBe(false);
    expect(result.source).toBe('server');
    expect(isNotRegistered(result)).toBe(true);
    expect(result.message).toContain('还没注册本银行使用');
  });

  it('服务端返回 200 registered=true → 放行', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ registered: true, status: 'active' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const result = await checkPhoneRegistered('011222333');
    expect(result.registered).toBe(true);
    expect(result.status).toBe('active');
    expect(isNotRegistered(result)).toBe(false);
  });

  it('服务端不可达 → 本地兜底：演示号放行、陌生号拦截', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const demo = await checkPhoneRegistered('097 993 5561');
    expect(demo.source).toBe('local');
    expect(demo.registered).toBe(true);

    const stranger = await checkPhoneRegistered('011222333');
    expect(stranger.source).toBe('local');
    expect(stranger.registered).toBe(false);
    expect(isNotRegistered(stranger)).toBe(true);
  });

  it('三语文案齐全且中文与用户要求一致', () => {
    expect(PHONE_NOT_REGISTERED_I18N.zh).toBe('你手机号码目前还没注册本银行使用');
    expect(PHONE_NOT_REGISTERED_I18N.en).toContain('not registered with this bank');
    expect(PHONE_NOT_REGISTERED_I18N.km).toContain('ធនាគារ');
    expect(PHONE_NOT_REGISTERED_MESSAGE).toContain(PHONE_NOT_REGISTERED_I18N.zh);
  });

  it('rememberRegisteredPhone 立即生效（注册成功后同端可登录）', () => {
    const phone = `011${Math.floor(Math.random() * 10000000)
      .toString()
      .padStart(7, '0')}`;
    expect(isLocallyRegistered(phone)).toBe(false);
    rememberRegisteredPhone(phone);
    expect(isLocallyRegistered(phone)).toBe(true);
  });
});
