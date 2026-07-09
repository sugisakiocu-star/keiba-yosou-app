// 指定期間の「全レース」(重賞に限らずOP/リステッド/条件戦も含む)結果を JRA 公式から
// クロールして Supabase に保存するローカルバッチ。scripts/backfill-graded-results.mjs(重賞専用)
// とは別スクリプトとして新設。既存スクリプトは変更しない。
//
// 背景: 予想モデルの近走フォームスコアが、重賞歴の無い条件戦好走馬を過小評価している問題を
// バックテスト側でも解消するため、重賞以外のレース結果もためる。
//
// 使い方(プロジェクト直下で):
//   node scripts/backfill-all-results.mjs --dry --from 2026-06-01 --to 2026-06-30
//     … 2026年6月だけ試し、DB書き込みせず件数/リクエスト数を確認
//   node scripts/backfill-all-results.mjs --from 2026-06-01 --to 2026-06-30 --skip-existing
//     … 実際に保存(月単位などチャンクに分けて複数回実行する想定)
//   node scripts/backfill-all-results.mjs --year 2026 --skip-existing
//     … 2026-01-01〜今日(未来日は除外)をまとめて対象にする(通常は月ごとに分けて叩くこと)
//   node scripts/backfill-all-results.mjs
//     … 期間指定なしなら安全のため既定で直近1ヶ月だけ
//
// 設計方針(プロジェクトの取得ルール準拠):
//   - JRA公式のみ。UA明示。リクエスト間隔を DELAY_MS 空ける(既定1.5秒、重賞版と同じ)。
//   - 重賞版との違いは「レース列挙をカレンダーJSONの重賞名一致で絞り込まない」ことだけ。
//     開催日の選択ページ(parseSelection)はもともと全レースを列挙できるので、絞り込みを外すだけでよい。
//   - 同日に複数場(例: 東京・阪神が同日開催)が開催していれば、その日の dayCnames を全部回り、
//     それぞれの選択ページから全レースを集める(「1つの場で見つかったら終わり」にしない。
//     重賞は1日1回という前提が崩れるため matchRace 的な名前一致・breakは行わない)。
//   - 選択ページのヘッダー(class="opt")に開催場(例:「2026年7月4日（土曜）2回福島3日」)が
//     載っているため、結果ページを叩く前に track を確定できる。これを使って --skip-existing を
//     「結果ページを叩く前」に効かせ、無駄なリクエストを減らす。
//   - JRADB の HTML は Shift_JIS。TextDecoder("shift_jis") で明示デコード。
//
// クロール連鎖:
//   /keiba/ → 過去結果入口 pw01skl00999999 → (月ページ pw01skl10YYYYMM を前月へ辿って開催日リンクを収集)
//     → 開催日 pw01srl…YYYYMMDD(=場ごとの選択ページ) → 選択ページの全レース(pw01sde…) → 結果テーブル

import { createClient } from "@supabase/supabase-js";

// ---- 設定 ----
const UA = "keiba-yosou-app (personal study project)";
const KEIBA_TOP = "https://www.jra.go.jp/keiba/";
const ACCESS_S = "https://www.jra.go.jp/JRADB/accessS.html";
const DELAY_MS = 1500;

// ---- CLI引数 ----
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const limIdx = args.indexOf("--limit");
const LIMIT = limIdx >= 0 ? Number(args[limIdx + 1]) : Infinity;
const VERBOSE = args.includes("--verbose");
const SKIP_EXISTING = args.includes("--skip-existing");

const fromIdx = args.indexOf("--from");
const toIdx = args.indexOf("--to");
const yearIdx = args.indexOf("--year");
const todayStr = new Date().toISOString().slice(0, 10);

let fromDate, toDate;
if (yearIdx >= 0) {
  const y = args[yearIdx + 1];
  fromDate = `${y}-01-01`;
  toDate = `${y}-12-31`;
} else if (fromIdx >= 0 || toIdx >= 0) {
  fromDate = fromIdx >= 0 ? args[fromIdx + 1] : todayStr;
  toDate = toIdx >= 0 ? args[toIdx + 1] : todayStr;
} else {
  // 期間指定なし: 安全のため既定で直近1ヶ月だけ(明示的に --from/--to/--year を渡さないと広がらない)
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  fromDate = d.toISOString().slice(0, 10);
  toDate = todayStr;
}
if (toDate > todayStr) toDate = todayStr; // 未来日は結果が無いのでクランプ

// ---- env ----
try {
  process.loadEnvFile(".env");
} catch {
  // .env が無ければ process.env をそのまま使う
}
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---- 小物 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (buf) => new TextDecoder("shift_jis").decode(buf);
const stripTags = (s) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const toInt = (s) => {
  const m = String(s ?? "").match(/-?\d+/);
  return m ? Number(m[0]) : null;
};
const toNum = (s) => {
  const m = String(s ?? "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

let reqCount = 0;
// 一過性のネットワーク失敗(fetch failed 等)に備え、指数バックオフで数回リトライする。
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
async function getHtml(url) {
  reqCount++;
  const html = await withRetry(async () => {
    const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
    if (!res.ok) throw new Error(`GET ${res.status} ${url}`);
    return decode(await res.arrayBuffer());
  }, `GET ${url}`);
  await sleep(DELAY_MS);
  return html;
}
async function post(cname) {
  reqCount++;
  const html = await withRetry(async () => {
    const res = await fetch(ACCESS_S, {
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

// ---- クロール ----

// /keiba/ から「過去のレース結果」入口 cname(pw01skl00…)を取得
async function fetchResultsIndexCname() {
  const html = await getHtml(KEIBA_TOP);
  const m = html.match(/doAction\('\/JRADB\/accessS\.html',\s*'(pw01skl00[0-9]+\/[0-9A-F]{2})'\)/);
  if (!m) throw new Error("過去レース結果の入口 cname(pw01skl00) が /keiba/ に無い");
  return m[1];
}

// 月ページ/索引ページから開催日リンク(pw01srl…YYYYMMDD/XX)を { date: cname } で取り出す
// 同日に複数場が開催していれば、場ごとに異なる cname が複数入る。
function parseDayLinks(html) {
  const re = /pw01srl\d{12}(\d{8})\/[0-9A-F]{2}/g;
  const out = {};
  for (const m of html.matchAll(re)) {
    const cname = m[0];
    const d = m[1];
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    (out[date] ||= new Set()).add(cname);
  }
  return out;
}

// 月ページから、指定 YYYYMM の月ページ cname を取り出す(前月ナビ用)
function findMonthCname(html, ym) {
  const m = html.match(new RegExp(`pw01skl10${ym}/[0-9A-F]{2}`));
  return m ? m[0] : null;
}

// fromDate の月まで、開催日リンクマップ { 'YYYY-MM-DD': Set(cname) } を月ページを遡って集める
async function collectDayLinks(fromDate) {
  const fromYm = fromDate.slice(0, 4) + fromDate.slice(5, 7);
  const dayMap = {};
  const merge = (src) => {
    for (const [date, set] of Object.entries(src)) {
      (dayMap[date] ||= new Set());
      for (const c of set) dayMap[date].add(c);
    }
  };

  const indexCname = await fetchResultsIndexCname();
  const indexHtml = await post(indexCname);
  merge(parseDayLinks(indexHtml)); // 索引ページには直近の開催日も載っている

  const monthLinks = [...indexHtml.matchAll(/pw01skl10(\d{6})\/[0-9A-F]{2}/g)].map((m) => m[1]);
  let ym = monthLinks.sort().reverse()[0];
  if (!ym) {
    const now = new Date();
    ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  let cname = findMonthCname(indexHtml, ym);
  while (cname && ym >= fromYm) {
    const html = await post(cname);
    merge(parseDayLinks(html));
    const y = Number(ym.slice(0, 4));
    const mo = Number(ym.slice(4, 6));
    const prev = mo === 1 ? `${y - 1}12` : `${y}${String(mo - 1).padStart(2, "0")}`;
    cname = findMonthCname(html, prev);
    ym = prev;
  }
  return dayMap;
}

// sde コードに埋まっているレース番号を取り出す(権威ソース)。
function raceNoFromSde(sde) {
  const m = String(sde ?? "").match(/pw01sde\d{12}(\d{2})\d{8}\//);
  return m ? Number(m[1]) : null;
}

// 選択ページのヘッダー(class="opt": 例「2026年7月4日（土曜）2回福島3日」)から
// 開催場を取り出す。結果ページを叩く前に track を確定させ、skip-existing 判定に使う。
function parseSelectionHeader(html) {
  const m = html.match(/class="opt">([\s\S]*?)<\/span>/);
  if (!m) return {};
  const t = stripTags(m[1]);
  const meta = {};
  const km = t.match(/(\d+)回(\D+?)(\d+)日/);
  if (km) {
    meta.kai = Number(km[1]);
    meta.track = km[2].trim();
    meta.nichi = Number(km[3]);
  }
  return meta;
}

// レース選択ページから [{ raceNo, name, sde }] を取り出す(重賞に限らず全レース)
function parseSelection(html) {
  const out = [];
  const re =
    /class="race_num">[\s\S]*?(pw01sde\d+\/[0-9A-F]{2})[\s\S]*?alt="(\d+)レース"[\s\S]*?class="race_name">([\s\S]*?)<\/td>/g;
  for (const m of html.matchAll(re)) {
    out.push({ sde: m[1], raceNo: raceNoFromSde(m[1]) ?? Number(m[2]), name: stripTags(m[3]) });
  }
  return out;
}

// 結果ページから レースメタ + 着順配列 を取り出す
function parseResult(html) {
  const meta = {};

  const rno = html.match(/alt="(\d+)レース"/);
  meta.raceNo = rno ? Number(rno[1]) : null;

  const dateCell = html.match(/class="cell date"[^>]*>([\s\S]*?)<\/(li|td|div)>/);
  if (dateCell) {
    const t = stripTags(dateCell[1]);
    const dm = t.match(/(\d+)年(\d+)月(\d+)日/);
    if (dm)
      meta.date = `${dm[1]}-${String(dm[2]).padStart(2, "0")}-${String(dm[3]).padStart(2, "0")}`;
    const km = t.match(/(\d+)回(\D+?)(\d+)日/);
    if (km) {
      meta.kai = Number(km[1]);
      meta.track = km[2].trim();
      meta.nichi = Number(km[3]);
    }
  }

  const course = html.match(/class="cell course"[\s\S]*?コース：<\/span>\s*([\d,]+)\s*<span class="unit">メートル<\/span>\s*<span class="detail">（([^）]+)）/);
  if (course) {
    meta.distance = toInt(course[1].replace(/,/g, ""));
    meta.surface = course[2].split(/[・\/]/)[0].trim();
  }

  const babaCell = html.match(/class="cell baba"([\s\S]*?)<\/ul>/);
  if (babaCell) {
    const pairs = [...babaCell[1].matchAll(/<span class="cap">([^<]*)<\/span><span class="txt">([\s\S]*?)<\/span>/g)];
    for (const p of pairs) {
      const cap = p[1].trim();
      const val = stripTags(p[2]);
      if (cap === "天候") meta.weather = val;
      else if (["芝", "ダート", "ダ", "障"].includes(cap)) meta.going = val;
    }
  }

  const nameCell = html.match(/class="race_name">([\s\S]*?)<\/(div|h1|h2)>/);
  if (nameCell) meta.name = stripTags(nameCell[1]);

  const horses = [];
  const tbl = html.match(/<table class="basic narrow-xy striped"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
  if (tbl) {
    const rows = tbl[1].split(/<tr[\s>]/).slice(1);
    for (const row of rows) {
      const cell = (cls) => {
        const m = row.match(new RegExp(`<td class="${cls}"[^>]*>([\\s\\S]*?)</td>`));
        return m ? m[1] : "";
      };
      const placeRaw = stripTags(cell("place"));
      if (!placeRaw && !cell("num")) continue;
      const wakuImg = cell("waku").match(/枠(\d)/);
      const hw = cell("h_weight");
      const hwm = hw.match(/(\d+)\s*<span>\(([^)]*)\)<\/span>/);
      horses.push({
        place: /^\d+$/.test(placeRaw) ? Number(placeRaw) : null,
        place_text: /^\d+$/.test(placeRaw) ? null : placeRaw || null,
        waku: wakuImg ? Number(wakuImg[1]) : null,
        umaban: toInt(stripTags(cell("num"))),
        name: stripTags(cell("horse")) || "(不明)",
        sex_age: stripTags(cell("age")) || null,
        weight_carry: toNum(stripTags(cell("weight"))),
        jockey: stripTags(cell("jockey")) || null,
        time: stripTags(cell("time")) || null,
        margin: stripTags(cell("margin")) || null,
        last3f: toNum(stripTags(cell("f_time"))),
        horse_weight: hwm ? Number(hwm[1]) : toInt(stripTags(hw)),
        horse_weight_diff: hwm ? toInt(hwm[2]) : null,
        trainer: stripTags(cell("trainer")) || null,
        popularity: toInt(stripTags(cell("pop"))),
      });
    }
  }

  return { meta, horses };
}

// ---- メイン ----
async function main() {
  console.log(`■ 全レース結果バックフィル  期間 ${fromDate} 〜 ${toDate}(当日・未来は除外)`);
  console.log(`  DRY=${DRY}  LIMIT=${LIMIT}  SKIP_EXISTING=${SKIP_EXISTING}  DELAY=${DELAY_MS}ms`);

  if (!DRY && (!SUPABASE_URL || !SERVICE_KEY)) {
    throw new Error(".env に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要です");
  }
  const supabase = DRY ? null : createClient(SUPABASE_URL, SERVICE_KEY);
  const t0 = Date.now();

  // 既存 (date, track, race_no) の集合。--skip-existing 時、結果ページを叩く前にスキップする。
  // race_results は増える一方なので、Supabase の1000行上限に当たらないようページングして全件取る。
  let existing = new Set();
  if (SKIP_EXISTING && supabase) {
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("race_results")
        .select("date, track, race_no")
        .range(from, from + 999);
      if (error) throw new Error(`race_results select: ${error.message}`);
      for (const r of data) existing.add(`${r.date}|${r.track}|${r.race_no}`);
      if (data.length < 1000) break;
      from += 1000;
    }
    console.log(`   → 既存 ${existing.size} 件を skip-existing 判定に使用`);
  }

  console.log("① 開催日リンクを収集(月ページを遡上)…");
  const dayMap = await collectDayLinks(fromDate);
  const dates = Object.keys(dayMap)
    .filter((d) => d >= fromDate && d <= toDate && d < todayStr)
    .sort();
  console.log(`   → 対象期間内 ${dates.length} 開催日`);

  console.log("② 各開催日・各場の選択ページから全レースを列挙…");
  const targets = [];
  let skippedPre = 0;
  for (const date of dates) {
    for (const dc of dayMap[date]) {
      const selHtml = await post(dc);
      const hdr = parseSelectionHeader(selHtml);
      if (!hdr.track) {
        console.warn(`  ! ${date} ${dc} … 選択ページから開催場を特定できず、この場をスキップ`);
        continue;
      }
      const races = parseSelection(selHtml);
      for (const r of races) {
        const key = `${date}|${hdr.track}|${r.raceNo}`;
        if (SKIP_EXISTING && existing.has(key)) {
          skippedPre++;
          continue;
        }
        targets.push({ date, track: hdr.track, raceNo: r.raceNo, name: r.name, sde: r.sde });
      }
    }
  }
  console.log(
    `   → ${targets.length} レースが対象(既存スキップ ${skippedPre} 件、現時点でのHTTPリクエスト計 ${reqCount})`,
  );

  const finalTargets = targets.slice(0, LIMIT === Infinity ? targets.length : LIMIT);
  let ok = 0,
    fail = 0;

  console.log(`③ 各レースの結果を取得(${finalTargets.length}件)…`);
  for (const [i, tg] of finalTargets.entries()) {
    const tag = `[${i + 1}/${finalTargets.length}] ${tg.date} ${tg.track}${tg.raceNo}R ${tg.name}`;
    try {
      const resHtml = await post(tg.sde);
      const { meta, horses } = parseResult(resHtml);
      if (horses.length === 0) {
        console.warn(`  ✗ ${tag} … 着順テーブルが空`);
        fail++;
        continue;
      }

      const record = {
        date: meta.date ?? tg.date,
        track: meta.track ?? tg.track,
        race_no: raceNoFromSde(tg.sde) ?? tg.raceNo ?? meta.raceNo ?? null,
        name: tg.name,
        grade: null, // OP/リステッド/条件戦のグレード判定は今回対象外(常にnull)
        surface: meta.surface ?? null,
        distance: meta.distance ?? null,
        going: meta.going ?? null,
        weather: meta.weather ?? null,
        cname: tg.sde,
      };

      if (DRY) {
        console.log(
          `  ○ ${tag}  ${record.surface ?? ""}${record.distance ?? ""}m ${record.going ?? ""}(${meta.weather ?? "?"}) / ${horses.length}頭  1着=${horses.find((h) => h.place === 1)?.name ?? "?"}`,
        );
        if (VERBOSE) {
          for (const h of horses.slice(0, 3)) {
            console.log(
              `       ${h.place ?? h.place_text}着 ${h.waku}枠${h.umaban}番 ${h.name} ${h.sex_age} 斤${h.weight_carry} ${h.jockey} ${h.time} 上${h.last3f} 体重${h.horse_weight}(${h.horse_weight_diff}) ${h.popularity}人気`,
            );
          }
        }
      } else {
        const rr = await withRetry(async () => {
          const { data, error } = await supabase
            .from("race_results")
            .upsert(record, { onConflict: "date,track,race_no" })
            .select("id")
            .single();
          if (error) throw new Error(`race_results upsert: ${error.message}`);
          return data;
        }, `upsert race_results ${tg.name}`);
        const rows = horses.map((h) => ({ ...h, result_id: rr.id }));
        await withRetry(async () => {
          const { error } = await supabase
            .from("result_horses")
            .upsert(rows, { onConflict: "result_id,umaban" });
          if (error) throw new Error(`result_horses upsert: ${error.message}`);
        }, `upsert result_horses ${tg.name}`);
        console.log(`  ○ ${tag}  → 保存(${horses.length}頭)`);
      }
      ok++;
    } catch (e) {
      console.error(`  ! ${tag} … ${e.message}`);
      fail++;
    }
  }

  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  console.log("──────────────────────────────");
  console.log(
    `完了: 成功 ${ok} / 失敗 ${fail} / 既存スキップ ${skippedPre}  (HTTPリクエスト計 ${reqCount}、所要 ${elapsedSec}秒)`,
  );
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
