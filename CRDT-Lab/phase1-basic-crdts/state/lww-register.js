'use strict';

// LWW-Register: a single register whose concurrent writes are resolved by a
// "last writer wins" rule. The subtlety is defining "last" without a global
// clock. We use a Lamport-style logical timestamp with the replica id as a
// deterministic tiebreak, so the total order (ts, id) is agreed by everyone —
// convergence does not depend on wall-clock skew.
//
// Merge keeps the entry with the greater (ts, id). Because that comparison is a
// total order, merge is commutative, associative, and idempotent.

class LWWRegister {
  constructor(id, entry = null, lamport = 0) {
    this.id = id;
    this.lamport = lamport; // highest timestamp ever observed here
    this.entry = entry; // { value, ts, id } | null
  }

  set(value) {
    this.lamport += 1;
    this.entry = { value, ts: this.lamport, id: this.id };
    return this;
  }

  static _wins(a, b) {
    // Is a strictly greater than b under (ts, id)? b may be null.
    if (!b) return true;
    if (!a) return false;
    if (a.ts !== b.ts) return a.ts > b.ts;
    return a.id > b.id;
  }

  merge(other) {
    this.lamport = Math.max(this.lamport, other.lamport);
    if (LWWRegister._wins(other.entry, this.entry)) {
      this.entry = other.entry ? { ...other.entry } : null;
    }
    return this;
  }

  clone() {
    return new LWWRegister(this.id, this.entry ? { ...this.entry } : null, this.lamport);
  }

  value() {
    return this.entry ? this.entry.value : null;
  }
}

module.exports = { LWWRegister };
