# Phase 3 — Sync protocol & transport

Make replicas efficiently discover *what the other hasn't seen* without resending
the whole history.

## Files

- `sync-doc.js` — wraps the RGA with a **version vector** (`origin → count`) and
  an oplog keyed by `(origin, seq)`. `delta(remoteVV)` returns exactly the ops a
  peer is missing; `integrate()` applies a received delta. Dual-mode Node/browser.
- `awareness.js` — **ephemeral** presence (cursors/names): last-write-per-field
  with expiry, deliberately kept out of the CRDT and the oplog.
- `server.js` — the sync **hub**: keeps the authoritative oplog per room, answers
  a reconnecting client's `hello` (version vector) with one delta, stores/relays
  live `update`s, and forwards `awareness` without persisting it.
- `public/` — browser editor with live cursors and an **offline toggle**.
- `test.js` — delta-sync fuzz, the offline-500-edits gate, awareness ephemerality.
- `e2e-test.js` — the full cycle over real sockets: connect → offline 500 edits →
  reconnect → resync in one delta message.

## Run

```bash
npm run phase3:test    # delta sync + offline reconnect + awareness
npm run phase3:e2e     # offline→reconnect through the real hub
npm run phase3:serve   # open http://localhost:3001 in two tabs; try the offline toggle
```

## Understanding gate (met)

> A client can go offline, make 500 edits, reconnect, and sync in one compact
> delta exchange rather than replaying every operation.

`test.js` proves it: after 500 offline edits, A's entire state is the version
vector `{"A":510}` (9 bytes); reconnection ships a single 500-op delta, and the
peer returns only its 3 ops. `e2e-test.js` confirms it over real websockets —
exactly **1** update message on reconnect. Verified in-browser with Playwright
(offline edits + a concurrent remote edit converged on reconnect; live presence
shown).

## The three questions

1. **What failure am I handling?** Reconnection after offline editing and long
   partitions — solved by version-vector deltas instead of full replay or
   per-op broadcast.
2. **What am I trading off?** A version vector is O(replicas) metadata, and delta
   computation assumes an ordered per-connection channel (websocket) even though
   the CRDT itself tolerates arbitrary reorder. Presence trades durability for
   freshness by bypassing the CRDT entirely.
3. **How do I prove correctness?** 300 randomized concurrent delta-sync scenarios
   converge; the offline gate asserts exact delta sizes (500 and 3); the e2e test
   asserts exactly one message on reconnect.
