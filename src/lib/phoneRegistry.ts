/**
 * 手机号「是否已注册本银行」校验（登录前置）。
 *
 * 规则（用户原话）：数据库里没有这个手机号 = 没有注册 = 不能登录，
 * 页面要显示「你手机号码目前还没注册本银行使用」。
 *
 * 数据来源：
 *   1. 服务端 `POST /api/wallet/auth/phone-check`（权威，查 users 表）
 *   2. 服务端不可达（本地无库 / 离线预览）→ 本地注册表兜底，保证演示可复现
 *
 * 兜底表必须包含演示手机号，否则演示流程会被误拦。
 */

/** 三语提示文案（与服务端 errors.ts 保持完全一致） */
export const PHONE_NOT_REGISTERED_MESSAGE =
  '你手机号码目前还没注册本银行使用 / This phone number is not registered with this bank yet';

export const PHONE_NOT_REGISTERED_I18N = {
  zh: '你手机号码目前还没注册本银行使用',
  en: 'This phone number is not registered with this bank yet.',
  km: 'លេខទូរស័ព្ទរបស់អ្នកមិនទាន់បានចុះឈ្មោះជាមួយធនាគារនេះទេ។',
} as const;

export type PhoneCheckSource = 'server' | 'local';

export interface PhoneCheckResult {
  /** 是否已在本银行注册（唯一能决定能否登录的字段） */
  registered: boolean;
  /** users.status：active / suspended / pending_verification；未注册为 null */
  status: string | null;
  message: string;
  source: PhoneCheckSource;
}

const DEV_GATEWAY: string =
  (import.meta.env.VITE_WALLET_GATEWAY_URL as string | undefined) ||
  'http://localhost:5200/api';

/** 本地兜底注册表（服务端不可达时使用；含演示账号） */
const LOCAL_REGISTERED = new Set<string>([
  '855979935561', // 演示手机号 +855 097 993 5561
]);

let gatewayBase: string | null | undefined;

/** 规范化：只留数字，去掉 +855 / 0 前缀的差异 → 855979935561 */
export function normalizePhone(input: string): string {
  let digits = String(input ?? '').replace(/\D+/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('855')) {
    // 兼容「+855 097 993 5561」这种把本地前导 0 也写进来的写法：
    // 855 + 10 位且以 0 开头 → 去掉那个 0，得到 855 + 9 位
    const rest = digits.slice(3);
    if (rest.startsWith('0') && rest.length === 10) {
      digits = `855${rest.slice(1)}`;
    }
  } else if (digits.startsWith('0')) {
    digits = `855${digits.slice(1)}`;
  } else if (digits.length === 9) {
    digits = `855${digits}`;
  }
  return digits;
}

/** 本地注册表里是否有这个号码 */
export function isLocallyRegistered(input: string): boolean {
  return LOCAL_REGISTERED.has(normalizePhone(input));
}

/** 注册成功后写入本地注册表（同端后续校验立即可见） */
export function rememberRegisteredPhone(input: string): void {
  LOCAL_REGISTERED.add(normalizePhone(input));
}

/**
 * 查询手机号是否已注册。
 * - 网关可达：以服务端结果为准（查 users 表）
 * - 网关不可达：用本地注册表兜底
 */
export async function checkPhoneRegistered(input: string): Promise<PhoneCheckResult> {
  const phone = normalizePhone(input);
  const local = isLocallyRegistered(phone);
  const fallback: PhoneCheckResult = {
    registered: local,
    status: null,
    message: local
      ? '手机号已注册本银行使用 / This phone number is registered'
      : PHONE_NOT_REGISTERED_MESSAGE,
    source: 'local',
  };

  const candidates = gatewayBase ? [gatewayBase] : [DEV_GATEWAY, '/api'];
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/wallet/auth/phone-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
        signal: AbortSignal.timeout(4000),
      });

      // 服务端明确回答「未注册」→ 以服务端为准，直接拦截
      if (res.status === 404) {
        gatewayBase = base;
        return {
          registered: false,
          status: null,
          message: PHONE_NOT_REGISTERED_MESSAGE,
          source: 'server',
        };
      }
      if (!res.ok) continue;

      gatewayBase = base;
      const data = (await res.json()) as {
        registered?: boolean;
        status?: string | null;
        message?: string;
      };
      return {
        registered: Boolean(data.registered),
        status: data.status ?? null,
        message: data.message || PHONE_NOT_REGISTERED_MESSAGE,
        source: 'server',
      };
    } catch {
      // 超时 / 网络失败 → 尝试下一个候选；全部失败则走本地兜底
    }
  }
  return fallback;
}

/** 结果是否为「未注册」（前端据此拦截并显示提示） */
export function isNotRegistered(result: PhoneCheckResult): boolean {
  return !result.registered;
}
