// Everything that needs the user's wallet: signing, sending, and the passkey check for big amounts.
import { authenticatePasskeyMFA, getPasskeys, registerPasskey, NoPasskeyCredentialsFoundError } from '@dynamic-labs-sdk/client';
import { createWalletClientForWalletAccount } from '@dynamic-labs-sdk/evm/viem';
import type { Address } from 'viem';
import { publicClient } from './chain';
import { STEP_UP_MON } from './env';

/** Picks the account to act with: the in-app wallet when there is one. */
export function pickAccount(accounts: any[] | undefined) {
  const evm = (accounts ?? []).filter(a => /^0x/i.test(a.address ?? ''));
  return evm.find(a => /waas|embedded|dynamic/i.test(a.walletProviderKey ?? '')) ?? evm[0] ?? null;
}

export async function walletClientFor(account: any) {
  return createWalletClientForWalletAccount({ walletAccount: account });
}

/**
 * Large amounts need a passkey. The app decides the threshold; Dynamic only
 * provides the passkey prompt. Throws a readable error if it cannot be done.
 */
export async function requireStepUp(mon: number) {
  if (mon < STEP_UP_MON) return;
  try {
    const have = await getPasskeys();
    if (!have || have.length === 0) {
      await registerPasskey();
    }
    await authenticatePasskeyMFA();
  } catch (e: any) {
    if (e instanceof NoPasskeyCredentialsFoundError) throw new Error('Add a passkey to your account to move this much.');
    throw new Error(e?.message ?? 'Passkey check failed.');
  }
}

export async function sendAndWait(
  account: any, args: { address: Address; abi: any; functionName: string; args?: any[]; value?: bigint; gas: bigint },
) {
  const wc = await walletClientFor(account);
  const hash = await wc.writeContract({
    address: args.address, abi: args.abi, functionName: args.functionName as never, args: (args.args ?? []) as never,
    value: args.value, gas: args.gas,
  } as never);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('The transaction failed.');
  return rc;
}
