# Phase 2 — Sequence CRDT for text (RGA)

The center of gravity. A data structure where any two replicas that have seen the
same operations agree on the *order* of characters, with no central coordinator.

## Files

- `rga.js` — RGA (Replicated Growable Array). Every character has a stable,
  globally-unique id `{c, r}` (Lamport counter + replica). Inserts say "after
  this id"; concurrent inserts at one anchor are ordered by id descending, a rule
  every replica computes identically. Deletes are tombstones (you can't unlink a
  node without stranding what came after it). Ops whose anchor hasn't arrived yet
  are **buffered and re-drained**, so it converges under arbitrary reorder and
  duplication. Dual-mode: `require()` in Node, `<script>` in the browser.
- `test.js` — 500 randomized concurrent insert/delete scenarios, delivered
  reordered + duplicated, asserting all replicas converge to identical text.
- `interleaving.js` — **reproduces the interleaving anomaly** and explains Fugue.
- `server.js` — the checkpoint relay: a dumb websocket broadcaster + static file
  server. Knows nothing about the CRDT; forwards opaque ops.
- `public/` — the two-tab browser editor (`index.html`, `client.js`).
- `sync-test.js` — end-to-end: real relay + two websocket clients converge.

## Run

```bash
npm run phase2:test          # 500-scenario convergence fuzz
npm run phase2:interleaving  # reproduce + explain the anomaly
npm run phase2:e2e           # two clients sync through the real relay
npm run phase2:serve         # then open http://localhost:3000 in two tabs
```

## ★ Demoable checkpoint

`npm run phase2:serve`, open the URL in two browser tabs (same `?room=`), and type
in both at once — they converge live. Verified automatically end-to-end by
`sync-test.js` (two Node websocket clients) and, during development, by driving
two real Chromium tabs with Playwright (both reached `"Hello World"`). **This is
the safety-net milestone: a working, shareable collaborative editor.**

## The interleaving anomaly (understanding gate)

Forward typing keeps each user's run contiguous (`"XYZabc"`). But when both users
**prepend**, all characters compete for one anchor and their lockstep ids
alternate, so `A="abc"` + `B="XYZ"` merges to `"ZcYbXa"` — the words shredded
together. Crucially this is *convergent*: every replica agrees on the gibberish.
Interleaving is a semantic-quality failure that Strong Eventual Consistency does
**not** forbid — which is why it hid in production CRDTs for years. Fugue fixes it
by giving characters left/right origins so a contiguous run stays contiguous
("maximal non-interleaving"). See `interleaving.js` for the live reproduction.

## The three questions

1. **What failure am I handling?** Reordered / delayed / duplicated op delivery
   (internal buffering) and concurrent edits at the same position (deterministic
   descending-id ordering).
2. **What am I trading off?** Memory for correctness: tombstones and per-character
   ids never shrink — the seed of the Phase 4 GC and encoding problems.
3. **How do I prove correctness?** 500 randomized concurrent scenarios assert
   identical converged text, plus an end-to-end test through the real relay.
