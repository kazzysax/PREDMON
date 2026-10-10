// Shared test plumbing: an in-process EVM (Hardhat), signers, deploy and clock helpers.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const hre = require('hardhat');

export const provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
export const E = ethers.parseEther;
export const HOUR = 3600;
export const DAY = 86400;

const artifact = name => JSON.parse(fs.readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url)));
export const abiOf = name => artifact(name).abi;

export async function signers() {
  const s = await Promise.all(Array.from({ length: 20 }, (_, i) => provider.getSigner(i)));
  const [owner, gate, settler, forwarder, creator, ...users] = s;
  return { owner, gate, settler, forwarder, creator, users };
}

export async function deployContract(name, signer, ...args) {
  const a = artifact(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

export const now = async () => (await provider.getBlock('latest')).timestamp;
export async function warp(seconds) {
  await hre.network.provider.send('evm_increaseTime', [seconds]);
  await hre.network.provider.send('evm_mine');
}
export async function warpTo(ts) {
  const t = await now();
  if (ts > t) await warp(ts - t);
}

const iface = new ethers.Interface([
  ...abiOf('Calls'), ...abiOf('Pools'), ...abiOf('Reputation'), ...abiOf('Prizes'),
].filter((f, i, a) => a.findIndex(g => g.type === f.type && g.name === f.name && JSON.stringify(g.inputs) === JSON.stringify(f.inputs)) === i));

/** Asserts a promise rejects with the named custom error. */
export async function reverts(promise, name) {
  try {
    await promise;
  } catch (e) {
    const data = e.data ?? e.info?.error?.data ?? e.error?.data;
    let parsed;
    try { parsed = data && iface.parseError(data); } catch { /* unknown selector */ }
    if (parsed?.name === name) return;
    throw new Error(`expected revert ${name}, got ${parsed?.name ?? e.shortMessage ?? e.message}`);
  }
  throw new Error(`expected revert ${name}, but the call succeeded`);
}

export const wait = async tx => (await tx).wait();
export const balance = a => provider.getBalance(typeof a === 'string' ? a : a.address ?? a.getAddress());

export const commitment = (guess, salt, entrant, poolId) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'bytes32', 'address', 'uint256'], [guess, salt, entrant, poolId]));
export const salt = () => ethers.hexlify(ethers.randomBytes(32));

/** Metadata blob as the Chainlink forwarder passes it: id(32) | name(10) | owner(20) | reportName(2). */
export const metadataFor = workflowOwner =>
  ethers.concat([ethers.ZeroHash, ethers.zeroPadBytes('0x', 10), workflowOwner, '0x0000']);
