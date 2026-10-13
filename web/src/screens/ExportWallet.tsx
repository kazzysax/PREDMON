// Let a person take their wallet with them. The key is drawn by Dynamic inside its own sealed frame,
// so it never passes through this app's code.
import { useRef, useState } from 'react';
import { exportWaasPrivateKey, isWaasWalletAccount } from '@dynamic-labs-sdk/client/waas';
import { Sheet } from '../ui';

export function ExportWallet({ account, onClose }: { account: any; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const [msg, setMsg] = useState('');

  const show = async () => {
    setMsg(''); setBusy(true);
    try {
      if (!account || !isWaasWalletAccount({ walletAccount: account })) throw new Error('This wallet can\'t be exported from here.');
      await exportWaasPrivateKey({ walletAccount: account, displayContainer: box.current! });
      setShown(true);
    } catch (e: any) { setMsg(e.shortMessage ?? e.message ?? 'We couldn\'t open the export. Please try again.'); }
    finally { setBusy(false); }
  };

  return (
    <Sheet onClose={onClose}>
      <h2 className="h2">Export your wallet</h2>
      <p className="lede">Take your wallet into MetaMask, Rabby or any other wallet, and move funds out, including tokens on other chains.</p>
      {!shown && (
        <>
          <p className="info"><b>Keep it private.</b> Anyone with this key can take everything in the wallet. PredTube will never ask for it, and nobody from PredTube needs it. Only you see it, inside a sealed Dynamic window.</p>
          <label className="check"><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /> <span>I understand, and I'm somewhere private.</span></label>
          {msg && <p className="err" role="alert">{msg}</p>}
          <button className="btn" disabled={!ok || busy} onClick={show}>{busy ? 'Opening…' : 'Show my private key'}</button>
        </>
      )}
      <div ref={box} className="exportbox" />
      {shown && (
        <p className="info">In MetaMask: tap your account, <b>Add account or hardware wallet</b>, <b>Import account</b>, and paste the key. Your address stays the same, so your funds on Base, Ethereum and other chains appear when you switch network.</p>
      )}
      <button className="text-btn" onClick={onClose}>{shown ? 'Done' : 'Cancel'}</button>
    </Sheet>
  );
}
