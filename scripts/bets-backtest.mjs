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
// 使い方: node scripts/bets-backtest.mjs [--since YYYY-MM-DD] [--verbose] [--dist [N]] [--all-races]
//   --dist [N]: 券種ごとに「払戻上位N件の的中を除いた回収率」も併記する(N省略時は1)。
//   あわせて上位1件が払戻総額に占める割合(%)も表示する。
//   (memory: keiba-app-payout-concentration — 超大穴1件が合計回収率を吊り上げる罠の確認用)
//   --all-races: 母集団を「平地重賞のみ」(既定)から「平地全レース」に広げる。
//   payouts.local.json に条件戦の払戻が入っている分だけ対象が増える。
//   注意: payouts.local.json はクロールで増え続けるため、結果を引用するときは必ずレース数nを添えること。
//   --by-class: 階級別(新馬・未勝利 / 1〜3勝クラス / OP・重賞 / 級不明)の内訳を全体の後に表示。
//   全レース回収率の崩壊が「履歴の薄い新馬・未勝利に集中」か「条件戦全体に広がる」かの切り分け用。
//   --all-races を含意する(母集団は平地全レース)。

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const PAYOUTS_PATH = new URL("./payouts.local.json", import.meta.url).pathname;

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const SINCE = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
const VERBOSE = args.includes("--verbose");
const distIdx = args.indexOf("--dist");
const DIST = distIdx >= 0;
// --dist の直後が数値ならそれを除外件数Nとして使う(例: --dist 5)。省略時は従来どおり1件。
const DIST_N = DIST && /^\d+$/.test(args[distIdx + 1] ?? "") ? Number(args[distIdx + 1]) : 1;
const BY_CLASS = args.includes("--by-class");
const ALL_RACES = args.includes("--all-races") || BY_CLASS;

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
// 階級レイヤ判定(--by-class用)。classWeightと同じレース名パターンでグルーピング。
// grade付き(G1〜G3・L等)とレース名「オープン」はOP・重賞層。どれにも該当しない
// 平場レース(名前に級表記がない特別戦など、classWeightが既定0.7を返す層)は「級不明」で別掲。
const CLASS_LAYERS = ["新馬・未勝利", "1〜3勝クラス", "OP・重賞", "級不明(特別戦等)"];
function raceClassLayer(grade, raceName) {
  if (grade) return "OP・重賞";
  const n = String(raceName ?? "");
  if (/新馬|未勝利|メイクデビュー/.test(n)) return "新馬・未勝利";
  if (/[1１2２3３]勝クラス/.test(n)) return "1〜3勝クラス";
  if (/オープン/.test(n)) return "OP・重賞";
  return "級不明(特別戦等)";
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
const makeAgg = () => ({
  agg: Object.fromEntries(BET_TYPES.map((t) => [t, { cost: 0, ret: 0, hit: 0, races: 0, hits: [] }])),
  fav: { tan: { cost: 0, ret: 0, hit: 0, races: 0 }, fuku: { cost: 0, ret: 0, hit: 0, races: 0 } },
  nRaces: 0,
});
const total = makeAgg();
const { agg, fav } = total; // 既存コードの参照名を維持
// --by-class: 階級レイヤ別に同じ集計を積む
const byClass = BY_CLASS ? new Map(CLASS_LAYERS.map((c) => [c, makeAgg()])) : null;

let nRaces = 0;
// 既定は従来どおり平地重賞のみ(後方互換)。--all-races で平地全レース(条件戦含む)に拡大。
const targets = races.filter(
  (r) =>
    (ALL_RACES
      ? !isJumpRun(r.grade, r.name, r.surface)
      : r.grade && !r.grade.startsWith("J")) &&
    payoutStore[r.id] &&
    (!SINCE || r.date >= SINCE),
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
  total.nRaces++;
  const clsAgg = BY_CLASS ? byClass.get(raceClassLayer(race.grade, race.name)) : null;
  if (clsAgg) clsAgg.nRaces++;
  const sinks = clsAgg ? [total, clsAgg] : [total];

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

  for (const sink of sinks) {
    for (const [type, cost, ret] of bets) {
      sink.agg[type].cost += cost;
      sink.agg[type].ret += ret;
      sink.agg[type].races++;
      if (ret > 0) {
        sink.agg[type].hit++;
        sink.agg[type].hits.push({ date: race.date, name: race.name, ret });
      }
    }
  }

  // 1番人気ベースライン(単勝/複勝 各6000円)。--by-class時は同じ層内で比較できるよう層別にも積む
  const favH = entrants.find((h) => h.popularity === 1);
  if (favH) {
    const tanYen = lookup(P.win, String(favH.umaban));
    const fukuYen = lookup(P.place, String(favH.umaban));
    for (const sink of sinks) {
      sink.fav.tan.cost += 6000;
      sink.fav.tan.ret += (tanYen * 6000) / 100;
      sink.fav.tan.races++;
      if (tanYen > 0) sink.fav.tan.hit++;
      sink.fav.fuku.cost += 6000;
      sink.fav.fuku.ret += (fukuYen * 6000) / 100;
      sink.fav.fuku.races++;
      if (fukuYen > 0) sink.fav.fuku.hit++;
    }
  }

  if (VERBOSE) {
    const hit = bets.filter(([, , r]) => r > 0).map(([t]) => t.split("(")[0]);
    console.log(
      `${race.date} ${race.name}(${race.grade ?? "平場"}) ◎${hon.name}=${hon.place ?? "?"}着 → 的中: ${hit.join(",") || "なし"}`,
    );
  }
}

const fmt = (s) =>
  `的中率 ${((s.hit / Math.max(s.races, 1)) * 100).toFixed(1).padStart(5)}% / 回収率 ${((s.ret / Math.max(s.cost, 1)) * 100).toFixed(1).padStart(6)}% / 投資 ${s.cost.toLocaleString()}円 → 払戻 ${Math.round(s.ret).toLocaleString()}円`;
function printReport(label, sink) {
  console.log(`\n===== 券種別シミュレーション(${label} ${sink.nRaces}レース・各券種6,000円/レース) =====`);
  for (const t of BET_TYPES) {
    const a = sink.agg[t];
    console.log(`${t.padEnd(16, "　")} ${fmt(a)}`);
    if (DIST && a.hits.length > 0) {
      const sorted = [...a.hits].sort((x, y) => y.ret - x.ret);
      const n = Math.min(DIST_N, sorted.length);
      const exclRet = sorted.slice(0, n).reduce((s, h) => s + h.ret, 0);
      const restCost = a.cost; // 除外しても投資額は不変(全レース分買っているため)
      const restRet = a.ret - exclRet;
      const top = sorted[0];
      // 上位1件シェア: 母集団が広がると的中件数が増え「1件の重み」自体が変わるので毎回明示する
      const top1Share = (top.ret / Math.max(a.ret, 1)) * 100;
      console.log(
        `  └ 上位${n}件除く: 回収率 ${((restRet / Math.max(restCost, 1)) * 100).toFixed(1)}%  ` +
          `(上位1件シェア ${top1Share.toFixed(1)}% = ${top.date} ${top.name} 払戻${Math.round(top.ret).toLocaleString()}円)`,
      );
    }
  }
  console.log("---- 参考(市場ベースライン・同じ母集団) ----");
  console.log(`1番人気 単勝6000円　 ${fmt(sink.fav.tan)}`);
  console.log(`1番人気 複勝6000円　 ${fmt(sink.fav.fuku)}`);
}

const scopeLabel = ALL_RACES ? "平地全レース" : "平地重賞";
printReport(scopeLabel, total);
if (BY_CLASS) {
  for (const cls of CLASS_LAYERS) {
    const sink = byClass.get(cls);
    if (sink.nRaces === 0) continue;
    printReport(`階級別: ${cls}`, sink);
  }
}
