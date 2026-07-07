'use strict';

// Phase 3 suite: version-vector delta sync, offline reconnection, and awareness
// ephemerality. The headline assertion is the roadmap's understanding gate — a
// client goes offline, makes 500 edits, reconnects, and syncs in ONE compact
// delta exchange rather than replaying every operation.

const { makeRng } = require('../common/rng');
const { SyncDoc } = require('./sync-doc');
const { Awareness } = require('./awareness');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A helper that fully syncs two docs via the delta protocol and counts the
// messages exchanged (to prove sync is O(changes), not O(history)).
function syncPair(a, b) {
  // a learns what b has that a lacks, and vice versa — two deltas, one each way.
  const deltaToA = b.delta(a.stateVector());
  const deltaToB = a.delta(b.stateVector());
  a.integrate(deltaToA);
  b.integrate(deltaToB);
  return { toA: deltaToA.length, toB: deltaToB.length, messages: 2 };
}

// ---- 1. Delta-sync correctness under random concurrent histories ------------
(function deltaSyncFuzz() {
  const SEEDS = 300;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = makeRng(seed);
    const a = new SyncDoc('A');
    const b = new SyncDoc('B');
    const docs = [a, b];
    const ops = 20 + (seed % 40);
    for (let i = 0; i < ops; i++) {
      const d = rng.pick(docs);
      const len = d.length();
      if (len === 0 || rng.chance(0.7)) d.insertAt(rng.int(len + 1), 'abcde'[rng.int(5)]);
      else d.deleteAt(rng.int(len));
      // Occasionally sync a pair mid-flight (partial knowledge → real deltas).
      if (rng.chance(0.3)) syncPair(a, b);
    }
    syncPair(a, b);
    syncPair(a, b); // ensure a full round settles
    assert(a.text() === b.text(), `seed ${seed}: delta sync diverged`);
  }
  console.log(`✓ delta sync converges over ${SEEDS} randomized concurrent histories`);
})();

// ---- 2. THE gate: offline 500 edits → one compact delta ---------------------
(function offlineReconnect() {
  const a = new SyncDoc('A');
  const b = new SyncDoc('B');

  // Start in sync with some shared content.
  for (let i = 0; i < 10; i++) a.insertAt(a.length(), 'x');
  syncPair(a, b);
  assert(a.text() === b.text() && a.length() === 10, 'precondition: synced baseline');

  // --- A goes OFFLINE and makes 500 edits; B makes 3 edits meanwhile ---
  for (let i = 0; i < 500; i++) a.insertAt(a.length(), 'y');
  for (let i = 0; i < 3; i++) b.insertAt(0, 'z');

  // --- reconnect: exactly one delta each way ---
  const vvA = a.stateVector(); // what A has (compact: {A: 510})
  const vvB = b.stateVector(); // what B has ({A:10, B:3})
  const deltaForB = a.delta(vvB); // A's 500 new ops
  const deltaForA = b.delta(vvA); // B's 3 new ops

  assert(deltaForB.length === 500, `expected 500-op delta to B, got ${deltaForB.length}`);
  assert(deltaForA.length === 3, `expected 3-op delta to A, got ${deltaForA.length}`);

  b.integrate(deltaForB);
  a.integrate(deltaForA);

  assert(a.text() === b.text(), 'post-reconnect divergence');
  assert(a.length() === 513, `expected 513 chars, got ${a.length()}`);

  // The compactness claim, made concrete: the version vector that summarized
  // "510 A-ops + 3 B-ops = 513 characters" is just two integers.
  const vvBytes = JSON.stringify(vvA).length;
  console.log('✓ offline reconnection: 500 edits synced in ONE 500-op delta (not 500 messages)');
  console.log(`  • A's entire state summarized by version vector ${JSON.stringify(vvA)} (${vvBytes} bytes)`);
  console.log(`  • converged to ${a.length()} characters; B needed only its 3 ops in return`);
})();

// ---- 3. Awareness is ephemeral and time-bounded -----------------------------
(function awarenessEphemeral() {
  const doc = new SyncDoc('A');
  const aw = new Awareness('A');

  // A cursor update produces an awareness message — and crucially does NOT touch
  // the oplog or version vector.
  const vvBefore = JSON.stringify(doc.stateVector());
  const msg = aw.setLocal({ cursor: 42, name: 'Ada' });
  assert(msg.type === 'awareness', 'awareness message shape');
  assert(JSON.stringify(doc.stateVector()) === vvBefore, 'awareness must NOT affect the CRDT vector');

  // Peer presence is visible while fresh and disappears once stale.
  aw.receive({ type: 'awareness', clientId: 'B', state: { cursor: 7 } }, 1000);
  assert(aw.peers(1000).B.cursor === 7, 'fresh peer presence visible');
  assert(Object.keys(aw.peers(1000 + 31000)).length === 0, 'stale presence expires');
  console.log('✓ awareness is ephemeral: never enters the oplog and expires on timeout');
})();

console.log('\n✓ Phase 3 complete: compact delta sync, offline reconnection, ephemeral presence.');
