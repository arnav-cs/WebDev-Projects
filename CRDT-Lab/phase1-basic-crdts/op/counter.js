'use strict';

// Op-based (CmRDT) PN-Counter.
//
// The operations (+n, -n) commute, so delivery ORDER doesn't matter. But an
// increment op is NOT idempotent — applying it twice double-counts. So this
// structure demands EXACTLY-ONCE delivery. We model that honestly: every op
// carries a unique id and apply() deduplicates. This is the concrete meaning of
// the roadmap's note that "op-based needs exactly-once delivery while
// state-based tolerates anything" — remove the dedup and duplicates diverge it.

class OpCounter {
  constructor(id) {
    this.id = id;
    this.total = 0;
    this.seq = 0;
    this.applied = new Set(); // op ids already applied (exactly-once guard)
  }

  // Local mutators return the op to broadcast.
  inc(by = 1) {
    return this._localOp(by);
  }
  dec(by = 1) {
    return this._localOp(-by);
  }
  _localOp(delta) {
    const op = { id: `${this.id}#${++this.seq}`, delta };
    this.apply(op);
    return op;
  }

  apply(op) {
    if (this.applied.has(op.id)) return; // exactly-once: ignore replays
    this.applied.add(op.id);
    this.total += op.delta;
  }

  value() {
    return this.total;
  }
}

module.exports = { OpCounter };
