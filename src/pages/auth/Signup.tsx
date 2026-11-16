import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import { ChevronLeft, ShieldCheck, AlertCircle, CheckCircle2 } from 'lucide-react';
import { normalizePhone } from '@/lib/phoneRegistry';
import {
  clearSignupPhone,
  getBackFor,
  getSignupPhone,
  setBackFor,
} from '@/lib/authFlow';
import {
  isStrongPassword,
  isValidNationalId,
  normalizeNationalId,
  registerAccount,
} from '@/lib/walletAuth';

const AbaShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="relative min-h-screen w-full overflow-hidden flex flex-col"
    style={{
      background:
        'radial-gradient(120% 80% at 50% 0%, #123a44 0%, #0c2530 45%, #07131b 100%)',
      fontFamily: '"Noto Sans Khmer", "DM Sans", system-ui, sans-serif',
    }}
  >
    <div
      className="pointer-events-none absolute inset-0"
      style={{ background: 'radial-gradient(80% 60% at 50% 100%, rgba(0,0,0,.45), transparent 70%)' }}
    />
    {children}
  </div>
);

const AbaMiniMark: React.FC = () => (
  <span className="flex items-baseline gap-0.5">
    <span className="text-white font-extrabold tracking-tight text-[22px]">ABA</span>
    <span
      aria-hidden
      className="inline-block"
      style={{ width: 7, height: 9, background: '#E94B3C', borderRadius: 1.5 }}
    />
  </span>
);

type FieldKey = 'phone' | 'fullName' | 'nationalIdNo' | 'password' | 'confirm';

const FIELDS: { key: FieldKey; label: string; hint: string; type?: string; placeholder: string }[] = [
  { key: 'phone', label: 'លេខទូរស័ព្ទ · 手机号', hint: '手机号', type: 'tel', placeholder: '012 345 678' },
  { key: 'fullName', label: 'ឈ្មោះពេញ · 姓名', hint: '姓名', placeholder: 'CHHENG BONNY' },
  {
    key: 'nationalIdNo',
    label: 'លេខអត្តសញ្ញាណប័ណ្ណ · 身份证号',
    hint: '证件号（必填）',
    placeholder: '49399 1234567',
  },
  { key: 'password', label: 'ពាក្យសម្ងាត់ · 密码', hint: '密码', type: 'password', placeholder: '至少 8 位，含字母+数字' },
  { key: 'confirm', label: 'បញ្ជាក់ពាក្យសម្ងាត់ · 确认密码', hint: '确认密码', type: 'password', placeholder: '再输入一次' },
];

const Signup: React.FC = () => {
  const [, setLocation] = useLocation();
  // 从登录页未注册拦截带过来的号码 → 预填，用户不用再打一遍
  const [values, setValues] = useState<Record<FieldKey, string>>(() => ({
    phone: getSignupPhone(),
    fullName: '',
    nationalIdNo: '',
    password: '',
    confirm: '',
  }));
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const set = (k: FieldKey, v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    setServerError(null);
  };
  const blur = (k: FieldKey) => setTouched((p) => ({ ...p, [k]: true }));

  /** 单字段校验（与服务端规则一致，服务端仍是最终裁判） */
  const errorOf = (k: FieldKey): string | null => {
    if (!touched[k]) return null;
    const v = values[k];
    switch (k) {
      case 'phone':
        return normalizePhone(v).length >= 8 ? null : '手机号格式不正确';
      case 'fullName':
        return v.trim().length >= 2 ? null : '请填写姓名（至少 2 个字符）';
      case 'nationalIdNo':
        // 证件号必填 —— 开户必须完成身份证信息
        if (!v.trim()) return '请填写证件号码（开户必须完成身份证信息）';
        return isValidNationalId(v) ? null : '证件号长度需为 4-32 位';
      case 'password':
        return isStrongPassword(v)
          ? null
          : '密码至少 8 位，且需包含字母与数字（不能是纯数字）';
      case 'confirm':
        return v === values.password ? null : '两次密码不一致';
      default:
        return null;
    }
  };

  const allValid =
    normalizePhone(values.phone).length >= 8 &&
    values.fullName.trim().length >= 2 &&
    isValidNationalId(values.nationalIdNo) &&
    isStrongPassword(values.password) &&
    values.confirm === values.password;

  const submit = async () => {
    setTouched({
      phone: true, fullName: true, nationalIdNo: true, password: true, confirm: true,
    });
    if (!allValid || submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await registerAccount({
        phone: values.phone,
        password: values.password,
        fullName: values.fullName,
        nationalIdNo: values.nationalIdNo,
      });
      if (!result.ok) {
        setServerError(result.message);
        return;
      }
      try {
        sessionStorage.setItem('aba.pendingPhone', normalizePhone(values.phone));
      } catch { /* storage unavailable */ }
      clearSignupPhone();
      // 注册已成功、账号已创建 → OTP 的返回键回主页，
      // 而不是回开户表单（回去只会撞上「该手机号已注册」的死路）。
      setBackFor('/auth/otp', '/home');
      // 注册完成 → 进入 OTP 验证，再进首页
      setLocation('/auth/otp');
    } finally {
      setSubmitting(false);
    }
  };

  const idNorm = normalizeNationalId(values.nationalIdNo);

  return (
    <AbaShell>
      {/* Header */}
      <div className="relative z-10 flex items-center gap-3 px-3 pt-3 pb-3">
        <button
          onClick={() => setLocation(getBackFor('/auth/signup', '/auth/start'))}
          className="w-10 h-10 flex items-center justify-center rounded-full active:bg-white/10 transition-colors"
          aria-label="Back"
        >
          <ChevronLeft className="w-7 h-7 text-white" strokeWidth={2.2} />
        </button>
        <div className="flex items-baseline gap-2">
          <AbaMiniMark />
          <span className="text-white font-bold text-[20px]">បើកគណនីរហ័ស · 快速开户</span>
        </div>
      </div>

      {/* Scrollable form — 全屏铺满，无手机壳限制 */}
      <div className="relative z-10 flex-1 overflow-y-auto px-6 pb-8 max-w-[520px] w-full mx-auto hide-scrollbar">
        <p className="text-white/60 text-[13px] leading-relaxed mb-5">
          បំពេញព័ត៌មានអត្តសញ្ញាណ ដើម្បីបើកគណនី · 填写身份信息完成开户（带 * 为必填）
        </p>

        {/* 证件号必填提示 */}
        <div
          className="mb-5 rounded-2xl px-4 py-3 flex gap-3 items-start"
          style={{
            background: 'rgba(63,214,224,0.10)',
            border: '1px solid rgba(63,214,224,0.45)',
          }}
          role="note"
        >
          <ShieldCheck className="w-5 h-5 shrink-0 mt-0.5 text-[#3FD6E0]" strokeWidth={2.2} />
          <p className="text-white/85 text-[13px] leading-snug">
            开户必须完成身份证信息；证件号每人不同，仅加密存储（密文 + 哈希 + 后 4 位），业务表不存明文。
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {FIELDS.map((f) => {
            const err = errorOf(f.key);
            const filled = values[f.key].length > 0;
            const isId = f.key === 'nationalIdNo';
            return (
              <div key={f.key} className="flex flex-col gap-1.5">
                <label
                  htmlFor={`signup-${f.key}`}
                  className="text-white/60 text-[13px] font-medium"
                >
                  {f.label}
                  {isId && <span className="text-[#FF8B7D] ml-1">*</span>}
                </label>
                <input
                  id={`signup-${f.key}`}
                  type={f.type ?? 'text'}
                  inputMode={f.key === 'phone' || isId ? 'numeric' : undefined}
                  autoComplete={
                    f.key === 'password' || f.key === 'confirm'
                      ? 'new-password'
                      : f.key === 'phone'
                        ? 'tel'
                        : 'off'
                  }
                  value={values[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                  onBlur={() => blur(f.key)}
                  placeholder={f.placeholder}
                  aria-invalid={Boolean(err)}
                  className="w-full h-[52px] rounded-xl px-4 text-white text-[16px] font-medium outline-none transition-all"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    border: `1.5px solid ${err ? '#FF8B7D' : filled ? 'rgba(63,214,224,0.6)' : 'rgba(255,255,255,0.18)'}`,
                  }}
                />
                {isId && idNorm.length > 0 && !err && (
                  <span className="text-[#3FD6E0] text-[12px]">
                    已识别证件号 …{idNorm.slice(-4)}（只保留后 4 位用于展示）
                  </span>
                )}
                {err && (
                  <span className="text-[#FF8B7D] text-[12.5px] leading-snug flex items-start gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    {err}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* 服务端错误 */}
        {serverError && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            role="alert"
            className="mt-4 rounded-2xl px-4 py-3 flex gap-3 items-start"
            style={{
              background: 'rgba(233,75,60,0.16)',
              border: '1px solid rgba(233,75,60,0.55)',
            }}
          >
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-[#FF8B7D]" />
            <span className="text-[#FFD9D4] text-[14px] leading-snug">{serverError}</span>
          </motion.div>
        )}

        {/* 提交 */}
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={submit}
          disabled={!allValid || submitting}
          className="w-full h-[56px] rounded-2xl text-white text-[18px] font-bold tracking-wide mt-7 transition-all disabled:opacity-40 disabled:cursor-not-allowed active:brightness-110 flex items-center justify-center gap-2"
          style={{
            background: allValid
              ? 'linear-gradient(180deg, #F05A4A 0%, #E94B3C 55%, #D83E30 100%)'
              : 'rgba(233,75,60,0.35)',
            boxShadow: allValid
              ? '0 10px 26px rgba(233,75,60,0.35), inset 0 1px 0 rgba(255,255,255,0.18)'
              : 'none',
          }}
        >
          {submitting ? (
            'កំពុងដាក់ពាក្យ...'
          ) : (
            <>
              <CheckCircle2 className="w-5 h-5" strokeWidth={2.2} />
              បើកគណនី · 完成开户
            </>
          )}
        </motion.button>

        <p className="text-white/45 text-[12.5px] text-center mt-4 leading-relaxed">
          已有账号？
          <button
            className="text-[#3FD6E0] underline underline-offset-4 ml-1"
            onClick={() => {
              // 记住来源，登录页的返回键能回到开户页
              setBackFor('/auth/register', '/auth/signup');
              setLocation('/auth/register');
            }}
          >
            返回登录
          </button>
        </p>
      </div>
    </AbaShell>
  );
};

export default Signup;
