import { useCallback, useEffect, useState } from 'react';
import { formatEther, parseEther } from 'viem';
import { api } from '../api';
import { useApp } from '../ctx';
import { callsAbi, prizesAbi, publicClient } from '../chain';
import { requireStepUp, sendAndWait, walletClientFor } from '../wallet';
import { Avatar, Icon, PostBody, Sheet, Verified, timeLeft, trimNum, when } from '../ui';

type Terms = { post?: string; highlight?: string; question: string; yesMeans: string; noMeans: string; source: string };
type Call = {
  id: number; terms: Terms; category: number; categoryName: string;
  creator: { username: string; xVerified: boolean; avatar?: string | null } | null;
  opensAt: number; locksAt: number; closesAt: number; state: 'open' | 'proposed' | 'finalized' | 'void';
  outcome: number; voteCount: number; viewerVoted: boolean; viewerSide?: 'yes' | 'no' | null;
  yesWeight?: number; noWeight?: number; yesPool?: string; noPool?: string; claimable?: string;
  evidence?: { reasoning: string; evidence: { title: string; url: string }[] };
};

const LIVES = [{ label: '1 hour', sec: 3600 }, { label: '6 hours', sec: 6 * 3600 }, { label: '1 day', sec: 86400 }, { label: '3 days', sec: 3 * 86400 }, { label: '7 days', sec: 7 * 86400 }, { label: '14 days', sec: 14 * 86400 }, { label: '30 days', sec: 30 * 86400 }];
const STAKES = ['Free', '5', '25', '100'];
/** Only offer amounts the contract will accept; the cap is set on chain and can change. */
const stakeChoices = (cap: number) => {
  const ok = ['1', '5', '25', '100'].filter(v => Number(v) <= cap);
  if (cap < 1) return ['Free', String(Math.max(cap, 0.01))];
  return ['Free', ...(ok.length ? ok : ['1'])];
};


type Rep = { category: number; name: string; score: number; scored: number; won: number };
const repCache = new Map<string, Promise<Rep[]>>();
/** A person's public record, fetched once per name. */
const repFor = (username?: string | null): Promise<Rep[]> => {
  if (!username) return Promise.resolve([]);
  if (!repCache.has(username)) repCache.set(username, api<{ reputation: Rep[] }>(`/api/users/${encodeURIComponent(username)}`).then(r => r.reputation ?? []).catch(() => []));
  return repCache.get(username)!;
};
/** Mirrors the contract: reputation gives 1x to 2x, and an early vote gets up to 1.2x on top, sliding to 1x at lock. */
export const voteWeight = (score: number, opensAt: number, locksAt: number, now: number) => {
  const rep = 1 + Math.min(Math.max(score, 0), 100) / 100;
  const span = locksAt - opensAt;
  const early = span > 0 && now < locksAt ? 1 + (0.2 * (locksAt - now)) / span : 1;
  return rep * early;
};
const fmtX = (n: number) => `${n.toFixed(2).replace(/0$/, '')}x`;

/** The top of the entry page: where you stand, and why it matters more than money here. */
function Standing({ category }: { category: string }) {
  const { me, config } = useApp();
  const reps = me.reputation ?? [];
  const cat = category !== '' ? Number(category) : [...reps].sort((a, b) => b.score - a.score)[0]?.category ?? 0;
  const r = reps.find(x => x.category === cat) ?? { score: 0, scored: 0, won: 0, name: config.categories[cat] ?? '' };
  const mult = 1 + Math.min(Math.max(r.score, 0), 100) / 100;
  const pct = r.scored ? Math.round((r.won / r.scored) * 100) : 0;
  return (
    <section className="standing" aria-label="Your standing">
      <div className="st-top">
        <span className="cap">Your standing in {config.categories[cat]}</span>
        <span className="st-rec">{r.scored ? `${r.won} of ${r.scored} right` : 'No record yet'}</span>
      </div>
      <div className="st-main">
        <div><b className="num st-score">{r.score.toFixed(1)}</b><span>reputation</span></div>
        <div><b className="num st-mult">{fmtX(mult)}</b><span>vote weight</span></div>
        <div><b className="num st-pct">{r.scored ? `${pct}%` : '—'}</b><span>hit rate</span></div>
      </div>
      <div className="st-bar" aria-hidden><i style={{ width: `${Math.min(Math.max(r.score, 0), 100)}%` }} /></div>
      <p className="st-why">{r.scored ? 'Every call you get right raises this, and a higher number pulls the room harder.' : 'Take a side on your first call. Being right early is how you build a name here.'} MON can back a call, but it never moves the bar.</p>
    </section>
  );
}

/** Who to listen to: the best record in the category being browsed. */
function Leaders({ category, onOpen }: { category: string; onOpen: () => void }) {
  const { config, me } = useApp();
  const cat = category !== '' ? Number(category) : 0;
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { setRows(null); api<{ board: any[] }>(`/api/leaderboard?category=${cat}`).then(r => setRows(r.board.slice(0, 6))).catch(() => setRows([])); }, [cat]);
  if (!rows || rows.length === 0) return null;
  return (
    <section className="leaders" aria-label="Top callers">
      <div className="ld-head"><span className="cap">Top callers · {config.categories[cat]}</span><button className="text-btn" onClick={onOpen}>See all</button></div>
      <div className="ld-row">
        {rows.map((r, i) => (
          <div key={r.username} className="ld">
            <span className="ld-pos">{i + 1}</span>
            <Avatar name={r.username} src={r.avatar} size="sm" />
            <b>@{r.username}</b>
            <span className="num">{r.score.toFixed(1)}</span>
            <small>{r.won}/{r.scored} right</small>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Calls({ composing, setComposing, openPeople }: { composing: boolean; setComposing: (v: boolean) => void; openPeople?: () => void }) {
  const { config } = useApp();
  const [feed, setFeed] = useState<'explore' | 'following' | 'top'>('explore');
  const [category, setCategory] = useState('');
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ feed: feed === 'following' ? 'following' : 'explore', ...(category ? { category } : {}) });
      let list = (await api<{ calls: Call[] }>(`/api/calls?${q}`)).calls;
      if (feed === 'top') {
        // Best record first: order by the author's reputation in the call's own category.
        const score = new Map<number, number>();
        await Promise.all(list.map(async c => { score.set(c.id, (await repFor(c.creator?.username)).find(r => r.category === c.category)?.score ?? 0); }));
        list = [...list].sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0));
      }
      setCalls(list);
      setErr('');
    } catch (e: any) { setErr(e.message); }
  }, [feed, category]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="filters">
        <button className={`filter lead ${feed === 'explore' ? 'on' : ''}`} onClick={() => setFeed('explore')}>Explore</button>
        <button className={`filter lead ${feed === 'top' ? 'on' : ''}`} onClick={() => setFeed('top')}>Top callers</button>
        <button className={`filter lead ${feed === 'following' ? 'on' : ''}`} onClick={() => setFeed('following')}>Following</button>
      </div>
      <div className="filters" style={{ paddingTop: 8, paddingBottom: 14 }}>
        <button className={`filter ${category === '' ? 'on' : ''}`} onClick={() => setCategory('')}>All</button>
        {config.categories.map((c, i) => (
          <button key={c} className={`filter ${category === String(i) ? 'on' : ''}`} onClick={() => setCategory(String(i))}>{c}</button>
        ))}
      </div>
      <div className="page draw">
        <Standing category={category} />
        <Leaders category={category} onOpen={() => openPeople?.()} />
        {err && <p className="err" role="alert">{err}</p>}
        {calls && calls.length === 0 && !err && (
          feed === 'following'
            ? <p className="empty"><b>Follow people with a record</b>Find them under People. Their calls land here.</p>
            : <p className="empty"><b>No calls posted yet.</b>Tap + and make a call. You could be the first.</p>
        )}
        {calls?.map(c => <CallCard key={c.id} call={c} reload={load} />)}
      </div>
      {composing && <Composer onClose={() => setComposing(false)} onCreated={() => { setComposing(false); load(); }} />}
    </>
  );
}

function Composer({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const { config, account } = useApp();
  const [prize, setPrize] = useState('');
  const [posted, setPosted] = useState<{ id: number; failed: string } | null>(null);
  const [post, setPost] = useState('');
  const [life, setLife] = useState(86400);
  const [draft, setDraft] = useState<{ draftId: string; terms: Terms } | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api('/api/calls/draft', { body: { post, lifeSec: life } });
      if (!r.ok) setMsg(r.reason); else setDraft(r);
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const made = await api<{ id: number }>('/api/calls/confirm', { body: { draftId: draft.draftId } });
      const amount = Number(prize);
      if (amount > 0 && config.addresses.prizes) {
        try {
          await sendAndWait(account, { address: config.addresses.prizes, abi: prizesAbi, functionName: 'addPrize', args: [BigInt(made.id)], value: parseEther(prize), gas: 200_000n });
        } catch (e: any) {
          // The post is already up. Say so plainly instead of pretending nothing happened.
          setPosted({ id: made.id, failed: e.shortMessage ?? e.message }); return;
        }
      }
      onCreated();
    }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };

  const prizeOk = prize === '' || (Number(prize) > 0 && Number(prize) <= 100000);
  const prizeNote = Number(prize) > 0 ? `${trimNum(prize)} MON prize, shared equally by everyone on the winning side.` : '';

  if (posted) {
    return (
      <Sheet onClose={onCreated}>
        <h2 className="h2">Your post is up.</h2>
        <p className="err" role="alert">The prize did not go through: {posted.failed}</p>
        <p className="small">Nothing was taken from your balance. Prizes can only be set when a post is made, so this one stays without a prize.</p>
        <div className="foot" style={{ paddingTop: 4 }}><button className="btn" onClick={onCreated}>Done</button></div>
      </Sheet>
    );
  }

  if (draft) {
    return (
      <Sheet onClose={onClose}>
        <h2 className="h2">This is how it settles</h2>
        <PostBody post={draft.terms.post} highlight={draft.terms.highlight} question={draft.terms.question} lg />
        <TermsBox terms={draft.terms} />
        {prizeNote && <p className="info"><b>Prize.</b> {prizeNote} It is sent when you post and cannot be changed.</p>}
        <p className="small">Your words are what gets posted. The underlined line is the call. Once it's up: no edits.</p>
        {msg && <p className="err" role="alert">{msg}</p>}
        <div className="foot" style={{ paddingTop: 4 }}>
          <button className="btn" disabled={busy} onClick={confirm}>{busy ? 'Posting…' : 'Post it'}</button>
          <button className="text-btn" disabled={busy} onClick={() => setDraft(null)}>Back, let me reword it</button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet onClose={onClose}>
      <h2 className="h2">Make your post. <em>See what people have to say.</em></h2>
      <p className="lede">Write it the way you would say it. Others vote and back it with MON, and you watch where the room stands. We show you how it settles before it goes up.</p>
      <textarea className="in" value={post} onChange={e => setPost(e.target.value)} maxLength={1500} autoFocus
        placeholder="good morning, what do you reckon BTC does in the next hour?" aria-label="Your call" />
      <div>
        <span className="label">Betting closes in</span>
        <div className="amounts">
          {LIVES.map(l => <button key={l.sec} className={life === l.sec ? 'on' : ''} onClick={() => setLife(l.sec)}>{l.label}</button>)}
        </div>
      </div>
      {config.addresses.prizes && (
        <div>
          <span className="label">Prize for the winners <small>(optional)</small></span>
          <div className="entry">
            <input className="in" inputMode="decimal" value={prize} onChange={e => setPrize(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="MON, leave empty for none" aria-label="Prize in MON" />
          </div>
          <p className="fine">Shared equally by everyone on the winning side. Set now, not editable later.</p>
        </div>
      )}
      {msg && <p className="err" role="alert">{msg}</p>}
      <div className="foot" style={{ paddingTop: 4 }}>
        <button className="btn" disabled={busy || post.trim().length < 10 || !prizeOk} onClick={check}>{busy ? 'Reading it…' : 'Continue'}</button>
        <button className="text-btn" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}

/** A prize on a post: MON from a sponsor, split equally between everyone on the winning side. */
function PrizeBox({ call }: { call: Call }) {
  const { config, account, preview } = useApp();
  const prizes = config.addresses.prizes;
  const [total, setTotal] = useState(0n);
  const [winners, setWinners] = useState(0);
  const [share, setShare] = useState(0n);
  const [endsAt, setEndsAt] = useState(0);
  const [reg, setReg] = useState(false);
  const [paid, setPaid] = useState(false);
  const [mine, setMine] = useState(0n);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);
  const now = Math.floor(Date.now() / 1000);

  useEffect(() => {
    if (!prizes || preview) return;
    (async () => {
      try {
        const id = BigInt(call.id);
        const rd = <T,>(functionName: string, args: any[]) => publicClient.readContract({ address: prizes, abi: prizesAbi, functionName: functionName as any, args: args as any }) as Promise<T>;
        const [p, r, pd, sp] = await Promise.all([
          rd<readonly [bigint, number]>('prizes', [id]), rd<boolean>('registered', [id, account.address]),
          rd<boolean>('paid', [id, account.address]), rd<bigint>('sponsored', [id, account.address]),
        ]);
        setTotal(p[0]); setWinners(Number(p[1])); setReg(r); setPaid(pd); setMine(sp);
        if (call.state === 'finalized') { setEndsAt(Number(await rd<bigint>('registrationEnds', [id]))); setShare(await rd<bigint>('shareOf', [id])); }
      } catch { /* prizes not readable yet */ }
    })();
  }, [call.id, call.state, tick, prizes]);

  if (!prizes || preview) return null;
  const voting = call.state === 'open' && now < call.locksAt;
  const iWon = call.state === 'finalized' && call.viewerSide === (call.outcome === 1 ? 'yes' : 'no');
  const windowOpen = call.state === 'finalized' && endsAt > now;
  const windowOver = call.state === 'finalized' && endsAt > 0 && endsAt <= now;
  if (total === 0n && mine === 0n) return null;

  const run = async (fn: 'register' | 'collect' | 'refund', value?: bigint) => {
    setMsg(''); setBusy(true);
    try {
      await sendAndWait(account, { address: prizes, abi: prizesAbi, functionName: fn, args: [BigInt(call.id)], value, gas: 200_000n });
      setTick(t => t + 1);
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); } finally { setBusy(false); }
  };

  return (
    <div className="prize">
      {total > 0n && (
        <div className="owed">
          <div><b>{trimNum(formatEther(total))}<small>MON</small></b><span>prize for the winning side</span></div>
          {windowOpen && iWon && !reg && <button className="btn sm" disabled={busy} onClick={() => run('register')}>{busy ? '…' : 'Claim a share'}</button>}
          {windowOpen && iWon && reg && <span className="small">You're in. Shares open {when(endsAt)}.</span>}
          {windowOver && reg && !paid && <button className="btn sm" disabled={busy} onClick={() => run('collect')}>{busy ? '…' : `Collect ${trimNum(formatEther(share))} MON`}</button>}
          {windowOver && reg && paid && <span className="small">Collected</span>}
        </div>
      )}
      {(call.state === 'void' || (windowOver && winners === 0)) && mine > 0n && (
        <button className="btn quiet sm" disabled={busy} onClick={() => run('refund')}>Take back your {trimNum(formatEther(mine))} MON</button>
      )}
      {voting && total > 0n && <p className="fine">Split equally between everyone on the winning side.</p>}
      {msg && <p className="err" role="alert">{msg}</p>}
    </div>
  );
}

function TermsBox({ terms, call }: { terms: Terms; call?: Call }) {
  return (
    <dl className="terms">
      <div><dt>Settles as</dt><dd>{terms.question}</dd></div>
      <div className="two">
        <div className="y"><dt>Counts as yes</dt><dd>{terms.yesMeans}</dd></div>
        <div className="n"><dt>Counts as no</dt><dd>{terms.noMeans}</dd></div>
      </div>
      <div><dt>Source</dt><dd>{terms.source}</dd></div>
      {call && (
        <div className="two">
          <div><dt>Betting closes</dt><dd>{when(call.locksAt)}</dd></div>
          <div><dt>Settles</dt><dd>{when(call.closesAt)}</dd></div>
        </div>
      )}
    </dl>
  );
}

function CallCard({ call, reload }: { call: Call; reload: () => void }) {
  const { config, account, preview } = useApp();
  const [msg, setMsg] = useState('');
  const [pick, setPick] = useState('Free');
  const [adding, setAdding] = useState(false);
  const [sheet, setSheet] = useState<'' | 'terms' | 'talk'>('');
  const [comments, setComments] = useState<any[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [claimable, setClaimable] = useState<bigint>(call.claimable ? parseEther(call.claimable) : 0n);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000); return () => clearInterval(t); }, []);
  const { me } = useApp();
  const [authorRep, setAuthorRep] = useState<Rep | null>(null);
  const [backing, setBacking] = useState(false);
  useEffect(() => { let on = true; repFor(call.creator?.username).then(r => { if (on) setAuthorRep(r.find(x => x.category === call.category) ?? null); }); return () => { on = false; }; }, [call.creator?.username, call.category]);
  const myScore = me.reputation?.find(r => r.category === call.category)?.score ?? 0;
  const myWeight = voteWeight(myScore, call.opensAt, call.locksAt, now);

  const voting = call.state === 'open' && now < call.locksAt;
  const settled = call.state === 'finalized' || call.state === 'void';
  const left = timeLeft(call.locksAt, now);

  useEffect(() => {
    if (!settled || preview) return;
    publicClient.readContract({ address: config.addresses.calls, abi: callsAbi, functionName: 'claimable', args: [BigInt(call.id), account.address] })
      .then(v => setClaimable(v as bigint)).catch(() => {});
  }, [call.state, call.id]);

  const openTalk = () => {
    setSheet('talk');
    if (!comments) api<{ comments: any[] }>(`/api/calls/${call.id}/comments`).then(r => setComments(r.comments)).catch(e => setMsg(e.message));
  };

  const freeVote = async (yes: boolean) => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    let sig = '0x';
    if (!preview) {
      const wc = await walletClientFor(account);
      sig = await wc.signTypedData({
        domain: { name: 'PredMon Calls', version: '1', chainId: config.chainId, verifyingContract: config.addresses.calls },
        types: { Vote: [
          { name: 'marketId', type: 'uint256' }, { name: 'yes', type: 'bool' },
          { name: 'voter', type: 'address' }, { name: 'deadline', type: 'uint256' },
        ] },
        primaryType: 'Vote',
        message: { marketId: BigInt(call.id), yes, voter: account.address, deadline },
      });
    }
    await api('/api/votes', { body: { marketId: call.id, yes, deadline: deadline.toString(), sig } });
  };

  const stake = async (yes: boolean, amount: string) => {
    const mon = Number(amount);
    if (!(mon > 0)) throw new Error('Enter an amount');
    if (mon > Number(config.maxStake)) throw new Error(`Up to ${trimNum(config.maxStake)} MON a call.`);
    await requireStepUp(mon);
    await sendAndWait(account, {
      address: config.addresses.calls, abi: callsAbi, functionName: 'stake',
      args: [BigInt(call.id), yes], value: parseEther(amount), gas: 250_000n,
    });
  };

  /** One tap: a free vote, or a staked one if an amount is picked. */
  const wager = async (yes: boolean, amount: string = pick) => {
    setMsg(''); setBusy(true);
    try {
      if (amount === 'Free') await freeVote(yes); else await stake(yes, amount);
      setAdding(false); reload();
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); } finally { setBusy(false); }
  };

  const claim = async () => {
    setMsg(''); setBusy(true);
    try {
      await requireStepUp(Number(formatEther(claimable)));
      await sendAndWait(account, { address: config.addresses.calls, abi: callsAbi, functionName: 'claim', args: [BigInt(call.id)], gas: 250_000n });
      setClaimable(0n); reload();
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); } finally { setBusy(false); }
  };

  const postComment = async () => {
    try {
      await api(`/api/calls/${call.id}/comments`, { body: { body: text } });
      setText('');
      setComments((await api<{ comments: any[] }>(`/api/calls/${call.id}/comments`)).comments);
    } catch (e: any) { setMsg(e.message); }
  };

  const total = (call.yesWeight ?? 0) + (call.noWeight ?? 0);
  const yesPct = total ? Math.round(((call.yesWeight ?? 0) / total) * 100) : 50;
  const pool = Number(call.yesPool ?? 0) + Number(call.noPool ?? 0);
  const revealed = call.yesWeight !== undefined;
  const mySide = call.viewerSide === 'no' ? 'NO' : 'YES';
  const amounts = (
    <div className="amounts" role="group" aria-label="How much MON to put behind it">
      {stakeChoices(Number(config.maxStake)).slice(1).map(s => (
        <button key={s} className={pick === s ? 'on' : ''} onClick={() => setPick(s)}>{s} MON</button>
      ))}
    </div>
  );
  const correct = (yes: boolean) => call.state === 'finalized' && call.outcome === (yes ? 1 : 2);

  return (
    <article className="card">
      <div className="inner">
      <div className="tags">
        {call.state === 'finalized' ? <span className={`tag ${call.outcome === 1 ? 'yes' : 'no'}`}>Resolved {call.outcome === 1 ? 'yes' : 'no'}</span>
          : call.state === 'void' ? <span className="tag dim">Void</span>
          : voting && left ? <span className={`tag ${call.locksAt - now < 3600 ? 'soon' : ''}`}><Icon name="clock" />{left}</span>
          : <span className="tag dim"><Icon name="lock" />{call.state === 'proposed' ? 'Settling' : 'Locked'}</span>}
        <span className="tag dim">{call.categoryName}</span>
        {call.viewerVoted
          ? <button className="tag end" onClick={openTalk} aria-label="Who's in"><Icon name="people" />{trimNum(call.voteCount, 0)} in</button>
          : <span className="tag dim end"><Icon name="people" />{trimNum(call.voteCount, 0)}</span>}
      </div>

      <PostBody post={call.terms.post} highlight={call.terms.highlight} question={call.terms.question} />

      {call.state === 'void' ? (
        <p className="info">Could not be settled. All stakes refunded, no reputation moved.</p>
      ) : revealed ? (
        <div className="room">
          <div className="room-nums">
            <div className="y"><b>{yesPct}%</b><span>said yes{correct(true) ? ' · correct' : ''}</span></div>
            <div className="n"><b>{100 - yesPct}%</b><span>said no{correct(false) ? ' · correct' : ''}</span></div>
          </div>
          <div className="meter" role="img" aria-label={`${yesPct}% said yes, ${100 - yesPct}% said no`}>
            <i className="y" style={{ width: `${yesPct}%` }} /><i className="n" style={{ flex: 1 }} />
          </div>
          <p className="fine" style={{ textAlign: 'left', marginTop: 6 }}>Weighted by reputation, not by money.</p>
        </div>
      ) : voting ? (
        <div className="veil"><Icon name="eyeoff" />Take a side to read the room</div>
      ) : null}

      {voting && !call.viewerVoted && (
        <>
          <div className="weigh">
            <span>Your vote weighs <b className="num">{fmtX(myWeight)}</b></span>
            <small>{myScore > 0 ? `${call.categoryName} reputation ${myScore.toFixed(1)}` : `Build ${call.categoryName} reputation`}{myWeight > 1 + (myScore > 0 ? Math.min(myScore, 100) / 100 : 0) + 0.005 ? ' · early bonus' : ''}</small>
          </div>
          <div className="sides">
            <button className="side yes" disabled={busy} onClick={() => wager(true, 'Free')}>Yes</button>
            <button className="side no" disabled={busy} onClick={() => wager(false, 'Free')}>No</button>
          </div>
          <p className="fine">Right calls raise your reputation, wrong ones lower it. One call, no edits.</p>
          {config.addresses.calls && (backing ? (
            <div className="backing">
              <span className="label">Back it with MON <small>(optional, does not change your weight)</small></span>
              {amounts}
              <div className="sides">
                <button className="side yes" disabled={busy || pick === 'Free'} onClick={() => wager(true, pick)}>Yes · {pick === 'Free' ? 'pick an amount' : `${pick} MON`}</button>
                <button className="side no" disabled={busy || pick === 'Free'} onClick={() => wager(false, pick)}>No · {pick === 'Free' ? 'pick an amount' : `${pick} MON`}</button>
              </div>
              <button className="text-btn" onClick={() => { setBacking(false); setPick('Free'); }}>Never mind, vote free</button>
            </div>
          ) : <button className="text-btn" onClick={() => { setBacking(true); setPick('5'); }}>Back it with MON too</button>)}
        </>
      )}

      {voting && call.viewerVoted && !adding && (
        <div className={`in-on ${call.viewerSide === 'no' ? 'no' : ''}`}>
          <i /><span style={{ color: 'inherit' }}>You're in on {mySide === 'YES' ? 'yes' : 'no'} <em>· locked</em></span>
          <button className="btn quiet sm" onClick={() => { setAdding(true); setPick('5'); }}>Back with MON</button>
        </div>
      )}
      {voting && call.viewerVoted && adding && (
        <>
          {amounts}
          <button className="btn" disabled={busy} onClick={() => wager(call.viewerSide !== 'no', pick)}>{busy ? 'Confirming…' : `Stake ${pick} MON on ${mySide === 'YES' ? 'yes' : 'no'}`}</button>
          <button className="text-btn" onClick={() => setAdding(false)}>Cancel</button>
        </>
      )}

      {claimable > 0n && (
        <div className="owed">
          <div><b>{trimNum(formatEther(claimable))}<small>MON</small></b><span>owed you</span></div>
          <button className="btn sm" disabled={busy} onClick={claim}>{busy ? 'Confirming…' : 'Collect'}</button>
        </div>
      )}

      <PrizeBox call={call} />

      {msg && <p className="err" role="alert">{msg}</p>}

      </div>
      <footer className="under">
        <Avatar name={call.creator?.username} src={call.creator?.avatar} />
        <div className="txt">
          <b><span>@{call.creator?.username}</span>{call.creator?.xVerified && <Verified />}</b>
          <span>{authorRep && authorRep.scored > 0 ? `${call.categoryName} ${authorRep.score.toFixed(1)} · ${authorRep.won} of ${authorRep.scored} right` : 'New caller · no record yet'}</span>
        </div>
        {settled && <a className="round sm" href={`${import.meta.env.VITE_API_URL ?? ''}/api/calls/${call.id}/card.svg`} target="_blank" rel="noreferrer" aria-label="Share"><Icon name="share" /></a>}
        <button className="pillbtn" onClick={() => setSheet('terms')}>How this settles</button>
      </footer>

      {sheet === 'terms' && (
        <Sheet onClose={() => setSheet('')}>
          <div className="by"><Avatar name={call.creator?.username} src={call.creator?.avatar} size="sm" /><div className="meta">@{call.creator?.username} in {call.categoryName}</div></div>
          <PostBody post={call.terms.post} highlight={call.terms.highlight} question={call.terms.question} lg />
          <h2 className="h2" style={{ fontSize: 24 }}>How this settles</h2>
          <TermsBox terms={call.terms} call={call} />
          {call.evidence && (
            <p className="info">
              {call.evidence.reasoning}{' '}
              {call.evidence.evidence.map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">{e.title || 'Source'}</a>)}
            </p>
          )}
          <button className="text-btn" onClick={() => setSheet('')}>Close</button>
        </Sheet>
      )}

      {sheet === 'talk' && (
        <Sheet onClose={() => setSheet('')}>
          <h2 className="h2">Who's in</h2>
          <p className="lede">Only people who took a side can read and post here.</p>
          {comments?.map(c => (
            <div key={c.id} className="say"><Avatar name={c.username} src={c.avatar} size="sm" /><p><b>@{c.username}{c.xVerified && <Verified />}</b>{c.body}</p></div>
          ))}
          {comments && comments.length === 0 && <p className="small">Nobody yet. You could be the first.</p>}
          <form className="sayrow" onSubmit={e => { e.preventDefault(); if (text.trim()) postComment(); }}>
            <input className="in" value={text} onChange={e => setText(e.target.value)} placeholder="Say why" maxLength={500} aria-label="Your comment" />
            <button className="btn sm" disabled={!text.trim()}>Send</button>
          </form>
          <button className="text-btn" onClick={() => setSheet('')}>Close</button>
        </Sheet>
      )}
    </article>
  );
}
