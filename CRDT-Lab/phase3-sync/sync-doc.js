'use strict';

// Phase 3 wraps the Phase 2 RGA with an efficient SYNC PROTOCOL. The naive
// "broadcast every op forever" of the Phase 2 relay doesn't survive offline
// editing: a client that made 500 edits offline must not replay 500 messages,
// nor must a reconnecting peer re-send the entire history. The fix is a
// version vector (a.k.a. state vector): a compact map origin → count summarizing
// exactly what each side has seen, so a peer can compute and ship only the delta.
//
// Every operation is tagged with (origin, seq): the replica that generated it
// and a per-origin monotonically increasing sequence number. A version vector
// { A: 12, B: 4 } means "I have A's ops 1..12 and B's ops 1..4." To sync, you
// send your vector; the peer replies with every op whose seq exceeds what your
// vector claims. One round trip, delta-sized — independent of total history.
//
// The delta exchange runs over an ordered, reliable per-connection channel
// (a websocket / TCP), so per-origin ops arrive in order during a sync. The
// underlying RGA still tolerates arbitrary reorder for robustness, but the
// version vector stays a simple contiguous count because of that ordering.

// Dual-mode dependency: require() in Node, global (loaded via <script>) in
// browser. Named RGAClass, not RGA, to avoid colliding with the top-level
// `class RGA` binding that rga.js contributes to the shared browser realm.
const RGAClass =
  typeof require !== 'undefined' ? require('../phase2-sequence/rga').RGA : globalThis.RGA;

class SyncDoc {
  constructor(id) {
    this.id = id;
    this.rga = new RGAClass(id);
    this.selfSeq = 0;
    // oplog: origin -> array of wire ops, index (seq-1). The replicated history.
    this.oplog = {};
    // version vector: origin -> highest contiguous seq stored.
    this.vv = {};
  }

  _store(origin, seq, inner) {
    if (!this.oplog[origin]) this.oplog[origin] = [];
    if (this.oplog[origin][seq - 1]) return false; // already have it (dedup)
    this.oplog[origin][seq - 1] = { origin, seq, inner };
    // Advance the contiguous frontier.
    let v = this.vv[origin] || 0;
    while (this.oplog[origin][v]) v++;
    this.vv[origin] = v;
    return true;
  }

  // ---- local edits ---------------------------------------------------------
  insertAt(index, value) {
    const inner = this.rga.insertAt(index, value);
    const seq = ++this.selfSeq;
    this._store(this.id, seq, inner);
    return { origin: this.id, seq, inner };
  }
  deleteAt(index) {
    const inner = this.rga.deleteAt(index);
    if (!inner) return null;
    const seq = ++this.selfSeq;
    this._store(this.id, seq, inner);
    return { origin: this.id, seq, inner };
  }

  // ---- sync primitives -----------------------------------------------------
  stateVector() {
    return { ...this.vv };
  }

  // Everything I have that a peer (described by remoteVV) is missing.
  delta(remoteVV) {
    const out = [];
    for (const origin of Object.keys(this.oplog)) {
      const from = remoteVV[origin] || 0;
      const log = this.oplog[origin];
      for (let seq = from + 1; seq <= log.length; seq++) {
        if (log[seq - 1]) out.push(log[seq - 1]);
      }
    }
    return out;
  }

  // Apply a received delta (or a single relayed op). Returns count newly applied.
  integrate(wireOps) {
    let applied = 0;
    for (const w of wireOps) {
      if (this._store(w.origin, w.seq, w.inner)) {
        this.rga.apply(w.inner);
        applied++;
      }
    }
    return applied;
  }

  // ---- observable ----------------------------------------------------------
  text() {
    return this.rga.text();
  }
  length() {
    return this.rga.length();
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { SyncDoc };
