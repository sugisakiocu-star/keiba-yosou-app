// 過去レースの最終オッズ(単勝・複勝)バックフィル。
// backfill-corners.mjs が結果ページから拾っておいたオッズページcname(scripts/odds-cnames.local.json、
// 8,769レース分)を使い、accessO.html から単複最終オッズを取得してローカルJSONに保存する。
//
// 目的: EV戦略の歴史バックテスト。「CALIB補正済みEVスキャンが過去2年で回収率何%だったか」を
// payouts.local.json との突き合わせで検証する(フェーズ4B → EV検証の本丸)。
// 歴史ページ(2024年分含む)にも最終オッズページが残っていることは2026-07-10深夜に実地確認済み。
//
// 使い方(プロジェクト直下で):
//   node scripts/backfill-odds.mjs --dry --limit 3       … 3件だけ取得して内容表示(保存もする)
//   node scripts/backfill-odds.mjs --sample 300           … 全期間から等間隔サンプリングで300件
//   node scripts/backfill-odds.mjs --skip-existing        … 全件(約8,769件・1.5秒間隔で約3.7時間)
//   node scripts/backfill-odds.mjs --since 2025-01-01 --until 2025-12-31
//
// 取得ルール(プロジェクト方針準拠): JRA公式のみ・UA明示・1.5秒間隔・skip-existingで再取得回避。
// 出力: scripts/odds-hist.local.json(gitignore済み)。公開リポジトリにJRAデータを再配布しない。

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { parseTanpuku } from "./fetch-odds.mjs";

const UA = "keiba-yosou-app (personal study project)";
const ACCESS_O = "https://www.jra.go.jp/JRADB/accessO.html";
const DELAY_MS = 1500;
const SAVE_EVERY = 50;
const CNAMES_IN = new URL("./odds-cnames.local.json", import.meta.url).pathname;
const OUT = new URL("./odds-hist.local.json", import.meta.url).pathname;

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const DRY = args.includes("--dry");
const LIMIT = Number(argOf("--limit", "Infinity"));
const SAMPLE = Number(argOf("--sample", "0"));
const SKIP_EXISTING = args.includes("--skip-existing");
const SINCE = argOf("--since", null);
const UNTIL = argOf("--until", null);

try {
  process.loadEnvFile(".env");
} catch {}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, opts, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(2000 * 2 ** i);
    }
  }
}
async function getOddsHtml(cname) {
  const res = await fetchRetry(ACCESS_O, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ cname }).toString(),
  });
  return new TextDecoder("shift_jis").decode(await res.arrayBuffer());
}

// ---- 対象の組み立て ----
const cnames = JSON.parse(fs.readFileSync(CNAMES_IN, "utf-8")); // {resultId: "pw151ou..."}

// レースメタデータ(日付でのソート・フィルタ用)を range ページングで全件読む(1000行上限対策)
const races = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from("race_results")
    .select("id, date, track, race_no, name, grade")
    .order("date")
    .order("id")
    .range(from, from + 999);
  if (error) {
    console.error("DB読み取りエラー:", error.message);
    process.exit(1);
  }
  races.push(...(data ?? []));
  if ((data?.length ?? 0) < 1000) break;
}

let targets = races.filter(
  (r) => cnames[r.id] && (!SINCE || r.date >= SINCE) && (!UNTIL || r.date <= UNTIL),
);
// --sample N: 日付順の全対象から等間隔にN件(期間の偏りなく・決定的に選ぶ)
if (SAMPLE > 0 && targets.length > SAMPLE) {
  const step = targets.length / SAMPLE;
  targets = Array.from({ length: SAMPLE }, (_, i) => targets[Math.floor(i * step)]);
}

let store = {};
if (fs.existsSync(OUT)) store = JSON.parse(fs.readFileSync(OUT, "utf-8"));
const save = () => fs.writeFileSync(OUT, JSON.stringify(store, null, 1));

console.log(
  `■ 過去オッズ(単複)バックフィル  対象${targets.length}件  sample=${SAMPLE || "-"} since=${SINCE ?? "-"} until=${UNTIL ?? "-"} 既存${Object.keys(store).length}件`,
);

let done = 0;
let skipped = 0;
let failed = 0;
let noOdds = 0;
for (const r of targets) {
  if (done + failed >= LIMIT) break;
  if (SKIP_EXISTING && store[r.id]) {
    skipped++;
    continue;
  }
  try {
    const html = await getOddsHtml(cnames[r.id]);
    const tp = parseTanpuku(html);
    if (!tp || Object.keys(tp.horses).length === 0) {
      // 古いレースはオッズページが消えている可能性(サンプル調査の主目的)。頻度を記録する。
      noOdds++;
      console.warn(`  △ ${r.date} ${r.track}${r.race_no}R: 単複テーブルなし(ページ消滅 or 構造違い)`);
      done++;
    } else {
      store[r.id] = {
        date: r.date,
        track: r.track,
        raceNo: r.race_no,
        name: r.name,
        grade: r.grade,
        refresh: tp.refresh,
        horses: tp.horses,
      };
      done++;
      if (DRY) {
        const fav = Object.entries(tp.horses).sort((a, b) => (a[1].tan ?? 999) - (b[1].tan ?? 999))[0];
        console.log(
          `  ○ ${r.date} ${r.track}${r.race_no}R ${r.name}: ${Object.keys(tp.horses).length}頭 1人気=${fav?.[1].name}(単${fav?.[1].tan}) ${tp.refresh}`,
        );
      }
    }
    if (done % SAVE_EVERY === 0 && !DRY) save();
    if (done % 200 === 0 && done > 0 && !DRY)
      console.log(`  … ${done}件処理(うちオッズ無し${noOdds}・失敗${failed})  ${r.date}まで到達`);
    await sleep(DELAY_MS);
  } catch (e) {
    failed++;
    console.warn(`  ✗ ${r.date} ${r.track}${r.race_no}R: ${e.message}`);
    await sleep(DELAY_MS * 2);
  }
}
save();
console.log(
  `完了: 処理${done} 取得${done - noOdds} オッズ無し${noOdds} スキップ${skipped} 失敗${failed} → ${OUT}(累計${Object.keys(store).length}レース)`,
);
