import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { E, HOUR, signers, deployContract, now, warp, warpTo, reverts, wait, balance } from './helpers.mjs';

let S;
before(async () => { S = await signers(); });

async function setup() {
  const rep = await deployContract('Reputation', S.owner);
  const calls = await deployContract('Calls', S.owner, await rep.getAddress(), S.gate.address, E('1000'));
  await wait(rep.setWriter(await calls.getAddress(), true));
  await wait(calls.setSettler(S.settler.address));
  const prizes = await deployContract('Prizes', S.owner, await calls.getAddress());
  return { calls, prizes };
}
async function open(calls) {
  await wait(calls.connect(S.gate).createMarket(S.creator.address, 0, ethers.id('t'), (await now()) + HOUR));
  return Number(await calls.marketCount());
}
async function settle(calls, id, outcome) {
  const m = await calls.getMarket(id);
  await warpTo(Number(m.closesAt) + 1);
  await wait(calls.connect(S.settler).proposeOutcome(id, outcome));
  if (outcome !== 3) { await warp(2 * HOUR + 1); await wait(calls.finalize(id)); }
}
const WINDOW = 3 * 24 * HOUR;

test('the prize is split equally between winners who register', async () => {
  const { calls, prizes } = await setup();
  const id = await open(calls);
  await wait(prizes.connect(S.creator).addPrize(id, { value: E('1000') }));
  const [a, b, c, d] = S.users;
  await wait(calls.connect(a).vote(id, true));
  await wait(calls.connect(b).vote(id, true));
  await wait(calls.connect(c).stake(id, true, { value: E('1') }));
  await wait(calls.connect(d).vote(id, false));
  await settle(calls, id, 1);

  await reverts(prizes.connect(d).register(id), 'NotAWinner');
  await reverts(prizes.connect(S.creator).register(id), 'NotAWinner');
  for (const w of [a, b, c]) await wait(prizes.connect(w).register(id));
  await reverts(prizes.connect(a).register(id), 'AlreadyRegistered');
  await reverts(prizes.connect(a).collect(id), 'WindowOpen');

  await warp(WINDOW + 1);
  const before = await balance(a);
  const r = await wait(prizes.connect(a).collect(id));
  const gas = r.gasUsed * r.gasPrice;
  const share = E('1000') / 3n;
  assert.equal((await balance(a)) - before + gas, share);
  await reverts(prizes.connect(a).collect(id), 'AlreadyPaid');
  await reverts(prizes.connect(d).collect(id), 'NotRegistered');
  await reverts(prizes.connect(S.creator).refund(id), 'NotSettled');
});

test('registration closes after the window', async () => {
  const { calls, prizes } = await setup();
  const id = await open(calls);
  await wait(prizes.connect(S.creator).addPrize(id, { value: E('5') }));
  await wait(calls.connect(S.users[0]).vote(id, true));
  await wait(calls.connect(S.users[1]).vote(id, false));
  await settle(calls, id, 1);
  await warp(WINDOW + 1);
  await reverts(prizes.connect(S.users[0]).register(id), 'WindowClosed');
});

test('sponsors are refunded if the post is voided', async () => {
  const { calls, prizes } = await setup();
  const id = await open(calls);
  await wait(prizes.connect(S.users[5]).addPrize(id, { value: E('4') }));
  await wait(prizes.connect(S.users[6]).addPrize(id, { value: E('6') }));
  await wait(calls.connect(S.users[0]).vote(id, true));
  await wait(calls.connect(S.users[1]).vote(id, false));
  await settle(calls, id, 3);
  const before = await balance(S.users[5]);
  const r = await wait(prizes.connect(S.users[5]).refund(id));
  assert.equal((await balance(S.users[5])) - before + r.gasUsed * r.gasPrice, E('4'));
  await reverts(prizes.connect(S.users[5]).refund(id), 'NothingToRefund');
  assert.equal(await balance(await prizes.getAddress()), E('6'));
});

test('sponsors are refunded if no winner registers', async () => {
  const { calls, prizes } = await setup();
  const id = await open(calls);
  await wait(prizes.connect(S.creator).addPrize(id, { value: E('7') }));
  await wait(calls.connect(S.users[0]).vote(id, true));
  await wait(calls.connect(S.users[1]).vote(id, false));
  await settle(calls, id, 1);
  await reverts(prizes.connect(S.creator).refund(id), 'NotSettled');
  await warp(WINDOW + 1);
  await wait(prizes.connect(S.creator).refund(id));
});

test('prizes can only be added while voting is open', async () => {
  const { calls, prizes } = await setup();
  await reverts(prizes.connect(S.creator).addPrize(99, { value: E('1') }), 'PostNotOpen');
  const id = await open(calls);
  await reverts(prizes.connect(S.creator).addPrize(id, { value: 0 }), 'ZeroAmount');
  const m = await calls.getMarket(id);
  await warpTo(Number(m.locksAt) + 1);
  await reverts(prizes.connect(S.creator).addPrize(id, { value: E('1') }), 'PostNotOpen');
});
