import '@aurora-is-near/intents-swap-widget/styles.css';
import { Widget, WidgetConfigProvider } from '@aurora-is-near/intents-swap-widget';
import { evm } from '@aurora-is-near/intents-swap-widget-evm';
import { AURORA_KEY } from '../env';

export default function AuroraWidget({ address }: { address: string }) {
  const injected = (window as any).ethereum;
  return (
    <WidgetConfigProvider
      config={{
        apiKey: AURORA_KEY,
        sendAddress: address,
        // Deposit mode needs the destination spelled out: MON on Monad, sent to the in-app wallet.
        defaultTargetToken: { symbol: 'MON', blockchain: 'monad' },
        // Pay from a browser wallet if there is one, or scan a QR code from any wallet.
        connectedWallets: {},
        providers: injected ? { evm: injected } : {},
        plugins: { evm },
        allowSwapWithExternalWallet: true,
        allowedChainsList: ['monad', 'eth', 'base', 'arb', 'op', 'sol', 'near'],
      } as any}
      theme={{ colorScheme: 'dark', accentColor: '#ff8a5c', backgroundColor: '#161412' } as any}
    >
      <Widget defaultMode="topup" />
    </WidgetConfigProvider>
  );
}
