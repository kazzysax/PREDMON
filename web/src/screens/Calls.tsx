import { useCallback, useEffect, useState } from 'react';
import { formatEther, parseEther } from 'viem';
import { api } from '../api';
import { useApp } from '../ctx';
import { callsAbi, publicClient } from '../chain';
import { requireStepUp, sendAndWait, walletClientFor } from '../wallet';
import { Avatar, Icon, PostBody, Sheet, Verified, timeLeft, trimNum, when } from '../ui';

type Terms = { post?: string; highlight?: string; question: string; yesMeans: string; noMeans: string; source: string };
type Call = {
  id: number; terms: Terms; category: number; categoryName: string;
  creator: { username: string; xVerified: boolean } | null;
  opensAt: number; locksAt: number; closesAt: number; state: 'open' | 'proposed' | 'finalized' | 'void';
  outcome: number; voteCount: number; viewerVoted: boolean; viewerSide?: 'yes' | 'no' | null;
  yesWeight?: number; noWeight?: number; yesPool?: string; noPool?: string; claimable?: string;
  evidence?: { reasoning: string; evidence: { title: string; url: string }[] };
};

const LIVES = [{ label: '1 hour', sec: 3600 }, { label: '6 hours', sec: 6 * 3600 }, { label: '1 day', sec: 86400 }, { label: '3 days', sec: 3 * 86400 }, { label: '7 days', sec: 7 * 86400 }];
const STAKES = ['Free', '5', '25', '100'];

export function Calls({ composing, setComposing }: { composing: boolean; setComposing: (v: boolean) => void }) {
  const { config } = useApp();
  const [feed, setFeed] = useState<'explore' | 'following'>('explore');
  const [category, setCategory] = useState('');
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ feed, ...(category ? { category } : {}) });
      setCalls((await api<{ calls: Call[] }>(`/api/calls?${q}`)).calls);
      setErr('');
    } catch (e: any) { setErr(e.message); }
  }, [feed, category]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="filters">
        <button className={`filter lead ${feed === 'explore' ? 'on' : ''}`} onClick={() => setFeed('explore')}>Explore</button>
        <button className={`filter lead ${feed === 'following' ? 'on' : ''}`} onClick={() => setFeed('following')}>Following</button>
      </div>
      <div className="filters" style={{ paddingTop: 8, paddingBottom: 14 }}>
        <button className={`filter ${category === '' ? 'on' : ''}`} onClick={() => setCategory('')}>All</button>
        {config.categories.map((c, i) => (
          <button key={c} className={`filter ${category === String(i) ? 'on' : ''}`} onClick={() => setCategory(String(i))}>{c}</button>
        ))}
      </div>
      <div className="page draw">
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
    try { await api('/api/calls/confirm', { body: { draftId: draft.draftId } }); onCreated(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };

  if (draft) {
    return (
      <Sheet onClose={onClose}>
        <h2 className="h2">This is how it settles</h2>
        <PostBody post={draft.terms.post} highlight={draft.terms.highlight} question={draft.terms.question} lg />
        <TermsBox terms={draft.terms} />
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
      <h2 className="h2">What do you want to be right about?</h2>
      <p className="lede">Say it however you like — your words are what gets posted. We'll show you how it settles before it goes up.</p>
      <textarea className="in" value={post} onChange={e => setPost(e.target.value)} maxLength={1500} autoFocus
        placeholder="good morning, what do you reckon BTC does in the next hour?" aria-label="Your call" />
      <div>
        <span className="label">Betting closes in</span>
        <div className="amounts">
          {LIVES.map(l => <button key={l.sec} className={life === l.sec ? 'on' : ''} onClick={() => setLife(l.sec)}>{l.label}</button>)}
        </div>
      </div>
      {msg && <p className="err" role="alert">{msg}</p>}
      <div className="foot" style={{ paddingTop: 4 }}>
        <button className="btn" disabled={busy || post.trim().length < 10} onClick={check}>{busy ? 'Reading it…' : 'Continue'}</button>
        <button className="text-btn" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
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
        account: account.address,
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
  const wager = async (yes: boolean) => {
    setMsg(''); setBusy(true);
    try {
      if (pick === 'Free') await freeVote(yes); else await stake(yes, pick);
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
    <div className="amounts" role="group" aria-label="How much to put on it">
      {(adding ? STAKES.slice(1) : STAKES).map(s => (
        <button key={s} className={pick === s ? 'on' : ''} onClick={() => setPick(s)}>{s === 'Free' ? 'Free' : `${s} MON`}</button>
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
        </div>
      ) : voting ? (
        <div className="veil"><Icon name="eyeoff" />Take a side to read the room</div>
      ) : null}

      {voting && !call.viewerVoted && (
        <>
          {amounts}
          <div className="sides">
            <button className="side yes" disabled={busy} onClick={() => wager(true)}>Yes</button>
            <button className="side no" disabled={busy} onClick={() => wager(false)}>No</button>
          </div>
          <p className="fine">One wager. No edits. No exits.</p>
        </>
      )}

      {voting && call.viewerVoted && !adding && (
        <div className={`in-on ${call.viewerSide === 'no' ? 'no' : ''}`}>
          <i /><span style={{ color: 'inherit' }}>You're in on {mySide === 'YES' ? 'yes' : 'no'} <em>· locked</em></span>
          <button className="btn quiet sm" onClick={() => { setAdding(true); setPick('5'); }}>Add MON</button>
        </div>
      )}
      {voting && call.viewerVoted && adding && (
        <>
          {amounts}
          <button className="btn" disabled={busy} onClick={() => wager(call.viewerSide !== 'no')}>{busy ? 'Confirming…' : `Stake ${pick} MON on ${mySide === 'YES' ? 'yes' : 'no'}`}</button>
          <button className="text-btn" onClick={() => setAdding(false)}>Cancel</button>
        </>
      )}

      {claimable > 0n && (
        <div className="owed">
          <div><b>{trimNum(formatEther(claimable))}<small>MON</small></b><span>owed you</span></div>
          <button className="btn sm" disabled={busy} onClick={claim}>{busy ? 'Confirming…' : 'Collect'}</button>
        </div>
      )}

      {msg && <p className="err" role="alert">{msg}</p>}

      </div>
      <footer className="under">
        <Avatar name={call.creator?.username} />
        <div className="txt">
          <b><span>@{call.creator?.username}</span>{call.creator?.xVerified && <Verified />}</b>
          <span>{revealed && pool > 0 ? `${trimNum(pool, 0)} MON staked` : call.terms.source}</span>
        </div>
        {settled && <a className="round sm" href={`${import.meta.env.VITE_API_URL ?? ''}/api/calls/${call.id}/card.svg`} target="_blank" rel="noreferrer" aria-label="Share"><Icon name="share" /></a>}
        <button className="pillbtn" onClick={() => setSheet('terms')}>How this settles</button>
      </footer>

      {sheet === 'terms' && (
        <Sheet onClose={() => setSheet('')}>
          <div className="by"><Avatar name={call.creator?.username} size="sm" /><div className="meta">@{call.creator?.username} in {call.categoryName}</div></div>
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
            <div key={c.id} className="say"><Avatar name={c.username} size="sm" /><p><b>@{c.username}{c.xVerified && <Verified />}</b>{c.body}</p></div>
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
