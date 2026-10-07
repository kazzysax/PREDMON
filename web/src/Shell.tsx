// The signed-in app frame: top bar, the screens, and the tab bar with + in the middle.
import { useEffect, useState } from 'react';
import { formatEther } from 'viem';
import { useApp } from './ctx';
import { publicClient } from './chain';
import { Icon, Wordmark, trimNum } from './ui';
import { Calls } from './screens/Calls';
import { Pools } from './screens/Pools';
import { Deposit } from './screens/Deposit';
import { Profile } from './screens/Profile';
import { Leaderboard } from './screens/Leaderboard';

type Tab = 'calls' | 'pools' | 'people' | 'wallet' | 'me';
const LEFT: { id: Tab; label: string; icon: string }[] = [{ id: 'calls', label: 'Feed', icon: 'calls' }, { id: 'pools', label: 'Pools', icon: 'pools' }];
const RIGHT: { id: Tab; label: string; icon: string }[] = [{ id: 'people', label: 'People', icon: 'people' }, { id: 'me', label: 'Profile', icon: 'me' }];

export function Shell({ initialTab = 'calls' as Tab, initialCompose = false }) {
  const { account, preview } = useApp();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [composing, setComposing] = useState(initialCompose);
  const [balance, setBalance] = useState(preview?.balance ?? '');

  useEffect(() => {
    if (preview) return;
    const read = () => publicClient.getBalance({ address: account.address }).then(b => setBalance(formatEther(b))).catch(() => {});
    read();
    const t = setInterval(read, 20_000);
    return () => clearInterval(t);
  }, [account?.address]);

  const go = (t: Tab) => { setTab(t); setComposing(false); window.scrollTo({ top: 0 }); };
  const tabBtn = (t: { id: Tab; label: string; icon: string }) => (
    <button key={t.id} className={`tab ${tab === t.id ? 'on' : ''}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
      <Icon name={t.icon} /><span>{t.label}</span>
    </button>
  );

  return (
    <div className="app">
      <div className="top">
        <Wordmark />
        <div className="top-right">
          <button className="balance" onClick={() => go('wallet')} aria-label="Wallet"><Icon name="wallet" />{balance === '' ? '…' : trimNum(balance)}<span>MON</span></button>
        </div>
      </div>

      {tab === 'calls' && <Calls composing={composing} setComposing={setComposing} />}
      {tab === 'pools' && <Pools />}
      {tab === 'wallet' && <Deposit balance={balance} />}
      {tab === 'people' && <Leaderboard />}
      {tab === 'me' && <Profile />}

      <nav className="tabs" aria-label="Sections">
        {LEFT.map(tabBtn)}
        <button className="plus" onClick={() => { setTab('calls'); setComposing(true); }} aria-label="Make a call"><Icon name="plus" /></button>
        {RIGHT.map(tabBtn)}
      </nav>
    </div>
  );
}
