/* ─── Transaction notification store ─────────────────────────────────────
   Every transfer out (debit) and transfer in (credit) is recorded here,
   persisted to localStorage, and surfaced in the Notifications center
   (both the "Important" and "Transactions" tabs). Static promo / system
   notifications stay hardcoded in the page module.
────────────────────────────────────────────────────────────────────────── */
export type TxNotification = {
  id: string;
  direction: 'debit' | 'credit'; // debit = 转出, credit = 入账
  counterparty: string;
  amount: string;
  currency: 'USD' | 'KHR';
  account: string;          // my account number, e.g. "088 710 222"
  reference: string;        // entry / reference number
  timeIso: string;          // ISO timestamp for sorting
  timeLabel: string;        // e.g. "4:52 PM"
  dateHeader: string;       // e.g. "19 NOV 2026"
  read: boolean;
};
const KEY = 'aba.txnotif.v1';
const SEEN_KEY = 'aba.txnotif.seenIncoming.v1';
type Persisted = { list: TxNotification[] };
function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { list: [] };
    const parsed = JSON.parse(raw) as Persisted;
    if (!Array.isArray(parsed.list)) return { list: [] };
    return parsed;
  } catch {
    return { list: [] };
  }
}
function save(p: Persisted) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
let cache: Persisted | null = null;
function store(): Persisted {
  if (!cache) cache = load();
  return cache;
}
const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function timeLabel(d: Date): string {
  const h12 = d.getHours() % 12 || 12;
  return `${h12}:${pad(d.getMinutes())} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
}
function dateHeader(d: Date): string {
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function entryNo(): string {
  return String(Math.floor(60000000000 + Math.random() * 30000000000));
}
/** All transaction notifications, newest first. */
export function getTxNotifications(): TxNotification[] {
  return [...store().list].sort((a, b) => (a.timeIso < b.timeIso ? 1 : -1));
}
/** Unread count — for the bell badge on Home. */
export function getUnreadCount(): number {
  return store().list.filter((n) => !n.read).length;
}
/** Mark all as read (when user opens the notifications page). */
export function markAllRead() {
  const s = store();
  s.list.forEach((n) => { n.read = true; });
  save(s);
}
/** Reset (tests only). */
export function resetTxNotifications() {
  cache = null;
  try { localStorage.removeItem(KEY); localStorage.removeItem(SEEN_KEY); } catch { /* noop */ }
}
type TransferOutInput = {
  counterparty: string;
  amount: string;
  currency: 'USD' | 'KHR';
  fromAccount?: string;
  reference?: string;
};
/** Record a successful transfer OUT (debit). Called from txnStore.addTxn. */
export function recordTransferOut(input: TransferOutInput): TxNotification {
  const s = store();
  const now = new Date();
  const amt = input.currency === 'KHR'
    ? Number(input.amount).toLocaleString('en-US')
    : Number(input.amount).toFixed(2);
  const n: TxNotification = {
    id: `out-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    direction: 'debit',
    counterparty: input.counterparty,
    amount: amt,
    currency: input.currency,
    account: input.fromAccount || '',
    reference: input.reference || entryNo(),
    timeIso: now.toISOString(),
    timeLabel: timeLabel(now),
    dateHeader: dateHeader(now),
    read: false,
  };
  s.list.push(n);
  save(s);
  return n;
}
type TransferInInput = {
  counterparty: string;
  amount: string;
  currency: 'USD' | 'KHR';
  toAccount?: string;
  reference?: string;
  dedupKey: string; // unique per incoming row (e.g. transaction id) to avoid re-notifying
};
function seenIncoming(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
}
function markIncomingSeen(key: string) {
  try {
    const set = seenIncoming();
    set.add(key);
    localStorage.setItem(SEEN_KEY, JSON.stringify([...set]));
  } catch { /* ignore */ }
}
/** Record a transfer IN (credit), deduplicated by dedupKey.
 *  Returns the notification if newly recorded, null if already seen. */
export function recordTransferIn(input: TransferInInput): TxNotification | null {
  const seen = seenIncoming();
  if (seen.has(input.dedupKey)) return null;
  markIncomingSeen(input.dedupKey);
  const s = store();
  const now = new Date();
  const amt = input.currency === 'KHR'
    ? Number(input.amount).toLocaleString('en-US')
    : Number(input.amount).toFixed(2);
  const n: TxNotification = {
    id: `in-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    direction: 'credit',
    counterparty: input.counterparty,
    amount: amt,
    currency: input.currency,
    account: input.toAccount || '',
    reference: input.reference || entryNo(),
    timeIso: now.toISOString(),
    timeLabel: timeLabel(now),
    dateHeader: dateHeader(now),
    read: false,
  };
  s.list.push(n);
  save(s);
  return n;
}
/** Group notifications by date header, newest date first. */
export function groupByDate(list: TxNotification[]): { date: string; items: TxNotification[] }[] {
  const groups = new Map<string, TxNotification[]>();
  for (const n of list) {
    const g = groups.get(n.dateHeader) ?? [];
    g.push(n);
    groups.set(n.dateHeader, g);
  }
  // Map preserves insertion order (first seen = newest because list is sorted).
  return [...groups.entries()].map(([date, items]) => ({ date, items }));
}
