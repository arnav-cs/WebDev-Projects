'use strict';

// RGA — Replicated Growable Array. A sequence CRDT for text.
//
// The core problem (Phase 2's reason for existing): you cannot address a
// character by its array index, because a concurrent insert elsewhere shifts
// every index after it and two replicas would disagree. RGA gives every
// character a STABLE, GLOBALLY-UNIQUE identifier, and expresses every insert as
// "insert this new id immediately after that existing id." Position becomes
// intrinsic to the character, not its offset.
//
// Identifiers are Lamport timestamps: id = { c, r } where c is a logical counter
// and r is the replica id (tiebreak). The counter advances past every id this
// replica has seen, so a causally-later insert always gets a strictly greater
// id. Concurrent inserts after the same reference are ordered by id DESCENDING —
// a deterministic rule every replica computes identically, which is what makes
// them converge.
//
// You cannot truly delete: removing a node would strand any character inserted
// after it. So delete only sets a TOMBSTONE flag; the node stays as an ordering
// anchor. Reclaiming tombstones safely is the Phase 4 garbage-collection problem.
//
// Delivery robustness: an insert references an id that may not have arrived yet
// (the network reordered things). Rather than assume causal delivery, this
// implementation BUFFERS any op whose dependency is missing and re-drains after
// each successful apply — so it converges under arbitrary reorder and
// duplication, exactly like the Phase 0 causal-delivery replica.

function compareId(a, b) {
  if (a.c !== b.c) return a.c - b.c;
  if (a.r < b.r) return -1;
  if (a.r > b.r) return 1;
  return 0;
}
const keyOf = (id) => `${id.c}:${id.r}`;

class RGA {
  constructor(id) {
    this.id = id;
    this.clock = 0;
    this.nodes = []; // ordered array of { id, value, deleted }
    this.byKey = new Map(); // idKey -> node
    this.applied = new Set(); // op ids applied (dedup / idempotence)
    this.pending = []; // ops buffered until their dependency exists
  }

  // ---- observable text -----------------------------------------------------
  visible() {
    return this.nodes.filter((n) => !n.deleted);
  }
  text() {
    return this.visible()
      .map((n) => n.value)
      .join('');
  }
  length() {
    return this.visible().length;
  }

  // ---- local mutations (return an op to broadcast) -------------------------
  // Insert `value` at visible position `index` (0..length). The new char is
  // anchored "after" the visible char at index-1 (or the start for index 0).
  insertAt(index, value) {
    const vis = this.visible();
    const afterId = index <= 0 ? null : vis[index - 1].id;
    const id = { c: ++this.clock, r: this.id };
    const op = { type: 'insert', id, value, afterId };
    this.apply(op);
    return op;
  }

  // Delete the visible char at `index`.
  deleteAt(index) {
    const vis = this.visible();
    if (index < 0 || index >= vis.length) return null;
    const op = { type: 'delete', id: vis[index].id };
    this.apply(op);
    return op;
  }

  // ---- op application ------------------------------------------------------
  apply(op) {
    const opId = op.type === 'insert' ? keyOf(op.id) : `del:${keyOf(op.id)}`;
    if (op.type === 'insert' && this.applied.has(opId)) return; // dedup inserts
    if (this._tryApply(op)) {
      if (op.type === 'insert') this.applied.add(opId);
      this._drainPending();
    } else {
      // Dependency missing — park it and retry later.
      if (!this.pending.some((p) => this._samePending(p, op))) this.pending.push(op);
    }
  }

  _samePending(a, b) {
    if (a.type !== b.type) return false;
    return a.type === 'insert' ? keyOf(a.id) === keyOf(b.id) : keyOf(a.id) === keyOf(b.id);
  }

  // Returns true if applied, false if its dependency is missing.
  _tryApply(op) {
    if (op.type === 'insert') {
      if (op.afterId && !this.byKey.has(keyOf(op.afterId))) return false; // wait for anchor
      this._integrateInsert(op);
      return true;
    }
    // delete
    const node = this.byKey.get(keyOf(op.id));
    if (!node) return false; // wait for the char to exist, then tombstone it
    node.deleted = true;
    return true;
  }

  _integrateInsert(op) {
    // Find the array slot right after the anchor.
    let pos;
    if (!op.afterId) {
      pos = 0;
    } else {
      const anchor = this.byKey.get(keyOf(op.afterId));
      pos = this.nodes.indexOf(anchor) + 1;
    }
    // Skip over concurrent inserts that outrank the newcomer (higher id first).
    // This descending-by-id rule is what every replica agrees on, giving a
    // single converged order for characters typed concurrently at one spot.
    while (pos < this.nodes.length && compareId(this.nodes[pos].id, op.id) > 0) {
      pos++;
    }
    const node = { id: op.id, value: op.value, deleted: false };
    this.nodes.splice(pos, 0, node);
    this.byKey.set(keyOf(op.id), node);
    if (op.id.c > this.clock) this.clock = op.id.c; // keep Lamport clock monotone
  }

  _drainPending() {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.pending.length; i++) {
        const op = this.pending[i];
        const already = op.type === 'insert' && this.applied.has(keyOf(op.id));
        if (already) {
          this.pending.splice(i, 1);
          progress = true;
          break;
        }
        if (this._tryApply(op)) {
          if (op.type === 'insert') this.applied.add(keyOf(op.id));
          this.pending.splice(i, 1);
          progress = true;
          break;
        }
      }
    }
  }
}

// Dual-mode: usable via require() in Node and as a plain <script> in the browser
// (RGA becomes a script-scope binding the client can reference). Keeping one
// source of truth avoids the Node tests and the browser demo drifting apart.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RGA, compareId, keyOf };
}
