// ev-scan.mjs の「単勝オッズ→暗黙勝率→FLバイアス補正→Harville展開→EV」ロジックを、
// scripts/odds-hist.local.json(過去の最終オッズ、単複のみ、8,769R)× scripts/payouts.local.json
// (実際の払戻、8,453R)に適用し、「EVが高いと判定した買い目は実際に儲かっていたか」を検証する
// 実現P&Lバックテスト。クロールなし・ローカル計算のみ。
//
// ⚠️ このデータでバックテストできるのは単勝・複勝のみ。odds-hist.local.jsonは全頭の単複オッズを
//   持つが、ワイド/馬連/3連複/3連単は「当たった組み合わせの払戻」しかpayouts.local.jsonに無く、
//   外れた組み合わせの事前オッズが分からないため、券種横断のEV検証はできない(別データが必要)。
//
// 使い方(プロジェクト直下で):
//   node scripts/ev-backtest.mjs                    … 単複、EV帯別の実現回収率
//   node scripts/ev-backtest.mjs --raw               … FLバイアス補正なし(ev-scanの生EV)
//   node scripts/ev-backtest.mjs --bootstrap 2000     … ブートストラップ回数を変更(既定2000)
//   node scripts/ev-backtest.mjs --min-n 8            … 頭数フィルタ(既定8、ev-scanと揃える)

import fs from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const RAW = args.includes("--raw");
const BOOTSTRAP = Number(argOf("--bootstrap", "2000"));
const MIN_N = Number(argOf("--min-n", "8"));

// ---- CALIB・harville: scripts/ev-scan.mjs と同一ロジック(変更時は要同期) ----
// 出典・根拠は ev-scan.mjs のコメント参照(pool-bias-check.mjs 8,453R確定値)。
const CALIB = [
  { maxRank: 3, factor: 1.0 },
  { maxRank: 6, factor: 0.94 },
  { maxRank: 9, factor: 1.0 },
  { maxRank: Infinity, factor: 0.78 },
];
const calibFactor = (rank) => CALIB.find((c) => rank <= c.maxRank).factor;

function harvilleTop3In(p) {
  const ids = Object.keys(p).map(Number);
  const top3In = new Map(ids.map((i) => [i, 0]));
  for (const a of ids) {
    for (const b of ids) {
      if (b === a) continue;
      const pab = p[a] * (p[b] / (1 - p[a]));
      for (const c of ids) {
        if (c === a || c === b) continue;
        const pabc = pab * (p[c] / (1 - p[a] - p[b]));
        top3In.set(a, top3In.get(a) + pabc);
        top3In.set(b, top3In.get(b) + pabc);
        top3In.set(c, top3In.get(c) + pabc);
      }
    }
  }
  return top3In;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- EV帯 ----
const BUCKETS = [
  { label: "<0.8", lo: -Infinity, hi: 0.8 },
  { label: "0.8-0.9", lo: 0.8, hi: 0.9 },
  { label: "0.9-1.0", lo: 0.9, hi: 1.0 },
  { label: "1.0-1.1", lo: 1.0, hi: 1.1 },
  { label: "1.1-1.3", lo: 1.1, hi: 1.3 },
  { label: "1.3-1.6", lo: 1.3, hi: 1.6 },
  { label: "1.6+", lo: 1.6, hi: Infinity },
];
const bucketIdx = (ev) => BUCKETS.findIndex((b) => ev >= b.lo && ev < b.hi);

// ---- データ読み込み・突き合わせ ----
const oddsHist = JSON.parse(fs.readFileSync(new URL("./odds-hist.local.json", import.meta.url), "utf-8"));
const payouts = JSON.parse(fs.readFileSync(new URL("./payouts.local.json", import.meta.url), "utf-8"));

let usedRaces = 0;
let skippedThin = 0;
let skippedN = 0;
const perRace = []; // { winBuckets: [{bets,ret}], placeBuckets: [{bets,ret}] }

for (const key of Object.keys(oddsHist)) {
  const oh = oddsHist[key];
  const po = payouts[key];
  if (!po) continue; // payoutsクロール未到達 or 除外レース
  const entries = Object.entries(oh.horses).filter(([, h]) => h.tan != null && h.tan > 0);
  if (entries.length < MIN_N) {
    skippedN++;
    continue;
  }
  // データ異常検知(複勝下限が単勝を上回る=取得タイミングの不整合)
  const anomaly = entries.some(([, h]) => h.fukuMin != null && h.fukuMin > h.tan);
  if (anomaly) {
    skippedThin++;
    continue;
  }

  const inv = entries.map(([u, h]) => [Number(u), 1 / h.tan]);
  const overround = inv.reduce((a, [, v]) => a + v, 0);
  const p = Object.fromEntries(inv.map(([u, v]) => [u, v / overround]));
  if (!RAW) {
    const ranked = [...entries].sort((a, b) => a[1].tan - b[1].tan);
    ranked.forEach(([u], i) => {
      p[Number(u)] *= calibFactor(i + 1);
    });
    const Zc = Object.values(p).reduce((a, b) => a + b, 0);
    for (const u of Object.keys(p)) p[u] /= Zc;
  }
  const top3In = harvilleTop3In(p);

  const winYen = new Map((po.payouts.win ?? []).map((x) => [String(x.num), x.yen]));
  const placeYen = new Map((po.payouts.place ?? []).map((x) => [String(x.num), x.yen]));

  const winBuckets = BUCKETS.map(() => ({ bets: 0, ret: 0 }));
  const placeBuckets = BUCKETS.map(() => ({ bets: 0, ret: 0 }));

  for (const [u, h] of entries) {
    const num = String(u);
    // 単勝
    const evWin = p[Number(u)] * h.tan;
    const bi = bucketIdx(evWin);
    if (bi >= 0) {
      winBuckets[bi].bets++;
      winBuckets[bi].ret += winYen.get(num) ?? 0;
    }
    // 複勝(下限オッズで保守的に、ev-scanと同じ扱い)
    if (h.fukuMin != null) {
      const evPlace = top3In.get(Number(u)) * h.fukuMin;
      const pi = bucketIdx(evPlace);
      if (pi >= 0) {
        placeBuckets[pi].bets++;
        placeBuckets[pi].ret += placeYen.get(num) ?? 0;
      }
    }
  }
  perRace.push({ winBuckets, placeBuckets });
  usedRaces++;
}

console.log(
  `■ EV実現P&Lバックテスト  対象${usedRaces}R(odds-hist${Object.keys(oddsHist).length}R × payouts${Object.keys(payouts).length}R突き合わせ、` +
    `頭数<${MIN_N}除外${skippedN}R・データ異常除外${skippedThin}R)`,
);
console.log(
  RAW
    ? "  補正: なし(--raw。ev-scanの生EVをそのまま検証)"
    : `  補正: favorite-longshot bias実測補正あり(ev-scan.mjsと同一CALIB)`,
);

function bootstrapCI(field, bucketI, betType) {
  if (BOOTSTRAP <= 0) return null;
  const rand = mulberry32(42);
  const n = perRace.length;
  const rates = new Array(BOOTSTRAP);
  for (let b = 0; b < BOOTSTRAP; b++) {
    let ret = 0;
    let bets = 0;
    for (let i = 0; i < n; i++) {
      const st = perRace[(rand() * n) | 0][betType][bucketI];
      ret += st.ret;
      bets += st.bets;
    }
    rates[b] = bets > 0 ? ret / (bets * 100) : NaN;
  }
  const valid = rates.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (valid.length < BOOTSTRAP * 0.5) return null;
  return [valid[Math.floor(0.025 * valid.length)], valid[Math.min(valid.length - 1, Math.floor(0.975 * valid.length))]];
}

function printTable(betType, title) {
  console.log(`\n===== ${title} =====`);
  console.log("EV帯      点数     的中     回収率    95%CI");
  for (let i = 0; i < BUCKETS.length; i++) {
    let bets = 0;
    let ret = 0;
    let hits = 0;
    for (const r of perRace) {
      bets += r[betType][i].bets;
      ret += r[betType][i].ret;
      hits += r[betType][i].ret > 0 ? 1 : 0; // 概算(複数的中を1件扱いしない粗い集計は下のhitsで別途)
    }
    if (bets === 0) continue;
    const rate = ((ret / (bets * 100)) * 100).toFixed(1) + "%";
    const ci = bootstrapCI(null, i, betType);
    const ciTxt = ci ? `[${(ci[0] * 100).toFixed(1)},${(ci[1] * 100).toFixed(1)}]` : "-";
    console.log(`${BUCKETS[i].label.padEnd(9)} ${String(bets).padStart(6)}  ${String(hits).padStart(6)}  ${rate.padStart(7)}  ${ciTxt}`);
  }
}

printTable("winBuckets", "単勝: EV帯別 実現回収率(100円均等買い)");
printTable("placeBuckets", "複勝: EV帯別 実現回収率(100円均等買い、オッズ下限)");

// EV>=1.0 vs EV<1.0 の単純比較(核心の問いへの直接回答)
function summarize(betType, pred) {
  let bets = 0;
  let ret = 0;
  for (const r of perRace) {
    for (let i = 0; i < BUCKETS.length; i++) {
      if (!pred(BUCKETS[i])) continue;
      bets += r[betType][i].bets;
      ret += r[betType][i].ret;
    }
  }
  return { bets, ret, rate: bets > 0 ? ret / (bets * 100) : null };
}
function bootstrapCombinedCI(betType, idxSet) {
  if (BOOTSTRAP <= 0) return null;
  const rand = mulberry32(42);
  const n = perRace.length;
  const rates = new Array(BOOTSTRAP);
  for (let b = 0; b < BOOTSTRAP; b++) {
    let ret = 0;
    let bets = 0;
    for (let i = 0; i < n; i++) {
      const race = perRace[(rand() * n) | 0];
      for (const idx of idxSet) {
        ret += race[betType][idx].ret;
        bets += race[betType][idx].bets;
      }
    }
    rates[b] = bets > 0 ? ret / (bets * 100) : NaN;
  }
  const valid = rates.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (valid.length < BOOTSTRAP * 0.5) return null;
  return [valid[Math.floor(0.025 * valid.length)], valid[Math.min(valid.length - 1, Math.floor(0.975 * valid.length))]];
}

console.log("\n===== 核心の問い: EV>=1.0で買ったら実際に儲かっていたか =====");
const hiIdx = BUCKETS.map((b, i) => (b.lo >= 1.0 ? i : null)).filter((i) => i != null);
const loIdx = BUCKETS.map((b, i) => (b.lo < 1.0 ? i : null)).filter((i) => i != null);
for (const [label, betType] of [
  ["単勝", "winBuckets"],
  ["複勝", "placeBuckets"],
]) {
  const hi = summarize(betType, (b) => b.lo >= 1.0);
  const lo = summarize(betType, (b) => b.lo < 1.0);
  const hiCI = bootstrapCombinedCI(betType, hiIdx);
  const loCI = bootstrapCombinedCI(betType, loIdx);
  const ciTxt = (ci) => (ci ? `95%CI[${(ci[0] * 100).toFixed(1)},${(ci[1] * 100).toFixed(1)}]` : "-");
  console.log(
    `${label}  EV>=1.0: 点数${hi.bets} 回収率${hi.rate != null ? (hi.rate * 100).toFixed(1) + "%" : "-"} ${ciTxt(hiCI)}` +
      `  |  EV<1.0: 点数${lo.bets} 回収率${lo.rate != null ? (lo.rate * 100).toFixed(1) + "%" : "-"} ${ciTxt(loCI)}`,
  );
}
