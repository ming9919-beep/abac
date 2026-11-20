import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PinLock from '@/components/PinLock';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { isAuthPath, isSessionActive } from '@/lib/authFlow';
import { subscribeIncoming } from '@/lib/realtimeNotify';
import { enablePushNotifications } from '@/lib/webPush';
import { accounts } from '@/data/accounts';
import Home from '@/pages/Home';
import Accounts from '@/pages/Accounts';
import AccountDetail from '@/pages/AccountDetail';
import EditAccount from '@/pages/EditAccount';
import TransactionDetail from '@/pages/TransactionDetail';
import Scanner from '@/pages/Scanner';
import PayFlow from '@/pages/PayFlow';
import TransferHub from '@/pages/TransferHub';
import Transfer from '@/pages/Transfer';
import Cards from '@/pages/Cards';
import Settings from '@/pages/Settings';
import SettingsFeatures from '@/pages/SettingsFeatures';
import Profile from '@/pages/Profile';
import ReceiveQr from '@/pages/ReceiveQr';
import Payments from '@/pages/Payments';
import InternationalTransfer from '@/pages/InternationalTransfer';
import EmoneyPay from '@/pages/EmoneyPay';
import Incoming from '@/pages/Incoming';
import Banks from '@/pages/Banks';
import Notifications from '@/pages/Notifications';
import Chat from '@/pages/Chat';
import LanguageSelect from '@/pages/auth/LanguageSelect';
import AuthStart from '@/pages/auth/AuthStart';
import PhoneRegister from '@/pages/auth/PhoneRegister';
import Signup from '@/pages/auth/Signup';
import OtpVerify from '@/pages/auth/OtpVerify';

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={LanguageSelect} />
      <Route path="/home" component={Home} />
      <Route path="/auth/language" component={LanguageSelect} />
      <Route path="/auth/start" component={AuthStart} />
      <Route path="/auth/register" component={PhoneRegister} />
      <Route path="/auth/signup" component={Signup} />
      <Route path="/auth/otp" component={OtpVerify} />
      <Route path="/scan" component={Scanner} />
      <Route path="/pay" component={PayFlow} />
      <Route path="/transfer" component={TransferHub} />
      <Route path="/transfer/send" component={Transfer} />
      <Route path="/accounts" component={Accounts} />
      <Route path="/cards" component={Cards} />
      <Route path="/settings" component={Settings} />
      <Route path="/settings/features" component={SettingsFeatures} />
      <Route path="/settings/profile" component={Profile} />
      <Route path="/receive" component={ReceiveQr} />
      <Route path="/payments" component={Payments} />
      <Route path="/international" component={InternationalTransfer} />
      <Route path="/emoney/pay" component={EmoneyPay} />
      <Route path="/incoming" component={Incoming} />
      <Route path="/banks" component={Banks} />
      <Route path="/notifications" component={Notifications} />
      <Route path="/chat" component={Chat} />
      <Route path="/accounts/:id/edit" component={EditAccount} />
      <Route path="/accounts/:id/tx/:txId" component={TransactionDetail} />
      <Route path="/accounts/:id" component={AccountDetail} />
      <Route component={NotFound} />
    </Switch>
  );
}

/* ─── 已登录守卫 ───────────────────────────────────────────────
   OTP 通过后会话已建立。此时若用户从主页按「返回」，浏览器会退到
   语言选择 / 登录 / 开户 / OTP 这些页面 —— 一律 replace 回主页，
   避免把已经登录的用户扔回登录流程（那里还会撞上「该手机号已注册」）。
   replace 而非 push，不会在历史里再堆一条。 */
function AuthGuard({ children }: { children: ReactNode }) {
  const [path, navigate] = useLocation();
  const active = isSessionActive();
  const blocked = active && isAuthPath(path);

  useEffect(() => {
    if (blocked) navigate('/home', { replace: true });
  }, [blocked, navigate]);

  // 重定向生效前先不渲染 auth 页面，避免闪一帧登录界面
  if (blocked) return null;
  return <>{children}</>;
}

/* ─── Splash gate — shows the ABA Mobile splash photo on every launch.
   Tap anywhere (or wait 2.5s) to enter. Matches "installed app" feel. */
const SPLASH_IMG = `${import.meta.env.BASE_URL}splash.webp`;
function SplashGate({ onDone }: { onDone: () => void }) {
  return (
    <div
      onClick={onDone}
      className="fixed inset-0 z-[9999] bg-[#0F1B33] flex flex-col items-center justify-center cursor-pointer select-none"
    >
      <img
        src={SPLASH_IMG}
        alt="ABA Mobile"
        className="absolute inset-0 w-full h-full object-cover"
        draggable={false}
      />
      <div className="relative mt-auto mb-12 flex flex-col items-center gap-3">
        <div
          className="w-8 h-8 rounded-full border-2 border-white/30 border-t-white"
          style={{ animation: 'splashSpin 0.9s linear infinite' }}
        />
        <p className="text-white/85 text-[13px] font-medium tracking-wide">
          ចុចដើម្បីចូល · Tap to enter
        </p>
      </div>
      <style>{`@keyframes splashSpin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function App() {
  const [splashDone, setSplashDone] = useState(false);
  const [pinUnlocked, setPinUnlocked] = useState<boolean>(() => {
    try { return sessionStorage.getItem('aba.pin.unlocked') === '1'; } catch { return false; }
  });
  useEffect(() => {
    const t = setTimeout(() => setSplashDone(true), 2500);
    return () => clearTimeout(t);
  }, []);
  // Subscribe to realtime incoming-transfer notifications for all my accounts.
  // When a payer scans my QR and sends money, their device pushes a message to
  // ntfy.sh/<my-account-topic>; we receive it here and record it as an in-app
  // notification (bell badge + Notifications center). Also enable Web Push so
  // system notifications arrive even when the app is closed.
  useEffect(() => {
    if (!isSessionActive()) return;
    const unsubs = accounts.map((a) => subscribeIncoming(a.number));
    accounts.forEach((a) => { enablePushNotifications(a.number).catch(() => {}); });
    return () => { unsubs.forEach((u) => u()); };
  }, []);
  const gated = !splashDone || !pinUnlocked;
  return (
    <>
      {!splashDone && <SplashGate onDone={() => setSplashDone(true)} />}
      {splashDone && !pinUnlocked && (
        <PinLock
          title="បញ្ចូលលេខសម្ងាត់"
          subtitle="បញ្ចូល PIN ដើម្បីចូលក្នុងកម្មវិធី · Enter PIN to enter the app"
          storageKey="aba.pin.unlocked"
          onUnlock={() => setPinUnlocked(true)}
        />
      )}
      {!gated && (
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <AuthGuard>
                <Router />
              </AuthGuard>
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      )}
    </>
  );
}

export default App;
