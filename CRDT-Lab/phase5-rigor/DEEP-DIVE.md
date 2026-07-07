# Building a collaborative editor from scratch to learn distributed systems

A technical deep-dive through the CRDT-Lab: from causality to a sequence CRDT to
the systems problems that make it real, benchmarked against Yjs. Every layer was
built by hand, zero-dependency (except `ws` for transport and `yjs` as the
benchmark answer key), and every claim below is backed by a runnable test.

> **Scope, stated honestly:** this is the *eventual-consistency / optimistic-
> replication* corner of distributed systems — the AP side of CAP. No consensus,
> linearizability, or transactions. That's a deliberate, deep slice.

---

## 1. Causality comes before CRDTs

You cannot reason about conflict-free merging without first reasoning about *what
happened before what*. A scalar clock gives a total order but can't distinguish
"A caused B" from "A and B happened concurrently." A **vector clock** can: two
events are concurrent exactly when their timestamps are **incomparable** (neither
dominates pointwise).

Phase 0 builds a simulator of replicas gossiping over a lossy, reordering,
duplicating channel, each delivering messages only when **causally ready** — a
message from `j` stamped `S` waits until the replica has delivered `S[j]−1`
messages from `j` and everything `j` had seen. 400 randomized scenarios assert
two properties that recur through the whole project:

- **Convergence** — every replica ends with the same set of messages.
- **Causal safety** — no message is delivered before its causal predecessors.

A *negative control* (forcing "always deliverable") makes causal safety fail —
proving the test can detect the bug it guards against. This "prove it, don't
observe it" discipline is the spine of everything after.

---

## 2. The CRDT pattern, in your bones (Phase 1)

A state-based CRDT's merge must be a **join**: commutative, associative, and
idempotent. Get that, and replicas converge regardless of message order, delay,
or duplication — **Strong Eventual Consistency (SEC)**.

The lab builds the ladder — G-Counter → PN-Counter → G-Set → 2P-Set → **OR-Set**
→ LWW-Register — each fixing the previous one's flaw. The pivotal lesson lives in
the sets: a 2P-Set can never re-add a removed element ("remove wins forever"); an
**OR-Set** tags every add with a unique token and removes only *observed* tokens,
so re-adding works and concurrent add-vs-remove is **add-wins**. The op-based
side teaches the dual lesson about delivery guarantees: an op-based counter is
commutative but **not idempotent**, so it needs **exactly-once** delivery
(verified: remove the dedup and duplicates double-count).

The reusable **convergence fuzzer** written here — random concurrent histories,
asserting identical converged state — is the single most valuable artifact of the
project. Every later phase reuses it.

---

## 3. The hard part: a sequence CRDT for text (Phase 2)

You can't address a character by array index — a concurrent insert elsewhere
shifts every index and replicas disagree. **RGA** gives each character a stable,
globally-unique id `{counter, replica}` and expresses inserts as "after this id."
Concurrent inserts at one anchor are ordered by id **descending**, a rule every
replica computes identically. Deletion can't unlink a node (it anchors others),
so it only sets a **tombstone** — the seed of the Phase 4 GC problem.

500 randomized concurrent scenarios (reordered + duplicated delivery) converge to
identical text. The editor works in two browser tabs over a websocket relay
(verified end-to-end and with Playwright) — the project's **demoable checkpoint**.

### The interleaving anomaly

SEC does **not** guarantee good semantics. When two users each *prepend* a word,
all characters compete for one anchor and their lockstep ids alternate, so
`"abc"` + `"XYZ"` merges to **`"ZcYbXa"`** — the words shredded together. Every
replica agrees on the gibberish, so convergence tests pass. This is why
interleaving hid in production CRDTs for years, and why **Fugue** exists: by
giving characters left/right origins, a contiguous run stays contiguous
("maximal non-interleaving"). Reproducing this by hand is the moment the problem
stops being abstract.

---

## 4. Syncing efficiently (Phase 3)

"Broadcast every op forever" dies on reconnection after offline editing. The fix
is a **version vector** (`origin → count`) summarizing exactly what each replica
has seen; a peer sends only the **delta** you're missing. The headline result:

> A client goes offline, makes **500 edits**, reconnects, and syncs in **one**
> delta exchange. Its entire state is summarized by the version vector `{"A":510}`
> — **9 bytes**. Verified over real websockets: exactly **1** update message on
> reconnect.

**Presence** (cursors) is deliberately kept *out* of the CRDT: it's ephemeral,
high-frequency, and worthless once stale. Routing it through the oplog would
bloat durable history with garbage forever — a mistake worth feeling once.

---

## 5. The systems-hard problems (Phase 4)

### Tombstone garbage collection

When is it safe to reclaim a tombstone? Only once the deletion is **causally
stable** — below the **causal frontier**, the pointwise-min of all version
vectors. The lab reclaims in tiers, honest about which is hard:

- **Content GC** (safe under live concurrency): drop the payload, keep an id
  anchor. Can't dangle. This is the Yjs approach.
- **Structural compaction** (safe only at **quiescence**): physically remove
  anchors — but a concurrent insert anchored at a stably-deleted node can itself
  be un-stable and still propagating; remove the anchor early and that insert
  **dangles forever**. So compaction *refuses* unless no ops are in flight, and
  the test **demonstrates the dangling insert the guard prevents**. This is the
  part the papers wave at; production systems solve it only partially.

### Binary encoding

Naive per-op JSON is enormous. From scratch: **LEB128 varints**, an interned
**string table** for replica ids, and **run-length encoding** of typing runs
(a whole typed run → one record). On an 18,000-char prose document:

| Encoding | Bytes |
|---|---|
| my naive JSON | 2,126,668 |
| **my binary encoder** | **18,019** |
| Yjs update | 18,016 |

The from-scratch encoder essentially **matches Yjs on size** for this workload —
the ~118× jump from naive to binary is precisely the wire-representation gap.

### Snapshots

Replaying history to open a doc is O(history) plus integration cost. A snapshot
(materialized nodes + version vector) rebuilds by a direct copy: a 20,000-edit
doc loads **14× faster** than replay.

---

## 6. Benchmarking against the answer key (Phase 5)

Scoped, not a demoralizing single ratio. Same document, three encodings + build
timing on both engines. Results and the honest gap analysis:

- **Size:** my binary encoder ties Yjs (18,019 vs 18,016 B on prose; on
  pathological prepend, 49,753 vs 49,878 B — mine is marginally *smaller*). The
  encoder recovers essentially all of the *wire-representation* gap.
- **Build time:** Yjs is **~27× faster** (115 ms vs 3,072 ms for 18k inserts).
  This gap is **structural and real**: my `insertAt` rescans visible nodes
  (O(n) per insert → O(n²) build), and my RGA holds **one node per character** in
  memory, while Yjs represents a typed run as a single **item with a length** in
  the live tree. My run-length win exists only in the *encoder*; matching Yjs's
  speed means adopting the item-with-length design in the data structure itself —
  the YATA refactor. **That is the single most useful thing the comparison
  taught.**

Reading Yjs's internals after building my own is what turned "Yjs is faster" into
"here is the exact mechanism, and here's the ~118× of it my encoder already
closed."

### Scaled rigor

3,000 scenarios exercise RGA + delta sync + **GC together**, asserting SEC every
time — including *after* compaction, the place a subtle GC bug would surface. Zero
divergences.

### Rich text (stretch)

Formatting marks anchored to character ids converge easily (grow-only set +
deterministic effective-format function inherit SEC). The hard parts are exactly
where Peritext focuses: **boundary expansion** (is a character typed at a bold
edge inside the bold? — no universal answer; bold expands, links don't) and
**overlap resolution** (concurrent bold vs un-bold — LWW converges but loses
information). A real bug found here: LWW with colliding Lamport timestamps
diverges without a replica-id tiebreak. Documented, not papered over.

---

## What building it taught that reading couldn't

1. SEC is a floor, not a ceiling — it permits interleaving gibberish. Semantic
   quality (Fugue, Peritext) is a separate battle convergence tests can't fight
   for you.
2. The frontier is everything in GC. "Safe to delete" is a statement about what
   *every* replica knows, and the honest answer to "can I compact now?" is often
   "not while anything is in flight."
3. Encoding is where the theory meets the profiler. The naive→binary step is a
   ~118× artifact you can *measure*, and it closes a specific, nameable gap.
4. The remaining gap to Yjs is structural (item-with-length), not incidental —
   you only learn that by matching its size and *still* losing on speed.

Every number here is reproducible: `npm test` (correctness across all phases),
`npm run phase5:bench` (the Yjs comparison), `npm run phase5:fuzz` (scaled SEC).
