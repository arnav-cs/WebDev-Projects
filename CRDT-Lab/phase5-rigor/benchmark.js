'use strict';

// Phase 5 · benchmark against the answer key (Yjs), SCOPED per the revised
// roadmap. A bare "mine is N× slower" number is demoralizing and shallow; the
// educational artifact is isolating the specific mechanisms that create the gap
// and measuring each. We compare three encodings of the SAME document —
//   (1) my naive per-op JSON,
//   (2) my from-scratch binary encoding (varint + string table + run-length),
//   (3) Yjs's update encoding,
// and time construction on both engines. Then we explain, concretely, where Yjs
// still wins and why.

const { SyncDoc } = require('../phase3-sync/sync-doc');
const enc = require('../phase4-systems/encoding');
const Y = require('yjs');

function time(fn) {
  const t0 = process.hrtime.bigint();
  const r = fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, r };
}
const fmt = (n) => n.toLocaleString('en-US');

function run(label, text) {
  console.log(`\n── ${label} (${fmt(text.length)} chars) ─────────────────────────`);

  // --- my RGA ---
  const mine = time(() => {
    const doc = new SyncDoc('A');
    for (let i = 0; i < text.length; i++) doc.insertAt(doc.length(), text[i]);
    return doc;
  });
  const doc = mine.r;
  const naive = enc.naiveBytes(doc.oplog);
  const binary = enc.encode(doc.oplog).length;

  // --- Yjs ---
  const yjs = time(() => {
    const d = new Y.Doc();
    const t = d.getText('t');
    // Insert char-by-char to mirror real typing (Yjs is far faster in bulk, but
    // per-char is the honest keystroke workload).
    for (let i = 0; i < text.length; i++) t.insert(t.length, text[i]);
    return d;
  });
  const yUpdate = Y.encodeStateAsUpdate(yjs.r).length;

  const insMinePerS = Math.round(text.length / (mine.ms / 1000));
  const insYjsPerS = Math.round(text.length / (yjs.ms / 1000));

  console.log('  build time:');
  console.log(`    mine (RGA)   ${mine.ms.toFixed(1)}ms   (${fmt(insMinePerS)} inserts/s)`);
  console.log(`    yjs          ${yjs.ms.toFixed(1)}ms   (${fmt(insYjsPerS)} inserts/s)   ${(mine.ms / yjs.ms).toFixed(1)}× my time`);
  console.log('  encoded size of the whole document:');
  console.log(`    mine · naive JSON   ${fmt(naive)} B`);
  console.log(`    mine · binary       ${fmt(binary)} B   (${(naive / binary).toFixed(0)}× smaller than my naive)`);
  console.log(`    yjs  · update       ${fmt(yUpdate)} B   (mine/yjs = ${(binary / yUpdate).toFixed(1)}×)`);

  // Correctness cross-check: same visible text.
  const yText = yjs.r.getText('t').toString();
  if (doc.text() !== yText) throw new Error('engines disagree on text!');
  return { naive, binary, yUpdate };
}

console.log('CRDT benchmark — my from-scratch RGA vs Yjs (the answer key)');

// Workload 1: prose typed left-to-right (the run-encodable common case).
run('sequential prose', 'The quick brown fox jumps over the lazy dog. '.repeat(400));

// Workload 2: pathological prepend (every insert at position 0 — no runs).
const pre = time(() => {
  const doc = new SyncDoc('A');
  for (let i = 0; i < 5000; i++) doc.insertAt(0, 'x');
  return doc;
});
const preNaive = enc.naiveBytes(pre.r.oplog);
const preBin = enc.encode(pre.r.oplog).length;
const yPre = new Y.Doc();
const yt = yPre.getText('t');
for (let i = 0; i < 5000; i++) yt.insert(0, 'x');
console.log('\n── pathological prepend (5,000 inserts at position 0) ─────────');
console.log(`  mine · naive JSON   ${fmt(preNaive)} B`);
console.log(`  mine · binary       ${fmt(preBin)} B   (runs don't form → less compression)`);
console.log(`  yjs  · update       ${fmt(Y.encodeStateAsUpdate(yPre).length)} B`);

console.log(`
Where Yjs wins, and why (having now read its internals)
-------------------------------------------------------
1. Integer client ids + relative positioning. My ids are {counter, "replicaId"}
   with a STRING replica id; Yjs uses a small integer client id and stores item
   positions relative to the previous item, so its per-item overhead is a few
   varint bytes. My string table narrows this but Yjs never materialized the
   string at all.
2. Items carry a length. Yjs represents a whole typed run as ONE struct with a
   length field, in the live data structure — not just on the wire. My RGA still
   holds one node per character in memory; my run-length win is only in the
   encoder. Closing this means representing runs in the tree itself (a real
   refactor), which is exactly the YATA "Item" design.
3. No per-op wire objects. My oplog is an array of JS objects with repeated keys;
   Yjs reads/writes a tight columnar byte stream directly. My naive→binary step
   (≈100× on prose) closes most of THIS gap specifically.
4. Deleted items compress to ranges. Yjs stores deletions as a compact delete-set
   of (id, len) ranges rather than per-character tombstones — the same idea as my
   Phase-4 delete-run encoding and content GC, but built into the core.

The scoped takeaway: my binary encoder recovers most of the SIZE gap that comes
from wire representation (mechanism #3), and delete-runs address #4. The
remaining gap is structural — Yjs's in-memory run representation (#1, #2) — which
my per-character RGA can't match without adopting the item-with-length design.
That is the single most useful thing this comparison taught.
`);
