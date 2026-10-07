import { ethers } from 'ethers';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { dynamicVerifier } from './auth.mjs';
import { createAi } from './ai.mjs';
import { createChain } from './chain.mjs';
import { createJobs } from './jobs.mjs';
import { createApp } from './app.mjs';

const cfg = loadConfig();
const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
const db = openDb(cfg.dbPath);
const chain = createChain(cfg, provider);
const ai = createAi({ apiKey: cfg.anthropicKey, model: cfg.anthropicModel });
const jobs = createJobs({ cfg, db, chain, ai });
const server = createApp({ cfg, db, chain, ai, verify: dynamicVerifier(cfg.dynamicEnvId), jobs });
server.listen(cfg.port, () => console.log(`predmon api on :${cfg.port}`));
jobs.start();
