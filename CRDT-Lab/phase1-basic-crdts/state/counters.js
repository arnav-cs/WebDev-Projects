'use strict';

// State-based counters.
//
// G-Counter: grow-only. Each replica owns one component and only ever increments
// its own. The merge is the pointwise maximum — which is a join (least upper
// bound) on the lattice of per-replica vectors, hence commutative, associative,
// and idempotent for free. The value is the sum of components.

class GCounter {
  constructor(id, counts = {}) {
    this.id = id;
    this.counts = { ...counts };
  }
  inc(by = 1) {
    if (by < 0) throw new Error('G-Counter cannot decrement');
    this.counts[this.id] = (this.counts[this.id] || 0) + by;
    return this;
  }
  merge(other) {
    for (const [k, v] of Object.entries(other.counts)) {
      this.counts[k] = Math.max(this.counts[k] || 0, v);
    }
    return this;
  }
  clone() {
    return new GCounter(this.id, this.counts);
  }
  value() {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }
}

// PN-Counter: supports decrement by keeping two G-Counters, P (increments) and
// N (decrements). value = sum(P) - sum(N). You cannot subtract in a single
// grow-only counter (max isn't invertible), so you split the concern — a
// recurring CRDT move: build a harder structure from monotone parts.

class PNCounter {
  constructor(id, p = {}, n = {}) {
    this.id = id;
    this.p = new GCounter(id, p);
    this.n = new GCounter(id, n);
  }
  inc(by = 1) {
    this.p.inc(by);
    return this;
  }
  dec(by = 1) {
    this.n.inc(by);
    return this;
  }
  merge(other) {
    this.p.merge(other.p);
    this.n.merge(other.n);
    return this;
  }
  clone() {
    return new PNCounter(this.id, this.p.counts, this.n.counts);
  }
  value() {
    return this.p.value() - this.n.value();
  }
}

module.exports = { GCounter, PNCounter };
