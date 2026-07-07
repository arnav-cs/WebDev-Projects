'use strict';

// Phase 4 · Problem 3 — SNAPSHOTTING & LAZY LOADING.
//
// Loading a document by replaying its whole history is O(history) AND pays the
// CRDT integration cost per op (the skip-scan, the buffering). A 100k-edit doc
// opens slowly. A snapshot is the already-materialized state — the current node
// array plus the version vector — so a fresh replica rebuilds the sequence by a
// direct O(live) array copy, no integration, and then only needs ops that
// arrived AFTER the snapshot's version vector.
//
// This is the natural partner of oplog compaction (gc.js): once stable ops are
// dropped from the oplog, a snapshot is how a new joiner still catches up.

const { SyncDoc } = require('../phase3-sync/sync-doc');

// Capture the materialized state. In a real system this would be binary-encoded
// (see encoding.js); we keep it as plain data here and measure separately.
function save(doc) {
  return {
    vv: { ...doc.vv },
    nodes: doc.rga.nodes.map((n) => ({ c: n.id.c, r: n.id.r, value: n.value, deleted: n.deleted })),
  };
}

// Rebuild a document from a snapshot WITHOUT re-integrating anything: the node
// order is already correct, so we just copy it into place. This is the fast path.
function load(id, snap) {
  const doc = new SyncDoc(id);
  const nodes = snap.nodes.map((n) => ({ id: { c: n.c, r: n.r }, value: n.value, deleted: n.deleted }));
  doc.rga.nodes = nodes;
  for (const n of nodes) {
    doc.rga.byKey.set(`${n.id.c}:${n.id.r}`, n);
    if (n.id.c > doc.rga.clock) doc.rga.clock = n.id.c;
  }
  doc.vv = { ...snap.vv };
  // Restore this replica's own sequence counter so continued local editing
  // doesn't reuse sequence numbers.
  doc.selfSeq = snap.vv[id] || 0;
  return doc;
}

module.exports = { save, load };
