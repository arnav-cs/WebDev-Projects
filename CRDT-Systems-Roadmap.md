# Becoming a Systems Engineer by Building a Real-Time Collaborative Editor (from scratch)

**Goal:** deep learning, not shipping. The output is *you understanding distributed systems*,
with a collaborative editor as the vehicle. A working product is a side effect.

**Scope, named honestly:** this is a *deep slice of one corner* of distributed systems —
optimistic replication and **eventual consistency (the AP corner of CAP)**. You will come out
an expert in CRDTs and collaborative editing. You will *not* touch consensus (Raft/Paxos),
linearizability, leader election, or distributed transactions — those are the CP corner and a
different project. That's a legitimate, valuable specialization; just don't expect broad
coverage the title might imply.

**Governing principle:** build every layer yourself first, *then* read the production
implementations and understand why they diverged from your naive version. If you `npm install`
the hard part, you skip the learning. The libraries (Yjs, Automerge) are the answer key — you
don't read the answer key before doing the problem.

**Assumed pace:** ~10–15 hrs/week alongside a job → ~6–9 months. Phases are sized in weeks but
treat them as milestones, not deadlines. **Read the "Realistic completion" note below before
you start** — the back half of this plan is deliberately more than one person finishes, and
that's by design.

---

## The one insight that shapes everything

Simple CRDTs (counters, sets) are *easy* and exist to teach you the mental model. **Sequence
CRDTs for text are the genuinely hard problem** — interleaving anomalies, tombstone garbage
collection, and encoding efficiency all live there. That's the part that turns this from a
toy into a systems project. Budget your time accordingly: the counters take a week, the text
CRDT and its consequences take months.

---

## Realistic completion (read this first)

This plan is intentionally larger than a single person finishes in 6–9 months. Two things
follow from that:

1. **There is a demoable checkpoint at the end of Phase 2** — two browser tabs, plaintext,
   real sync over a websocket. If you stop there, you still have a working artifact and a real
   story to tell. Treat it as the point where the project is already a success; everything
   after is depth, not survival.
2. **Phase 4 is a menu, not a sequence.** Each item in it is arguably its own multi-month
   project. Pick **two** and do them properly rather than touching all six shallowly. Reaching
   the end of the timeline with two Phase-4 topics done *deeply* is the target outcome, not a
   shortfall.

The single biggest risk to this project is not technical — it's stalling out around month four
when the novelty fades and the encoding grind starts. The checkpoint and the menu exist to
manage exactly that.

---

## Phase 0 — Distributed systems foundations (weeks 1–3)

You cannot reason about a CRDT without reasoning about causality first.

**Learn:**
- Happens-before relation, concurrency, causality
- Lamport timestamps (total order) vs vector clocks (partial/causal order) — and *why* you
  need vector clocks when Lamport clocks aren't enough
- Eventual Consistency vs **Strong Eventual Consistency (SEC)** — SEC is the property CRDTs
  guarantee and the whole point of the exercise
- Where this sits in CAP: CRDTs are an AP choice (available + partition-tolerant, eventually
  consistent). Be able to say what the *CP* alternative would cost you here — that contrast is
  what makes the AP choice meaningful.

**Build:**
- A tiny simulator: N in-memory "replicas" exchanging messages over a lossy, reorderable
  channel, each tracking a vector clock. Deliver messages only when causally ready (buffer
  out-of-causal-order ones). This single exercise makes causality *concrete*.

**You understand it when:** you can explain, without notes, why two concurrent operations
have incomparable vector clocks and what "causally ready to deliver" means.

**Read:** Lamport, "Time, Clocks, and the Ordering of Events in a Distributed System" (1978) —
short, foundational, worth the effort.

---

## Phase 1 — Easy-mode CRDTs + convergence testing (weeks 4–7)

Build the simple CRDTs so the core pattern (commutative, associative, idempotent merges) is
in your bones before text makes it hard.

**Build from scratch (both flavors):**
- **State-based (CvRDT):** merge via a join/least-upper-bound. G-Counter → PN-Counter →
  G-Set → 2P-Set → **OR-Set** (observed-remove, the one that behaves intuitively) →
  LWW-Register
- **Op-based (CmRDT):** the same structures expressed as commutative operations broadcast to
  peers. Understand the delivery guarantees each flavor assumes (op-based needs
  causal/exactly-once delivery; state-based tolerates anything).

**The rigor that matters most here — property-based testing:**
- Generate random sequences of concurrent operations across N replicas
- Apply them in randomized, delayed, duplicated orders
- **Assert all replicas converge to the identical state** (this is SEC, tested)
- This convergence-fuzzing harness is reusable for every CRDT you build after — invest in it.

**You understand it when:** you can state the three algebraic properties a state-based merge
must satisfy and explain why OR-Set needs unique tags while a naive 2P-Set has the "can't
re-add after remove" flaw.

**Read:** Shapiro, Preguiça, Baquero, Zawirski — "A Comprehensive Study of Convergent and
Commutative Replicated Data Types" (2011). *The* foundational CRDT paper. Also their shorter
"Conflict-Free Replicated Data Types" (2011).

---

## Phase 2 — The hard part: a sequence CRDT for text (weeks 8–15)

This is the center of gravity. A collaborative text editor needs a data structure where any
two replicas that have seen the same operations agree on the *order* of characters, with no
central coordinator.

**Know the other branch of the field first (half a day, before you build).** The two families
that solve collaborative editing are **Operational Transformation (OT)** and **CRDTs**. OT is
what actually ships in Google Docs; CRDTs are what won for peer-to-peer and offline-first. You
are not building OT — but a systems engineer who studied this field and can't explain *why it
forked*, what OT trades away (a central server transforming operations) and what CRDTs trade
away (per-character metadata and GC), has a hole. Read one OT overview and be able to argue
both sides.

**Understand the problem first:**
- Why can't you just use indices? (Concurrent inserts shift indices → replicas disagree.)
- The solution: every character gets a **stable, globally-unique, densely-orderable
  identifier** so position is intrinsic to the character, not its array index.
- **Tombstones:** you can't truly delete — you mark deleted and keep the node, or ordering
  breaks. This is the seed of the garbage-collection problem you'll fight later.

**Survey the algorithm family (know the tradeoffs):**
- **WOOT** — the original, correct but heavy
- **Logoot / LSEQ** — position identifiers as fractional/variable-length paths; elegant but
  identifiers can grow unboundedly under adversarial editing
- **RGA (Replicated Growable Array)** — timestamp-based, widely used, a great first
  implementation
- **YATA** — the algorithm behind **Yjs**; optimized for the common case
- **Fugue** — newer, specifically fixes *interleaving anomalies* (when two users type words at
  the same spot and the characters get shuffled together into gibberish)

**Build:** implement **RGA or a YATA-style CRDT yourself.** Get plaintext editing working
between two browser tabs over a websocket relay. No fancy encoding yet — correctness first.

**★ Demoable checkpoint.** When two tabs sync plaintext correctly, stop and take stock: you
have a real, working, shareable artifact and a real story. This is the safety net for the whole
project — everything past here is depth, and you could pause here and still have finished
something worth showing.

**You understand it when:** you can hand-trace what happens when two replicas concurrently
insert different characters at the same position and show why they still converge to the same
order — and when you can *reproduce an interleaving anomaly* in your naive version and explain
what Fugue does about it.

**Read:** Kleppmann & Beresford, "A Conflict-Free Replicated JSON Datatype" (2017);
Weidner & Kleppmann, "The Art of the Fugue: Minimizing Interleaving in Collaborative Text
Editing" (interleaving anomalies). Watch Martin Kleppmann's CRDT talks — he's the clearest
voice in the field.

---

## Phase 3 — Sync protocol & transport (weeks 16–21)

You have a CRDT. Now make replicas efficiently discover *what the other hasn't seen* without
resending the whole history.

**Build:**
- **State vectors / version vectors:** compact summaries of "what I've seen," exchanged so
  each side sends only the missing operations (a delta). Naive "broadcast every op" doesn't
  survive reconnection after offline editing.
- **Delta sync:** compute and ship minimal diffs.
- **Transport:** start with a websocket relay server, then add **WebRTC** for peer-to-peer
  sync (leverage your existing WebRTC experience — this is where it pays off). Understand the
  tradeoff: P2P has no central bottleneck but complicates persistence and discovery.
- **Awareness/presence:** live cursors and selections. Note this is *ephemeral* state — it
  shouldn't go through the CRDT/persistence path (a mistake worth making once to feel why, but
  cap that mistake at a day — it's cheap to feel, expensive to wallow in).

**You understand it when:** a client can go offline, make 500 edits, reconnect, and sync in one
compact delta exchange rather than replaying every operation.

---

## Phase 4 — The systems-hard problems (weeks 22–30) — *pick two, go deep*

This phase is what makes it a *systems* project. **These items are a menu, not a checklist.**
Each one is arguably its own multi-month project — safe tombstone GC and columnar encoding
alone are where Yjs and Automerge sank *years*. Choose **two** and do them properly. Finishing
two of these deeply is the target; touching all six shallowly teaches you far less.

- **Tombstone garbage collection / compaction.** Deleted characters linger forever as
  tombstones; documents grow unbounded. When is it *safe* to actually remove a tombstone?
  (Only once every replica has seen the deletion — which requires knowing the causal frontier
  of all replicas. Genuinely hard; partial in production systems.)
- **Efficient binary encoding.** Naive CRDTs store per-character metadata and explode in
  memory/bandwidth. Study run-length encoding of consecutive operations and columnar encoding
  (Automerge's approach). This is *the* reason Yjs/Automerge are fast — reimplement a slice of
  it yourself and benchmark the before/after.
- **Snapshotting & lazy loading.** Loading a large doc by replaying all history is too slow.
  Design snapshots + incremental history so a 100k-edit document opens instantly.
- **Offline & large-delta reconnection.** Robust behavior across long partitions.
- **Collaborative undo/redo.** Undoing *your* change without clobbering a collaborator's
  concurrent edit — surprisingly deep, an easy thing to get subtly wrong.
- **Scaling the sync server.** Many documents, many clients per document. Horizontal scaling,
  routing clients of the same doc together, backpressure. (Your queue/pub-sub background from
  work applies directly here.)

**You understand it when:** for each of the two you chose, you can articulate exactly why your
solution is correct (or honestly explain the cases where it isn't) and show a before/after
measurement that proves the improvement.

---

## Phase 5 — Rigor, comparison, and writing it up (weeks 31–36)

The difference between "I built a toy" and "I understand this" is here.

- **Convergence fuzzing at scale:** thousands of randomized concurrent-op scenarios, asserting
  SEC every time. Find and fix the bug this *will* surface.
- **Benchmark against Yjs and Automerge — scoped, not raw.** Your naive implementation will
  lose by one to two orders of magnitude, and a bare "mine is 100× slower" number is
  demoralizing and shallow. Instead, isolate **two or three specific mechanisms** (e.g.
  run-length encoding of adjacent inserts; Yjs's integer-clock item IDs vs your per-character
  metadata) and measure the before/after when *you* implement that one slice. The educational
  artifact is "here is the exact optimization that closed 10× of the gap and why," not the
  headline ratio. Measure memory, sync payload size, load time, and ops/sec on identical
  workloads, then read their source to confirm your explanation.
- **Rich text is a known-hard sub-problem, not a checkbox.** Formatting spans (bold/italic)
  over a sequence CRDT — the Peritext problem — is genuinely subtle: a concurrent bold and an
  insert at the same boundary is where it bites. Attempt it as a *stretch*, and treat
  documenting exactly where you get stuck as the deliverable. That writeup is itself excellent
  evidence of depth.
- **Write a technical deep-dive** (blog/README) explaining causality → CRDTs (and why not OT)
  → your sequence algorithm → the GC and encoding problems → your scoped benchmark results vs.
  production libraries. Teaching it is the proof you learned it, and it's the portfolio
  evidence that reads as systems depth rather than app work.

---

## Reference implementations to dissect (the answer key)

- **Yjs** (YATA algorithm, Kevin Jahns) — the fast, pragmatic one; read after Phase 2
- **Automerge** (Rust core, columnar encoding) — read for the encoding lessons in Phase 4
- **Diamond Types** (Seph Gentle) — writeups on making text CRDTs fast are gold
- **Y-Sweet / y-websocket** — for how sync servers are structured in production

## Core reading list

- Lamport (1978) — *Time, Clocks, and the Ordering of Events*
- Shapiro et al. (2011) — *A Comprehensive Study of CvRDTs and CmRDTs* (the foundational paper)
- Kleppmann & Beresford (2017) — *A Conflict-Free Replicated JSON Datatype*
- Weidner & Kleppmann — *The Art of the Fugue* (interleaving anomalies)
- One OT overview (for the CRDT-vs-OT contrast) — e.g. Ellis & Gibbs' original OT paper, or a
  modern survey; you only need enough to argue both sides
- Litt, Kleppmann et al. — *Peritext: A CRDT for Rich-Text Collaboration* (read before the
  Phase 5 rich-text stretch)
- Martin Kleppmann — *Designing Data-Intensive Applications* (Ch. 5 replication, Ch. 9
  consistency) for the surrounding systems context, plus his CRDT talks
- The `crdt.tech` resource hub for the current landscape

*(CRDT research moves — check for papers newer than early 2026 on interleaving, GC, and
encoding when you reach Phases 2 and 4.)*

---

## How to keep it honestly "systems engineering"

At every phase, force yourself to answer three questions in writing:
1. **What failure am I handling?** (message loss, reorder, duplication, partition, replica
   crash)
2. **What am I trading off?** (memory vs. bandwidth, latency vs. consistency, P2P vs.
   central)
3. **How do I *prove* correctness, not just observe it?** (convergence properties, not "it
   looked fine in two tabs")

If you can answer those three at every layer, you'll come out the other side an actual
distributed-systems engineer (of the eventual-consistency school) — the editor is just what
you have to show for it.
