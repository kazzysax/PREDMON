// Dynamic client: sign-in, in-app wallet creation, and the helpers the screens share.
import { createDynamicClient } from '@dynamic-labs-sdk/client';
import { addEvmExtension } from '@dynamic-labs-sdk/evm';
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from '@dynamic-labs-sdk/client/waas';
import { DYNAMIC_ENV } from './env';

export const dynamicClient = createDynamicClient({
  environmentId: DYNAMIC_ENV,
  metadata: { name: 'PredMon', universalLink: window.location.origin },
});
addEvmExtension();

/**
 * Google sign-in creates the user but not necessarily a wallet. Make sure an
 * in-app wallet exists for every signed-in user.
 */
export async function ensureWallet() {
  const missing = getChainsMissingWaasWalletAccounts();
  if (missing.length > 0) await createWaasWalletAccounts({ chains: missing });
}
