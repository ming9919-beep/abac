import React, { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import { ChevronLeft } from 'lucide-react';

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

const OTP_LEN = 6;

const OtpVerify: React.FC = () => {
  const [, setLocation] = useLocation();
  const [otp, setOtp] = useState<string[]>(Array(OTP_LEN).fill(''));
  const [filled, setFilled] = useState(false);

  // Simulate auto-fill: generate a random 6-digit code and type it in one digit at a time
  useEffect(() => {
    const code = Array.from({ length: OTP_LEN }, () =>
      Math.floor(Math.random() * 10).toString(),
    );
    let i = 0;
    const tick = () => {
      if (i >= OTP_LEN) {
        // all filled — briefly hold for a short moment so the user sees the complete code, then proceed
        setTimeout(() => setFilled(true), 350);
        return;
      }
      setOtp((prev) => {
        const next = [...prev];
        next[i] = code[i];
        return next;
      });
      i += 1;
      setTimeout(tick, 220);
    };
    const t = setTimeout(tick, 600);
    return () => clearTimeout(t);
  }, []);

  // After the code is fully filled, navigate to the home page
  useEffect(() => {
    if (!filled) return;
    const t = setTimeout(() => setLocation('/home'), 900);
    return () => clearTimeout(t);
  }, [filled, setLocation]);

  const joined = otp.join('');

  return (
    <AbaShell>
      {/* Header */}
      <div className="relative z-10 flex items-center gap-3 px-3 pt-3 pb-3">
        <button
          onClick={() => setLocation('/auth/register')}
          className="w-10 h-10 flex items-center justify-center rounded-full active:bg-white/10 transition-colors"
          aria-label="Back"
        >
          <ChevronLeft className="w-7 h-7 text-white" strokeWidth={2.2} />
        </button>
        <div className="flex items-baseline gap-2">
          <AbaMiniMark />
          <span className="text-white font-bold text-[20px]">បញ្ជាក់លេខសម្ងាត់</span>
        </div>
      </div>

      {/* Phone display */}
      <div className="relative z-10 px-6 pt-10 max-w-[460px] w-full mx-auto">
        <p className="text-white/55 text-[14px] text-center">
          កូដអាចបញ្ជាក់ត្រូវបានផ្ញើទៅលេខ
        </p>
        <p className="text-white font-semibold text-[18px] text-center mt-1">
          {(() => {
            try {
              const raw = sessionStorage.getItem('aba.pendingPhone');
              if (!raw) return '+855 12 345 678';
              const d = raw.replace(/\D/g, '');
              const local = d.startsWith('855') ? d.slice(3) : d;
              return `+855 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
            } catch {
              return '+855 12 345 678';
            }
          })()}
        </p>
      </div>

      {/* OTP boxes */}
      <div className="relative z-10 flex justify-center gap-3 mt-10 px-6">
        {otp.map((digit, i) => {
          const isCurrent = !filled && digit === '';
          return (
            <motion.div
              key={i}
              initial={{ scale: 1 }}
              animate={{ scale: digit ? 1.06 : 1 }}
              transition={{ duration: 0.15 }}
              className="w-11 h-14 rounded-xl flex items-center justify-center text-white text-[26px] font-bold"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: `1px solid ${
                  isCurrent ? '#3FD6E0' : 'rgba(255,255,255,0.2)'
                }`,
                boxShadow: isCurrent ? '0 0 0 2px rgba(63,214,224,0.25)' : 'none',
              }}
            >
              {digit}
              {isCurrent && (
                <span className="w-[2px] h-6 bg-[#3FD6E0] animate-pulse" />
              )}
            </motion.div>
          );
        })}
      </div>

      {/* status */}
      <div className="relative z-10 mt-7 text-center px-6">
        {filled ? (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-[#3FD6E0] text-[14px] font-medium"
          >
            កំពុងផ្ទៀងផ្ទាត់... · Verifying
          </motion.p>
        ) : (
          <p className="text-white/45 text-[13px]">
          កំពុងផ្ទាំងកូដដោយស្វ័យប្រវត្តិ...
        </p>
        )}
      </div>

      {/* Resend */}
      <div className="relative z-10 mt-6 text-center">
        <button
          className="text-white/55 text-[13px] underline-offset-4 hover:text-white/80 transition-colors"
          onClick={() => {
            // re-run auto-fill again
            setFilled(false);
            setOtp(Array(OTP_LEN).fill(''));
            const code = Array.from({ length: OTP_LEN }, () =>
              Math.floor(Math.random() * 10).toString(),
            );
            let i = 0;
            const tick = () => {
              if (i >= OTP_LEN) {
                setTimeout(() => setFilled(true), 350);
                return;
              }
              setOtp((prev) => {
                const next = [...prev];
                next[i] = code[i];
                return next;
              });
              i += 1;
              setTimeout(tick, 220);
            };
            setTimeout(tick, 400);
          }}
        >
          មិនបានទទួលកូដ? បញ្ជូនម្តងទៀត
        </button>
      </div>

      <div className="flex-1" />

      {/* bottom hint: the auto-filled code (for demo transparency) */}
      <p className="relative z-10 text-center pb-10 text-white/30 text-[12px]">
        Demo code: {joined || '------'}
      </p>
    </AbaShell>
  );
};

export default OtpVerify;
