// Raises or lowers the money caps. Run by the owner key.
//   OWNER_KEY=0x... MAX_STAKE=1000 MAX_ENTRY=1000 node scripts/set-caps.mjs
import fs from 'node:fs';
import { ethers } from 'ethers';
const addr = JSON.parse(fs.readFileSync(new URL('../shared/addresses.json', import.meta.url), 'utf8'));
const abis = JSON.parse(fs.readFileSync(new URL('../shared/abis.json', import.meta.url), 'utf8'));
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://rpc.monad.xyz');
const owner = new ethers.Wallet(process.env.OWNER_KEY, provider);
const calls = new ethers.Contract(addr.calls, abis.Calls, owner);
const pools = new ethers.Contract(addr.pools, abis.Pools, owner);
if (process.env.MAX_STAKE) await (await calls.setMaxStake(ethers.parseEther(process.env.MAX_STAKE))).wait();
if (process.env.MAX_ENTRY) await (await pools.setMaxEntry(ethers.parseEther(process.env.MAX_ENTRY))).wait();
console.log('maxStake', ethers.formatEther(await calls.maxStake()), 'maxEntry', ethers.formatEther(await pools.maxEntry()));
