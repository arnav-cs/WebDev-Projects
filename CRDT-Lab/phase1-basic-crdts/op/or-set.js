'use strict';

// Op-based (CmRDT) OR-Set.
//
// An add mints a globally-unique token and broadcasts (element, token). A remove
// broadcasts the exact tokens it has OBSERVED for the element. Application folds
// tokens into grow-only sets: `adds` (element -> tokens) and `tombs` (removed
// tokens). Element present iff it owns a token not in `tombs`.
//
// A note on the classic "op-based needs causal delivery" claim: because removes
// carry their tokens and application is into grow-only sets, this formulation is
// actually commutative AND idempotent — a remove that arrives before its add
// simply tombstones a token that the later add then re-inserts-but-masked, so
// the final state (add+remove present) is "absent" either way. So it tolerates
// reorder and duplication. Causal delivery buys you *intermediate* sanity (never
// showing a remove of something not yet added), not eventual convergence.

class OpORSet {
  constructor(id) {
    this.id = id;
    this.counter = 0;
    this.adds = {}; // element -> Set(token)
    this.tombs = new Set(); // removed tokens
  }

  add(e) {
    const token = `${this.id}:${++this.counter}`;
    const op = { type: 'add', e, token };
    this.apply(op);
    return op;
  }

  remove(e) {
    const live = this.adds[e] ? [...this.adds[e]].filter((t) => !this.tombs.has(t)) : [];
    const op = { type: 'remove', e, tokens: live };
    this.apply(op);
    return op;
  }

  apply(op) {
    if (op.type === 'add') {
      if (!this.adds[op.e]) this.adds[op.e] = new Set();
      this.adds[op.e].add(op.token);
    } else {
      for (const t of op.tokens) this.tombs.add(t);
    }
  }

  has(e) {
    const toks = this.adds[e];
    if (!toks) return false;
    for (const t of toks) if (!this.tombs.has(t)) return true;
    return false;
  }

  value() {
    return Object.keys(this.adds)
      .filter((e) => this.has(e))
      .sort();
  }
}

module.exports = { OpORSet };
