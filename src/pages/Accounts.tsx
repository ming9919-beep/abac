import React from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, MoreHorizontal, Wallet, ChevronDown, Plus, BarChart3 } from 'lucide-react';
import { useLocation } from 'wouter';
import { accounts } from '../data/accounts';
import { getBalance } from '../lib/balanceStore';
import type { Account } from '../data/accounts';

/* ─── Purple donut ring (matches ABA official screenshot) ───────────────────── */
const RingChart = () => {
  const r = 54;
  const cx = 72;
  const cy = 72;
  const circumference = 2 * Math.PI * r;

  // Segments (clockwise from top): blue ~12%, violet ~6%, purple ~76%, gap ~6%
  const blue = circumference * 0.12;
  const violet = circumference * 0.06;
  const purple = circumference * 0.76;
  const gap = circumference - blue - violet - purple;

  // Start at top (-90deg = 25% of circumference offset)
  const startOffset = circumference * 0.25;

  return (
    <svg width="144" height="144" viewBox="0 0 144 144">
      <defs>
        {/* Purple/magenta main arc */}
        <linearGradient id="purpleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#D946EF" />
          <stop offset="50%" stopColor="#C026D3" />
          <stop offset="100%" stopColor="#A21CAF" />
        </linearGradient>
        {/* Blue segment */}
        <linearGradient id="blueGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
        {/* Violet segment */}
        <linearGradient id="violetGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#8B5CF6" />
          <stop offset="100%" stopColor="#7C3AED" />
        </linearGradient>
        <filter id="ringGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Dark track */}
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke="rgba(255,255,255,0.12)"
        strokeWidth="13"
      />

      {/* Purple main arc (largest) */}
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke="url(#purpleGrad)"
        strokeWidth="13"
        strokeDasharray={`${purple} ${circumference - purple}`}
        strokeDashoffset={startOffset - blue - violet}
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.8s ease' }}
      />

      {/* Blue segment at top */}
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke="url(#blueGrad)"
        strokeWidth="13"
        strokeDasharray={`${blue} ${circumference - blue}`}
        strokeDashoffset={startOffset}
        strokeLinecap="round"
        filter="url(#ringGlow)"
      />

      {/* Violet segment after blue */}
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke="url(#violetGrad)"
        strokeWidth="13"
        strokeDasharray={`${violet} ${circumference - violet}`}
        strokeDashoffset={startOffset - blue}
        strokeLinecap="round"
      />

      {/* Inner hole: transparent (shows background) with subtle inner ring */}
      <circle cx={cx} cy={cy} r="40" fill="rgba(15,10,25,0.35)" />
      <circle cx={cx} cy={cy} r="40" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />

      {/* Center wallet icon (white) */}
      <g transform="translate(58, 50)" stroke="#FFFFFF" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <rect x="0" y="4" width="20" height="13" rx="2.5" fill="rgba(255,255,255,0.06)" />
        <path d="M3 8 h17 a2 2 0 0 1 2 2 v5 a2 2 0 0 1 -2 2 h-17 a2 2 0 0 1 -2 -2 v-9 a2 2 0 0 1 2 -2 z" />
        <rect x="13" y="9" width="4" height="3" rx="1" fill="#FFFFFF" stroke="none" />
      </g>

      {/* Center label (white) */}
      <text x={cx} y={cy + 22} textAnchor="middle" fill="#FFFFFF" fontSize="8.5" fontWeight="700" fontFamily="sans-serif" opacity="0.95">
        គណនីទាំងអស់
      </text>
    </svg>
  );
};


/* ─── Card logos ──────────────────────────────────────────────────────────── */
const USFlagIcon = () => (
  <div className="w-[38px] h-[24px] rounded-sm overflow-hidden border border-gray-200/60 flex flex-col">
    {[0,1,2,3,4,5,6].map(i => (
      <div key={i} className="flex-1" style={{ backgroundColor: i % 2 === 0 ? '#B22234' : '#FFFFFF' }} />
    ))}
    <div className="absolute inset-0" style={{ width: '40%', height: '55%', backgroundColor: '#3C3B6E' }} />
  </div>
);

const FlagIcon = () => (
  <div className="relative w-[38px] h-[24px] rounded-sm overflow-hidden border border-gray-200/60">
    {/* US flag simplified */}
    <div className="absolute inset-0 flex flex-col">
      {[0,1,2,3,4,5,6].map(i => (
        <div key={i} className="flex-1" style={{ backgroundColor: i % 2 === 0 ? '#BF0A30' : '#FFFFFF' }} />
      ))}
    </div>
    {/* Blue canton */}
    <div className="absolute top-0 left-0 w-[45%] h-[55%] bg-[#002868] flex flex-wrap items-center justify-center p-[1px] gap-[1px]">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="w-[3px] h-[3px] bg-white/80 rounded-full" />
      ))}
    </div>
  </div>
);

const VisaLogo = () => (
  <svg width="46" height="15" viewBox="0 0 54 16">
    <text x="0" y="13" fontFamily="Arial, sans-serif" fontStyle="italic" fontWeight="bold" fontSize="16" fill="#1A1F71">VISA</text>
  </svg>
);

/* ─── Account Card ──────────────────────────────────────────────────────────── */
const AccountCard = ({
  account,
  index,
  onPress,
}: {
  account: Account;
  index: number;
  onPress: () => void;
}) => (
  <motion.div
    initial={{ opacity: 0, y: 14 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay: index * 0.07, ease: 'easeOut' }}
    whileTap={{ scale: 0.985 }}
    onClick={onPress}
    className="bg-white rounded-2xl shadow-[0_2px_10px_rgba(0,0,0,0.07)] overflow-hidden border border-gray-100/80 cursor-pointer"
  >
    <div className="flex">
      {/* Left color accent bar */}
      <div className="w-[5px] rounded-l-2xl shrink-0" style={{ backgroundColor: account.borderColor }} />

      <div className="flex-1 px-4 pt-3.5 pb-3">
        {/* Top row: name + badge + menu */}
        <div className="flex items-start justify-between mb-0.5">
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-bold text-gray-900 leading-tight">{account.name}</p>
            <div className="flex items-center flex-wrap gap-1.5 mt-0.5">
              <p className="text-[11px] text-gray-400 font-medium">
                {account.number} | {account.type}
              </p>
              {account.badge && (
                <span className={`text-[9.5px] px-1.5 py-0.5 rounded font-bold ${account.badge.color}`}>
                  {account.badge.label}
                </span>
              )}
            </div>
          </div>
          <button className="text-gray-300 hover:text-gray-500 transition-colors p-1 -mr-1 ml-2 shrink-0">
            <MoreHorizontal className="w-[17px] h-[17px]" strokeWidth={2} />
          </button>
        </div>

        {/* Card logo row */}
        <div className="mt-2.5 mb-2 h-[24px] flex items-center gap-2">
          {(account.cardType === 'visa' || account.cardType === 'flag-visa') && <VisaLogo />}
        </div>

        {/* Balance */}
        {account.balance !== null && (
          <div className="flex justify-end items-baseline gap-1">
            <span className="text-[15.5px] font-extrabold text-gray-900">{getBalance(account.id, account.balance)}</span>
            <span className="text-[11px] font-bold text-gray-400">{account.currency}</span>
          </div>
        )}
      </div>
    </div>
  </motion.div>
);

/* ─── Main Page ──────────────────────────────────────────────────────────────── */
export default function Accounts() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-[100dvh] md:h-screen md:min-h-screen bg-gray-200 flex items-center justify-center md:p-4 font-sans select-none">
      <div className="w-full h-full md:max-w-[390px] md:h-[844px] bg-white md:rounded-[2.5rem] shadow-2xl relative overflow-hidden md:border-[8px] border-black flex flex-col">

        {/* Background: Angkor temple image with dark overlay (matches ABA official) */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <img
            src={`${import.meta.env.BASE_URL}images/theme-angkor.jpg`}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/40 to-black/65" />
        </div>

        {/* ── Header (white text over image) ── */}
        <div className="relative z-20 px-5 pt-12 pb-2 flex items-center gap-3">
          <button
            onClick={() => setLocation('/')}
            className="text-white hover:text-white/80 transition-colors"
          >
            <ArrowLeft className="w-6 h-6" strokeWidth={2.5} />
          </button>
          <h1 className="text-[22px] font-extrabold text-white tracking-tight">
            ABA<span className="text-white text-2xl font-black">'</span>{' '}
            <span className="font-semibold">គណនី</span>
          </h1>
        </div>

        {/* ── Ring + Balance row ── */}
        <div className="relative z-10 px-5 pt-2 pb-1 flex items-center justify-between">
          {/* Ring */}
          <motion.div
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, ease: 'backOut' }}
          >
            <RingChart />
          </motion.div>

          {/* Balance info (white text) */}
          <motion.div
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.18, duration: 0.4 }}
            className="text-right flex-1 ml-4"
          >
            <p className="text-[11px] text-white/70 font-medium mb-1 tracking-wide">ទឹកប្រាក់ដែលមាន</p>
            <p className="text-[33px] font-extrabold text-white leading-none tracking-tight drop-shadow-sm">
              ${accounts.filter((a) => a.currency === 'USD').reduce((sum, a) => sum + (Number(getBalance(a.id, a.balance)) || 0), 0).toFixed(2)}
            </p>
            <div className="w-full h-[1px] bg-white/25 my-2" />
            <p className="text-[27px] font-extrabold text-white leading-none drop-shadow-sm">
              <span className="text-[16px] align-top mt-[3px] inline-block font-bold text-white/70 mr-[1px]">៛</span>
              {accounts.filter((a) => a.currency === 'KHR').reduce((sum, a) => sum + (Number(getBalance(a.id, a.balance)) || 0), 0).toLocaleString()}
            </p>
          </motion.div>
        </div>

        {/* ── Analytics label + chevron (white, matches ABA official) ── */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="relative z-10 flex flex-col items-center justify-center mb-1"
        >
          <button className="flex items-center gap-1.5 text-white/80 hover:text-white transition-colors px-4 py-1">
            <BarChart3 className="w-[13px] h-[13px]" strokeWidth={2} />
            <span className="text-[13px] font-semibold">មុខងារវិភាគ</span>
          </button>
          <ChevronDown className="w-4 h-4 text-white/50 -mt-0.5" strokeWidth={2} />
        </motion.div>

        {/* ── White slide-up sheet ── */}
        <motion.div
          initial={{ y: 28 }}
          animate={{ y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="flex-1 bg-[#F3F2F7] rounded-t-[26px] overflow-y-auto z-20 mt-1 pb-24 relative"
        >
          {/* Top center notch (ABA-style concave cutout) */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[1px] w-12 h-4 pointer-events-none">
            <svg viewBox="0 0 48 16" className="w-full h-full" preserveAspectRatio="none">
              <path d="M0,0 L48,0 L48,2 Q40,2 36,6 Q30,14 24,14 Q18,14 12,6 Q8,2 0,2 Z" fill="#F3F2F7" />
            </svg>
          </div>

          {/* Section header */}
          <div className="px-5 pt-5 pb-3 flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-white shadow-sm flex items-center justify-center">
              <Wallet className="w-4 h-4 text-gray-500" strokeWidth={2} />
            </div>
            <span className="text-[12px] font-extrabold text-gray-500 tracking-widest uppercase">គណនី</span>
          </div>

          {/* Account cards */}
          <div className="px-4 space-y-3">
            {accounts.map((acc, i) => (
              <AccountCard
                key={acc.id}
                account={acc}
                index={i}
                onPress={() => setLocation(`/accounts/${acc.id}`)}
              />
            ))}
          </div>
        </motion.div>

        {/* ── Floating "+ គណនី" button ── */}
        <motion.button
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.5, type: 'spring', stiffness: 280 }}
          whileTap={{ scale: 0.93 }}
          className="absolute bottom-7 right-5 z-30 flex items-center gap-2 px-4 py-3 rounded-full shadow-xl"
          style={{ background: 'linear-gradient(135deg, #E8002D 0%, #FF3355 100%)' }}
          onClick={() => {}}
        >
          <Plus className="w-4 h-4 text-white" strokeWidth={2.5} />
          <span className="text-[13px] font-extrabold text-white tracking-wide">គណនី</span>
        </motion.button>
      </div>
    </div>
  );
}
