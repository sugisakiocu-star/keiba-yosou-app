// JRAの出馬表(出走馬一覧)を取得する。
//
// カレンダー日程と違い、出馬表は JRADB の POST フォーム系にある。ページ内の
//   doAction('/JRADB/accessS.html', '<cname>')
// を POST(cname=...) で辿る形。cname 末尾の "/AF" 等はチェックサムで計算不可のため、
// レースIDを組み立てることはできず、必ず出馬表インデックスから親→子とクロールする。
//
// クロール連鎖:
//   /keiba/ で出馬表インデックスの cname を取得
//     → accessS.html にPOST → 出馬表インデックス(開催日ごとの pw01srl... を列挙)
//       → 目的の開催日を accessS.html にPOST → その日のレース一覧(各レースの pw01ses...)
//         → 目的レースを accessS.html にPOST → 出馬表(馬名テーブル)
//
// 注意: JRADB の HTML は Shift_JIS。カレンダーJSON(UTF-8)とは別なので TextDecoder で明示的に変換する。

const USER_AGENT = "keiba-yosou-app (personal study project)";
const KEIBA_TOP = "https://www.jra.go.jp/keiba/";
const ACCESS_S = "https://www.jra.go.jp/JRADB/accessS.html";

export type RaceCard = {
  date: string; // YYYY-MM-DD
  track: string;
  raceNo: number | null;
  name: string;
  grade: string | null;
  cname: string; // このレースの出馬表 pw01ses コード(再取得・デバッグ用)
};

export type Horse = {
  waku: number | null; // 枠番
  umaban: number | null; // 馬番
  name: string; // 馬名
  sexAge: string | null; // 性齢 (例: 牡4)
  weightCarry: number | null; // 斤量
  jockey: string | null; // 騎手
  trainer: string | null; // 調教師
};

async function getHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, cache: "no-store" });
  if (!res.ok) throw new Error(`GET failed: ${res.status} ${url}`);
  return new TextDecoder("shift_jis").decode(await res.arrayBuffer());
}

async function postJradb(cname: string): Promise<string> {
  const res = await fetch(ACCESS_S, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ cname }).toString(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`POST failed: ${res.status} cname=${cname}`);
  return new TextDecoder("shift_jis").decode(await res.arrayBuffer());
}

// doAction('/JRADB/accessS.html','<cname>') から cname を全部取り出す(チェックサム込み)。
function extractSCnames(html: string): string[] {
  const re = /doAction\('\/JRADB\/accessS\.html',\s*'([^']+)'\)/g;
  const out: string[] = [];
  for (const m of html.matchAll(re)) out.push(m[1]);
  return out;
}

// 出馬表インデックスの入口 cname を /keiba/ から取得する(チェックサムをハードコードしないため)。
async function fetchIndexCname(): Promise<string> {
  const html = await getHtml(KEIBA_TOP);
  const cname = extractSCnames(html).find((c) => c.startsWith("pw01sli00"));
  if (!cname) throw new Error("出馬表インデックスの cname(pw01sli00) が /keiba/ に見つからない");
  return cname;
}

type DayLink = { cname: string; date: string };

// 出馬表インデックスHTMLから、開催日ごとのリンク(pw01srl...YYYYMMDD/CK)を取り出す。
// コード末尾8桁が開催日なので、そこから日付を復元する(HTML構造に依存しない堅い抽出)。
export function parseDayLinks(indexHtml: string): DayLink[] {
  const re = /pw01srl\d{12}(\d{8})\/[0-9A-F]{2}/g;
  const seen = new Set<string>();
  const out: DayLink[] = [];
  for (const m of indexHtml.matchAll(re)) {
    const cname = m[0];
    if (seen.has(cname)) continue;
    seen.add(cname);
    const d = m[1];
    out.push({ cname, date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` });
  }
  return out;
}

// --- ここから下(開催日リスト/馬名テーブルの解析)は 2026-07-09 の出馬表公開後に実物で確定する ---
// 過去日を叩くと成績ページに飛ぶため、公開前は構造を最終確定できない。暫定実装＋TODO。

type RaceLink = { cname: string; raceNo: number | null; name: string | null };

// その日のレース一覧HTMLから、各レースの出馬表リンク(pw01ses...)を取り出す。
// TODO(2026-07-09): 実ページでレース番号・レース名の対応付けを確定する。
export function parseRaceLinks(dayHtml: string): RaceLink[] {
  const re = /pw01ses\d+\/[0-9A-F]{2}/g;
  const seen = new Set<string>();
  const out: RaceLink[] = [];
  for (const m of dayHtml.matchAll(re)) {
    const cname = m[0];
    if (seen.has(cname)) continue;
    seen.add(cname);
    out.push({ cname, raceNo: null, name: null });
  }
  return out;
}

// 出馬表(馬名テーブル)HTMLから出走馬を取り出す。
// TODO(2026-07-09): 実ページのテーブル構造(枠/馬番/馬名/性齢/斤量/騎手/調教師)に合わせて確定する。
export function parseHorses(_shutubaHtml: string): Horse[] {
  return [];
}

export type FetchRaceCardResult = {
  found: boolean;
  race: RaceCard | null;
  horses: Horse[];
  debug: {
    dayCandidates: DayLink[];
    matchedDayCname: string | null;
    raceLinks: number;
    horsesParsed: number;
    // 7/9 の実物確認用に、たどり着いた各段HTMLの断片を返す。
    sampleHtml?: string;
  };
};

// 指定した開催日・レース名の出馬表をクロールして取得する。
export async function fetchRaceCard(target: {
  date: string; // YYYY-MM-DD
  track: string;
  raceName: string; // 部分一致で照合(例: 七夕賞)
  grade?: string | null;
  withSample?: boolean;
}): Promise<FetchRaceCardResult> {
  const indexCname = await fetchIndexCname();
  const indexHtml = await postJradb(indexCname);
  const dayCandidates = parseDayLinks(indexHtml).filter((d) => d.date === target.date);

  const debug: FetchRaceCardResult["debug"] = {
    dayCandidates,
    matchedDayCname: null,
    raceLinks: 0,
    horsesParsed: 0,
  };

  // 目的日の候補(複数開催)を順に開き、レース名が一致する開催日ページを特定する。
  for (const day of dayCandidates) {
    const dayHtml = await postJradb(day.cname);
    if (!dayHtml.includes(target.raceName)) continue;
    debug.matchedDayCname = day.cname;

    const raceLinks = parseRaceLinks(dayHtml);
    debug.raceLinks = raceLinks.length;
    if (target.withSample) debug.sampleHtml = dayHtml.slice(0, 4000);

    // TODO(2026-07-09): レース名でレースを特定できるようになったら、該当 ses を選んで出馬表を取得する。
    // 現状は暫定: 出馬表の実HTMLは公開後に確定するため、レース枠だけ返す。
    const race: RaceCard = {
      date: target.date,
      track: target.track,
      raceNo: null,
      name: target.raceName,
      grade: target.grade ?? null,
      cname: raceLinks[0]?.cname ?? day.cname,
    };
    return { found: true, race, horses: [], debug };
  }

  if (target.withSample) debug.sampleHtml = indexHtml.slice(0, 4000);
  return { found: false, race: null, horses: [], debug };
}
