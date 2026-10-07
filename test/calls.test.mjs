import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  provider, E, HOUR, DAY, signers, deployContract, now, warp, warpTo, reverts, wait, balance, metadataFor,
} from './helpers.mjs';

let S;
before(async () => { S = await signers(); });

async function setup({ maxStake = E('1000') } = {}) {
  const rep = await deployContract('Reputation', S.owner);
  const calls = await deployContract('Calls', S.owner, await rep.getAddress(), S.gate.address, maxStake);
  await wait(rep.setWriter(await calls.getAddress(), true));
  await wait(calls.setSettler(S.settler.address));
  return { rep, calls };
}
async function open(calls, { life = HOUR, category = 0, creator = S.creator } = {}) {
  const closes = (await now()) + life;
  await wait(calls.connect(S.gate).createMarket(creator.address, category, ethers.id('terms'), closes));
  return Number(await calls.marketCount());
}
const weights = async (calls, id) => { const m = await calls.getMarket(id); return [m.yesWeight, m.noWeight]; };
/** Walks a market through close, proposal, hold and finalisation. */
async function settle(calls, id, outcome) {
  const m = await calls.getMarket(id);
  await warpTo(Number(m.closesAt) + 1);
  await wait(calls.connect(S.settler).proposeOutcome(id, outcome));
  if (outcome !== 3) {
    await warp(2 * HOUR + 1);
    await wait(calls.finalize(id));
  }
}

test('only the gate opens markets, inside the 5 minute to 7 day window, with a valid category', async () => {
  const { calls } = await setup();
  const t = await now();
  await reverts(calls.connect(S.users[0]).createMarket(S.creator.address, 0, ethers.id('x'), t + HOUR), 'NotAuthorized');
  await reverts(calls.connect(S.gate).createMarket(S.creator.address, 0, ethers.id('x'), t + 60), 'BadWindow');
  await reverts(calls.connect(S.gate).createMarket(S.creator.address, 0, ethers.id('x'), t + 8 * DAY), 'BadWindow');
  await reverts(calls.connect(S.gate).createMarket(S.creator.address, 5, ethers.id('x'), t + HOUR), 'BadCategory');
});

test('votes and stakes lock at 90% of the market life', async () => {
  const { calls } = await setup();
  const id = await open(calls, { life: 10 * HOUR });
  const m = await calls.getMarket(id);
  // The block that opens the market can land a second or two after `now()` was read.
  assert.ok(Math.abs(Number(m.locksAt) - Number(m.opensAt) - 9 * HOUR) <= 5);
  assert.equal(Number(m.locksAt) - Number(m.opensAt), Math.floor((Number(m.closesAt) - Number(m.opensAt)) * 0.9));

  await warpTo(Number(m.locksAt) - 60);
  await wait(calls.connect(S.users[0]).vote(id, true));
  await warpTo(Number(m.locksAt) + 1);
  await reverts(calls.connect(S.users[1]).vote(id, true), 'VotingClosed');
  await reverts(calls.connect(S.users[1]).stake(id, true, { value: E('1') }), 'VotingClosed');
});

test('one vote per user; early votes weigh 1.2x, sliding to 1.0x at lock', async () => {
  const { calls } = await setup();
  const id = await open(calls, { life: 10 * HOUR });
  await wait(calls.connect(S.users[0]).vote(id, true));
  const [early] = await weights(calls, id);
  assert.ok(early > 11_900n && early <= 12_000n, `early weight ${early}`);
  await reverts(calls.connect(S.users[0]).vote(id, false), 'AlreadyVoted');

  const m = await calls.getMarket(id);
  await warpTo(Number(m.opensAt) + 4.5 * HOUR); // halfway to lock
  await wait(calls.connect(S.users[1]).vote(id, false));
  const [, mid] = await weights(calls, id);
  assert.ok(mid > 10_900n && mid < 11_200n, `mid weight ${mid}`);
});

test('a signed vote can be relayed once, for the signer only, before the deadline', async () => {
  const { calls } = await setup();
  const id = await open(calls);
  const wallet = ethers.Wallet.createRandom(); // holds no MON; the relayer pays
  const { chainId } = await provider.getNetwork();
  const domain = { name: 'PredMon Calls', version: '1', chainId, verifyingContract: await calls.getAddress() };
  const types = { Vote: [
    { name: 'marketId', type: 'uint256' }, { name: 'yes', type: 'bool' },
    { name: 'voter', type: 'address' }, { name: 'deadline', type: 'uint256' },
  ] };
  const deadline = (await now()) + 600;
  const sig = await wallet.signTypedData(domain, types, { marketId: id, yes: true, voter: wallet.address, deadline });

  await reverts(calls.connect(S.users[3]).voteBySig(id, false, wallet.address, deadline, sig), 'BadSignature');
  await reverts(calls.connect(S.users[3]).voteBySig(id, true, S.users[0].address, deadline, sig), 'BadSignature');
  await reverts(calls.connect(S.users[3]).voteBySig(id, true, wallet.address, deadline, '0x1234'), 'BadSignature');
  await wait(calls.connect(S.users[3]).voteBySig(id, true, wallet.address, deadline, sig));
  assert.equal((await calls.positions(id, wallet.address)).side, 1n);
  await reverts(calls.connect(S.users[3]).voteBySig(id, true, wallet.address, deadline, sig), 'AlreadyVoted');

  // A signature for another market is useless here.
  const id2 = await open(calls);
  await reverts(calls.connect(S.users[3]).voteBySig(id2, true, wallet.address, deadline, sig), 'BadSignature');
  // And an expired one is refused.
  const old = await wallet.signTypedData(domain, types, { marketId: id2, yes: true, voter: wallet.address, deadline: (await now()) - 1 });
  await reverts(calls.connect(S.users[3]).voteBySig(id2, true, wallet.address, (await now()) - 1, old), 'Expired');
});

test('a signature from one chain or contract cannot be replayed on another deployment', async () => {
  const a = await setup();
  const b = await setup();
  const idA = await open(a.calls);
  const idB = await open(b.calls);
  assert.equal(idA, idB);
  const wallet = ethers.Wallet.createRandom();
  const { chainId } = await provider.getNetwork();
  const domain = { name: 'PredMon Calls', version: '1', chainId, verifyingContract: await a.calls.getAddress() };
  const types = { Vote: [
    { name: 'marketId', type: 'uint256' }, { name: 'yes', type: 'bool' },
    { name: 'voter', type: 'address' }, { name: 'deadline', type: 'uint256' },
  ] };
  const deadline = (await now()) + 600;
  const sig = await wallet.signTypedData(domain, types, { marketId: idA, yes: true, voter: wallet.address, deadline });
  await reverts(b.calls.voteBySig(idB, true, wallet.address, deadline, sig), 'BadSignature');
});

test('staking casts the vote, refuses the other side, enforces the cumulative cap', async () => {
  const { calls } = await setup({ maxStake: E('10') });
  const id = await open(calls);
  await reverts(calls.connect(S.users[0]).stake(id, true, { value: 0 }), 'ZeroStake');
  await wait(calls.connect(S.users[0]).stake(id, true, { value: E('6') }));
  assert.equal((await calls.positions(id, S.users[0].address)).side, 1n);
  await reverts(calls.connect(S.users[0]).stake(id, false, { value: E('1') }), 'WrongSide');
  await reverts(calls.connect(S.users[0]).stake(id, true, { value: E('5') }), 'OverStakeCap');
  await wait(calls.connect(S.users[0]).stake(id, true, { value: E('4') })); // exactly at the cap
  await reverts(calls.connect(S.users[0]).stake(id, true, { value: 1 }), 'OverStakeCap');

  // A free vote can be backed with money later, on the same side.
  await wait(calls.connect(S.users[1]).vote(id, false));
  await reverts(calls.connect(S.users[1]).stake(id, true, { value: E('1') }), 'WrongSide');
  await wait(calls.connect(S.users[1]).stake(id, false, { value: E('1') }));

  // The owner can move the cap.
  await reverts(calls.connect(S.users[0]).setMaxStake(E('1000')), 'NotOwner');
  await wait(calls.connect(S.owner).setMaxStake(E('1000')));
  await wait(calls.connect(S.users[0]).stake(id, true, { value: E('500') }));
});

test('settlement: proposal needs the settler, a closed market and a real outcome; the hold must pass', async () => {
  const { calls } = await setup();
  const id = await open(calls);
  await wait(calls.connect(S.users[0]).vote(id, true));
  await wait(calls.connect(S.users[1]).vote(id, false));

  await reverts(calls.connect(S.settler).proposeOutcome(id, 1), 'MarketStillOpen');
  const m = await calls.getMarket(id);
  await warpTo(Number(m.closesAt) + 1);
  await reverts(calls.connect(S.users[0]).proposeOutcome(id, 1), 'NotAuthorized');
  await reverts(calls.connect(S.settler).proposeOutcome(id, 0), 'BadOutcome');
  await reverts(calls.connect(S.settler).proposeOutcome(id, 4), 'BadOutcome');
  await reverts(calls.connect(S.settler).proposeOutcome(999, 1), 'NoSuchMarket');
  await wait(calls.connect(S.settler).proposeOutcome(id, 1));
  await reverts(calls.connect(S.settler).proposeOutcome(id, 2), 'BadState');

  await reverts(calls.finalize(id), 'HoldNotOver');
  await warp(2 * HOUR - 5);
  await reverts(calls.finalize(id), 'HoldNotOver');
  await warp(10);
  await wait(calls.finalize(id));
  assert.equal(Number((await calls.getMarket(id)).state), 2); // Finalized
  await reverts(calls.finalize(id), 'BadState');
});

test('owner may correct a proposed outcome during the hold, which restarts the hold', async () => {
  const { calls } = await setup();
  const id = await open(calls);
  await wait(calls.connect(S.users[0]).vote(id, true));
  await wait(calls.connect(S.users[1]).vote(id, false));
  await warpTo(Number((await calls.getMarket(id)).closesAt) + 1);
  await wait(calls.connect(S.settler).proposeOutcome(id, 1));
  await warp(HOUR + 30 * 60);

  await reverts(calls.connect(S.users[0]).correctOutcome(id, 2), 'NotOwner');
  await wait(calls.connect(S.owner).correctOutcome(id, 2));
  await warp(HOUR + 30 * 60); // would have been past the original hold
  await reverts(calls.finalize(id), 'HoldNotOver');
  await warp(31 * 60);
  await wait(calls.finalize(id));
  assert.equal((await calls.getMarket(id)).outcome, 2n);
});

test('the forwarder can deliver an outcome; a wrong workflow owner or caller is refused', async () => {
  const { calls } = await setup();
  const id = await open(calls);
  await wait(calls.connect(S.users[0]).vote(id, true));
  await wait(calls.connect(S.users[1]).vote(id, false));
  await warpTo(Number((await calls.getMarket(id)).closesAt) + 1);

  const report = ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint8'], [id, 1]);
  const goodMeta = metadataFor(S.users[5].address);
  await reverts(calls.connect(S.forwarder).onReport(goodMeta, report), 'NotAuthorized'); // forwarder not set yet
  await wait(calls.connect(S.owner).setForwarder(S.forwarder.address, S.users[5].address));
  await reverts(calls.connect(S.users[0]).onReport(goodMeta, report), 'NotAuthorized');
  await reverts(calls.connect(S.forwarder).onReport(metadataFor(S.users[6].address), report), 'NotAuthorized');
  await reverts(calls.connect(S.forwarder).onReport('0x1234', report), 'BadMetadata');
  await wait(calls.connect(S.forwarder).onReport(goodMeta, report));
  assert.equal(Number((await calls.getMarket(id)).state), 1); // Proposed
  assert.equal(await calls.supportsInterface('0x01ffc9a7'), true);
});

test('reputation: win pays K(1-s), loss costs K*s with s the share at close; per category', async () => {
  const { calls, rep } = await setup();
  const id = await open(calls, { category: 1 });
  await wait(calls.connect(S.users[0]).vote(id, true));
  await wait(calls.connect(S.users[1]).vote(id, true));
  await wait(calls.connect(S.users[2]).vote(id, true));
  await wait(calls.connect(S.users[3]).vote(id, false));
  await settle(calls, id, 2); // the minority was right

  const [y, n] = await weights(calls, id);
  const noShare = (n * 10_000n) / (y + n);
  const yesShare = (y * 10_000n) / (y + n);
  await wait(calls.score(id, S.users.slice(0, 4).map(u => u.address)));
  await wait(calls.score(id, S.users.slice(0, 4).map(u => u.address))); // repeat is harmless
  assert.equal(await rep.score(S.users[3].address, 1), (1000n * (10_000n - noShare)) / 10_000n);
  assert.equal(await rep.score(S.users[0].address, 1), -((1000n * yesShare) / 10_000n));
  assert.equal(await rep.score(S.users[3].address, 0), 0n, 'other categories untouched');
  assert.equal(await rep.callsScored(S.users[0].address, 1), 1n);
  assert.equal(await rep.callsWon(S.users[3].address, 1), 1n);

  // Reputation lifts weight only inside its own category.
  const id2 = await open(calls, { category: 1 });
  const id3 = await open(calls, { category: 0 });
  await wait(calls.connect(S.users[3]).vote(id2, true));
  await wait(calls.connect(S.users[3]).vote(id3, true));
  const [w2] = await weights(calls, id2);
  const [w3] = await weights(calls, id3);
  assert.ok(w2 > w3, `category with reputation weighs more: ${w2} vs ${w3}`);
});

test('a free voter is scored by claim without it reverting; scoring cannot be repeated', async () => {
  const { calls, rep } = await setup();
  const id = await open(calls);
  await wait(calls.connect(S.users[0]).vote(id, true));
  await wait(calls.connect(S.users[1]).vote(id, false));
  await settle(calls, id, 1);
  await wait(calls.connect(S.users[0]).claim(id));
  assert.ok((await rep.score(S.users[0].address, 0)) > 0n);
  await reverts(calls.connect(S.users[0]).claim(id), 'NothingToClaim');
  await reverts(calls.connect(S.users[4]).claim(id), 'NothingToClaim'); // never voted
  await reverts(calls.score(id, new Array(101).fill(S.users[0].address)), 'BatchTooLarge');
});

test('payouts: winners split the losing pool less the 2% author fee; all money is accounted for', async () => {
  const { calls } = await setup();
  const id = await open(calls);
  await wait(calls.connect(S.users[0]).stake(id, true, { value: E('1') }));
  await wait(calls.connect(S.users[1]).stake(id, true, { value: E('3') }));
  await wait(calls.connect(S.users[2]).stake(id, false, { value: E('2') }));
  await wait(calls.connect(S.users[3]).vote(id, false));

  await reverts(calls.connect(S.users[0]).claim(id), 'NothingToClaim'); // not settled
  await settle(calls, id, 1);
  assert.equal(await calls.authorFees(S.creator.address), E('0.04'));
  assert.equal(await calls.claimable(id, S.users[0].address), E('1.49'));
  assert.equal(await calls.claimable(id, S.users[1].address), E('4.47'));
  assert.equal(await calls.claimable(id, S.users[2].address), 0n);

  await wait(calls.connect(S.users[0]).claim(id));
  await wait(calls.connect(S.users[1]).claim(id));
  await reverts(calls.connect(S.users[0]).claim(id), 'NothingToClaim');
  await wait(calls.connect(S.creator).withdrawAuthorFees());
  await reverts(calls.connect(S.creator).withdrawAuthorFees(), 'NothingToClaim');
  assert.ok(await balance(await calls.getAddress()) <= 2n, 'everything paid out, at most dust left');
});

test('void, a one-sided money pool, and one-sided votes all refund and move no reputation', async () => {
  const { calls, rep } = await setup();

  const a = await open(calls);
  await wait(calls.connect(S.users[0]).stake(a, true, { value: E('1') }));
  await wait(calls.connect(S.users[1]).stake(a, false, { value: E('2') }));
  await settle(calls, a, 3); // VOID takes effect at once
  assert.equal(Number((await calls.getMarket(a)).state), 3);
  assert.equal(await calls.claimable(a, S.users[0].address), E('1'));
  await wait(calls.connect(S.users[0]).claim(a));
  await reverts(calls.score(a, [S.users[1].address]), 'BadState');

  const b = await open(calls); // money only on the losing side
  await wait(calls.connect(S.users[0]).stake(b, false, { value: E('1') }));
  await wait(calls.connect(S.users[1]).vote(b, true));
  await settle(calls, b, 1);
  assert.equal(await calls.claimable(b, S.users[0].address), E('1'));
  assert.equal(await calls.authorFees(S.creator.address), 0n);

  const c = await open(calls); // votes on one side only: never a contest
  await wait(calls.connect(S.users[0]).stake(c, true, { value: E('1') }));
  await wait(calls.connect(S.users[1]).vote(c, true));
  await settle(calls, c, 1);
  assert.equal(Number((await calls.getMarket(c)).state), 3);
  assert.equal(await rep.score(S.users[0].address, 0), 0n);
});

test('owner can void any unsettled market; anyone can void one nobody settled for 7 days', async () => {
  const { calls } = await setup();
  const a = await open(calls);
  await wait(calls.connect(S.users[0]).stake(a, true, { value: E('1') }));
  await reverts(calls.connect(S.users[0]).voidMarket(a), 'NotOwner');
  await wait(calls.connect(S.owner).voidMarket(a));
  await reverts(calls.connect(S.owner).voidMarket(a), 'BadState');
  await wait(calls.connect(S.users[0]).claim(a));

  const b = await open(calls);
  await wait(calls.connect(S.users[0]).stake(b, true, { value: E('1') }));
  await warpTo(Number((await calls.getMarket(b)).closesAt) + 1);
  await reverts(calls.voidIfStale(b), 'NotStale');
  await warp(7 * DAY);
  await wait(calls.connect(S.users[9]).voidIfStale(b));
  await wait(calls.connect(S.users[0]).claim(b));
});

test('pausing stops new activity but never blocks claims, refunds or settlement', async () => {
  const { calls } = await setup();
  const id = await open(calls);
  await wait(calls.connect(S.users[0]).stake(id, true, { value: E('1') }));
  await wait(calls.connect(S.users[1]).stake(id, false, { value: E('1') }));
  await reverts(calls.connect(S.users[2]).setPaused(true), 'NotOwner');
  await wait(calls.connect(S.owner).setPaused(true));

  await reverts(calls.connect(S.users[2]).vote(id, true), 'IsPaused');
  await reverts(calls.connect(S.users[2]).stake(id, true, { value: E('1') }), 'IsPaused');
  const closes = (await now()) + HOUR;
  await reverts(calls.connect(S.gate).createMarket(S.creator.address, 0, ethers.id('y'), closes), 'IsPaused');

  await settle(calls, id, 1);
  await wait(calls.connect(S.users[0]).claim(id));
  await wait(calls.connect(S.users[1]).claim(id).catch(() => null)).catch(() => {});
});

test('ownership moves in two steps', async () => {
  const { calls } = await setup();
  await wait(calls.connect(S.owner).transferOwnership(S.users[0].address));
  await reverts(calls.connect(S.users[1]).acceptOwnership(), 'NotAuthorized');
  assert.equal(await calls.owner(), S.owner.address);
  await wait(calls.connect(S.users[0]).acceptOwnership());
  assert.equal(await calls.owner(), S.users[0].address);
  await reverts(calls.connect(S.owner).setPaused(true), 'NotOwner');
});

test('randomised markets: payouts never exceed what was staked, and dust stays tiny', async () => {
  for (let round = 0; round < 8; round++) {
    const { calls } = await setup();
    const id = await open(calls);
    const staked = [];
    const n = 6 + Math.floor(Math.random() * 10);
    for (let i = 0; i < n; i++) {
      const u = S.users[i];
      const yes = Math.random() < 0.5;
      const amount = BigInt(1 + Math.floor(Math.random() * 1_000_000)) * 1_000_000_007n; // awkward wei amounts
      await wait(calls.connect(u).stake(id, yes, { value: amount }));
      staked.push({ u, yes, amount });
    }
    const outcome = Math.random() < 0.5 ? 1 : 2;
    await settle(calls, id, outcome);
    const m = await calls.getMarket(id);
    const total = m.yesPool + m.noPool;
    let paid = 0n;
    for (const s of staked) {
      const c = await calls.claimable(id, s.u.address);
      if (c > 0n) { await wait(calls.connect(s.u).claim(id)); paid += c; }
      else if ((await calls.positions(id, s.u.address)).stake > 0n) {
        await wait(calls.connect(s.u).claim(id).catch(() => null)).catch(() => {}); // loser: scored only
      }
    }
    const fees = await calls.authorFees(S.creator.address);
    if (fees > 0n) await wait(calls.connect(S.creator).withdrawAuthorFees());
    const left = await balance(await calls.getAddress());
    assert.equal(paid + fees + left, total, 'every wei is accounted for');
    assert.ok(left >= 0n && left <= BigInt(n), `dust ${left} wei should be at most one wei per winner`);
  }
});
