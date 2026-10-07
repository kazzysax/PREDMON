// All settings come from the environment so nothing secret lives in the repo.
import fs from 'node:fs';

const env = process.env;
const need = (k) => { if (!env[k]) throw new Error(`missing env ${k}`); return env[k]; };

export function loadConfig(overrides = {}) {
  const addrFile = env.ADDRESSES_FILE || new URL('../shared/addresses.json', import.meta.url).pathname;
  let addresses = {};
  try { addresses = JSON.parse(fs.readFileSync(addrFile, 'utf8')); } catch { /* not deployed yet */ }
  return {
    port: Number(env.PORT || 8787),
    rpcUrl: env.RPC_URL || 'https://rpc.monad.xyz',
    chainId: Number(env.CHAIN_ID || 143),
    logChunk: Number(env.LOG_CHUNK || 100),       // public RPCs limit getLogs ranges
    dbPath: env.DB_PATH || './data/predmon.db',
    dynamicEnvId: env.DYNAMIC_ENVIRONMENT_ID || '',
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    // One key per role. The same key may fill several roles on a small deployment.
    gateKey: env.GATE_KEY || '',                  // opens markets (Calls.gate)
    settlerKey: env.SETTLER_KEY || '',            // posts results (Base.settler)
    relayerKey: env.RELAYER_KEY || '',            // pays gas for signed votes
    addresses: {
      reputation: env.REPUTATION_ADDRESS || addresses.reputation,
      calls: env.CALLS_ADDRESS || addresses.calls,
      pools: env.POOLS_ADDRESS || addresses.pools,
    },
    deployBlock: Number(env.DEPLOY_BLOCK || addresses.deployBlock || 0),
    priceFeeds: env.PRICE_FEEDS ? JSON.parse(env.PRICE_FEEDS) : (addresses.priceFeeds || {}), // {"0": "0x..."}
    limits: {
      callsPerDay: Number(env.CALLS_PER_DAY || 5),
      votesPerDay: Number(env.VOTES_PER_DAY || 200),
      commentsPerDay: Number(env.COMMENTS_PER_DAY || 100),
      minLifeSec: 300,
      maxLifeSec: 7 * 86400,
    },
    gas: {
      createMarket: Number(env.GAS_CREATE || 300_000),
      vote: Number(env.GAS_VOTE || 250_000),
      propose: Number(env.GAS_PROPOSE || 200_000),
      finalize: Number(env.GAS_FINALIZE || 250_000),
      scorePer: Number(env.GAS_SCORE_PER || 120_000),
      reveal: Number(env.GAS_REVEAL || 120_000),
      price: Number(env.GAS_PRICE || 200_000),
      rankPer: Number(env.GAS_RANK_PER || 90_000),
    },
    relayerMinBalance: env.RELAYER_MIN_MON || '5',
    tickMs: Number(env.TICK_MS || 15_000),
    corsOrigin: env.CORS_ORIGIN || '*',
    ...overrides,
  };
}
export { need };
