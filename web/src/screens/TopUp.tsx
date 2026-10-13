// Adding MON from another chain, built on NEAR Intents' public 1Click service.
// Three plain steps: how much, a live quote, then one deposit address with a QR code and live progress.
import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';

const API = 'https://1click.chaindefuser.com/v0';
type Tok = { assetId: string; symbol: string; blockchain: string; decimals: number; price: number };
type Quote = { minAmountIn?: string; amountInFormatted: string; amountOutFormatted: string; amountInUsd?: string; amountOutUsd?: string; timeEstimate?: number; minAmountOut?: string; depositAddress?: string; deadline?: string };

const EVM = new Set(['eth', 'base', 'arb', 'op', 'monad', 'bsc', 'pol', 'avax']);
const validAddr = (chain: string, a: string) =>
  EVM.has(chain) ? /^0x[0-9a-fA-F]{40}$/.test(a) : chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) : /^[a-z0-9._-]{2,64}$/.test(a);
const toUnits = (v: string, d: number) => { const [i, f = ''] = v.split('.'); return (BigInt(i || '0') * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d))).toString(); };
const nice = (s?: string, dp = 2) => { const n = Number(s); return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 1 : dp }) : '—'; };

let tokenCache: Tok[] | null = null;
async function tokens() { if (!tokenCache) tokenCache = await (await fetch(`${API}/tokens`)).json(); return tokenCache!; }

async function post(body: object) {
  const r = await fetch(`${API}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(friendly(j?.message ?? ''));
  return j;
}
function friendly(m: string) {
  if (/amount.*(low|small)|minimum/i.test(m)) return 'That amount is too small to swap. Try a little more.';
  if (/liquid|no route|not enough/i.test(m)) return 'No route for that amount right now. Try a different amount or token.';
  return 'We couldn\'t get a quote just now. Please try again in a moment.';
}

export default function TopUp({ address, chain, symbol, chainLabel }: { address: string; chain: string; symbol: string; chainLabel: string; injectedRefund?: string }) {
  const [origin, setOrigin] = useState<Tok | null>(null);
  const [dest, setDest] = useState<Tok | null>(null);
  const [amount, setAmount] = useState('');
  const [refund, setRefund] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [qBusy, setQBusy] = useState(false);
  const [err, setErr] = useState('');
  const [live, setLive] = useState<Quote | null>(null);
  const [status, setStatus] = useState('');
  const [got, setGot] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState('');
  const seq = useRef(0);

  useEffect(() => { tokens().then(t => {
    setOrigin(t.find(x => x.symbol === symbol && x.blockchain === chain) ?? null);
    setDest(t.find(x => x.symbol === 'MON' && x.blockchain === 'monad') ?? null);
  }).catch(() => setErr('Couldn\'t load the token list. Check your connection and reopen this screen.')); }, [chain, symbol]);

  const usdHint = useMemo(() => origin && Number(amount) > 0 ? `≈ $${nice(String(Number(amount) * origin.price))}` : '', [origin, amount]);

  const base = (dry: boolean, to: string) => origin && dest ? ({
    dry, swapType: 'FLEX_INPUT', slippageTolerance: 300, originAsset: origin.assetId, depositType: 'ORIGIN_CHAIN', destinationAsset: dest.assetId,
    amount: toUnits(amount, origin.decimals), refundTo: to, refundType: 'ORIGIN_CHAIN', recipient: address, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 30 * 60e3).toISOString(),
  }) : null;

  // A live estimate as the amount is typed.
  useEffect(() => {
    setQuote(null); setErr('');
    if (!origin || !dest || !(Number(amount) > 0)) return;
    const my = ++seq.current; setQBusy(true);
    const t = setTimeout(async () => {
      try { const j = await post(base(true, EVM.has(chain) ? '0x2A55D842c097Dd323a212F561b1Fab39b738E62f' : '0x2A55D842c097Dd323a212F561b1Fab39b738E62f')!); if (my === seq.current) setQuote(j.quote); }
      catch (e: any) { if (my === seq.current) setErr(e.message); }
      finally { if (my === seq.current) setQBusy(false); }
    }, 500);
    return () => clearTimeout(t);
  }, [amount, origin, dest]);

  const start = async () => {
    setErr('');
    if (!validAddr(chain, refund.trim())) { setErr(`Enter your own ${chainLabel} address, the one you are sending from.`); return; }
    if (refund.trim().toLowerCase() === address.toLowerCase()) { setErr('That is your PredTube address. Use the wallet you are paying from, so a refund comes back to you.'); return; }
    setQBusy(true);
    try { const j = await post(base(false, refund.trim())!); setLive({ ...j.quote, deadline: j.quoteRequest?.deadline }); setStatus('PENDING_DEPOSIT'); }
    catch (e: any) { setErr(e.message); } finally { setQBusy(false); }
  };

  // Follow the deposit until the MON lands.
  useEffect(() => {
    if (!live?.depositAddress || ['SUCCESS', 'REFUNDED', 'FAILED'].includes(status)) return;
    const id = setInterval(async () => {
      try { const j = await (await fetch(`${API}/status?depositAddress=${live.depositAddress}`)).json(); if (j?.status) setStatus(j.status); const d = Number(j?.swapDetails?.depositedAmountFormatted); if (Number.isFinite(d)) setGot(d); } catch { /* keep trying */ }
    }, 4000);
    return () => clearInterval(id);
  }, [live, status]);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const copy = (what: string, text: string) => { navigator.clipboard?.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 1400); };

  if (!origin || !dest) return <p className="empty">{err || 'Loading…'}</p>;

  // Step 3: where to send.
  if (live?.depositAddress) {
    const qr = qrcode(0, 'M'); qr.addData(live.depositAddress); qr.make();
    const steps: [string, string[]][] = [['Waiting for your deposit', ['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT']], ['Swapping', ['KNOWN_DEPOSIT_TX', 'PROCESSING']], ['MON in your wallet', ['SUCCESS']]];
    const at = steps.findIndex(s => s[1].includes(status));
    return (
      <div className="topup">
        {status === 'SUCCESS' ? (
          <div className="tu-done"><b>MON added</b><span>About {nice(live.amountOutFormatted)} MON is in your wallet.</span></div>
        ) : status === 'REFUNDED' || status === 'FAILED' ? (
          <div className="tu-done bad"><b>{status === 'REFUNDED' ? 'Refunded' : 'It didn\'t go through'}</b><span>{status === 'REFUNDED' ? `Your ${symbol} was sent back to ${refund.slice(0, 6)}…${refund.slice(-4)}.` : 'Nothing was swapped. If you sent funds they return to your refund address.'}</span></div>
        ) : (
          <>
            <p className="tu-send">Send <b>{live.amountInFormatted} {symbol}</b> on <b>{chainLabel}</b> to:</p>
            <div className="tu-qr" dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }} />
            <div className="tu-addr"><code>{live.depositAddress}</code></div>
            <div className="tu-row">
              <button className="btn quiet sm" onClick={() => copy('addr', live.depositAddress!)}>{copied === 'addr' ? 'Copied' : 'Copy address'}</button>
              <button className="btn quiet sm" onClick={() => copy('amt', live.amountInFormatted)}>{copied === 'amt' ? 'Copied' : 'Copy amount'}</button>
            </div>
            <p className="info">Send only {symbol} on {chainLabel}. You get about {nice(live.amountOutFormatted)} MON, usually within a minute. Anything from {nice(String(Number(live.amountInFormatted) * 0.97), 3)} up is swapped, so a small fee on your side is fine. This address is for this order only.</p>
            {live.deadline && <p className="tu-hint" style={{ textAlign: 'center' }}>{(() => { const left = Math.max(0, Math.floor((new Date(live.deadline).getTime() - now) / 1000)); return left > 0 ? `Open for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more. Send before then.` : 'This order has expired. Do not send anything. Close and start again.'; })()}</p>}
            {status === 'INCOMPLETE_DEPOSIT' && <p className="err" role="alert">We received {nice(String(got), 3)} {symbol}, which is less than {nice(String(Number(live.amountInFormatted) * 0.97), 3)}. Send at least {nice(String(Math.max(0.01, Number(live.amountInFormatted) * 0.97 - got + 0.01)), 3)} {symbol} more to the same address to finish.</p>}
          </>
        )}
        <ol className="tu-steps">{steps.map((s, i) => <li key={i} className={i < at || status === 'SUCCESS' ? 'done' : i === at ? 'now' : ''}>{s[0]}</li>)}</ol>
      </div>
    );
  }

  // Steps 1 and 2: amount, estimate, refund address.
  return (
    <div className="topup">
      <label><span className="label">You pay</span>
        <div className="tu-amt"><input className="in" inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} autoFocus /><span>{symbol}</span></div>
        {usdHint && <span className="tu-hint">{usdHint}</span>}
      </label>
      <div className="tu-get">
        <span>You get</span>
        <b>{qBusy ? '…' : quote ? `≈ ${nice(quote.amountOutFormatted)} MON` : '—'}</b>
        {quote && <span className="tu-hint">{quote.timeEstimate ? `About ${quote.timeEstimate}s` : ''}{quote.amountOutUsd ? ` · $${nice(quote.amountOutUsd)}` : ''}</span>}
      </div>
      <label><span className="label">Your {chainLabel} wallet, the one you pay from</span>
        <input className="in" value={refund} onChange={e => setRefund(e.target.value)} placeholder={`Your ${chainLabel} address`} spellCheck={false} />
        <span className="tu-hint">If anything goes wrong, your {symbol} is sent back here. Do not use your PredTube address; it can only hold MON.</span>
      </label>
      {err && <p className="err" role="alert">{err}</p>}
      <button className="btn" disabled={!quote || qBusy} onClick={start}>{qBusy ? 'Getting your quote…' : 'Get deposit address'}</button>
    </div>
  );
}
