import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import { Avatar, Verified } from '../ui';

export function Leaderboard() {
  const { config, me } = useApp();
  const [cat, setCat] = useState(0);
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { setRows(null); api(`/api/leaderboard?category=${cat}`).then(r => setRows(r.board)).catch(() => setRows([])); }, [cat]);
  const first = rows?.[0];

  return (
    <>
      <div className="page" style={{ paddingBottom: 0, flex: 'none' }}>
        <div>
          <h1 className="h1">See who's actually <em>good.</em></h1>
          <p className="lede" style={{ marginTop: 10 }}>Every record is public, and higher reputation pulls the bar harder.</p>
        </div>
      </div>
      <div className="filters" style={{ padding: '14px 18px' }}>
        {config.categories.map((c, i) => <button key={c} className={`filter ${cat === i ? 'on' : ''}`} onClick={() => setCat(i)}>{c}</button>)}
      </div>
      <div className="page">
        {rows && rows.length === 0 && <p className="empty"><b>Nobody yet.</b>You could be the first.</p>}
        {first && (
          <div className="card plain">
            <span className="cap">Leading {config.categories[cat]}</span>
            <div className="num" style={{ fontSize: 72 }}>{first.score.toFixed(1)}</div>
            <div className="under" style={{ padding: '8px 0 0' }}>
              <Avatar name={first.username} />
              <div className="txt"><b><span>@{first.username}</span>{first.xVerified && <Verified />}</b><span>{first.won} wins · {first.scored} played</span></div>
            </div>
          </div>
        )}
        {rows && rows.length > 1 && (
          <div className="list">
            {rows.slice(1).map((r, i) => (
              <div key={r.username} className="item">
                <span className="pos">{i + 2}</span>
                <Avatar name={r.username} size="sm" />
                <div className="grow">
                  <div className="name">@{r.username}{r.xVerified && <Verified />}{r.username === me.username ? <span className="sub"> · you</span> : null}</div>
                  <div className="sub">{r.won} wins · {r.scored} played</div>
                </div>
                <span className="val">{r.score.toFixed(1)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
