// Compiles every contract with the bundled solc (no compiler download needed)
// and writes ABI + bytecode to artifacts/<Name>.json, plus shared/abis.json for
// the backend, indexer and app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractsDir = path.join(root, 'contracts');

const sources = {};
const walk = dir => {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (f.endsWith('.sol')) {
      sources[path.relative(contractsDir, full)] = { content: fs.readFileSync(full, 'utf8') };
    }
  }
};
walk(contractsDir);

const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
})));

for (const e of out.errors || []) console.error(e.formattedMessage);
if ((out.errors || []).some(e => e.severity === 'error')) process.exit(1);

fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
const abis = {};
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue; // interfaces
    fs.writeFileSync(
      path.join(root, 'artifacts', `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2)
    );
    if (!file.startsWith('test/')) abis[name] = c.abi;
    const size = c.evm.deployedBytecode.object.length / 2;
    console.log(`${name.padEnd(16)} ${String(size).padStart(6)} bytes deployed`);
  }
}
fs.writeFileSync(path.join(root, 'shared/abis.json'), JSON.stringify(abis, null, 2));
