import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import { ChevronLeft, Delete, ShieldAlert } from 'lucide-react';
import {
  PHONE_NOT_REGISTERED_I18N,
  checkPhoneRegistered,
  normalizePhone,
} from '@/lib/phoneRegistry';

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

/* ABA mini wordmark for the header (smaller) */
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

const KEYS: { d: string; sub?: string }[] = [
  { d: '1' },
  { d: '2', sub: 'ABC' },
  { d: '3', sub: 'DEF' },
  { d: '4', sub: 'GHI' },
  { d: '5', sub: 'JKL' },
  { d: '6', sub: 'MNO' },
  { d: '7', sub: 'PQRS' },
  { d: '8', sub: 'TUV' },
  { d: '9', sub: 'WXYZ' },
  { d: '+*#' },
  { d: '0' },
  { d: '⌫' },
];

const PhoneRegister: React.FC = () => {
  const [, setLocation] = useLocation();
  const [phone, setPhone] = useState('');
  const [checking, setChecking] = useState(false);
  // 未注册时的拦截提示（三语）
  const [blocked, setBlocked] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);

  const press = (k: string) => {
    setBlocked(false);
    if (k === '⌫') {
      setPhone((p) => p.slice(0, -1));
      return;
    }
    if (k === '+*#') {
      setPhone((p) => (p.length < 12 ? p + '+' : p));
      return;
    }
    setPhone((p) => (p.length < 12 ? p + k : p));
  };

  const canContinue = phone.replace(/\D/g, '').length >= 6;

  /**
   * 登录前置校验：数据库里没有这个手机号 = 没注册 = 不允许进入下一步。
   * 服务端可达时以服务端为准，否则用本地注册表兜底（见 src/lib/phoneRegistry.ts）。
   */
  const continueLogin = async () => {
    if (!canContinue || checking) return;
    setChecking(true);
    setBlocked(false);
    setServerMessage(null);
    try {
      const result = await checkPhoneRegistered(phone);
      if (!result.registered) {
        setServerMessage(result.message);
        setBlocked(true);
        return;
      }
      try {
        sessionStorage.setItem('aba.pendingPhone', normalizePhone(phone));
      } catch { /* storage unavailable */ }
      setLocation('/auth/otp');
    } finally {
      setChecking(false);
    }
  };

  return (
    <AbaShell>
      {/* Header */}
      <div className="relative z-10 flex items-center gap-3 px-3 pt-3 pb-3">
        <button
          onClick={() => setLocation('/auth/start')}
          className="w-10 h-10 flex items-center justify-center rounded-full active:bg-white/10 transition-colors"
          aria-label="Back"
        >
          <ChevronLeft className="w-7 h-7 text-white" strokeWidth={2.2} />
        </button>
        <div className="flex items-baseline gap-2">
          <AbaMiniMark />
          <span className="text-white font-bold text-[20px]">បើកដំណើរការ</span>
        </div>
      </div>

      {/* Phone inputs */}
      <div className="relative z-10 px-6 pt-10 max-w-[460px] w-full mx-auto">
        <div className="flex items-end gap-5">
          {/* Country code */}
          <div className="flex flex-col gap-1.5 w-[28%]">
            <label className="text-white/55 text-[13px]">លេខកូដប្រទេស</label>
            <div
              className="pb-2 text-white text-[22px] font-semibold border-b-2 border-white/25"
            >
              +855
            </div>
          </div>
          {/* Phone number */}
          <div className="flex flex-col gap-1.5 flex-1">
            <label className="text-[#3FD6E0] text-[13px] font-medium">លេខទូរស័ព្ទ</label>
            <div className="pb-2 border-b-2 border-[#3FD6E0] min-h-[34px] flex items-center">
              <span
                className={`text-[22px] font-semibold ${phone ? 'text-white' : 'text-white/35'}`}
                style={{ letterSpacing: '0.5px' }}
              >
                {phone || '012 345 678'}
              </span>
              {phone && (
                <span className="ml-1 w-[2px] h-6 bg-[#3FD6E0] inline-block animate-pulse" />
              )}
            </div>
          </div>
        </div>

        {/* 未注册手机号的拦截提示 */}
        {blocked && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-5 rounded-2xl px-4 py-3.5 flex gap-3 items-start"
            style={{
              background: 'rgba(233,75,60,0.16)',
              border: '1px solid rgba(233,75,60,0.55)',
            }}
            role="alert"
          >
            <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" style={{ color: '#FF8B7D' }} />
            <div className="flex flex-col gap-1">
              <span className="text-[#FFD9D4] text-[15px] font-semibold leading-snug">
                {PHONE_NOT_REGISTERED_I18N.km}
              </span>
              <span className="text-[#FFC9C2] text-[13px] leading-snug">
                {serverMessage || PHONE_NOT_REGISTERED_I18N.en}
              </span>
              <span className="text-white/70 text-[13px] leading-snug">
                {PHONE_NOT_REGISTERED_I18N.zh}
              </span>
              <span className="text-white/45 text-[12px] mt-1">
                សូមចុះឈ្មោះជាមុនសិន · 请先注册后再登录
              </span>
            </div>
          </motion.div>
        )}

        {/* Continue button */}
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={continueLogin}
          disabled={!canContinue || checking}
          className="w-full h-[58px] rounded-2xl text-white text-[19px] font-bold tracking-wide mt-12 transition-all disabled:opacity-40 disabled:cursor-not-allowed active:brightness-110"
          style={{
            background: canContinue
              ? 'linear-gradient(180deg, #F05A4A 0%, #E94B3C 55%, #D83E30 100%)'
              : 'rgba(233,75,60,0.35)',
            boxShadow: canContinue ? '0 10px 26px rgba(233,75,60,0.35), inset 0 1px 0 rgba(255,255,255,0.18)' : 'none',
          }}
        >
          {checking ? 'កំពុងពិនិត្យ...' : 'បន្ទាប់'}
        </motion.button>
      </div>

      <div className="flex-1" />

      {/* Numeric keypad */}
      <div
        className="relative z-10 w-full pt-4 pb-6"
        style={{
          background: 'linear-gradient(180deg, rgba(20,40,48,0) 0%, rgba(180,188,192,0.18) 30%, rgba(200,206,210,0.28) 100%)',
        }}
      >
        <div className="grid grid-cols-3 gap-x-3 gap-y-2.5 px-5 max-w-[420px] mx-auto">
          {KEYS.map((k) => {
            const isBack = k.d === '⌫';
            const isStar = k.d === '+*#';
            return (
              <button
                key={k.d}
                onClick={() => press(k.d)}
                className="h-[58px] rounded-xl flex flex-col items-center justify-center active:scale-95 transition-transform"
                style={{
                  background: isBack || isStar ? 'transparent' : '#ffffff',
                  boxShadow: isBack || isStar ? 'none' : '0 1px 2px rgba(0,0,0,0.18), inset 0 -1px 0 rgba(0,0,0,0.08)',
                }}
              >
                {isBack ? (
                  <Delete className="w-6 h-6 text-white/85" strokeWidth={1.8} />
                ) : isStar ? (
                  <span className="text-white/90 text-[18px] font-medium">+*#</span>
                ) : (
                  <>
                    <span className="text-[#1a1a1a] text-[26px] font-medium leading-none">{k.d}</span>
                    {k.sub && (
                      <span className="text-[#888] text-[9px] font-semibold tracking-widest mt-0.5">
                        {k.sub}
                      </span>
                    )}
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </AbaShell>
  );
};

export default PhoneRegister;
