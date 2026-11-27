# Tournament — png-squeeze entry

Internal pairwise tournament over genuinely different compression designs, judged
in weight order: **practice-set score first, then determinism, 60 s wall, repo size,
robustness across themes**. All scores are totals out of 1,000,000 on the kit
practice set (8 instances), measured with the kit scorer or the manifest points
formula on exact outputs. The champion is the design built in `main.ts`.

## Candidates

| # | Candidate | Design in one line | Score | Wall |
|---|-----------|--------------------|------:|-----:|
| 1 | baseline fixed-paeth | House baseline: RGBA, Paeth every row, zlib 9 | 420,399 | 3.2 s |
| 2 | scale6 | Kit `scalePng` compressor, zlib 6, no brute search | 666,661 | 2.9 s |
| 3 | scale9 | Kit screen, winners re-deflated zlib 9 | 697,728 | 4.4 s |
| 4 | scale9brute | Kit screen with brute-force per-row filters, zlib 9 | 701,039 | 9.2 s |
| 5 | minsum9 | Colour forms + minimum-sum filter only, zlib 9 | 620,781 | — |
| 6 | screen9 / screen9pal | Own screen (forms + filter heuristics), zlib 9 | 701,039 | — |
| 7 | z9best | Screen winners, best zlib variant per instance (memLevel 8, Z_FILTERED, level 6) | 705,452 | — |
| 8 | custom lazy deflate | Own DEFLATE, lazy matching, chain 512, single block | 667,348 | — |
| 9 | custom lazy deflate, blocked | Own DEFLATE, lazy matching, 256 KiB blocks | 675,751 | — |
| 10 | custom lazy deflate, tuned | Chain 4096, maxLazy 258, good-length reduction off, 256 KiB blocks | 709,733 | — |
| 11 | full pipeline, dp32 | Lazy + seeded optimal parse, 256 KiB blocks, 1 DP iteration | 736,336 | 35.7 s |
| 12 | full pipeline, block 512 KiB | As 11, 512 KiB blocks | 737,364 | 37.9 s |
| 13 | **full pipeline, block 512 KiB, dpChain 64** | As 12, DP chain 64 | **741,331** (byte-derived) / **741,212** (kit-scored, all exact) | 38.6 s pre-wipe / 40–44 s now |
| 14 | full pipeline, dpChain 128 | As 13, DP chain 128 | 744,163 | 42.5 s |
| 15 | full pipeline, 2 DP iterations | As 13, DP run twice | 745,369 | 58.0 s |
| 16 | no-brute + dpChain 16 | As 11, brute filter off, DP chain 16, 256 KiB blocks | 727,402 | 33.3 s |
| 17 | no-brute, dp32 | As 11, brute filter off | 731,169 | 35.7 s |
| 18 | brute-level 1 + dp16 | Brute filter weighed at zlib level 1, DP chain 16 | 730,212 | 38.2 s |
| 19 | screen level 1 weighing | Screen weighed at zlib level 1 instead of 6 | 715,125 | 35.3 s |
| 20 | **CHAMPION: full pipeline, block 512 KiB, dpChain 32** | As 13, DP chain 32 | **737,257** (kit-scored, all exact) | **36.8 s / 38.6 s** |

## Pairwise results (winner advances)

- **1 vs 2:** scale6 (666,661) beats baseline (420,399). Colour-type reduction is the
  biggest single win: the baseline is terrible on flat/grey (i001 98 pts, i004 369 pts).
- **2 vs 3:** scale9 (697,728) beats scale6 — re-deflating winners at zlib 9 helps.
- **3 vs 4:** scale9brute (701,039) beats scale9 — brute-force per-row filters help a little.
- **4 vs 5:** scale9brute beats minsum9 (620,781) — minimum-sum alone is much worse than
  a best-of screen; a single heuristic is not enough.
- **4 vs 6:** tie (701,039) — the own screen with extra palette orders gives no gain over
  the kit screen; the screen design is saturated at this level.
- **6 vs 7:** z9best (705,452) beats screen9 — per-instance zlib variants (memLevel 8,
  Z_FILTERED, level 6) add a little; Z_FILTERED helps i006 a lot but hurts others, so
  best-of per instance only.
- **7 vs 10:** tuned custom lazy deflate (709,733) beats z9best — a hand-built DEFLATE
  with deep chains beats zlib's best settings.
- **10 vs 11:** full pipeline with seeded optimal parse (736,336) beats tuned lazy —
  the DP optimal parse is the second-biggest win (+26.6k over lazy alone).
- **11 vs 12:** 512 KiB blocks (737,364) beat 256 KiB blocks (736,336).
- **12 vs 13:** dpChain 64 (741,331) beats dpChain 32 at 512 KiB blocks.
- **13 vs 14:** dpChain 128 (744,163) beats dpChain 64 on score — but the wall-time
  criterion (42.5 s and rising, on a machine that later measured slower) makes it
  riskier; rejected on wall-time safety.
- **13 vs 15:** 2 DP iterations (745,369) beat dpChain 64 on score — but 58.0 s is
  inside the 60 s wall only on paper; any slower grader CPU times out and scores 0.
  **Rejected on the wall criterion.**
- **13 vs 19:** screen level-1 weighing (715,125) is far worse — the screen must be
  weighed at a realistic deflate level. Rejected on score.
- **13 vs 16/17/18:** cost-cutting variants (727–731k) are all worse on score than 13;
  the brute filter and the DP chain both earn their time.
- **13 vs 20 (final):** dpChain 64 (741,212, kit-scored) beats dpChain 32 (737,257) on
  score by 3,955 points (0.53%) — but the final machine measured dpChain 64 at
  40–44 s vs dpChain 32 at 36.8–38.6 s. The 60 s wall is a cliff: a timeout scores 0
  for the whole set. Trading 0.53% of score for a ~20% larger time margin is the
  correct call under the tournament's weight order (the wall is a hard gate, not a
  tie-breaker). **Candidate 20 is the champion.**

## Key findings

- Colour-type reduction is the biggest win vs the baseline (palette for flat,
  grey for grey, RGB when opaque, RGBA otherwise, plus the tRNS-key trick).
- Screen winners by (form, filter) under zlib 9: i001 palette/0, i002 RGB/0, i003 RGBA/brute,
  i004 grey/brute, i005 palette/0, i006 RGB/pairs, i007 RGBA/0, i008 grey/0. Brute-force
  per-row choice badly misleads on i007 (77,636 vs 60,833 for filter 0) — the best-of
  screen protects against it.
- DP (optimal-parse) gains are uneven per image (seeded, chain 32, 256 KiB blocks):
  i001 +5.93%, i002 +0.18%, i003 +6.64%, i004 +4.93%, i005 +3.39%, i006 +5.51%,
  i007 −0.52%, i008 +5.19%. Per-block min(lazy, DP) makes the DP never hurt.
  No reliable cheap signal predicted DP gain per image, so no adaptive skipping.
- Lazy matching needs deep chains: chain 4096 + maxLazy 258 + good-length reduction
  disabled is best; the good-length chain cut cost ~2% quality. DP needs lazy-match
  seeding — unseeded DP with chain 64 was worse than lazy; seeded DP with chain 32
  beats lazy.

## Bug found and fixed during verification

The first build scored 469,404 with i003, i004 and i006 at 0 points (pixels differ).
Root cause: in the per-row filter path, the filtered row was written into the output
buffer at the row's start offset instead of one byte later, overwriting the filter-type
byte and shifting every row by one byte (dropping its first byte, zeroing its last).
Fixed rows (filter 0) were unaffected, which is why only the three instances whose
winners use per-row filters failed. Fix: write the trial row at `at + 1` and the
filter type at `at`. After the fix all 8 outputs decode pixel-exact and the champion
scores 737,257 (kit-scored). The earlier byte-derived tournament numbers were computed
assuming exactness; the champion and the dpChain-64 runner-up were both re-verified
with the kit scorer after the fix (737,257 and 741,212 respectively).

## Champion

Candidate 20 — full pipeline (colour forms + best-of filter screen + hand-built
DEFLATE with lazy matching and one seeded optimal-parse pass), 512 KiB blocks,
DP chain 32, one DP iteration. Practice score **737,257**, all 8 exact, deterministic,
36.8–38.6 s wall, repo 57 KiB.
