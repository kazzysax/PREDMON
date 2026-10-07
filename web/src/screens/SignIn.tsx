import { useEffect, useState } from 'react';
import {
  signInWithSocialRedirect, detectSocialRedirectUrl, completeSocialRedirect,
  connectAndVerifyWithWalletProvider, getAvailableWalletProvidersData,
} from '@dynamic-labs-sdk/client';
import { Avatar, PostBody, Wordmark } from '../ui';

export function SignIn({ preview = false }: { preview?: boolean }) {
  const [msg, setMsg] = useState('');
  const [wallets, setWallets] = useState<{ key: string; name: string }[]>([]);

  useEffect(() => {
    if (preview) return;
    (async () => {
      const url = new URL(window.location.href);
      if (await detectSocialRedirectUrl({ url })) {
        try { await completeSocialRedirect({ url }); } catch (e: any) { setMsg(e.message); }
        window.history.replaceState({}, '', window.location.pathname);
      }
    })();
    try {
      setWallets(getAvailableWalletProvidersData().filter((p: any) => p.chain === 'EVM')
        .map((p: any) => ({ key: p.key, name: p.metadata?.displayName ?? p.key })));
    } catch { /* no wallet extensions found */ }
  }, []);

  const google = () => { if (!preview) signInWithSocialRedirect({ provider: 'google', redirectUrl: window.location.href }).catch(e => setMsg(e.message)); };

  return (
    <div className="app">
      <div className="pad draw">
        <Wordmark xl />
        <div className="mid" style={{ display: 'grid', gap: 22, padding: '28px 0' }}>
          <h1 className="h1" style={{ fontSize: 44 }}>What if you could track conviction behind predictions, <em>socially?</em></h1>
          <div className="card">
            <div className="inner">
            <div className="tags"><span className="tag">3d left</span><span className="tag dim">Crypto</span></div>
            <PostBody
              post={'Everyone is nervous again. I am not.\n\nBitcoin closes above $120,000 on 31 August.'}
              highlight="Bitcoin closes above $120,000 on 31 August."
              question=""
            />
            <div className="room">
              <div className="room-nums">
                <div className="y"><b>34%</b><span>17 said yes</span></div>
                <div className="n"><b>66%</b><span>33 said no</span></div>
              </div>
              <div className="meter"><i className="y" style={{ width: '34%' }} /><i className="n" style={{ flex: 1 }} /></div>
            </div>
            </div>
            <div className="under"><Avatar name="nkechi" /><div className="txt"><b>@nkechi</b><span>50 people in</span></div><span className="pillbtn">How this settles</span></div>
          </div>
          <p className="lede">Everyone has opinions. Nobody keeps score. <b>Here, you do.</b></p>
        </div>

        <div className="foot" style={{ paddingTop: 0 }}>
          <button className="btn" onClick={google}>Get started with Google</button>
          {wallets.map(w => (
            <button key={w.key} className="text-btn" onClick={async () => {
              try { await connectAndVerifyWithWalletProvider({ walletProviderKey: w.key }); } catch (e: any) { setMsg(e.message); }
            }}>Use {w.name}</button>
          ))}
          {msg && <p className="err" role="alert">{msg}</p>}
          <p className="cap" style={{ marginTop: 10, textAlign: 'center' }}>Social · Public · Reputation</p>
        </div>
      </div>
    </div>
  );
}
