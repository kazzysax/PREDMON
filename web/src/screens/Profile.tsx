import { useEffect, useState } from 'react';
import { formatEther } from 'viem';
import { api } from '../api';
import { useApp } from '../ctx';
import { callsAbi, publicClient } from '../chain';
import { sendAndWait } from '../wallet';
import { Avatar, Icon, Verified, trimNum } from '../ui';

export function Profile() {
  const { me, config, account, hasX, linkX, signOut, preview } = useApp();
  const [fees, setFees] = useState<bigint>(preview ? 12_400000000000000000n : 0n);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (preview) return;
    publicClient.readContract({ address: config.addresses.calls, abi: callsAbi, functionName: 'authorFees', args: [account.address] })
      .then(v => setFees(v as bigint)).catch(() => {});
  }, []);

  const totalScored = me.reputation.reduce((a, r) => a + r.scored, 0);
  const totalWon = me.reputation.reduce((a, r) => a + r.won, 0);
  const max = Math.max(10, ...me.reputation.map(r => Math.abs(r.score)));

  const rate = totalScored ? Math.round((totalWon / totalScored) * 100) : 0;
  const best = [...me.reputation].sort((x, y) => y.score - x.score)[0];

  return (
    <div className="page">
      <div className="under" style={{ padding: '6px 0' }}>
        <Avatar name={me.username} size="ring" />
        <div className="txt">
          <h1 className="h2">@{me.username}{me.xVerified && <Verified />}</h1>
          <span className="small">{account.address.slice(0, 8)}…{account.address.slice(-6)}</span>
        </div>
      </div>

      <div className="wtiles">
        <div className="wtile rep">
          <div className="wtop"><span className="wbadge g"><Icon name="ranks" /></span><span className="wlabel">Best reputation</span></div>
          <div className="wbig">{best ? best.score.toFixed(1) : '0.0'}</div>
          <div className="wunit">{best ? best.name : 'No calls yet'}</div>
        </div>
        <div className="wtile hit">
          <div className="wtop"><span className="wbadge"><Icon name="check" /></span><span className="wlabel">Hit rate</span></div>
          <div className="ring2" style={{ ['--p' as any]: `${rate * 3.6}deg` }}><b>{rate}%</b></div>
          <div className="wunit">{totalWon} of {totalScored} calls right</div>
        </div>
      </div>

      <div className="group tipinfo">
        <div className="lead"><b>{totalScored}</b><span>Played</span></div>
        <div className="mid"><b>{totalWon}</b><span>Wins</span></div>
        <div className="sent"><b>{totalScored - totalWon}</b><span>Losses</span></div>
      </div>

      {fees > 0n && (
        <div className="owed">
          <div><b>{trimNum(formatEther(fees))}<small>MON</small></b><span>owed you from your calls</span></div>
          <button className="btn sm" onClick={async () => {
            try { await sendAndWait(account, { address: config.addresses.calls, abi: callsAbi, functionName: 'withdrawAuthorFees', gas: 120_000n }); setFees(0n); }
            catch (e: any) { setMsg(e.shortMessage ?? e.message); }
          }}>Collect</button>
        </div>
      )}

      <p className="heading">Reputation</p>
      <div className="group">
        {me.reputation.map(r => (
          <div key={r.category} className="grow rep-row">
            <span className="gm"><b>{r.name}</b><span>{r.won} wins · {r.scored} played</span></span>
            <div className="track"><i style={{ width: `${r.score > 0 ? Math.max(4, (r.score / max) * 100) : 0}%` }} /></div>
            <span className="val" style={{ minWidth: 58, textAlign: 'right' }}>{r.score > 0 ? '+' : ''}{r.score.toFixed(1)}</span>
          </div>
        ))}
      </div>

      {!hasX && (
        <div className="in-on"><div><div>Link your X account</div><span>So people know it's you.</span></div><button className="btn quiet sm" onClick={linkX}>Link X</button></div>
      )}

      <FindUser />
      {msg && <p className="err" role="alert">{msg}</p>}
      <button className="text-btn" onClick={signOut}>Sign out</button>
    </div>
  );
}

function FindUser() {
  const [name, setName] = useState('');
  const [u, setU] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const find = async () => { try { setU(await api(`/api/users/${name}`)); setMsg(''); } catch (e: any) { setU(null); setMsg(e.message); } };
  const toggle = async () => {
    await api(u.iFollow ? '/api/unfollow' : '/api/follow', { body: { username: u.username } });
    setU({ ...u, iFollow: !u.iFollow, followers: u.followers + (u.iFollow ? -1 : 1) });
  };
  return (
    <>
      <p className="heading">People to follow</p>
      <form className="sayrow" onSubmit={e => { e.preventDefault(); if (name) find(); }}>
        <input className="in" value={name} onChange={e => setName(e.target.value)} placeholder="username" aria-label="Username to look up" />
        <button className="btn quiet sm">Find</button>
      </form>
      {msg && <p className="err" role="alert">{msg === 'no such user' ? "Couldn't load that profile." : msg}</p>}
      {u && (
        <div className="list"><div className="item">
          <Avatar name={u.username} />
          <div className="grow">
            <div className="name">@{u.username}{u.xVerified && <Verified />}</div>
            <div className="sub">{trimNum(u.followers, 0)} followers{u.reputation.filter((r: any) => r.scored > 0).slice(0, 2).map((r: any) => ` · ${r.name} ${r.score.toFixed(1)}`)}</div>
          </div>
          <button className={`btn sm ${u.iFollow ? 'quiet' : ''}`} onClick={toggle}>{u.iFollow ? 'Following' : 'Follow'}</button>
        </div></div>
      )}
    </>
  );
}
