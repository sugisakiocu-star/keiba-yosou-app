// 指定日・指定場の全レースのオッズ(単勝・複勝、オプションでワイド・馬連・3連複・3連単)を
// JRA公式から取得してローカルJSON(scripts/odds.local.json、gitignore済み)にスナップショット
// 保存するローカルバッチ。フェーズ4Bの試験版(DB書き込みなし・Vercel cron化は動作検証後)。
//
// 使い方(プロジェクト直下で):
//   node scripts/fetch-odds.mjs --date 2026-07-11 --track 福島 --label morning
//   node scripts/fetch-odds.mjs --date 2026-07-11 --track 福島 --label afternoon --bets tanpuku,wide,umaren
//   node scripts/fetch-odds.mjs --date 2026-07-11 --track 福島 --bets tanpuku,trio,tierce --max-requests 100
//     … 3連複・3連単込み(1レースあたり単複+trio+tierceで3リクエスト、12レースなら36件。
//       3連単ページは1レースあたり数百KB〜1MB近くと重いので、対象を絞って使うこと)
//   node scripts/fetch-odds.mjs --date 2026-07-11 --track 福島 --dry   … クロール連鎖の確認のみ(保存なし)
//
// ⚠️ 制約(2026-07-10偵察・memory keiba-app-phase4b-odds-recon):
//   - オッズは開催当日朝10時発売開始。発売前は accessO 開催選択が「今週のオッズは未発表です。」
//     のみのデッドエンドになる(このスクリプトはその場合明確にエラー終了する)。
//   - cname のチェックサムはサーバー計算のため自前生成不可。必ずページ上のリンクから拾う。
//   - 発売中オッズページの実物は未確認(最終オッズでのみパース検証済み)。構造が想定と違う場合は
//     scratchpad にHTMLを保存して終了するので、それを見てパーサーを直すこと。
//
// 設計方針(プロジェクトの取得ルール準拠): JRA公式のみ・UA明示・1.5秒間隔・リクエスト上限つき。

import fs from "node:fs";

// ---- 設定 ----
const UA = "keiba-yosou-app (personal study project)";
const ACCESS_O = "https://www.jra.go.jp/JRADB/accessO.html";
const ODDS_INDEX_CNAME = "pw15oli00/6D"; // オッズ入口(トップの doAction から既知)
const DELAY_MS = 1500;
const OUT_PATH = new URL("./odds.local.json", import.meta.url).pathname;
const DEBUG_DIR = "/tmp/jra-odds-debug"; // 想定外HTML保存先(セッションに依存しない場所)

// ---- CLI引数 ----
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const DATE = argOf("--date", null); // YYYY-MM-DD
const TRACK = argOf("--track", null); // 例: 福島
const LABEL = argOf("--label", "snapshot");
const BETS = argOf("--bets", "tanpuku,wide,umaren").split(",");
const DRY = args.includes("--dry");
const MAX_REQ = Number(argOf("--max-requests", "60"));
if (!DATE || !TRACK) {
  console.error("使い方: node scripts/fetch-odds.mjs --date YYYY-MM-DD --track 福島 [--label morning] [--bets tanpuku,wide,umaren] [--dry]");
  process.exit(1);
}

// ---- 小物(backfill-all-results.mjs と同じ流儀) ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (buf) => new TextDecoder("shift_jis").decode(buf);
const stripTags = (s) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const toNum = (s) => {
  const m = String(s ?? "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

let reqCount = 0;
async function withRetry(fn, label, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = DELAY_MS * (i + 1) * 2;
      if (i < tries - 1) {
        console.warn(`   … リトライ ${i + 1}/${tries - 1} (${label}): ${e.message} → ${wait}ms待機`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}
async function postO(cname) {
  if (reqCount >= MAX_REQ) throw new Error(`リクエスト上限(${MAX_REQ})に到達。設計を見直すこと`);
  reqCount++;
  const html = await withRetry(async () => {
    const res = await fetch(ACCESS_O, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ cname }).toString(),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`POST ${res.status} cname=${cname}`);
    return decode(await res.arrayBuffer());
  }, `POST ${cname}`);
  await sleep(DELAY_MS);
  return html;
}
function saveDebug(name, html) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const p = `${DEBUG_DIR}/${name}`;
  fs.writeFileSync(p, html);
  return p;
}

// accessO 系リンク(doAction('/JRADB/accessO.html','CNAME'))を [{cname, text}] で列挙
function parseOLinks(html) {
  const out = [];
  const re = /<a[^>]*doAction\('\/JRADB\/accessO\.html'\s*,\s*'([^']+)'\)[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) out.push({ cname: m[1], text: stripTags(m[2]) });
  return out;
}

// ---- パーサー ----
// 単勝・複勝ページ(table.tanpuku)。返り値: { raceName, horses: {umaban: {name, tan, fukuMin, fukuMax}}, betCnames }
function parseTanpuku(html) {
  const raceName = stripTags((html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? "");
  const horses = {};
  const tbl = (html.match(/<table[^>]*class="[^"]*tanpuku[^"]*"[\s\S]*?<\/table>/) ?? [])[0];
  if (!tbl) return null;
  const rows = tbl.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  for (const tr of rows) {
    const num = (tr.match(/<td[^>]*class="[^"]*num[^"]*"[^>]*>([\s\S]*?)<\/td>/) ?? [])[1];
    if (num == null) continue;
    const umaban = toNum(stripTags(num));
    if (umaban == null) continue;
    const name = stripTags((tr.match(/<td[^>]*class="[^"]*horse[^"]*"[^>]*>([\s\S]*?)<\/td>/) ?? [])[1] ?? "");
    const tan = toNum(stripTags((tr.match(/<td[^>]*class="[^"]*odds_tan[^"]*"[^>]*>([\s\S]*?)<\/td>/) ?? [])[1] ?? ""));
    const fukuCell = (tr.match(/<td[^>]*class="[^"]*odds_fuku[^"]*"[^>]*>([\s\S]*?)<\/td>/) ?? [])[1] ?? "";
    const fukuMin = toNum(stripTags((fukuCell.match(/<span[^>]*class="[^"]*min[^"]*"[^>]*>([\s\S]*?)<\/span>/) ?? [])[1] ?? ""));
    const fukuMax = toNum(stripTags((fukuCell.match(/<span[^>]*class="[^"]*max[^"]*"[^>]*>([\s\S]*?)<\/span>/) ?? [])[1] ?? ""));
    horses[umaban] = { name, tan, fukuMin, fukuMax };
  }
  // 同ページ内の他式別cname(nav pills)
  const betCnames = {};
  for (const { cname } of parseOLinks(html)) {
    if (/^pw154ou/.test(cname)) betCnames.umaren ??= cname;
    if (/^pw155ou/.test(cname)) betCnames.wide ??= cname;
    if (/^pw156ou/.test(cname)) betCnames.umatan ??= cname;
    if (/^pw157ou/.test(cname)) betCnames.trio ??= cname;
    if (/^pw158ou/.test(cname)) betCnames.tierce ??= cname;
  }
  // 更新時刻表示(発売中は「◯時◯分現在」想定・最終は「最終オッズ」)
  const refresh = stripTags((html.match(/<div[^>]*class="[^"]*refresh_line[^"]*"[\s\S]*?<\/div>\s*<\/div>/) ?? [])[0] ?? "");
  return { raceName, horses, betCnames, refresh };
}

// 組み合わせ表(ワイド=範囲、馬連=単一値)。返り値: { "1-2": [min,max]|odds }
function parseCombi(html, kind) {
  const out = {};
  const blocks = html.match(/<caption>[\s\S]*?<\/caption>[\s\S]*?<\/tbody>/g) ?? [];
  for (const block of blocks) {
    const base = toNum(stripTags((block.match(/<caption>([\s\S]*?)<\/caption>/) ?? [])[1] ?? ""));
    if (base == null) continue;
    const rows = block.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    for (const tr of rows) {
      const partner = toNum(stripTags((tr.match(/<th[^>]*>([\s\S]*?)<\/th>/) ?? [])[1] ?? ""));
      if (partner == null) continue;
      const key = [base, partner].sort((a, b) => a - b).join("-");
      if (kind === "wide") {
        const min = toNum(stripTags((tr.match(/<span[^>]*class="[^"]*min[^"]*"[^>]*>([\s\S]*?)<\/span>/) ?? [])[1] ?? ""));
        const max = toNum(stripTags((tr.match(/<span[^>]*class="[^"]*max[^"]*"[^>]*>([\s\S]*?)<\/span>/) ?? [])[1] ?? ""));
        if (min != null) out[key] = [min, max];
      } else {
        const v = toNum(stripTags((tr.match(/<td[^>]*>([\s\S]*?)<\/td>/) ?? [])[1] ?? ""));
        if (v != null) out[key] = v;
      }
    }
  }
  return out;
}

// 3連複表(table.fuku3)。<caption>1-2</caption> の下に3頭目(th)×オッズ(td)が並ぶ。
// 返り値: { "1-2-3": odds }(キーは3頭を昇順ソートして結合)
function parseTrio(html) {
  const out = {};
  const blocks = html.match(/<caption>[\s\S]*?<\/caption>[\s\S]*?<\/tbody>/g) ?? [];
  for (const block of blocks) {
    const capTxt = stripTags((block.match(/<caption>([\s\S]*?)<\/caption>/) ?? [])[1] ?? "");
    const basePair = capTxt.split("-").map(Number);
    if (basePair.length !== 2 || basePair.some((n) => !Number.isFinite(n))) continue;
    const rows = block.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    for (const tr of rows) {
      const third = toNum(stripTags((tr.match(/<th[^>]*>([\s\S]*?)<\/th>/) ?? [])[1] ?? ""));
      if (third == null) continue;
      const v = toNum(stripTags((tr.match(/<td[^>]*>([\s\S]*?)<\/td>/) ?? [])[1] ?? ""));
      if (v == null) continue; // &nbsp;(無効な組み合わせ)はスキップ
      const key = [...basePair, third].sort((a, b) => a - b).join("-");
      out[key] = v;
    }
  }
  return out;
}

// 3連単表(div.tan3_unit)。1着(h4見出し) > li(2着ごと) > table(3着ごとの単一オッズ)の3階層。
// 返り値: { "1-2-3": odds }(キーは着順どおり=順序を保持、ソートしない)
function parseTierce(html) {
  const out = {};
  const units = html.split('<div class="tan3_unit').slice(1);
  for (const rawUnit of units) {
    const unit = '<div class="tan3_unit' + rawUnit;
    const firstNum = toNum(
      stripTags((unit.match(/<h4[^>]*>[\s\S]*?<span class="num">([\s\S]*?)<\/span>/) ?? [])[1] ?? ""),
    );
    if (firstNum == null) continue;
    const lis = unit.match(/<li>[\s\S]*?<\/table>[\s\S]*?<\/li>/g) ?? [];
    for (const li of lis) {
      const nums = [...li.matchAll(/<div class="num">([\s\S]*?)<\/div>/g)].map((m) =>
        toNum(stripTags(m[1])),
      );
      const second = nums[1]; // nums[0]は1着(unitと重複)、nums[1]がこのliの2着
      if (second == null) continue;
      const rows = li.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
      for (const tr of rows) {
        const third = toNum(stripTags((tr.match(/<th[^>]*>([\s\S]*?)<\/th>/) ?? [])[1] ?? ""));
        if (third == null) continue;
        const v = toNum(stripTags((tr.match(/<td[^>]*>([\s\S]*?)<\/td>/) ?? [])[1] ?? ""));
        if (v == null) continue; // &nbsp;(無効な組み合わせ)はスキップ
        out[`${firstNum}-${second}-${third}`] = v;
      }
    }
  }
  return out;
}

// ---- クロール連鎖 ----
console.log(`■ オッズ取得  ${DATE} ${TRACK}  label=${LABEL}  bets=${BETS.join(",")}  DRY=${DRY}`);
const [, mm, dd] = DATE.match(/^\d{4}-(\d{2})-(\d{2})$/) ?? [];
if (!mm) {
  console.error("--date は YYYY-MM-DD 形式で指定");
  process.exit(1);
}
const dateLabelA = `${Number(mm)}月${Number(dd)}日`; // 例: 7月11日

// ① オッズ入口 → 開催選択
const indexHtml = await postO(ODDS_INDEX_CNAME);
if (/今週のオッズは未発表です/.test(indexHtml)) {
  console.error("✗ オッズ未発表(発売は開催当日朝10時〜)。時間を改めて実行すること。");
  process.exit(2);
}
const dayLinks = parseOLinks(indexHtml);
if (dayLinks.length === 0) {
  const p = saveDebug("odds-index.html", indexHtml);
  console.error(`✗ 開催選択ページにaccessOリンクが見つからない(構造が想定外)。HTML保存: ${p}`);
  process.exit(3);
}
console.log(`  開催選択リンク ${dayLinks.length}件:`);
for (const l of dayLinks.slice(0, 20)) console.log(`    - "${l.text}" → ${l.cname}`);

// 日付+場が一致するリンクを探す。テキストは「7月11日（土曜）2回福島3日」形式のほか
// 「2回福島5日」のように日付を含まない場合がある(2026-07-10確認)ので、
// その場合は cname 内の開催日8桁(例: …20260711/17)でマッチする。
const ymd = DATE.replace(/-/g, "");
const dayLink = dayLinks.find(
  (l) =>
    l.text.includes(TRACK) &&
    (l.text.includes(dateLabelA) || l.text.includes(`${mm}月${dd}日`) || l.cname.includes(ymd)),
);
if (!dayLink) {
  const p = saveDebug("odds-index.html", indexHtml);
  console.error(`✗ "${dateLabelA} ${TRACK}" に一致する開催リンクが無い。HTML保存: ${p}`);
  process.exit(3);
}
console.log(`  → 選択: "${dayLink.text}"`);

// ② 開催選択 → レース一覧(単複ページへのリンク pw151ou… が12個並ぶ想定)
const raceListHtml = await postO(dayLink.cname);
let raceLinks = parseOLinks(raceListHtml).filter((l) => /^pw151ou/.test(l.cname));
if (raceLinks.length === 0) {
  // 想定外: レース一覧が式別選択などを挟む場合に備えて1階層だけ潜ってみる
  const mid = parseOLinks(raceListHtml).find((l) => /単勝|複勝/.test(l.text));
  if (mid) {
    const midHtml = await postO(mid.cname);
    raceLinks = parseOLinks(midHtml).filter((l) => /^pw151ou/.test(l.cname));
  }
}
if (raceLinks.length === 0) {
  const p = saveDebug("odds-racelist.html", raceListHtml);
  console.error(`✗ レース一覧に単複オッズリンク(pw151ou)が無い。HTML保存: ${p}`);
  process.exit(3);
}
// cname中のレース番号(日付8桁の直前2桁)で昇順に
const raceNoOf = (cname) => Number((cname.match(/(\d{2})\d{8}Z/) ?? [])[1] ?? 0);
raceLinks = [...new Map(raceLinks.map((l) => [l.cname, l])).values()].sort(
  (a, b) => raceNoOf(a.cname) - raceNoOf(b.cname),
);
console.log(`  レース ${raceLinks.length}件検出`);

// ③ 各レースの単複(+ワイド・馬連)を取得
const snapshot = { label: LABEL, fetchedAt: new Date().toISOString(), date: DATE, track: TRACK, races: [] };
for (const l of raceLinks) {
  const raceNo = raceNoOf(l.cname);
  const html = await postO(l.cname);
  const tp = parseTanpuku(html);
  if (!tp || Object.keys(tp.horses).length === 0) {
    const p = saveDebug(`odds-r${raceNo}-tanpuku.html`, html);
    console.warn(`  △ ${raceNo}R 単複テーブルのパース失敗。HTML保存: ${p}`);
    continue;
  }
  const race = {
    raceNo,
    refresh: tp.refresh,
    horses: tp.horses,
    tanpukuCname: l.cname,
  };
  if (BETS.includes("wide") && tp.betCnames.wide) {
    race.wide = parseCombi(await postO(tp.betCnames.wide), "wide");
  }
  if (BETS.includes("umaren") && tp.betCnames.umaren) {
    race.umaren = parseCombi(await postO(tp.betCnames.umaren), "umaren");
  }
  if (BETS.includes("trio") && tp.betCnames.trio) {
    race.trio = parseTrio(await postO(tp.betCnames.trio));
  }
  if (BETS.includes("tierce") && tp.betCnames.tierce) {
    race.tierce = parseTierce(await postO(tp.betCnames.tierce));
  }
  snapshot.races.push(race);
  const n = Object.keys(tp.horses).length;
  const fav = Object.entries(tp.horses).sort((a, b) => (a[1].tan ?? 999) - (b[1].tan ?? 999))[0];
  console.log(
    `  ○ ${String(raceNo).padStart(2)}R ${n}頭  1人気=${fav?.[1].name}(単${fav?.[1].tan})  ${tp.refresh}  [req計${reqCount}]`,
  );
}

// ④ 保存(スナップショット追記方式)
if (DRY) {
  console.log(`\nDRY: 保存せず終了。総リクエスト ${reqCount}`);
  process.exit(0);
}
let store = { snapshots: [] };
try {
  store = JSON.parse(fs.readFileSync(OUT_PATH, "utf-8"));
} catch {
  /* 初回 */
}
store.snapshots.push(snapshot);
fs.writeFileSync(OUT_PATH, JSON.stringify(store, null, 1));
console.log(
  `\n完了: ${snapshot.races.length}レース保存 → ${OUT_PATH}(累計スナップショット${store.snapshots.length}件)  総リクエスト ${reqCount}`,
);
