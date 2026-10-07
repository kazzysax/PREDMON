import { createPublicClient, defineChain, http, parseAbi, keccak256, encodeAbiParameters, type Address } from 'viem';
import { MONAD_RPC } from './env';

export const monad = defineChain({
  id: 143, name: 'Monad', nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [MONAD_RPC] } },
  blockExplorers: { default: { name: 'MonadVision', url: 'https://monadvision.com' } },
});
export const publicClient = createPublicClient({ chain: monad, transport: http(MONAD_RPC) });

export const callsAbi = parseAbi([
  'function stake(uint256 id, bool yes) payable',
  'function vote(uint256 id, bool yes)',
  'function claim(uint256 id)',
  'function claimable(uint256 id, address voter) view returns (uint256)',
  'function withdrawAuthorFees()',
  'function authorFees(address) view returns (uint256)',
  'function positions(uint256, address) view returns (uint8 side, bool scored, bool claimed, uint128 stake)',
]);
export const poolsAbi = parseAbi([
  'function createPool(uint8 asset, uint64 resultTime, uint256 entryAmount) returns (uint256)',
  'function enter(uint256 id, bytes32 commitment) payable returns (uint256)',
  'function reveal(uint256 id, uint256 entryId, uint256 guess, bytes32 salt)',
  'function claim(uint256 id, uint256 entryId)',
  'function claimable(uint256 id, uint256 entryId) view returns (uint256)',
  'function poolCount() view returns (uint256)',
  'event Entered(uint256 indexed id, uint256 indexed entryId, address indexed entrant, bytes32 commitment)',
]);

/** Same formula as the contract: keccak256(abi.encode(guess, salt, entrant, poolId)). */
export const commitmentFor = (guess: bigint, salt: `0x${string}`, entrant: Address, poolId: bigint) =>
  keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
    [guess, salt, entrant, poolId]));

export const randomSalt = (): `0x${string}` => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
};

/** Prices carry 8 decimals, like Chainlink USD feeds. */
export const toPrice = (s: string) => {
  const [w, f = ''] = s.trim().split('.');
  return BigInt(w || '0') * 10n ** 8n + BigInt((f + '00000000').slice(0, 8));
};
export const fromPrice = (p: string | bigint) => (Number(p) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 });

export const ASSETS: Record<number, string> = { 0: 'BTC', 1: 'ETH', 2: 'MON' };
