[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/mfahmiq/png-squeeze/rank.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/mfahmiq/png-squeeze/reward.svg)](https://make.fun/c/png-squeeze-01-run-20261127)

# png-squeeze

Lossless PNG re-encoder for 1280×720 screenshots, written for the
`png-squeeze-01-run-20261127` make.fun bounty. It squeezes each screenshot into the
smallest exact PNG it can find, in one deterministic run, well inside the 60 s wall.

## How it works

1. **Exact colour-type reduction.** Each image is analysed and written in its
   cheapest exact form: palette (≤256 colours, count-order and luminance-order),
   grey (type 0) when every pixel is grey, RGB (type 2) when opaque, RGBA (type 6)
   otherwise — plus a tRNS-key trick that drops the alpha channel when a single
   fully-transparent value can stand in for it.
2. **Filter screen.** For every form, each per-row filter choice is weighed with a
   real deflate (zlib level 6): fixed filters 0–4, minimum-sum, fewest-distinct-byte-
   pairs, an entropy model, and a brute-force search that weighs each row with a
   deflate of the row after the 32 KiB written before it. The smallest (zlib bytes +
   PLTE/tRNS overhead) wins.
3. **Hand-built DEFLATE.** The winner is written with a from-scratch DEFLATE:
   a lazy-matching LZ77 pass (deep hash chains, 4096 entries, no good-length
   reduction) plus a zopfli-style optimal-parse pass (dynamic programming over
   literal/match costs, seeded with the lazy pass's matches, 512 KiB blocks).
   Each block keeps whichever token stream has the smaller exact bit cost, so the
   optimal parse can never hurt. Fixed vs dynamic Huffman is chosen per block by
   exact bit cost; code lengths are length-limited (≤15 bits) with Kraft repair.

Everything is deterministic: fixed effort counts everywhere, no clock, no
randomness, no network, no files outside `/bot`, `/input`, `/output` and `/tmp`.
Node built-ins only (`node:fs`, `node:path`, `node:zlib`).

## How to run

```sh
node main.ts
# reads  $MAKEFUN_INPUT_DIR  (default /input)  — <id>/image.png
# writes $MAKEFUN_OUTPUT_DIR (default /output) — <id>/image.png
```

Practice run (from this directory):

```sh
MAKEFUN_INPUT_DIR=/path/to/kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice score

| instance | theme | bytes | points |
|----------|-------|-------|--------|
| i001 | flat | 11,614 | 761.8 |
| i002 | rich | 48,692 | 743.8 |
| i003 | alpha | 98,904 | 722.2 |
| i004 | grey | 101,387 | 721.8 |
| i005 | flat | 15,823 | 768.3 |
| i006 | rich | 171,376 | 716.7 |
| i007 | alpha | 59,287 | 718.5 |
| i008 | grey | 23,657 | 745.0 |
| **total** | | | **737,257** |

House baseline (fixed-paeth 1.0.0) on the same practice set: **420,399**.
This entry beats it by **316,858 points (+75%)**. All 8 outputs decode pixel-exact;
two consecutive runs are byte-identical; whole-set wall time 36.8 s / 38.6 s
(limit 60 s). See `TOURNAMENT.md` for the candidate tournament and `SUBMISSION.md`
for the full verification evidence.

## License

MIT — see `LICENSE`.
