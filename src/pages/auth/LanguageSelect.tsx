import React from 'react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';

/* ─── Shared ABA Mobile launch background (deep teal → navy gradient) ──────── */
const AbaShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="relative min-h-screen w-full overflow-hidden flex flex-col items-center"
    style={{
      background:
        'radial-gradient(120% 80% at 50% 0%, #123a44 0%, #0c2530 45%, #07131b 100%)',
      fontFamily: '"Noto Sans Khmer", "DM Sans", system-ui, sans-serif',
    }}
  >
    {/* subtle vignette */}
    <div
      className="pointer-events-none absolute inset-0"
      style={{ background: 'radial-gradient(80% 60% at 50% 100%, rgba(0,0,0,.45), transparent 70%)' }}
    />
    {children}
  </div>
);

/* ABA Mobile wordmark — white "ABA" with the signature red apostrophe */
const AbaWordmark: React.FC<{ className?: string }> = ({ className }) => (
  <div className={`flex items-baseline gap-1 select-none ${className ?? ''}`}>
    <span className="text-white font-extrabold tracking-tight" style={{ fontSize: '2.6rem', lineHeight: 1 }}>
      ABA
    </span>
    <span
      aria-hidden
      className="inline-block w-2 self-start"
      style={{ height: '1.05rem', marginTop: '.45rem', background: '#E94B3C', borderRadius: 2 }}
    />
    <span className="text-white font-semibold tracking-tight" style={{ fontSize: '2.6rem', lineHeight: 1 }}>
      Mobile
    </span>
  </div>
);

type Lang = 'km' | 'en' | 'zh';

const LANGS: { code: Lang; label: string; native: string }[] = [
  { code: 'km', label: 'ភាសាខ្មែរ', native: 'Khmer' },
  { code: 'en', label: 'ENGLISH', native: 'English' },
  { code: 'zh', label: '中文', native: '中文' },
];

const LanguageSelect: React.FC = () => {
  const [, setLocation] = useLocation();

  const choose = (code: Lang) => {
    try { localStorage.setItem('aba.lang', code); } catch { /* ignore */ }
    setLocation('/auth/start');
  };

  return (
    <AbaShell>
      {/* top spacer */}
      <div className="flex-1 min-h-[28vh]" />

      {/* Brand */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="flex flex-col items-center"
      >
        <AbaWordmark />
        <p className="mt-3 text-white/55 text-[13px] tracking-wide">
          Choose your language · ជ្រើសរើសភាសា
        </p>
      </motion.div>

      <div className="flex-1 min-h-[10vh]" />

      {/* Language buttons */}
      <div className="w-full px-7 pb-14 flex flex-col gap-4 max-w-[440px]">
        {LANGS.map((l, i) => (
          <motion.button
            key={l.code}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.15 + i * 0.08, ease: 'easeOut' }}
            onClick={() => choose(l.code)}
            whileTap={{ scale: 0.97 }}
            className="w-full h-[60px] rounded-2xl text-white text-[19px] font-semibold tracking-wide active:brightness-110 transition-all"
            style={{
              background: 'linear-gradient(180deg, #F05A4A 0%, #E94B3C 55%, #D83E30 100%)',
              boxShadow: '0 8px 22px rgba(233,75,60,0.35), inset 0 1px 0 rgba(255,255,255,0.18)',
            }}
          >
            {l.label}
          </motion.button>
        ))}
      </div>
    </AbaShell>
  );
};

export default LanguageSelect;
