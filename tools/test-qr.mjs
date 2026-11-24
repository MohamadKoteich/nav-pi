// PN-41: checks features/nav/qrcode.js with a small QR *decoder* written here from the standard (ISO/IEC 18004),
// not sharing the encoder's code: finder/timing patterns, both format-info copies (BCH-valid, level M), version
// info (v7+), unmask, zigzag read, de-interleave, Reed-Solomon syndromes all zero, byte-mode payload == input.
//   node tools/test-qr.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const QR = require("../features/nav/qrcode.js");
let fails = 0;
const check = (name, ok) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name); };

// GF(256) for the syndromes
const EXP = [], LOG = [];
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
const gmul = (a, b) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);
const syndromesZero = (cw, nec) => {
  for (let i = 0; i < nec; i++) { let s = 0; for (const c of cw) s = gmul(s, EXP[i]) ^ c; if (s) return false; }
  return true;
};
// level M block table, read from the standard's table 9 (independent copy)
const TABLE = { 1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]] };
const ALIGN = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

function decode(q) {
  const n = q.size, v = (n - 17) / 4, M = (x, y) => (q.get(x, y) ? 1 : 0);
  // finder patterns: 7x7 ring/core at three corners
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
    if (M(ox + x, oy + y) !== (d === 2 ? 0 : 1)) throw new Error("finder");
  }
  for (let i = 8; i < n - 8; i++) if (M(i, 6) !== (i % 2 ? 0 : 1) || M(6, i) !== (i % 2 ? 0 : 1)) throw new Error("timing");
  // format info, both copies; valid code words = BCH(15,5) with 0x537, xor 0x5412
  const fmtA = [], fmtB = [];
  for (let i = 0; i <= 5; i++) fmtA.push(M(8, i));
  fmtA.push(M(8, 7), M(8, 8), M(7, 8));
  for (let i = 9; i < 15; i++) fmtA.push(M(14 - i, 8));
  for (let i = 0; i < 8; i++) fmtB.push(M(n - 1 - i, 8));
  for (let i = 8; i < 15; i++) fmtB.push(M(8, n - 15 + i));
  const val = bits => bits.reduce((a, b, i) => a | (b << i), 0);
  if (val(fmtA) !== val(fmtB)) throw new Error("format copies differ");
  const f = val(fmtA) ^ 0x5412, data = f >> 10;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  if ((((data << 10) | (rem & 0x3ff))) !== f) throw new Error("format BCH");
  if (data >> 3 !== 0) throw new Error("level is not M");
  const mask = data & 7;
  if (M(8, n - 8) !== 1) throw new Error("dark module");
  if (v >= 7) {
    let bits = 0;
    for (let i = 0; i < 18; i++) bits |= M(n - 11 + (i % 3), Math.floor(i / 3)) << i;
    if (bits >> 12 !== v) throw new Error("version info");
  }
  // which modules are function patterns
  const fn = (x, y) => {
    if ((x < 9 && y < 9) || (x >= n - 8 && y < 9) || (x < 9 && y >= n - 8)) return true;
    if (x === 6 || y === 6) return true;
    if (v >= 7 && ((x >= n - 11 && y < 6) || (y >= n - 11 && x < 6))) return true;
    const al = ALIGN[v] || [];
    for (const ax of al) for (const ay of al) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === al.at(-1)) || (ax === al.at(-1) && ay === 6)) continue;
      if (Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2) return true;
    }
    return false;
  };
  const cond = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0][mask];
  // zigzag: column pairs from the right, upwards first, skipping the timing column
  const bits = [];
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < n; k++) {
      const y = up ? n - 1 - k : k;
      for (const x of [col, col - 1]) if (!fn(x, y)) bits.push(M(x, y) ^ (cond(x, y) ? 1 : 0));
    }
    up = !up;
  }
  const [nec, groups] = TABLE[v], blocks = [];
  for (const [cnt, len] of groups) for (let i = 0; i < cnt; i++) blocks.push({ len, d: [], e: [] });
  const total = blocks.reduce((a, b) => a + b.len + nec, 0);
  const cw = [];
  for (let i = 0; i < total; i++) { let c = 0; for (let k = 0; k < 8; k++) c = (c << 1) | bits[i * 8 + k]; cw.push(c); }
  let p = 0;
  const maxLen = Math.max(...blocks.map(b => b.len));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.len) b.d.push(cw[p++]);
  for (let i = 0; i < nec; i++) for (const b of blocks) b.e.push(cw[p++]);
  for (const b of blocks) if (!syndromesZero(b.d.concat(b.e), nec)) throw new Error("RS syndromes");
  const data_ = blocks.flatMap(b => b.d), bs = data_.flatMap(c => [...c.toString(2).padStart(8, "0")].map(Number));
  const rd = (o, k) => bs.slice(o, o + k).reduce((a, b) => a * 2 + b, 0);
  if (rd(0, 4) !== 4) throw new Error("not byte mode");
  const cc = v < 10 ? 8 : 16, len = rd(4, cc), out = [];
  for (let i = 0; i < len; i++) out.push(rd(4 + cc + 8 * i, 8));
  return { text: new TextDecoder().decode(new Uint8Array(out)), v, mask };
}

const cases = ["a", "geo:48.138640,11.573610?q=48.138640,11.573610(Frauenkirche%20M%C3%BCnchen)",
  "https://www.openstreetmap.org/?mlat=53.550300&mlon=10.000600#map=17/53.550300/10.000600",
  "https://www.google.com/maps/search/?api=1&query=-33.856784,151.215297", "Ærøskøbing – Straße ✓ " + "x".repeat(60),
  "y".repeat(150), "z".repeat(213)];
const seen = new Set();
for (const t of cases) {
  try {
    const q = QR.encode(t), r = decode(q);
    seen.add(r.v); seen.add("m" + r.mask);
    check(`v${r.v} mask ${r.mask} (${new TextEncoder().encode(t).length} bytes) decodes to the input`, r.text === t);
  } catch (e) { check("decode " + t.slice(0, 30) + ": " + e.message, false); }
}
// every mask pattern at least once: force them by encoding many strings
for (let i = 0; i < 400 && [...seen].filter(s => String(s).startsWith("m")).length < 8; i++) {
  const t = "nav-pi " + i * 7919, q = QR.encode(t), r = decode(q);
  if (r.text !== t) { check("mask " + r.mask + " round trip", false); break; }
  seen.add("m" + r.mask);
}
check("all 8 masks seen and decoded: " + [...seen].filter(s => String(s).startsWith("m")).sort().join(" "), [...seen].filter(s => String(s).startsWith("m")).length === 8);
let tooLong = false;
try { QR.encode("w".repeat(214)); } catch (e) { tooLong = /too long/.test(e.message); }
check("214 bytes refused with a clear error", tooLong);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
