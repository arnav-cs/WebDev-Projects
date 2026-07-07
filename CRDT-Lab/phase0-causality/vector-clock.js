'use strict';

// A vector clock over a fixed, known set of replica ids.
//
// The whole point of Phase 0: a scalar (Lamport) clock can give you a *total*
// order, but it cannot tell you whether two events are causally related or
// genuinely concurrent. A vector clock can. Two events are concurrent exactly
// when their vector timestamps are incomparable (neither <= the other).
//
// We store the clock as a plain object { replicaId: count }. A missing entry is
// treated as 0, so replicas that have never been heard from cost nothing.

class VectorClock {
  constructor(entries = {}) {
    this.entries = { ...entries };
  }

  get(id) {
    return this.entries[id] || 0;
  }

  set(id, value) {
    this.entries[id] = value;
    return this;
  }

  // Advance this replica's own component by one. This is the "an event happened
  // here" operation.
  increment(id) {
    this.entries[id] = this.get(id) + 1;
    return this;
  }

  copy() {
    return new VectorClock(this.entries);
  }

  // Pointwise maximum. This is how a replica folds in what it learns from a
  // received message: "I now know at least as much as the sender did."
  merge(other) {
    const ids = new Set([...Object.keys(this.entries), ...Object.keys(other.entries)]);
    for (const id of ids) {
      this.entries[id] = Math.max(this.get(id), other.get(id));
    }
    return this;
  }

  // The relation that makes causality concrete.
  //   'equal'      — identical timestamps
  //   'before'     — this happens-before other (this <= other, and strictly < somewhere)
  //   'after'      — other happens-before this
  //   'concurrent' — incomparable: neither dominates. This is the interesting case.
  compare(other) {
    const ids = new Set([...Object.keys(this.entries), ...Object.keys(other.entries)]);
    let lessSomewhere = false;
    let greaterSomewhere = false;
    for (const id of ids) {
      const a = this.get(id);
      const b = other.get(id);
      if (a < b) lessSomewhere = true;
      if (a > b) greaterSomewhere = true;
    }
    if (lessSomewhere && greaterSomewhere) return 'concurrent';
    if (lessSomewhere) return 'before';
    if (greaterSomewhere) return 'after';
    return 'equal';
  }

  // Convenience: does this happen-before other? (Strict.)
  happensBefore(other) {
    return this.compare(other) === 'before';
  }

  isConcurrentWith(other) {
    return this.compare(other) === 'concurrent';
  }

  toString() {
    const ids = Object.keys(this.entries).sort();
    return '[' + ids.map((id) => `${id}:${this.entries[id]}`).join(' ') + ']';
  }
}

module.exports = { VectorClock };
