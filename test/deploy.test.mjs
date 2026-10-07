import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { E, signers, deployContract, abiOf, provider, wait } from './helpers.mjs';
import { deploy } from '../scripts/deploy.mjs';

let S;
before(async () => { S = await signers(); });

test('deploy wires roles, caps and ownership handover', async () => {
  const agg = await deployContract('MockAggregator', S.owner);
  const out = await deploy({
    signer: S.users[0], owner: S.owner.address, gate: S.gate.address, settler: S.settler.address,
    assets: [{ id: 0, feed: await agg.getAddress(), maxAge: 3600 }], log: () => {},
  });
  const rep = new ethers.Contract(out.reputation, abiOf('Reputation'), provider);
  const calls = new ethers.Contract(out.calls, abiOf('Calls'), provider);
  const pools = new ethers.Contract(out.pools, abiOf('Pools'), provider);
  assert.equal(await rep.writers(out.calls), true);
  assert.equal(await rep.writers(out.pools), true);
  assert.equal(await rep.owner(), S.owner.address);
  assert.equal(await calls.gate(), S.gate.address);
  assert.equal(await calls.settler(), S.settler.address);
  assert.equal(await pools.settler(), S.settler.address);
  assert.equal(await calls.maxStake(), E('1'));
  assert.equal(await pools.maxEntry(), E('1'));
  assert.equal(await pools.assetEnabled(0), true);
  assert.equal(await calls.pendingOwner(), S.owner.address);
  await wait(calls.connect(S.owner).acceptOwnership());
  await wait(pools.connect(S.owner).acceptOwnership());
  assert.equal(await calls.owner(), S.owner.address);
  await wait(calls.connect(S.owner).setMaxStake(E('1000')));
  assert.equal(await calls.maxStake(), E('1000'));
  assert.ok(out.deployBlock > 0);
});
