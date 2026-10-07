// Delivers a call's outcome onchain as a DON-signed report.
//
// The backend decides the outcome (AI resolver with cited evidence) and sends
// it here as a signed HTTP request. The DON verifies the sender's key, signs a
// report (marketId, outcome) and writes it to Calls.onReport. The contract
// accepts it only from the forwarder and only for our workflow owner, then
// applies the same 2-hour dispute hold as any other outcome.
//
// STATUS: written against @chainlink/cre-sdk 1.23. Not yet run on a DON.
import {
  cre, Runner, getNetwork, prepareReportRequest, decodeJson, type Runtime, type HTTPPayload,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters } from "viem";
import { z } from "zod";

const configSchema = z.object({
  chainSelectorName: z.string(),
  callsAddress: z.string(),
  authorizedKey: z.string(),                  // EVM address of the backend key allowed to trigger this
  gasLimit: z.string(),
});
type Config = z.infer<typeof configSchema>;

const bodySchema = z.object({
  marketId: z.number().int().positive(),
  outcome: z.number().int().min(1).max(3),    // 1 YES, 2 NO, 3 VOID
});

const onRequest = (runtime: Runtime<Config>, payload: HTTPPayload) => {
  const cfg = runtime.config;
  const body = bodySchema.parse(decodeJson(payload.input));
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName, isTestnet: false });
  if (!network) throw new Error(`unknown network ${cfg.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);

  const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }], [BigInt(body.marketId), body.outcome]);
  const report = runtime.report(prepareReportRequest(data)).result();
  evm.writeReport(runtime, { receiver: cfg.callsAddress, report, gasConfig: { gasLimit: cfg.gasLimit } }).result();
  return `market ${body.marketId} outcome ${body.outcome} delivered`;
};

const initWorkflow = (config: Config) => {
  const http = new cre.capabilities.HTTPCapability();
  return [cre.handler(http.trigger({ authorizedKeys: [{ type: "KEY_TYPE_ECDSA_EVM", publicKey: config.authorizedKey }] }), onRequest)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
main();
