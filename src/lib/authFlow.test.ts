import { describe, it, expect, beforeEach } from 'vitest';
import {
  SIGNUP_PHONE_KEY,
  clearSignupPhone,
  getBackFor,
  getSignupPhone,
  setBackFor,
  setSignupPhone,
} from './authFlow';

describe('authFlow: 注册/登录页面互联', () => {
  beforeEach(() => {
    try {
      sessionStorage.clear();
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
});
