# Phase 5 — Rigor, comparison, and writing it up

The difference between "I built a toy" and "I understand this."

## Files

- `fuzz-scale.js` — **convergence fuzzing at scale**: thousands of randomized
  concurrent scenarios exercising RGA + delta sync + **GC together**, asserting
  SEC every time (including *after* compaction, where subtle GC bugs hide).
- `benchmark.js` — **scoped** comparison against **Yjs** (the answer key): three
  encodings of the same document + build timing on both engines, with a concrete
  gap analysis. Requires the `yjs` dev dependency.
- `rich-text.js` — the **Peritext-lite** stretch: formatting marks over RGA,
  converging, with the hard sub-problems (boundary expansion, overlap
  resolution) reproduced and documented — including a real LWW-tiebreak bug found
  and fixed.
- `DEEP-DIVE.md` — the **technical writeup**: causality → CRDTs → RGA → GC &
  encoding → benchmark, every claim backed by a runnable test.

## Run

```bash
npm run phase5:fuzz       # 3000 scaled SEC scenarios (RGA + sync + GC)
npm run phase5:bench      # head-to-head vs Yjs (needs: npm i)
npm run phase5:richtext   # rich-text stretch + difficulty writeup
```

## Headline results

- **Scaled SEC:** 3,000 scenarios, zero divergences, GC never broke convergence.
- **Encoding vs Yjs:** on 18k-char prose my from-scratch binary encoder produces
  **18,019 B** vs Yjs's **18,016 B** — a tie; naive JSON was 2.1 MB (~118×).
- **Speed vs Yjs:** Yjs is ~**27×** faster to build — a *structural* gap (Yjs's
  item-with-length vs my per-character nodes and O(n²) `insertAt`), which the
  writeup dissects. That named, measured gap is the most educational artifact.

## Understanding gate (met)

The scoped benchmark isolates *which mechanism* costs what (wire representation
vs in-memory structure), rather than a demoralizing raw ratio — exactly the
framing the revised roadmap called for. `DEEP-DIVE.md` is the teach-it-to-prove-
you-learned-it deliverable.
