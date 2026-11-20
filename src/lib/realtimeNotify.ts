/* ─── Cross-device realtime transfer notifications ──────────────────────────
   Uses ntfy.sh (free, zero-config, no API key) as the pub/sub bus.
   - Payer: after a successful transfer, POSTs a JSON message to the payee's
     topic (derived from payee account number).
   - Payee: subscribes via EventSource (SSE) to their own topic; incoming
     messages are recorded via recordTransferIn (deduplicated) and surface
     in the Notifications center + bell badge.
   Topic = "abac-pay-" + digits of payee account number.
────────────────────────────────────────────────────────────────────────── */
import { recordTransferIn } from './notificationStore';

const NTFY_BASE = 'https://ntfy.sh';
const TOPIC_PREFIX = 'abac-pay-';

/** Derive the ntfy topic for an account number (digits only). */
export function topicFor(account: string): string {
  return TOPIC_PREFIX + (account || '').replace(/\D/g, '');
}

export type TransferInPayload = {
  type: 'transfer_in';
  amount: string;
  currency: 'USD' | 'KHR';
  fromName: string;
  fromAccount: string;
  reference: string;
  timeIso: string;
};

/** Payer side: notify the payee's device that a transfer arrived.
 *  Fire-and-forget; never throws. */
export async function notifyReceiver(opts: {
  payeeAccount: string;
  amount: string;
  currency: 'USD' | 'KHR';
  fromName: string;
  fromAccount: string;
  reference?: string;
}): Promise<void> {
  if (!opts.payeeAccount) return;
  const topic = topicFor(opts.payeeAccount);
  const payload: TransferInPayload = {
    type: 'transfer_in',
    amount: opts.amount,
    currency: opts.currency,
    fromName: opts.fromName || 'Unknown',
    fromAccount: opts.fromAccount || '',
    reference: opts.reference || String(Date.now()),
    timeIso: new Date().toISOString(),
  };
  try {
    await fetch(`${NTFY_BASE}/${topic}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { Title: '收到转账', Tags: 'moneybag' },
    });
  } catch {
    /* network unreachable — notification simply won't arrive */
  }
}

/** Payee side: subscribe to incoming-transfer notifications for my account.
 *  Returns an unsubscribe function. Messages are deduplicated by reference. */
export function subscribeIncoming(myAccount: string): () => void {
  if (!myAccount || typeof EventSource === 'undefined') return () => {};
  const topic = topicFor(myAccount);
  let es: EventSource | null = null;
  try {
    es = new EventSource(`${NTFY_BASE}/${topic}/sse`);
  } catch {
    return () => {};
  }
  es.onmessage = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(ev.data);
      if (!msg.message) return; // keepalive / other events
      const payload = JSON.parse(msg.message) as TransferInPayload;
      if (payload.type !== 'transfer_in') return;
      recordTransferIn({
        counterparty: payload.fromName,
        amount: payload.amount,
        currency: payload.currency,
        toAccount: myAccount,
        reference: payload.reference,
        dedupKey: payload.reference,
      });
      // Trigger a UI refresh by dispatching a custom event.
      window.dispatchEvent(new CustomEvent('aba:incoming-transfer', { detail: payload }));
    } catch {
      /* malformed message — ignore */
    }
  };
  es.onerror = () => {
    /* EventSource auto-reconnects; nothing to do */
  };
  return () => {
    try { es?.close(); } catch { /* noop */ }
  };
}
