/**
 * 注册 / 登录流程的页面互联（auth flow navigation）。
 *
 * 目标：`/auth/start`、`/auth/register`（登录）、`/auth/signup`（开户）、
 * `/auth/otp`（验证码）四个页面之间任意可达，不出现死胡同，也不出现自环：
 *
 *   start ──▶ register ──(未注册拦截)──▶ signup
 *     │          ▲                          │
 *     │          └──────(已有账号登录)───────┘
 *     └──────────▶ signup ──(注册成功)──▶ otp ──▶ home
 *
 * 关键：**按目标页面分别记录返回来源**（`aba.back:<页面>`），而不是共用一个键。
 * 共用一个键时，register→signup 会把 back 改成 signup，
 * 之后在 signup 点返回就跳回自己（自环）。
 *
 * 存 sessionStorage，仅本标签页有效，关掉即清，不落盘。
 */

import { normalizePhone } from './phoneRegistry';

/** 开户页预填的手机号（登录页未注册拦截后跳开户时带过去） */
export const SIGNUP_PHONE_KEY = 'aba.signupPhone';

const backKey = (page: string) => `aba.back:${page}`;

/**
 * 记录「page 这一页是从 source 进来的」，page 的返回键就能回到 source。
 * 必须在跳转到 page **之前**调用。
 */
export function setBackFor(page: string, source: string): void {
  try {
    sessionStorage.setItem(backKey(page), source);
  } catch {
    /* storage 不可用时静默降级为 fallback */
  }
}

/**
 * 读取 page 的返回目标。
 * 没有记录（直接刷新 / 首次进入 / 路由直达）时用 fallback，避免返回到不存在的页面。
 */
export function getBackFor(page: string, fallback: string): string {
  try {
    const v = sessionStorage.getItem(backKey(page));
    // 防御：不允许返回到自己
    return v && v !== page ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 记录开户页要预填的手机号。
 * 复用 phoneRegistry 的 normalizePhone —— 它已经处理了「+855 097 993 5561」
 * 这种把本地前导 0 也写进来的写法，统一到 `855979935561`。
 */
export function setSignupPhone(raw: string): void {
  try {
    const digits = normalizePhone(raw);
    if (digits.replace(/\D/g, '').length >= 6) {
      sessionStorage.setItem(SIGNUP_PHONE_KEY, digits);
    }
  } catch {
    /* ignore */
  }
}

/** 取出开户页预填手机号，转成本地展示格式 `0979935561`；无记录返回空串 */
export function getSignupPhone(): string {
  try {
    const raw = sessionStorage.getItem(SIGNUP_PHONE_KEY);
    if (!raw) return '';
    const digits = raw.replace(/\D+/g, '');
    if (digits.startsWith('855')) return `0${digits.slice(3)}`;
    return digits;
  } catch {
    return '';
  }
}

/** 开户成功后清掉预填，避免下次进入残留旧号码 */
export function clearSignupPhone(): void {
  try {
    sessionStorage.removeItem(SIGNUP_PHONE_KEY);
  } catch {
    /* ignore */
  }
}

/* ─── 已登录会话标志 ───────────────────────────────────────────
   OTP 验证通过进入主页时打上标记；有了它，从主页按「返回」落到
   任何 auth 页面（语言选择 / 登录 / 开户 / OTP）都会被立刻送回主页，
   而不会把用户扔回登录流程里。

   存 localStorage：登录一次后，刷新、新开标签页、关掉浏览器再打开
   都不会再看到登录页面。安全性由 PIN 锁（PinLock，每次打开仍要输）
   兜底 —— PIN 存 sessionStorage，标签页关掉即失效。 */

export const SESSION_KEY = 'aba.session';

/** 优先 localStorage，拿不到（隐私模式/禁用）就退回 sessionStorage */
function sessionStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  }
}

/** OTP 通过 → 建立会话（顺带把本次手机号记进去，便于展示） */
export function startSession(): void {
  try {
    let phone = '';
    try {
      phone = sessionStorage.getItem('aba.pendingPhone') || '';
    } catch {
      /* ignore */
    }
    const value = phone || '1';
    sessionStore()?.setItem(SESSION_KEY, value);
    // 兼容之前存在 sessionStorage 的会话，避免升级后要重新登录
    sessionStorage.setItem(SESSION_KEY, value);
  } catch {
    /* ignore */
  }
}

/** 是否已登录 */
export function isSessionActive(): boolean {
  try {
    if (window.localStorage?.getItem(SESSION_KEY)) return true;
  } catch {
    /* ignore */
  }
  try {
    return Boolean(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return false;
  }
}

/** 退出登录（当前 UI 没有入口，保留给后续用） */
export function endSession(): void {
  try {
    window.localStorage?.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** 已登录时这些页面不该再出现 —— 主页返回不能回到它们 */
export const AUTH_PATHS = [
  '/',
  '/auth/language',
  '/auth/start',
  '/auth/register',
  '/auth/signup',
  '/auth/otp',
] as const;

export function isAuthPath(path: string): boolean {
  return (AUTH_PATHS as readonly string[]).includes(path);
}
