// Deploys only the Prizes contract (reads the live Calls) and records its address.
import fs from 'node:fs';
import { ethers } from 'ethers';
const art = JSON.parse(fs.readFileSync(new URL('../artifacts/Prizes.json', import.meta.url), 'utf8'));
const file = new URL('../shared/addresses.json', import.meta.url);
const addrs = JSON.parse(fs.readFileSync(file, 'utf8'));
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const signer = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
const before = await provider.getBalance(signer.address);
const c = await new ethers.ContractFactory(art.abi, art.bytecode, signer).deploy(addrs.calls);
const rc = await c.deploymentTransaction().wait();
addrs.prizes = await c.getAddress();
fs.writeFileSync(file, JSON.stringify(addrs, null, 2) + '\n');
console.log('Prizes', addrs.prizes, 'block', rc.blockNumber, 'cost MON', ethers.formatEther(before - await provider.getBalance(signer.address)));
