// Background work. Every step looks at the chain first and only acts if the
// chain says it is still needed, so the loop can crash, restart or run twice
// without harm.
import { ethers } from 'ethers';

const HOLD = 2 * 3600;
const STALE_AFTER = 7 * 86400;
const BATCH = 100;

export function createJobs({ cfg, db, chain, ai, log = console }) {
  const { read } = chain;
  let running = false;

  async function syncPools() {
    const count = Number(await read.pools.poolCount());
    const known = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM pools').get().m;
    for (let id = known + 1; id <= count; id++) {
      const p = await read.pools.getPool(id);
      db.prepare('INSERT OR IGNORE INTO pools(id,creator,asset,lock_time,result_time,entry_amount) VALUES(?,?,?,?,?,?)')
        .run(id, p.creator.toLowerCase(), Number(p.asset), Number(p.lockTime), Number(p.resultTime), p.entryAmount.toString());
    }
  }

  // ---------------------------------------------------------------- calls
  async function runCall(m, now) {
    const o = await read.calls.getMarket(m.id);
    const state = Number(o.state);

    if (state === 3) { db.prepare('UPDATE markets SET done=1 WHERE id=?').run(m.id); return; }

    if (state === 0) {
      if (now < m.closes_at) return;
      if (now >= m.closes_at + STALE_AFTER) {
        await chain.send('settler', 'calls', 'voidIfStale', [m.id], cfg.gas.finalize);
        return;
      }
      if (now < m.next_attempt_at) return;
      try {
        const r = await ai.resolve(JSON.parse(m.terms_json), new Date(m.closes_at * 1000).toISOString());
        db.prepare('UPDATE markets SET evidence_json=? WHERE id=?').run(JSON.stringify(r), m.id);
        await chain.send('settler', 'calls', 'proposeOutcome', [m.id, r.outcome], cfg.gas.propose);
        log.info?.(`market ${m.id} proposed ${r.outcome}`);
      } catch (e) {
        // The model or the network failed: try again later. Only a clear VOID answer voids.
        const attempts = m.resolve_attempts + 1;
        db.prepare('UPDATE markets SET resolve_attempts=?, next_attempt_at=? WHERE id=?')
          .run(attempts, now + Math.min(60 * 2 ** attempts, 3600), m.id);
        log.warn?.(`market ${m.id} resolve attempt ${attempts} failed: ${e.message}`);
      }
      return;
    }

    if (state === 1) {
      if (now >= Number(o.proposedAt) + HOLD) await chain.send('settler', 'calls', 'finalize', [m.id], cfg.gas.finalize);
      return;
    }

    if (state === 2) {
      if (!m.scored) {
        const latest = await chain.provider.getBlockNumber();
        const evs = await chain.logs(read.calls, read.calls.filters.Voted(m.id), m.created_block, latest);
        const voters = [...new Set(evs.map(e => e.args.voter))];
        for (let i = 0; i < voters.length; i += BATCH) {
          const slice = voters.slice(i, i + BATCH);
          await chain.send('settler', 'calls', 'score', [m.id, slice], cfg.gas.finalize + cfg.gas.scorePer * slice.length);
        }
        db.prepare('UPDATE markets SET scored=1 WHERE id=?').run(m.id);
      }
      db.prepare('UPDATE markets SET done=1 WHERE id=?').run(m.id);
    }
  }

  // ---------------------------------------------------------------- pools
  const distance = (g, price) => (g >= price ? g - price : price - g);

  async function runPool(row, now) {
    const id = row.id;
    const p = await read.pools.getPool(id);
    if (p.voided) { db.prepare('UPDATE pools SET done=1 WHERE id=?').run(id); return; }
    const refund = await read.pools.refundAll(id);
    if (refund) { db.prepare('UPDATE pools SET done=1 WHERE id=?').run(id); return; }

    // 1. reveal sealed guesses once entries lock
    if (now >= Number(p.lockTime) && now < Number(p.resultTime)) {
      const pending = db.prepare('SELECT * FROM guesses WHERE pool_id=? AND revealed=0').all(id);
      for (const g of pending) {
        const e = await read.pools.getEntry(id, g.entry_id);
        if (e.revealed) { db.prepare('UPDATE guesses SET revealed=1 WHERE pool_id=? AND entry_id=?').run(id, g.entry_id); continue; }
        try {
          await chain.send('settler', 'pools', 'reveal', [id, g.entry_id, BigInt(g.guess), g.salt], cfg.gas.reveal);
          db.prepare('UPDATE guesses SET revealed=1 WHERE pool_id=? AND entry_id=?').run(id, g.entry_id);
        } catch (e2) { log.warn?.(`reveal ${id}/${g.entry_id}: ${e2.message}`); }
      }
    }

    // 2. price after the result time
    if (now >= Number(p.resultTime) && !p.priced) {
      const feed = cfg.priceFeeds[String(p.asset)];
      if (!feed) return; // no price source: the pool refunds itself after 24h
      try {
        const agg = new ethers.Contract(feed, ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'], chain.provider);
        const [, answer, , updatedAt] = await agg.latestRoundData();
        if (answer > 0n) await chain.send('settler', 'pools', 'reportPrice', [id, answer, updatedAt], cfg.gas.price);
      } catch (e) { log.warn?.(`pool ${id} price: ${e.message}`); }
      return;
    }

    // 3. rank, then 4. score
    if (p.priced) {
      const revealed = Number(p.revealedCount);
      let ranked = Number(p.rankedCount);
      if (ranked < revealed) {
        const list = [];
        for (let eid = 1; eid <= Number(p.entryCount); eid++) {
          const e = await read.pools.getEntry(id, eid);
          if (e.revealed) list.push({ eid, d: distance(e.guess, p.price) });
        }
        list.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.eid - b.eid));
        for (let i = ranked; i < list.length; i += BATCH) {
          const slice = list.slice(i, i + BATCH).map(x => x.eid);
          await chain.send('settler', 'pools', 'submitRanking', [id, slice], cfg.gas.price + cfg.gas.rankPer * slice.length);
        }
        ranked = list.length;
      }
      if (ranked === revealed && !row.scored) {
        const ids = [];
        for (let eid = 1; eid <= Number(p.entryCount); eid++) ids.push(eid);
        for (let i = 0; i < ids.length; i += BATCH) {
          const slice = ids.slice(i, i + BATCH);
          await chain.send('settler', 'pools', 'scoreEntries', [id, slice], cfg.gas.price + cfg.gas.scorePer * slice.length);
        }
        db.prepare('UPDATE pools SET scored=1, done=1 WHERE id=?').run(id);
      }
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = await chain.chainNow();
      try { await syncPools(); } catch (e) { log.warn?.(`syncPools: ${e.message}`); }
      for (const m of db.prepare('SELECT * FROM markets WHERE done=0 ORDER BY id').all()) {
        try { await runCall(m, now); } catch (e) { log.warn?.(`market ${m.id}: ${e.message}`); }
      }
      for (const p of db.prepare('SELECT * FROM pools WHERE done=0 ORDER BY id').all()) {
        try { await runPool(p, now); } catch (e) { log.warn?.(`pool ${p.id}: ${e.message}`); }
      }
    } finally { running = false; }
  }

  return { tick, syncPools, start: () => setInterval(() => tick().catch(e => log.error?.(e)), cfg.tickMs) };
}
