import { useCallback, useEffect, useState } from 'react';
import { decodeEventLog, formatEther, parseEther } from 'viem';
import { api } from '../api';
import { useApp } from '../ctx';
import { ASSETS, OPEN_ASSET, commitmentFor, fromPrice, poolsAbi, publicClient, randomSalt, toPrice } from '../chain';
import { requireStepUp, sendAndWait } from '../wallet';
import { Avatar, Curve, Icon, Sheet, timeLeft, trimNum, when } from '../ui';

type Question = { question: string; unit: string; source: string; resultTime: number };
type Pool = {
  id: number; creator: { username?: string; wallet?: string }; asset: number; entryAmount: string;
  lockTime: number; resultTime: number; entries: number; revealed: number; priced: boolean;
  price: string | null; refunded: boolean; voided: boolean; pot: string; guesses?: string[];
  question?: Question | null; creatorFee?: string; creatorFeePaid?: boolean;
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

/** The multiplier ladder the contract pays: x2.9 falling to x0.3 at the halfway mark, x0.3 below it. */
const ladder = (n: number) => {
  const t = Math.max(1, Math.floor(n / 2));
  const d = t > 1 ? t - 1 : 1;
  const w = (r: number) => (r < t ? 290 * d - 260 * r : 30 * d);
  let total = 0; for (let r = 0; r < n; r++) total += w(r);
  return (r: number) => (total ? (0.95 * n * w(r)) / total : 0);
};
const isOpen = (p: Pool) => p.asset === OPEN_ASSET;
const unitOf = (p: Pool) => (isOpen(p) ? p.question?.unit ?? '' : 'USD');
const showNum = (p: Pool, raw: string | bigint) => (isOpen(p) ? (Number(raw) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 }) : `$${fromPrice(raw)}`);

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
          <h1 className="h1">Get closest to <em>the number.</em></h1>
          <p className="lede" style={{ marginTop: 10 }}>Anyone can ask a question with a number for an answer: Bitcoin in an hour, a match score, a date. Everyone puts in the same amount and locks a guess. The closer you land, the bigger your multiplier, from about ×2.9 down to ×0.3. The person who opened the pool earns 5%.</p>
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
  const [kind, setKind] = useState<'open' | number>('open');
  const [question, setQuestion] = useState('');
  const [at, setAt] = useState('');
  const [entry, setEntry] = useState('50');
  const [checked, setChecked] = useState<{ hash: `0x${string}`; terms: Question } | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const when_ = () => {
    const t = Math.floor(new Date(at).getTime() / 1000);
    if (!t) throw new Error('Pick the moment the answer is read.');
    if (t < Date.now() / 1000 + 3.5 * 3600) throw new Error('The result time must be at least 3 and a half hours away.');
    return t;
  };
  const amount = () => {
    const n = Number(entry);
    if (!(n >= 50 && n <= 1000)) throw new Error('The entry has to be between 50 and 1000 MON.');
    if (n > Number(config.maxEntry)) throw new Error(`Entry can be at most ${trimNum(config.maxEntry)} MON right now.`);
    return parseEther(entry);
  };

  const check = async () => {
    setMsg(''); setBusy(true);
    try {
      const t = when_(); amount();
      if (question.trim().length < 10) throw new Error('Ask your question in a few words, for example "How many goals will Man City score on Saturday?"');
      const r = await api<any>('/api/pools/check', { body: { question, resultTime: t } });
      if (!r.ok) setMsg(r.reason); else setChecked({ hash: r.hash, terms: r.terms });
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };

  const open = async (asset: number, hash: `0x${string}`) => {
    const t = when_();
    await sendAndWait(account, {
      address: config.addresses.pools, abi: poolsAbi, functionName: 'createPool',
      args: [asset, BigInt(t), amount(), hash], gas: 300_000n,
    });
    onDone();
  };
  const create = async () => {
    setMsg(''); setBusy(true);
    try {
      if (kind === 'open') { if (!checked) return; await open(OPEN_ASSET, checked.hash); }
      else await open(kind, '0x0000000000000000000000000000000000000000000000000000000000000000');
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); } finally { setBusy(false); }
  };

  if (checked && kind === 'open') {
    return (
      <Sheet onClose={onCancel}>
        <h2 className="h2">This is how it settles</h2>
        <dl className="terms">
          <div><dt>Question</dt><dd>{checked.terms.question}</dd></div>
          <div className="two"><div><dt>Answer is a number in</dt><dd>{checked.terms.unit}</dd></div><div><dt>Entry</dt><dd>{trimNum(entry)} MON</dd></div></div>
          <div><dt>Settled from</dt><dd>{checked.terms.source}</dd></div>
          <div><dt>Answer is read</dt><dd>{when(checked.terms.resultTime)}</dd></div>
        </dl>
        <p className="small">Once it is open there are no edits. You earn 5% of the pot when it pays out. If the answer can't be found from a public source, everyone gets their entry back.</p>
        {msg && <p className="err" role="alert">{msg}</p>}
        <div className="foot" style={{ paddingTop: 4 }}>
          <button className="btn" disabled={busy} onClick={create}>{busy ? 'Confirming…' : 'Open pool'}</button>
          <button className="text-btn" disabled={busy} onClick={() => setChecked(null)}>Back, let me reword it</button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet onClose={onCancel}>
      <h2 className="h2">Open a pool</h2>
      <p className="lede">Ask something with a number for an answer. Everyone enters the same amount and guesses it.</p>
      <div className="amounts">
        <button className={kind === 'open' ? 'on' : ''} onClick={() => setKind('open')}>Any question</button>
        {Object.entries(ASSETS).map(([id, n]) => <button key={id} className={kind === Number(id) ? 'on' : ''} onClick={() => setKind(Number(id))}>{n} price</button>)}
      </div>
      {kind === 'open' && (
        <label><span className="label">Your question</span>
          <textarea className="in" value={question} onChange={e => setQuestion(e.target.value)} maxLength={400}
            placeholder="How many goals will Man City score on Saturday?" aria-label="Your question" />
        </label>
      )}
      <label><span className="label">The answer is read</span>
        <input className="in" type="datetime-local" value={at} onChange={e => setAt(e.target.value)} />
      </label>
      <label><span className="label">Everyone pays, between 50 and 1000 MON</span>
        <input className="in" inputMode="decimal" value={entry} onChange={e => setEntry(e.target.value)} placeholder="50" />
      </label>
      {msg && <p className="err" role="alert">{msg}</p>}
      <p className="fine">Entries close 3 hours before the answer is read. Three pools a day.</p>
      <div className="foot" style={{ paddingTop: 0 }}>
        {kind === 'open'
          ? <button className="btn" disabled={busy} onClick={check}>{busy ? 'Reading it…' : 'Continue'}</button>
          : <button className="btn" disabled={busy} onClick={create}>{busy ? 'Confirming…' : 'Open pool'}</button>}
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
  const unit = unitOf(pool);
  const title = isOpen(pool) ? pool.question?.question ?? 'A question with a number for an answer' : `Where will ${ASSETS[pool.asset] ?? `#${pool.asset}`} be on ${when(pool.resultTime)}?`;
  const iAmCreator = !!pool.creator.wallet && pool.creator.wallet.toLowerCase() === account.address.toLowerCase();

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
      if (guess.trim() === '' || !(Number(guess) >= 0)) throw new Error(`Type the number you think it will be${unit ? `, in ${unit}` : ''}.`);
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

  const takeFee = async () => {
    setMsg(''); setBusy(true);
    try {
      await sendAndWait(account, { address: config.addresses.pools, abi: poolsAbi, functionName: 'claimCreatorFee', args: [BigInt(pool.id)], gas: 150_000n });
      reload();
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); } finally { setBusy(false); }
  };

  const left = timeLeft(pool.lockTime, now);
  const values = (pool.guesses ?? []).map(g => Number(g) / 1e8);
  const n = stage >= 1 ? pool.revealed : pool.entries;
  const mult = ladder(Math.max(n, 2));
  const entryNum = Number(pool.entryAmount);
  const players = Number(pool.pot) * 0.95;

  return (
    <article className="card">
      <div className="inner">
      <div className="tags">
        {refunding ? <span className="tag dim">Void</span>
          : pool.priced ? <span className="tag yes">Resolved</span>
          : open && left ? <span className={`tag ${pool.lockTime - now < 3600 ? 'soon' : ''}`}><Icon name="clock" />{left}</span>
          : <span className="tag dim"><Icon name="lock" />{stage === 1 ? 'Sealed' : 'Settling'}</span>}
        <span className="tag dim">{isOpen(pool) ? 'Number pool' : `${ASSETS[pool.asset] ?? `#${pool.asset}`} pool`}</span>
        <span className="tag dim end"><Icon name="people" />{pool.entries}</span>
      </div>

      <p className="said"><mark className="block" style={{ marginTop: 0 }}>{title}</mark></p>
      {isOpen(pool) && pool.question && <p className="fine">Answer in {pool.question.unit}. Settled from {pool.question.source}. Read {when(pool.resultTime)}.</p>}

      {values.length >= 3 && (
        <div>
          <Curve values={values} mark={pool.priced ? Number(pool.price) / 1e8 : null} />
          <p className="fine" style={{ marginTop: 6 }}>{pool.priced ? 'Where everyone guessed. The dot is the real answer.' : 'Where everyone guessed. The dot is the most common guess.'}</p>
        </div>
      )}

      <div className="owed">
        <div>
          <b>{pool.priced ? showNum(pool, pool.price!) : trimNum(pool.pot, 0)}{!pool.priced && <small>MON</small>}</b>
          <span>{pool.priced ? `the answer${unit && isOpen(pool) ? ` (${unit})` : ''}` : 'in the pot'}</span>
        </div>
        <span className="small" style={{ textAlign: 'right', maxWidth: '16ch' }}>{refunding ? 'Entries refunded' : `${trimNum(players, 0)} MON shared by closeness`}</span>
      </div>

      <div className="ladder-row" aria-label="What each place pays">
        <div><b>×{mult(0).toFixed(1)}</b><span>closest</span></div>
        <div><b>×{mult(Math.max(0, Math.floor(n / 4))).toFixed(1)}</b><span>near</span></div>
        <div><b>×0.3</b><span>bottom half</span></div>
      </div>
      <p className="fine">Entry {trimNum(entryNum)} MON. Opener earns 5%. Multipliers are for {Math.max(n, 2)} players and adjust as people join.</p>

      {!refunding && (
        <ol className="steps" aria-label="Where this pool is">
          {['Open', 'Sealed', 'Settling', 'Paid'].map((s, i) => <li key={s} className={i < stage ? 'done' : i === stage ? 'now' : ''}>{s}</li>)}
        </ol>
      )}

      {open && (
        <>
          <div className="entry">
            <input className="in" inputMode="decimal" value={guess} onChange={e => setGuess(e.target.value)} placeholder={`Your number${unit ? `, in ${unit}` : ''}`} aria-label="Your guess" />
            <button className="btn sm" disabled={busy} onClick={enter}>{busy ? '…' : `Get in · ${trimNum(entryNum)} MON`}</button>
          </div>
          <p className="fine">Sealed until entries close. No edits.</p>
        </>
      )}

      {mine.map(m => (
        <div key={m.entryId} className="in-on">
          <i />You said {showNum(pool, m.guess)}
          {revealWindow && <button className="btn quiet sm" onClick={() => reveal(m)}>Reveal</button>}
          {(payouts[m.entryId] ?? 0n) > 0n && <button className="btn sm" onClick={() => claim(m)}>Collect {trimNum(formatEther(payouts[m.entryId]))} MON</button>}
        </div>
      ))}

      {iAmCreator && pool.priced && !pool.refunded && !pool.creatorFeePaid && Number(pool.creatorFee) > 0 && (
        <div className="owed">
          <div><b>{trimNum(pool.creatorFee ?? '0')}<small>MON</small></b><span>your 5% for opening it</span></div>
          <button className="btn sm" disabled={busy} onClick={takeFee}>{busy ? 'Confirming…' : 'Collect'}</button>
        </div>
      )}
      {msg && <p className="err" role="alert">{msg}</p>}
      </div>
      <footer className="under">
        <Avatar name={pool.creator.username ?? '?'} />
        <div className="txt">
          <b>@{pool.creator.username ?? pool.creator.wallet?.slice(0, 8)}</b>
          <span>{isOpen(pool) ? 'Settled by the AI resolver, with sources' : 'Settles from the Chainlink price feed'}</span>
        </div>
        <span className="pillbtn">{trimNum(pool.entryAmount)} MON to get in</span>
      </footer>
    </article>
  );
}
