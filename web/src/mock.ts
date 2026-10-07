// Sample data for preview mode (open the app with ?preview). Lets the design be
// seen and clicked through with no keys, wallet or server. Nothing here is real.
export const PREVIEW = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('preview');

const now = () => Math.floor(Date.now() / 1000);
const H = 3600;

export const mockConfig = {
  chainId: 143,
  addresses: { reputation: '0x0000000000000000000000000000000000000001', calls: '0x0000000000000000000000000000000000000002', pools: '0x0000000000000000000000000000000000000003' },
  categories: ['Crypto', 'Sports', 'Music', 'Politics', 'Other'], maxStake: '1000.0', maxEntry: '1000.0', limits: { callsPerDay: 5 },
} as const;

export const mockMe = {
  id: 'me', username: 'kazzysax', wallet: '0x71c7656ec7ab88b098defb751b7401b5f6d8976f', xVerified: true, xUsername: 'kazzysax',
  reputation: [
    { category: 0, name: 'Crypto', score: 41.2, scored: 23, won: 15 },
    { category: 1, name: 'Sports', score: 18.6, scored: 11, won: 7 },
    { category: 2, name: 'Music', score: 6.4, scored: 3, won: 2 },
    { category: 3, name: 'Politics', score: -3.1, scored: 4, won: 1 },
    { category: 4, name: 'Other', score: 0, scored: 0, won: 0 },
  ],
};

const call = (o: any) => ({
  opensAt: now() - 2 * H, voteCount: 0, viewerVoted: false, outcome: 0, state: 'open', ...o,
  locksAt: o.closesAt - Math.round((o.closesAt - (now() - 2 * H)) * 0.1),
});
const calls: any[] = [
  call({
    id: 14, category: 1, categoryName: 'Sports', creator: { username: 'ada_calls', xVerified: true }, closesAt: now() + 5 * H, voteCount: 212,
    terms: {
      post: "Watched all of Arsenal's last four away games and the press is finally clicking.\n\nSaka is back, the midfield isn't getting bullied any more, and City look tired after midweek.\n\nArsenal beat City at the Etihad on Sunday.\n\nNot a draw. A win. Screenshot this.",
      highlight: 'Arsenal beat City at the Etihad on Sunday.',
      question: 'Will Arsenal beat Manchester City in their Premier League match on Sunday?',
      yesMeans: 'Arsenal win the match in normal time.', noMeans: 'City win or the match is drawn, or it is not played.', source: 'premierleague.com match report',
    },
  }),
  call({
    id: 13, category: 0, categoryName: 'Crypto', creator: { username: 'monad_maxi', xVerified: false }, closesAt: now() + 40 * 60, voteCount: 1840, viewerVoted: true, viewerSide: 'yes',
    yesWeight: 6400, noWeight: 3600, yesPool: '4210.5', noPool: '1975.0', comments: 3,
    terms: {
      post: "Funding flipped positive and nobody is talking about it.\n\nMON closes above $0.50 this Friday. Easy.",
      highlight: 'MON closes above $0.50 this Friday.',
      question: 'Will MON close above $0.50 on Friday?', yesMeans: 'MON/USD is above 0.50 at Friday 23:59 UTC.', noMeans: 'It is at or below 0.50.', source: 'Chainlink MON/USD feed',
    },
  }),
  call({
    id: 11, category: 2, categoryName: 'Music', creator: { username: 'kazzysax', xVerified: true }, closesAt: now() - 30 * H, state: 'finalized', outcome: 1, voteCount: 967, viewerVoted: true, viewerSide: 'yes',
    yesWeight: 3100, noWeight: 6900, yesPool: '820.0', noPool: '2650.0', claimable: '148.75',
    terms: {
      post: "Everyone says it's too soon. I say the rollout has been perfect.\n\nBurna drops the album before the month ends.",
      highlight: 'Burna drops the album before the month ends.',
      question: 'Will the album be released before the end of the month?', yesMeans: 'It is available on major streaming services by the last day of the month.', noMeans: 'It is not.', source: 'Spotify and Apple Music release pages',
    },
    evidence: { reasoning: 'The album appeared on both services on the 27th.', evidence: [{ title: 'Spotify release page', url: 'https://example.com' }] },
  }),
  call({
    id: 9, category: 3, categoryName: 'Politics', creator: { username: 'quietpolls', xVerified: false }, closesAt: now() - 50 * H, state: 'void', outcome: 3, voteCount: 301,
    yesWeight: 5000, noWeight: 5000, yesPool: '95.0', noPool: '110.0',
    terms: { post: 'The bill gets signed this week, mark my words.', highlight: '', question: 'Will the bill be signed into law this week?', yesMeans: 'Signed by Sunday.', noMeans: 'Not signed by Sunday.', source: 'Official gazette' },
  }),
];

// a repeatable bell-ish spread, so the preview curve looks the same every time
const spread = (n: number, centre: number, width: number) =>
  Array.from({ length: n }, (_, i) => {
    const u = Math.sin(i * 12.9898) * 43758.5453, v = Math.sin(i * 78.233) * 12543.123;
    const a = u - Math.floor(u), b = v - Math.floor(v);
    const z = Math.sqrt(-2 * Math.log(a || 0.5)) * Math.cos(2 * Math.PI * b);
    return String(Math.round((centre + z * width) * 1e8));
  });
const pools: any[] = [
  { id: 6, creator: { username: 'ada_calls' }, asset: 0, entryAmount: '25.0', lockTime: now() + 9 * H, resultTime: now() + 12 * H, entries: 47, revealed: 0, priced: false, price: null, refunded: false, voided: false, pot: '1175.0', guesses: [] },
  { id: 5, creator: { username: 'monad_maxi' }, asset: 2, entryAmount: '5.0', lockTime: now() - 1 * H, resultTime: now() + 2 * H, entries: 132, revealed: 118, priced: false, price: null, refunded: false, voided: false, pot: '660.0', guesses: spread(118, 0.51, 0.035) },
  { id: 4, creator: { username: 'kazzysax' }, asset: 1, entryAmount: '10.0', lockTime: now() - 30 * H, resultTime: now() - 27 * H, entries: 64, revealed: 61, priced: true, price: '412356000000', refunded: false, voided: false, pot: '640.0', guesses: spread(61, 4080, 140) },
];

const board = [
  ['ada_calls', true, 88.4, 61, 44], ['kazzysax', true, 41.2, 23, 15], ['monad_maxi', false, 37.9, 40, 24],
  ['quietpolls', false, 29.5, 19, 12], ['zee.eth', true, 22.1, 14, 9], ['tunde_o', false, 17.8, 12, 7], ['lagosbull', false, 9.3, 8, 4],
].map(([username, xVerified, score, scored, won]) => ({ username, xVerified, score, scored, won }));

const comments = [
  { id: 1, username: 'ada_calls', xVerified: true, body: 'Funding has been positive for three days. I am in.' },
  { id: 2, username: 'quietpolls', xVerified: false, body: 'Friday close is a long way off in this market.' },
  { id: 3, username: 'tunde_o', xVerified: false, body: 'Backed YES with 50. Let us see.' },
];

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function mockApi(path: string, opts: { body?: any } = {}): Promise<any> {
  await wait(120);
  const [p, q = ''] = path.split('?');
  const query = new URLSearchParams(q);
  if (p === '/api/calls/draft') {
    const post = String(opts.body.post ?? '').trim();
    const lines = post.split('\n').map(l => l.trim()).filter(Boolean);
    const line = lines.find(l => /\d|\bwill\b|\bbefore\b|\bby\b/i.test(l)) ?? lines[0] ?? post;
    return { ok: true, draftId: 'd1', lifeSec: opts.body.lifeSec, terms: { post, highlight: line, question: `Will this happen: ${line}`, yesMeans: 'It happens as written before the call closes.', noMeans: 'It does not.', source: 'An official public source', category: 4 } };
  }
  if (p === '/api/calls/confirm') return { id: 15 };
  if (p === '/api/calls') {
    let list = calls;
    if (query.get('category')) list = list.filter(c => String(c.category) === query.get('category'));
    if (query.get('feed') === 'following') list = list.filter(c => c.creator.username === 'ada_calls');
    return { calls: list };
  }
  if (/\/comments$/.test(p)) return opts.body ? { id: 9 } : { comments };
  if (p === '/api/votes') {
    const c = calls.find(x => x.id === opts.body.marketId);
    Object.assign(c, { viewerVoted: true, viewerSide: opts.body.yes ? 'yes' : 'no', yesWeight: 5800, noWeight: 4200, yesPool: '312.0', noPool: '188.5', voteCount: c.voteCount + 1 });
    return { ok: true };
  }
  if (p === '/api/pools') return { pools };
  if (p === '/api/leaderboard') return { board };
  if (p.startsWith('/api/users/')) return { username: 'ada_calls', xVerified: true, followers: 1204, following: 88, iFollow: false, reputation: [{ category: 1, name: 'Sports', score: 88.4, scored: 61, won: 44 }, { category: 0, name: 'Crypto', score: 12.5, scored: 9, won: 6 }] };
  return { ok: true };
}
