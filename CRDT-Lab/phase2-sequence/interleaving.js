'use strict';

// Reproducing the INTERLEAVING ANOMALY in our RGA — the roadmap's "you
// understand it when you can reproduce an interleaving anomaly and explain what
// Fugue does about it."
//
// The anomaly: two users each type a contiguous word at the same location,
// concurrently. A correct-but-unsatisfying merge would put one whole word before
// the other ("abcXYZ" or "XYZabc"). An INTERLEAVED merge shuffles their
// characters together into gibberish ("ZcYbXa"). Both are "convergent" (all
// replicas agree), so SEC does NOT rule interleaving out — it's a semantic
// quality problem the convergence tests can't catch.

const { RGA } = require('./rga');

function typeWord(word, insertPosFn) {
  const r = new RGA(insertPosFn.replicaId);
  const ops = [];
  for (const ch of word) ops.push(r.insertAt(insertPosFn(r), ch));
  return { r, ops };
}

function mergeScenario(title, wordA, wordB, positionFn) {
  const A = typeWord(wordA, Object.assign((r) => positionFn(r), { replicaId: 'A' }));
  const B = typeWord(wordB, Object.assign((r) => positionFn(r), { replicaId: 'B' }));
  // Cross-apply each other's ops.
  A.ops.forEach((o) => B.r.apply(o));
  B.ops.forEach((o) => A.r.apply(o));
  const converged = A.r.text() === B.r.text();
  const result = A.r.text();
  const interleaved = !(result === wordA + wordB || result === wordB + wordA);
  console.log(
    `  ${title.padEnd(22)} A="${wordA}" B="${wordB}" → "${result}"  ` +
      `${converged ? 'converged' : 'DIVERGED'}  ${interleaved ? '⚠ INTERLEAVED' : 'clean (block order)'}`
  );
  return { result, interleaved, converged };
}

console.log('RGA interleaving behavior by typing direction:\n');

// Forward typing (append): each next char after the previous → RGA keeps each
// user's run contiguous. No anomaly.
mergeScenario('forward / append', 'abc', 'XYZ', (r) => r.length());

// Prepend typing (always insert at position 0): this is where RGA interleaves.
const bad = mergeScenario('backward / prepend', 'abc', 'XYZ', () => 0);

// Insert in the middle: also interleaves.
mergeScenario('middle insert', 'abc', 'XYZ', (r) => Math.min(1, r.length()));

console.log(`
Why it happens
--------------
Each character is anchored "after" the previous one the user typed. When both
users PREPEND, every character is anchored at the very start, so all six
characters become siblings competing for the same anchor. RGA orders siblings by
id descending — and because the two users' logical clocks advance in lockstep as
they type, their ids alternate. Alternating ids ⇒ alternating characters ⇒
"${bad.result}". The runs get shredded together even though each user typed a
single contiguous word.

Note this passed every convergence test: all replicas AGREE on "${bad.result}".
Interleaving is not a convergence bug — it's a semantic-quality bug that Strong
Eventual Consistency does not forbid. That's precisely why it went unnoticed in
production CRDTs for years.

What Fugue does about it
------------------------
Fugue (Weidner & Kleppmann, "The Art of the Fugue") reframes the structure as a
tree where each character records BOTH a left and a right origin, and inserts
choose a side. The guarantee it targets is "maximal non-interleaving": a run of
characters typed contiguously by one user stays contiguous after merging with a
concurrent run, so you get "abcXYZ" or "XYZabc" — never "${bad.result}". The key
idea is that a new character attaches to the *closest* existing character on the
side it was typed, rather than all competing at one shared anchor, so a user's
own run forms an unbroken chain that concurrent runs can only sit beside, not
weave through. YATA (Yjs) uses a related left/right-origin rule for the common
cases; Fugue proves the non-interleaving property in general.
`);

// Make this runnable as an assertion too: the anomaly must actually reproduce,
// otherwise the demo is lying.
if (!bad.interleaved) {
  console.error('EXPECTED interleaving anomaly did not reproduce');
  process.exit(1);
}
console.log('✓ interleaving anomaly reproduced (and explained).');
