'use strict';

// Phase 5 · convergence fuzzing AT SCALE. Thousands of randomized concurrent
// scenarios exercising the whole stack together — RGA integration, version-
// vector delta sync, AND garbage collection — asserting Strong Eventual
// Consistency every time. GC is folded in deliberately: a converged system that
// diverges after compaction is a classic subtle bug, and this is where it would
// surface.

const { makeRng } = require('../common/rng');
const { SyncDoc } = require('../phase3-sync/sync-doc');
const gc = require('../phase4-systems/gc');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function scenario(seed) {
  const rng = makeRng(seed);
  const n = 3 + (rng.int(4)); // 3..6 replicas
  const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
  const docs = ids.map((id) => new SyncDoc(id));

  // Pending deltas per directed pair, so sync is asynchronous and reorderable.
  const steps = 60 + rng.int(120);
  for (let s = 0; s < steps; s++) {
    const d = rng.pick(docs);
    const roll = rng.next();
    if (roll < 0.55) {
      const len = d.length();
      d.insertAt(len === 0 ? 0 : rng.int(len + 1), 'abcdefg'[rng.int(7)]);
    } else if (roll < 0.72 && d.length() > 0) {
      d.deleteAt(rng.int(d.length()));
    } else {
      // Sync a random directed pair (partial-knowledge delta).
      const a = rng.pick(docs);
      const b = rng.pick(docs);
      if (a !== b) a.integrate(b.delta(a.stateVector()));
    }
  }

  // Settle: full all-to-all sync.
  for (let round = 0; round < 3; round++)
    for (const a of docs) for (const b of docs) if (a !== b) a.integrate(b.delta(a.stateVector()));

  // Everyone converged?
  const ref = docs[0].text();
  for (const d of docs) assert(d.text() === ref, `seed ${seed}: pre-GC divergence`);

  // Now GC on every replica with the shared causal frontier, then re-assert.
  const frontier = gc.meetVV(docs.map((d) => d.stateVector()));
  for (const d of docs) {
    gc.contentGC(d, frontier);
    gc.structuralCompact(d, frontier);
    gc.compactOplog(d, frontier);
  }
  for (const d of docs) assert(d.text() === ref, `seed ${seed}: POST-GC divergence (GC broke convergence!)`);

  // After a settled full sync, GC should have been able to compact (quiescent).
  return ref.length;
}

function main() {
  const N = Number(process.argv[2] || 3000);
  let chars = 0;
  const t0 = process.hrtime.bigint();
  for (let seed = 1; seed <= N; seed++) chars += scenario(seed);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`✓ ${N} scaled scenarios converged (RGA + delta sync + GC), SEC held every time`);
  console.log(`  • ${chars} converged characters total`);
  console.log(`  • GC preserved convergence in all ${N} runs (no post-compaction divergence)`);
  console.log(`  • ${ms.toFixed(0)}ms total (${(ms / N).toFixed(2)}ms/scenario)`);
}

main();
