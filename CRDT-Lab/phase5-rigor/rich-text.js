'use strict';

// Phase 5 · rich text (the Peritext problem) — a STRETCH, per the roadmap. The
// deliverable is a working-but-limited attempt plus an honest writeup of where
// it gets hard, not a production rich-text CRDT.
//
// Plaintext order is solved (RGA). Formatting adds a second CRDT layered on top:
// a set of MARKS, each a (type, value, start, end) span whose boundaries are
// anchored to CHARACTER IDS — not offsets — so a mark keeps covering the same
// text as the document is edited concurrently. Marks form a grow-only set (each
// has a unique id), so the set converges by union; the effective formatting of
// a character is then a deterministic function of that set, which keeps SEC.
//
// The two genuinely hard sub-problems, surfaced by the demos below:
//   (A) Boundary expansion. When a character is inserted at a mark's edge, is it
//       inside the mark or outside? Peritext answers this with per-boundary
//       "expand" rules (bold expands after its end; a link does not). We pick a
//       fixed rule and SHOW a case where the other rule would be wanted.
//   (B) Overlap resolution. Concurrent bold and un-bold over the same range must
//       resolve identically everywhere. We use last-writer-wins per (type) via a
//       Lamport timestamp, and show it converging.

const { RGA } = require('../phase2-sequence/rga');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const keyOf = (id) => `${id.c}:${id.r}`;

// Total order on marks for last-writer-wins: (ts, replica, counter). The
// replica/counter tiebreak is essential — two replicas' Lamport timestamps can
// collide, and without a deterministic tiebreak LWW would diverge.
function markWins(a, b) {
  if (a.ts !== b.ts) return a.ts > b.ts;
  if (a.id.r !== b.id.r) return a.id.r > b.id.r;
  return a.id.c > b.id.c;
}

class RichDoc {
  constructor(id) {
    this.id = id;
    this.rga = new RGA(id);
    this.clock = 0;
    this.marks = new Map(); // markId -> mark (grow-only set → converges by union)
  }

  // ---- text ops delegate to RGA -------------------------------------------
  insertAt(index, ch) {
    return this.rga.insertAt(index, ch);
  }
  applyText(op) {
    this.rga.apply(op);
  }
  text() {
    return this.rga.text();
  }

  // ---- formatting ----------------------------------------------------------
  // Format visible range [start, end) with type=value. Anchors to the character
  // ids at those positions so the span tracks edits.
  format(start, end, type, value) {
    const vis = this.rga.visible();
    if (start >= end || start < 0 || end > vis.length) return null;
    const mark = {
      id: { c: ++this.clock, r: this.id },
      type,
      value,
      startId: vis[start].id, // inclusive
      endId: vis[end - 1].id, // inclusive
      ts: ++this.clock, // Lamport-ish for LWW overlap resolution
    };
    this.applyMark(mark);
    return mark;
  }
  applyMark(mark) {
    this.marks.set(keyOf(mark.id), mark);
    if (mark.ts > this.clock) this.clock = mark.ts;
  }

  // Effective value of `type` for the visible character at `index`. Among all
  // marks of that type whose [startId, endId] span covers the character (by
  // current document position), the highest-ts mark wins (LWW). Boundary rule:
  // end is INCLUSIVE and NON-EXPANDING — a character inserted strictly after
  // endId is NOT covered.
  formatAt(index, type) {
    const vis = this.rga.visible();
    const pos = new Map(vis.map((n, i) => [keyOf(n.id), i]));
    let best = null;
    for (const mark of this.marks.values()) {
      if (mark.type !== type) continue;
      const s = pos.get(keyOf(mark.startId));
      const e = pos.get(keyOf(mark.endId));
      if (s === undefined || e === undefined) continue; // anchor deleted
      if (index >= s && index <= e) {
        if (!best || markWins(mark, best)) best = mark;
      }
    }
    return best ? best.value : false;
  }

  // Render as a list of {char, bold} for inspection.
  spans(type = 'bold') {
    return this.rga.visible().map((n, i) => ({ char: n.value, on: this.formatAt(i, type) }));
  }
}

function render(doc) {
  return doc
    .spans('bold')
    .map((s) => (s.on ? `[${s.char}]` : s.char))
    .join('');
}

// Merge two RichDocs (union of text ops + union of marks), for the demos.
function mergeInto(target, source, textOps) {
  for (const op of textOps) target.applyText(op);
  for (const mark of source.marks.values()) target.applyMark(mark);
}

console.log('Rich text over RGA (Peritext-lite):\n');

// --- Demo 1: basic bold converges across replicas ---------------------------
(function basic() {
  const A = new RichDoc('A');
  const ops = [];
  for (const ch of 'hello world') ops.push(A.insertAt(A.text().length, ch));
  A.format(0, 5, 'bold', true); // bold "hello"

  const B = new RichDoc('B');
  mergeInto(B, A, ops);
  assert(render(A) === render(B), 'rich text must converge');
  console.log(`  ✓ basic bold converges: A="${render(A)}"  B="${render(B)}"`);
})();

// --- Demo 2: boundary expansion (hard sub-problem A) ------------------------
(function boundary() {
  const A = new RichDoc('A');
  const ops = [];
  for (const ch of 'abc') ops.push(A.insertAt(A.text().length, ch));
  A.format(0, 3, 'bold', true); // bold "abc"
  // Now type 'd' right after 'c' (at the end). Under our NON-EXPANDING rule it
  // is NOT bold. A user typing at the end of a bold word usually EXPECTS bold.
  A.insertAt(3, 'd');
  console.log(`  ⚠ boundary: bolded "abc" then typed 'd' at the end → "${render(A)}"`);
  console.log(`    our non-expanding end rule leaves 'd' unbold; Peritext's per-boundary`);
  console.log(`    "expand" flag is exactly what's needed to make 'd' inherit bold. (Documented.)`);
  assert(A.formatAt(3, 'bold') === false, 'non-expanding rule: d is not bold');
})();

// --- Demo 3: concurrent bold vs un-bold resolves by LWW (hard sub-problem B) -
(function overlap() {
  const base = new RichDoc('A');
  const ops = [];
  for (const ch of 'word') ops.push(base.insertAt(base.text().length, ch));

  const A = new RichDoc('A');
  mergeInto(A, base, ops);
  const B = new RichDoc('B');
  mergeInto(B, base, ops);

  const mBold = A.format(0, 4, 'bold', true); // A bolds
  const mUnbold = B.format(0, 4, 'bold', false); // B concurrently un-bolds
  // Cross-merge the marks.
  A.applyMark(mUnbold);
  B.applyMark(mBold);

  assert(render(A) === render(B), 'concurrent bold/un-bold must converge');
  const winner = markWins(mBold, mUnbold) ? 'bold' : 'un-bold';
  console.log(`  ✓ concurrent bold|un-bold converges to "${render(A)}" (LWW winner: ${winner})`);
})();

console.log(`
Honest difficulty writeup
-------------------------
- Convergence was the EASY part: marks as a grow-only set + a deterministic
  effective-format function inherit SEC from the same machinery as everything
  else. The plaintext RGA did the heavy lifting.
- Boundary expansion (A) is the real trap. "Is a character typed at a mark edge
  inside the mark?" has no single right answer — bold should expand, a hyperlink
  should not. A correct system needs per-boundary expand flags AND anchors that
  bind "before" vs "after" a character. Our fixed non-expanding rule is visibly
  wrong for the common "keep typing in bold" case.
- Overlap (B) needs a resolution policy. LWW is simple and converges but loses
  information; Peritext instead keeps all marks and defines a richer merge so
  that, e.g., a later un-bold of a sub-range composes correctly with an earlier
  bold rather than clobbering it.
- What we did NOT attempt: mark splitting/joining under partial-range edits,
  non-boolean attributes (colors, links with values), and rendering nested marks
  — each its own sub-project. This is why rich text is a phase of its own in
  production CRDTs, not a checkbox.
`);
console.log('✓ rich-text stretch attempted; hard parts reproduced and documented.');
