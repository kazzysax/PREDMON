import { useCallback, useEffect, useState } from 'react';
import { decodeEventLog, formatEther, parseEther } from 'viem';
import { api } from '../api';
import { useApp } from '../ctx';
import { ASSETS, commitmentFor, fromPrice, poolsAbi, publicClient, randomSalt, toPrice } from '../chain';
import { requireStepUp, sendAndWait } from '../wallet';
import { Avatar, Curve, Icon, Sheet, timeLeft, trimNum, when } from '../ui';

type Pool = {
  id: number; creator: { username?: string; wallet?: string }; asset: number; entryAmount: string;
  lockTime: number; resultTime: number; entries: number; revealed: number; priced: boolean;
  price: string | null; refunded: boolean; voided: boolean; pot: string; guesses?: string[];
};
type Mine = { poolId: number; entryId: number; guess: string; salt: `0x${string}` };

// Your sealed guesses are also kept in this browser, in case you want to reveal them yourself.
const storeKey = (w: string) => `predmon:guesses:${w.toLowerCase()}`;
const loadMine = (w: string): Mine[] => { try { return JSON.parse(localStorage.getItem(storeKey(w)) ?? '[]'); } catch { return []; } };
const saveMine = (w: string, list: Mine[]) => { try { localStorage.setItem(storeKey(w), JSON.stringify(list)); } catch { /* storage unavailable */ } };
const PREVIEW_MINE: Mine[] = [
  { poolId: 5, entryId: 31, guess: '52000000', salt: '0x00' },
  { poolId: 4, entryId: 12, guess: '412100000000', salt: '0x00' },
];

export function Pools() {
  const { account, preview } = useApp();
  const [pools, setPools] = useState<Pool[] | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [mine, setMine] = useState<Mine[]>(() => (preview ? PREVIEW_MINE : loadMine(account.address)));

  const load = useCallback(async () => {
    try { setPools((await api<{ pools: Pool[] }>('/api/pools')).pools); setErr(''); } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const addMine = (m: Mine) => { const next = [...mine, m]; setMine(next); saveMine(account.address, next); };

  return (
    <>
      <div className="page">
        <div>
          <h1 className="h1">Closest guess <em>wins.</em></h1>
          <p className="lede" style={{ marginTop: 10 }}>Everyone pays the same to get in and guesses a price. Guesses stay sealed until betting closes. The closest 30% split the pot.</p>
        </div>
        <button className="btn" onClick={() => setCreating(true)}>Open a pool</button>
        {err && <p className="err" role="alert">{err}</p>}
        {pools && pools.length === 0 && !err && <p className="empty"><b>Nothing here yet.</b>Open a pool. You could be the first.</p>}
        {pools?.map(p => <PoolCard key={p.id} pool={p} mine={mine.filter(m => m.poolId === p.id)} addMine={addMine} reload={load} />)}
      </div>
      {creating && <NewPool onDone={() => { setCreating(false); load(); }} onCancel={() => setCreating(false)} />}
    </>
  );
}

function NewPool({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { config, account } = useApp();
  const [asset, setAsset] = useState(0);
  const [at, setAt] = useState('');
  const [entry, setEntry] = useState('5');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setMsg(''); setBusy(true);
    try {
      const t = Math.floor(new Date(at).getTime() / 1000);
      if (!t) throw new Error('Pick the moment the price is read.');
      if (t < Date.now() / 1000 + 3.5 * 3600) throw new Error('The result time must be at least 3 and a half hours away.');
      if (!(Number(entry) > 0)) throw new Error('Set an entry price.');
      if (Number(entry) > Number(config.maxEntry)) throw new Error(`Entry can be at most ${trimNum(config.maxEntry)} MON.`);
      await sendAndWait(account, {
        address: config.addresses.pools, abi: poolsAbi, functionName: 'createPool',
        args: [asset, BigInt(t), parseEther(entry)], gas: 250_000n,
      });
      onDone();
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet onClose={onCancel}>
      <h2 className="h2">Open a pool</h2>
      <p className="lede">Pick what people guess, when it settles, and what it costs to get in.</p>
      <div className="amounts">
        {Object.entries(ASSETS).map(([id, n]) => <button key={id} className={asset === Number(id) ? 'on' : ''} onClick={() => setAsset(Number(id))}>{n}</button>)}
      </div>
      <label><span className="label">Settles</span>
        <input className="in" type="datetime-local" value={at} onChange={e => setAt(e.target.value)} />
      </label>
      <label><span className="label">Entry in MON, up to {trimNum(config.maxEntry)}</span>
        <input className="in" inputMode="decimal" value={entry} onChange={e => setEntry(e.target.value)} placeholder="0.10" />
      </label>
      {msg && <p className="err" role="alert">{msg}</p>}
      <p className="fine">Betting closes 3 hours before it settles. Three pools a day.</p>
      <div className="foot" style={{ paddingTop: 0 }}>
        <button className="btn" disabled={busy} onClick={create}>{busy ? 'Confirming…' : 'Open pool'}</button>
        <button className="text-btn" onClick={onCancel}>Cancel</button>
      </div>
    </Sheet>
  );
}

function PoolCard({ pool, mine, addMine, reload }: { pool: Pool; mine: Mine[]; addMine: (m: Mine) => void; reload: () => void }) {
  const { config, account, preview } = useApp();
  const [guess, setGuess] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [payouts, setPayouts] = useState<Record<number, bigint>>(preview && pool.priced ? { 12: 106_660000000000000000n } : {});
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000); return () => clearInterval(t); }, []);

  const refunding = pool.refunded || pool.voided;
  const open = !refunding && now < pool.lockTime;
  const revealWindow = !refunding && now >= pool.lockTime && now < pool.resultTime;
  const stage = pool.priced ? 3 : now >= pool.resultTime ? 2 : now >= pool.lockTime ? 1 : 0;
  const name = ASSETS[pool.asset] ?? `#${pool.asset}`;

  useEffect(() => {
    if (preview) return;
    (async () => {
      const out: Record<number, bigint> = {};
      for (const m of mine) {
        try {
          out[m.entryId] = await publicClient.readContract({
            address: config.addresses.pools, abi: poolsAbi, functionName: 'claimable', args: [BigInt(pool.id), BigInt(m.entryId)],
          }) as bigint;
        } catch { /* not readable yet */ }
      }
      setPayouts(out);
    })();
  }, [mine.length, pool.priced, pool.refunded, pool.revealed, now > pool.resultTime]);

  const enter = async () => {
    setMsg(''); setBusy(true);
    try {
      if (!guess || !(Number(guess) > 0)) throw new Error('Type the price you think it will be.');
      const g = toPrice(guess);
      const salt = randomSalt();
      const commitment = commitmentFor(g, salt, account.address, BigInt(pool.id));
      await requireStepUp(Number(pool.entryAmount));
      const rc = await sendAndWait(account, {
        address: config.addresses.pools, abi: poolsAbi, functionName: 'enter',
        args: [BigInt(pool.id), commitment], value: parseEther(pool.entryAmount), gas: 200_000n,
      });
      let entryId = 0;
      for (const log of rc.logs) {
        try {
          const ev = decodeEventLog({ abi: poolsAbi, data: log.data, topics: log.topics });
          if (ev.eventName === 'Entered') entryId = Number((ev.args as any).entryId);
        } catch { /* other event */ }
      }
      if (!entryId) throw new Error('You are in, but your entry number could not be read. Check your wallet history.');
      addMine({ poolId: pool.id, entryId, guess: g.toString(), salt });
      // Hand the sealed guess to the server so it can reveal it for you at lock time.
      try { await api(`/api/pools/${pool.id}/guess`, { body: { entryId, guess: g.toString(), salt } }); }
      catch { setMsg('You are in. Your guess could not be stored for auto-reveal, so come back and reveal it yourself once entries lock.'); }
      setGuess(''); reload();
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); } finally { setBusy(false); }
  };

  const reveal = async (m: Mine) => {
    setMsg('');
    try {
      await sendAndWait(account, {
        address: config.addresses.pools, abi: poolsAbi, functionName: 'reveal',
        args: [BigInt(pool.id), BigInt(m.entryId), BigInt(m.guess), m.salt], gas: 150_000n,
      });
      reload();
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); }
  };

  const claim = async (m: Mine) => {
    setMsg('');
    try {
      await requireStepUp(Number(formatEther(payouts[m.entryId] ?? 0n)));
      await sendAndWait(account, {
        address: config.addresses.pools, abi: poolsAbi, functionName: 'claim',
        args: [BigInt(pool.id), BigInt(m.entryId)], gas: 250_000n,
      });
      reload();
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); }
  };

  const left = timeLeft(pool.lockTime, now);

  const values = (pool.guesses ?? []).map(g => Number(g) / 1e8);
  const winners = Math.max(1, Math.floor((stage >= 1 ? pool.revealed : pool.entries) * 0.3));

  return (
    <article className="card">
      <div className="inner">
      <div className="tags">
        {refunding ? <span className="tag dim">Void</span>
          : pool.priced ? <span className="tag yes">Resolved</span>
          : open && left ? <span className={`tag ${pool.lockTime - now < 3600 ? 'soon' : ''}`}><Icon name="clock" />{left}</span>
          : <span className="tag dim"><Icon name="lock" />{stage === 1 ? 'Sealed' : 'Settling'}</span>}
        <span className="tag dim">{name} pool</span>
        <span className="tag dim end"><Icon name="people" />{pool.entries}</span>
      </div>

      <p className="said"><mark className="block" style={{ marginTop: 0 }}>Where will {name} be on {when(pool.resultTime)}?</mark></p>

      {values.length >= 3 && (
        <div>
          <Curve values={values} mark={pool.priced ? Number(pool.price) / 1e8 : null} />
          <p className="fine" style={{ marginTop: 6 }}>{pool.priced ? `Where everyone guessed. The dot is where ${name} landed.` : 'Where everyone guessed. The dot is the most common guess.'}</p>
        </div>
      )}

      <div className="owed">
        <div>
          <b>{pool.priced ? `$${fromPrice(pool.price!)}` : trimNum(pool.pot, 0)}{!pool.priced && <small>MON</small>}</b>
          <span>{pool.priced ? `${name} settled here` : 'in the pot'}</span>
        </div>
        <span className="small" style={{ textAlign: 'right', maxWidth: '15ch' }}>{refunding ? 'Stake refunded' : pool.priced ? `${trimNum(pool.pot, 0)} MON to the ${winners} closest` : `${winners} closest split it`}</span>
      </div>

      <div className="stats three">
        <div><b>{trimNum(pool.entryAmount)}</b><span>MON to get in</span></div>
        <div><b>{pool.entries}</b><span>who's in</span></div>
        <div><b>{winners}</b><span>{pool.priced ? 'won' : 'will win'}</span></div>
      </div>

      {!refunding && (
        <ol className="steps" aria-label="Where this pool is">
          {['Open', 'Sealed', 'Settling', 'Paid'].map((s, i) => <li key={s} className={i < stage ? 'done' : i === stage ? 'now' : ''}>{s}</li>)}
        </ol>
      )}

      {open && (
        <>
          <div className="entry">
            <input className="in" inputMode="decimal" value={guess} onChange={e => setGuess(e.target.value)} placeholder={`Your ${name} price, in USD`} aria-label={`Your ${name} price guess in dollars`} />
            <button className="btn sm" disabled={busy} onClick={enter}>{busy ? '…' : 'Get in'}</button>
          </div>
          <p className="fine">Sealed until betting closes. No edits.</p>
        </>
      )}

      {mine.map(m => (
        <div key={m.entryId} className="in-on">
          <i />You said ${fromPrice(m.guess)}
          {revealWindow && <button className="btn quiet sm" onClick={() => reveal(m)}>Reveal</button>}
          {(payouts[m.entryId] ?? 0n) > 0n && <button className="btn sm" onClick={() => claim(m)}>Collect {trimNum(formatEther(payouts[m.entryId]))} MON</button>}
        </div>
      ))}
      {msg && <p className="err" role="alert">{msg}</p>}
      </div>
      <footer className="under">
        <Avatar name={pool.creator.username ?? '?'} />
        <div className="txt">
          <b>@{pool.creator.username ?? pool.creator.wallet?.slice(0, 8)}</b>
          <span>Settles from the Chainlink price feed</span>
        </div>
        <span className="pillbtn">{trimNum(pool.entryAmount)} MON to get in</span>
      </footer>
    </article>
  );
}
