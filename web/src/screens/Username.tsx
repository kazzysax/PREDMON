import { useState } from 'react';
import { api } from '../api';
import { Wordmark } from '../ui';

export function Username({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="app">
      <form className="pad" onSubmit={async e => {
        e.preventDefault();
        try { await api('/api/me/username', { body: { username: name } }); onDone(); } catch (x: any) { setErr(x.message); }
      }}>
        <Wordmark />
        <div className="mid" style={{ display: 'grid', gap: 14 }}>
          <h1 className="h1">Claim your name</h1>
          <p className="lede">Every call you make gets filed under it.</p>
          <input className="in" value={name} onChange={e => setName(e.target.value)} placeholder="username" autoFocus maxLength={20} aria-label="Username" />
          {err ? <p className="err" role="alert">{err}</p> : <p className="small">3 to 20 letters, numbers or underscores.</p>}
        </div>
        <div className="foot"><button className="btn" disabled={name.length < 3}>Continue</button></div>
      </form>
    </div>
  );
}
