import React from 'react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import { ChevronLeft, Smartphone, Wallet, ChevronRight } from 'lucide-react';

/* Reuse the shared shell + wordmark defined in LanguageSelect */
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

const AbaWordmark: React.FC = () => (
  <div className="flex items-baseline gap-1 select-none">
    <span className="text-white font-extrabold tracking-tight" style={{ fontSize: '2.4rem', lineHeight: 1 }}>
      ABA
    </span>
    <span
      aria-hidden
      className="inline-block w-2 self-start"
      style={{ height: '0.95rem', marginTop: '.42rem', background: '#E94B3C', borderRadius: 2 }}
    />
    <span className="text-white font-semibold tracking-tight" style={{ fontSize: '2.4rem', lineHeight: 1 }}>
      Mobile
    </span>
  </div>
);

const AuthStart: React.FC = () => {
  const [, setLocation] = useLocation();

  return (
    <AbaShell>
      {/* Top bar with back */}
      <div className="relative z-10 flex items-center px-4 pt-3 pb-2">
        <button
          onClick={() => setLocation('/auth/language')}
          className="w-10 h-10 flex items-center justify-center rounded-full active:bg-white/10 transition-colors"
          aria-label="Back"
        >
          <ChevronLeft className="w-7 h-7 text-white" strokeWidth={2.2} />
        </button>
      </div>

      {/* Brand */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center mt-4 mb-10"
      >
        <AbaWordmark />
      </motion.div>

      {/* Cards */}
      <div className="relative z-10 flex flex-col gap-5 px-6 max-w-[460px] w-full mx-auto">
        {/* Primary — register with phone */}
        <motion.button
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.1 }}
          whileTap={{ scale: 0.985 }}
          onClick={() => setLocation('/auth/register')}
          className="w-full text-left rounded-3xl px-5 py-5 flex items-center gap-4 active:brightness-110 transition-all"
          style={{
            background: 'linear-gradient(180deg, #F05A4A 0%, #E94B3C 55%, #D83E30 100%)',
            boxShadow: '0 10px 26px rgba(233,75,60,0.32), inset 0 1px 0 rgba(255,255,255,0.18)',
          }}
        >
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.18)' }}
          >
            <Smartphone className="w-6 h-6 text-white" strokeWidth={1.9} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-[18px] leading-snug">
              បើកដំណើរការជាមួយ ABA Mobile
            </p>
            <p className="text-white/75 text-[13px] mt-0.5 leading-snug">
              សម្រាប់អ្នកមានគណនី ABA ស្រាប់
            </p>
          </div>
          <ChevronRight className="w-6 h-6 text-white/90 flex-shrink-0" strokeWidth={2.2} />
        </motion.button>

        {/* Divider */}
        <div className="flex items-center gap-3 px-1">
          <div className="flex-1 h-px bg-white/15" />
          <span className="text-white/55 text-[13px] whitespace-nowrap">មិនទាន់មានគណនី ABA?</span>
          <div className="flex-1 h-px bg-white/15" />
        </div>

        {/* Secondary — open bank account */}
        <motion.button
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.2 }}
          whileTap={{ scale: 0.985 }}
          onClick={() => setLocation('/auth/signup')}
          className="w-full text-left rounded-3xl px-5 py-5 flex items-center gap-4 transition-all"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.16)',
            backdropFilter: 'blur(6px)',
          }}
        >
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.10)' }}
          >
            <Wallet className="w-6 h-6 text-white" strokeWidth={1.9} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-[18px] leading-snug">
              បើកគណនីរហ័ស
            </p>
            <p className="text-white/60 text-[13px] mt-0.5 leading-snug">
              បើកគណនី ABA ដំបូងរបស់អ្នកក្នុងរយៈពេលពីរបីនាទី
            </p>
          </div>
          <ChevronRight className="w-6 h-6 text-white/60 flex-shrink-0" strokeWidth={2.2} />
        </motion.button>
      </div>

      <div className="flex-1" />
    </AbaShell>
  );
};

export default AuthStart;
