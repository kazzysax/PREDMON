// Hardhat is used only as a local EVM for tests. Compilation goes through
// scripts/compile.mjs (bundled solc), which needs no compiler download.
module.exports = { networks: { hardhat: { hardfork: 'cancun', allowBlocksWithSameTimestamp: true } } };
