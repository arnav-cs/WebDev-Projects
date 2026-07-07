'use strict';

// State-based sets, in order of increasing sophistication. Each fixes a flaw in
// the previous one — this progression is the whole point of building all of them.

// G-Set: grow-only set. Merge = union. Correct but you can never remove.
class GSet {
  constructor(id, elements = []) {
    this.id = id;
    this.elements = new Set(elements);
  }
  add(e) {
    this.elements.add(e);
    return this;
  }
  has(e) {
    return this.elements.has(e);
  }
  merge(other) {
    for (const e of other.elements) this.elements.add(e);
    return this;
  }
  clone() {
    return new GSet(this.id, [...this.elements]);
  }
  value() {
    return [...this.elements].sort();
  }
}

// 2P-Set: two grow-only sets, `added` and `removed` (tombstones). An element is
// present iff added and not removed. Merge = union both sides.
//
// THE FLAW (why we need OR-Set next): removal is permanent. Once x is in
// `removed`, re-adding it does nothing — x can never come back. "Remove wins,
// forever," which is rarely what a user means.
class TwoPSet {
  constructor(id, added = [], removed = []) {
    this.id = id;
    this.added = new Set(added);
    this.removed = new Set(removed);
  }
  add(e) {
    this.added.add(e);
    return this;
  }
  remove(e) {
    if (this.added.has(e)) this.removed.add(e);
    return this;
  }
  has(e) {
    return this.added.has(e) && !this.removed.has(e);
  }
  merge(other) {
    for (const e of other.added) this.added.add(e);
    for (const e of other.removed) this.removed.add(e);
    return this;
  }
  clone() {
    return new TwoPSet(this.id, [...this.added], [...this.removed]);
  }
  value() {
    return [...this.added].filter((e) => !this.removed.has(e)).sort();
  }
}

// OR-Set (Observed-Remove Set): the one that behaves intuitively.
//
// The insight: don't tag the ELEMENT as removed — tag each individual ADD with a
// unique token, and remove only the tokens you have actually observed. A fresh
// add mints a brand-new token that no prior remove could have named, so re-adding
// after removing works. Concurrent add-vs-remove resolves ADD-WINS: the
// concurrent add's token was never observed by the remove, so it survives.
//
// State: for each element, a set of live tokens `adds`, plus a global set of
// removed tokens `tombs`. Element present iff it has a token not in `tombs`.
// Merge = union of adds (per element) and union of tombs. Unique tokens make
// this a clean join.
class ORSet {
  constructor(id, adds = {}, tombs = []) {
    this.id = id;
    this.counter = 0;
    // element -> Set(token)
    this.adds = {};
    for (const [e, toks] of Object.entries(adds)) this.adds[e] = new Set(toks);
    this.tombs = new Set(tombs);
  }
  _freshToken() {
    return `${this.id}:${++this.counter}`;
  }
  add(e) {
    if (!this.adds[e]) this.adds[e] = new Set();
    this.adds[e].add(this._freshToken());
    return this;
  }
  remove(e) {
    // Observed-remove: tombstone exactly the tokens visible right now.
    if (this.adds[e]) for (const t of this.adds[e]) this.tombs.add(t);
    return this;
  }
  has(e) {
    const toks = this.adds[e];
    if (!toks) return false;
    for (const t of toks) if (!this.tombs.has(t)) return true;
    return false;
  }
  merge(other) {
    for (const [e, toks] of Object.entries(other.adds)) {
      if (!this.adds[e]) this.adds[e] = new Set();
      for (const t of toks) this.adds[e].add(t);
    }
    for (const t of other.tombs) this.tombs.add(t);
    return this;
  }
  clone() {
    const c = new ORSet(this.id);
    for (const [e, toks] of Object.entries(this.adds)) c.adds[e] = new Set(toks);
    c.tombs = new Set(this.tombs);
    c.counter = this.counter;
    return c;
  }
  value() {
    return Object.keys(this.adds)
      .filter((e) => this.has(e))
      .sort();
  }
}

module.exports = { GSet, TwoPSet, ORSet };
