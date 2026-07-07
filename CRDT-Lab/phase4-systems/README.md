# Phase 4 — Systems-hard problems (pick two, go deep)

Per the revised roadmap, Phase 4 is a **menu**, not a checklist. This lab goes
deep on the two most central problems — **tombstone GC** and **binary encoding**
— and adds **snapshotting** because it falls out naturally from oplog compaction.

## 1. Tombstone garbage collection — `gc.js`

Deleted characters can't be unlinked (they anchor concurrent inserts), so they
accumulate. Safe reclamation hinges on the **causal frontier**: the pointwise
minimum (`meetVV`) of every replica's version vector. An op is *causally stable*
when it sits below the frontier — every replica has it, and nothing concurrent
to it can still arrive.

Three tiers, honest about which is hard:

- **Content GC** (safe under live concurrency): drop the payload of any
  stably-deleted tombstone, keep a minimal id anchor. Never dangles. This is
  the Yjs approach.
- **Structural compaction** (safe only at **quiescence**): physically remove
  stable tombstone anchors — but only when no ops are in flight, because a
  concurrent insert anchored at a stably-deleted node can itself be un-stable and
  still propagating. Removing the anchor early makes that insert **dangle
  forever**. `structuralCompact` refuses unless `isQuiescent`, and the test
  *demonstrates the dangling insert the guard prevents*. This is the genuinely
  hard part the papers wave at; production systems solve it only partially.
- **Oplog compaction**: stable ops can leave the oplog (no delta will need
  them), provided new joiners catch up via a snapshot.

## 2. Binary encoding — `encoding.js`

Naive per-op JSON is enormous. Built from scratch: LEB128 **varints**, an
interned **string table** for replica ids, and **run-length encoding** of typing
runs (contiguous inserts by one replica, each anchored on the previous — collapse
to `{replica, startSeq, startCounter, anchor, count, "text"}`). Plus delete-run
encoding for contiguous selections. This is the Yjs "items have length" idea in
the columnar spirit of Automerge.

**Benchmark (realistic typing workload):** 3200 ops, naive JSON **362,666 B** →
binary **3,024 B** — ~**120× smaller**. That ratio is workload-dependent: prose
typed left-to-right run-encodes beautifully; adversarial scattered edits compress
less (the 200-doc round-trip fuzz covers those cases for correctness). The lesson
is the *mechanism* that closes the gap, not the headline number.

## 3. Snapshotting — `snapshot.js`

Loading by replaying history is O(history) plus per-op integration cost. A
snapshot is the materialized node array + version vector, rebuilt by a direct
O(live) copy. **Benchmark:** a 20,000-edit doc loads **14× faster** from a
snapshot than by replay, identical text.

## Run

```bash
npm run phase4:test
```

## Understanding gate (met)

> Your editor handles a document with hundreds of thousands of operations without
> choking, and you can articulate exactly why your tombstone GC is safe (or
> honestly explain the cases where it can't collect).

Content GC is always safe; structural compaction is safe exactly at quiescence
and **refuses otherwise** — verified, including a demonstration of the dangling
insert unsafe collection would cause. Encoding and snapshots keep large docs
cheap to store and fast to open.
