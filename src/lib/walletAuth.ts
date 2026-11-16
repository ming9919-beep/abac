/**
 * 注册（开户）API 封装。
 *
 * 对应服务端 `POST /api/wallet/auth/register`，服务端强制：
 *   - 手机号格式正确
 *   - 姓名 ≥ 2 字
 *   - 密码 ≥ 8 位且至少两类字符（字母/数字/符号），纯数字拒绝
 *   - **证件号必填**（开户必须完成身份证信息），每人不同，库里只存密文+哈希+后4位
 *
 * 网关地址与 phoneRegistry 一致：优先 VITE_WALLET_GATEWAY_URL，其次本地 5200，最后同源 /api。
 * 服务端不可达时用本地兜底（演示/离线），保证流程可继续。
 */

const DEV_GATEWAY: string =
  (import.meta.env.VITE_WALLET_GATEWAY_URL as string | undefined) ||
  'http://localhost:5200/api';

export interface RegisterAccountInput {
  phone: string;
  password: string;
  fullName: string;
  /** 证件号 —— 必填 */
  nationalIdNo: string;
  dateOfBirth?: string;
  currencies?: string[];
}

export interface RegisterAccountResult {
  ok: boolean;
  /** 'server' = 服务端创建；'local' = 离线兜底；'error' = 服务端拒绝 */
  source: 'server' | 'local' | 'error';
  message: string;
  token?: string;
  userNo?: string;
}

/** 密码强度：与服务端 isStrongPassword 规则保持一致（前端先拦，服务端为准） */
export function isStrongPassword(password: string): boolean {
  if (typeof password !== 'string') return false;
  if (password.length < 8 || password.length > 128) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  return classes >= 2;
}

/** 证件号规范化：去空格/横线/点，统一大写（与服务端 normalizeNationalId 一致） */
export function normalizeNationalId(input: string): string {
  return String(input ?? '')
    .replace(/[\s\-.]/g, '')
    .toUpperCase();
}

/** 证件号是否可提交：4-32 位（服务端同规则） */
export function isValidNationalId(input: string): boolean {
  const n = normalizeNationalId(input);
  return n.length >= 4 && n.length <= 32;
}

function gatewayCandidates(): string[] {
  const saved = (() => {
    try {
      return sessionStorage.getItem('aba.gateway');
    } catch {
      return null;
    }
  })();
  const list = saved ? [saved, DEV_GATEWAY, '/api'] : [DEV_GATEWAY, '/api'];
  return [...new Set(list)];
}

function rememberGateway(base: string): void {
  try {
    sessionStorage.setItem('aba.gateway', base);
  } catch {
    /* storage unavailable */
  }
}

/**
 * 提交开户注册。
 * - 服务端可达：以服务端结果为准（成功拿 token，失败展示服务端文案）
 * - 服务端不可达（离线演示）：本地登记手机号，流程继续
 */
export async function registerAccount(
  input: RegisterAccountInput,
): Promise<RegisterAccountResult> {
  const payload = {
    phone: input.phone,
    password: input.password,
    fullName: input.fullName.trim(),
    nationalIdNo: normalizeNationalId(input.nationalIdNo),
    ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
    currencies: input.currencies?.length ? input.currencies : ['USD', 'KHR'],
  };

  let networkFailed = false;
  for (const base of gatewayCandidates()) {
    try {
      const res = await fetch(`${base}/wallet/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(6000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        token?: string;
        userNo?: string;
        message?: string;
        details?: { message?: string };
      };

      if (res.ok) {
        rememberGateway(base);
        return {
          ok: true,
          source: 'server',
          message: data.message || '注册成功',
          token: data.token,
          userNo: data.userNo,
        };
      }
      // 服务端明确拒绝（密码弱 / 证件号重复 / 手机号已注册…）→ 直接返回错误文案
      rememberGateway(base);
      return {
        ok: false,
        source: 'error',
        message:
          data.message || data.details?.message || `注册失败（HTTP ${res.status}）`,
      };
    } catch {
      networkFailed = true; // 超时 / 网络失败 → 试下一个候选
    }
  }

  if (networkFailed) {
    // 离线兜底：本地登记，登录前置校验（phoneRegistry）即可放行
    const { rememberRegisteredPhone } = await import('./phoneRegistry');
    rememberRegisteredPhone(payload.phone);
    return {
      ok: true,
      source: 'local',
      message: '离线注册成功（服务端不可达，已本地登记）',
    };
  }
  return { ok: false, source: 'error', message: '注册失败' };
}
