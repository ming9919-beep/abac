import { createRoot } from 'react-dom/client';

import App from './App';
import ErrorBoundary from '@/components/ErrorBoundary';

import './index.css';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

/* PWA service worker: only register for production builds. In dev the
   cache-first worker serves stale modules, so unregister it and clear caches. */
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register(`${import.meta.env.BASE_URL}sw.js`)
        .catch(() => {});
    });
  } else {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
      .catch(() => {});
    if (typeof caches !== 'undefined') {
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => {});
    }
  }
}