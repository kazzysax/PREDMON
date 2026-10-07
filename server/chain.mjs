// Everything that talks to the chain: contracts, the three server wallets, and
// a single queue so transactions from one wallet never race on nonces.
import fs from 'node:fs';
import { ethers } from 'ethers';

const abis = JSON.parse(fs.readFileSync(new URL('../shared/abis.json', import.meta.url), 'utf8'));
export const ABIS = abis;

class TxQueue {
  #tail = Promise.resolve();
  run(fn) {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => {});
    return next;
  }
}

export function createChain(cfg, provider) {
  const mk = key => (key ? new ethers.Wallet(key, provider) : null);
  const wallets = { gate: mk(cfg.gateKey), settler: mk(cfg.settlerKey), relayer: mk(cfg.relayerKey) };
  const queues = new Map(); // one queue per address
  const queueFor = w => { const k = w.address; if (!queues.has(k)) queues.set(k, new TxQueue()); return queues.get(k); };

  const read = {
    reputation: new ethers.Contract(cfg.addresses.reputation, abis.Reputation, provider),
    calls: new ethers.Contract(cfg.addresses.calls, abis.Calls, provider),
    pools: new ethers.Contract(cfg.addresses.pools, abis.Pools, provider),
  };
  const as = (name, role) => {
    const w = wallets[role];
    if (!w) throw new Error(`no ${role} key configured`);
    return new ethers.Contract(cfg.addresses[name], abis[name[0].toUpperCase() + name.slice(1)], w);
  };

  /** Sends one transaction from a role's wallet, serialised, with an explicit gas limit, and waits for it. */
  async function send(role, contractName, method, args, gasLimit, value) {
    const w = wallets[role];
    if (!w) throw new Error(`no ${role} key configured`);
    return queueFor(w).run(async () => {
      const c = as(contractName, role);
      const tx = await c[method](...args, { gasLimit, ...(value ? { value } : {}) });
      const rc = await tx.wait();
      if (rc.status !== 1) throw new Error(`${method} reverted (${tx.hash})`);
      return rc;
    });
  }

  async function chainNow() { return (await provider.getBlock('latest')).timestamp; }

  /** getLogs in small ranges, since public Monad RPCs cap the block span. */
  async function logs(contract, filter, fromBlock, toBlock) {
    const out = [];
    for (let start = fromBlock; start <= toBlock; start += cfg.logChunk) {
      const end = Math.min(start + cfg.logChunk - 1, toBlock);
      out.push(...await contract.queryFilter(filter, start, end));
    }
    return out;
  }

  async function relayerLow() {
    const w = wallets.relayer; if (!w) return true;
    return (await provider.getBalance(w.address)) < ethers.parseEther(cfg.relayerMinBalance);
  }

  return { provider, wallets, read, send, chainNow, logs, relayerLow, iface: { calls: read.calls.interface, pools: read.pools.interface } };
}
