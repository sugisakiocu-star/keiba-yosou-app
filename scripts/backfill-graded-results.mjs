// 過去1年分の「重賞」レース結果を JRA 公式からクロールして Supabase に保存する一回限りのローカルバッチ。
//
// 使い方(プロジェクト直下で):
//   node scripts/backfill-graded-results.mjs --dry --limit 3   … DB書き込みせず先頭3件だけ試す
//   node scripts/backfill-graded-results.mjs --limit 3         … 先頭3件だけ実際に保存
//   node scripts/backfill-graded-results.mjs                   … 過去12ヶ月の重賞を全件保存
//
// 設計方針(プロジェクトの取得ルール準拠):
//   - JRA公式のみ。UA明示。リクエスト間隔を DELAY_MS 空ける(既定1.5秒)。
//   - 重賞のみに限定してリクエスト数を最小化(年間 ~140レース)。
//   - 取得元: 「過去レース結果検索」の POST クロール連鎖(accessS.html)。
//   - どのレースが重賞かは、既に使っている月別カレンダーJSONの gradeRace から判定。
//   - JRADB の HTML は Shift_JIS。TextDecoder("shift_jis") で明示デコード。
//
// クロール連鎖:
//   /keiba/ → 過去結果入口 pw01skl00999999 → (月ページ pw01skl10YYYYMM を前月へ辿って開催日リンクを収集)
//     → 開催日 pw01srl…YYYYMMDD → レース選択(pw01sde…一覧+レース名) → 重賞名に一致する pw01sde → 結果テーブル

import { createClient } from "@supabase/supabase-js";

// ---- 設定 ----
const UA = "keiba-yosou-app (personal study project)";
const KEIBA_TOP = "https://www.jra.go.jp/keiba/";
const ACCESS_S = "https://www.jra.go.jp/JRADB/accessS.html";
const CAL_JSON = (ym) => `https://www.jra.go.jp/keiba/common/calendar/json/${ym}.json`;
const DELAY_MS = 1500;
const MONTHS_BACK = 12;

// ---- CLI引数 ----
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const limIdx = args.indexOf("--limit");
const LIMIT = limIdx >= 0 ? Number(args[limIdx + 1]) : Infinity;
const VERBOSE = args.includes("--verbose");
const SKIP_EXISTING = args.includes("--skip-existing"); // 既にDBにある(date,name)は取得しない
const DEBUG = args.includes("--debug"); // 一致しないとき候補レース名をダンプ

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
async function getJson(url) {
  reqCount++;
  const json = await withRetry(async () => {
    const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
    if (!res.ok) throw new Error(`GET(json) ${res.status} ${url}`);
    return res.json();
  }, `GET(json) ${url}`);
  await sleep(DELAY_MS);
  return json;
}

// レース名の表記ゆれ吸収(「府中牝馬ステークス」と「府中牝馬S」を一致させる)
const normName = (s) =>
  String(s ?? "")
    .replace(/ステークス/g, "S")
    .replace(/ハンデキャップ/g, "H")
    .replace(/ハンデ/g, "H")
    .replace(/カップ/g, "C")
    .replace(/[\s　・]/g, "")
    .trim();

// カッコ内(（秋）等)を除いた版も作る
const stripParen = (s) => String(s ?? "").replace(/[（(][^)）]*[)）]/g, "");

// カレンダーの通称 → 選択ページ(JRA公式名/略称)に現れる部分文字列。
// 正規化では吸収できない別名だけをここで橋渡しする。
const NAME_ALIASES = {
  オークス: ["優駿牝馬"],
  日本ダービー: ["東京優駿"],
  アメリカJCC: ["アメリカジョッキー"],
  マイルチャンピオンシップ: ["マイルチャンピオン"],
  阪神ジュベナイルフィリーズ: ["阪神ジュベナイル"],
  朝日杯フューチュリティS: ["朝日フューチュリティ", "朝日杯フューチュリティ"],
  弥生賞ディープインパクト記念: ["弥生ディープ", "弥生賞ディープ"],
  サウジアラビアロイヤルC: ["サウジアラビア"],
  ダービー卿CT: ["ダービー卿"],
  阪神スプリングジャンプ: ["阪神スプリングジャンプ", "阪神スプリングJ"],
  アイビスサマーダッシュ: ["アイビスサマーダッシュ", "アイビス"],
};

// レース選択ページの一覧から、重賞 g に対応する行を柔軟に照合する。
// 別名テーブル → 表記ゆれ正規化(ステークス/S・ハンデ/H・カッコ有無・双方向部分一致)の順で試す。
function matchRace(races, g) {
  const aliases = NAME_ALIASES[g.name];
  if (aliases) {
    const hit = races.find((r) => aliases.some((a) => r.name.includes(a)));
    if (hit) return hit;
  }
  const keys = [
    normName(g.name),
    normName(g.detail),
    normName(stripParen(g.name)),
    normName(stripParen(g.detail)),
  ].filter((k) => k.length >= 2);
  return races.find((r) => {
    const cand = normName(r.name);
    const candS = normName(stripParen(r.name));
    return keys.some(
      (k) => cand.includes(k) || k.includes(cand) || candS.includes(k) || k.includes(candS),
    );
  });
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

// 過去12ヶ月分の開催日リンクマップ { 'YYYY-MM-DD': Set(cname) } を作る
async function collectDayLinks() {
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

  // 索引が持つ月リンクのうち最新の月から前月へ辿る
  const monthLinks = [...indexHtml.matchAll(/pw01skl10(\d{6})\/[0-9A-F]{2}/g)].map((m) => m[1]);
  let ym = monthLinks.sort().reverse()[0];
  if (!ym) {
    const now = new Date();
    ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  let cname = findMonthCname(indexHtml, ym);
  for (let i = 0; i < MONTHS_BACK && cname; i++) {
    const html = await post(cname);
    merge(parseDayLinks(html));
    // 前月を計算して、その月ページ cname をこのページ内のナビから取得
    const y = Number(ym.slice(0, 4));
    const mo = Number(ym.slice(4, 6));
    const prev = mo === 1 ? `${y - 1}12` : `${y}${String(mo - 1).padStart(2, "0")}`;
    cname = findMonthCname(html, prev);
    ym = prev;
  }
  return dayMap;
}

// sde コードに埋まっているレース番号を取り出す(権威ソース)。
// 例 pw01sde 100220260107 01 20260704 /21 → 中央の 2桁 "01" がレース番号
function raceNoFromSde(sde) {
  const m = String(sde ?? "").match(/pw01sde\d{12}(\d{2})\d{8}\//);
  return m ? Number(m[1]) : null;
}

// レース選択ページから [{ raceNo, name, sde }] を取り出す
function parseSelection(html) {
  const out = [];
  // 行ごと(race_num セルを起点に)に sde コード・レース番号・レース名を拾う
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
    meta.distance = toInt(course[1].replace(/,/g, "")); // "2,000" → 2000
    meta.surface = course[2].split(/[・\/]/)[0].trim(); // 芝 / ダート / 障
  }

  // 天候・馬場(cap→txt ペア)
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

  // 着順テーブル
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

// 月別カレンダーJSONから、指定期間の重賞レース [{date, name, detail, grade}] を列挙
async function fetchGradedRaces(fromDate, toDate) {
  const months = new Set();
  const start = new Date(fromDate + "T00:00:00+09:00");
  const end = new Date(toDate + "T00:00:00+09:00");
  for (let d = new Date(start); d <= end; d.setMonth(d.getMonth() + 1)) {
    months.add(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const out = [];
  for (const ym of [...months].sort()) {
    let blocks;
    try {
      blocks = await getJson(CAL_JSON(ym));
    } catch (e) {
      console.warn(`  ! カレンダーJSON取得失敗 ${ym}: ${e.message}`);
      continue;
    }
    for (const b of blocks) {
      for (const d of b.data ?? []) {
        const day = Number(d.date);
        if (!day) continue;
        const date = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, "0")}`;
        if (date < fromDate || date > toDate) continue;
        for (const info of d.info ?? []) {
          for (const g of info.gradeRace ?? []) {
            if (!g.name) continue;
            out.push({ date, name: g.name, detail: g.detail || g.name, grade: g.grade || null });
          }
        }
      }
    }
  }
  return out;
}

// ---- メイン ----
async function main() {
  const today = new Date();
  const toDate = today.toISOString().slice(0, 10);
  const fromD = new Date(today);
  fromD.setFullYear(fromD.getFullYear() - 1);
  const fromDate = fromD.toISOString().slice(0, 10);

  console.log(`■ 重賞結果バックフィル  期間 ${fromDate} 〜 ${toDate}`);
  console.log(`  DRY=${DRY}  LIMIT=${LIMIT}  DELAY=${DELAY_MS}ms`);

  if (!DRY && (!SUPABASE_URL || !SERVICE_KEY)) {
    throw new Error(".env に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要です");
  }
  const supabase = DRY ? null : createClient(SUPABASE_URL, SERVICE_KEY);

  console.log("① 重賞レースを列挙(カレンダーJSON)…");
  let graded = await fetchGradedRaces(fromDate, toDate);
  // 未来・当日は結果が無いので除外
  graded = graded.filter((g) => g.date < toDate).sort((a, b) => a.date.localeCompare(b.date));
  console.log(`   → ${graded.length} 件の重賞`);

  // 既にDBにある重賞は取得しない(--skip-existing 指定時)。未取得分だけの再実行に使う。
  if (SKIP_EXISTING && supabase) {
    const { data: existRows } = await supabase.from("race_results").select("date, name");
    const have = new Set((existRows ?? []).map((r) => `${r.date}|${r.name}`));
    const before = graded.length;
    graded = graded.filter((g) => !have.has(`${g.date}|${g.name}`));
    console.log(`   → 既存 ${before - graded.length} 件をスキップ、残 ${graded.length} 件を取得`);
  }

  console.log("② 開催日リンクを収集(月ページを遡上)…");
  const dayMap = await collectDayLinks();
  console.log(`   → ${Object.keys(dayMap).length} 開催日分のリンク`);

  const targets = graded.slice(0, LIMIT === Infinity ? graded.length : LIMIT);
  const selCache = new Map(); // dayCname -> parseSelection結果
  let ok = 0,
    miss = 0,
    fail = 0;

  console.log(`③ 各重賞の結果を取得(${targets.length}件)…`);
  for (const [i, g] of targets.entries()) {
    const tag = `[${i + 1}/${targets.length}] ${g.date} ${g.grade ?? ""} ${g.name}`;
    try {
      const dayCnames = [...(dayMap[g.date] ?? [])];
      if (dayCnames.length === 0) {
        console.warn(`  ✗ ${tag} … 開催日リンク未発見`);
        miss++;
        continue;
      }
      // 開催日候補(複数場)の中から、そのレース名を含む選択ページを特定
      let matched = null;
      const seenNames = [];
      for (const dc of dayCnames) {
        let races = selCache.get(dc);
        if (!races) {
          const selHtml = await post(dc);
          races = parseSelection(selHtml);
          selCache.set(dc, races);
        }
        const hit = matchRace(races, g);
        if (hit) {
          matched = hit;
          break;
        }
        for (const r of races) if (r.raceNo >= 9) seenNames.push(`${r.raceNo}R:${r.name}`);
      }
      if (!matched) {
        console.warn(`  ✗ ${tag} … 一致なし`);
        if (DEBUG) console.warn(`      候補(9R以降): ${seenNames.join(" / ")}`);
        miss++;
        continue;
      }

      const resHtml = await post(matched.sde);
      const { meta, horses } = parseResult(resHtml);
      if (horses.length === 0) {
        console.warn(`  ✗ ${tag} … 着順テーブルが空`);
        fail++;
        continue;
      }

      const record = {
        date: g.date,
        track: meta.track ?? null,
        race_no: raceNoFromSde(matched.sde) ?? matched.raceNo ?? meta.raceNo ?? null,
        name: g.name,
        grade: g.grade,
        surface: meta.surface ?? null,
        distance: meta.distance ?? null,
        going: meta.going ?? null,
        weather: meta.weather ?? null,
        cname: matched.sde,
      };

      if (DRY) {
        console.log(
          `  ○ ${tag}  ${record.track ?? "?"}${record.race_no ?? "?"}R ${record.surface ?? ""}${record.distance ?? ""}m ${record.going ?? ""}(${meta.weather ?? "?"}) / ${horses.length}頭  1着=${horses.find((h) => h.place === 1)?.name ?? "?"}`,
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
            .upsert(record, { onConflict: "date,track,name" })
            .select("id")
            .single();
          if (error) throw new Error(`race_results upsert: ${error.message}`);
          return data;
        }, `upsert race_results ${g.name}`);
        const rows = horses.map((h) => ({ ...h, result_id: rr.id }));
        await withRetry(async () => {
          const { error } = await supabase
            .from("result_horses")
            .upsert(rows, { onConflict: "result_id,umaban" });
          if (error) throw new Error(`result_horses upsert: ${error.message}`);
        }, `upsert result_horses ${g.name}`);
        console.log(`  ○ ${tag}  → 保存(${horses.length}頭)`);
      }
      ok++;
    } catch (e) {
      console.error(`  ! ${tag} … ${e.message}`);
      fail++;
    }
  }

  console.log("──────────────────────────────");
  console.log(`完了: 成功 ${ok} / 未発見 ${miss} / 失敗 ${fail}  (HTTPリクエスト計 ${reqCount})`);
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
