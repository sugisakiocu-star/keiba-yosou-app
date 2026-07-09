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

function scoreHorse(runs, now) {
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
// 馬名・騎手ごとの全履歴(評価時に日付でフィルタ)
const byHorse = new Map();
const byJockey = new Map();
for (const h of rows) {
  const meta = raceById.get(h.result_id);
  if (!byHorse.has(h.name)) byHorse.set(h.name, []);
  byHorse.get(h.name).push({ place: h.place, meta });
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
const stat = {
  n: 0,
  honWin: 0, // ◎が1着
  honTop3: 0, // ◎が3着以内
  top5Hit: 0, // 勝ち馬が印5頭に入っていた
  favWin: 0, // 1番人気が1着
  favTop3: 0,
  noData: 0, // ◎のスコアが0(材料なしで実質予想不能)
};

for (const race of targets) {
  const entrants = (byRace.get(race.id) ?? []).filter(
    (h) => !/[取除]/.test(h.place_text ?? ""), // 出走取消・競走除外は出走していないので外す
  );
  if (entrants.length === 0) continue;
  const now = new Date(race.date);

  const withW = entrants.filter((h) => h.weight_carry != null);
  const avgW = withW.length ? withW.reduce((s, h) => s + Number(h.weight_carry), 0) / withW.length : 0;

  const scored = entrants.map((h) => {
    const runs = (byHorse.get(h.name) ?? []).filter(
      (r) => r.meta.date < race.date && !String(r.meta.grade ?? "").startsWith("J"),
    );
    const rides = (byJockey.get(h.jockey) ?? []).filter((r) => r.meta.date < race.date);
    const wPts = h.weight_carry != null && avgW > 0 ? (avgW - Number(h.weight_carry)) * 2 : 0;
    return { ...h, total: scoreHorse(runs, now) + scoreJockey(rides) + wPts, nRuns: runs.length };
  });
  scored.sort((a, b) => b.total - a.total);

  const hon = scored[0];
  const top5 = scored.slice(0, 5);
  const winner = entrants.find((h) => h.place === 1);
  const fav = entrants.find((h) => h.popularity === 1);

  stat.n++;
  if (hon.place === 1) stat.honWin++;
  if (hon.place != null && hon.place <= 3) stat.honTop3++;
  if (winner && top5.some((h) => h.name === winner.name)) stat.top5Hit++;
  if (fav?.place === 1) stat.favWin++;
  if (fav?.place != null && fav.place <= 3) stat.favTop3++;
  if (hon.total <= 0) stat.noData++;

  if (VERBOSE) {
    const winRank = winner ? scored.findIndex((h) => h.name === winner.name) + 1 : "?";
    console.log(`\n■ ${race.date} ${race.track} ${race.name}(${race.grade}) ${race.surface}${race.distance}m`);
    top5.forEach((h, i) =>
      console.log(
        `  ${MARKS[i]} ${h.name.padEnd(10, "　")} score=${h.total.toFixed(1).padStart(6)} → 実際 ${
          h.place ?? h.place_text ?? "?"
        }着(${h.popularity ?? "?"}人気)`,
      ),
    );
    console.log(
      `  勝ち馬: ${winner?.name ?? "?"}(${winner?.popularity ?? "?"}人気)= 予想${winRank}位 / 1番人気${
        fav?.name ?? "?"
      }は${fav?.place ?? "?"}着`,
    );
  }
}

const pct = (x) => ((x / Math.max(stat.n, 1)) * 100).toFixed(1) + "%";
console.log(`\n===== 集計(平地重賞 ${stat.n}レース${SINCE ? ` / ${SINCE}以降` : ""}) =====`);
console.log(`v1の◎     : 勝率 ${pct(stat.honWin)} / 複勝率 ${pct(stat.honTop3)}`);
console.log(`1番人気    : 勝率 ${pct(stat.favWin)} / 複勝率 ${pct(stat.favTop3)}`);
console.log(`勝ち馬が印5頭内: ${pct(stat.top5Hit)}`);
console.log(`◎が材料なし(スコア0以下): ${stat.noData}レース ※開催が古いほど履歴が無く不利`);
