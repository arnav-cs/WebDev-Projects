'use strict';

// RGA convergence suite. This is the real test of Phase 2: generate concurrent
// insert/delete histories across N replicas, deliver every op to every replica
// in randomized order WITH duplicates, and assert all replicas converge to the
// identical text. RGA's internal buffering means we can deliver in any order —
// so this simultaneously tests convergence and reorder/dup tolerance.

const { makeRng } = require('../common/rng');
const { RGA } = require('./rga');

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

function runScenario(seed) {
  const rng = makeRng(seed);
  const replicaCount = 2 + (seed % 4); // 2..5
  const ids = Array.from({ length: replicaCount }, (_, i) => String.fromCharCode(65 + i));
  const replicas = ids.map((id) => new RGA(id));

  // Generate ops. Each op is produced against ONE replica's current local state
  // (so afterId anchors are real), then queued for delivery to the others.
  const outbox = []; // { origin, op }
  const opCount = 30 + (seed % 50);
  for (let i = 0; i < opCount; i++) {
    const r = rng.pick(replicas);
    const len = r.length();
    if (len === 0 || rng.chance(0.7)) {
      const op = r.insertAt(rng.int(len + 1), rng.pick(ALPHABET.split('')));
      outbox.push({ origin: r.id, op });
    } else {
      const op = r.deleteAt(rng.int(len));
      if (op) outbox.push({ origin: r.id, op });
    }
  }

  // Deliver to every non-origin replica in randomized order, with duplicates.
  for (const target of replicas) {
    const deliveries = [];
    for (const { origin, op } of outbox) {
      if (origin === target.id) continue;
      deliveries.push(op);
      if (rng.chance(0.25)) deliveries.push(op); // duplicate
    }
    rng.shuffle(deliveries);
    for (const op of deliveries) target.apply(op);
  }

  // Convergence: identical text everywhere, and no op left buffered.
  const reference = replicas[0].text();
  for (const r of replicas) {
    assert(r.pending.length === 0, `seed ${seed}: ${r.id} has ${r.pending.length} un-drained ops`);
    assert(
      r.text() === reference,
      `seed ${seed}: divergence\n  ${replicas[0].id}: ${JSON.stringify(reference)}\n  ${r.id}: ${JSON.stringify(r.text())}`
    );
  }
  return { replicaCount, reference };
}

function main() {
  const SEEDS = 500;
  let totalChars = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { reference } = runScenario(seed);
    totalChars += reference.length;
  }
  console.log(`✓ RGA converged in ${SEEDS}/${SEEDS} randomized concurrent scenarios`);
  console.log(`  • delivery was reordered + duplicated; every replica reached identical text`);
  console.log(`  • no ops left buffered (all causal dependencies eventually satisfied)`);
  console.log(`  • ${totalChars} converged characters across all runs`);

  // Focused determinism check: concurrent inserts at the same spot resolve to a
  // single order regardless of which replica integrates first.
  const a = new RGA('A');
  const b = new RGA('B');
  const opA = a.insertAt(0, 'a'); // A types 'a' at start
  const opB = b.insertAt(0, 'b'); // B concurrently types 'b' at start
  a.apply(opB);
  b.apply(opA);
  assert(a.text() === b.text(), 'concurrent same-position inserts must converge');
  console.log(`  • concurrent same-position inserts converge to "${a.text()}" on both replicas`);
}

main();
