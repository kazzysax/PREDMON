// Deploys Reputation, Calls and Pools, wires the roles, and writes
// shared/addresses.json. Starts with LOW caps for the dry run; raise them with
// scripts/set-caps.mjs once the dry run is clean.
//
//   DEPLOYER_KEY=0x... OWNER_ADDRESS=0x... GATE_ADDRESS=0x... SETTLER_ADDRESS=0x... \
//   RPC_URL=https://rpc.monad.xyz node scripts/deploy.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const art = n => JSON.parse(fs.readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));

export async function deploy({
  signer, owner, gate, settler,
  maxStake = ethers.parseEther('1'), maxEntry = ethers.parseEther('1'),
  assets = [],            // [{ id, feed, maxAge }]  asset ids: 0 BTC, 1 ETH, 2 MON
  log = console.log,
}) {
  const send = async (label, p) => { const tx = await p; const rc = await tx.wait(); if (rc.status !== 1) throw new Error(`${label} failed`); log(`  ${label}`); return rc; };
  const make = async (name, ...args) => {
    const a = art(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
    const rc = await c.deploymentTransaction().wait();
    log(`${name} ${await c.getAddress()}`);
    return { c, block: rc.blockNumber };
  };

  const rep = await make('Reputation');
  const calls = await make('Calls', await rep.c.getAddress(), gate, maxStake);
  const pools = await make('Pools', await rep.c.getAddress(), maxEntry);

  await send('Reputation writer: Calls', rep.c.setWriter(await calls.c.getAddress(), true));
  await send('Reputation writer: Pools', rep.c.setWriter(await pools.c.getAddress(), true));
  await send('Calls settler', calls.c.setSettler(settler));
  await send('Pools settler', pools.c.setSettler(settler));
  for (const a of assets) await send(`Pools asset ${a.id}`, pools.c.setAsset(a.id, true, a.feed ?? ethers.ZeroAddress, a.maxAge ?? 3600));

  // Hand over ownership last. Reputation transfers at once; Calls and Pools need `acceptOwnership` from the new owner.
  const me = await signer.getAddress();
  if (owner && owner.toLowerCase() !== me.toLowerCase()) {
    await send('Reputation owner', rep.c.setOwner(owner));
    await send('Calls ownership offered', calls.c.transferOwnership(owner));
    await send('Pools ownership offered', pools.c.transferOwnership(owner));
  }
  return {
    reputation: await rep.c.getAddress(), calls: await calls.c.getAddress(), pools: await pools.c.getAddress(),
    deployBlock: Math.min(rep.block, calls.block, pools.block),
    priceFeeds: Object.fromEntries(assets.filter(a => a.feed).map(a => [String(a.id), a.feed])),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const need = k => { if (!process.env[k]) { console.error(`set ${k}`); process.exit(1); } return process.env[k]; };
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://rpc.monad.xyz');
  const net = await provider.getNetwork();
  if (net.chainId !== 143n && !process.env.ALLOW_OTHER_CHAIN) { console.error(`connected to chain ${net.chainId}, expected 143 (Monad mainnet)`); process.exit(1); }
  const signer = new ethers.Wallet(need('DEPLOYER_KEY'), provider);
  console.log(`deployer ${signer.address}, balance ${ethers.formatEther(await provider.getBalance(signer.address))} MON`);
  const feeds = process.env.PRICE_FEEDS ? JSON.parse(process.env.PRICE_FEEDS) : {}; // {"0":"0x..."}
  const out = await deploy({
    signer, owner: need('OWNER_ADDRESS'), gate: need('GATE_ADDRESS'), settler: need('SETTLER_ADDRESS'),
    maxStake: ethers.parseEther(process.env.MAX_STAKE || '1'), maxEntry: ethers.parseEther(process.env.MAX_ENTRY || '1'),
    assets: (process.env.ASSETS || '0').split(',').map(id => ({ id: Number(id), feed: feeds[id] })),
  });
  fs.mkdirSync(new URL('../shared', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('../shared/addresses.json', import.meta.url), JSON.stringify(out, null, 2));
  console.log('wrote shared/addresses.json');
}
