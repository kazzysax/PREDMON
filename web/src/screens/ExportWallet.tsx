// Let a person take their wallet with them. The key is drawn by Dynamic inside its own sealed frame,
// so it never passes through this app's code. Dynamic wants a fresh proof it is really you first
// (a passkey, or a code sent to your email), so that step comes before the key.
import { useRef, useState } from 'react';
import { TokenScope, authenticatePasskeyMFA, checkStepUpAuth, sendEmailOTP, verifyOTP } from '@dynamic-labs-sdk/client';
import { exportWaasPrivateKey, isWaasWalletAccount } from '@dynamic-labs-sdk/client/waas';
import { useApp } from '../ctx';
import { Sheet } from '../ui';

type Step = 'start' | 'code' | 'shown';

export function ExportWallet({ account, onClose }: { account: any; onClose: () => void }) {
  const { me } = useApp();
  const box = useRef<HTMLDivElement>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>('start');
  const [msg, setMsg] = useState('');
  const [code, setCode] = useState('');
  const [otp, setOtp] = useState<any>(null);
  const [mail, setMail] = useState('');

  const reveal = async () => {
    await exportWaasPrivateKey({ walletAccount: account, displayContainer: box.current! });
    setStep('shown');
  };

  const begin = async () => {
    setMsg(''); setBusy(true);
    try {
      if (!account || !isWaasWalletAccount({ walletAccount: account })) throw new Error('This wallet can\'t be exported from here.');
      const check = await checkStepUpAuth({ scope: TokenScope.Walletexport });
      if (!check.isRequired) { await reveal(); return; }
      const creds: any[] = check.credentials ?? [];
      const pick = creds.find(c => c.id === check.defaultCredentialId) ?? creds[0];
      const formats = creds.map(c => c.format).join(', ') || 'none';
      const passkey = creds.find(c => String(c.format).toLowerCase().includes('passkey'));
      const email = creds.find(c => String(c.format).toLowerCase() === 'email');
      if (passkey && (!email || pick === passkey)) {
        await authenticatePasskeyMFA({ requestedScopes: [TokenScope.Walletexport] });
        await reveal();
      } else if (email || (me as any)?.email) {
        const to = email?.alias ?? (me as any)?.email;
        if (!to) throw new Error('No email is on this account to send a code to.');
        setMail(to);
        setOtp(await sendEmailOTP({ email: to }));
        setStep('code');
      } else {
        throw new Error(`Dynamic asked for a sign-in check this screen can't do yet (${formats}).`);
      }
    } catch (e: any) { setMsg(e.shortMessage ?? e.message ?? 'We couldn\'t open the export. Please try again.'); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    setMsg(''); setBusy(true);
    try {
      await verifyOTP({ otpVerification: otp, verificationToken: code.trim(), requestedScopes: [TokenScope.Walletexport] });
      await reveal();
    } catch (e: any) { setMsg(/otp|code|invalid/i.test(String(e.message)) ? 'That code didn\'t work. Check it and try again.' : (e.shortMessage ?? e.message)); }
    finally { setBusy(false); }
  };

  return (
    <Sheet onClose={onClose}>
      <h2 className="h2">Export your wallet</h2>
      <p className="lede">Take your wallet into MetaMask, Rabby or any other wallet, and move funds out, including tokens on other chains.</p>
      {step === 'start' && (
        <>
          <p className="info"><b>Keep it private.</b> Anyone with this key can take everything in the wallet. PredTube will never ask for it, and nobody from PredTube needs it. Only you see it, inside a sealed Dynamic window.</p>
          <label className="check"><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /> <span>I understand, and I'm somewhere private.</span></label>
          {msg && <p className="err" role="alert">{msg}</p>}
          <button className="btn" disabled={!ok || busy} onClick={begin}>{busy ? 'Checking…' : 'Show my private key'}</button>
        </>
      )}
      {step === 'code' && (
        <>
          <p className="info">We sent a code to <b>{mail}</b>. Enter it to prove it's you.</p>
          <label><span className="label">Code</span><input className="in" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} placeholder="123456" autoFocus /></label>
          {msg && <p className="err" role="alert">{msg}</p>}
          <button className="btn" disabled={busy || code.trim().length < 4} onClick={confirm}>{busy ? 'Checking…' : 'Confirm and show key'}</button>
        </>
      )}
      <div ref={box} className="exportbox" />
      {step === 'shown' && (
        <p className="info">In MetaMask: tap your account, <b>Add account or hardware wallet</b>, <b>Import account</b>, and paste the key. Your address stays the same, so your funds on Base, Ethereum and other chains appear when you switch network.</p>
      )}
      <button className="text-btn" onClick={onClose}>{step === 'shown' ? 'Done' : 'Cancel'}</button>
    </Sheet>
  );
}
