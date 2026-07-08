export type RaceDay = {
  date: string; // YYYY-MM-DD
  track: string;
  kai: number | null;
  nichi: number | null;
};

const USER_AGENT = "keiba-yosou-app (personal study project)";

// JRA公式の月別開催カレンダーJSON。HTMLはJSレンダリングで中身が取れないため、
// カレンダーが内部的に読むこのJSON (UTF-8・固定URL) を直接参照する。
function calendarUrl(year: number, month: number): string {
  const ym = `${year}${String(month).padStart(2, "0")}`;
  return `https://www.jra.go.jp/keiba/common/calendar/json/${ym}.json`;
}

// "2回福島" → { track: "福島", kai: 2, nichi: null }
// 将来 "2回福島8日" のような表記が来ても拾えるよう日目もオプションで解釈する。
function parseRaceName(name: string): Pick<RaceDay, "track" | "kai" | "nichi"> {
  const m = name.match(/^(\d+)回(.+?)(?:(\d+)日)?$/);
  if (!m) return { track: name, kai: null, nichi: null };
  return { track: m[2], kai: Number(m[1]), nichi: m[3] ? Number(m[3]) : null };
}

type CalendarBlock = {
  month?: string;
  data?: Array<{
    date?: string;
    info?: Array<{ race?: Array<{ name?: string }> }>;
  }>;
};

export async function fetchRaceDays(year: number, month: number): Promise<RaceDay[]> {
  const url = calendarUrl(year, month);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`JRA calendar fetch failed: ${res.status} ${url}`);
  }

  const blocks = (await res.json()) as CalendarBlock[];
  const days: RaceDay[] = [];
  const mm = String(month).padStart(2, "0");

  for (const block of blocks) {
    for (const d of block.data ?? []) {
      const day = Number(d.date);
      if (!day) continue;
      const date = `${year}-${mm}-${String(day).padStart(2, "0")}`;
      for (const info of d.info ?? []) {
        for (const r of info.race ?? []) {
          if (!r.name) continue;
          const parsed = parseRaceName(r.name);
          days.push({ date, ...parsed });
        }
      }
    }
  }

  return days;
}
