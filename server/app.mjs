// HTTP API. Plain node:http with a tiny router, no framework.
import http from 'node:http';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { authenticate, httpError } from './auth.mjs';
import { cleanName } from './names.mjs';
import { termsHash, CATEGORIES, cleanPost, pickHighlight } from './ai.mjs';

const DAY_MS = 86400_000;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATES = ['open', 'proposed', 'finalized', 'void'];

export function createApp({ cfg, db, chain, ai, verify, jobs }) {
  const routes = [];
  const route = (method, path, handler, { auth = false, optionalAuth = false } = {}) =>
    routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, auth, optionalAuth });

  // ------------------------------------------------------------ helpers
  const lc = a => a.toLowerCase();
  const nowMs = () => Date.now();

  function upsertUser(claims, wantedWallet) {
    let wallet = wantedWallet ? lc(wantedWallet) : null;
    if (wallet && !claims.wallets.some(w => w.address === wallet)) throw httpError(400, 'that wallet is not on your account');
    if (!wallet) wallet = (claims.wallets.find(w => w.embedded) ?? claims.wallets[0])?.address;
    if (!wallet) throw httpError(400, 'your account has no wallet yet');
    const existing = db.prepare('SELECT * FROM users WHERE id=?').get(claims.userId);
    if (!existing) {
      const taken = db.prepare('SELECT id FROM users WHERE wallet=?').get(wallet);
      if (taken) throw httpError(409, 'that wallet belongs to another account');
      db.prepare('INSERT INTO users(id,wallet,x_username,created_at) VALUES(?,?,?,?)').run(claims.userId, wallet, claims.xUsername, nowMs());
    } else {
      // Keep the verified X handle current; the wallet is only changed by an explicit choice.
      db.prepare('UPDATE users SET x_username=? WHERE id=?').run(claims.xUsername, claims.userId);
      if (wantedWallet && existing.wallet !== wallet) {
        const taken = db.prepare('SELECT id FROM users WHERE wallet=? AND id<>?').get(wallet, claims.userId);
        if (taken) throw httpError(409, 'that wallet belongs to another account');
        db.prepare('UPDATE users SET wallet=? WHERE id=?').run(wallet, claims.userId);
      }
    }
    return db.prepare('SELECT * FROM users WHERE id=?').get(claims.userId);
  }

  async function reputationOf(wallet) {
    const out = [];
    for (let c = 0; c < 5; c++) {
      const [score, scored, won] = await Promise.all([
        chain.read.reputation.score(wallet, c), chain.read.reputation.callsScored(wallet, c), chain.read.reputation.callsWon(wallet, c)]);
      out.push({ category: c, name: CATEGORIES[c], score: Number(score) / 100, scored: Number(scored), won: Number(won) });
    }
    return out;
  }

  const publicUser = u => u && ({ username: u.username, wallet: u.wallet, xVerified: !!u.x_username, xUsername: u.x_username });
  const userByWallet = w => db.prepare('SELECT * FROM users WHERE wallet=?').get(lc(w));
  const hasVoted = async (id, wallet) => Number((await chain.read.calls.positions(id, wallet)).side) !== 0;

  async function marketView(row, viewerWallet) {
    const o = await chain.read.calls.getMarket(row.id);
    const side = viewerWallet ? Number((await chain.read.calls.positions(row.id, viewerWallet)).side) : 0;
    const voted = side !== 0;
    const state = Number(o.state);
    const settled = state === 2 || state === 3;
    const creator = db.prepare('SELECT * FROM users WHERE id=?').get(row.creator_id);
    const view = {
      id: row.id, terms: JSON.parse(row.terms_json), category: row.category, categoryName: CATEGORIES[row.category],
      creator: publicUser(creator), createdAt: row.created_at,
      opensAt: Number(o.opensAt), locksAt: Number(o.locksAt), closesAt: Number(o.closesAt),
      state: STATES[state], outcome: Number(o.outcome), voteCount: Number(o.voteCount),
      viewerVoted: voted, viewerSide: side === 1 ? 'yes' : side === 2 ? 'no' : null,
    };
    // Blind bars: the tally stays hidden until you have voted, or the call is settled.
    if (voted || settled) {
      view.yesWeight = Number(o.yesWeight); view.noWeight = Number(o.noWeight);
      view.yesPool = ethers.formatEther(o.yesPool); view.noPool = ethers.formatEther(o.noPool);
    }
    if (settled && row.evidence_json) view.evidence = JSON.parse(row.evidence_json);
    return view;
  }

  // ------------------------------------------------------------- routes
  route('GET', '/api/health', async () => ({ ok: true, relayerLow: await chain.relayerLow() }));

  route('GET', '/api/config', async () => ({
    chainId: cfg.chainId, addresses: cfg.addresses, categories: CATEGORIES,
    limits: cfg.limits, dynamicEnvironmentId: cfg.dynamicEnvId,
    maxStake: ethers.formatEther(await chain.read.calls.maxStake()),
    maxEntry: ethers.formatEther(await chain.read.pools.maxEntry()),
  }));

  // --- account
  route('GET', '/api/me', async ({ claims, query }) => {
    const u = upsertUser(claims, query.get('wallet'));
    return { ...publicUser(u), id: u.id, email: claims.email, wallets: claims.wallets, reputation: await reputationOf(u.wallet) };
  }, { auth: true });

  route('POST', '/api/me/username', async ({ claims, body }) => {
    const u = upsertUser(claims);
    let c;
    try { c = cleanName(body.username); } catch (e) { throw httpError(400, e.message); }
    const taken = db.prepare('SELECT id FROM users WHERE username_folded=? AND id<>?').get(c.folded, u.id);
    if (taken) throw httpError(409, 'that name is taken or too similar to one that is');
    db.prepare('UPDATE users SET username=?, username_folded=? WHERE id=?').run(c.name, c.folded, u.id);
    return { username: c.name };
  }, { auth: true });

  // --- calls: draft then confirm
  route('POST', '/api/calls/draft', async ({ claims, body }) => {
    const u = upsertUser(claims);
    if (!u.username) throw httpError(400, 'pick a username first');
    // The post is kept exactly as written (paragraphs and all); the AI only marks the prediction in it.
    const question = cleanPost(body.post ?? body.question);
    if (question.length < 10 || question.length > 1500) throw httpError(400, 'write your post in 10-1500 characters');
    const lifeSec = Math.floor(Number(body.lifeSec));
    if (!(lifeSec >= cfg.limits.minLifeSec && lifeSec <= cfg.limits.maxLifeSec)) throw httpError(400, 'a call lives between 5 minutes and 7 days');
    assertCallQuota(u.id);
    let g;
    try { g = await ai.gate(question, lifeSec); } catch { throw httpError(503, 'the call checker is unavailable, try again soon'); }
    if (!g.ok) return { ok: false, reason: g.reason };
    const terms = { ...g.terms, post: question, highlight: pickHighlight(question, g.highlight) };
    const draftId = crypto.randomUUID();
    db.prepare('INSERT INTO drafts(id,user_id,terms_json,terms_hash,category,life_sec,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(draftId, u.id, JSON.stringify(terms), termsHash(terms), terms.category, lifeSec, nowMs());
    return { ok: true, draftId, terms, lifeSec };
  }, { auth: true });

  function assertCallQuota(userId) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM markets WHERE creator_id=? AND created_at>?').get(userId, nowMs() - DAY_MS).n;
    if (n >= cfg.limits.callsPerDay) throw httpError(429, `limit is ${cfg.limits.callsPerDay} calls per day`);
  }

  route('POST', '/api/calls/confirm', async ({ claims, body }) => {
    const u = upsertUser(claims);
    assertCallQuota(u.id);
    const d = db.prepare('SELECT * FROM drafts WHERE id=? AND user_id=?').get(String(body.draftId ?? ''), u.id);
    if (!d || d.used) throw httpError(404, 'draft not found');
    if (nowMs() - d.created_at > 30 * 60_000) throw httpError(410, 'that draft expired, write it again');
    // Claim the draft before spending gas so a double click cannot open two markets.
    const claimed = db.prepare('UPDATE drafts SET used=1 WHERE id=? AND used=0').run(d.id);
    if (claimed.changes !== 1) throw httpError(409, 'already confirmed');
    try {
      const closesAt = (await chain.chainNow()) + d.life_sec;
      const rc = await chain.send('gate', 'calls', 'createMarket', [u.wallet, d.category, d.terms_hash, closesAt], cfg.gas.createMarket);
      const ev = rc.logs.map(l => { try { return chain.iface.calls.parseLog(l); } catch { return null; } }).find(e => e?.name === 'MarketCreated');
      const id = Number(ev.args.id);
      db.prepare(`INSERT INTO markets(id,creator,creator_id,category,terms_json,terms_hash,closes_at,created_at,created_block)
                  VALUES(?,?,?,?,?,?,?,?,?)`).run(id, u.wallet, u.id, d.category, d.terms_json, d.terms_hash, closesAt, nowMs(), rc.blockNumber);
      return { id };
    } catch (e) {
      db.prepare('UPDATE drafts SET used=0 WHERE id=?').run(d.id);
      throw httpError(502, `could not open the call: ${e.shortMessage ?? e.message}`);
    }
  }, { auth: true });

  // --- feed
  route('GET', '/api/calls', async ({ claims, query }) => {
    const viewer = claims ? upsertUser(claims) : null;
    const limit = Math.min(Number(query.get('limit') || 30), 50);
    const where = []; const args = [];
    const cat = query.get('category');
    if (cat !== null && cat !== '') { where.push('category=?'); args.push(Number(cat)); }
    if (query.get('feed') === 'following') {
      if (!viewer) throw httpError(401, 'sign in to see who you follow');
      where.push('creator_id IN (SELECT u.id FROM follows f JOIN users u ON u.username_folded=f.followee WHERE f.follower=?)'); args.push(viewer.id);
    }
    if (query.get('creator')) { where.push('creator_id=(SELECT id FROM users WHERE username_folded=?)'); args.push(query.get('creator')); }
    const sql = `SELECT * FROM markets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...args, limit);
    return { calls: await Promise.all(rows.map(r => marketView(r, viewer?.wallet))) };
  }, { optionalAuth: true });

  route('GET', '/api/calls/:id', async ({ claims, params }) => {
    const viewer = claims ? upsertUser(claims) : null;
    const row = db.prepare('SELECT * FROM markets WHERE id=?').get(Number(params.id));
    if (!row) throw httpError(404, 'no such call');
    return marketView(row, viewer?.wallet);
  }, { optionalAuth: true });

  // --- signed votes, paid for by the relayer
  route('POST', '/api/votes', async ({ claims, body }) => {
    const u = upsertUser(claims);
    const id = Number(body.marketId);
    const row = db.prepare('SELECT * FROM markets WHERE id=?').get(id);
    if (!row) throw httpError(404, 'no such call');
    if (await chain.relayerLow()) throw httpError(503, 'free voting is paused for a moment, you can still vote with a small transaction');
    const sent = db.prepare('SELECT COUNT(*) AS n FROM relays r JOIN users x ON x.wallet=r.voter WHERE x.id=? AND r.created_at>?').get(u.id, nowMs() - DAY_MS).n;
    if (sent >= cfg.limits.votesPerDay) throw httpError(429, 'daily free vote limit reached');
    const o = await chain.read.calls.getMarket(id);
    const now = await chain.chainNow();
    if (Number(o.state) !== 0 || now >= Number(o.locksAt)) throw httpError(409, 'voting has closed on this call');
    if (await hasVoted(id, u.wallet)) throw httpError(409, 'you already voted on this call');
    const ins = db.prepare('INSERT OR IGNORE INTO relays(market_id,voter,created_at) VALUES(?,?,?)').run(id, u.wallet, nowMs());
    if (ins.changes !== 1) throw httpError(409, 'your vote is already being sent');
    try {
      const rc = await chain.send('relayer', 'calls', 'voteBySig', [id, !!body.yes, u.wallet, BigInt(body.deadline), body.sig], cfg.gas.vote);
      db.prepare('UPDATE relays SET tx=? WHERE market_id=? AND voter=?').run(rc.hash ?? null, id, u.wallet);
      return { ok: true };
    } catch (e) {
      db.prepare('DELETE FROM relays WHERE market_id=? AND voter=?').run(id, u.wallet);
      throw httpError(400, 'the vote was rejected (check the signature and deadline)');
    }
  }, { auth: true });

  // --- comments, only for people who voted
  route('GET', '/api/calls/:id/comments', async ({ claims, params }) => {
    const u = upsertUser(claims);
    const id = Number(params.id);
    const row = db.prepare('SELECT * FROM markets WHERE id=?').get(id);
    if (!row) throw httpError(404, 'no such call');
    if (row.creator_id !== u.id && !(await hasVoted(id, u.wallet))) throw httpError(403, 'vote first to read and join the discussion');
    const rows = db.prepare('SELECT c.id,c.body,c.created_at,u.username,u.x_username FROM comments c JOIN users u ON u.id=c.user_id WHERE market_id=? ORDER BY c.id').all(id);
    return { comments: rows.map(r => ({ id: r.id, body: r.body, createdAt: r.created_at, username: r.username, xVerified: !!r.x_username })) };
  }, { auth: true });

  route('POST', '/api/calls/:id/comments', async ({ claims, params, body }) => {
    const u = upsertUser(claims);
    if (!u.username) throw httpError(400, 'pick a username first');
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM markets WHERE id=?').get(id)) throw httpError(404, 'no such call');
    if (!(await hasVoted(id, u.wallet))) throw httpError(403, 'vote first to comment');
    const text = String(body.body ?? '').trim();
    if (text.length < 1 || text.length > 500) throw httpError(400, 'comments are 1-500 characters');
    const n = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE user_id=? AND created_at>?').get(u.id, nowMs() - DAY_MS).n;
    if (n >= cfg.limits.commentsPerDay) throw httpError(429, 'daily comment limit reached');
    const r = db.prepare('INSERT INTO comments(market_id,user_id,body,created_at) VALUES(?,?,?,?)').run(id, u.id, text, nowMs());
    return { id: Number(r.lastInsertRowid) };
  }, { auth: true });

  // --- share card
  route('GET', '/api/calls/:id/card.svg', async ({ params }) => {
    const row = db.prepare('SELECT * FROM markets WHERE id=?').get(Number(params.id));
    if (!row) throw httpError(404, 'no such call');
    const v = await marketView(row, null);
    const t = v.terms;
    const result = v.state === 'finalized' ? (v.outcome === 1 ? 'YES' : 'NO') : v.state === 'void' ? 'VOID' : v.state.toUpperCase();
    const wrap = (s, n) => s.match(new RegExp(`.{1,${n}}(\\s|$)`, 'g'))?.slice(0, 4).map(x => x.trim()) ?? [];
    const lines = wrap(t.question, 38).map((l, i) => `<text x="48" y="${150 + i * 44}" font-size="34" fill="#111">${esc(l)}</text>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 600 315">
<rect width="600" height="315" fill="#fff"/><g font-family="sans-serif">
<text x="48" y="64" font-size="22" fill="#666">${esc(v.categoryName)} call${v.creator?.username ? ' by @' + esc(v.creator.username) : ''}</text>${lines}
<text x="48" y="285" font-size="40" font-weight="bold" fill="#111">${esc(result)}</text></g></svg>`;
    return { raw: true, type: 'image/svg+xml', body: svg };
  });

  // --- people
  route('GET', '/api/users/:name', async ({ claims, params }) => {
    const viewer = claims ? upsertUser(claims) : null;
    const u = db.prepare('SELECT * FROM users WHERE username_folded=?').get(cleanFold(params.name));
    if (!u) throw httpError(404, 'no such user');
    const followers = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee=?').get(u.username_folded).n;
    const following = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower=?').get(u.id).n;
    const iFollow = viewer ? !!db.prepare('SELECT 1 FROM follows WHERE follower=? AND followee=?').get(viewer.id, u.username_folded) : false;
    return { ...publicUser(u), followers, following, iFollow, reputation: await reputationOf(u.wallet) };
  }, { optionalAuth: true });
  const cleanFold = n => { try { return cleanName(n).folded; } catch { return '\u0000'; } };

  route('POST', '/api/follow', async ({ claims, body }) => {
    const u = upsertUser(claims);
    const target = db.prepare('SELECT * FROM users WHERE username_folded=?').get(cleanFold(body.username));
    if (!target) throw httpError(404, 'no such user');
    if (target.id === u.id) throw httpError(400, 'you cannot follow yourself');
    db.prepare('INSERT OR IGNORE INTO follows(follower,followee,created_at) VALUES(?,?,?)').run(u.id, target.username_folded, nowMs());
    return { ok: true };
  }, { auth: true });

  route('POST', '/api/unfollow', async ({ claims, body }) => {
    const u = upsertUser(claims);
    db.prepare('DELETE FROM follows WHERE follower=? AND followee=?').run(u.id, cleanFold(body.username));
    return { ok: true };
  }, { auth: true });

  let boardCache = new Map();
  route('GET', '/api/leaderboard', async ({ query }) => {
    const cat = Number(query.get('category') ?? 0);
    if (!(cat >= 0 && cat <= 4)) throw httpError(400, 'bad category');
    const hit = boardCache.get(cat);
    if (hit && nowMs() - hit.at < 60_000) return hit.data;
    const users = db.prepare('SELECT * FROM users WHERE username IS NOT NULL').all();
    const rows = await Promise.all(users.map(async u => {
      const [score, scored, won] = await Promise.all([
        chain.read.reputation.score(u.wallet, cat), chain.read.reputation.callsScored(u.wallet, cat), chain.read.reputation.callsWon(u.wallet, cat)]);
      return { ...publicUser(u), wallet: undefined, score: Number(score) / 100, scored: Number(scored), won: Number(won) };
    }));
    const data = { category: cat, name: CATEGORIES[cat], board: rows.filter(r => r.scored > 0).sort((a, b) => b.score - a.score).slice(0, 50) };
    boardCache.set(cat, { at: nowMs(), data });
    return data;
  });

  // --- pools
  route('GET', '/api/pools', async ({ query }) => {
    await jobs.syncPools();
    const limit = Math.min(Number(query.get('limit') || 30), 50);
    const rows = db.prepare('SELECT * FROM pools ORDER BY id DESC LIMIT ?').all(limit);
    return { pools: await Promise.all(rows.map(r => poolView(r.id))) };
  });

  // Revealed guesses are public onchain. Cached per pool until another one is revealed.
  const guessCache = new Map();
  async function revealedGuesses(id, p) {
    const n = Number(p.revealedCount);
    if (n === 0) return [];
    const hit = guessCache.get(id);
    if (hit && hit.n === n) return hit.list;
    const list = [];
    for (let eid = 1; eid <= Number(p.entryCount); eid++) {
      const e = await chain.read.pools.getEntry(id, eid);
      if (e.revealed) list.push(e.guess.toString());
    }
    guessCache.set(id, { n, list });
    return list;
  }

  async function poolView(id) {
    const p = await chain.read.pools.getPool(id);
    const refund = await chain.read.pools.refundAll(id);
    const creator = userByWallet(p.creator);
    return {
      id, creator: publicUser(creator) ?? { wallet: p.creator.toLowerCase() }, asset: Number(p.asset),
      entryAmount: ethers.formatEther(p.entryAmount), lockTime: Number(p.lockTime), resultTime: Number(p.resultTime),
      entries: Number(p.entryCount), revealed: Number(p.revealedCount), priced: p.priced,
      price: p.priced ? p.price.toString() : null, refunded: refund, voided: p.voided,
      pot: ethers.formatEther(p.entryAmount * BigInt(p.entryCount)),
      guesses: await revealedGuesses(id, p),
    };
  }
  route('GET', '/api/pools/:id', async ({ params }) => {
    await jobs.syncPools();
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM pools WHERE id=?').get(id)) throw httpError(404, 'no such pool');
    return poolView(id);
  });

  // The app stores your sealed guess here so the server can reveal it for you at lock time.
  route('POST', '/api/pools/:id/guess', async ({ claims, params, body }) => {
    const u = upsertUser(claims);
    const id = Number(params.id);
    const entryId = Number(body.entryId);
    const e = await chain.read.pools.getEntry(id, entryId);
    if (e.entrant === ethers.ZeroAddress || lc(e.entrant) !== u.wallet) throw httpError(403, 'that entry is not yours');
    const guess = BigInt(body.guess);
    const expect = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'bytes32', 'address', 'uint256'], [guess, body.salt, e.entrant, id]));
    if (expect !== e.commitment) throw httpError(400, 'that guess does not match your sealed entry');
    db.prepare('INSERT OR REPLACE INTO guesses(pool_id,entry_id,entrant,guess,salt,revealed) VALUES(?,?,?,?,?,?)')
      .run(id, entryId, u.wallet, guess.toString(), body.salt, e.revealed ? 1 : 0);
    return { ok: true };
  }, { auth: true });

  // ------------------------------------------------------------- server
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const cors = { 'access-control-allow-origin': cfg.corsOrigin, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    try {
      const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw httpError(404, 'not found');
      const params = url.pathname.match(r.re).groups ?? {};
      let claims = null;
      if (r.auth) claims = await authenticate(req, verify);
      else if (r.optionalAuth && req.headers.authorization) claims = await authenticate(req, verify).catch(() => null);
      let body = {};
      if (req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 20_000) throw httpError(413, 'too large'); chunks.push(c); }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw httpError(400, 'bad JSON'); }
      }
      const out = await r.handler({ req, claims, params, query: url.searchParams, body });
      if (out?.raw) { res.writeHead(200, { ...cors, 'content-type': out.type, 'cache-control': 'public, max-age=60' }); return res.end(out.body); }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (e) {
      const status = e.status ?? 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'something went wrong' : e.message }));
    }
  }
  return http.createServer(handle);
}
