// Small shared pieces: icons, avatar, the post with its highlighted prediction, time helpers.
import type { ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  calls: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12.5h5" /></>,
  pools: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  ranks: <><path d="M5 20V11M12 20V4M19 20v-6" /></>,
  me: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.2-4 4.2-6 8-6s6.8 2 8 6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.500V12l3 2" /></>,
  eyeoff: <><path d="M3 3l18 18" /><path d="M10.5 6.200A9.6 9.6 0 0 1 12 6c5 0 8.5 4 9.5 6a13 13 0 0 1-2.7 3.500M6.3 7.800A13 13 0 0 0 2.5 12c1 2 4.5 6 9.5 6 1.3 0 2.5-.3 3.6-.7" /></>,
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  people: <><circle cx="9" cy="9" r="3.5" /><path d="M2.5 20c.8-3.5 3.3-5 6.5-5s5.7 1.5 6.5 5" /><path d="M16 5.800a3.5 3.5 0 0 1 0 6.400M18.5 15.500c1.7.7 2.7 2.2 3 4.5" /></>,
  doc: <><path d="M6 3h8l4 4v14H6z" /><path d="M9 12h6M9 16h6" /></>,
  share: <><path d="M12 15V4M8 8l4-4 4 4" /><path d="M5 13v6h14v-6" /></>,
  check: <path d="M5 12.500l4.5 4.500L19 7.5" />,
  wallet: <><path d="M4 7.5h14.5a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18z" /><path d="M4 7.5V6a1.5 1.5 0 0 1 1.5-1.5H16" /><circle cx="16" cy="13.5" r="0.9" fill="currentColor" /></>,
  lock: <><rect x="5.5" y="10.5" width="13" height="9" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
};
export function Icon({ name }: { name: keyof typeof paths | string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

const hue = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
export function Avatar({ name, size }: { name?: string | null; size?: 'sm' | 'ring' }) {
  const n = name || '?';
  const el = <span className={`av h${hue(n)} ${size ?? ''}`} aria-hidden="true">{n[0]}</span>;
  return size === 'ring' ? <span className="ringwrap">{el}</span> : el;
}
export const Verified = () => <span className="tick" title="Linked X account">✓</span>;
export const Wordmark = ({ xl }: { xl?: boolean }) => <div className={`logo ${xl ? 'xl' : ''}`}>Pred<i>Tube</i></div>;

/**
 * The post exactly as its author wrote it, paragraphs and line breaks kept,
 * with the call inside it lifted out in serif. If no part of the post was
 * marked, the fixed question is shown underneath as the call.
 */
export function PostBody({ post, highlight, question, lg }: { post?: string; highlight?: string; question: string; lg?: boolean }) {
  const text = post ?? question;
  const at = highlight ? text.indexOf(highlight) : -1;
  if (at < 0 || !highlight) {
    return <p className={`said ${lg ? 'lg' : ''}`}>{post && post !== question ? post : null}<mark className="block">{question}</mark></p>;
  }
  return <p className={`said ${lg ? 'lg' : ''}`}>{text.slice(0, at)}<mark>{highlight}</mark>{text.slice(at + highlight.length)}</p>;
}

export function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheetbox" role="dialog" aria-modal="true">{children}</div>
    </div>
  );
}

/**
 * The spread of a pool's revealed guesses, drawn from the real numbers. The
 * dot sits at `mark` when given (the result), otherwise on the peak.
 */
export function Curve({ values, mark }: { values: number[]; mark?: number | null }) {
  const W = 400, H = 92, base = 84, top = 12, N = 72;
  if (values.length < 3) return null;
  const lo0 = Math.min(...values, mark ?? Infinity), hi0 = Math.max(...values, mark ?? -Infinity);
  const span = hi0 - lo0 || Math.abs(hi0) * 0.02 || 1;
  const lo = lo0 - span * 0.3, hi = hi0 + span * 0.3;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || span * 0.1;
  const h = Math.max(1.06 * sd * values.length ** -0.2, span * 0.04);
  const dens = (x: number) => values.reduce((a, v) => a + Math.exp(-0.5 * ((x - v) / h) ** 2), 0);
  const xs = Array.from({ length: N + 1 }, (_, i) => lo + ((hi - lo) * i) / N);
  const ys = xs.map(dens);
  const max = Math.max(...ys);
  const px = (x: number) => ((x - lo) / (hi - lo)) * W;
  const py = (y: number) => base - (y / max) * (base - top);
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)} ${py(ys[i]).toFixed(1)}`).join(' ');
  const at = mark ?? xs[ys.indexOf(max)];
  return (
    <svg className="curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="aurora-stroke" gradientUnits="userSpaceOnUse" x1="0" x2={W} y1="0" y2="0">
          <stop offset="0" stopColor="#ffc46b" /><stop offset="0.5" stopColor="#ff8a5c" /><stop offset="1" stopColor="#ff5c8a" />
        </linearGradient>
        <linearGradient id="aurora-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ff8a5c" stopOpacity="0.22" /><stop offset="1" stopColor="#ff8a5c" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="fill" d={`${d} L${W} ${H} L0 ${H} Z`} />
      <path className="trace" d={d} vectorEffect="non-scaling-stroke" />
      <circle className="halo" cx={px(at)} cy={py(dens(at))} r="10" /><circle className="dot" cx={px(at)} cy={py(dens(at))} r="4.5" />
    </svg>
  );
}

export function timeLeft(to: number, now: number) {
  const s = to - now;
  if (s <= 0) return null;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m left`;
  if (s < 86400) return `${Math.round(s / 3600)}h left`;
  return `${Math.round(s / 86400)}d left`;
}
export const when = (t: number) =>
  new Date(t * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const trimNum = (s: string | number, d = 2) => Number(s).toLocaleString(undefined, { maximumFractionDigits: d });
