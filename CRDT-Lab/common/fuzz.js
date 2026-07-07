'use strict';

// The reusable convergence-fuzzing harness — the single most valuable artifact
// of Phase 1, reused by every CRDT built afterwards. It tests Strong Eventual
// Consistency directly: replicas that have observed the same set of updates
// must reach byte-identical state, regardless of the order, delay, or
// duplication with which they observed them.

const { makeRng } = require('./rng');

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Deep structural equality via canonical JSON. CRDT `.value()` returns plain
// data (numbers, arrays, sorted for sets), so this is sufficient and readable.
function canon(x) {
  return JSON.stringify(x, (_k, v) => {
    if (v instanceof Set) return { __set: [...v].sort() };
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

function equalValues(a, b) {
  return canon(a) === canon(b);
}

// ---------------------------------------------------------------------------
// State-based (CvRDT) convergence fuzzer.
//
//   factory(id)  -> a fresh replica exposing:
//                     .merge(other)  (in place; join / least-upper-bound)
//                     .clone()       (deep copy, for property checks)
//                     .value()       (plain-data observable state)
//   ops          -> [{ name, apply(replica, rng) }]
//
// Procedure: give each replica a random local history, gossip random pairwise
// merges throughout, then run a full all-to-all merge round and assert every
// replica converges to the same value. Also checks that the merge is idempotent
// on the final state.
// ---------------------------------------------------------------------------
function fuzzStateBased({ factory, ops, replicaCount = 4, opsPerReplica = 25, seed }) {
  const rng = makeRng(seed);
  const ids = Array.from({ length: replicaCount }, (_, i) => String.fromCharCode(65 + i));
  const replicas = ids.map((id) => factory(id));

  const totalOps = replicaCount * opsPerReplica;
  for (let step = 0; step < totalOps; step++) {
    const r = rng.pick(replicas);
    rng.pick(ops).apply(r, rng);
    // Interleave gossip: occasionally merge a random directed pair.
    if (rng.chance(0.5)) {
      const a = rng.pick(replicas);
      const b = rng.pick(replicas);
      if (a !== b) a.merge(b);
    }
  }

  // Full convergence round: everyone merges everyone (order randomized).
  for (let round = 0; round < 2; round++) {
    for (const a of rng.shuffle([...replicas])) {
      for (const b of rng.shuffle([...replicas])) {
        if (a !== b) a.merge(b);
      }
    }
  }

  const reference = replicas[0].value();
  for (const r of replicas) {
    assert(
      equalValues(r.value(), reference),
      `SEC violated (seed ${seed}): ${r.id}=${canon(r.value())} != ${canon(reference)}`
    );
  }

  // Idempotence on the converged state: merging a copy of self changes nothing.
  const before = canon(replicas[0].value());
  replicas[0].merge(replicas[0].clone());
  assert(canon(replicas[0].value()) === before, `merge not idempotent (seed ${seed})`);

  return replicas;
}

// Directly assert the three algebraic laws a state-based merge must satisfy,
// on concrete instances. This is the "you understand it when you can state the
// three properties" gate, mechanized.
function checkMergeAlgebra({ factory, ops, seed }) {
  const rng = makeRng(seed);
  const build = (id, n) => {
    const r = factory(id);
    for (let i = 0; i < n; i++) rng.pick(ops).apply(r, rng);
    return r;
  };
  const a = build('A', 6);
  const b = build('B', 6);
  const c = build('C', 6);

  // Commutativity: merge(a,b) == merge(b,a)
  const ab = a.clone().merge(b.clone());
  const ba = b.clone().merge(a.clone());
  assert(equalValues(ab.value(), ba.value()), `merge not commutative (seed ${seed})`);

  // Associativity: (a·b)·c == a·(b·c)
  const left = a.clone().merge(b.clone()).merge(c.clone());
  const right = a.clone().merge(b.clone().merge(c.clone()));
  assert(equalValues(left.value(), right.value()), `merge not associative (seed ${seed})`);

  // Idempotence: a·a == a
  const aa = a.clone().merge(a.clone());
  assert(equalValues(aa.value(), a.value()), `merge not idempotent (seed ${seed})`);
}

// ---------------------------------------------------------------------------
// Op-based (CmRDT) convergence fuzzer.
//
//   factory(id)  -> replica exposing .apply(op) and .value(); local mutators
//                   that RETURN an op to broadcast are provided via `ops`.
//   ops          -> [{ name, gen(replica, rng) -> op | null }]
//   causal       -> if true, ops are delivered respecting the order they were
//                   generated per origin (op-based OR-Set needs add-before-remove).
//
// We generate ops on random replicas, collecting (origin, seq, op), then
// deliver every op to every OTHER replica in a randomized order (optionally
// constrained to per-origin causal order), with duplicates. Assert convergence.
// ---------------------------------------------------------------------------
function fuzzOpBased({ factory, ops, replicaCount = 4, opsTotal = 80, causal = false, seed }) {
  const rng = makeRng(seed);
  const ids = Array.from({ length: replicaCount }, (_, i) => String.fromCharCode(65 + i));
  const replicas = ids.map((id) => factory(id));
  const byId = Object.fromEntries(replicas.map((r) => [r.id, r]));

  // Generate ops locally (the generator both mutates the origin and returns the
  // op others must apply).
  const outbox = []; // { origin, seq, op }
  const seqByOrigin = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let i = 0; i < opsTotal; i++) {
    const r = rng.pick(replicas);
    const op = rng.pick(ops).gen(r, rng);
    if (!op) continue;
    outbox.push({ origin: r.id, seq: seqByOrigin[r.id]++, op });
  }

  // Build the delivery schedule: each op to each other replica, plus dups.
  for (const target of replicas) {
    const deliveries = [];
    for (const entry of outbox) {
      if (entry.origin === target.id) continue; // origin already applied locally
      deliveries.push(entry);
      if (rng.chance(0.2)) deliveries.push(entry); // duplicate
    }
    rng.shuffle(deliveries);

    if (causal) {
      // Stable-sort into per-origin order while keeping cross-origin interleave
      // random: repeatedly deliver the lowest un-delivered seq available.
      const delivered = Object.fromEntries(ids.map((id) => [id, new Set()]));
      const nextSeq = Object.fromEntries(ids.map((id) => [id, 0]));
      let remaining = deliveries.slice();
      let guard = remaining.length * 4 + 100;
      while (remaining.length && guard-- > 0) {
        const idx = remaining.findIndex((d) => d.seq <= nextSeq[d.origin] && !delivered[d.origin].has(d.seq));
        if (idx === -1) {
          // Only duplicates of already-delivered or not-yet-ready ops remain;
          // drop already-delivered dups, advance readiness otherwise.
          const dupIdx = remaining.findIndex((d) => delivered[d.origin].has(d.seq));
          if (dupIdx !== -1) {
            byId[target.id].apply(remaining[dupIdx].op); // idempotent replay
            remaining.splice(dupIdx, 1);
            continue;
          }
          break;
        }
        const d = remaining.splice(idx, 1)[0];
        byId[target.id].apply(d.op);
        if (!delivered[d.origin].has(d.seq)) {
          delivered[d.origin].add(d.seq);
          nextSeq[d.origin] = Math.max(nextSeq[d.origin], d.seq + 1);
        }
      }
    } else {
      for (const d of deliveries) byId[target.id].apply(d.op);
    }
  }

  const reference = replicas[0].value();
  for (const r of replicas) {
    assert(
      equalValues(r.value(), reference),
      `op-based SEC violated (seed ${seed}): ${r.id}=${canon(r.value())} != ${canon(reference)}`
    );
  }
  return replicas;
}

module.exports = {
  assert,
  canon,
  equalValues,
  fuzzStateBased,
  checkMergeAlgebra,
  fuzzOpBased,
};
