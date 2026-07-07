# CRDT-Lab

Working implementation of the [CRDT Systems Roadmap](../CRDT-Systems-Roadmap.md).
Every layer is built from scratch, zero-dependency, with the production libraries
(Yjs, Automerge) reserved as the answer key. The deliverable is understanding;
the editor is the vehicle.

## Progress

| Phase | Topic | Status |
|-------|-------|--------|
| 0 | Distributed-systems foundations — causality, vector clocks, causal delivery | ✅ done |
| 1 | Easy-mode CRDTs + convergence testing | ⬜ next |
| 2 | Sequence CRDT for text (the hard part) | ⬜ |
| 3 | Sync protocol & transport | ⬜ |
| 4 | Systems-hard problems (pick two, go deep) | ⬜ |
| 5 | Rigor, comparison, writeup | ⬜ |

## Running

No dependencies. Node ≥ 18.

```bash
cd phase0-causality
node demo.js   # deterministic, human-readable causal-buffering walkthrough
node test.js   # 400 randomized lossy/reordering scenarios, asserts SEC + causal safety
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
