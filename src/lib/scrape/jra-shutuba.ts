// JRAの出馬表(出走馬一覧)を取得する。
//
// カレンダー日程(UTF-8のJSON)と違い、出馬表は JRADB の POST フォーム系にある。ページ内の
//   doAction('/JRADB/accessD.html', '<cname>')
// を POST(cname=...) で辿る形。cname 末尾の "/F3" 等はチェックサムで計算不可のため、
// コードを組み立てることはできず、必ず出馬表インデックスから親→子とクロールする。
//
// ※重要: 出馬表の入口は accessS.html(pw01sli00)ではなく accessD.html(pw01dli00)。
//   accessS 側(pw01sli00)は「レース結果(成績)」で、過去日しか出てこない。2026-07-09 に判明。
//
// クロール連鎖(全段 accessD.html にPOST):
//   /keiba/ で出馬表インデックスの cname(pw01dli00…)を取得
//     → 出馬表インデックス(開催日ごとの pw01drl…YYYYMMDD を「N回◯◯M日」ラベル付きで列挙)
//       → 目的の開催日(date+track一致)ページ → その日のレース一覧(各レース pw01dde…)
//         → 目的レース(レース名一致)の出馬表テーブル(table.basic.narrow-xy)
//
// 注意: JRADB の HTML は Shift_JIS。カレンダーJSON(UTF-8)とは別なので TextDecoder で明示的に変換する。
// 注意: 枠順は開催前々日(例年 金曜)に確定する。木曜時点は 枠/馬番 が空(=null)で、
//   馬名・性齢・斤量・騎手・調教師のみ取れる。枠順確定後に再クロールすると同じ連鎖で 枠/馬番 が埋まる。

const USER_AGENT = "keiba-yosou-app (personal study project)";
const KEIBA_TOP = "https://www.jra.go.jp/keiba/";
const ACCESS_D = "https://www.jra.go.jp/JRADB/accessD.html";

export type RaceCard = {
  date: string; // YYYY-MM-DD
  track: string;
  raceNo: number | null;
  name: string;
  grade: string | null;
  distance: number | null; // 距離(メートル)。出馬表ヘッダ「コース:2,000メートル(芝・右)」から
  surface: string | null; // 芝/ダート/障
  cname: string; // このレースの出馬表 pw01dde コード(再取得・デバッグ用)
};

// 出馬表 td.past p1〜p4 に埋まっている過去走(1走分)。追加リクエストゼロで取れる。
export type PastRun = {
  date: string | null; // YYYY-MM-DD
  track: string | null; // 例: 中山
  raceName: string | null;
  grade: string | null; // G1/G2/G3/J.G* 。平場・リステッドは null
  place: number | null; // 着順。中止/除外などは null
  placeText: string | null; // 生の着順表記 (例: "10着", "中止")
  fieldSize: number | null; // 頭数
  umaban: number | null; // 馬番
  popularity: number | null; // 人気
  jockey: string | null;
  weightCarry: number | null; // 斤量
  distance: number | null; // 距離(メートル)
  surface: string | null; // 芝/ダート/障
  time: string | null; // 走破タイム (例: "2:32.3")
  going: string | null; // 馬場状態 (良/稍重/重/不良)
  rating: number | null; // JRAレーティング
  horseWeight: number | null; // 馬体重
  corners: string | null; // コーナー通過順 (例: "2-2-2-1")
  last3f: number | null; // 上がり3F (例: 37.5)
  finHorse: string | null; // 勝ち馬(自身が1着なら2着馬)
  finDiff: number | null; // 着差(秒)。自身が1着なら負値のことがある
};

export type Horse = {
  waku: number | null; // 枠番(枠順未確定なら null)
  umaban: number | null; // 馬番(枠順未確定なら null)
  name: string; // 馬名
  sexAge: string | null; // 性齢 (例: 牡5)
  weightCarry: number | null; // 斤量 (例: 55.0)
  jockey: string | null; // 騎手
  trainer: string | null; // 調教師
  past: PastRun[]; // 過去4走(最新順。キャリアが浅い馬は4未満)
};

const decode = (buf: ArrayBuffer) => new TextDecoder("shift_jis").decode(buf);
const strip = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const toInt = (s: string): number | null => {
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : null;
};
const toNum = (s: string): number | null => {
  const m = s.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const pick = (chunk: string, re: RegExp): string => strip((chunk.match(re) ?? [])[1] ?? "");

async function getHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, cache: "no-store" });
  if (!res.ok) throw new Error(`GET failed: ${res.status} ${url}`);
  return decode(await res.arrayBuffer());
}

async function postJradb(cname: string): Promise<string> {
  const res = await fetch(ACCESS_D, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ cname }).toString(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`POST failed: ${res.status} cname=${cname}`);
  return decode(await res.arrayBuffer());
}

// doAction('/JRADB/accessD.html','<cname>') から cname を全部取り出す(チェックサム込み)。
function extractDCnames(html: string): string[] {
  const re = /doAction\('\/JRADB\/accessD\.html',\s*'([^']+)'\)/g;
  const out: string[] = [];
  for (const m of html.matchAll(re)) out.push(m[1]);
  return out;
}

// 出馬表インデックスの入口 cname を /keiba/ から取得する(チェックサムをハードコードしないため)。
async function fetchIndexCname(): Promise<string> {
  const html = await getHtml(KEIBA_TOP);
  const cname = extractDCnames(html).find((c) => c.startsWith("pw01dli00"));
  if (!cname) throw new Error("出馬表インデックスの cname(pw01dli00) が /keiba/ に見つからない");
  return cname;
}

export type DayLink = {
  cname: string;
  date: string; // YYYY-MM-DD
  track: string | null; // 競馬場名(ラベル「N回◯◯M日」から抽出)
  kai: number | null; // 開催回
  nichi: number | null; // 開催何日目
};

// 出馬表インデックス/開催日ページから、開催日ごとのリンク(pw01drl…YYYYMMDD/CK)を
// ラベル「N回◯◯M日」付きで取り出す。コード末尾8桁が開催日。
export function parseDayLinks(html: string): DayLink[] {
  // アンカーごとに cname とラベルを対応付ける。
  const re =
    /doAction\('\/JRADB\/accessD\.html',\s*'(pw01drl\d{12}(\d{8})\/[0-9A-F]{2})'\)[\s\S]*?>([\s\S]*?)<\/a>/g;
  const seen = new Set<string>();
  const out: DayLink[] = [];
  for (const m of html.matchAll(re)) {
    const cname = m[1];
    if (seen.has(cname)) continue;
    seen.add(cname);
    const d = m[2];
    const label = strip(m[3]); // 例: "2回福島6日"
    const lm = label.match(/(\d+)回(\D+?)(\d+)日/);
    out.push({
      cname,
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      track: lm ? lm[2] : null,
      kai: lm ? Number(lm[1]) : null,
      nichi: lm ? Number(lm[3]) : null,
    });
  }
  return out;
}

export type RaceLink = {
  cname: string;
  raceNo: number | null;
  name: string | null;
  grade: string | null;
};

// icon_grade_s_g3.png / icon_grade_j_g1.png → "G3" / "J.G1"
function gradeFromIcon(html: string): string | null {
  const m = html.match(/icon_grade_(s|j)_g(\d)/);
  if (!m) return null;
  return m[1] === "j" ? `J.G${m[2]}` : `G${m[2]}`;
}

// その日のレース一覧HTMLから、各レースの出馬表リンク(pw01dde…)を
// レース番号・レース名・グレード付きで取り出す。
// レース番号は dde コードに埋まる: pw01dde + 12桁 + RR(2桁=レース番号) + 8桁(日付)。
// レースリンクは doAction ではなく直リンク href="/JRADB/accessD.html?CNAME=pw01dde…" の形。
// 1レース = テーブル1行(<tr>)。行内に th.race_num(ddeリンク) と td.race_name(名前+グレード)がある。
export function parseRaceLinks(dayHtml: string): RaceLink[] {
  const seen = new Set<string>();
  const out: RaceLink[] = [];
  for (const rm of dayHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = rm[1];
    const cm = row.match(/CNAME=(pw01dde\d{12}(\d{2})\d{8}\/[0-9A-F]{2})/);
    if (!cm) continue;
    const cname = cm[1];
    if (seen.has(cname)) continue;
    seen.add(cname);
    // race_name セルの先頭テキスト(グレードアイコン以降を落とす)をレース名とする。
    const nameCell = row.match(/class="race_name">([\s\S]*?)<\/td>/);
    let name: string | null = null;
    if (nameCell) name = strip(nameCell[1].replace(/<span class="grade_icon[\s\S]*/, "")) || null;
    out.push({ cname, raceNo: Number(cm[2]), name, grade: gradeFromIcon(row) });
  }
  return out;
}

// 出馬表ヘッダの「コース:2,000メートル(芝・右)」から距離と芝ダを取り出す。
export function parseCourse(shutubaHtml: string): { distance: number | null; surface: string | null } {
  const m = shutubaHtml.match(/class="cell course"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return { distance: null, surface: null };
  const txt = strip(m[1]).replace(/,/g, "");
  const surface = txt.includes("障") ? "障" : txt.includes("ダート") ? "ダート" : txt.includes("芝") ? "芝" : null;
  return { distance: toInt(txt), surface };
}

// 過去走セル(td.past p1〜p4)1つ分をパースする。キャリアが浅い馬の空セルは null。
function parsePastCell(td: string): PastRun | null {
  const raceName = pick(td, /<div class="name">([\s\S]*?)<\/div>/) || null;
  const dateM = pick(td, /<div class="date">([\s\S]*?)<\/div>/).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!raceName && !dateM) return null;

  const placeText = pick(td, /<div class="place">([\s\S]*?)<\/div>/) || null;
  const placeM = placeText?.match(/^(\d+)着/);
  // 距離表記は "2500芝" / "1200ダ" / "3000障" 形式
  const distRaw = pick(td, /<span class="dist">([\s\S]*?)<\/span>/);
  const surfChar = distRaw.match(/(芝|ダ|障)/)?.[1] ?? null;
  const finM = td.match(/<p class="fin">([\s\S]*?)<\/p>/);
  const finDiffM = finM?.[1].match(/\(([-−+]?\d+(?:\.\d+)?)\)/);

  return {
    date: dateM ? `${dateM[1]}-${dateM[2].padStart(2, "0")}-${dateM[3].padStart(2, "0")}` : null,
    track: pick(td, /<div class="rc">([\s\S]*?)<\/div>/) || null,
    raceName,
    grade: gradeFromIcon(td),
    place: placeM ? Number(placeM[1]) : null,
    placeText,
    fieldSize: toInt(pick(td, /<span class="max">([\s\S]*?)<\/span>/)),
    umaban: toInt(pick(td, /<span class="gate">([\s\S]*?)<\/span>/)),
    popularity: toInt(pick(td, /<span class="pop">([\s\S]*?)<\/span>/)),
    jockey: pick(td, /<div class="jockey">([\s\S]*?)<\/div>/) || null,
    weightCarry: toNum(pick(td, /<div class="weight">([\s\S]*?)<\/div>/)),
    distance: toInt(distRaw.replace(/,/g, "")),
    surface: surfChar === "ダ" ? "ダート" : surfChar, // result_horses の表記(芝/ダート/障)に揃える
    time: pick(td, /<p class="time">([\s\S]*?)<\/p>/) || null,
    going: pick(td, /<span class="condition">([\s\S]*?)<\/span>/) || null,
    rating: toInt(pick(td, /<p class="rating">([\s\S]*?)<\/p>/)),
    horseWeight: toInt(pick(td, /<p class="h_weight">([\s\S]*?)<\/p>/)),
    corners:
      [...td.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => strip(m[1])).filter(Boolean).join("-") ||
      null,
    last3f: toNum(pick(td, /<div class="f3">([\s\S]*?)<\/div>/).replace(/^3F\s*/, "")),
    finHorse: finM ? strip(finM[1].replace(/<span class="time">[\s\S]*$/, "")) || null : null,
    finDiff: finDiffM ? Number(finDiffM[1].replace("−", "-")) : null,
  };
}

// 出馬表(馬名テーブル table.basic.narrow-xy)HTMLから出走馬を取り出す。
export function parseHorses(shutubaHtml: string): Horse[] {
  const start = shutubaHtml.indexOf('class="basic narrow-xy');
  if (start < 0) return [];
  const tbl = shutubaHtml.slice(start, shutubaHtml.indexOf("</table>", start));
  const rows = [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);

  const cell = (row: string, cls: string): string => {
    const m = row.match(new RegExp(`<td[^>]*class="${cls}[^"]*"[^>]*>([\\s\\S]*?)</td>`));
    return m ? m[1] : "";
  };

  const horses: Horse[] = [];
  for (const row of rows) {
    if (!/<td[^>]*class="waku/.test(row)) continue; // データ行のみ(ヘッダ除外)
    const horseTd = cell(row, "horse");
    const jockeyTd = cell(row, "jockey");

    const name = pick(horseTd, /<div class="name">([\s\S]*?)<\/div>/);
    if (!name) continue;
    const trainerRaw = pick(horseTd, /<p class="trainer">([\s\S]*?)<\/p>/);
    const trainer = trainerRaw.replace(/[(（].*$/, "").trim() || null; // 所属(美浦/栗東)を落とす

    const sexColor = pick(jockeyTd, /<p class="age">([\s\S]*?)<\/p>/); // 例: 牡5/青鹿
    const sexAge = sexColor ? sexColor.split("/")[0].trim() : null; // 例: 牡5
    const weightCarry = toNum(pick(jockeyTd, /<p class="weight">([\s\S]*?)<\/p>/));
    const jockey = pick(jockeyTd, /<p class="jockey">([\s\S]*?)<\/p>/) || null;

    // 過去4走(td.past p1〜p4)。p1が前走。キャリアが浅い馬は空セルなので詰める。
    // 3着以内のセルは class="past p1 place1" のように修飾クラスが付くので [^"]* で許容する。
    const past = [...row.matchAll(/<td[^>]*class="past p\d[^"]*"[^>]*>([\s\S]*?)<\/td>/g)]
      .map((m) => parsePastCell(m[1]))
      .filter((p): p is PastRun => p != null);

    horses.push({
      waku: toInt(strip(cell(row, "waku"))),
      umaban: toInt(strip(cell(row, "num"))),
      name,
      sexAge,
      weightCarry,
      jockey,
      trainer,
      past,
    });
  }
  return horses;
}

export type FetchRaceCardResult = {
  found: boolean;
  race: RaceCard | null;
  horses: Horse[];
  debug: {
    dayCandidates: DayLink[];
    matchedDayCname: string | null;
    raceLinks: number;
    matchedRaceCname: string | null;
    horsesParsed: number;
  };
};

// 指定した開催日・競馬場・レース名の出馬表をクロールして取得する。
export async function fetchRaceCard(target: {
  date: string; // YYYY-MM-DD
  track: string;
  raceName: string; // 部分一致で照合(例: 七夕賞)
  grade?: string | null;
}): Promise<FetchRaceCardResult> {
  const indexCname = await fetchIndexCname();
  const indexHtml = await postJradb(indexCname);
  const allDays = parseDayLinks(indexHtml);
  // date 一致、かつ track 一致(ラベル未取得なら date だけで候補に残す)。
  const dayCandidates = allDays.filter(
    (d) => d.date === target.date && (d.track === null || d.track.includes(target.track)),
  );

  const debug: FetchRaceCardResult["debug"] = {
    dayCandidates,
    matchedDayCname: null,
    raceLinks: 0,
    matchedRaceCname: null,
    horsesParsed: 0,
  };

  for (const day of dayCandidates) {
    const dayHtml = await postJradb(day.cname);
    const raceLinks = parseRaceLinks(dayHtml);
    const race = raceLinks.find((r) => r.name && r.name.includes(target.raceName));
    if (!race) continue;

    debug.matchedDayCname = day.cname;
    debug.raceLinks = raceLinks.length;
    debug.matchedRaceCname = race.cname;

    const shutubaHtml = await postJradb(race.cname);
    const horses = parseHorses(shutubaHtml);
    const course = parseCourse(shutubaHtml);
    debug.horsesParsed = horses.length;

    return {
      found: horses.length > 0,
      race: {
        date: target.date,
        track: target.track,
        raceNo: race.raceNo,
        name: race.name ?? target.raceName,
        grade: race.grade ?? target.grade ?? null,
        distance: course.distance,
        surface: course.surface,
        cname: race.cname,
      },
      horses,
      debug,
    };
  }

  return { found: false, race: null, horses: [], debug };
}

export type GradedCard = { race: RaceCard; horses: Horse[] };

// 出馬表インデックスに出ている「今後の重賞」を全て自動収集する(週次cron用)。
// 各開催日ページはレース一覧をグレード付きで返すので、重賞(grade!=null)だけ出馬表テーブルを取りに行く。
// リクエスト数は有界: index(1) + 開催日ページ(数日) + 重賞の出馬表(数レース)。
export async function fetchUpcomingGradedCards(opts?: { fromDate?: string }): Promise<{
  cards: GradedCard[];
  debug: { days: number; graded: number };
}> {
  const fromDate = opts?.fromDate ?? new Date().toISOString().slice(0, 10);
  const indexCname = await fetchIndexCname();
  const indexHtml = await postJradb(indexCname);
  const days = parseDayLinks(indexHtml).filter((d) => d.date >= fromDate);

  const cards: GradedCard[] = [];
  for (const day of days) {
    const dayHtml = await postJradb(day.cname);
    const gradedRaces = parseRaceLinks(dayHtml).filter((r) => r.grade); // 重賞のみ
    for (const race of gradedRaces) {
      const shutubaHtml = await postJradb(race.cname);
      const horses = parseHorses(shutubaHtml);
      if (horses.length === 0) continue; // 未公開などで空なら書き込まない
      const course = parseCourse(shutubaHtml);
      cards.push({
        race: {
          date: day.date,
          track: day.track ?? "",
          raceNo: race.raceNo,
          name: race.name ?? "",
          grade: race.grade,
          distance: course.distance,
          surface: course.surface,
          cname: race.cname,
        },
        horses,
      });
    }
  }
  return { cards, debug: { days: days.length, graded: cards.length } };
}
