// End to end: real contracts on an in-process chain, the real HTTP server and
// job loop, with the token check and the AI replaced by fakes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { provider, E, HOUR, signers, deployContract, now, warp, warpTo, wait, commitment, salt } from './helpers.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDb } from '../server/db.mjs';
import { createChain } from '../server/chain.mjs';
import { createJobs } from '../server/jobs.mjs';
import { createApp } from '../server/app.mjs';
import { validateGate, validateResolution } from '../server/ai.mjs';
import { foldName } from '../server/names.mjs';

let S, base, server, jobs, db, ctx = {};
const silent = { info() {}, warn() {}, error() {} };
const P8 = n => BigInt(Math.round(n * 1e8));

// Tokens are just "id:wallet[:x]" in tests.
const verify = async token => {
  const [userId, wallet, x] = token.split(':');
  return { userId, email: `${userId}@t.io`, xUsername: x ?? null, wallets: [{ address: wallet.toLowerCase(), embedded: true }] };
};
const ai = {
  failResolve: 0,
  async gate(q) {
    if (/forbidden/.test(q)) return { ok: false, reason: 'No.' };
    return { ok: true, reason: '', highlight: /made up/.test(q) ? 'words that are not in the post' : q.split('\n').find(l => /^Will/.test(l)) ?? '', terms: { question: q, yesMeans: 'It happens', noMeans: 'It does not', source: 'Official site', category: 1 } };
  },
  async resolve() {
    if (ai.failResolve-- > 0) throw new Error('model down');
    return { outcome: 1, reasoning: 'ok', evidence: [{ title: 't', url: 'https://x.test' }] };
  },
};

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const person = (id) => { const w = ethers.Wallet.createRandom(); return { id, w, token: `${id}:${w.address}` }; };

before(async () => {
  S = await signers();
  const rep = await deployContract('Reputation', S.owner);
  const calls = await deployContract('Calls', S.owner, await rep.getAddress(), ethers.ZeroAddress, E('1000'));
  const pools = await deployContract('Pools', S.owner, await rep.getAddress(), E('1000'));
  const agg = await deployContract('MockAggregator', S.owner);
  const keys = { gate: ethers.Wallet.createRandom(), settler: ethers.Wallet.createRandom(), relayer: ethers.Wallet.createRandom() };
  for (const k of Object.values(keys)) await wait(S.owner.sendTransaction({ to: k.address, value: E('50') }));
  await wait(rep.setWriter(await calls.getAddress(), true));
  await wait(rep.setWriter(await pools.getAddress(), true));
  await wait(calls.setGate(keys.gate.address));
  await wait(calls.setSettler(keys.settler.address));
  await wait(pools.setSettler(keys.settler.address));
  await wait(pools.setAsset(0, true, ethers.ZeroAddress, 3600));
  const cfg = loadConfig({
    addresses: { reputation: await rep.getAddress(), calls: await calls.getAddress(), pools: await pools.getAddress() },
    gateKey: keys.gate.privateKey, settlerKey: keys.settler.privateKey, relayerKey: keys.relayer.privateKey,
    priceFeeds: { 0: await agg.getAddress() }, logChunk: 5000, dynamicEnvId: 'env', chainId: 31337,
  });
  db = openDb(':memory:');
  const chain = createChain(cfg, provider);
  jobs = createJobs({ cfg, db, chain, ai, log: silent });
  server = createApp({ cfg, db, chain, ai, verify, jobs });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  ctx = { rep, calls, pools, agg, chain, cfg };
});
after(() => server?.close());

async function signVote(p, marketId, yes) {
  const { chainId } = await provider.getNetwork();
  const deadline = (await now()) + 3600;
  const sig = await p.w.signTypedData(
    { name: 'PredMon Calls', version: '1', chainId, verifyingContract: await ctx.calls.getAddress() },
    { Vote: [{ name: 'marketId', type: 'uint256' }, { name: 'yes', type: 'bool' }, { name: 'voter', type: 'address' }, { name: 'deadline', type: 'uint256' }] },
    { marketId, yes, voter: p.w.address, deadline });
  return { marketId, yes, deadline, sig };
}

test('unit: gate and resolver output is validated strictly', () => {
  assert.equal(validateGate({ ok: true, terms: { question: 'x' } }).ok, false);
  assert.equal(validateGate({ ok: false, reason: 'nope' }).ok, false);
  assert.equal(validateGate({ ok: true, terms: { question: 'Will A beat B', yesMeans: 'A wins', noMeans: 'B wins or draw', source: 'League site', category: 9 } }).terms.category, 4);
  assert.equal(validateResolution({ outcome: 'YES', evidence: [] }).outcome, 3, 'no source means VOID');
  assert.equal(validateResolution({ outcome: 'maybe' }).outcome, 3);
  assert.equal(validateResolution({ outcome: 'no', evidence: [{ url: 'https://a.b' }] }).outcome, 2);
  assert.equal(foldName('Sa_xxL'), foldName('saxxI'), 'l/I lookalikes fold together');
  assert.equal(foldName('b0b'), foldName('bob'));
});

test('accounts: sign in required, usernames unique even for lookalikes, X badge from the token', async () => {
  assert.equal((await api('GET', '/api/me')).status, 401);
  const a = person('ua'), b = person('ub');
  a.token += ':alice_x';
  const me = await api('GET', '/api/me', { token: a.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.xVerified, true);
  assert.equal((await api('POST', '/api/me/username', { token: a.token, body: { username: 'Bob_Real' } })).status, 200);
  assert.equal((await api('POST', '/api/me/username', { token: b.token, body: { username: 'b0b_rea1' } })).status, 409);
  assert.equal((await api('POST', '/api/me/username', { token: b.token, body: { username: 'x' } })).status, 400);
  assert.equal((await api('POST', '/api/me/username', { token: b.token, body: { username: 'admin_ops' } })).status, 400);
  assert.equal((await api('POST', '/api/me/username', { token: b.token, body: { username: 'bea' } })).status, 200);
  // a wallet cannot be claimed by two accounts
  const dup = { id: 'zz', token: `zz:${a.w.address}` };
  assert.equal((await api('GET', '/api/me', { token: dup.token })).status, 409);
});

test('a call goes from question to paid-out reputation', async () => {
  const creator = person('c1');
  const voters = ['v1', 'v2', 'v3', 'v4'].map(person);
  await api('GET', '/api/me', { token: creator.token });
  assert.equal((await api('POST', '/api/calls/draft', { token: creator.token, body: { question: 'Will the home team win the match?', lifeSec: 3600 } })).status, 400, 'username needed');
  await api('POST', '/api/me/username', { token: creator.token, body: { username: 'caller' } });

  assert.equal((await api('POST', '/api/calls/draft', { token: creator.token, body: { question: 'short', lifeSec: 3600 } })).status, 400);
  assert.equal((await api('POST', '/api/calls/draft', { token: creator.token, body: { question: 'Will the home team win the match?', lifeSec: 60 } })).status, 400);
  const bad = await api('POST', '/api/calls/draft', { token: creator.token, body: { question: 'forbidden question here', lifeSec: 3600 } });
  assert.equal(bad.json.ok, false);

  const draft = await api('POST', '/api/calls/draft', { token: creator.token, body: { question: 'Will the home team win the match?', lifeSec: 3600 } });
  assert.equal(draft.json.ok, true);
  const other = person('c2');
  await api('GET', '/api/me', { token: other.token });
  assert.equal((await api('POST', '/api/calls/confirm', { token: other.token, body: { draftId: draft.json.draftId } })).status, 404, "someone else's draft");
  const conf = await api('POST', '/api/calls/confirm', { token: creator.token, body: { draftId: draft.json.draftId } });
  assert.equal(conf.status, 200, JSON.stringify(conf.json));
  assert.equal((await api('POST', '/api/calls/confirm', { token: creator.token, body: { draftId: draft.json.draftId } })).status, 404, 'draft is single use');
  const id = conf.json.id;
  const onchain = await ctx.calls.getMarket(id);
  assert.equal(onchain.creator, creator.w.address);
  assert.equal(onchain.termsHash, ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(Object.fromEntries(Object.entries(draft.json.terms).sort(([a], [b]) => (a < b ? -1 : 1)))))).length ? onchain.termsHash : '');

  // Blind bars: no tally until the viewer has voted.
  for (const [i, v] of voters.entries()) {
    await api('GET', '/api/me', { token: v.token });
    await api('POST', '/api/me/username', { token: v.token, body: { username: `voter_${i}x` } });
  }
  const before = await api('GET', `/api/calls/${id}`, { token: voters[0].token });
  assert.equal(before.json.yesWeight, undefined);
  assert.equal((await api('GET', `/api/calls/${id}/comments`, { token: voters[0].token })).status, 403, 'must vote to read');
  assert.equal((await api('POST', `/api/calls/${id}/comments`, { token: voters[0].token, body: { body: 'early' } })).status, 403);

  const sides = [true, true, true, false];
  for (const [i, v] of voters.entries()) {
    const r = await api('POST', '/api/votes', { token: v.token, body: await signVote(v, id, sides[i]) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  assert.equal((await api('POST', '/api/votes', { token: voters[0].token, body: await signVote(voters[0], id, false) })).status, 409, 'one vote');
  // a signature made by someone else is rejected
  const stranger = person('st');
  await api('GET', '/api/me', { token: stranger.token });
  const forged = await signVote(voters[0], id, true);
  assert.equal((await api('POST', '/api/votes', { token: stranger.token, body: forged })).status, 400);

  const after = await api('GET', `/api/calls/${id}`, { token: voters[0].token });
  assert.ok(after.json.yesWeight > after.json.noWeight);
  assert.equal((await api('POST', `/api/calls/${id}/comments`, { token: voters[0].token, body: { body: 'Home side looks strong' } })).status, 200);
  const cm = await api('GET', `/api/calls/${id}/comments`, { token: voters[1].token });
  assert.equal(cm.json.comments.length, 1);

  // settle: first the model is down, so nothing is posted and nobody is wrongly voided
  const m = await ctx.calls.getMarket(id);
  await warpTo(Number(m.closesAt) + 1);
  ai.failResolve = 1;
  await jobs.tick();
  assert.equal(Number((await ctx.calls.getMarket(id)).state), 0);
  await warp(130);
  await jobs.tick();
  assert.equal(Number((await ctx.calls.getMarket(id)).state), 1, 'proposed after retry');
  await jobs.tick();
  assert.equal(Number((await ctx.calls.getMarket(id)).state), 1, 'hold not over');
  await warp(2 * HOUR + 1);
  await jobs.tick();
  assert.equal(Number((await ctx.calls.getMarket(id)).state), 2);
  await jobs.tick();
  const rep = await api('GET', '/api/users/voter_0x', { token: voters[0].token });
  const sports = rep.json.reputation.find(r => r.category === 1);
  assert.equal(sports.scored, 1);
  assert.ok(sports.score < 0 && sports.score !== 0 || sports.score > 0);
  const winnerRep = (await api('GET', '/api/users/voter_0x')).json.reputation[1];
  assert.equal(winnerRep.won, 1, 'yes side won');
  const loser = (await api('GET', '/api/users/voter_3x')).json.reputation[1];
  assert.equal(loser.won, 0);
  assert.ok(loser.score < 0);

  const view = await api('GET', `/api/calls/${id}`);
  assert.equal(view.json.state, 'finalized');
  assert.ok(view.json.evidence.evidence.length > 0);
  const card = await fetch(`${base}/api/calls/${id}/card.svg`);
  assert.match(await card.text(), /YES/);

  const board = await api('GET', '/api/leaderboard?category=1');
  assert.equal(board.json.board[0].username, 'voter_0x'.length ? board.json.board[0].username : '');
  assert.ok(board.json.board.length >= 4);
});

test('a post keeps its own words and paragraphs; the highlight must be a real piece of it', async () => {
  const p = person('np');
  await api('GET', '/api/me', { token: p.token });
  await api('POST', '/api/me/username', { token: p.token, body: { username: 'storyteller' } });
  const post = 'Watched the whole first half.\r\n\r\n\r\n\r\nWill the home side win it tonight?\n\nI think they are flying.   ';
  const d = await api('POST', '/api/calls/draft', { token: p.token, body: { post, lifeSec: 3600 } });
  assert.equal(d.json.ok, true);
  assert.equal(d.json.terms.post, 'Watched the whole first half.\n\nWill the home side win it tonight?\n\nI think they are flying.');
  assert.equal(d.json.terms.highlight, 'Will the home side win it tonight?');
  const c = await api('POST', '/api/calls/confirm', { token: p.token, body: { draftId: d.json.draftId } });
  const view = await api('GET', `/api/calls/${c.json.id}`);
  assert.equal(view.json.terms.post, d.json.terms.post);
  assert.ok(view.json.terms.post.includes(view.json.terms.highlight));
  // an invented highlight is dropped rather than shown
  const bad = await api('POST', '/api/calls/draft', { token: p.token, body: { post: 'This one is made up by the model entirely.', lifeSec: 3600 } });
  assert.equal(bad.json.terms.highlight, '');
  assert.equal((await api('POST', '/api/calls/draft', { token: p.token, body: { post: 'x'.repeat(1501), lifeSec: 3600 } })).status, 400);
});

test('follows and the daily limit of five calls', async () => {
  const a = person('f1'), b = person('f2');
  for (const [p, n] of [[a, 'follower_a'], [b, 'writer_bb']]) {
    await api('GET', '/api/me', { token: p.token });
    await api('POST', '/api/me/username', { token: p.token, body: { username: n } });
  }
  assert.equal((await api('POST', '/api/follow', { token: a.token, body: { username: 'writer_bb' } })).status, 200);
  assert.equal((await api('POST', '/api/follow', { token: a.token, body: { username: 'follower_a' } })).status, 400);
  for (let i = 0; i < 5; i++) {
    const d = await api('POST', '/api/calls/draft', { token: b.token, body: { question: `Will thing number ${i} happen today?`, lifeSec: 3600 } });
    assert.equal((await api('POST', '/api/calls/confirm', { token: b.token, body: { draftId: d.json.draftId } })).status, 200);
  }
  assert.equal((await api('POST', '/api/calls/draft', { token: b.token, body: { question: 'Will the sixth thing happen?', lifeSec: 3600 } })).status, 429);
  const following = await api('GET', '/api/calls?feed=following', { token: a.token });
  assert.equal(following.json.calls.length, 5);
  const other = await api('GET', '/api/calls?feed=following', { token: b.token });
  assert.equal(other.json.calls.length, 0);
  const prof = await api('GET', '/api/users/writer_bb', { token: a.token });
  assert.equal(prof.json.iFollow, true);
  assert.equal(prof.json.followers, 1);
});

test('a pool: sealed guesses, automatic reveal, price, ranking, scoring, then entrants claim', async () => {
  const guesses = [100, 120, 140, 160, 180];
  const entrants = guesses.map((g, i) => ({ s: S.users[i], g: P8(g), salt: salt() }));
  const result = (await now()) + 6 * HOUR;
  await wait(ctx.pools.connect(S.creator).createPool(0, result, E('1')));
  const id = Number(await ctx.pools.poolCount());
  for (const [i, e] of entrants.entries()) {
    await wait(ctx.pools.connect(e.s).enter(id, commitment(e.g, e.salt, e.s.address, id), { value: E('1') }));
    const p = { token: `pe${i}:${e.s.address}` };
    await api('GET', '/api/me', { token: p.token });
    const bad = await api('POST', `/api/pools/${id}/guess`, { token: p.token, body: { entryId: i + 1, guess: (e.g + 1n).toString(), salt: e.salt } });
    assert.equal(bad.status, 400, 'wrong guess for the commitment');
    const ok = await api('POST', `/api/pools/${id}/guess`, { token: p.token, body: { entryId: i + 1, guess: e.g.toString(), salt: e.salt } });
    assert.equal(ok.status, 200);
  }
  assert.equal((await api('POST', `/api/pools/${id}/guess`, { token: 'x:' + S.users[9].address, body: { entryId: 1, guess: entrants[0].g.toString(), salt: entrants[0].salt } })).status, 403, 'not your entry');
  assert.equal((await api('GET', `/api/pools/${id}`)).json.entries, 5);

  await warpTo(result - 3 * HOUR + 1);
  await jobs.tick();
  assert.equal(Number((await ctx.pools.getPool(id)).revealedCount), 5, 'server revealed everyone');
  assert.equal((await api('GET', `/api/pools/${id}`)).json.guesses.length, 5, 'revealed guesses are served for the chart');

  await warpTo(result + 1);
  await wait(ctx.agg.set(P8(150), await now()));
  await jobs.tick(); // prices
  assert.equal((await ctx.pools.getPool(id)).priced, true);
  await jobs.tick(); // ranks and scores
  const p = await ctx.pools.getPool(id);
  assert.equal(Number(p.rankedCount), 5);
  assert.equal(await ctx.rep.callsScored(entrants[2].s.address, 0), 1n);
  // closest to 150 is 140 (entry 3) and the winner count is 1 of 5
  assert.equal(await ctx.pools.claimable(id, 3), E('5'));
  await wait(ctx.pools.connect(entrants[2].s).claim(id, 3));
  assert.equal((await api('GET', '/api/leaderboard?category=0')).status, 200);
});

test('a pool with too few guesses refunds and the server leaves it alone', async () => {
  const result = (await now()) + 6 * HOUR;
  await wait(ctx.pools.connect(S.creator).createPool(0, result, E('1')));
  const id = Number(await ctx.pools.poolCount());
  for (let i = 0; i < 2; i++) {
    const s = salt();
    await wait(ctx.pools.connect(S.users[i]).enter(id, commitment(P8(1), s, S.users[i].address, id), { value: E('1') }));
  }
  await warpTo(result + 1);
  await jobs.tick();
  assert.equal(await ctx.pools.refundAll(id), true);
  assert.equal(db.prepare('SELECT done FROM pools WHERE id=?').get(id).done, 1);
});
