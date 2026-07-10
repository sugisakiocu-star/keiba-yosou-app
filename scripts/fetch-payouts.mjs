// DBに保存済みの重賞結果(race_results.cname)から、結果ページの「払戻金」だけを取得する一回限りのローカルバッチ。
// 出力はローカルJSON(scripts/payouts.local.json)。公開リポジトリにJRAの払戻データを再配布しないため、コミットしない(.gitignore)。
//
// 使い方(プロジェクト直下で):
//   node scripts/fetch-payouts.mjs --dry --limit 3   … 先頭3件だけ取得して内容を表示(保存もする)
//   node scripts/fetch-payouts.mjs                   … 平地重賞130件を全取得(1.5秒間隔で約4分)
//   node scripts/fetch-payouts.mjs --skip-existing   … 既にJSONにある分は再取得しない
//
// 取得ルール(プロジェクト方針準拠): JRA公式のみ・UA明示・リクエスト間隔1.5秒・一回限り+キャッシュ。

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const UA = "keiba-yosou-app (personal study project)";
const ACCESS_S = "https://www.jra.go.jp/JRADB/accessS.html";
const DELAY_MS = 1500;
const OUT = new URL("./payouts.local.json", import.meta.url).pathname;

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const limIdx = args.indexOf("--limit");
const LIMIT = limIdx >= 0 ? Number(args[limIdx + 1]) : Infinity;
const SKIP_EXISTING = args.includes("--skip-existing");

try {
  process.loadEnvFile(".env");
} catch {}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 指数バックオフ付きfetch(バックフィル時にネットワーク断続エラーがあったため)
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

// 払戻金ブロックをパースする。
// <li class="win"><dl><dt>単勝</dt><dd><div class="line"><div class="num">2</div><div class="yen">420...
// 券種: win(単勝) place(複勝) wakuren(枠連) wide(ワイド) umaren(馬連) umatan(馬単) trio(3連複) tierce(3連単)
export function parsePayouts(html) {
  const start = html.indexOf('class="refund_area');
  if (start < 0) return null;
  const block = html.slice(start, html.indexOf("caution", start));
  const out = {};
  for (const li of block.matchAll(/<li class="(win|place|wakuren|wide|umaren|umatan|trio|tierce)">([\s\S]*?)<\/li>/g)) {
    const lines = [];
    for (const line of li[2].matchAll(
      /<div class="num">([\s\S]*?)<\/div>\s*<div class="yen">([\s\S]*?)<\/div>/g,
    )) {
      const num = line[1].replace(/<[^>]+>/g, "").trim(); // 例 "2" / "2-15" / "2-15-7"
      const yenTxt = line[2].replace(/<[^>]+>/g, "").replace(/[,円\s]/g, "");
      const yen = Number(yenTxt);
      if (num && Number.isFinite(yen)) lines.push({ num, yen });
    }
    out[li[1]] = lines;
  }
  return out;
}

// ---- メイン ----
// import.meta.url で「直接実行された時だけ」動くようにガードする。
// これが無いと、他スクリプトから parsePayouts だけを import した際にも
// このクロールループ一式が(しかも process.argv を共有した状態で)勝手に実行されてしまう。
async function main() {
  const { data: races, error } = await supabase
    .from("race_results")
    .select("id, date, track, name, grade, cname")
    .order("date");
  if (error) {
    console.error(error);
    process.exit(1);
  }
  const targets = races.filter((r) => r.grade && !r.grade.startsWith("J") && r.cname);

  let store = {};
  if (fs.existsSync(OUT)) store = JSON.parse(fs.readFileSync(OUT, "utf-8"));

  let done = 0;
  for (const r of targets) {
    if (done >= LIMIT) break;
    if (SKIP_EXISTING && store[r.id]) continue;
    const html = await getResultHtml(r.cname);
    const payouts = parsePayouts(html);
    if (!payouts || !payouts.win?.length) {
      console.warn(`⚠ 払戻が取れない: ${r.date} ${r.name}`);
    } else {
      store[r.id] = { date: r.date, track: r.track, name: r.name, grade: r.grade, payouts };
    }
    done++;
    if (DRY) console.log(r.date, r.name, JSON.stringify(payouts));
    process.stdout.write(`\r${done}/${Math.min(targets.length, LIMIT)} ${r.date} ${r.name}          `);
    await sleep(DELAY_MS);
  }
  fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
  console.log(`\n保存: ${OUT}(${Object.keys(store).length}レース分)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
