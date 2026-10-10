import { useEffect, useState } from 'react';
import { signInWithSocialRedirect, detectSocialRedirectUrl, completeSocialRedirect } from '@dynamic-labs-sdk/client';
import { Avatar, PostBody, Wordmark } from '../ui';

const EXAMPLES = [
  { who: 'dami_x', left: '18h left', tag: 'Sports', q: 'Will Arsenal beat Chelsea on Saturday?', y: 44, n: 18 },
  { who: 'thefold', left: '6d left', tag: 'Politics', q: 'Will the Fed cut rates in September?', y: 26, n: 28 },
];

const STEPS = [
  { n: '01', h: 'Say it in your own words', p: 'Write a post the way you would anywhere else. The AI finds the one line that holds the prediction, highlights it, and turns it into a clear yes/no with a named source. If it cannot be checked, it tells you why instead of guessing.' },
  { n: '02', h: 'Read the room, then vote', p: 'Everyone gets one free vote that costs no gas. You can back it with MON if you mean it. The bars stay hidden until you have voted, so the crowd cannot steer you.' },
  { n: '03', h: 'It settles on evidence', p: 'When the call ends, the AI resolver looks up public sources and settles it YES, NO or VOID, and shows you the links it used. Unclear or contested calls refund everyone.' },
];

export function SignIn({ preview = false }: { preview?: boolean }) {
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (preview) return;
    (async () => {
      const url = new URL(window.location.href);
      if (await detectSocialRedirectUrl({ url })) {
        try { await completeSocialRedirect({ url }); } catch (e: any) { setMsg(e.message); }
        window.history.replaceState({}, '', window.location.pathname);
      }
    })();
  }, []);

  const google = () => { if (!preview) signInWithSocialRedirect({ provider: 'google', redirectUrl: window.location.href }).catch(e => setMsg(e.message)); };
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

  return (
    <div className="app land">
      <div className="pad draw">
        <Wordmark xl />

        {/* ---- hero ---- */}
        <section className="hero-s">
          <h1 className="h1" style={{ fontSize: 44 }}>What if you could track conviction behind predictions, <em>socially?</em></h1>
          <div className="card">
            <div className="inner">
              <div className="tags"><span className="tag">3d left</span><span className="tag dim">Crypto</span></div>
              <PostBody
                post={'Everyone is nervous again. I am not.\n\nBitcoin closes above $120,000 on 31 August.'}
                highlight="Bitcoin closes above $120,000 on 31 August."
                question=""
              />
              <div className="room">
                <div className="room-nums">
                  <div className="y"><b>34%</b><span>17 said yes</span></div>
                  <div className="n"><b>66%</b><span>33 said no</span></div>
                </div>
                <div className="meter"><i className="y" style={{ width: '34%' }} /><i className="n" style={{ flex: 1 }} /></div>
              </div>
            </div>
            <div className="under"><Avatar name="nkechi" /><div className="txt"><b>@nkechi</b><span>50 people in</span></div><span className="pillbtn">How this settles</span></div>
          </div>
          <p className="lede">Everyone has opinions. Nobody keeps score. <b>Here, you do.</b></p>
          <div className="cta-row">
            <button className="btn" onClick={google}>Get started with Google</button>
            <button className="text-btn" onClick={() => scrollTo('how')}>See how it works ↓</button>
          </div>
          {msg && <p className="err" role="alert">{msg}</p>}
          <p className="cap" style={{ textAlign: 'center' }}>Social · Public · Reputation</p>
        </section>

        {/* ---- a look inside ---- */}
        <section className="sec">
          <p className="cap">A look inside</p>
          <h2 className="h2">Get insight on a market <em>before</em> you place your prediction.</h2>
          <p className="lede">See what everyone else is saying, on a social feed. Each post is a real call with a deadline, not a hot take that disappears.</p>
          <div className="stack">
            {EXAMPLES.map(c => (
              <div className="card" key={c.who}>
                <div className="inner">
                  <div className="tags"><span className="tag">{c.left}</span><span className="tag dim">{c.tag}</span></div>
                  <p className="q">{c.q}</p>
                  <div className="room">
                    <div className="room-nums">
                      <div className="y"><b>{c.y}</b><span>said yes</span></div>
                      <div className="n"><b>{c.n}</b><span>said no</span></div>
                    </div>
                    <div className="meter"><i className="y" style={{ width: `${(c.y / (c.y + c.n)) * 100}%` }} /><i className="n" style={{ flex: 1 }} /></div>
                  </div>
                </div>
                <div className="under"><Avatar name={c.who} /><div className="txt"><b>@{c.who}</b><span>example call</span></div></div>
              </div>
            ))}
          </div>
        </section>

        {/* ---- how it works ---- */}
        <section className="sec" id="how">
          <p className="cap">How it works</p>
          <h2 className="h2">A post becomes a market. <em>Evidence</em> settles it.</h2>
          <div className="stack">
            {STEPS.map(s => (
              <div className="card plain-step" key={s.n}>
                <span className="num">{s.n}</span>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- pools ---- */}
        <section className="sec">
          <p className="cap">Pools</p>
          <h2 className="h2">Not yes or no. <em>How close</em> can you get?</h2>
          <p className="lede">Some questions have a number for an answer: Bitcoin's price in an hour, a match score, a date. Everyone puts in the same fixed amount and locks in a guess. When the event ends, the closer you were, the bigger your share. Even a rough guess gets something back.</p>
          <div className="card plain-step">
            <div className="ladder">
              <div><b>×2.9</b><span>closest</span></div>
              <div><b>×1.6</b><span>near</span></div>
              <div><b>×0.3</b><span>bottom half</span></div>
            </div>
            <p className="small">Example multipliers on a pool entry. Pools move with reputation and stake: your guess moves your score, and your entry moves with it. The pool creator earns 5% of the pot.</p>
          </div>
        </section>

        {/* ---- reputation ---- */}
        <section className="sec">
          <p className="cap">Reputation</p>
          <h2 className="h2">See who is <em>actually</em> good.</h2>
          <div className="stack">
            <div className="card plain-step"><h3>A public record</h3><p>Every call you win or lose moves your score, kept per category: Crypto, Sports, Music, Politics and Other. It lives onchain, so anyone can check it and nobody can edit it.</p></div>
            <div className="card plain-step"><h3>Money cannot buy it</h3><p>You can only earn reputation by being right. Higher reputation also gives your vote more weight, so the sharpest voices carry the room.</p></div>
            <div className="card plain-step"><h3>Then go use it</h3><p>Take what you learn about who calls it right, and use it wherever you predict.</p></div>
          </div>
        </section>

        {/* ---- built on ---- */}
        <section className="sec">
          <p className="cap">Built on Monad</p>
          <h2 className="h2">Fast, cheap, and <em>no seed phrase</em>.</h2>
          <p className="lede">Sign in with Google and a wallet is made for you. Votes are free, and the contracts are public. Money only moves when you choose to stake, and a pause on new activity never blocks anyone from claiming or getting a refund.</p>
        </section>

        {/* ---- final call ---- */}
        <section className="sec final">
          <h2 className="h2">Everyone has opinions.<br />Nobody keeps score.<br /><em>Here, you do.</em></h2>
          <button className="btn" onClick={google}>Get started with Google</button>
          {msg && <p className="err" role="alert">{msg}</p>}
          <p className="small" style={{ textAlign: 'center' }}>Predictions are not financial advice. Only stake MON you can afford to lose.</p>
        </section>
      </div>
    </div>
  );
}
