# CRDT-Lab

Working implementation of the [CRDT Systems Roadmap](../CRDT-Systems-Roadmap.md).
Every layer is built from scratch, zero-dependency, with the production libraries
(Yjs, Automerge) reserved as the answer key. The deliverable is understanding;
the editor is the vehicle.

## Progress — all phases complete

| Phase | Topic | Status |
|-------|-------|--------|
| 0 | Distributed-systems foundations — causality, vector clocks, causal delivery | ✅ |
| 1 | Easy-mode CRDTs + reusable convergence harness | ✅ |
| 2 | Sequence CRDT for text (RGA) + interleaving anomaly + two-tab checkpoint | ✅ |
| 3 | Sync protocol & transport (version-vector delta sync, presence) | ✅ |
| 4 | Systems-hard problems: tombstone GC + binary encoding + snapshots | ✅ |
| 5 | Rigor (scaled fuzz), Yjs benchmark, rich-text stretch, deep-dive writeup | ✅ |

**Read [`phase5-rigor/DEEP-DIVE.md`](phase5-rigor/DEEP-DIVE.md) for the full
technical narrative** and headline results.

## Running

Correctness suite is zero-dependency except `ws` (transport). The Yjs benchmark
needs dev deps. Node ≥ 18.

```bash
npm install        # ws + yjs (yjs only for the benchmark)
npm test           # every phase's correctness suite, end to end

# individual pieces
npm run phase0:demo        # causal-buffering walkthrough
npm run phase2:serve       # then open http://localhost:3000 in two tabs
npm run phase3:serve       # delta sync + presence + offline toggle
npm run phase4:test        # GC + encoding + snapshots
npm run phase5:bench       # head-to-head vs Yjs
```

## Phase 0 — what's here

A tiny simulator of N in-memory replicas exchanging messages over a lossy,
reorderable, duplicating channel, each tracking a vector clock and delivering
messages only when causally ready. This is the exercise that makes causality
concrete before any CRDT is written.

- `vector-clock.js` — vector clock with `compare()` returning
  `before | after | equal | concurrent`. Concurrency **is** incomparability.
- `replica.js` — causal-order broadcast delivery (Birman–Schiper–Stephenson
  rule): a message is delivered only once every message that happens-before it
  has been delivered; early arrivals are buffered.
- `channel.js` — the unreliable substrate: reorder, delay, duplicate, and
  loss-with-retransmission.
- `simulator.js` — drives randomized interleavings of broadcasts and deliveries.
- `test.js` — the property harness: **convergence** (all replicas deliver the
  identical message set) and **causal safety** (every replica's delivery order
  is a linear extension of happens-before), across 400 seeded scenarios. Includes
  a vacuity guard (buffering must actually occur) and a negative control is
  documented below.
- `demo.js` — the classic "reply arrives before the original" scenario, printed
  step by step.

### The three questions (per the roadmap)

1. **What failure am I handling?** Message reorder, arbitrary delay,
   duplication, and loss (modeled as loss + retransmission so liveness holds).
   The channel guarantees eventual at-least-once delivery in arbitrary order;
   rebuilding order is the replica's job.
2. **What am I trading off?** Latency for consistency: a causally-ready message
   may sit in the buffer waiting for a predecessor rather than being shown
   immediately. Vector clocks cost O(replicas) metadata per message — the first
   taste of the metadata-overhead problem that dominates Phase 4.
3. **How do I prove correctness, not just observe it?** 400 randomized scenarios
   assert convergence and causal safety on every run, not "it looked fine." The
   harness is guarded against a vacuous pass, and a **negative control**
   (forcing `_canDeliver` to always return true) makes the causal-safety
   assertion fail — proving the test can detect the bug it claims to.

### Understanding gate (roadmap: "you understand it when…")

Two concurrent operations have **incomparable** vector timestamps — each has
advanced a component the other hasn't, so neither dominates. "Causally ready to
deliver" means: for a message from `j` stamped `S`, the replica has already
delivered exactly `S[j] - 1` messages from `j` (per-sender FIFO) and at least as
many messages from every other origin as the sender had seen when it sent
(`S[k] ≤ V[k]`). Only then can no causal predecessor still be in flight.
