// png-squeeze: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
//
// How it works, in one paragraph: each screenshot is re-encoded by first choosing its
// cheapest exact form (palette when it holds at most 256 colours, grey / grey+alpha when
// every pixel is grey, RGB when it is opaque, RGBA otherwise, with a tRNS key when a
// single fully-transparent value can stand in for the alpha channel), then choosing, per
// form, the cheapest per-row filter (fixed filters, minimum-sum, fewest-pairs, an
// entropy model, and a brute-force search that weighs each row with a real deflate),
// and finally writing the filtered bytes with a hand-built DEFLATE: a lazy-matching
// LZ77 pass with deep hash chains, plus a zopfli-style optimal-parse pass (dynamic
// programming over literal/match costs, seeded with the lazy pass's matches) that keeps
// whichever token stream is smaller per block. Everything is deterministic: fixed
// effort counts everywhere, no clock, no randomness, no network, no files outside
// /bot, /input, /output and /tmp. Node built-ins only (node:fs, node:path, node:zlib).
//
// Usage (as the grader runs it): node main.ts
//   reads  /input/<id>/image.png  (or $MAKEFUN_INPUT_DIR)
//   writes /output/<id>/image.png (or $MAKEFUN_OUTPUT_DIR)
// Practice run: MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG codec
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode any 8-bit non-interlaced PNG of colour type 0, 2, 3, 4 or 6 into RGBA. */
function decodePng(bytes) {
  if (bytes.length < 8) throw new Error('file too short for a PNG signature');
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw new Error('truncated chunk');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error('bad CRC in ' + type);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    else throw new Error('unexpected chunk ' + type);
  }
  if (!header || header.depth !== 8 || header.interlace !== 0) throw new Error('unsupported PNG header');
  const channels = CHANNELS[header.colourType];
  if (channels === undefined) throw new Error('unsupported colour type ' + header.colourType);
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== header.height * (stride + 1)) throw new Error('IDAT inflates to the wrong size');
  const samples = new Uint8Array(header.height * stride);
  for (let y = 0; y < header.height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('bad filter type ' + ft);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? samples[o + i - channels] : 0;
      const b = y > 0 ? samples[p + i] : 0;
      const c = y > 0 && i >= channels ? samples[p + i - channels] : 0;
      const v = raw[src + i];
      samples[o + i] = ft === 0 ? v : ft === 1 ? v + a : ft === 2 ? v + b : ft === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c);
    }
  }
  const n = header.width * header.height;
  const rgba = new Uint8Array(n * 4);
  const ct = header.colourType;
  if (ct === 6) rgba.set(samples);
  else if (ct === 2) {
    const key = trns ? (trns[1] << 16) | (trns[3] << 8) | trns[5] : -1;
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (ct === 0) {
    const key = trns ? trns[1] : -1;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (ct === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1]; lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width: header.width, height: header.height, rgba };
}

/** Assemble a PNG from [type, data] chunks (signature, lengths, CRCs). */
function pngOf(chunks) {
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------- PNG filters
function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    if (type === 1) out[i] = cur[i] - a;
    else if (type === 2) out[i] = cur[i] - b;
    else if (type === 3) out[i] = cur[i] - ((a + b) >> 1);
    else out[i] = cur[i] - paeth(a, b, prev === null || i < bpp ? 0 : prev[i - bpp]);
  }
}

/** Sum of a filtered row's bytes read as signed values (the minimum-sum heuristic). */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** How many distinct neighbouring byte pairs a filtered row holds (the pairs heuristic). */
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- image analysis
/** Whether every pixel is opaque, whether every pixel is grey, and the colours (<=256). */
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  const first = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      if (!counts.has(c)) {
        if (counts.size === 256) many = true;
        else { counts.set(c, 1); first.set(c, i); }
      } else counts.set(c, counts.get(c) + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c), first: first.get(c) };
  });
  return { opaque, grey, colours };
}

/**
 * The one fully-transparent value (grey or RGB) the image may key by tRNS instead of
 * an alpha channel: every non-opaque pixel is that exact value at alpha 0, and no
 * opaque pixel uses the same value. Null when there is none.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in colour type `ct` (0, 2, 4 or 6) from its RGBA. */
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

/** A palette form: entries ordered by `order`, transparent entries first (short tRNS). */
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

/** The exact forms an image can be written in, each with the filters to try. */
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [['count', [0]], ['luminance', [0, 'minsum', 'brute', 'entropy']]]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute', 'entropy'] });
  return forms;
}

// ---------------------------------------------------------------- filtering
/**
 * The filtered rows of `samples` by `choice`: a fixed filter 0-4 for every row, or
 * 'minsum' (least signed sum), 'pairs' (fewest distinct byte pairs), 'entropy' (least
 * -log2 cost under a global byte model), or 'brute' (each row weighed by a real
 * deflate of the row after the 32 KiB written before it).
 */
function filtered(samples, width, height, bpp, choice, entropyModel) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRowInto(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trial[t]);
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else if (choice === 'entropy') {
        cost = 0;
        for (let i = 0; i < stride; i++) cost += entropyModel[trial[t][i]];
      } else {
        cost = deflateSync(trial[t], before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at + 1);
    raw[at] = type;
  }
  return raw;
}

/** -log2 byte costs from a first filtered pass (the 'entropy' filter's model). */
function entropyModelOf(filteredData) {
  const freq = new Float64Array(256);
  for (let i = 0; i < filteredData.length; i++) freq[filteredData[i]]++;
  const total = filteredData.length;
  const model = new Float64Array(256);
  for (let i = 0; i < 256; i++) model[i] = -Math.log2((freq[i] + 0.5) / (total + 128));
  return model;
}

// ---------------------------------------------------------------- DEFLATE (part 1)
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** Length code (0..28, symbol 257..285) for a match length 3..258. 258 is code 28. */
function lengthCode(len) {
  if (len === 258) return 28;
  for (let s = 0; s < 28; s++) {
    if (len < LEN_BASE[s] + (1 << LEN_EXTRA[s])) return s;
  }
  return 28;
}

/** Distance code (0..29) for a match distance 1..32768. */
function distCode(d) {
  for (let s = 0; s < 30; s++) {
    if (d < DIST_BASE[s] + (1 << DIST_EXTRA[s])) return s;
  }
  return 29;
}

/**
 * Length-limited Huffman code lengths from symbol frequencies (maxBits, default 15).
 * An optimal Huffman tree by heap; when a depth exceeds maxBits, clamp it and repair
 * the Kraft sum (lengthen the cheapest symbols until the sum is at most 1, then
 * greedily shorten the most valuable symbols until the code is complete, sum == 1).
 */
function codeLengths(freq, maxBits) {
  if (maxBits === undefined) maxBits = 15;
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return lengths;
  }
  const heap = [];
  const nodeFreq = new Float64Array(2 * n);
  const nodeChild = new Int32Array(2 * n * 2);
  const push = (e) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
        i = m;
      }
    }
    return top;
  };
  for (const s of used) { push([freq[s], s]); nodeFreq[s] = freq[s]; }
  let next = n;
  while (heap.length > 1) {
    const a = pop();
    const b = pop();
    nodeFreq[next] = a[0] + b[0];
    nodeChild[next * 2] = a[1];
    nodeChild[next * 2 + 1] = b[1];
    push([nodeFreq[next], next]);
    next++;
  }
  const root = heap[0][1];
  const stack = [[root, 0]];
  while (stack.length > 0) {
    const [node, d] = stack.pop();
    if (node < n) { lengths[node] = d; continue; }
    stack.push([nodeChild[node * 2], d + 1]);
    stack.push([nodeChild[node * 2 + 1], d + 1]);
  }
  let maxLen = 0;
  for (const s of used) if (lengths[s] > maxLen) maxLen = lengths[s];
  if (maxLen <= maxBits) return lengths;
  for (const s of used) if (lengths[s] > maxBits) lengths[s] = maxBits;
  const kraft = () => {
    let sum = 0;
    for (const s of used) sum += 1 << (maxBits - lengths[s]);
    return sum;
  };
  const FULL = 1 << maxBits;
  let guard = 0;
  while (kraft() > FULL && guard++ < 100000) {
    let bestSym = -1;
    let bestKey = Infinity;
    for (const s of used) {
      if (lengths[s] >= maxBits) continue;
      const key = freq[s] / (1 << (maxBits - lengths[s] - 1));
      if (key < bestKey) { bestKey = key; bestSym = s; }
    }
    if (bestSym < 0) break;
    lengths[bestSym]++;
  }
  guard = 0;
  while (kraft() < FULL && guard++ < 100000) {
    let bestSym = -1;
    let bestVal = -1;
    const deficit = FULL - kraft();
    for (const s of used) {
      if (lengths[s] <= 1) continue;
      const add = 1 << (maxBits - lengths[s]);
      if (add > deficit) continue;
      const val = freq[s] * (1 << lengths[s]);
      if (val > bestVal) { bestVal = val; bestSym = s; }
    }
    if (bestSym < 0) break;
    lengths[bestSym]--;
  }
  return lengths;
}

/** Canonical Huffman codes from lengths. */
function canonicalCodes(lengths) {
  const n = lengths.length;
  const codes = new Uint32Array(n);
  const blCount = new Uint32Array(16);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Uint32Array(16);
  let code = 0;
  for (let b = 1; b <= 15; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l > 0) codes[i] = nextCode[l]++;
  }
  return { codes, lens: lengths };
}

/** Reverse the low `len` bits of `code` (DEFLATE writes Huffman codes MSB-first). */
function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

/** LSB-first bit writer over a growing byte buffer. */
class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  ensure(n) {
    if (this.pos + n + 8 > this.buf.length) {
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n + 1024));
      nb.set(this.buf.subarray(0, this.pos));
      this.buf = nb;
    }
  }
  writeBits(value, len) {
    this.bitbuf |= (value << this.bitcnt) >>> 0;
    this.bitcnt += len;
    while (this.bitcnt >= 8) {
      this.ensure(1);
      this.buf[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  writeCode(code, len) {
    this.writeBits(reverseBits(code, len), len);
  }
  bytes() {
    if (this.bitcnt > 0) {
      this.ensure(1);
      this.buf[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
}

/** Adler-32 of a byte array. */
function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** RLE-encode lit+dist code lengths into code-length symbols (0..18) for the header. */
function rleCodeLengths(allLengths) {
  const syms = [];
  const extras = [];
  const extraBits = [];
  let i = 0;
  const n = allLengths.length;
  while (i < n) {
    const v = allLengths[i];
    let run = 1;
    while (i + run < n && allLengths[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        syms.push(18); extras.push(take - 11); extraBits.push(7);
        left -= take;
      }
      if (left >= 3) { syms.push(17); extras.push(left - 3); extraBits.push(3); left = 0; }
      while (left > 0) { syms.push(0); extras.push(0); extraBits.push(0); left--; }
    } else {
      syms.push(v); extras.push(0); extraBits.push(0);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        syms.push(16); extras.push(take - 3); extraBits.push(2);
        left -= take;
      }
      while (left > 0) { syms.push(v); extras.push(0); extraBits.push(0); left--; }
    }
    i += run;
  }
  return { syms, extras, extraBits };
}

// ---------------------------------------------------------------- DEFLATE (part 2)
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const WINDOW = 32768;
const MAX_MATCH = 258;
const MIN_MATCH = 3;

function hash3(data, p) {
  return ((data[p] << 10) ^ (data[p + 1] << 5) ^ data[p + 2]) & HASH_MASK;
}

/**
 * Lazy-matching LZ77 tokenization of data[start..end), with a 32 KiB lookback that
 * may reach before `start` (seeded positions). Returns parallel arrays: syms (the
 * literal/length symbol 0..285), dists (distance code 0..29, or -1 for a literal),
 * lenExtra (extra-bits value of the length code) and distExtra (of the distance code).
 * Deterministic: fixed chain budget, no clock. opts.recordMatches optionally records
 * the best match found at each visited position for the optimal parser to seed with.
 */
function tokenizeLazy(data, start, end, opts) {
  const maxChain = opts.maxChain !== undefined ? opts.maxChain : 128;
  const goodLength = opts.goodLength !== undefined ? opts.goodLength : 32;
  const niceLength = opts.niceLength !== undefined ? opts.niceLength : 258;
  const maxLazy = opts.maxLazy !== undefined ? opts.maxLazy : 32;
  const seedFrom = Math.max(0, start - WINDOW);

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.length).fill(-1);
  const insert = (p) => {
    const h = hash3(data, p);
    prev[p] = head[h];
    head[h] = p;
  };
  for (let p = seedFrom; p < start; p++) {
    if (p + 2 < data.length) insert(p);
  }

  const syms = [];
  const dists = [];
  const lenExtra = [];
  const distExtra = [];
  const rec = opts.recordMatches !== undefined ? opts.recordMatches : null;

  const longestMatch = (pos, best) => {
    if (pos + MIN_MATCH > end) return { len: 0, dist: 0 };
    const h = hash3(data, pos);
    let cur = head[h];
    let chain = maxChain;
    let bestLen = best;
    let bestDist = 0;
    const limit = pos - WINDOW;
    const maxLen = Math.min(MAX_MATCH, end - pos);
    if (bestLen >= goodLength) chain >>= 2;
    while (cur >= limit && cur >= 0 && chain-- > 0) {
      if (bestLen > 0) {
        if (pos + bestLen >= end) break;
        if (data[cur + bestLen] !== data[pos + bestLen]) { cur = prev[cur]; continue; }
      }
      let len = 0;
      while (len < maxLen && data[cur + len] === data[pos + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = pos - cur;
        if (len >= niceLength) break;
        if (len >= goodLength) chain >>= 2;
      }
      cur = prev[cur];
    }
    return { len: bestLen, dist: bestDist };
  };

  let pos = start;
  while (pos < end) {
    if (pos + MIN_MATCH <= end) {
      const m = longestMatch(pos, 0);
      if (rec !== null && m.len >= MIN_MATCH) {
        const i = pos - rec.base;
        if (rec.len[i] === 0 || m.dist < rec.dist[i]) { rec.len[i] = m.len; rec.dist[i] = m.dist; }
      }
      if (m.len >= MIN_MATCH) {
        if (m.len < maxLazy && pos + 1 + MIN_MATCH <= end) {
          const m2 = longestMatch(pos + 1, 0);
          if (m2.len > m.len) {
            syms.push(data[pos]); dists.push(-1); lenExtra.push(0); distExtra.push(0);
            insert(pos);
            pos++;
            continue;
          }
        }
        const lc = lengthCode(m.len);
        const dc = distCode(m.dist);
        syms.push(257 + lc);
        dists.push(dc);
        lenExtra.push(m.len - LEN_BASE[lc]);
        distExtra.push(m.dist - DIST_BASE[dc]);
        for (let p = pos; p < pos + m.len; p++) insert(p);
        pos += m.len;
        continue;
      }
    }
    syms.push(data[pos]); dists.push(-1); lenExtra.push(0); distExtra.push(0);
    insert(pos);
    pos++;
  }
  return { syms, dists, lenExtra, distExtra };
}

/** Fixed Huffman lengths for literal/length symbols (RFC 1951). */
function fixedLitLengths() {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
}

/** Exact bit cost of encoding `tokens` as one DEFLATE block (min of fixed/dynamic). */
function blockCost(tokens) {
  const { syms, dists } = tokens;
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (let i = 0; i < syms.length; i++) {
    litFreq[syms[i]]++;
    if (dists[i] >= 0) distFreq[dists[i]]++;
  }
  litFreq[256]++;
  let litUsed = 0;
  for (let i = 0; i < 286; i++) if (litFreq[i] > 0) litUsed++;
  if (litUsed < 2) litFreq[0] += 1;
  let distUsed = 0;
  for (let i = 0; i < 30; i++) if (distFreq[i] > 0) distUsed++;
  if (distUsed === 0) { distFreq[0] += 1; distFreq[1] += 1; }
  else if (distUsed === 1) { for (let i = 0; i < 30; i++) if (distFreq[i] === 0) { distFreq[i] += 1; break; } }

  let extraBits = 0;
  for (let i = 0; i < syms.length; i++) {
    if (dists[i] >= 0) extraBits += LEN_EXTRA[syms[i] - 257] + DIST_EXTRA[dists[i]];
  }

  const fixedLens = fixedLitLengths();
  let fixedCost = 3;
  for (let i = 0; i < 286; i++) fixedCost += litFreq[i] * fixedLens[i];
  for (let i = 0; i < 30; i++) fixedCost += distFreq[i] * 5;
  fixedCost += extraBits;

  const litLens = codeLengths(litFreq, 15);
  const distLens = codeLengths(distFreq, 15);
  let hlit = 286;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const allLens = new Uint8Array(hlit + hdist);
  allLens.set(litLens.subarray(0, hlit), 0);
  allLens.set(distLens.subarray(0, hdist), hlit);
  const rle = rleCodeLengths(allLens);
  const clFreq = new Uint32Array(19);
  for (const s of rle.syms) clFreq[s]++;
  let clUsed = 0;
  for (let i = 0; i < 19; i++) if (clFreq[i] > 0) clUsed++;
  if (clUsed < 2) { clFreq[0] += 1; clFreq[1] += 1; }
  const clLens = codeLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
  let dynCost = 3 + 5 + 5 + 4 + 3 * hclen;
  for (let i = 0; i < rle.syms.length; i++) dynCost += clLens[rle.syms[i]] + rle.extraBits[i];
  for (let i = 0; i < 286; i++) dynCost += litFreq[i] * litLens[i];
  for (let i = 0; i < 30; i++) dynCost += distFreq[i] * distLens[i];
  dynCost += extraBits;

  return {
    cost: Math.min(fixedCost, dynCost),
    useFixed: fixedCost <= dynCost,
    litLens, distLens, hlit, hdist, hclen, clLens, rle,
  };
}

/** Encode one block's tokens into writer `w` (dynamic vs fixed by exact bit cost). */
function encodeBlock(w, tokens, isLast) {
  const { syms, dists, lenExtra, distExtra } = tokens;
  const bc = blockCost(tokens);
  const { useFixed, litLens, distLens, hlit, hdist, hclen, clLens, rle } = bc;
  if (useFixed) {
    w.writeBits(isLast ? 1 : 0, 1);
    w.writeBits(1, 2);
    const litCodes = canonicalCodes(fixedLitLengths());
    const distCodes = new Uint32Array(30);
    for (let i = 0; i < 30; i++) distCodes[i] = i;
    for (let i = 0; i < syms.length; i++) {
      w.writeCode(litCodes.codes[syms[i]], litCodes.lens[syms[i]]);
      if (dists[i] >= 0) {
        if (LEN_EXTRA[syms[i] - 257] > 0) w.writeBits(lenExtra[i], LEN_EXTRA[syms[i] - 257]);
        w.writeCode(distCodes[dists[i]], 5);
        if (DIST_EXTRA[dists[i]] > 0) w.writeBits(distExtra[i], DIST_EXTRA[dists[i]]);
      }
    }
    w.writeCode(litCodes.codes[256], litCodes.lens[256]);
    return bc.cost;
  }
  w.writeBits(isLast ? 1 : 0, 1);
  w.writeBits(2, 2);
  w.writeBits(hlit - 257, 5);
  w.writeBits(hdist - 1, 5);
  w.writeBits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.writeBits(clLens[CL_ORDER[i]], 3);
  const litCodes = canonicalCodes(litLens);
  const distCodes = canonicalCodes(distLens);
  const clCodes = canonicalCodes(clLens);
  for (let i = 0; i < rle.syms.length; i++) {
    w.writeCode(clCodes.codes[rle.syms[i]], clCodes.lens[rle.syms[i]]);
    if (rle.extraBits[i] > 0) w.writeBits(rle.extras[i], rle.extraBits[i]);
  }
  for (let i = 0; i < syms.length; i++) {
    w.writeCode(litCodes.codes[syms[i]], litCodes.lens[syms[i]]);
    if (dists[i] >= 0) {
      if (LEN_EXTRA[syms[i] - 257] > 0) w.writeBits(lenExtra[i], LEN_EXTRA[syms[i] - 257]);
      w.writeCode(distCodes.codes[dists[i]], distCodes.lens[dists[i]]);
      if (DIST_EXTRA[dists[i]] > 0) w.writeBits(distExtra[i], DIST_EXTRA[dists[i]]);
    }
  }
  w.writeCode(litCodes.codes[256], litCodes.lens[256]);
  return bc.cost;
}

// ---------------------------------------------------------------- optimal parse
/** Integer (x256) symbol costs from token frequencies, for the DP's cost model. */
function costsFromTokens(tokens) {
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (let i = 0; i < tokens.syms.length; i++) {
    litFreq[tokens.syms[i]]++;
    if (tokens.dists[i] >= 0) distFreq[tokens.dists[i]]++;
  }
  litFreq[256]++;
  const litLens = codeLengths(litFreq, 15);
  const distLens = codeLengths(distFreq, 15);
  const litCost = new Int32Array(286);
  const distCost = new Int32Array(30);
  for (let i = 0; i < 286; i++) litCost[i] = (litLens[i] || 1) * 256;
  for (let i = 0; i < 30; i++) distCost[i] = (distLens[i] || 1) * 256;
  const lenCost = new Int32Array(259);
  for (let l = 3; l <= 258; l++) {
    const c = lengthCode(l);
    lenCost[l] = litCost[257 + c] + LEN_EXTRA[c] * 256;
  }
  const distCodeCost = new Int32Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const c = distCode(d);
    distCodeCost[d] = distCost[c] + DIST_EXTRA[c] * 256;
  }
  return { litCost, lenCost, distCodeCost };
}

// Lengths the DP considers at each position: dense for short matches (alignment),
// then the length-code boundaries, then the maximum.
const DP_LENGTHS = (() => {
  const s = new Set();
  for (let l = 3; l <= 24; l++) s.add(l);
  for (const l of [27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]) s.add(l);
  return [...s].sort((a, b) => a - b);
})();

/**
 * Optimal-parse tokenization of data[start..end) by dynamic programming: the
 * cheapest literal/match sequence under `costs`. At each position the chain walk
 * fills, for every length, the closest distance achieving it; the lazy pass's match
 * at that position is injected at its own distance, so the DP never loses the match
 * the deep lazy search found. Deterministic: fixed chain budget and length set.
 */
function tokenizeOptimal(data, start, end, costs, opts) {
  const maxChain = opts.dpChain !== undefined ? opts.dpChain : 64;
  const n = end - start;
  const dp = new Int32Array(n + 1);
  const prevPos = new Int32Array(n + 1);
  const prevLen = new Int16Array(n + 1);
  const prevDist = new Int32Array(n + 1);
  const INF = 1 << 30;
  for (let i = 0; i <= n; i++) dp[i] = INF;
  dp[0] = 0;
  prevPos[0] = -1;

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.length).fill(-1);
  const insert = (p) => {
    const h = hash3(data, p);
    prev[p] = head[h];
    head[h] = p;
  };
  const seedFrom = Math.max(0, start - WINDOW);
  for (let p = seedFrom; p < start; p++) if (p + 2 < data.length) insert(p);

  const sublen = new Int32Array(259);
  const sublenTag = new Int32Array(259);
  let tag = 0;
  const { litCost, lenCost, distCodeCost } = costs;
  const lazyM = opts.lazyMatches !== undefined ? opts.lazyMatches : null;

  for (let p = start; p < end; p++) {
    const pi = p - start;
    const base = dp[pi];
    if (base >= INF) { insert(p); continue; }
    const litC = base + litCost[data[p]];
    if (litC < dp[pi + 1]) { dp[pi + 1] = litC; prevPos[pi + 1] = pi; prevLen[pi + 1] = 0; prevDist[pi + 1] = 0; }
    if (p + MIN_MATCH <= end) {
      tag++;
      const h = hash3(data, p);
      let cur = head[h];
      let chain = maxChain;
      let bestLen = 0;
      const limit = p - WINDOW;
      const maxLen = Math.min(MAX_MATCH, end - p);
      let lazyLen = 0;
      let lazyDist = 0;
      let lazyDone = true;
      if (lazyM !== null) {
        const li = p - lazyM.base;
        if (li >= 0 && li < lazyM.len.length) {
          lazyLen = lazyM.len[li];
          lazyDist = lazyM.dist[li];
          lazyDone = lazyLen < MIN_MATCH;
        }
      }
      const injectLazy = () => {
        if (lazyLen > bestLen) {
          for (let l = bestLen + 1; l <= lazyLen; l++) { sublen[l] = lazyDist; sublenTag[l] = tag; }
          bestLen = lazyLen;
        }
        lazyDone = true;
      };
      while (cur >= limit && cur >= 0 && chain-- > 0) {
        const dist = p - cur;
        if (!lazyDone && dist > lazyDist) injectLazy();
        if (bestLen > 0) {
          if (p + bestLen >= end) break;
          if (data[cur + bestLen] !== data[p + bestLen]) { cur = prev[cur]; continue; }
        }
        let len = 0;
        while (len < maxLen && data[cur + len] === data[p + len]) len++;
        if (len > bestLen) {
          for (let l = bestLen + 1; l <= len; l++) { sublen[l] = dist; sublenTag[l] = tag; }
          bestLen = len;
          if (len >= MAX_MATCH) break;
        }
        cur = prev[cur];
      }
      if (!lazyDone) injectLazy();
      if (bestLen >= MIN_MATCH) {
        for (const l of DP_LENGTHS) {
          if (l > bestLen) break;
          const d = sublenTag[l] === tag ? sublen[l] : 0;
          if (d === 0) continue;
          const c = base + lenCost[l] + distCodeCost[d];
          const ni = pi + l;
          if (c < dp[ni]) { dp[ni] = c; prevPos[ni] = pi; prevLen[ni] = l; prevDist[ni] = d; }
        }
        if (!DP_LENGTHS.includes(bestLen)) {
          const d = sublenTag[bestLen] === tag ? sublen[bestLen] : 0;
          if (d > 0) {
            const c = base + lenCost[bestLen] + distCodeCost[d];
            if (c < dp[pi + bestLen]) { dp[pi + bestLen] = c; prevPos[pi + bestLen] = pi; prevLen[pi + bestLen] = bestLen; prevDist[pi + bestLen] = d; }
          }
        }
      }
    }
    insert(p);
  }

  const rev = [];
  let j = n;
  while (j > 0) {
    const i = prevPos[j];
    if (i < 0) throw new Error('DP backtrack failed at ' + j);
    const l = prevLen[j];
    if (l === 0) rev.push({ lit: data[start + i] });
    else rev.push({ len: l, dist: prevDist[j] });
    j = i;
  }
  rev.reverse();
  const syms = [];
  const dists = [];
  const lenExtra = [];
  const distExtra = [];
  for (const t of rev) {
    if (t.lit !== undefined) {
      syms.push(t.lit); dists.push(-1); lenExtra.push(0); distExtra.push(0);
    } else {
      const lc = lengthCode(t.len);
      const dc = distCode(t.dist);
      syms.push(257 + lc);
      dists.push(dc);
      lenExtra.push(t.len - LEN_BASE[lc]);
      distExtra.push(t.dist - DIST_BASE[dc]);
    }
  }
  return { syms, dists, lenExtra, distExtra };
}

/**
 * Best-of-both deflate: per block, tokenize lazily, then run the seeded optimal
 * parse; keep the token set with the smaller exact block cost, so the DP can never
 * hurt a block. One lazy pass per block; the DP reuses its recorded matches.
 * Fixed effort counts only (blockSize, dpChain, iterations) — no clock.
 */
function deflateBest(data, opts) {
  const blockSize = opts.blockSize !== undefined ? opts.blockSize : 524288;
  const iterations = opts.iterations !== undefined ? opts.iterations : 1;
  const w = new BitWriter(data.length + 65536);
  w.ensure(2);
  w.buf[w.pos++] = 0x78;
  w.buf[w.pos++] = 0xda;
  const bounds = [];
  if (blockSize > 0) {
    for (let s = 0; s < data.length; s += blockSize) bounds.push([s, Math.min(data.length, s + blockSize)]);
  } else bounds.push([0, data.length]);
  for (let b = 0; b < bounds.length; b++) {
    const [s, e] = bounds[b];
    const recLen = new Int32Array(e - s);
    const recDist = new Int32Array(e - s);
    const rec = { len: recLen, dist: recDist, base: s };
    let tokens = tokenizeLazy(data, s, e, { ...opts, recordMatches: rec });
    let bestTokens = tokens;
    let bestCost = blockCost(tokens).cost;
    for (let it = 0; it < iterations; it++) {
      const costs = costsFromTokens(tokens);
      tokens = tokenizeOptimal(data, s, e, costs, { ...opts, lazyMatches: rec });
      const c = blockCost(tokens).cost;
      if (c < bestCost) { bestCost = c; bestTokens = tokens; }
    }
    encodeBlock(w, bestTokens, b === bounds.length - 1);
  }
  const body = w.bytes();
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  const a = adler32(data);
  out[body.length] = (a >>> 24) & 0xff;
  out[body.length + 1] = (a >>> 16) & 0xff;
  out[body.length + 2] = (a >>> 8) & 0xff;
  out[body.length + 3] = a & 0xff;
  return out;
}

// ---------------------------------------------------------------- driver
const LAZY_OPTS = { maxChain: 4096, maxLazy: 258, goodLength: 1000000 };
const SCREEN_LEVEL = 6;
const BLOCK_SIZE = 524288;
const DP_CHAIN = 32;
const DP_ITERATIONS = 1;

/**
 * Encode one RGBA image (width x height) as a PNG: screen every exact form and
 * filter choice by zlib level 6, then write the winner with the best-of deflate.
 */
function encodeImage(rgba, width, height) {
  const forms = formsOf(rgba);
  const weigh = (d) => deflateSync(d, { level: SCREEN_LEVEL, memLevel: 8 });
  let best = null;
  for (const form of forms) {
    const chunks = (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
    let model = null;
    if (form.filters.includes('entropy')) model = entropyModelOf(filtered(form.samples, width, height, form.bpp, 'minsum'));
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, model);
      const z = weigh(data);
      const bytes = z.length + chunks;
      if (!best || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  const idat = deflateBest(best.data, { ...LAZY_OPTS, blockSize: BLOCK_SIZE, iterations: DP_ITERATIONS, dpChain: DP_CHAIN });
  const chunks = [['IHDR', ihdrOf(width, height, best.form.colourType)]];
  if (best.form.plte) chunks.push(['PLTE', best.form.plte]);
  if (best.form.trns) chunks.push(['tRNS', best.form.trns]);
  chunks.push(['IDAT', new Uint8Array(idat)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR !== undefined ? process.env.MAKEFUN_INPUT_DIR : '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR !== undefined ? process.env.MAKEFUN_OUTPUT_DIR : '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const inPath = join(INPUT_DIR, id, 'image.png');
  if (!existsSync(inPath) || !statSync(inPath).isFile()) continue;
  const image = decodePng(new Uint8Array(readFileSync(inPath)));
  const out = encodeImage(image.rgba, image.width, image.height);
  const outDir = join(OUTPUT_DIR, id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'image.png'), out);
}
