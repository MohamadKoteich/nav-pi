/* nav-pi QR code encoder (PN-41), written for this app — no library, no network.
   QRCode.encode(text) -> {size, get(x, y)}: byte mode (UTF-8), error correction level M, versions 1-10
   (up to 213 bytes), mask chosen by the standard penalty rules (ISO/IEC 18004). QRCode.svg(text) -> SVG markup.
   Also loads in node (tools/test-qr.mjs checks it against an independent decoder written there). */
"use strict";
const QRCode = (() => {
  // level M per version: [EC codewords per block, blocks in group 1, data codewords each, group 2 blocks, data each]
  const BLOCKS = [null, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function rsGen(n) {           // (x - a^0)(x - a^1)...(x - a^(n-1)), highest power first
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }
  function rsRemainder(data, n) {
    const g = rsGen(n), r = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ r.shift(); r.push(0);
      for (let j = 0; j < n; j++) r[j] ^= mul(g[j + 1], f);
    }
    return r;
  }
  function utf8(s) { return Array.from(new TextEncoder().encode(s)); }
  const dataCw = v => { const b = BLOCKS[v]; return b[1] * b[2] + b[3] * b[4]; };

  function codewords(bytes) {
    let v = 1;
    while (v <= 10 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataCw(v) * 8) v++;
    if (v > 10) throw new Error("QR: text too long (" + bytes.length + " bytes, at most 213)");
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    const cap = dataCw(v) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let p = 0; data.length < dataCw(v); p ^= 1) data.push(p ? 0x11 : 0xec);
    // split into blocks, add the error correction, interleave
    const [ec, n1, d1, n2, d2] = BLOCKS[v], blocks = [];
    let k = 0;
    for (let i = 0; i < n1 + n2; i++) {
      const len = i < n1 ? d1 : d2, d = data.slice(k, k + len); k += len;
      blocks.push({ d, e: rsRemainder(d, ec) });
    }
    const out = [];
    for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
    return { v, out };
  }

  function encode(text) {
    const { v, out } = codewords(utf8(text));
    const size = 17 + 4 * v;
    const mod = [...Array(size)].map(() => new Array(size).fill(false));
    const fn = [...Array(size)].map(() => new Array(size).fill(false));
    const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = ALIGN[v];
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const format = mask => {
      const data = (0 << 3) | mask;   // level M = 00
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412, b = i => ((bits >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, b(i));
      set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
      set(8, size - 8, true);   // the dark module
    };
    format(0);
    if (v >= 7) {
      let rem = v;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (v << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
        set(a, c, dark); set(c, a, dark);
      }
    }
    // data in the two-column zigzag, bottom right first, column 6 (timing) skipped
    let bit = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && bit < out.length * 8) { mod[y][x] = ((out[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1; bit++; }
      }
    }
    const MASKS = [(x, y) => (x + y) % 2, (x, y) => y % 2, x => x % 3, (x, y) => (x + y) % 3,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2, (x, y) => (x * y) % 2 + (x * y) % 3,
      (x, y) => ((x * y) % 2 + (x * y) % 3) % 2, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2];
    const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y) === 0) mod[y][x] = !mod[y][x]; };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); format(m);
      const s = penalty(mod, size);
      if (s < bestScore) { bestScore = s; best = m; }
      applyMask(m);   // xor again = undo
    }
    applyMask(best); format(best);
    return { size, version: v, mask: best, get: (x, y) => mod[y][x] };
  }

  function penalty(m, n) {
    let s = 0, dark = 0;
    const line = get => {   // runs of 5+ and finder-like 1011101 with 4 light on a side
      let run = 1, r = 0;
      for (let i = 1; i < n; i++) {
        if (get(i) === get(i - 1)) { run++; if (run === 5) r += 3; else if (run > 5) r++; } else run = 1;
      }
      for (let i = 0; i + 6 < n; i++) {
        if (get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6)) {
          const light = (a, b) => { for (let k = a; k < b; k++) if (k >= 0 && k < n && get(k)) return false; return true; };
          if (light(i - 4, i) || light(i + 7, i + 11)) r += 40;
        }
      }
      return r;
    };
    for (let y = 0; y < n; y++) s += line(x => m[y][x]);
    for (let x = 0; x < n; x++) s += line(y => m[y][x]);
    for (let y = 0; y + 1 < n; y++) for (let x = 0; x + 1 < n; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) s += 3;
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) dark++;
    const total = n * n;
    s += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return s;
  }

  // SVG with a 4-module quiet zone; one path, crisp at any size
  function svg(text, fg = "#000", bg = "#fff") {
    const q = encode(text), n = q.size + 8;
    let d = "";
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.get(x, y)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>`;
  }
  return { encode, svg, rsRemainder };
})();
if (typeof module !== "undefined") module.exports = QRCode;
