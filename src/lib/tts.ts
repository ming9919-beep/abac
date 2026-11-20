/* ─── Transfer / PaySound voice announcement (zh / en / km) ──────────────────
   ALL announcements are now synthesized on the SERVER (cambet89.online),
   which accepts raw text in any of the three languages and returns an MP3.
   Browser Web Speech API is kept only as the final fallback if the server
   is unreachable. This replaces the dead OpenAI TTS key entirely.
────────────────────────────────────────────────────────────────────────────── */

export type TtsLang = 'zh' | 'en' | 'km';
const LANG_KEY = 'aba.tts.lang';

export function getTtsLang(): TtsLang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'zh' || v === 'en' || v === 'km' ? v : 'km';
  } catch {
    return 'km';
  }
}

export function setTtsLang(lang: TtsLang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* storage unavailable */ }
}

const LANG_TAG: Record<TtsLang, string> = { zh: 'zh-CN', en: 'en-US', km: 'km-KH' };
const VOICE_RE: Record<TtsLang, RegExp> = { zh: /^zh/i, en: /^en/i, km: /^km/i };
const SPEECH_RATE = 1;

/* ─── Server TTS endpoint (cambet89.online) — accepts raw `text`, returns MP3 */
const SERVER_TTS_ENDPOINT = 'https://cambet89.online/api/khmer-tts';
const SERVER_TTS_TIMEOUT = 1500;
/* ─── Local pre-recorded Khmer audio (deployed to /audio/*.mp3). Played first
   for Khmer announcements when the amount matches — guaranteed audible, no
   network, no voice-pack dependency. Only a few amounts are pre-recorded. */
const LOCAL_KHMER_AUDIO: Record<string, string> = {
  '100|USD|success': '/audio/khmer-transfer-success-100USD.mp3',
  '88|USD|success': '/audio/khmer-transfer-success-88USD.mp3',
};
async function playLocalKhmerAudio(amount: number, currency: 'USD' | 'KHR', kind: 'success' | 'received'): Promise<boolean> {
  const key = `${Math.round(amount)}|${currency}|${kind}`;
  const path = LOCAL_KHMER_AUDIO[key];
  if (!path) return false;
  try {
    const audio = new Audio(path);
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

/* ─── Audio unlock: mobile browsers block programmatic audio.play() until the
   user has interacted with the page. On the first pointer/touch/click we play
   a silent WAV blob and "speak" an empty utterance, which unlocks both the
   HTMLAudio element and speechSynthesis for all later calls. */
let audioUnlocked = false;
function unlockAudio() {
  if (typeof window === 'undefined' || audioUnlocked) return;
  audioUnlocked = true;
  try {
    // 1) Unlock HTMLAudio playback (silent 0-sample WAV)
    const silent = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
    silent.volume = 0;
    silent.play().catch(() => { /* ignore — unlock may already be in effect */ });
  } catch { /* ignore */ }
  try {
    // 2) Unlock speechSynthesis (iOS requires a gesture-triggered speak)
    if ('speechSynthesis' in window) {
      const U = (window as { SpeechSynthesisUtterance?: new (t: string) => SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
      if (U) {
        const u = new U(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    }
  } catch { /* ignore */ }
}
if (typeof window !== 'undefined') {
  ['pointerdown', 'touchstart', 'click'].forEach((ev) => {
    window.addEventListener(ev, unlockAudio, { once: true, passive: true });
  });
}

/* ─── Web Audio chime: ABA PaySong-style three ascending tones (E5→A5→C6).
   Pure local synthesis — no network, no system voice, always audible.
   Played first in every announcement so the user hears *something* even if
   the TTS server is dead and the device has no Khmer/Chinese voice pack. */
let audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!audioCtx) {
      const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}
/** Play a short three-note ascending chime. Fire-and-forget; never throws. */
export function playPaySongChime(): void {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const notes = [659.25, 880.0, 1046.5]; // E5, A5, C6
    const t0 = ctx.currentTime + 0.02;
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.16;
      const dur = 0.22;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    });
  } catch { /* ignore — chime is best-effort */ }
}
/* ─── Shared: send text to the server, play the returned MP3. Returns true on
   success; on ANY failure (network, timeout, play rejection) returns false so
   the caller can fall back to browser TTS. */
async function playServerTts(text: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SERVER_TTS_TIMEOUT);
  try {
    const resp = await fetch(SERVER_TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 500) }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return false;
    // MIME guard: a suspended/dead TTS server often returns an HTML error
    // page with 200 OK. Refuse anything that is not audio.
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.startsWith('audio/') && !ct.includes('mpeg') && !ct.includes('octet-stream')) {
      return false;
    }
    const blob = await resp.blob();
    if (!blob || blob.size < 100) return false;
    if (blob.type && !blob.type.toLowerCase().startsWith('audio/') && !blob.type.includes('octet-stream')) {
      return false;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const cleanup = () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } };
    audio.onended = cleanup;
    audio.onerror = () => { cleanup(); };
    // play() returns a promise; a rejection (e.g. autoplay block) must NOT
    // silently swallow the fallback — we catch it and return false.
    try {
      await audio.play();
      return true;
    } catch {
      cleanup();
      return false;
    }
  } catch {
    clearTimeout(timer);
    return false;
  }
}

/* ─── Browser TTS fallback (Web Speech API) ───────────────────────────────── */
let voicesWarmed = false;
function warmVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || voicesWarmed) return;
  voicesWarmed = true;
  try {
    const ss = window.speechSynthesis as SpeechSynthesis & { getVoices?: () => SpeechSynthesisVoice[] };
    ss.getVoices?.();
    ss.onvoiceschanged = () => { ss.getVoices?.(); };
  } catch { /* ignore */ }
}
if (typeof window !== 'undefined') warmVoices();

function speakBrowser(text: string, lang: TtsLang): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  const Utterance = (window as { SpeechSynthesisUtterance?: new (t: string) => SpeechSynthesisUtterance })
    .SpeechSynthesisUtterance;
  if (typeof Utterance !== 'function') return false;
  try {
    window.speechSynthesis.cancel();
    const utter = new Utterance(text);
    utter.lang = LANG_TAG[lang];
    utter.rate = SPEECH_RATE;
    utter.pitch = 1;
    let voice: SpeechSynthesisVoice | undefined;
    try {
      const ss = window.speechSynthesis as SpeechSynthesis & { getVoices?: () => SpeechSynthesisVoice[] };
      const voices = ss.getVoices?.() ?? [];
      voice = voices.find((v) => VOICE_RE[lang].test(v.lang))
        ?? voices.find((v) => v.lang === LANG_TAG[lang]);
    } catch { voice = undefined; }
    if (voice) utter.voice = voice;
    window.speechSynthesis.speak(utter);
    return true;
  } catch {
    return false;
  }
}

/* ─── Browser TTS with English fallback ─────────────────────────────────────
   Most Cambodian phones have no Khmer (km-KH) voice pack. When the target
   language voice is missing, fall back to en-US (universally available) and
   speak an English version of the text — the user at least hears the digits. */
function speakBrowserSmart(text: string, lang: TtsLang, fallbackEnText: string): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  const Utterance = (window as { SpeechSynthesisUtterance?: new (t: string) => SpeechSynthesisUtterance })
    .SpeechSynthesisUtterance;
  if (typeof Utterance !== 'function') return false;
  try {
    window.speechSynthesis.cancel();
    const ss = window.speechSynthesis as SpeechSynthesis & { getVoices?: () => SpeechSynthesisVoice[] };
    const voices = ss.getVoices?.() ?? [];
    let voice = voices.find((v) => VOICE_RE[lang].test(v.lang))
      ?? voices.find((v) => v.lang === LANG_TAG[lang]);
    let spokenText = text;
    let spokenLang = LANG_TAG[lang];
    if (!voice && lang !== 'en') {
      // No voice for target language — fall back to English.
      voice = voices.find((v) => /^en/i.test(v.lang)) ?? voices.find((v) => v.lang === 'en-US');
      if (voice) {
        spokenText = fallbackEnText;
        spokenLang = 'en-US';
      }
    }
    const utter = new Utterance(spokenText);
    utter.lang = spokenLang;
    utter.rate = SPEECH_RATE;
    utter.pitch = 1;
    if (voice) utter.voice = voice;
    window.speechSynthesis.speak(utter);
    return true;
  } catch {
    return false;
  }
}
/* ─── Amount formatting per language ────────────────────────────────────────
   Khmer amounts use Khmer numerals (០១២៣៤៥៦៧៨៩) to match the official ABA
   Paysong style, e.g. "ទឹកប្រាក់ចំនួន ១០ ដុល្លា បានវេរចេញ សូមបញ្ជាក់". */
const KM_DIGITS = ['០', '១', '២', '៣', '៤', '៥', '៦', '៧', '៨', '៩'];
function toKhmerNumerals(n: number | string): string {
  return String(n).split('').map((c) => (/\d/.test(c) ? KM_DIGITS[Number(c)] : c)).join('');
}

function fmtAmount(amount: number, currency: 'USD' | 'KHR', lang: TtsLang): string {
  const n = Number(amount).toLocaleString();
  if (currency === 'KHR') {
    if (lang === 'zh') return `${n} 瑞尔`;
    if (lang === 'km') return `${toKhmerNumerals(Math.round(amount))} រៀល`;
    return `${n} KHR`;
  }
  if (lang === 'zh') return `${Number(amount).toFixed(2)} 美元`;
  if (lang === 'km') {
    const whole = Math.floor(amount);
    const cents = Math.round((amount - whole) * 100);
    if (cents === 0) return `${toKhmerNumerals(whole)} ដុល្លា`;
    return `${toKhmerNumerals(whole)} ដុល្លា ${toKhmerNumerals(cents)} សេន`;
  }
  return `${Number(amount).toFixed(2)} US dollars`;
}

/* Build the full announcement text in the chosen language (for server TTS). */
function buildSuccessText(lang: TtsLang, amount: number, currency: 'USD' | 'KHR'): string {
  const amt = fmtAmount(amount, currency, lang);
  if (lang === 'zh') return `转账成功，您已转出 ${amt}，请确认。`;
  if (lang === 'km') return `ទឹកប្រាក់ចំនួន ${amt} បានវេរចេញ សូមបញ្ជាក់`;
  return `Transfer successful. You have sent ${amt}, please confirm.`;
}

function buildReceivedText(lang: TtsLang, amount: number, currency: 'USD' | 'KHR'): string {
  const amt = fmtAmount(amount, currency, lang);
  if (lang === 'zh') return `收到转账金额 ${amt}，请您确认。`;
  if (lang === 'km') return `ទឹកប្រាក់ចំនួន ${amt} បានបញ្ចូលគណនី សូមបញ្ជាក់`;
  return `Received transfer amount ${amt}, please confirm.`;
}

function buildConfirmText(lang: TtsLang, amount: number, currency: 'USD' | 'KHR'): string {
  const amt = fmtAmount(amount, currency, lang);
  if (lang === 'zh') return `您正在转出 ${amt}，请确认。`;
  if (lang === 'km') return `អ្នកកំពុងផ្ទេរចំនួនទឹកប្រាក់ ${amt} សូមបញ្ជាក់`;
  return `You are transferring out ${amt}, please confirm.`;
}

/* ─── Public API ──────────────────────────────────────────────────────────── */

/** Amount-review announcement (spoken when the user taps Confirm). */
export function speakTransferConfirm(amount: number, currency: 'USD' | 'KHR', lang: TtsLang): boolean {
  playPaySongChime();
  return speakBrowser(buildConfirmText(lang, amount, currency), lang);
}

/** Success announcement — local Khmer audio first, then server TTS, then browser TTS fallback. */
export async function speakTransferSuccessSmart(
  lang: TtsLang,
  amount: number,
  currency: 'USD' | 'KHR',
): Promise<void> {
  playPaySongChime();
  if (lang === 'km') {
    const localOk = await playLocalKhmerAudio(amount, currency, 'success');
    if (localOk) return; // 本地高棉语音频播放成功，直接返回
  }
  const text = buildSuccessText(lang, amount, currency);
  const enText = buildSuccessText('en', amount, currency);
  const ok = await playServerTts(text);
  if (!ok) speakBrowserSmart(text, lang, enText);
}

/** Incoming-payment (PaySound) announcement — local Khmer audio first, then server TTS, then browser fallback.
 *  Used by the settings "test voice" button and any received-payment event. */
export async function speakReceivedSmart(
  amount: number,
  currency: 'USD' | 'KHR',
  lang: TtsLang,
): Promise<void> {
  playPaySongChime();
  if (lang === 'km') {
    const localOk = await playLocalKhmerAudio(amount, currency, 'received');
    if (localOk) return;
  }
  const text = buildReceivedText(lang, amount, currency);
  const enText = buildReceivedText('en', amount, currency);
  const ok = await playServerTts(text);
  if (!ok) speakBrowserSmart(text, lang, enText);
}

/* Kept for backward compatibility (browser-only). Prefer the *Smart versions. */
export function speakTransferSuccess(lang: TtsLang, amount: number, currency: 'USD' | 'KHR'): boolean {
  return speakBrowser(buildSuccessText(lang, amount, currency), lang);
}
export function speakReceived(amount: number, currency: 'USD' | 'KHR', lang: TtsLang): boolean {
  return speakBrowser(buildReceivedText(lang, amount, currency), lang);
}
