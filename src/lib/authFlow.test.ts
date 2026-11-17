import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  SIGNUP_PHONE_KEY,
  clearSignupPhone,
  endSession,
  getBackFor,
  getSignupPhone,
  isAuthPath,
  isSessionActive,
  setBackFor,
  setSignupPhone,
  startSession,
} from './authFlow';

/**
 * 本项目的 jsdom 环境没有 localStorage（真实浏览器一定有）。
 * 这里补一个最小实现，好让「会话持久化」这条逻辑能被真正测到。
 */
function ensureLocalStorage(): void {
  if (window.localStorage) return;
  const mem = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        mem.set(k, String(v));
      },
      removeItem: (k: string) => {
        mem.delete(k);
      },
      clear: () => mem.clear(),
      key: (i: number) => Array.from(mem.keys())[i] ?? null,
      get length() {
        return mem.size;
      },
    },
  });
}

describe('authFlow: 注册/登录页面互联', () => {
  beforeAll(() => {
    ensureLocalStorage();
  });

  beforeEach(() => {
    try {
      sessionStorage.clear();
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('按页面分别记录返回来源，互不覆盖', () => {
    // start → register
    setBackFor('/auth/register', '/auth/start');
    expect(getBackFor('/auth/register', '/auth/x')).toBe('/auth/start');

    // register → signup：只改 signup 的来源，register 的来源保持不变
    setBackFor('/auth/signup', '/auth/register');
    expect(getBackFor('/auth/signup', '/auth/x')).toBe('/auth/register');
    expect(getBackFor('/auth/register', '/auth/x')).toBe('/auth/start');

    // signup → register（已有账号登录）：改 register 的来源
    setBackFor('/auth/register', '/auth/signup');
    expect(getBackFor('/auth/register', '/auth/x')).toBe('/auth/signup');
    // signup 自己的来源仍是 register，不会自环
    expect(getBackFor('/auth/signup', '/auth/x')).toBe('/auth/register');
  });

  it('没有记录时用 fallback，不返回自己（防自环）', () => {
    expect(getBackFor('/auth/register', '/auth/start')).toBe('/auth/start');

    // 明确写成自己也必须被兜底掉，否则点返回原地不动
    setBackFor('/auth/signup', '/auth/signup');
    expect(getBackFor('/auth/signup', '/auth/start')).toBe('/auth/start');
  });

  it('预填手机号规范化存储，展示转回本地格式', () => {
    setSignupPhone('+855 097 993 5561');
    expect(sessionStorage.getItem(SIGNUP_PHONE_KEY)).toBe('855979935561');
    expect(getSignupPhone()).toBe('0979935561');

    setSignupPhone('0912000111');
    expect(getSignupPhone()).toBe('0912000111');
  });

  it('号码太短不写入；开户成功后清掉预填', () => {
    setSignupPhone('12');
    expect(getSignupPhone()).toBe('');

    setSignupPhone('0912000111');
    clearSignupPhone();
    expect(getSignupPhone()).toBe('');
  });

  it('无记录时返回空串/兜底路径，不抛异常', () => {
    expect(getSignupPhone()).toBe('');
    expect(getBackFor('/auth/otp', '/auth/register')).toBe('/auth/register');
  });

  it('OTP 通过建立会话，退出后清除', () => {
    expect(isSessionActive()).toBe(false);
    startSession();
    expect(isSessionActive()).toBe(true);
    endSession();
    expect(isSessionActive()).toBe(false);
  });

  it('会话持久化在 localStorage：刷新/新标签页都不会退回登录页', () => {
    startSession();
    // 模拟「关掉 sessionStorage（换标签页/刷新）」后仍保持登录
    sessionStorage.clear();
    expect(isSessionActive()).toBe(true);
    expect(localStorage.getItem('aba.session')).toBeTruthy();

    endSession();
    expect(isSessionActive()).toBe(false);
    expect(localStorage.getItem('aba.session')).toBeNull();
  });

  it('只有 auth 页面会被守卫拦下，主页与业务页不受影响', () => {
    expect(isAuthPath('/')).toBe(true);
    expect(isAuthPath('/auth/language')).toBe(true);
    expect(isAuthPath('/auth/start')).toBe(true);
    expect(isAuthPath('/auth/register')).toBe(true);
    expect(isAuthPath('/auth/signup')).toBe(true);
    expect(isAuthPath('/auth/otp')).toBe(true);

    expect(isAuthPath('/home')).toBe(false);
    expect(isAuthPath('/accounts')).toBe(false);
    expect(isAuthPath('/transfer')).toBe(false);
    expect(isAuthPath('/settings/profile')).toBe(false);
  });
});
