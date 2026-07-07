'use strict';

// Phase 4 · Problem 1 — TOMBSTONE GARBAGE COLLECTION.
//
// Deleted characters can't be unlinked from an RGA (they anchor concurrent
// inserts), so they linger as tombstones and the document grows without bound.
// The question the roadmap poses: when is it SAFE to actually reclaim one?
//
// The answer hinges on the CAUSAL FRONTIER: the "meet" (pointwise minimum) of
// every replica's version vector. An op at (origin, seq) is *causally stable*
// when seq ≤ frontier[origin] — i.e. EVERY replica has it. Nothing before the
// frontier can ever be contradicted or referenced by a new concurrent op,
// because there are no more concurrent ops down there to arrive.
//
// We reclaim in two tiers, of increasing aggressiveness and increasing
// preconditions — this mirrors what production systems actually do, and is
// honest about which part is genuinely hard.
//
//   TIER 1 · Content GC (safe under live concurrency).
//     For any tombstone whose DELETE is causally stable, drop its payload but
//     KEEP a minimal id-only anchor. This reclaims the dominant cost (character
//     content and, later, rich-text metadata) and can NEVER dangle, because the
//     anchor every concurrent insert might reference is still there. This is
//     essentially what Yjs does with deleted items.
//
//   TIER 2 · Structural compaction (safe only at QUIESCENCE).
//     Physically remove stable tombstone anchors entirely. This is the part the
//     papers wave at: it is unsafe while edits are in flight, because a
//     concurrent insert M anchored at a tombstone N can be stable-delete'd-N yet
//     itself not-yet-stable, still propagating to a replica that already dropped
//     N → M dangles forever. So we only compact when the frontier has caught up
//     to the present (minVV == maxVV: no in-flight ops). Real systems do this
//     only partially/opportunistically; we implement the provably-safe case and
//     document the boundary rather than pretend it away.
//
//   TIER 3 · Oplog compaction + snapshot.
//     Once an op is causally stable, no delta will ever need it (every replica
//     already has it), so it can leave the oplog — provided new joiners can
//     still catch up via a SNAPSHOT. See snapshot.js.

// Pointwise minimum of a set of version vectors = the causal frontier. An origin
// absent from ANY replica's vector contributes 0 (that replica has none of it).
function meetVV(vectors) {
  const origins = new Set();
  for (const vv of vectors) for (const o of Object.keys(vv)) origins.add(o);
  const out = {};
  for (const o of origins) {
    let min = Infinity;
    for (const vv of vectors) min = Math.min(min, vv[o] || 0);
    out[o] = min === Infinity ? 0 : min;
  }
  return out;
}

const isStable = (meta, frontier) => !!meta && meta.seq <= (frontier[meta.origin] || 0);

// True when the frontier equals the document's own full knowledge for every
// origin — no operation is still in flight anywhere. The precondition for safe
// structural compaction.
function isQuiescent(doc, frontier) {
  for (const origin of Object.keys(doc.vv)) {
    if ((frontier[origin] || 0) < doc.vv[origin]) return false;
  }
  return true;
}

// TIER 1: reclaim payloads of stably-deleted tombstones. Returns count reclaimed.
function contentGC(doc, frontier) {
  let reclaimed = 0;
  for (const node of doc.rga.nodes) {
    if (!node.deleted || node.compacted) continue;
    const meta = doc.deleteMeta[`${node.id.c}:${node.id.r}`];
    if (isStable(meta, frontier)) {
      node.value = null; // drop the character; keep the id anchor
      node.compacted = true;
      reclaimed++;
    }
  }
  return reclaimed;
}

// TIER 2: physically remove stable tombstone anchors. Only runs when quiescent.
// Returns { removed, skipped: reason } .
function structuralCompact(doc, frontier) {
  if (!isQuiescent(doc, frontier)) {
    return { removed: 0, skipped: 'not causally quiescent — ops still in flight' };
  }
  let removed = 0;
  const kept = [];
  for (const node of doc.rga.nodes) {
    const key = `${node.id.c}:${node.id.r}`;
    const insertStable = isStable(doc.insertMeta[key], frontier);
    const deleteStable = node.deleted && isStable(doc.deleteMeta[key], frontier);
    if (node.deleted && insertStable && deleteStable) {
      doc.rga.byKey.delete(key);
      removed++;
    } else {
      kept.push(node);
    }
  }
  doc.rga.nodes = kept;
  return { removed, skipped: null };
}

// TIER 3: drop causally-stable ops from the oplog (they'll never be needed for a
// delta). Keeps the version vector intact. Returns count dropped.
function compactOplog(doc, frontier) {
  let dropped = 0;
  for (const origin of Object.keys(doc.oplog)) {
    const stableUpto = frontier[origin] || 0;
    const log = doc.oplog[origin];
    for (let seq = 1; seq <= stableUpto; seq++) {
      if (log[seq - 1]) {
        log[seq - 1] = null; // stable → no peer will ever request it
        dropped++;
      }
    }
  }
  return dropped;
}

module.exports = { meetVV, isStable, isQuiescent, contentGC, structuralCompact, compactOplog };
