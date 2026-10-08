// The real app: Dynamic sign-in, wallet bootstrap, then the shell.
import { useEffect, useState } from 'react';
import { DynamicProvider, useUser, useGetWalletAccounts, useGetUserSocialAccounts } from '@dynamic-labs-sdk/react-hooks';
import { logout, signInWithSocialRedirect, refreshAuth } from '@dynamic-labs-sdk/client';
import { api, setTokenGetter } from './api';
import { AppCtx, type Config, type Me } from './ctx';
import { dynamicClient, ensureWallet } from './dynamic';
import { pickAccount } from './wallet';
import { SignIn } from './screens/SignIn';
import { Username } from './screens/Username';
import { Shell } from './Shell';

setTokenGetter(() => dynamicClient.token);

export default function App() {
  return <DynamicProvider client={dynamicClient}><Inner /></DynamicProvider>;
}

function Inner() {
  const user = useUser();
  const accounts = useGetWalletAccounts();
  const social = useGetUserSocialAccounts();
  const [config, setConfig] = useState<Config | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const account = pickAccount(accounts.data);

  useEffect(() => { api<Config>('/api/config').then(setConfig).catch(e => setError(e.message)); }, []);

  // Once signed in: make sure there is a wallet, then load the profile.
  useEffect(() => {
    if (!user.data) { setMe(null); return; }
    ensureWallet().catch((e: any) => setError(`Could not create your wallet: ${e.message}`));
  }, [user.data?.id]);

  const reloadMe = async () => {
    if (!account) return;
    const load = () => api<Me>(`/api/me?wallet=${account.address}`);
    try { setMe(await load()); setError(''); } catch (e: any) {
      // A new in-app wallet is not in the sign-in token yet. Get a fresh token and try once more.
      if (/not on your account/i.test(e.message)) {
        try { await refreshAuth(); setMe(await load()); setError(''); return; } catch (e2: any) { setError(e2.message); return; }
      }
      setError(e.message);
    }
  };
  useEffect(() => { if (user.data && account) reloadMe(); }, [user.data?.id, account?.address]);

  if (!user.data) return <SignIn />;
  if (!config || !account || !me) {
    return <div className="app"><p className="empty">{error || "Setting up your wallet…"}</p></div>;
  }
  if (!me.username) return <Username onDone={reloadMe} />;

  const hasX = (social.data ?? []).some((a: any) => a.provider === 'twitter');
  const linkX = () => { signInWithSocialRedirect({ provider: 'twitter', redirectUrl: window.location.href }).catch(e => setError(e.message)); };

  return (
    <AppCtx.Provider value={{ config, me, account, reloadMe, hasX, linkX, signOut: () => { logout(); } }}>
      <Shell />
    </AppCtx.Provider>
  );
}
