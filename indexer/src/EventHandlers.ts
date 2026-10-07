// Turns contract events into queryable rows. Written against Envio HyperIndex
// 2.x conventions; run `pnpm envio codegen` then `pnpm envio dev` to check it.
import { Calls, Pools, Reputation } from "generated";

const STATES = ["open", "proposed", "finalized", "void"];
const posId = (market: bigint, voter: string) => `${market}-${voter.toLowerCase()}`;

Calls.MarketCreated.handler(async ({ event, context }) => {
  context.Market.set({
    id: event.params.id.toString(),
    creator: event.params.creator.toLowerCase(),
    category: Number(event.params.category),
    termsHash: event.params.termsHash,
    locksAt: Number(event.params.locksAt),
    closesAt: Number(event.params.closesAt),
    state: "open", outcome: 0, yesWeight: 0n, noWeight: 0n, voteCount: 0,
    createdAt: event.block.timestamp,
  });
});

Calls.Voted.handler(async ({ event, context }) => {
  const id = event.params.id.toString();
  const m = await context.Market.get(id);
  if (m) {
    context.Market.set({
      ...m, voteCount: m.voteCount + 1,
      yesWeight: m.yesWeight + (event.params.yes ? event.params.weightBps : 0n),
      noWeight: m.noWeight + (event.params.yes ? 0n : event.params.weightBps),
    });
  }
  context.Position.set({
    id: posId(event.params.id, event.params.voter), market: id, voter: event.params.voter.toLowerCase(),
    yes: event.params.yes, staked: 0n, claimed: 0n, repDelta: 0n, scored: false,
  });
});

Calls.Staked.handler(async ({ event, context }) => {
  const pid = posId(event.params.id, event.params.voter);
  const p = await context.Position.get(pid);
  if (p) context.Position.set({ ...p, staked: p.staked + event.params.amount });
});

const setState = (state: number) => async ({ event, context }: any) => {
  const m = await context.Market.get(event.params.id.toString());
  if (m) context.Market.set({ ...m, state: STATES[state], outcome: event.params.outcome !== undefined ? Number(event.params.outcome) : m.outcome });
};
Calls.OutcomeProposed.handler(setState(1));
Calls.OutcomeCorrected.handler(setState(1));
Calls.Finalized.handler(setState(2));
Calls.Voided.handler(async ({ event, context }) => {
  const m = await context.Market.get(event.params.id.toString());
  if (m) context.Market.set({ ...m, state: "void", outcome: 3 });
});

Calls.Scored.handler(async ({ event, context }) => {
  const p = await context.Position.get(posId(event.params.id, event.params.voter));
  if (p) context.Position.set({ ...p, scored: true, repDelta: event.params.repDelta });
});
Calls.Claimed.handler(async ({ event, context }) => {
  const p = await context.Position.get(posId(event.params.id, event.params.voter));
  if (p) context.Position.set({ ...p, claimed: p.claimed + event.params.amount });
});

Pools.PoolCreated.handler(async ({ event, context }) => {
  context.Pool.set({
    id: event.params.id.toString(), creator: event.params.creator.toLowerCase(), asset: Number(event.params.asset),
    entryAmount: event.params.entryAmount, lockTime: Number(event.params.lockTime), resultTime: Number(event.params.resultTime),
    entryCount: 0, revealedCount: 0, price: undefined, voided: false,
  });
});
Pools.Entered.handler(async ({ event, context }) => {
  const pid = event.params.id.toString();
  const p = await context.Pool.get(pid);
  if (p) context.Pool.set({ ...p, entryCount: p.entryCount + 1 });
  context.PoolEntry.set({
    id: `${pid}-${event.params.entryId}`, pool: pid, entryId: Number(event.params.entryId),
    entrant: event.params.entrant.toLowerCase(), guess: undefined, repDelta: undefined, paid: 0n,
  });
});
Pools.Revealed.handler(async ({ event, context }) => {
  const pid = event.params.id.toString();
  const p = await context.Pool.get(pid);
  if (p) context.Pool.set({ ...p, revealedCount: p.revealedCount + 1 });
  const e = await context.PoolEntry.get(`${pid}-${event.params.entryId}`);
  if (e) context.PoolEntry.set({ ...e, guess: event.params.guess });
});
Pools.PriceReported.handler(async ({ event, context }) => {
  const p = await context.Pool.get(event.params.id.toString());
  if (p) context.Pool.set({ ...p, price: event.params.price });
});
Pools.PoolVoided.handler(async ({ event, context }) => {
  const p = await context.Pool.get(event.params.id.toString());
  if (p) context.Pool.set({ ...p, voided: true });
});
Pools.EntryScored.handler(async ({ event, context }) => {
  const e = await context.PoolEntry.get(`${event.params.id}-${event.params.entryId}`);
  if (e) context.PoolEntry.set({ ...e, repDelta: event.params.repDelta });
});
Pools.Claimed.handler(async ({ event, context }) => {
  const e = await context.PoolEntry.get(`${event.params.id}-${event.params.entryId}`);
  if (e) context.PoolEntry.set({ ...e, paid: e.paid + event.params.amount });
});

Reputation.RepChanged.handler(async ({ event, context }) => {
  const id = `${event.params.user.toLowerCase()}-${event.params.category}`;
  const r = await context.Reputation.get(id);
  context.Reputation.set({
    id, user: event.params.user.toLowerCase(), category: Number(event.params.category),
    score: event.params.newScore, scored: (r?.scored ?? 0) + 1, won: (r?.won ?? 0) + (event.params.won ? 1 : 0),
  });
});
