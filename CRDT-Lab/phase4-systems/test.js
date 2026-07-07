'use strict';

// Phase 4 suite: tombstone GC (with an explicit safety proof), binary encoding
// (round-trip + benchmark), snapshot loading, and oplog compaction.

const { makeRng } = require('../common/rng');
const { SyncDoc } = require('../phase3-sync/sync-doc');
const { RGA } = require('../phase2-sequence/rga');
const gc = require('./gc');
const enc = require('./encoding');
const snapshot = require('./snapshot');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function syncAll(docs) {
  // Bring every doc fully up to date with every other (delta both directions).
  for (const a of docs)
    for (const b of docs)
      if (a !== b) a.integrate(b.delta(a.stateVector()));
}

// ===========================================================================
console.log('Tombstone garbage collection:');

// ---- 1a. Content GC + structural compaction reclaim stably-deleted nodes ----
(function reclaim() {
  const a = new SyncDoc('A');
  const b = new SyncDoc('B');
  // Type 200 chars, delete 150 of them, across both replicas.
  for (let i = 0; i < 120; i++) a.insertAt(a.length(), 'a');
  for (let i = 0; i < 80; i++) b.insertAt(b.length(), 'b');
  syncAll([a, b]);
  for (let i = 0; i < 150; i++) a.deleteAt(0);
  syncAll([a, b]);

  const before = a.nodeCount();
  const liveText = a.text();
  const frontier = gc.meetVV([a.stateVector(), b.stateVector()]);

  const contentReclaimed = gc.contentGC(a, frontier);
  assert(a.text() === liveText, 'content GC must not change visible text');
  assert(a.rga.nodes.filter((n) => n.deleted && n.value !== null).length === 0, 'all stable tombstones compacted');

  const { removed, skipped } = gc.structuralCompact(a, frontier);
  assert(!skipped, `structural compaction should run at quiescence, got: ${skipped}`);
  assert(a.text() === liveText, 'structural compaction must not change visible text');
  assert(a.tombstoneCount() === 0, 'all stable tombstones physically removed');
  assert(a.nodeCount() === a.liveCount(), 'node count equals live count after compaction');

  console.log(
    `  ✓ reclaimed ${contentReclaimed} payloads + removed ${removed} tombstone anchors ` +
      `(${before} nodes → ${a.nodeCount()}); text intact (${a.length()} chars)`
  );
})();

// ---- 1b. GC refuses to collect what isn't causally stable (SAFETY) ----------
(function safety() {
  // 3 replicas. A inserts N; everyone gets it. B (before seeing the delete)
  // inserts M anchored at N. A deletes N; the delete reaches everyone. But B's
  // insert M has NOT yet reached C. The delete is stable; M is not.
  const A = new SyncDoc('A');
  const B = new SyncDoc('B');
  const C = new SyncDoc('C');

  A.insertAt(0, 'N');
  syncAll([A, B, C]); // all have N

  const M = B.insertAt(1, 'M'); // B anchors M after N (N still visible at B)
  const D = A.deleteAt(0); // A deletes N
  // Deliver the delete D to everyone, and M to A only — NOT to C.
  B.integrate([D]);
  C.integrate([D]);
  A.integrate([M]);
  // Now: A has {N(del), M}. C has {N(del)} but is missing M.

  const frontier = gc.meetVV([A.stateVector(), B.stateVector(), C.stateVector()]);
  const deleteKey = `${D.inner.id.c}:${D.inner.id.r}`;
  assert(gc.isStable(A.deleteMeta[deleteKey], frontier), 'the delete of N is causally stable');

  // Even though the delete is stable, structural compaction must REFUSE on A,
  // because M (which anchors at N) is still in flight to C → not quiescent.
  const res = gc.structuralCompact(A, frontier);
  assert(res.removed === 0 && res.skipped, `unsafe compaction not refused: ${JSON.stringify(res)}`);

  // Prove the danger the guard averts: if we FORCE-remove N from C and then M
  // finally arrives, M dangles forever (its anchor is gone).
  const cForced = new SyncDoc('C');
  cForced.integrate([{ origin: 'A', seq: 1, inner: A.oplog.A[0].inner }]); // N
  cForced.integrate([D]); // delete N
  // Force-drop N's anchor (simulating an unsafe GC).
  const nkey = `${A.oplog.A[0].inner.id.c}:${A.oplog.A[0].inner.id.r}`;
  cForced.rga.nodes = cForced.rga.nodes.filter((n) => `${n.id.c}:${n.id.r}` !== nkey);
  cForced.rga.byKey.delete(nkey);
  cForced.integrate([M]); // M arrives, anchored at the now-missing N
  assert(cForced.rga.pending.length === 1, 'forced-unsafe GC makes the late insert dangle');

  console.log('  ✓ refuses to compact while a concurrent insert is in flight (guard verified)');
  console.log('    and demonstrates the dangling insert that the guard prevents');
})();

// ---- 1c. Oplog compaction drops stable ops ---------------------------------
(function oplog() {
  const a = new SyncDoc('A');
  const b = new SyncDoc('B');
  for (let i = 0; i < 50; i++) a.insertAt(a.length(), 'x');
  syncAll([a, b]);
  const frontier = gc.meetVV([a.stateVector(), b.stateVector()]);
  const before = a.oplogCount();
  const dropped = gc.compactOplog(a, frontier);
  // A peer that is already up to date needs nothing, so dropping stable ops is safe.
  assert(a.delta(b.stateVector()).length === 0, 'an up-to-date peer needs no dropped op');
  console.log(`  ✓ oplog compaction dropped ${dropped}/${before} causally-stable ops`);
})();

// ===========================================================================
console.log('\nBinary encoding:');

// ---- 2a. Round-trip fidelity over random docs ------------------------------
(function roundTrip() {
  const SEEDS = 200;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = makeRng(seed);
    const doc = new SyncDoc('A');
    const n = 20 + (seed % 60);
    for (let i = 0; i < n; i++) {
      const len = doc.length();
      if (len === 0 || rng.chance(0.75)) doc.insertAt(rng.chance(0.6) ? len : rng.int(len + 1), 'abcde'[rng.int(5)]);
      else doc.deleteAt(rng.int(len));
    }
    const buf = enc.encode(doc.oplog);
    const ops = enc.decode(buf);
    // Apply decoded ops into a fresh RGA; must reproduce the same text.
    const rebuilt = new RGA('Z');
    for (const w of ops) rebuilt.apply(w.inner);
    assert(rebuilt.text() === doc.text(), `seed ${seed}: decoded ops rebuild wrong text`);
    assert(ops.length === doc.oplogCount(), `seed ${seed}: op count mismatch`);
  }
  console.log(`  ✓ encode→decode round-trips exactly over ${SEEDS} random documents`);
})();

// ---- 2b. Benchmark vs naive JSON on a realistic typing workload ------------
(function benchmark() {
  const doc = new SyncDoc('A');
  const para =
    'The quick brown fox jumps over the lazy dog. Collaborative editing is fun. '.repeat(40);
  for (const ch of para) doc.insertAt(doc.length(), ch);
  // Delete a contiguous selection (exercises delete-run encoding).
  for (let i = 0; i < 200; i++) doc.deleteAt(100);

  const naive = enc.naiveBytes(doc.oplog);
  const buf = enc.encode(doc.oplog);
  const ratio = (naive / buf.length).toFixed(1);
  // Sanity: it still round-trips.
  const rebuilt = new RGA('Z');
  for (const w of enc.decode(buf)) rebuilt.apply(w.inner);
  assert(rebuilt.text() === doc.text(), 'benchmark doc must round-trip');

  console.log(`  ✓ ${doc.oplogCount()} ops: naive JSON ${naive}B → binary ${buf.length}B (${ratio}× smaller)`);
  console.log(`    (run-length encoding of typing runs + interned replica ids + varints)`);
})();

// ===========================================================================
console.log('\nSnapshot loading:');

(function snapshotBench() {
  const doc = new SyncDoc('A');
  const N = 20000;
  for (let i = 0; i < N; i++) doc.insertAt(doc.length(), 'x');

  // Load path 1: replay the whole oplog into a fresh doc (integration cost).
  const ops = enc.flatten(doc.oplog);
  let t0 = process.hrtime.bigint();
  const replayed = new SyncDoc('B');
  replayed.integrate(ops);
  let replayMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Load path 2: from a snapshot (direct array copy, no integration).
  const snap = snapshot.save(doc);
  t0 = process.hrtime.bigint();
  const loaded = snapshot.load('C', snap);
  let snapMs = Number(process.hrtime.bigint() - t0) / 1e6;

  assert(replayed.text() === doc.text() && loaded.text() === doc.text(), 'both load paths must match');
  const speedup = (replayMs / Math.max(snapMs, 0.001)).toFixed(1);
  console.log(
    `  ✓ ${N}-edit doc: replay-load ${replayMs.toFixed(1)}ms vs snapshot-load ${snapMs.toFixed(1)}ms ` +
      `(${speedup}× faster); identical text`
  );
})();

console.log('\n✓ Phase 4 complete: tombstone GC (with safety proof), binary encoding, snapshots.');
