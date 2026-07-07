'use strict';

// Seeded PRNG (mulberry32) shared across the lab. Reproducibility is
// non-negotiable: a fuzzer that finds a convergence bug it can't replay is
// almost useless. Every scenario is a pure function of its seed.

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
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    takeRandom: (arr) => arr.splice(Math.floor(next() * arr.length), 1)[0],
    chance: (p) => next() < p,
    shuffle: (arr) => {
      // Fisher–Yates in place.
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

module.exports = { makeRng };
