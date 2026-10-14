import { useCallback, useEffect, useState } from 'react';
import { formatEther } from 'viem';
import { useApp } from '../ctx';
import { callsAbi, poolsAbi, prizesAbi, publicClient } from '../chain';
import { sendAndWait } from '../wallet';
import { trimNum } from '../ui';

type Item = { key: string; label: string; amount: bigint; run: () => Promise<void> };

/** Everything the contracts owe this wallet, in one place: stakes, pool entries, and prizes sponsored by you. One button per item, and one for all. */
export function RefundCenter() {
  const { config, account, preview } = useApp();
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const me = account?.address as `0x${string}` | undefined;

  const load = useCallback(async () => {
    if (preview || !me) { setItems([]); return; }
    const out: Item[] = [];
    const A = config.addresses;
    try {
      const n = Number(await publicClient.readContract({ address: A.calls, abi: callsAbi, functionName: 'marketCount' }));
      for (let id = 1; id <= n; id++) {
        const v = (await publicClient.readContract({ address: A.calls, abi: callsAbi, functionName: 'claimable', args: [BigInt(id), me] })) as bigint;
        if (v > 0n) out.push({ key: `c${id}`, label: `Post #${id}: your stake back or winnings`, amount: v, run: async () => { await sendAndWait(account, { address: A.calls, abi: callsAbi, functionName: 'claim', args: [BigInt(id)], gas: 250_000n }); } });
        if (A.prizes) {
          const sp = (await publicClient.readContract({ address: A.prizes, abi: prizesAbi, functionName: 'sponsored', args: [BigInt(id), me] })) as bigint;
          if (sp > 0n) out.push({ key: `z${id}`, label: `Post #${id}: prize you added`, amount: sp, run: async () => { await sendAndWait(account, { address: A.prizes!, abi: prizesAbi, functionName: 'refund', args: [BigInt(id)], gas: 200_000n }); } });
        }
      }
      const fees = (await publicClient.readContract({ address: A.calls, abi: callsAbi, functionName: 'authorFees', args: [me] })) as bigint;
      if (fees > 0n) out.push({ key: 'fees', label: 'Author fees from your posts', amount: fees, run: async () => { await sendAndWait(account, { address: A.calls, abi: callsAbi, functionName: 'withdrawAuthorFees', gas: 120_000n }); } });
      const pc = Number(await publicClient.readContract({ address: A.pools, abi: poolsAbi, functionName: 'poolCount' }));
      for (let id = 1; id <= pc; id++) {
        const pool = (await publicClient.readContract({ address: A.pools, abi: poolsAbi, functionName: 'getPool', args: [BigInt(id)] })) as { entryCount: number };
        for (let e = 1; e <= Number(pool.entryCount); e++) {
          const en = (await publicClient.readContract({ address: A.pools, abi: poolsAbi, functionName: 'getEntry', args: [BigInt(id), BigInt(e)] })) as { entrant: string };
          if (en.entrant.toLowerCase() !== me.toLowerCase()) continue;
          const v = (await publicClient.readContract({ address: A.pools, abi: poolsAbi, functionName: 'claimable', args: [BigInt(id), BigInt(e)] })) as bigint;
          if (v > 0n) out.push({ key: `p${id}-${e}`, label: `Pool #${id}: your entry back or winnings`, amount: v, run: async () => { await sendAndWait(account, { address: A.pools, abi: poolsAbi, functionName: 'claim', args: [BigInt(id), BigInt(e)], gas: 250_000n }); } });
        }
      }
    } catch (e: any) { setMsg(e.shortMessage ?? e.message); }
    setItems(out);
  }, [me, preview]);

  useEffect(() => { load(); }, [load]);

  const go = async (list: Item[]) => {
    setMsg('');
    for (const it of list) {
      setBusy(it.key);
      try { await it.run(); } catch (e: any) { setMsg(e.shortMessage ?? e.message); break; }
    }
    setBusy('');
    load();
  };

  if (!items) return null;
  const total = items.reduce((a, i) => a + i.amount, 0n);
  return (
    <>
      <p className="heading">Your money in the contracts</p>
      {items.length === 0 ? (
        <div className="group"><div className="grow"><span className="gm"><b>Nothing waiting</b><span>Stakes, pool entries and prizes you added come back here as soon as they can be claimed.</span></span></div></div>
      ) : (
        <div className="group">
          {items.map(i => (
            <div key={i.key} className="grow">
              <span className="gm"><b>{trimNum(formatEther(i.amount))} MON</b><span>{i.label}</span></span>
              <button className="btn sm" disabled={!!busy} onClick={() => go([i])}>{busy === i.key ? 'Confirming…' : 'Claim'}</button>
            </div>
          ))}
          {items.length > 1 && (
            <div className="grow">
              <span className="gm"><b>{trimNum(formatEther(total))} MON in total</b><span>Claim everything in one go</span></span>
              <button className="btn sm" disabled={!!busy} onClick={() => go(items)}>{busy ? 'Working…' : 'Claim all'}</button>
            </div>
          )}
        </div>
      )}
      {msg && <p className="err" role="alert">{msg}</p>}
    </>
  );
}
