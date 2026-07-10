// 券種別の擬似購入バックテスト。v2予想(predict.tsと同ロジック)で印を打ち、
// 実際の払戻金(scripts/payouts.local.json ← fetch-payouts.mjs)で的中率・回収率を計算する。
//
// 買い方(1レースあたり全券種6,000円ずつ・点数で等分):
//   複勝1点6,000円 / 単勝1点6,000円 / ワイド2点3,000円 / 馬連3点2,000円 /
//   馬単5点1,200円 / 3連複20点300円 / 3連単60点100円
//
// フォーメーション(スコア順位ベース。点数が仕様どおりになる定番形):
//   ◎=1位 ○=2位 ▲=3位 △=4,5位 ☆=6位
//   ワイド2点: ◎-○ ◎-▲
//   馬連3点: ◎○▲ボックス
//   馬単5点: ◎→○▲△△ + ○→◎
//   3連複20点: 上位6頭(◎○▲△△☆)ボックス C(6,3)=20
//   3連単60点: ◎軸1頭マルチ・相手○▲△△☆(5頭) C(5,2)×3!=60
//
// 使い方: node scripts/bets-backtest.mjs [--since YYYY-MM-DD] [--verbose] [--dist]
//   --dist: 券種ごとに「上位1件の的中を除いた回収率」も併記する。
//   (memory: keiba-app-payout-concentration — 超大穴1件が合計回収率を吊り上げる罠の確認用)

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const PAYOUTS_PATH = new URL("./payouts.local.json", import.meta.url).pathname;

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const SINCE = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
const VERBOSE = args.includes("--verbose");
const DIST = args.includes("--dist");

try {
  process.loadEnvFile(".env");
} catch {}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

// ---- v2スコアリング(predict.ts / backtest.mjs と同一。変更時は要同期) ----
const GRADE_W = { G1: 1.5, G2: 1.2, G3: 1.0 };
const placePts = (p) =>
  p === 1 ? 10 : p === 2 ? 7 : p === 3 ? 5 : p === 4 ? 3 : p === 5 ? 2 : p != null && p <= 9 ? 1 : 0;
// クラス重み(4E・predict.ts と同期)。重賞は grade、条件戦などはレース名の級表記から。
function classWeight(grade, raceName) {
  const gw = GRADE_W[grade ?? ""];
  if (gw) return gw;
  const n = String(raceName ?? "");
  if (/新馬|未勝利|メイクデビュー/.test(n)) return 0.3;
  if (/[1１]勝クラス/.test(n)) return 0.5;
  if (/[2２]勝クラス/.test(n)) return 0.65;
  if (/[3３]勝クラス/.test(n)) return 0.8;
  if (/オープン/.test(n)) return 0.9;
  return 0.7;
}
// 障害判定(4E・predict.ts と同期)。平場障害は grade=null なので名前/コースでも見る。
const isJumpRun = (grade, raceName, surface) =>
  String(grade ?? "").startsWith("J") || surface === "障" || /障害/.test(String(raceName ?? ""));
function aptBonus(surface, distance, target) {
  if (target.distance == null || target.surface == null) return 0;
  if (surface !== target.surface) return 0;
  return Math.abs((distance ?? 0) - target.distance) <= 300 ? 1 : 0;
}
function scoreHorse(runs, now, target) {
  if (runs.length === 0) return 0;
  let total = 0;
  for (const r of runs) {
    const gw = classWeight(r.meta.grade, r.meta.name);
    const ageMonths = (now.getTime() - new Date(r.meta.date).getTime()) / (1000 * 3600 * 24 * 30);
    const rw = ageMonths <= 3 ? 1.2 : ageMonths <= 6 ? 1.0 : 0.8;
    const apt = r.place != null && r.place <= 5 ? aptBonus(r.meta.surface, r.meta.distance, target) : 0;
    total += placePts(r.place) * gw * rw + apt;
  }
  return (total / runs.length) * Math.min(1, runs.length / 3) * 10;
}
function scoreForm(past, target) {
  const runs = past.filter((p) => p.place != null);
  if (runs.length === 0) return 0;
  const recencyW = (n) => (n <= 1 ? 1.0 : n === 2 ? 0.75 : n === 3 ? 0.55 : 0.4);
  let raw = 0;
  let apt = 0;
  for (const p of runs) {
    const rw = recencyW(p.runNo);
    const strengthMul = p.fieldSize != null ? Math.min(1.2, Math.max(0.7, p.fieldSize / 14)) : 1;
    raw += placePts(p.place) * classWeight(p.grade, p.raceName) * rw * strengthMul;
    if (p.place <= 5) apt += aptBonus(p.surface, p.distance, target) * rw * 2;
  }
  return (raw / runs.length) * Math.min(1, runs.length / 2) * 6 + apt;
}
function scoreJockey(rides) {
  if (rides.length < 5) return 0;
  const top3 = rides.filter((r) => r.place != null && r.place <= 3).length;
  return (top3 / rides.length) * 30;
}

// ---- データロード(range()ページング) ----
async function fetchAll(table, cols, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).order(order).range(from, from + 999);
    if (error) {
      console.error(`DB読み取り失敗(${table}):`, error);
      process.exit(1);
    }
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
const races = await fetchAll("race_results", "id, date, track, name, grade, surface, distance", "date");
const rows = await fetchAll(
  "result_horses",
  "result_id, place, place_text, name, jockey, weight_carry, popularity, umaban",
  "id",
);
const payoutStore = JSON.parse(fs.readFileSync(PAYOUTS_PATH, "utf-8"));

const raceById = new Map(races.map((r) => [r.id, r]));
const byRace = new Map();
for (const h of rows) {
  if (!byRace.has(h.result_id)) byRace.set(h.result_id, []);
  byRace.get(h.result_id).push({ ...h, meta: raceById.get(h.result_id) });
}
const fieldSizeByResult = new Map([...byRace].map(([id, list]) => [id, list.length]));
const byHorse = new Map();
const byJockey = new Map();
for (const h of rows) {
  const meta = raceById.get(h.result_id);
  if (!byHorse.has(h.name)) byHorse.set(h.name, []);
  byHorse.get(h.name).push({
    place: h.place,
    fieldSize: fieldSizeByResult.get(h.result_id) ?? null,
    meta,
  });
  if (h.jockey) {
    if (!byJockey.has(h.jockey)) byJockey.set(h.jockey, []);
    byJockey.get(h.jockey).push({ place: h.place, meta });
  }
}
function buildPast(name, beforeDate) {
  return (byHorse.get(name) ?? [])
    .filter(
      (r) => r.meta.date < beforeDate && !isJumpRun(r.meta.grade, r.meta.name, r.meta.surface),
    )
    .sort((a, b) => (a.meta.date < b.meta.date ? 1 : -1))
    .slice(0, 4)
    .map((r, i) => ({
      runNo: i + 1,
      place: r.place,
      fieldSize: r.fieldSize,
      distance: r.meta.distance,
      surface: r.meta.surface,
      grade: r.meta.grade,
      raceName: r.meta.name,
    }));
}

// ---- 券種シミュレーション ----
const pairKey = (a, b) => [a, b].sort((x, y) => x - y).join("-");
const tripleKey = (a, b, c) => [a, b, c].sort((x, y) => x - y).join("-");

// 払戻表から購入点の払戻額(100円あたり)を引く。無ければ0。
const lookup = (lines, key) =>
  (lines ?? []).filter((l) => l.num === key).reduce((s, l) => s + l.yen, 0);

const BET_TYPES = [
  "複勝1点(6000円)",
  "単勝1点(6000円)",
  "ワイド2点(3000円×2)",
  "馬連3点(2000円×3)",
  "馬単5点(1200円×5)",
  "3連複20点(300円×20)",
  "3連単60点(100円×60)",
];
const agg = Object.fromEntries(BET_TYPES.map((t) => [t, { cost: 0, ret: 0, hit: 0, races: 0, hits: [] }]));
// 参考: 1番人気ベースライン
const fav = { tan: { cost: 0, ret: 0, hit: 0, races: 0 }, fuku: { cost: 0, ret: 0, hit: 0, races: 0 } };

let nRaces = 0;
const targets = races.filter(
  (r) => r.grade && !r.grade.startsWith("J") && payoutStore[r.id] && (!SINCE || r.date >= SINCE),
);

for (const race of targets) {
  const entrants = (byRace.get(race.id) ?? []).filter(
    (h) => !/[取除]/.test(h.place_text ?? "") && h.umaban != null,
  );
  if (entrants.length < 6) continue;
  const now = new Date(race.date);
  const target = { distance: race.distance, surface: race.surface };
  const withW = entrants.filter((h) => h.weight_carry != null);
  const avgW = withW.length ? withW.reduce((s, h) => s + Number(h.weight_carry), 0) / withW.length : 0;

  const scored = entrants
    .map((h) => {
      const runs = (byHorse.get(h.name) ?? []).filter(
        (r) => r.meta.date < race.date && !isJumpRun(r.meta.grade, r.meta.name, r.meta.surface),
      );
      const rides = (byJockey.get(h.jockey) ?? []).filter((r) => r.meta.date < race.date);
      const wPts = h.weight_carry != null && avgW > 0 ? (avgW - Number(h.weight_carry)) * 2 : 0;
      return {
        ...h,
        total:
          scoreHorse(runs, now, target) +
          scoreForm(buildPast(h.name, race.date), target) +
          scoreJockey(rides) +
          wPts,
      };
    })
    .sort((a, b) => b.total - a.total);

  const P = payoutStore[race.id].payouts;
  const [hon, taikou, tanana] = scored; // ◎ ○ ▲
  const marks5 = scored.slice(0, 5); // ◎○▲△△
  const top6 = scored.slice(0, 6); // ◎○▲△△☆(3連複BOX用)
  const multi5 = scored.slice(1, 6); // ○▲△△☆(3連単◎軸マルチの相手)
  nRaces++;

  const bets = []; // [type, cost, return]
  // 複勝・単勝
  bets.push(["複勝1点(6000円)", 6000, (lookup(P.place, String(hon.umaban)) * 6000) / 100]);
  bets.push(["単勝1点(6000円)", 6000, (lookup(P.win, String(hon.umaban)) * 6000) / 100]);
  // ワイド2点: ◎-○ ◎-▲
  {
    let ret = 0;
    for (const x of [taikou, tanana])
      ret += (lookup(P.wide, pairKey(hon.umaban, x.umaban)) * 3000) / 100;
    bets.push(["ワイド2点(3000円×2)", 6000, ret]);
  }
  // 馬連3点: ◎○▲ボックス
  {
    const combos = [
      [hon, taikou],
      [hon, tanana],
      [taikou, tanana],
    ];
    let ret = 0;
    for (const [a, b] of combos) ret += (lookup(P.umaren, pairKey(a.umaban, b.umaban)) * 2000) / 100;
    bets.push(["馬連3点(2000円×3)", 6000, ret]);
  }
  // 馬単5点: ◎→○▲△△ + ○→◎
  {
    const combos = marks5.slice(1).map((x) => [hon, x]);
    combos.push([taikou, hon]);
    let ret = 0;
    let cost = 0;
    for (const [a, b] of combos.slice(0, 5)) {
      cost += 1200;
      ret += (lookup(P.umatan, `${a.umaban}-${b.umaban}`) * 1200) / 100;
    }
    bets.push(["馬単5点(1200円×5)", cost, ret]);
  }
  // 3連複20点: 上位6頭ボックス C(6,3)=20
  {
    let cost = 0;
    let ret = 0;
    for (let i = 0; i < top6.length; i++)
      for (let j = i + 1; j < top6.length; j++)
        for (let k = j + 1; k < top6.length; k++) {
          cost += 300;
          ret +=
            (lookup(P.trio, tripleKey(top6[i].umaban, top6[j].umaban, top6[k].umaban)) * 300) / 100;
        }
    bets.push(["3連複20点(300円×20)", cost, ret]);
  }
  // 3連単60点: ◎軸1頭マルチ・相手5頭(○▲△△☆) C(5,2)×6=60
  {
    let cost = 0;
    let ret = 0;
    for (let i = 0; i < multi5.length; i++)
      for (let j = i + 1; j < multi5.length; j++) {
        const tri = [hon.umaban, multi5[i].umaban, multi5[j].umaban];
        for (const [a, b, c] of [
          [tri[0], tri[1], tri[2]],
          [tri[0], tri[2], tri[1]],
          [tri[1], tri[0], tri[2]],
          [tri[1], tri[2], tri[0]],
          [tri[2], tri[0], tri[1]],
          [tri[2], tri[1], tri[0]],
        ]) {
          cost += 100;
          ret += (lookup(P.tierce, `${a}-${b}-${c}`) * 100) / 100;
        }
      }
    bets.push(["3連単60点(100円×60)", cost, ret]);
  }

  for (const [type, cost, ret] of bets) {
    agg[type].cost += cost;
    agg[type].ret += ret;
    agg[type].races++;
    if (ret > 0) {
      agg[type].hit++;
      agg[type].hits.push({ date: race.date, name: race.name, ret });
    }
  }

  // 1番人気ベースライン(単勝/複勝 各6000円)
  const favH = entrants.find((h) => h.popularity === 1);
  if (favH) {
    fav.tan.cost += 6000;
    fav.tan.ret += (lookup(P.win, String(favH.umaban)) * 6000) / 100;
    fav.tan.races++;
    if (lookup(P.win, String(favH.umaban)) > 0) fav.tan.hit++;
    fav.fuku.cost += 6000;
    fav.fuku.ret += (lookup(P.place, String(favH.umaban)) * 6000) / 100;
    fav.fuku.races++;
    if (lookup(P.place, String(favH.umaban)) > 0) fav.fuku.hit++;
  }

  if (VERBOSE) {
    const hit = bets.filter(([, , r]) => r > 0).map(([t]) => t.split("(")[0]);
    console.log(
      `${race.date} ${race.name}(${race.grade}) ◎${hon.name}=${hon.place ?? "?"}着 → 的中: ${hit.join(",") || "なし"}`,
    );
  }
}

const fmt = (s) =>
  `的中率 ${((s.hit / Math.max(s.races, 1)) * 100).toFixed(1).padStart(5)}% / 回収率 ${((s.ret / Math.max(s.cost, 1)) * 100).toFixed(1).padStart(6)}% / 投資 ${s.cost.toLocaleString()}円 → 払戻 ${Math.round(s.ret).toLocaleString()}円`;
console.log(`\n===== 券種別シミュレーション(平地重賞 ${nRaces}レース・各券種6,000円/レース) =====`);
for (const t of BET_TYPES) {
  console.log(`${t.padEnd(16, "　")} ${fmt(agg[t])}`);
  if (DIST && agg[t].hits.length > 0) {
    const top = [...agg[t].hits].sort((a, b) => b.ret - a.ret)[0];
    const restCost = agg[t].cost; // 除外しても投資額は不変(全レース分買っているため)
    const restRet = agg[t].ret - top.ret;
    console.log(
      `  └ 上位1件除く: 回収率 ${((restRet / Math.max(restCost, 1)) * 100).toFixed(1)}%  ` +
        `(除外: ${top.date} ${top.name} 払戻${Math.round(top.ret).toLocaleString()}円)`,
    );
  }
}
console.log("---- 参考(市場ベースライン) ----");
console.log(`1番人気 単勝6000円　 ${fmt(fav.tan)}`);
console.log(`1番人気 複勝6000円　 ${fmt(fav.fuku)}`);
