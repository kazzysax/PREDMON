import { createContext, useContext } from 'react';

export type Me = {
  id: string; username: string | null; wallet: string; xVerified: boolean; xUsername: string | null;
  reputation: { category: number; name: string; score: number; scored: number; won: number }[];
};
export type Config = {
  chainId: number; addresses: { reputation: `0x${string}`; calls: `0x${string}`; pools: `0x${string}`; prizes?: `0x${string}` };
  categories: string[]; maxStake: string; maxEntry: string; limits: { callsPerDay: number };
};
export type Ctx = {
  config: Config; me: Me; account: any; reloadMe: () => Promise<void>;
  hasX: boolean; linkX: () => void; signOut: () => void;
  /** Sample-data mode: no wallet, no network. */
  preview?: { balance: string };
};
export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);
