// 人気帯別の単勝・複勝回収率を実際の払戻(scripts/payouts.local.json)から実測するスクリプト。
// クロールなし(payouts.local.jsonとSupabase読み取りのみ)。フェーズ4C: オッズの歪み検証の第一歩。
//
// 目的: favorite-longshot bias(人気薄の単勝は過剰に買われ回収率が低い、という世界的に知られる歪み)が
// うちのデータでも観測できるか、そして「大穴側の複勝は単勝ほど歪んでいない(=相対的に過小評価)」
// という仮説が成り立つかを、理論値ではなく実際の払戻で確かめる。
//
// 方法: 各レースの出走馬(取消・除外を除く)全頭に人気帯ごとに単勝/複勝を100円ずつ買ったと仮定し、
// 帯ごとの回収率 = Σ的中払戻 / (100円 × 購入点数) を集計。的中判定は payouts の num リスト
// (複勝2着払いの少頭数レースも払戻データがそのまま正解になる)。
// 回収率は少数の大穴的中に引っ張られるため([[keiba-app-payout-concentration]]の教訓)、
// 最高払戻1件を除いた回収率と、レース単位ブートストラップの95%CIを併記する。
//
// 使い方(プロジェクト直下で):
//   node scripts/pool-bias-check.mjs
//   node scripts/pool-bias-check.mjs --graded-only     # 重賞のみ
//   node scripts/pool-bias-check.mjs --bootstrap 10000 # CI付き(既定10000、0で省略)
//   node scripts/pool-bias-check.mjs --by dist         # 距離別(dist/going/field/all、カンマ区切り可)
//     ※分割するとセルあたりのサンプルが小さくなる。点推定でなくCIで判断すること。

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const GRADED_ONLY = args.includes("--graded-only");
const NONGRADED_ONLY = args.includes("--nongraded-only"); // 平場・条件戦のみ(重賞との歪みの違いを見る用)
const BOOTSTRAP = Number(argOf("--bootstrap", "10000"));
const BY = argOf("--by", null); // dist / going / field / all(カンマ区切り可)

try {
  process.loadEnvFile(".env");
} catch {}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const payouts = JSON.parse(fs.readFileSync(new URL("./payouts.local.json", import.meta.url).pathname, "utf-8"));
const resultIds = Object.keys(payouts).map(Number);
console.log(`払戻データ ${resultIds.length}レース分をロード`);

// ---- DBから人気・着順・馬番を取得 ----
// ⚠️ Supabaseは1クエリ1000行上限。in句は60レース(≒840頭)ずつに分割([[keiba-app-phase4k-legstyle]]の教訓)
const byResult = new Map();
const CHUNK = 60;
for (let i = 0; i < resultIds.length; i += CHUNK) {
  const { data, error } = await supabase
    .from("result_horses")
    .select("result_id, umaban, popularity, place, place_text")
    .in("result_id", resultIds.slice(i, i + CHUNK));
  if (error) {
    console.error("DB読み取りエラー(result_horses):", error.message);
    process.exit(1);
  }
  for (const h of data) {
    if (!byResult.has(h.result_id)) byResult.set(h.result_id, []);
    byResult.get(h.result_id).push(h);
  }
}
// レースメタ(重賞フィルタ・期間表示用)
const raceMeta = new Map();
for (let i = 0; i < resultIds.length; i += CHUNK) {
  const { data, error } = await supabase
    .from("race_results")
    .select("id, date, grade, name, surface, distance, going")
    .in("id", resultIds.slice(i, i + CHUNK));
  if (error) {
    console.error("DB読み取りエラー(race_results):", error.message);
    process.exit(1);
  }
  for (const r of data) raceMeta.set(r.id, r);
}

// ---- 集計 ----
const BANDS = [
  { label: "1番人気 ", test: (p) => p === 1 },
  { label: "2-3人気 ", test: (p) => p >= 2 && p <= 3 },
  { label: "4-6人気 ", test: (p) => p >= 4 && p <= 6 },
  { label: "7-9人気 ", test: (p) => p >= 7 && p <= 9 },
  { label: "10人気〜", test: (p) => p >= 10 },
  { label: "全部   ", test: () => true },
];
const isJump = (m) => String(m?.grade ?? "").startsWith("J") || m?.surface === "障" || /障害/.test(String(m?.name ?? ""));

// レースごとに帯別の {bets, winRet, placeRet, winHits, placeHits} を作る(ブートストラップの単位)
const perRace = []; // { bandStats: [ {bets,winRet,placeRet,winHits,placeHits} x BANDS ] }
let usedRaces = 0;
let minDate = "9999";
let maxDate = "0000";
for (const rid of resultIds) {
  const meta = raceMeta.get(rid);
  const horses = byResult.get(rid);
  if (!meta || !horses || isJump(meta)) continue;
  if (GRADED_ONLY && !meta.grade) continue;
  if (NONGRADED_ONLY && meta.grade) continue;
  const pay = payouts[rid]?.payouts;
  if (!pay?.win?.length) continue;
  const winYen = new Map(pay.win.map((x) => [Number(x.num), x.yen]));
  const placeYen = new Map((pay.place ?? []).map((x) => [Number(x.num), x.yen]));
  const runners = horses.filter((h) => !/[取除]/.test(h.place_text ?? "") && h.popularity != null && h.umaban != null);
  if (runners.length < 5) continue;
  usedRaces++;
  if (meta.date < minDate) minDate = meta.date;
  if (meta.date > maxDate) maxDate = meta.date;
  const bandStats = BANDS.map(() => ({ bets: 0, winRet: 0, placeRet: 0, winHits: 0, placeHits: 0 }));
  for (const h of runners) {
    BANDS.forEach((b, bi) => {
      if (!b.test(h.popularity)) return;
      const st = bandStats[bi];
      st.bets++;
      const wy = winYen.get(h.umaban);
      if (wy != null) {
        st.winRet += wy;
        st.winHits++;
      }
      const py = placeYen.get(h.umaban);
      if (py != null) {
        st.placeRet += py;
        st.placeHits++;
      }
    });
  }
  perRace.push({ bandStats, meta: { distance: meta.distance, going: meta.going, fieldSize: runners.length } });
}
console.log(
  `集計対象 ${usedRaces}レース(平地のみ${GRADED_ONLY ? "・重賞のみ" : ""}${NONGRADED_ONLY ? "・非重賞のみ" : ""}、期間 ${minDate}〜${maxDate})\n`,
);

// ---- ブートストラップ(レース単位、シード固定で再現可能) ----
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
function bootstrapCI(sub, bandIdx, field) {
  if (BOOTSTRAP <= 0) return null;
  const rand = mulberry32(42);
  const n = sub.length;
  const means = new Array(BOOTSTRAP);
  for (let b = 0; b < BOOTSTRAP; b++) {
    let ret = 0;
    let bets = 0;
    for (let i = 0; i < n; i++) {
      const st = sub[(rand() * n) | 0].bandStats[bandIdx];
      ret += st[field];
      bets += st.bets;
    }
    means[b] = bets > 0 ? ret / (bets * 100) : 0; // 回収率(1.0=100%)
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * BOOTSTRAP)], means[Math.min(BOOTSTRAP - 1, Math.floor(0.975 * BOOTSTRAP))]];
}

// ---- レポート(subに対して帯別テーブルを印字。--byの分割でも同じ関数を使う) ----
// 回収率 = Σ払戻円 / (100円×点数)。「top1除外」は最高払戻1件を除いた回収率(大穴1発の寄与を確認する用)
function printBandTable(sub, title, { collectCalib = false } = {}) {
  const winCalib = [];
  console.log(`===== 人気帯別の実測回収率(100円均等買い)${title} n=${sub.length}R =====`);
  console.log("帯        点数    単勝的中  単勝回収率(top1除外)  95%CI          複勝的中  複勝回収率(top1除外)  95%CI");
  BANDS.forEach((b, bi) => {
    const tot = { bets: 0, winRet: 0, placeRet: 0, winHits: 0, placeHits: 0 };
    const winList = [];
    const placeList = [];
    for (const r of sub) {
      const st = r.bandStats[bi];
      tot.bets += st.bets;
      tot.winRet += st.winRet;
      tot.placeRet += st.placeRet;
      tot.winHits += st.winHits;
      tot.placeHits += st.placeHits;
      if (st.winRet > 0) winList.push(st.winRet);
      if (st.placeRet > 0) placeList.push(st.placeRet);
    }
    if (tot.bets === 0) return;
    const rate = (ret) => ((ret / (tot.bets * 100)) * 100).toFixed(1) + "%";
    const rateExTop = (ret, list) =>
      (((ret - (list.length ? Math.max(...list) : 0)) / (tot.bets * 100)) * 100).toFixed(1) + "%";
    const ciTxt = (ci) => (ci ? `[${(ci[0] * 100).toFixed(1)},${(ci[1] * 100).toFixed(1)}]` : "-");
    const wci = bootstrapCI(sub, bi, "winRet");
    const pci = bootstrapCI(sub, bi, "placeRet");
    // 補正係数 = 実測単勝回収率 ÷ 0.8(控除後の理論回収率)。
    // 単勝回収率 = 真の勝率×オッズ の期待値、オッズ ≈ 0.8/暗黙勝率 なので、
    // 回収率/0.8 = 真の勝率/オッズ暗黙勝率(=暗黙勝率に掛けるべき倍率)になる。
    if (collectCalib)
      winCalib.push({ label: b.label.trim(), factor: tot.winRet / (tot.bets * 100) / 0.8, ci: wci ? [wci[0] / 0.8, wci[1] / 0.8] : null });
    console.log(
      `${b.label}  ${String(tot.bets).padStart(5)}  ${String(tot.winHits).padStart(6)}  ${rate(tot.winRet).padStart(7)} (${rateExTop(tot.winRet, winList).padStart(6)})  ${ciTxt(wci).padStart(13)}  ${String(tot.placeHits).padStart(6)}  ${rate(tot.placeRet).padStart(7)} (${rateExTop(tot.placeRet, placeList).padStart(6)})  ${ciTxt(pci).padStart(13)}`,
    );
  });
  return winCalib;
}

// ---- プール間の歪み: 帯ごとの(複勝回収率 − 単勝回収率)のペア差ブートストラップ ----
// 同じレース集合での差なのでペアで比較(レースごとの相関を保ったままリサンプリング)
// 戻り値: セルごとの {band, obs, lo, hi, p}。pはブートストラップ両側p値
// (分布の符号割合の2倍、+1補正でp=0を避ける)。--byの多重比較補正で使う。
function printPoolGap(sub, title) {
  const cells = [];
  if (BOOTSTRAP <= 0) return cells;
  console.log(`\n===== プール間の歪み: 複勝回収率 − 単勝回収率(正=複勝の方がマシ)${title} =====`);
  BANDS.forEach((b, bi) => {
    const rand = mulberry32(1234);
    const n = sub.length;
    let obsW = 0;
    let obsP = 0;
    let obsBets = 0;
    for (const r of sub) {
      obsW += r.bandStats[bi].winRet;
      obsP += r.bandStats[bi].placeRet;
      obsBets += r.bandStats[bi].bets;
    }
    if (obsBets === 0) return;
    const obs = (obsP - obsW) / (obsBets * 100);
    const means = new Array(BOOTSTRAP);
    for (let bb = 0; bb < BOOTSTRAP; bb++) {
      let dw = 0;
      let dp = 0;
      let db = 0;
      for (let i = 0; i < n; i++) {
        const st = sub[(rand() * n) | 0].bandStats[bi];
        dw += st.winRet;
        dp += st.placeRet;
        db += st.bets;
      }
      means[bb] = db > 0 ? (dp - dw) / (db * 100) : 0;
    }
    means.sort((x, y) => x - y);
    const lo = means[Math.floor(0.025 * BOOTSTRAP)];
    const hi = means[Math.min(BOOTSTRAP - 1, Math.floor(0.975 * BOOTSTRAP))];
    let le = 0;
    let ge = 0;
    for (const m of means) {
      if (m <= 0) le++;
      if (m >= 0) ge++;
    }
    const p = Math.min(1, (2 * (Math.min(le, ge) + 1)) / (BOOTSTRAP + 1));
    cells.push({ band: b.label.trim(), obs, lo, hi, p, nRaces: sub.length, bets: obsBets });
    console.log(
      `${b.label}  差 ${obs >= 0 ? "+" : ""}${(obs * 100).toFixed(1)}pt  95%CI [${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]${lo > 0 ? "  ← 有意に複勝優位" : hi < 0 ? "  ← 有意に単勝優位" : ""}`,
    );
  });
  return cells;
}

// ---- 全体 ----
const winCalib = printBandTable(perRace, "", { collectCalib: true });
// ev-scan.mjs 用の補正係数(オッズ暗黙勝率に掛ける倍率)。
// payouts.local.json が増えたらこのスクリプトを再実行し、ev-scan.mjs の CALIB 定数を更新すること。
console.log("\n===== ev-scan用 補正係数(暗黙勝率×この倍率が実測ベースの勝率) =====");
for (const c of winCalib) {
  const ciTxt = c.ci ? ` CI[${c.ci[0].toFixed(2)}, ${c.ci[1].toFixed(2)}]` : "";
  console.log(`  ${c.label}: ×${c.factor.toFixed(3)}${ciTxt}`);
}
printPoolGap(perRace, "");

// ---- --by: 距離/馬場/頭数の分割検証(セルが小さくなるのでCIで判断する) ----
const SEGMENTS = {
  dist: [
    ["短距離(〜1400m)", (m) => m.distance != null && m.distance <= 1400],
    ["中距離(1401〜2200m)", (m) => m.distance != null && m.distance > 1400 && m.distance <= 2200],
    ["長距離(2201m〜)", (m) => m.distance != null && m.distance > 2200],
  ],
  going: [
    ["良馬場", (m) => m.going === "良"],
    ["道悪(稍重/重/不良)", (m) => m.going != null && m.going !== "良"],
  ],
  field: [
    ["少頭数(〜12頭)", (m) => m.fieldSize <= 12],
    ["多頭数(13頭〜)", (m) => m.fieldSize >= 13],
  ],
};
if (BY) {
  const keys = BY === "all" ? Object.keys(SEGMENTS) : BY.split(",");
  const allCells = []; // 多重比較補正の対象(全分割セルの複勝−単勝ペア差)
  for (const key of keys) {
    const segs = SEGMENTS[key];
    if (!segs) {
      console.error(`--by ${key} は未対応(dist / going / field / all)`);
      continue;
    }
    for (const [name, test] of segs) {
      const sub = perRace.filter((r) => test(r.meta));
      if (sub.length === 0) continue;
      console.log("");
      printBandTable(sub, ` 【${name}】`);
      for (const c of printPoolGap(sub, ` 【${name}】`)) allCells.push({ segment: name, ...c });
    }
  }

  // ---- 多重比較補正(BH法=FDR 5% と Bonferroni を併記) ----
  // 分割セルを増やすほど「たまたま有意」が混ざる(m個の独立検定で偽陽性の期待値 ≈ 0.05m)。
  // 各セルのブートストラップ両側p値に対し、BH: p(i) ≤ (i/m)α を満たす最大順位まで採択。
  if (allCells.length > 0) {
    const ALPHA = 0.05;
    const m = allCells.length;
    const sorted = [...allCells].sort((a, b) => a.p - b.p);
    let kMax = 0;
    sorted.forEach((c, i) => {
      if (c.p <= ((i + 1) / m) * ALPHA) kMax = i + 1;
    });
    console.log(`\n===== 多重比較補正(複勝−単勝ペア差、セル数 m=${m}、α=${ALPHA}) =====`);
    console.log("順位  セル                                   差       p値      BH閾値   BH(FDR5%)  Bonferroni");
    sorted.slice(0, Math.max(kMax, 8)).forEach((c, i) => {
      const bhThr = ((i + 1) / m) * ALPHA;
      const bh = i < kMax ? "生き残り" : "棄却";
      const bonf = c.p <= ALPHA / m ? "生き残り" : "棄却";
      console.log(
        `${String(i + 1).padStart(3)}  ${`${c.segment}×${c.band}`.padEnd(24, "　")} ${`${c.obs >= 0 ? "+" : ""}${(c.obs * 100).toFixed(1)}pt`.padStart(8)}  ${c.p.toFixed(4)}  ${bhThr.toFixed(4)}  ${bh.padEnd(5, "　")}  ${bonf}`,
      );
    });
    if (kMax === 0) {
      console.log("→ BH補正(FDR5%)後に生き残るセルなし = 分割の有意セルは多重比較のノイズと整合的");
    } else {
      console.log(`→ BH補正後も ${kMax} セルが生き残り(表の上位${kMax}件)。Bonferroni(p≤${(ALPHA / m).toFixed(4)})はより保守的な参考値`);
    }
    console.log("※ 同一レースを共有するセル同士は独立でない(BHの前提より保守側に働くとは限らない)点に注意");
  }
}

console.log(`
読み方:
- JRAの控除率は単勝・複勝とも20%なので、歪みが無ければどの帯も回収率は約80%に揃うはず。
- favorite-longshot biasがあれば「人気帯ほど80%に近く、大穴帯ほど大きく下回る」形になる(単勝で顕著)。
- 仮説「大穴の複勝は過小評価」が正しければ、10人気〜の複勝回収率が単勝回収率より明確に高く出る。
- ブートストラップはレース単位リサンプリング・シード固定(B=${BOOTSTRAP})。CIが重ならない帯同士は実差とみなせる。`);
