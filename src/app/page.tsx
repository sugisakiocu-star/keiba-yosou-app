import { createClient } from "@supabase/supabase-js";
import type { RaceDay } from "@/lib/scrape/jra-calendar";
import {
  FEATURE_RACES,
  SAMPLE_RESULTS,
  type FeatureRace,
  type RaceResult,
  type Grade,
} from "@/lib/racing-data";
import { Hero } from "@/components/Hero";
import { ScheduleResults, type ScheduleDay } from "@/components/ScheduleResults";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// Supabase が未設定・無効でも画面が落ちないよう、クライアント生成ごと try/catch で包む。
async function getUpcomingRaceDays(): Promise<RaceDay[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url?.startsWith("http") || !anonKey) return [];

  const today = new Date().toISOString().slice(0, 10);
  try {
    const supabase = createClient(url, anonKey);
    const { data, error } = await supabase
      .from("race_days")
      .select("date, track, kai, nichi")
      .gte("date", today)
      .order("date", { ascending: true });
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}

function dayLabelJP(date: string): string {
  const d = new Date(`${date}T00:00:00+09:00`);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

type ResultHorseRow = {
  place: number | null;
  waku: number | null;
  umaban: number | null;
  name: string;
  jockey: string | null;
  time: string | null;
  popularity: number | null;
};
type RaceResultRow = {
  id: number;
  date: string;
  track: string;
  race_no: number | null;
  name: string;
  grade: string | null;
  surface: string | null;
  distance: number | null;
  going: string | null;
  result_horses: ResultHorseRow[];
};

// 直近の重賞レース結果を race_results / result_horses から取得して UI 型に変換する。
async function getRecentResults(): Promise<RaceResult[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url?.startsWith("http") || !anonKey) return [];

  try {
    const supabase = createClient(url, anonKey);
    const { data, error } = await supabase
      .from("race_results")
      .select(
        "id, date, track, race_no, name, grade, surface, distance, going, result_horses(place, waku, umaban, name, jockey, time, popularity)",
      )
      .order("date", { ascending: false })
      .limit(6);
    if (error || !data) return [];

    return (data as RaceResultRow[]).map((r) => {
      const top3 = (r.result_horses ?? [])
        .filter((h) => h.place != null && h.place >= 1 && h.place <= 3)
        .sort((a, b) => (a.place ?? 99) - (b.place ?? 99))
        .map((h) => ({
          pos: h.place as number,
          waku: h.waku ?? 0,
          umaban: h.umaban ?? 0,
          name: h.name,
          jockey: h.jockey ?? "",
          pop: h.popularity ?? 0,
        }));
      const winner = (r.result_horses ?? []).find((h) => h.place === 1);
      return {
        id: String(r.id),
        date: r.date,
        dayLabel: dayLabelJP(r.date),
        track: r.track,
        raceNo: r.race_no ?? 0,
        name: r.name,
        grade: (r.grade as Grade) ?? undefined,
        course: [r.surface, r.distance ? `${r.distance}m` : null].filter(Boolean).join(" "),
        going: r.going ?? "",
        time: winner?.time ?? "",
        top3,
      } satisfies RaceResult;
    });
  } catch {
    return [];
  }
}

// race_days(1日=複数競馬場)を、UI用の日付単位カードデータに畳み込む。
function toScheduleDays(raceDays: RaceDay[]): ScheduleDay[] {
  const byDate = new Map<string, RaceDay[]>();
  for (const rd of raceDays) {
    const list = byDate.get(rd.date) ?? [];
    list.push(rd);
    byDate.set(rd.date, list);
  }

  return [...byDate.entries()].map(([date, list]) => {
    const d = new Date(`${date}T00:00:00+09:00`);
    return {
      date,
      dayLabel: `${d.getMonth() + 1}/${d.getDate()}`,
      weekday: WEEKDAYS[d.getDay()],
      tracks: list.map((rd) => ({
        name: rd.track,
        kai: rd.kai ? `${rd.kai}回` : "",
        nichime: rd.nichi ? `${rd.nichi}日目` : "",
      })),
      // race_days に grade が無いため、当面 FEATURE_RACES と突き合わせて重賞バッジを付与
      gradeRaces: FEATURE_RACES.filter((f) => f.date === date).map((f) => ({
        name: f.name,
        grade: f.grade,
        track: f.track,
      })),
    };
  });
}

// 直近の未来の重賞をヒーロー用に選ぶ
function pickFeatured(): FeatureRace | null {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = FEATURE_RACES.filter((f) => f.date >= today).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  return upcoming[0] ?? null;
}

export default async function Home() {
  const [raceDays, recentResults] = await Promise.all([
    getUpcomingRaceDays(),
    getRecentResults(),
  ]);
  const days = toScheduleDays(raceDays);
  const featured = pickFeatured();

  // 実データがあればそれを、無ければサンプルを表示(注記を出し分ける)。
  const resultsAreSample = recentResults.length === 0;
  const results = resultsAreSample ? SAMPLE_RESULTS : recentResults;

  return (
    <div className="paper-bg min-h-screen">
      <header style={{ background: "var(--turf-deep)" }}>
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-4 sm:px-8">
          <span className="text-2xl">🏇</span>
          <span
            className="font-display text-2xl font-bold tracking-wide italic"
            style={{ color: "var(--gold-bright)" }}
          >
            KEIBA YOSOU
          </span>
          <span className="text-xs font-bold tracking-[0.3em]" style={{ color: "#d9d2bd" }}>
            競馬予想
          </span>
          <span className="ml-auto text-xs" style={{ color: "#b9b19a" }}>
            データ出典:JRA公式
          </span>
        </div>
      </header>
      <div className="checker-strip" />

      <Hero featured={featured} />
      <div className="checker-strip" />

      <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
        <ScheduleResults days={days} results={results} resultsAreSample={resultsAreSample} />
      </main>

      <footer style={{ background: "var(--turf-deep)" }}>
        <div className="mx-auto max-w-5xl px-5 py-5 text-xs sm:px-8" style={{ color: "#b9b19a" }}>
          keiba-yosou-app — 個人開発 / データは JRA
          公式サイトより最小頻度で取得・キャッシュしています
        </div>
      </footer>
    </div>
  );
}
