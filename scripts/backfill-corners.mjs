// DBに保存済みの結果ページcname(race_results.cname)を再取得し、各馬のコーナー通過順位だけを
// 抽出して scripts/corners.local.json に保存するローカルバッチ。脚質(逃げ/先行/差し/追込)特徴量の材料。
// 公開リポジトリにJRA由来データを再配布しないため、出力はコミットしない(.gitignore)。
//
// 使い方(プロジェクト直下で):
//   node scripts/backfill-corners.mjs --dry --limit 3     … 先頭3件を取得して内容表示(保存もする)
//   node scripts/backfill-corners.mjs --skip-existing     … 全件(未取得のみ)。約8,800件×1.5秒≒3.7時間
//   node scripts/backfill-corners.mjs --since 2025-01-01 --until 2025-12-31 --skip-existing
//
// 取得ルール(プロジェクト方針準拠): JRA公式のみ・UA明示・1.5秒間隔・キャッシュ済みは再取得しない。
// 途中で止めても --skip-existing で再開できる(50件ごとに追記保存)。

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const UA = "keiba-yosou-app (personal study project)";
const ACCESS_S = "https://www.jra.go.jp/JRADB/accessS.html";
const DELAY_MS = 1500;
const OUT = new URL("./corners.local.json", import.meta.url).pathname;
const SAVE_EVERY = 50;

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const DRY = args.includes("--dry");
const LIMIT = Number(argOf("--limit", "Infinity"));
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

async function getResultHtml(cname) {
  const res = await fetchRetry(ACCESS_S, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ cname }).toString(),
  });
  return new TextDecoder("shift_jis").decode(await res.arrayBuffer());
}

const stripTags = (s) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// 着順テーブルの各行から { umaban: "1-1-1-1" } を抽出。
// <td class="num">2</td> … <td class="corner"><ul><li title="1コーナー通過順位">1</li>…</ul></td>
// 直線競馬(新潟1000m)はコーナー無し、中止馬は空、障害は5個以上もあり得る。
function parseCorners(html) {
  const out = {};
  const rows = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  for (const tr of rows) {
    const num = (tr.match(/<td[^>]*class="[^"]*num[^"]*"[^>]*>([\s\S]*?)<\/td>/) ?? [])[1];
    if (num == null) continue;
    const umaban = Number(stripTags(num));
    if (!Number.isFinite(umaban) || umaban < 1) continue;
    const cell = (tr.match(/<td[^>]*class="[^"]*corner[^"]*"[^>]*>([\s\S]*?)<\/td>/) ?? [])[1] ?? "";
    const lis = [...cell.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]));
    const corners = lis.filter((v) => v !== "").join("-");
    out[umaban] = corners || null;
  }
  return out;
}

// ---- 対象レースをDBから取得 ----
console.log(`■ コーナー通過順バックフィル  since=${SINCE ?? "-"} until=${UNTIL ?? "-"} skipExisting=${SKIP_EXISTING} limit=${LIMIT}`);
let store = {};
try {
  store = JSON.parse(fs.readFileSync(OUT, "utf-8"));
} catch {
  /* 初回 */
}

const races = [];
for (let from = 0; ; from += 1000) {
  let q = supabase
    .from("race_results")
    .select("id,date,track,race_no,name,cname")
    .order("date", { ascending: false })
    .order("id", { ascending: true })
    .range(from, from + 999);
  if (SINCE) q = q.gte("date", SINCE);
  if (UNTIL) q = q.lte("date", UNTIL);
  const { data, error } = await q;
  if (error) {
    console.error("DB読み取りエラー:", error.message);
    process.exit(1);
  }
  races.push(...data);
  if (data.length < 1000) break;
}
console.log(`  対象 ${races.length}レース(新しい順)`);

let done = 0, skipped = 0, failed = 0, reqCount = 0;
const save = () => fs.writeFileSync(OUT, JSON.stringify(store));

for (const r of races) {
  if (done + failed >= LIMIT) break;
  if (SKIP_EXISTING && store[r.id]) {
    skipped++;
    continue;
  }
  try {
    const html = await getResultHtml(r.cname);
    reqCount++;
    const corners = parseCorners(html);
    if (Object.keys(corners).length === 0) {
      console.warn(`  △ ${r.date} ${r.track}${r.race_no}R ${r.name}: コーナー行が0件(パース確認要)`);
      failed++;
    } else {
      store[r.id] = { date: r.date, track: r.track, race_no: r.race_no, corners };
      done++;
      if (DRY) console.log(`  ○ ${r.date} ${r.track}${r.race_no}R ${r.name}:`, JSON.stringify(corners));
    }
    if (done % SAVE_EVERY === 0) save();
    if (done % 200 === 0 && done > 0 && !DRY)
      console.log(`  … ${done}件取得(スキップ${skipped}・失敗${failed})  ${r.date}まで到達`);
    await sleep(DELAY_MS);
  } catch (e) {
    failed++;
    console.warn(`  ✗ ${r.date} ${r.track}${r.race_no}R: ${e.message}`);
    await sleep(DELAY_MS * 2);
  }
}
save();
console.log(
  `\n完了: 取得${done} スキップ${skipped} 失敗${failed} リクエスト${reqCount} → ${OUT}(累計${Object.keys(store).length}レース)`,
);
