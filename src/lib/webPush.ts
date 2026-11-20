/* ─── Web Push subscription + send ──────────────────────────────────────────
   Enables system notifications on the payee's phone even when the app is
   closed. The payee grants notification permission once; their PushSubscription
   is stored on the server keyed by account number. After a successful transfer
   the payer's device calls /api/push/send and the server delivers the push.
────────────────────────────────────────────────────────────────────────── */

let swReg: ServiceWorkerRegistration | null = null;

async function getSwReg(): Promise<ServiceWorkerRegistration | null> {
  if (swReg) return swReg;
  if (!('serviceWorker' in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.ready;
    return swReg;
  } catch {
    return null;
  }
}

async function getVapidKey(): Promise<string> {
  try {
    const r = await fetch('/api/push/vapid-key');
    const j = await r.json();
    return j.key || '';
  } catch {
    return '';
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Request notification permission + subscribe to Web Push + register with server.
 *  Call after login. Safe to call repeatedly (no-ops if already subscribed). */
export async function enablePushNotifications(account: string): Promise<boolean> {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return false;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return false;
    const reg = await getSwReg();
    if (!reg) return false;
    const vapidKey = await getVapidKey();
    if (!vapidKey) return false;
    let sub: PushSubscription | null = null;
    try {
      sub = await reg.pushManager.getSubscription();
    } catch { sub = null; }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, subscription: sub.toJSON() }),
    });
    return true;
  } catch {
    return false;
  }
}

/** Payer side: ask the server to push a system notification to the payee.
 *  Returns true if the payee has an active push subscription. Fire-and-forget. */
export async function sendPushNotification(opts: {
  payeeAccount: string;
  amount: string;
  currency: string;
  fromName: string;
}): Promise<boolean> {
  try {
    const r = await fetch('/api/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payeeAccount: opts.payeeAccount,
        amount: opts.amount,
        currency: opts.currency,
        fromName: opts.fromName,
      }),
    });
    const j = await r.json();
    return Boolean(j.ok);
  } catch {
    return false;
  }
}
