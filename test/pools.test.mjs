import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  E, HOUR, DAY, signers, deployContract, now, warp, warpTo, reverts, wait, balance,
  commitment, salt, metadataFor,
} from './helpers.mjs';

let S;
before(async () => { S = await signers(); });
const P8 = n => BigInt(Math.round(n * 1e8)); // prices carry 8 decimals

async function setup({ maxEntry = E('1000'), feed = false } = {}) {
  const rep = await deployContract('Reputation', S.owner);
  const pools = await deployContract('Pools', S.owner, await rep.getAddress(), maxEntry);
  await wait(rep.setWriter(await pools.getAddress(), true));
  await wait(pools.setSettler(S.settler.address));
  let agg = null;
  if (feed) {
    agg = await deployContract('MockAggregator', S.owner);
    await wait(pools.setAsset(0, true, await agg.getAddress(), 3600));
  } else {
    await wait(pools.setAsset(0, true, ethers.ZeroAddress, 3600));
  }
  return { rep, pools, agg };
}

/** Opens a pool and enters one sealed guess per user. Returns what is needed to reveal. */
async function populate(pools, guesses, { amount = E('1'), hoursToResult = 6 } = {}) {
  const resultTime = (await now()) + hoursToResult * HOUR;
  await wait(pools.connect(S.creator).createPool(0, resultTime, amount));
  const id = Number(await pools.poolCount());
  const entries = [];
  for (let i = 0; i < guesses.length; i++) {
    const u = S.users[i];
    const s = salt();
    const g = P8(guesses[i]);
    await wait(pools.connect(u).enter(id, commitment(g, s, u.address, id), { value: amount }));
    entries.push({ u, g, s, entryId: i + 1 });
  }
  return { id, resultTime, entries };
}
async function revealAll(pools, id, entries) {
  const p = await pools.getPool(id);
  await warpTo(Number(p.lockTime) + 1);
  for (const e of entries) await wait(pools.reveal(id, e.entryId, e.g, e.s));
}
const rankOrder = (entries, price) =>
  [...entries].sort((a, b) => {
    const da = a.g > price ? a.g - price : price - a.g;
    const db = b.g > price ? b.g - price : price - b.g;
    return da < db ? -1 : da > db ? 1 : a.entryId - b.entryId;
  }).map(e => e.entryId);
async function finish(pools, id, entries, price) {
  const p = await pools.getPool(id);
  await warpTo(Number(p.resultTime) + 1);
  await wait(pools.connect(S.settler).reportPrice(id, price, await now()));
  await wait(pools.connect(S.settler).submitRanking(id, rankOrder(entries, price)));
}

test('creation: asset enabled, entry within the cap, windows, three a day', async () => {
  const { pools } = await setup({ maxEntry: E('5') });
  const t = await now();
  const ok = t + 6 * HOUR;
  await reverts(pools.connect(S.creator).createPool(1, ok, E('1')), 'BadAsset');
  await reverts(pools.connect(S.creator).createPool(0, ok, 0), 'BadEntryAmount');
  await reverts(pools.connect(S.creator).createPool(0, ok, E('5.1')), 'BadEntryAmount');
  await reverts(pools.connect(S.creator).createPool(0, t + 3 * HOUR, E('1')), 'BadWindow');
  await reverts(pools.connect(S.creator).createPool(0, t + 8 * DAY, E('1')), 'BadWindow');
  await reverts(pools.connect(S.users[0]).setMaxEntry(E('1000')), 'NotOwner');
  await wait(pools.connect(S.creator).createPool(0, ok, E('5')));
  await wait(pools.connect(S.creator).createPool(0, ok, E('1')));
  await wait(pools.connect(S.creator).createPool(0, ok, E('1')));
  await reverts(pools.connect(S.creator).createPool(0, ok, E('1')), 'DailyLimit');
  await wait(pools.connect(S.users[0]).createPool(0, ok, E('1'))); // others are unaffected
  await wait(pools.connect(S.owner).setMaxEntry(E('1000')));
  await warp(DAY); // new day, fresh allowance
  await wait(pools.connect(S.creator).createPool(0, (await now()) + 6 * HOUR, E('900')));
});

test('entering: exact amount, before lock, capacity, several entries allowed', async () => {
  const { pools } = await setup();
  const { id } = await populate(pools, [100]);
  const c = commitment(P8(1), salt(), S.users[1].address, id);
  await reverts(pools.connect(S.users[1]).enter(id, c, { value: E('0.5') }), 'WrongAmount');
  await reverts(pools.connect(S.users[1]).enter(id, c, { value: E('2') }), 'WrongAmount');
  await reverts(pools.connect(S.users[1]).enter(99, c, { value: E('1') }), 'NoSuchPool');
  await wait(pools.connect(S.users[0]).enter(id, c, { value: E('1') })); // second entry by the same user
  assert.equal(Number((await pools.getPool(id)).entryCount), 2);
  assert.equal(await pools.firstEntry(id, S.users[0].address), 1n);

  await warpTo(Number((await pools.getPool(id)).lockTime) + 1);
  await reverts(pools.connect(S.users[2]).enter(id, c, { value: E('1') }), 'EntriesClosed');
});

test('a pool holds at most 300 entries', async () => {
  const { pools } = await setup();
  const t = (await now()) + 6 * HOUR;
  await wait(pools.connect(S.creator).createPool(0, t, 1n));
  const id = Number(await pools.poolCount());
  const c = ethers.id('x');
  for (let i = 0; i < 300; i++) await pools.connect(S.users[0]).enter(id, c, { value: 1n });
  await reverts(pools.connect(S.users[0]).enter(id, c, { value: 1n }), 'PoolFull');
});

test('reveal: only inside lock..result, only the true guess and salt, once', async () => {
  const { pools } = await setup();
  const { id, entries } = await populate(pools, [100, 200, 300]);
  const [a] = entries;
  await reverts(pools.reveal(id, 1, a.g, a.s), 'RevealClosed'); // before lock
  const p = await pools.getPool(id);
  await warpTo(Number(p.lockTime) + 1);
  await reverts(pools.reveal(id, 1, a.g + 1n, a.s), 'BadReveal');
  await reverts(pools.reveal(id, 1, a.g, salt()), 'BadReveal');
  await reverts(pools.reveal(id, 99, a.g, a.s), 'BadReveal');
  await wait(pools.connect(S.users[9]).reveal(id, 1, a.g, a.s)); // anyone may submit it
  await reverts(pools.reveal(id, 1, a.g, a.s), 'AlreadyReveal'.replace('Reveal', 'Revealed'));
  await warpTo(Number(p.resultTime));
  await reverts(pools.reveal(id, 2, entries[1].g, entries[1].s), 'RevealClosed');
});

test('a commitment is bound to its entrant and pool', async () => {
  const { pools } = await setup();
  const { id } = await populate(pools, [100, 200, 300]);
  // user1 copies user0's commitment hash for their own entry: they cannot reveal without the salt anyway,
  // and a hash made for another address does not verify for them.
  const s = salt();
  const stolen = commitment(P8(5), s, S.users[0].address, id);
  await wait(pools.connect(S.users[5]).enter(id, stolen, { value: E('1') }));
  await warpTo(Number((await pools.getPool(id)).lockTime) + 1);
  await reverts(pools.reveal(id, 4, P8(5), s), 'BadReveal');
});

test('settlement from the feed: window, staleness, bad answers, single use', async () => {
  const { pools, agg } = await setup({ feed: true });
  const { id, entries } = await populate(pools, [100, 200, 300]);
  const p = await pools.getPool(id);
  await warpTo(Number(p.lockTime) + 1);
  for (const e of entries) await wait(pools.reveal(id, e.entryId, e.g, e.s));

  await reverts(pools.settleFromFeed(id), 'NotYet');
  await warpTo(Number(p.resultTime) + 1);
  await wait(agg.set(0, await now()));
  await reverts(pools.settleFromFeed(id), 'BadPrice');
  await wait(agg.set(P8(150), (await now()) - 2 * HOUR));
  await reverts(pools.settleFromFeed(id), 'BadPrice'); // stale
  await wait(agg.set(P8(150), await now()));
  await wait(pools.connect(S.users[8]).settleFromFeed(id));
  assert.equal((await pools.getPool(id)).price, P8(150));
  await reverts(pools.settleFromFeed(id), 'AlreadyPriced');

  const { id: id2, entries: e2 } = await populate(pools, [1, 2, 3]);
  await revealAll(pools, id2, e2);
  await warpTo(Number((await pools.getPool(id2)).resultTime) + 11 * 60);
  await wait(agg.set(P8(150), await now()));
  await reverts(pools.settleFromFeed(id2), 'TooLate');
});

test('feed settlement needs a configured feed', async () => {
  const { pools } = await setup();
  const { id, entries } = await populate(pools, [1, 2, 3]);
  await revealAll(pools, id, entries);
  await warpTo(Number((await pools.getPool(id)).resultTime) + 1);
  await reverts(pools.settleFromFeed(id), 'NoFeed');
});

test('reportPrice: settler only, after the result time, plausible timestamp, once', async () => {
  const { pools } = await setup();
  const { id, entries } = await populate(pools, [100, 200, 300]);
  await revealAll(pools, id, entries);
  const p = await pools.getPool(id);
  await reverts(pools.connect(S.settler).reportPrice(id, P8(1), await now()), 'NotYet');
  await warpTo(Number(p.resultTime) + 1);
  const t = await now();
  await reverts(pools.connect(S.users[0]).reportPrice(id, P8(1), t), 'NotAuthorized');
  await reverts(pools.connect(S.settler).reportPrice(id, 0, t), 'BadPrice');
  await reverts(pools.connect(S.settler).reportPrice(id, P8(1), t + 1000), 'BadPrice');
  await reverts(pools.connect(S.settler).reportPrice(id, P8(1), Number(p.resultTime) - 2 * DAY), 'BadPrice');
  await wait(pools.connect(S.settler).reportPrice(id, P8(1), t));
  await reverts(pools.connect(S.settler).reportPrice(id, P8(2), t), 'AlreadyPriced');
});

test('the forwarder can deliver a price report', async () => {
  const { pools } = await setup();
  const { id, entries } = await populate(pools, [100, 200, 300]);
  await revealAll(pools, id, entries);
  await warpTo(Number((await pools.getPool(id)).resultTime) + 1);
  await wait(pools.connect(S.owner).setForwarder(S.forwarder.address, S.users[7].address));
  const report = ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256', 'uint64'], [id, P8(150), await now()]);
  await reverts(pools.connect(S.forwarder).onReport(metadataFor(S.users[8].address), report), 'NotAuthorized');
  await wait(pools.connect(S.forwarder).onReport(metadataFor(S.users[7].address), report));
  assert.equal((await pools.getPool(id)).price, P8(150));
});

test('ranking is verified on chain: wrong order, duplicates, unrevealed all revert; chunks are fine', async () => {
  const { pools } = await setup();
  const { id, entries } = await populate(pools, [100, 140, 155, 180, 90]);
  await revealAll(pools, id, entries);
  const p = await pools.getPool(id);
  await reverts(pools.connect(S.settler).submitRanking(id, [1]), 'NotPriced');
  await warpTo(Number(p.resultTime) + 1);
  await wait(pools.connect(S.settler).reportPrice(id, P8(150), await now()));

  const order = rankOrder(entries, P8(150)); // closest first
  assert.deepEqual(order, [3, 2, 4, 1, 5]);
  await reverts(pools.connect(S.users[0]).submitRanking(id, [3]), 'NotAuthorized');
  await reverts(pools.connect(S.settler).submitRanking(id, [2, 3]), 'BadRanking');
  await reverts(pools.connect(S.settler).submitRanking(id, [3, 3]), 'BadRanking');
    await reverts(pools.connect(S.settler).submitRanking(id, new Array(301).fill(3)), 'BatchTooLarge');
  await wait(pools.connect(S.settler).submitRanking(id, order.slice(0, 2)));
  await reverts(pools.connect(S.settler).submitRanking(id, [5, 1, 4]), 'BadRanking'); // continues behind the last ranked
  await wait(pools.connect(S.settler).submitRanking(id, order.slice(2)));
  assert.equal(Number((await pools.getPool(id)).rankedCount), 5);
  // a skipped entry can never be ranked afterwards, which is why only the settler may submit
  await reverts(pools.connect(S.settler).submitRanking(id, [1]), 'BadRanking'); // already ranked
});

test('equal distances rank by lower entry number', async () => {
  const { pools } = await setup();
  const { id, entries } = await populate(pools, [140, 160, 100]);
  await revealAll(pools, id, entries);
  await warpTo(Number((await pools.getPool(id)).resultTime) + 1);
  await wait(pools.connect(S.settler).reportPrice(id, P8(150), await now()));
  await reverts(pools.connect(S.settler).submitRanking(id, [2, 1, 3]), 'BadRanking');
  await wait(pools.connect(S.settler).submitRanking(id, [1, 2, 3]));
});

test('payouts: the closest 30% split the whole pot by linear weights; reputation by rank', async () => {
  const { pools, rep } = await setup();
  const guesses = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190]; // price 148 -> 150,140,160,130,170,...
  const { id, entries } = await populate(pools, guesses, { amount: E('2') });
  await revealAll(pools, id, entries);
  await finish(pools, id, entries, P8(148));
  assert.equal(await pools.winnerCount(id), 3n);

  const order = rankOrder(entries, P8(148));
  const pot = E('20');
  const expected = [pot * 3n / 6n, pot * 2n / 6n, pot * 1n / 6n];
  const sum = expected.reduce((a, b) => a + b, 0n);
  assert.ok(sum <= pot);
  for (let r = 0; r < 3; r++) {
    assert.equal(await pools.claimable(id, order[r]), expected[r]);
  }
  assert.equal(await pools.claimable(id, order[3]), 0n);

  await reverts(pools.connect(S.users[9]).claim(id, order[0]), 'NotEntrant');
  const winner = entries.find(e => e.entryId === order[0]);
  const before = await balance(winner.u);
  const r = await wait(pools.connect(winner.u).claim(id, order[0]));
  assert.equal((await balance(winner.u)) - before + r.gasUsed * r.gasPrice, expected[0]);
  await reverts(pools.connect(winner.u).claim(id, order[0]), 'NothingToClaim');

  // Claiming scored everyone's first entry? No - only the claimer. Score the rest in one batch.
  await wait(pools.scoreEntries(id, entries.map(e => e.entryId)));
  const n = 10n;
  for (let rank = 0; rank < 10; rank++) {
    const e = entries.find(x => x.entryId === order[rank]);
    assert.equal(await rep.score(e.u.address, 0), (1000n * (n - 1n - 2n * BigInt(rank))) / (n - 1n));
  }
  assert.equal(await rep.callsWon(entries.find(x => x.entryId === order[0]).u.address, 0), 1n);
  assert.equal(await rep.callsWon(entries.find(x => x.entryId === order[5]).u.address, 0), 0n);
  await wait(pools.scoreEntries(id, entries.map(e => e.entryId))); // no double scoring
  assert.equal(await rep.callsScored(entries[0].u.address, 0), 1n);
});

test('only a user\'s first entry earns reputation', async () => {
  const { pools, rep } = await setup();
  const t = (await now()) + 6 * HOUR;
  await wait(pools.connect(S.creator).createPool(0, t, E('1')));
  const id = Number(await pools.poolCount());
  const mk = async (u, g) => {
    const s = salt(); const gg = P8(g);
    await wait(pools.connect(u).enter(id, commitment(gg, s, u.address, id), { value: E('1') }));
    return { u, g: gg, s, entryId: Number((await pools.getPool(id)).entryCount) };
  };
  const entries = [await mk(S.users[0], 100), await mk(S.users[0], 148), await mk(S.users[1], 200), await mk(S.users[2], 10)];
  await revealAll(pools, id, entries);
  await finish(pools, id, entries, P8(150));
  await wait(pools.scoreEntries(id, entries.map(e => e.entryId)));
  assert.equal(await rep.callsScored(S.users[0].address, 0), 1n);
  const ranks = rankOrder(entries, P8(150));
  // user0's first entry (guess 100) is not the closest, so it is what gets scored
  const rank100 = ranks.indexOf(1);
  assert.equal(await rep.score(S.users[0].address, 0), (1000n * (3n - 2n * BigInt(rank100))) / 3n);
});

test('refund when fewer than 3 guesses are revealed', async () => {
  const { pools, rep } = await setup();
  const { id, entries } = await populate(pools, [100, 200, 300], { amount: E('1') });
  const p = await pools.getPool(id);
  await warpTo(Number(p.lockTime) + 1);
  await wait(pools.reveal(id, 1, entries[0].g, entries[0].s));
  await wait(pools.reveal(id, 2, entries[1].g, entries[1].s));
  await warpTo(Number(p.resultTime) + 1);
  assert.equal(await pools.refundAll(id), true);
  await reverts(pools.connect(S.settler).reportPrice(id, P8(1), await now()), 'Refunding');
  for (const e of entries) {
    assert.equal(await pools.claimable(id, e.entryId), E('1'));
    await wait(pools.connect(e.u).claim(id, e.entryId));
  }
  assert.equal(await rep.callsScored(entries[0].u.address, 0), 0n);
  assert.ok((await balance(await pools.getAddress())) === 0n);
});

test('refund when no price arrives within 24h, with no help from anyone', async () => {
  const { pools } = await setup();
  const { id, entries } = await populate(pools, [100, 200, 300]);
  await revealAll(pools, id, entries);
  const p = await pools.getPool(id);
  await warpTo(Number(p.resultTime) + 23 * HOUR);
  assert.equal(await pools.refundAll(id), false);
  assert.equal(await pools.claimable(id, 1), 0n);
  await warp(2 * HOUR);
  assert.equal(await pools.refundAll(id), true);
  await wait(pools.connect(entries[0].u).claim(id, 1));
  await reverts(pools.connect(S.settler).reportPrice(id, P8(1), await now()), 'Refunding');
});

test('refund when ranking is not finished within 72h of the price', async () => {
  const { pools } = await setup();
  const { id, entries } = await populate(pools, [100, 200, 300, 400]);
  await revealAll(pools, id, entries);
  await warpTo(Number((await pools.getPool(id)).resultTime) + 1);
  await wait(pools.connect(S.settler).reportPrice(id, P8(150), await now()));
  await wait(pools.connect(S.settler).submitRanking(id, [1])); // partial
  assert.equal(await pools.claimable(id, 1), 0n);
  await warp(72 * HOUR + 5);
  assert.equal(await pools.refundAll(id), true);
  await reverts(pools.connect(S.settler).submitRanking(id, [2]), 'Refunding');
  await reverts(pools.scoreEntries(id, [1]), 'NotSettled');
  for (const e of entries) await wait(pools.connect(e.u).claim(id, e.entryId));
});

test('an unrevealed entry is refunded after the reveal window; revealed ones are paid from the revealed pot', async () => {
  const { pools } = await setup();
  const { id, entries } = await populate(pools, [100, 120, 140, 160, 180], { amount: E('1') });
  const p = await pools.getPool(id);
  await warpTo(Number(p.lockTime) + 1);
  const revealed = entries.slice(0, 4);
  for (const e of revealed) await wait(pools.reveal(id, e.entryId, e.g, e.s));
  assert.equal(await pools.claimable(id, 5), 0n);
  await warpTo(Number(p.resultTime) + 1);
  assert.equal(await pools.claimable(id, 5), E('1')); // lost its seat, keeps its money
  await wait(pools.connect(S.settler).reportPrice(id, P8(110), await now()));
  await wait(pools.connect(S.settler).submitRanking(id, rankOrder(revealed, P8(110))));
  assert.equal(await pools.winnerCount(id), 1n);
  assert.equal(await pools.claimable(id, rankOrder(revealed, P8(110))[0]), E('4'));
  await wait(pools.connect(entries[4].u).claim(id, 5));
  await reverts(pools.connect(entries[4].u).claim(id, 5), 'NothingToClaim');
});

test('owner can void an unsettled pool; a settled one cannot be voided', async () => {
  const { pools } = await setup();
  const a = await populate(pools, [100, 200, 300]);
  await reverts(pools.connect(S.users[0]).voidPool(a.id), 'NotOwner');
  await wait(pools.connect(S.owner).voidPool(a.id));
  await reverts(pools.connect(S.owner).voidPool(a.id), 'NotSettled');
  await reverts(pools.connect(S.users[9]).enter(a.id, ethers.id('x'), { value: E('1') }), 'EntriesClosed');
  await wait(pools.connect(a.entries[0].u).claim(a.id, 1));

  const b = await populate(pools, [100, 200, 300]);
  await revealAll(pools, b.id, b.entries);
  await finish(pools, b.id, b.entries, P8(150));
  await reverts(pools.connect(S.owner).voidPool(b.id), 'NotSettled');
});

test('pause stops creating and entering, never claims or ranking', async () => {
  const { pools } = await setup();
  const { id, entries } = await populate(pools, [100, 200, 300]);
  await wait(pools.connect(S.owner).setPaused(true));
  await reverts(pools.connect(S.creator).createPool(0, (await now()) + 6 * HOUR, E('1')), 'IsPaused');
  await reverts(pools.connect(S.users[9]).enter(id, ethers.id('x'), { value: E('1') }), 'IsPaused');
  await revealAll(pools, id, entries);
  await finish(pools, id, entries, P8(150));
  await wait(pools.connect(entries[1].u).claim(id, 2));
});

test('randomised pools: payouts and refunds never exceed deposits, dust stays tiny', async () => {
  for (let round = 0; round < 6; round++) {
    const { pools } = await setup();
    const n = 3 + Math.floor(Math.random() * 12);
    const amount = BigInt(1 + Math.floor(Math.random() * 1000)) * 1_000_003n;
    const guesses = Array.from({ length: n }, () => Math.floor(Math.random() * 300));
    const { id, entries } = await populate(pools, guesses, { amount });
    const p = await pools.getPool(id);
    await warpTo(Number(p.lockTime) + 1);
    const skip = new Set();
    for (const e of entries) {
      if (Math.random() < 0.15) { skip.add(e.entryId); continue; }
      await wait(pools.reveal(id, e.entryId, e.g, e.s));
    }
    const revealed = entries.filter(e => !skip.has(e.entryId));
    await warpTo(Number(p.resultTime) + 1);
    const price = P8(Math.floor(Math.random() * 300));
    if (revealed.length >= 3) {
      await wait(pools.connect(S.settler).reportPrice(id, price, await now()));
      await wait(pools.connect(S.settler).submitRanking(id, rankOrder(revealed, price)));
    }
    const deposited = amount * BigInt(n);
    let paid = 0n;
    for (const e of entries) {
      const c = await pools.claimable(id, e.entryId);
      if (c > 0n) { await wait(pools.connect(e.u).claim(id, e.entryId)); paid += c; }
    }
    const left = await balance(await pools.getAddress());
    assert.equal(paid + left, deposited);
    assert.ok(left <= BigInt(n), `dust ${left}`);
  }
});
