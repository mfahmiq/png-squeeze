# SUBMISSION — png-squeeze-01-run-20261127

- **Suggested repo name:** `mfahmiq/png-squeeze`
- **Competition:** png-squeeze-01-run-20261127 ($100 code bounty, free entry,
  deadline 2026-11-29T05:00Z). Session started after the competition opened
  (2026-11-27T05:00Z).
- **Session id:** 32c361db-102f-4c1f-b713-483f2d9e501c

## Champion

A lossless PNG re-encoder in a single self-contained `main.ts` (plain JS in a `.ts`
file, Node built-ins only):

1. **Exact colour-type reduction** — palette (≤256 colours, count- and
   luminance-ordered), grey, RGB, or RGBA, whichever is cheapest, plus a tRNS-key
   trick that drops the alpha channel when one fully-transparent value can stand
   in for it.
2. **Best-of filter screen** — every form and per-row filter choice (fixed 0–4,
   minimum-sum, fewest-pairs, entropy model, brute-force weighed by real deflate)
   is weighed with zlib level 6; the smallest (zlib bytes + PLTE/tRNS overhead) wins.
3. **Hand-built DEFLATE** — lazy LZ77 matching (hash chains 4096, maxLazy 258,
   good-length reduction off) plus one zopfli-style optimal-parse pass (dynamic
   programming, seeded with the lazy matches, 512 KiB blocks, DP chain 32), keeping
   the smaller token stream per block; fixed vs dynamic Huffman chosen per block by
   exact bit cost.

Deterministic: fixed effort counts only, no clock, no randomness, no network.
See `TOURNAMENT.md` for the 20-candidate tournament (champion = candidate 20).

## Practice score vs baseline (kit scorer, 2026-11-27)

| instance | theme | champion bytes | champion points | baseline bytes | baseline points |
|----------|-------|---------------:|----------------:|---------------:|----------------:|
| i001 | flat | 11,614 | 761.8 | 25,099 | 98.2 |
| i002 | rich | 48,692 | 743.8 | 59,994 | 607.0 |
| i003 | alpha | 98,904 | 722.2 | 107,297 | 670.3 |
| i004 | grey | 101,387 | 721.8 | 159,860 | 369.1 |
| i005 | flat | 15,823 | 768.3 | 30,157 | 256.4 |
| i006 | rich | 171,376 | 716.7 | 203,550 | 601.0 |
| i007 | alpha | 59,287 | 718.5 | 78,176 | 522.6 |
| i008 | grey | 23,657 | 745.0 | 44,018 | 238.6 |
| **total** | | | **737,257** | | **420,399** |

Champion beats the house baseline (fixed-paeth 1.0.0) by **316,858 points (+75%)**.
Note: the task brief's "~788k" baseline figure is conflated with the kit reference
compressor's score (competition.yaml: reference 788,502 / 772,836 on two drawn sets);
the baseline measured on the practice set with the kit's own code is 420,399.

## Determinism + timing evidence

- All 8 outputs decode **pixel-exact** (kit scorer: `passed: 1, answered: 8`).
- Two consecutive runs into separate output dirs: `diff -r` clean — **byte-identical**.
- Whole-set wall time: **36.8 s** and **38.6 s** (limit 60 s).
- Baseline wall time: 3.3 s.
- A dpChain-64 variant of the same pipeline scored 741,212 (kit-scored, all exact)
  in 40–44 s; the dpChain-32 champion trades 0.53% of score for a ~20% larger
  time margin against the 60 s wall (a timeout scores 0 for the whole set).

Output SHA-256 (run 1):

```
76cf29a89cea197a84d549831dae303073ae44b5f971a0368872dd7e946085f9  i001
f9cd636a0488ba4776b0cece691c548cb2d61d11f765391e8aa382e80385f960  i002
d6e455aa3520d7749ffb771c55040fd253a271e5c13031c683f4f660afdfce3b  i003
20deb5fd2c1bb06cb8b0bea61292b0699322100992139d4a382f998af56f1fc0  i004
fdb8b7ff2669014920ce4c6af500061ad94f519831f68aa78b6f4938c06471d1  i005
96d80653d3c3744e2d32ab64e551633721e435e7a3f4319cf6e9a5a5311d7ec0  i006
0b1c58ee57a55ad73c494b32ba54fe83afc3d2c9d229ea1e7be1447384a04a3f  i007
d1bc4826e84cc878f404699476184e86097c618ab25bb9ff6fc5ea6adbff2970  i008
```

## Repo contents

| file | bytes |
|------|------:|
| main.ts | 41,621 |
| README.md | 2,870 |
| TOURNAMENT.md | 7,315 |
| SUBMISSION.md | (this file) |
| LICENSE | 1,079 |
| .makefun/owner.json | 57 |
| **total** | **~57 KiB** (limit 1 MiB) |

## Local-check commands (exact, run 2026-11-27)

```sh
KIT=/home/hatch/workspace/makefun/kits-20261127-1258/png-squeeze/png-squeeze-01-run-20261127-kit
WORK=/home/hatch/workspace/makefun/png-squeeze-work
cd /home/hatch/workspace/makefun/png-squeeze

# Run the entry on the practice set (twice, for determinism)
MAKEFUN_INPUT_DIR=$KIT/practice/input MAKEFUN_OUTPUT_DIR=$WORK/out1 node main.ts
MAKEFUN_INPUT_DIR=$KIT/practice/input MAKEFUN_OUTPUT_DIR=$WORK/out2 node main.ts
diff -r $WORK/out1 $WORK/out2   # expect no output (byte-identical)

# Score with the kit scorer
MAKEFUN_OUTPUT_DIR=$WORK/out1 MAKEFUN_REFERENCE_DIR=$KIT/practice/reference \
  MAKEFUN_SCORES_DIR=$WORK/scores node $KIT/program/scorer/score.ts
cat $WORK/scores/scores.json    # expect {"score":737257,"passed":1,"answered":8,...}

# Baseline comparison
cd $KIT/baselines/fixed-paeth
MAKEFUN_INPUT_DIR=../../practice/input MAKEFUN_OUTPUT_DIR=$WORK/out-baseline node main.ts
MAKEFUN_OUTPUT_DIR=$WORK/out-baseline MAKEFUN_REFERENCE_DIR=$KIT/practice/reference \
  MAKEFUN_SCORES_DIR=$WORK/scores-baseline node $KIT/program/scorer/score.ts
cat $WORK/scores-baseline/scores.json  # expect {"score":420399,...}
```

## What was NOT done (parent's job)

No push to GitHub, no bundling, no submission, no submit script run. The parent
submits `mfahmiq/png-squeeze` from this directory on handoff.
