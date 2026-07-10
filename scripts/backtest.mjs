// v1予想ロジック(src/lib/predict.ts)のバックテスト。ローカルバッチ、クロールなし(DB読むだけ)。
//
// 使い方(プロジェクト直下で):
//   node scripts/backtest.mjs --since 2026-07-01           … 指定日以降の重賞だけ答え合わせ(詳細表示)
//   node scripts/backtest.mjs --all                        … DBにある全重賞を通しで答え合わせ(集計のみ)
//   node scripts/backtest.mjs --all --verbose              … 全件+レースごとの詳細
//
// 仕組み: 各レースについて「そのレースの開催日より前の結果だけ」を材料に v1 と同じ採点をし、
// ◎(スコア1位)が実際に何着だったかを照合する。ベースラインは1番人気。
// リーク防止のため、直近重み(rw)の基準日もレース当日にする。
//
// ⚠️ スコアリング部分は src/lib/predict.ts の scoreHorse/scoreJockey の複製。
//    predict.ts を変えたらここも合わせること(TSを.mjsから直接importできないため)。

import { createClient } from "@supabase/supabase-js";

// ---- CLI引数 ----
const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const SINCE = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
const ALL = args.includes("--all");
const VERBOSE = args.includes("--verbose") || (SINCE != null && !ALL);
if (!SINCE && !ALL) {
  console.error("使い方: node scripts/backtest.mjs --since YYYY-MM-DD | --all [--verbose]");
  process.exit(1);
}

// ---- env / supabase ----
try {
  process.loadEnvFile(".env");
} catch {
  /* .env が無ければ環境変数をそのまま使う */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env にありません");
  process.exit(1);
}
const supabase = createClient(url, key);

// ---- v1スコアリング(predict.ts の複製) ----
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

// v1(旧・ベースライン): 距離適性は芝1800〜2200に固定。フォーム(近走)無し。
// ⚠️ v1は比較基準として旧仕様のまま凍結(4E後は条件戦もG3と同じ重み1.0で採点される)。
function scoreHorseV1(runs, now) {
  if (runs.length === 0) return 0;
  let total = 0;
  for (const r of runs) {
    const gw = GRADE_W[r.meta.grade ?? ""] ?? 1.0;
    const ageMonths = (now.getTime() - new Date(r.meta.date).getTime()) / (1000 * 3600 * 24 * 30);
    const rw = ageMonths <= 3 ? 1.2 : ageMonths <= 6 ? 1.0 : 0.8;
    const apt =
      r.meta.surface === "芝" &&
      (r.meta.distance ?? 0) >= 1800 &&
      (r.meta.distance ?? 0) <= 2200 &&
      r.place != null &&
      r.place <= 5
        ? 1
        : 0;
    total += placePts(r.place) * gw * rw + apt;
  }
  return (total / runs.length) * Math.min(1, runs.length / 3) * 10;
}

// v2(新): predict.ts の scoreHorse/scoreForm を複製。距離適性は当該レースのコースで判定。
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
// past: 最新順(runNo 1=前走)。predict.ts の scoreForm を複製。
// 4E以降、2026年分の近走は全レース(条件戦含む)の実データ。2025年以前は重賞のみの近似のまま。
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

// ---- データ一括ロード(2000行強なので全部メモリに載せる) ----
// ⚠️ Supabaseは1リクエスト最大1000行(サーバー側max-rows)。.limit()を増やしても超えられないので range でページング。
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
  "result_id, place, place_text, name, jockey, weight_carry, popularity",
  "id",
);

const raceById = new Map(races.map((r) => [r.id, r]));
const byRace = new Map(); // result_id -> rows
for (const h of rows) {
  if (!byRace.has(h.result_id)) byRace.set(h.result_id, []);
  byRace.get(h.result_id).push({ ...h, meta: raceById.get(h.result_id) });
}
const fieldSizeByResult = new Map([...byRace].map(([id, list]) => [id, list.length]));
// 馬名・騎手ごとの全履歴(評価時に日付でフィルタ)
const byHorse = new Map();
const byJockey = new Map();
for (const h of rows) {
  const meta = raceById.get(h.result_id);
  if (!byHorse.has(h.name)) byHorse.set(h.name, []);
  byHorse.get(h.name).push({
    place: h.place,
    popularity: h.popularity,
    fieldSize: fieldSizeByResult.get(h.result_id) ?? null,
    meta,
  });
  if (h.jockey) {
    if (!byJockey.has(h.jockey)) byJockey.set(h.jockey, []);
    byJockey.get(h.jockey).push({ place: h.place, meta });
  }
}

// ---- 対象レース: 平地重賞のみ(障害J.G*は除外) ----
const targets = races.filter(
  (r) => r.grade && !r.grade.startsWith("J") && (!SINCE || r.date >= SINCE),
);

const MARKS = ["◎", "○", "▲", "△", "△"];
// v1(旧)・v2(近走+コース適性)・1番人気 の3者を同じ土俵で集計。
const mkStat = () => ({ win: 0, top3: 0, top5Hit: 0 });
const stat = { n: 0, v1: mkStat(), v2: mkStat(), fav: mkStat() };

// 指定馬の、race.date より前の平地成績を最新順に最大4走ぶん PastRun 化する。
function buildPast(name, beforeDate) {
  return (byHorse.get(name) ?? [])
    .filter(
      (r) => r.meta.date < beforeDate && !isJumpRun(r.meta.grade, r.meta.name, r.meta.surface),
    )
    .sort((a, b) => (a.meta.date < b.meta.date ? 1 : -1)) // 新しい順
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

// スコア上位から着け直した印で、勝率/複勝率/勝ち馬カバー率を集計する。
function tally(target, scoreFn, entrants, race) {
  const scored = entrants
    .map((h) => ({ ...h, total: scoreFn(h) }))
    .sort((a, b) => b.total - a.total);
  const hon = scored[0];
  const winner = entrants.find((h) => h.place === 1);
  if (hon.place === 1) target.win++;
  if (hon.place != null && hon.place <= 3) target.top3++;
  if (winner && scored.slice(0, 5).some((h) => h.name === winner.name)) target.top5Hit++;
  return scored;
}

for (const race of targets) {
  const entrants = (byRace.get(race.id) ?? []).filter(
    (h) => !/[取除]/.test(h.place_text ?? ""), // 出走取消・競走除外は出走していないので外す
  );
  if (entrants.length === 0) continue;
  const now = new Date(race.date);
  const target = { distance: race.distance, surface: race.surface };

  const withW = entrants.filter((h) => h.weight_carry != null);
  const avgW = withW.length ? withW.reduce((s, h) => s + Number(h.weight_carry), 0) / withW.length : 0;
  const wPtsOf = (h) => (h.weight_carry != null && avgW > 0 ? (avgW - Number(h.weight_carry)) * 2 : 0);
  const runsOf = (h) =>
    (byHorse.get(h.name) ?? []).filter(
      (r) => r.meta.date < race.date && !isJumpRun(r.meta.grade, r.meta.name, r.meta.surface),
    );
  const jockeyPtsOf = (h) =>
    scoreJockey((byJockey.get(h.jockey) ?? []).filter((r) => r.meta.date < race.date));

  stat.n++;
  const v1score = (h) => scoreHorseV1(runsOf(h), now) + jockeyPtsOf(h) + wPtsOf(h);
  const v2score = (h) =>
    scoreHorse(runsOf(h), now, target) +
    scoreForm(buildPast(h.name, race.date), target) +
    jockeyPtsOf(h) +
    wPtsOf(h);

  tally(stat.v1, v1score, entrants, race);
  const scoredV2 = tally(stat.v2, v2score, entrants, race);
  // 1番人気を「印」とみなして同じ指標を集計
  const fav = entrants.find((h) => h.popularity === 1);
  if (fav?.place === 1) stat.fav.win++;
  if (fav?.place != null && fav.place <= 3) stat.fav.top3++;
  if (fav && [...entrants].sort((a, b) => (a.popularity ?? 99) - (b.popularity ?? 99)).slice(0, 5).some((h) => h.name === (entrants.find((e) => e.place === 1)?.name)))
    stat.fav.top5Hit++;

  if (VERBOSE) {
    const winner = entrants.find((h) => h.place === 1);
    const winRank = winner ? scoredV2.findIndex((h) => h.name === winner.name) + 1 : "?";
    console.log(`\n■ ${race.date} ${race.track} ${race.name}(${race.grade}) ${race.surface}${race.distance}m [v2]`);
    scoredV2.slice(0, 5).forEach((h, i) =>
      console.log(
        `  ${MARKS[i]} ${h.name.padEnd(10, "　")} score=${h.total.toFixed(1).padStart(6)} → 実際 ${
          h.place ?? h.place_text ?? "?"
        }着(${h.popularity ?? "?"}人気)`,
      ),
    );
    console.log(
      `  勝ち馬: ${winner?.name ?? "?"}(${winner?.popularity ?? "?"}人気)= v2予想${winRank}位 / 1番人気${
        fav?.name ?? "?"
      }は${fav?.place ?? "?"}着`,
    );
  }
}

const pct = (x) => ((x / Math.max(stat.n, 1)) * 100).toFixed(1) + "%";
const line = (label, s) =>
  `${label}: 勝率 ${pct(s.win).padStart(6)} / 複勝率 ${pct(s.top3).padStart(6)} / 勝ち馬印5頭内 ${pct(s.top5Hit)}`;
console.log(`\n===== 集計(平地重賞 ${stat.n}レース${SINCE ? ` / ${SINCE}以降` : ""}) =====`);
console.log(line("v1(旧・重賞実績のみ)   ", stat.v1));
console.log(line("v2(近走+コース適性追加)", stat.v2));
console.log(line("1番人気(市場ベースライン)", stat.fav));
console.log(
  "\n※ 4E以降: 2026年分の実績・近走は全レース(条件戦含む)の実データ、2025年以前は重賞のみの近似。",
);
