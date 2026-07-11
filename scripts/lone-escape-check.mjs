// 「単騎逃げ」の市場ミスプライス検証。
//
// 仮説: 恒常的な逃げ馬がメンバー中1頭だけのレース(=単騎逃げが濃厚)では、その馬は
// 楽なペースで残しやすいのに、市場(人気)は展開の相互作用を織り込みきれていないのでは?
// cornerGain(単体特徴量、市場織り込み済みで棄却)とは別の「メンバー構成との相互作用」を見る。
//
// 方法:
// - corners.local.json(backfill-corners.mjsの出力、8,769R)から各馬の過去走の
//   「最初のコーナー通過順位 ÷ コーナー記録頭数」(firstCornerPct)を計算。
// - ⚠️ リーク禁止: 対象レースより日付が厳密に前の走だけを使う(当日・当該レースは不使用)。
// - 恒常的逃げ馬 = 過去のコーナー記録付き直近5走のうち3走以上あり、firstCornerPctの平均が
//   閾値(既定0.15 = 先頭15%以内が常態)以下の馬。
// - レースを「単騎(該当1頭)/競合(2頭以上)/不在(0頭)」に分類し、単騎レースの逃げ馬の
//   単勝・複勝100円買いの実測回収率を、同じ人気帯の全体平均(同一母集団から算出)と比較。
//   差のCIはレース単位ブートストラップ(シード固定)。競合レースの逃げ馬も対照群として併記。
//
// 使い方(プロジェクト直下で):
//   node scripts/lone-escape-check.mjs [--thresh 0.15] [--min-runs 3] [--min-coverage 0.6]
//     [--bootstrap N(既定10000)]
//   --min-coverage: 出走馬のうち逃げ判定可能な馬の割合がこの値未満のレースは除外
//     (判定不能馬だらけのレースで「該当1頭」と数えるのを防ぐ)。
// クロールなし(ローカルJSONとSupabase読み取りのみ)。

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const THRESH = Number(argOf("--thresh", "0.15"));
const MIN_RUNS = Number(argOf("--min-runs", "3"));
const MIN_COVERAGE = Number(argOf("--min-coverage", "0.6"));
const BOOTSTRAP = Number(argOf("--bootstrap", "10000"));

try {
  process.loadEnvFile(".env");
} catch {}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const payouts = JSON.parse(fs.readFileSync(new URL("./payouts.local.json", import.meta.url).pathname, "utf-8"));
const cornersByResult = JSON.parse(fs.readFileSync(new URL("./corners.local.json", import.meta.url).pathname, "utf-8"));
const resultIds = Object.keys(payouts).map(Number);
console.log(`払戻 ${resultIds.length}R / コーナー ${Object.keys(cornersByResult).length}R をロード`);

// ---- DB(60レースずつ: 1000行上限対策) ----
const byResult = new Map();
const raceMeta = new Map();
const CHUNK = 60;
for (let i = 0; i < resultIds.length; i += CHUNK) {
  const ids = resultIds.slice(i, i + CHUNK);
  const [h, r] = await Promise.all([
    supabase.from("result_horses").select("result_id, umaban, name, popularity, place_text").in("result_id", ids),
    supabase.from("race_results").select("id, date, grade, name, surface").in("id", ids),
  ]);
  if (h.error || r.error) {
    console.error("DB読み取りエラー:", h.error?.message ?? r.error?.message);
    process.exit(1);
  }
  for (const x of h.data) {
    if (!byResult.has(x.result_id)) byResult.set(x.result_id, []);
    byResult.get(x.result_id).push(x);
  }
  for (const x of r.data) raceMeta.set(x.id, x);
}

// ---- 馬ごとのコーナー履歴(馬名で串刺し) ----
// firstCornerPct = 最初のコーナー通過順位 ÷ コーナー記録のある頭数(leg-style-check.mjsと同じ正規化)
const historyByHorse = new Map(); // name -> [{date, pct}]
for (const [ridStr, rec] of Object.entries(cornersByResult)) {
  const rid = Number(ridStr);
  const horses = byResult.get(rid);
  const meta = raceMeta.get(rid);
  if (!horses || !meta || !rec?.corners) continue;
  const fieldSize = Object.keys(rec.corners).length;
  if (fieldSize < 5) continue;
  for (const h of horses) {
    const str = rec.corners[h.umaban];
    if (!str) continue;
    const first = Number(String(str).split("-")[0]);
    if (!Number.isFinite(first)) continue;
    if (!historyByHorse.has(h.name)) historyByHorse.set(h.name, []);
    historyByHorse.get(h.name).push({ date: meta.date, pct: first / fieldSize });
  }
}
for (const list of historyByHorse.values()) list.sort((a, b) => (a.date < b.date ? 1 : -1)); // 新しい順

// 対象レースより前の直近5走から逃げ判定。戻り値: true/false/null(判定不能=履歴不足)
function isHabitualEscaper(name, beforeDate) {
  const past = (historyByHorse.get(name) ?? []).filter((r) => r.date < beforeDate).slice(0, 5);
  if (past.length < MIN_RUNS) return null;
  const avg = past.reduce((s, r) => s + r.pct, 0) / past.length;
  return avg <= THRESH;
}

// ---- 人気帯(pool-bias-check.mjsと同じ) ----
const BANDS = [
  { label: "1番人気 ", test: (p) => p === 1 },
  { label: "2-3人気 ", test: (p) => p >= 2 && p <= 3 },
  { label: "4-6人気 ", test: (p) => p >= 4 && p <= 6 },
  { label: "7-9人気 ", test: (p) => p >= 7 && p <= 9 },
  { label: "10人気〜", test: (p) => p >= 10 },
];
const bandOf = (p) => BANDS.findIndex((b) => b.test(p));
const isJump = (m) => String(m?.grade ?? "").startsWith("J") || m?.surface === "障" || /障害/.test(String(m?.name ?? ""));

// ---- 本集計 ----
// baseline[band] = {bets, winRet, placeRet} 全出走馬(同一母集団)
// groups: lone(単騎レースの逃げ馬) / multi(競合レースの各逃げ馬)
const baseline = BANDS.map(() => ({ bets: 0, winRet: 0, placeRet: 0 }));
const lone = []; // {band, winYen, placeYen, pop, date, raceName, place}
const multi = [];
let usedRaces = 0;
let loneRaces = 0;
let multiRaces = 0;
let noneRaces = 0;
let skippedCoverage = 0;
let coverageSum = 0;

for (const rid of resultIds) {
  const meta = raceMeta.get(rid);
  const horses = byResult.get(rid);
  if (!meta || !horses || isJump(meta)) continue;
  const P = payouts[rid]?.payouts;
  if (!P?.win?.length) continue;
  const runners = horses.filter((h) => !/[取除]/.test(h.place_text ?? "") && h.popularity != null && h.umaban != null);
  if (runners.length < 6) continue;

  const winYen = new Map(P.win.map((x) => [Number(x.num), x.yen]));
  const placeYen = new Map((P.place ?? []).map((x) => [Number(x.num), x.yen]));

  // 逃げ判定(リークなし: meta.dateより前の走のみ)
  const flags = runners.map((h) => isHabitualEscaper(h.name, meta.date));
  const known = flags.filter((f) => f !== null).length;
  const coverage = known / runners.length;
  if (coverage < MIN_COVERAGE) {
    skippedCoverage++;
    continue;
  }
  usedRaces++;
  coverageSum += coverage;

  // ベースライン(全出走馬)
  for (const h of runners) {
    const bi = bandOf(h.popularity);
    if (bi < 0) continue;
    baseline[bi].bets++;
    baseline[bi].winRet += winYen.get(h.umaban) ?? 0;
    baseline[bi].placeRet += placeYen.get(h.umaban) ?? 0;
  }

  const escapers = runners.filter((_, i) => flags[i] === true);
  if (escapers.length === 0) {
    noneRaces++;
    continue;
  }
  const target = escapers.length === 1 ? lone : multi;
  if (escapers.length === 1) loneRaces++;
  else multiRaces++;
  for (const h of escapers) {
    target.push({
      band: bandOf(h.popularity),
      winYen: winYen.get(h.umaban) ?? 0,
      placeYen: placeYen.get(h.umaban) ?? 0,
      pop: h.popularity,
      date: meta.date,
      raceName: meta.name,
    });
  }
}

console.log(
  `集計対象 ${usedRaces}R(平地・カバレッジ${(MIN_COVERAGE * 100).toFixed(0)}%未満の${skippedCoverage}Rを除外、平均カバレッジ${((coverageSum / Math.max(usedRaces, 1)) * 100).toFixed(1)}%)`,
);
console.log(
  `逃げ馬判定: 閾値avgPct≤${THRESH} / 直近${MIN_RUNS}走以上 → 単騎${loneRaces}R / 競合${multiRaces}R / 不在${noneRaces}R`,
);

// ---- ベースライン帯別回収率 ----
const baseRate = baseline.map((b) => ({
  win: b.bets > 0 ? b.winRet / (b.bets * 100) : 0,
  place: b.bets > 0 ? b.placeRet / (b.bets * 100) : 0,
}));
console.log("\n===== ベースライン(同一母集団・全出走馬の帯別回収率) =====");
BANDS.forEach((b, bi) =>
  console.log(
    `${b.label}  点数${String(baseline[bi].bets).padStart(6)}  単勝${(baseRate[bi].win * 100).toFixed(1)}% 複勝${(baseRate[bi].place * 100).toFixed(1)}%`,
  ),
);

// ---- グループ評価: 実測回収率 vs 帯マッチ期待値、差のブートストラップCI ----
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
function evalGroup(group, label) {
  if (group.length === 0) {
    console.log(`\n${label}: 該当なし`);
    return;
  }
  const n = group.length;
  const actW = group.reduce((s, g) => s + g.winYen, 0) / (n * 100);
  const actP = group.reduce((s, g) => s + g.placeYen, 0) / (n * 100);
  const expW = group.reduce((s, g) => s + baseRate[g.band].win, 0) / n;
  const expP = group.reduce((s, g) => s + baseRate[g.band].place, 0) / n;
  // 人気分布
  const popDist = BANDS.map((b, bi) => `${b.label.trim()}:${group.filter((g) => g.band === bi).length}`).join(" ");
  console.log(`\n===== ${label}(n=${n}頭) =====`);
  console.log(`人気分布: ${popDist}(平均人気 ${(group.reduce((s, g) => s + g.pop, 0) / n).toFixed(1)})`);
  console.log(`単勝: 実測 ${(actW * 100).toFixed(1)}% vs 帯期待 ${(expW * 100).toFixed(1)}% → 差 ${((actW - expW) * 100).toFixed(1)}pt`);
  console.log(`複勝: 実測 ${(actP * 100).toFixed(1)}% vs 帯期待 ${(expP * 100).toFixed(1)}% → 差 ${((actP - expP) * 100).toFixed(1)}pt`);
  if (BOOTSTRAP > 0) {
    // 頭単位リサンプリング(単騎は1レース1頭なのでレース単位と同義。競合も頭単位で近似)
    for (const [fld, exp, name] of [
      ["winYen", "win", "単勝"],
      ["placeYen", "place", "複勝"],
    ]) {
      const rand = mulberry32(42);
      const diffs = new Float64Array(BOOTSTRAP);
      for (let b = 0; b < BOOTSTRAP; b++) {
        let act = 0;
        let ex = 0;
        for (let i = 0; i < n; i++) {
          const g = group[(rand() * n) | 0];
          act += g[fld];
          ex += baseRate[g.band][exp];
        }
        diffs[b] = act / (n * 100) - ex / n;
      }
      diffs.sort();
      const lo = diffs[Math.floor(0.025 * BOOTSTRAP)];
      const hi = diffs[Math.min(BOOTSTRAP - 1, Math.floor(0.975 * BOOTSTRAP))];
      const verdict = lo > 0 ? " ← 有意に帯平均より高回収" : hi < 0 ? " ← 有意に帯平均より低回収" : "(CIが0を跨ぐ=誤差と区別できない)";
      console.log(`  ${name}差 95%CI [${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]${verdict}`);
    }
  }
  // 大穴1発の罠チェック: 単勝払戻の上位1件
  const topW = [...group].sort((a, b) => b.winYen - a.winYen)[0];
  if (topW.winYen > 0) {
    const share = topW.winYen / group.reduce((s, g) => s + g.winYen, 0);
    console.log(
      `  単勝払戻top1: ${topW.date} ${topW.raceName}(${topW.pop}番人気, ${topW.winYen}円) シェア${(share * 100).toFixed(1)}%`,
    );
  }
}
evalGroup(lone, `単騎逃げレースの逃げ馬(閾値${THRESH})`);
evalGroup(multi, `競合レースの逃げ馬(対照群、1レース2頭以上)`);

console.log(`
読み方:
- 「帯期待」は同じ人気帯の全出走馬平均(同一母集団)。差が正なら市場は単騎逃げを過小評価している。
- 単騎逃げ仮説が正しければ、単騎群の差>0かつ競合群は差≤0(競り合いで共倒れ)になるはず。
- 逃げ判定はコーナー記録のある2023-07以降の走のみ(それ以前はデータなし)。初期のレースほど
  履歴不足で判定不能が多く、--min-coverageで除外している点に注意(サンプルは後期に偏る)。
- 閾値の感度は --thresh 0.2 / --min-runs 2 などで確認すること。`);
