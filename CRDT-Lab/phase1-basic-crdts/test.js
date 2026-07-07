'use strict';

// Phase 1 convergence suite. Every CRDT is driven through the shared harness:
// hundreds of randomized concurrent histories, asserting Strong Eventual
// Consistency on each. State-based structures additionally have their merge
// algebra (commutative / associative / idempotent) checked directly.

const { fuzzStateBased, checkMergeAlgebra, fuzzOpBased, assert, canon } = require('../common/fuzz');
const { GCounter, PNCounter } = require('./state/counters');
const { GSet, TwoPSet, ORSet } = require('./state/sets');
const { LWWRegister } = require('./state/lww-register');
const { OpCounter } = require('./op/counter');
const { OpORSet } = require('./op/or-set');

const SEEDS = 300;
const VALUES = ['x', 'y', 'z', 'w']; // small element universe → forces real add/remove conflicts

function run(name, fn) {
  for (let seed = 1; seed <= SEEDS; seed++) fn(seed);
  console.log(`  ✓ ${name} — ${SEEDS} scenarios`);
}

// ---- State-based -----------------------------------------------------------
console.log('State-based (CvRDT) convergence + merge algebra:');

run('G-Counter', (seed) => {
  const cfg = { factory: (id) => new GCounter(id), ops: [{ name: 'inc', apply: (r) => r.inc(1) }], seed };
  fuzzStateBased(cfg);
  checkMergeAlgebra(cfg);
});

run('PN-Counter', (seed) => {
  const cfg = {
    factory: (id) => new PNCounter(id),
    ops: [
      { name: 'inc', apply: (r) => r.inc(1) },
      { name: 'dec', apply: (r) => r.dec(1) },
    ],
    seed,
  };
  fuzzStateBased(cfg);
  checkMergeAlgebra(cfg);
});

run('G-Set', (seed) => {
  const cfg = {
    factory: (id) => new GSet(id),
    ops: [{ name: 'add', apply: (r, rng) => r.add(rng.pick(VALUES)) }],
    seed,
  };
  fuzzStateBased(cfg);
  checkMergeAlgebra(cfg);
});

run('2P-Set', (seed) => {
  const cfg = {
    factory: (id) => new TwoPSet(id),
    ops: [
      { name: 'add', apply: (r, rng) => r.add(rng.pick(VALUES)) },
      { name: 'remove', apply: (r, rng) => r.remove(rng.pick(VALUES)) },
    ],
    seed,
  };
  fuzzStateBased(cfg);
  checkMergeAlgebra(cfg);
});

run('OR-Set', (seed) => {
  const cfg = {
    factory: (id) => new ORSet(id),
    ops: [
      { name: 'add', apply: (r, rng) => r.add(rng.pick(VALUES)) },
      { name: 'remove', apply: (r, rng) => r.remove(rng.pick(VALUES)) },
    ],
    seed,
  };
  fuzzStateBased(cfg);
  checkMergeAlgebra(cfg);
});

run('LWW-Register', (seed) => {
  const cfg = {
    factory: (id) => new LWWRegister(id),
    ops: [{ name: 'set', apply: (r, rng) => r.set(rng.pick(VALUES)) }],
    seed,
  };
  fuzzStateBased(cfg);
  checkMergeAlgebra(cfg);
});

// ---- Op-based --------------------------------------------------------------
console.log('\nOp-based (CmRDT) convergence:');

run('Op-Counter (exactly-once)', (seed) => {
  fuzzOpBased({
    factory: (id) => new OpCounter(id),
    ops: [
      { name: 'inc', gen: (r) => r.inc(1) },
      { name: 'dec', gen: (r) => r.dec(1) },
    ],
    seed,
  });
});

run('Op-OR-Set', (seed) => {
  fuzzOpBased({
    factory: (id) => new OpORSet(id),
    ops: [
      { name: 'add', gen: (r, rng) => r.add(rng.pick(VALUES)) },
      { name: 'remove', gen: (r, rng) => r.remove(rng.pick(VALUES)) },
    ],
    seed,
  });
});

// ---- Semantic checks the fuzzer alone wouldn't pin down ---------------------
console.log('\nSemantic gates:');

// OR-Set re-add after remove works; 2P-Set's does NOT — the flaw the OR-Set fixes.
(function orSetVs2PSet() {
  const or = new ORSet('A');
  or.add('x');
  or.remove('x');
  or.add('x');
  assert(or.has('x'), 'OR-Set must allow re-add after remove');

  const tp = new TwoPSet('A');
  tp.add('x');
  tp.remove('x');
  tp.add('x');
  assert(!tp.has('x'), '2P-Set is expected to (flaw) forbid re-add after remove');
  console.log('  ✓ OR-Set re-adds after remove; 2P-Set cannot (the flaw OR-Set fixes)');
})();

// OR-Set add-wins under concurrent add|remove.
(function addWins() {
  const a = new ORSet('A');
  const b = new ORSet('B');
  a.add('x'); // A adds
  b.merge(a); // B observes it
  b.remove('x'); // B removes what it observed
  a.add('x'); // A concurrently adds again (new token, unobserved by B's remove)
  a.merge(b);
  b.merge(a);
  assert(a.has('x') && b.has('x'), 'OR-Set concurrent add|remove must be add-wins');
  console.log('  ✓ OR-Set resolves concurrent add|remove as add-wins');
})();

// Op-based counter needs exactly-once: prove duplicates would diverge WITHOUT
// the dedup guard, and are handled WITH it.
(function exactlyOnce() {
  const withGuard = new OpCounter('A');
  const op = withGuard.inc(5);
  withGuard.apply(op); // duplicate replay
  withGuard.apply(op);
  assert(withGuard.value() === 5, 'op-counter dedup must make replays idempotent');

  // Simulate the un-guarded variant to show the failure it prevents.
  let naive = 0;
  const applyNaive = (o) => (naive += o.delta);
  applyNaive(op);
  applyNaive(op); // duplicate
  assert(naive === 10, 'sanity: without dedup a duplicate double-counts');
  console.log('  ✓ op-counter needs exactly-once delivery (dedup verified; naive double-counts)');
})();

console.log('\n✓ Phase 1 complete: all CRDTs satisfy SEC; state-based merges are a join.');
