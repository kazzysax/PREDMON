// Posts the settlement price for pools whose result time has passed.
//
// Every minute: look at the newest pools, and for each one that is past its
// result time and still unpriced, read the Chainlink feed for its asset, have
// the DON sign a report (poolId, price, feedTimestamp), and deliver it to
// Pools.onReport through the forwarder.
//
// STATUS: written against @chainlink/cre-sdk 1.23. Not yet run on a DON.
// Run `cre workflow simulate` first (see ../README.md).
import {
  cre, Runner, getNetwork, encodeCallMsg, bytesToHex, prepareReportRequest,
  LAST_FINALIZED_BLOCK_NUMBER, type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, zeroAddress, type Address } from "viem";
import { z } from "zod";

const configSchema = z.object({
  schedule: z.string(),                       // e.g. "0 * * * * *"  (every minute)
  chainSelectorName: z.string(),              // "monad-mainnet"
  poolsAddress: z.string(),
  feeds: z.record(z.string(), z.string()),    // asset id -> Chainlink aggregator address
  lookback: z.number(),           // how many recent pools to inspect
  gasLimit: z.string(),
});
type Config = z.infer<typeof configSchema>;

const poolsAbi = parseAbi([
  "function poolCount() view returns (uint256)",
  "function getPool(uint256 id) view returns ((address creator,uint8 asset,bool voided,bool priced,uint64 lockTime,uint64 resultTime,uint64 pricedAt,uint128 entryAmount,uint32 entryCount,uint32 revealedCount,uint32 rankedCount,uint32 lastRankedId,uint256 price,uint256 lastDistance))",
  "function refundAll(uint256 id) view returns (bool)",
]);
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

function read<T>(evm: InstanceType<typeof cre.capabilities.EVMClient>, runtime: Runtime<Config>, to: string, abi: any, functionName: string, args: any[] = []): T {
  const reply = evm.callContract(runtime, {
    call: encodeCallMsg({ from: zeroAddress, to: to as Address, data: encodeFunctionData({ abi, functionName, args }) }),
    blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
  }).result();
  return decodeFunctionResult({ abi, functionName, data: bytesToHex(reply.data) }) as T;
}

const onTick = (runtime: Runtime<Config>) => {
  const cfg = runtime.config;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName, isTestnet: false });
  if (!network) throw new Error(`unknown network ${cfg.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const nowSec = Math.floor(runtime.now().getTime() / 1000);

  const count = Number(read<bigint>(evm, runtime, cfg.poolsAddress, poolsAbi, "poolCount"));
  const first = Math.max(1, count - cfg.lookback + 1);
  let posted = 0;

  for (let id = count; id >= first; id--) {
    const pool = read<any>(evm, runtime, cfg.poolsAddress, poolsAbi, "getPool", [BigInt(id)]);
    if (pool.priced || pool.voided || nowSec < Number(pool.resultTime)) continue;
    if (read<boolean>(evm, runtime, cfg.poolsAddress, poolsAbi, "refundAll", [BigInt(id)])) continue;
    const feed = cfg.feeds[String(pool.asset)];
    if (!feed) { runtime.log(`pool ${id}: no feed for asset ${pool.asset}`); continue; }

    const round = read<readonly [bigint, bigint, bigint, bigint, bigint]>(evm, runtime, feed, feedAbi, "latestRoundData");
    const answer = round[1], updatedAt = round[3];
    if (answer <= 0n) { runtime.log(`pool ${id}: bad feed answer`); continue; }

    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }],
      [BigInt(id), answer, updatedAt],
    );
    const report = runtime.report(prepareReportRequest(payload)).result();
    evm.writeReport(runtime, {
      receiver: cfg.poolsAddress,
      report,
      gasConfig: { gasLimit: cfg.gasLimit },
    }).result();
    runtime.log(`pool ${id}: price ${answer} delivered`);
    posted++;
  }
  return `posted ${posted}`;
};

const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onTick)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
main();
