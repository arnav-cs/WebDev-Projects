'use strict';

// A tiny seeded PRNG (mulberry32). We deliberately do NOT use Math.random:
// every scenario in this lab must be reproducible so that when the convergence
// harness surfaces a bug, we can replay the exact seed that caused it. A
// non-deterministic fuzzer that finds a bug it can't reproduce is nearly
// useless.

function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    // float in [0, 1)
    next,
    // integer in [0, n)
    int: (n) => Math.floor(next() * n),
    // pick and remove a random element from arr (mutates arr)
    takeRandom: (arr) => arr.splice(Math.floor(next() * arr.length), 1)[0],
    // true with probability p
    chance: (p) => next() < p,
  };
}

module.exports = { makeRng };
