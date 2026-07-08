import { createClient } from "@supabase/supabase-js";
import type { RaceDay } from "@/lib/scrape/jra-calendar";
import { FEATURE_RACES, SAMPLE_RESULTS, type FeatureRace } from "@/lib/racing-data";
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
  const raceDays = await getUpcomingRaceDays();
  const days = toScheduleDays(raceDays);
  const featured = pickFeatured();

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
        <ScheduleResults days={days} results={SAMPLE_RESULTS} />
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
