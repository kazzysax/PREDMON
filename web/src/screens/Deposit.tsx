// Wallet: balance, tips, and adding MON. Adding MON is a short, clear choice:
// pick where it is coming from, then a token, and the widget only asks for the amount.
import { lazy, Suspense, useEffect, useState } from 'react';
import { formatEther, parseEther } from 'viem';
import { api } from '../api';
import { useApp } from '../ctx';
import { AURORA_KEY } from '../env';
import { sendAndWait } from '../wallet';
import { Avatar, Icon, Sheet, trimNum } from '../ui';

const AuroraWidget = lazy(() => import('./AuroraWidget'));

type Tips = { sent: string; received: string; recent: { direction: 'sent' | 'received'; username: string | null; amount: string; at: number }[] };

/** Where money can come from. `chain` is Aurora's chain id; the tokens are the usual stable and native ones. */
const SOURCES: { id: string; label: string; chain: string; tokens: string[] }[] = [
  { id: 'monad', label: 'Monad', chain: 'monad', tokens: ['MON', 'USDC'] },
  { id: 'base', label: 'Base', chain: 'base', tokens: ['USDC', 'ETH'] },
  { id: 'eth', label: 'Ethereum', chain: 'eth', tokens: ['USDC', 'USDT', 'ETH'] },
  { id: 'arb', label: 'Arbitrum', chain: 'arb', tokens: ['USDC', 'ETH'] },
  { id: 'op', label: 'Optimism', chain: 'op', tokens: ['USDC', 'ETH'] },
  { id: 'sol', label: 'Solana', chain: 'sol', tokens: ['SOL', 'USDC'] },
  { id: 'near', label: 'NEAR', chain: 'near', tokens: ['NEAR', 'USDC'] },
];

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ago = (t: number) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };

export function Deposit({ balance }: { balance: string }) {
  const { account, preview } = useApp();
  const [sheet, setSheet] = useState<'' | 'add' | 'tip'>('');
  const [tips, setTips] = useState<Tips | null>(preview ? { sent: '12', received: '31.5', recent: [
    { direction: 'received', username: 'nkechi', amount: '10', at: Math.floor(Date.now() / 1000) - 7200 },
    { direction: 'sent', username: 'thefold', amount: '5', at: Math.floor(Date.now() / 1000) - 86400 },
  ] } : null);
  const [copied, setCopied] = useState(false);

  const loadTips = () => { if (!preview) api<Tips>('/api/me/tips').then(setTips).catch(() => {}); };
  useEffect(loadTips, []);

  const copy = () => { navigator.clipboard?.writeText(account.address); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <div className="page">
      <h1 className="h1" style={{ fontSize: 32 }}>Wallet</h1>

      <div className="wtiles">
        <div className="wtile bal">
          <div className="wtop"><span className="wbadge"><img src="/monad.png" alt="" width="20" height="20" /></span><span className="wlabel">MON balance</span></div>
          <div className="wbig">{balance === '' ? '…' : trimNum(balance)}</div>
          <div className="wunit">MON on Monad</div>
          <button className="wmini" onClick={() => setSheet('add')}><Icon name="plus" />Add MON</button>
        </div>
        <button className="wtile tipt" onClick={() => setSheet('tip')}>
          <div className="wtop"><span className="wbadge g"><Icon name="people" /></span><span className="wlabel">Tip</span></div>
          <div className="wcoin" aria-hidden="true"><i /></div>
          <div className="wcap"><b>Reward a good call</b><span>Send MON to anyone by username.</span></div>
        </button>
      </div>

      <p className="heading">Your address</p>
      <div className="group">
        <div className="grow"><span className="gm"><b>{short(account.address)}</b><span>Send MON on Monad to this address</span></span>
          <button className="btn quiet sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
      </div>

      <p className="heading">Tip info</p>
      <div className="group tipinfo">
        <div className="lead"><b>{trimNum(tips?.received ?? '0')}</b><span>MON received</span></div>
        <div className="plane" aria-hidden="true"><Icon name="share" /></div>
        <div className="sent"><b>{trimNum(tips?.sent ?? '0')} MON</b><span>sent</span></div>
      </div>
      {tips && tips.recent.length > 0 && (
        <div className="group">
          {tips.recent.map((t, i) => (
            <div className="grow" key={i}>
              <Avatar name={t.username ?? '?'} size="sm" />
              <span className="gm"><b>@{t.username ?? 'someone'}</b><span>{t.direction === 'sent' ? 'You tipped' : 'Tipped you'} · {ago(t.at)}</span></span>
              <span className={`gv ${t.direction === 'received' ? 'in' : ''}`}><b>{t.direction === 'received' ? '+' : '−'}{trimNum(t.amount)}</b><span>MON</span></span>
            </div>
          ))}
        </div>
      )}

      {sheet === 'add' && <AddMon onClose={() => setSheet('')} />}
      {sheet === 'tip' && <TipSheet onClose={() => setSheet('')} onSent={() => { setSheet(''); loadTips(); }} />}
    </div>
  );
}

function AddMon({ onClose }: { onClose: () => void }) {
  const { account, preview } = useApp();
  const [src, setSrc] = useState(SOURCES[1]);
  const [token, setToken] = useState(SOURCES[1].tokens[0]);
  const [go, setGo] = useState(false);

  const pick = (s: typeof SOURCES[number]) => { setSrc(s); setToken(s.tokens[0]); setGo(false); };

  return (
    <Sheet onClose={onClose}>
      <h2 className="h2">Add MON</h2>
      <p className="lede">Pay with what you already have. It arrives as MON in your wallet.</p>

      <div>
        <span className="label">From</span>
        <div className="amounts wrap">
          {SOURCES.map(s => <button key={s.id} className={src.id === s.id ? 'on' : ''} onClick={() => pick(s)}>{s.label}</button>)}
        </div>
      </div>
      <div>
        <span className="label">Pay with</span>
        <div className="amounts wrap">
          {src.tokens.map(t => <button key={t} className={token === t ? 'on' : ''} onClick={() => { setToken(t); setGo(false); }}>{t}</button>)}
        </div>
      </div>

      {src.id === 'monad' && token === 'MON' ? (
        <p className="info">Already on Monad? Send MON straight to <b>{short(account.address)}</b>. Copy it from the wallet page.</p>
      ) : preview ? (
        <div className="frame"><p className="empty"><b>{token} on {src.label} → MON</b>Aurora's form loads here in the live app.</p></div>
      ) : !AURORA_KEY ? (
        <p className="info">Top-ups from other chains aren't switched on yet.</p>
      ) : !go ? (
        <button className="btn" onClick={() => setGo(true)}>Continue with {token} on {src.label}</button>
      ) : (
        <div className="frame">
          <Suspense fallback={<p className="empty">Loading…</p>}>
            <AuroraWidget key={`${src.id}-${token}`} address={account.address} source={{ symbol: token, blockchain: src.chain }} />
          </Suspense>
        </div>
      )}
      <button className="text-btn" onClick={onClose}>Close</button>
    </Sheet>
  );
}

function TipSheet({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const { account, preview } = useApp();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setMsg(''); setBusy(true);
    try {
      const n = name.replace(/^@/, '').trim();
      if (!n) throw new Error('Who is it for? Type their username.');
      if (!(Number(amount) > 0)) throw new Error('How much MON?');
      if (preview) { onSent(); return; }
      const u = await api<{ username: string; wallet: string }>(`/api/users/${encodeURIComponent(n)}`);
      const hash = await sendValue(account, u.wallet as `0x${string}`, parseEther(amount));
      await api('/api/tips', { body: { username: u.username, txHash: hash } });
      onSent();
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet onClose={onClose}>
      <h2 className="h2">Tip someone</h2>
      <p className="lede">Reward a call you liked. The MON goes straight to their wallet.</p>
      <label><span className="label">Username</span><input className="in" value={name} onChange={e => setName(e.target.value)} placeholder="@username" autoFocus /></label>
      <div className="amounts">{['1', '5', '10', '25'].map(a => <button key={a} className={amount === a ? 'on' : ''} onClick={() => setAmount(a)}>{a} MON</button>)}</div>
      <label><span className="label">Or another amount</span><input className="in" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="MON" /></label>
      {msg && <p className="err" role="alert">{msg}</p>}
      <div className="foot" style={{ paddingTop: 0 }}>
        <button className="btn" disabled={busy} onClick={send}>{busy ? 'Confirming…' : 'Send tip'}</button>
        <button className="text-btn" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}

/** A plain MON transfer from the in-app wallet. */
async function sendValue(account: any, to: `0x${string}`, value: bigint) {
  const { walletClientFor } = await import('../wallet');
  const { publicClient } = await import('../chain');
  const wc = await walletClientFor(account);
  const hash = await wc.sendTransaction({ to, value, account: account.address } as never);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('The transfer failed.');
  return hash;
}
