'use strict';

// The "prove it, don't observe it" harness for Phase 0.
//
// We run hundreds of randomized, lossy, reordering, duplicating scenarios and
// assert two properties on every single one:
//
//   1. CONVERGENCE  — every replica delivered exactly the same set of messages.
//                     (Liveness: nothing was lost for good; dedup worked.)
//   2. CAUSAL SAFETY — at no replica was a message delivered before a message
//                     that happens-before it. Formally: each replica's delivery
//                     order is a linear extension of the happens-before partial
//                     order. (The core guarantee of causal broadcast.)
//
// We ALSO assert that the scenarios actually exercised out-of-order buffering —
// otherwise a broken "deliver everything immediately" implementation would pass
// vacuously.

const { runScenario } = require('./simulator');
const { VectorClock } = require('./vector-clock');

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Property 1: all replicas delivered the identical set of message ids.
function checkConvergence(replicas) {
  const [first, ...rest] = replicas;
  const reference = first.deliveredIds;
  for (const r of rest) {
    assert(
      r.deliveredIds.size === reference.size,
      `convergence: ${r.id} delivered ${r.deliveredIds.size} msgs, ${first.id} delivered ${reference.size}`
    );
    for (const id of reference) {
      assert(r.deliveredIds.has(id), `convergence: ${r.id} is missing message ${id}`);
    }
  }
}

// Property 2: each replica's delivery order respects happens-before.
//
// For a replica, walk its delivery order and remember, for each message id, the
// index at which it was delivered. Then for every ordered pair (a, b) where
// a happens-before b (a.stamp < b.stamp), assert index(a) < index(b).
//
// Comparing every pair is O(n^2); n is small here (tens of messages), and
// correctness clarity beats cleverness in a learning harness.
function checkCausalSafety(replicas, stamps) {
  const ids = [...stamps.keys()];

  // Precompute the happens-before pairs once from the global stamp record.
  const hbPairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const sa = stamps.get(ids[i]);
      const sb = stamps.get(ids[j]);
      if (sa.compare(sb) === 'before') hbPairs.push([ids[i], ids[j]]);
    }
  }

  for (const r of replicas) {
    const position = new Map();
    r.deliveredOrder.forEach((id, idx) => position.set(id, idx));
    for (const [a, b] of hbPairs) {
      const pa = position.get(a);
      const pb = position.get(b);
      // Both must be present (convergence already guarantees that) and in order.
      assert(
        pa !== undefined && pb !== undefined && pa < pb,
        `causal safety violated at ${r.id}: ${a} (hb) ${b} but delivered at ${pa} then ${pb}`
      );
    }
  }
}

function main() {
  const SEEDS = 400;
  let bufferingSeen = 0;
  let totalMessages = 0;

  for (let seed = 1; seed <= SEEDS; seed++) {
    // Vary the shape of each scenario a little via the seed.
    const replicaCount = 3 + (seed % 4); // 3..6 replicas
    const opCount = 20 + (seed % 60); // 20..79 ops
    const { replicas, stamps, drained } = runScenario({
      seed,
      replicaCount,
      opCount,
      channelOpts: { dupProbability: 0.2, dropProbability: 0.15 },
    });

    assert(drained, `seed ${seed}: channel did not drain (possible liveness bug)`);
    try {
      checkConvergence(replicas);
      checkCausalSafety(replicas, stamps);
    } catch (err) {
      console.error(`\n✗ FAILED on seed ${seed} (${replicaCount} replicas, ${opCount} ops)`);
      throw err;
    }

    if (replicas.some((r) => r.everBufferedOutOfOrder)) bufferingSeen++;
    totalMessages += stamps.size;
  }

  // Guard against a vacuous pass: the reordering substrate must actually have
  // forced buffering in a meaningful fraction of runs.
  assert(
    bufferingSeen > SEEDS * 0.5,
    `harness too gentle: only ${bufferingSeen}/${SEEDS} scenarios exercised out-of-order buffering`
  );

  console.log(`✓ ${SEEDS} randomized scenarios passed`);
  console.log(`  • convergence: all replicas delivered identical message sets`);
  console.log(`  • causal safety: no message delivered before its causal predecessors`);
  console.log(`  • ${totalMessages} total messages across all runs`);
  console.log(`  • out-of-order buffering exercised in ${bufferingSeen}/${SEEDS} scenarios`);

  // A focused sanity check on the primitive itself: concurrency <=> incomparable.
  const a = new VectorClock({ A: 1, B: 0 });
  const b = new VectorClock({ A: 0, B: 1 });
  assert(a.isConcurrentWith(b), 'sanity: A:1 and B:1 should be concurrent');
  assert(new VectorClock({ A: 1 }).happensBefore(new VectorClock({ A: 1, B: 1 })), 'sanity: hb');
  console.log(`  • vector-clock compare() sanity checks passed`);
}

main();
