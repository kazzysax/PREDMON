// Wallet: your balance, your address, and topping up MON from any other chain.
// The Aurora widget handles the routing; funds land in the in-app wallet.
import { lazy, Suspense } from 'react';
import { useApp } from '../ctx';
import { AURORA_KEY } from '../env';
import { trimNum } from '../ui';

const AuroraWidget = lazy(() => import('./AuroraWidget'));

export function Deposit({ balance }: { balance: string }) {
  const { account, preview } = useApp();
  return (
    <div className="page">
      <div className="card plain">
        <span className="cap">On-chain balance</span>
        <div className="hero" style={{ padding: 0 }}><div className="big">{balance === '' ? '…' : trimNum(balance)}<small>MON</small></div></div>
        <span className="small">{account.address.slice(0, 10)}…{account.address.slice(-8)}</span>
        <button className="btn quiet sm" style={{ marginTop: 8, justifySelf: 'start' }} onClick={() => navigator.clipboard?.writeText(account.address)}>Copy address</button>
      </div>
      <p className="heading">Add MON from another chain</p>
      {preview ? (
        <div className="frame"><p className="empty"><b>Top-up form</b>Aurora's deposit form loads here in the live app.</p></div>
      ) : !AURORA_KEY ? (
        <p className="info">Top-ups from other chains aren't switched on yet. For now, send MON on Monad to your address.</p>
      ) : (
        <div className="frame"><Suspense fallback={<p className="empty">Loading…</p>}><AuroraWidget address={account.address} /></Suspense></div>
      )}
    </div>
  );
}
