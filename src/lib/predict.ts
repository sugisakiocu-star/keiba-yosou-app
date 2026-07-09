// 簡易予想スコア(フェーズ4C「まず雑に予想」)。
// 過去1年の重賞結果(race_results / result_horses)だけを材料に、出馬表の各馬を採点する。
//
// スコア = 馬の重賞実績 + 騎手の重賞複勝率 + 斤量(ハンデ差)
//  - 馬: 着順ポイント × グレード重み × 直近重み + 距離適性ボーナス を平均し、走数が少ないほど縮める
//  - 騎手: 過去1年重賞の複勝率 × 30(騎乗5回未満は標本不足として中立=0)
//  - 斤量: (出走馬平均 − 自身の斤量) × 2(ハンデ戦では軽いほうがプラス)
//
// あくまで「まず動く」ための透明な採点。精度は未検証(バックテストはフェーズ4Dで)。

import { createClient } from "@supabase/supabase-js";
import type { RaceCard, Grade } from "@/lib/racing-data";

export interface PredictedHorse {
  mark: string | null; // ◎ ○ ▲ △(上位5頭)
  name: string;
  jockey: string | null;
  weightCarry: number | null;
  total: number; // 合計スコア
  barPct: number; // フィールド内最大を100とした相対値(バー表示用)
  horsePts: number;
  jockeyPts: number;
  weightPts: number;
  jockeyRate: number | null; // 騎手の重賞複勝率(標本不足なら null)
  runsLabel: string; // 例: "G3 1着・G2 2着・G3 6着" / "重賞実績なし"
}

export interface RacePrediction {
  raceId: string;
  raceName: string;
  dayLabel: string;
  track: string;
  raceNo: number;
  grade?: Grade;
  avgWeight: number;
  horses: PredictedHorse[];
}

type HistRow = {
  name: string;
  place: number | null;
  race_results: { date: string; grade: string | null; surface: string | null; distance: number | null };
};
type JockeyRow = { jockey: string | null; place: number | null };

const MARKS = ["◎", "○", "▲", "△", "△"];
const PAGE_SIZE = 1000; // Supabase の max-rows 上限。超える分は range() でページングして全件読む

// makeQuery が返すクエリを range() で繰り返し実行して全行を集める。失敗したら null。
async function fetchAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[] | null> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await makeQuery(from, from + PAGE_SIZE - 1);
    if (error) return null;
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_SIZE) return out;
  }
}
const GRADE_W: Record<string, number> = { G1: 1.5, G2: 1.2, G3: 1.0 };

const placePts = (p: number | null): number =>
  p === 1 ? 10 : p === 2 ? 7 : p === 3 ? 5 : p === 4 ? 3 : p === 5 ? 2 : p != null && p <= 9 ? 1 : 0;

// 馬の重賞実績スコア。runs は障害を除いた過去1年の重賞成績。
export function scoreHorse(runs: HistRow[], now: Date): { pts: number; label: string } {
  if (runs.length === 0) return { pts: 0, label: "重賞実績なし" };
  let total = 0;
  const labels: string[] = [];
  for (const r of runs) {
    const gw = GRADE_W[r.race_results.grade ?? ""] ?? 1.0;
    const ageMonths = (now.getTime() - new Date(r.race_results.date).getTime()) / (1000 * 3600 * 24 * 30);
    const rw = ageMonths <= 3 ? 1.2 : ageMonths <= 6 ? 1.0 : 0.8; // 直近重視
    // 距離適性: 芝1800〜2200mで5着以内なら+1(七夕賞=芝2000を想定した中距離適性)
    const apt =
      r.race_results.surface === "芝" &&
      (r.race_results.distance ?? 0) >= 1800 &&
      (r.race_results.distance ?? 0) <= 2200 &&
      r.place != null &&
      r.place <= 5
        ? 1
        : 0;
    total += placePts(r.place) * gw * rw + apt;
    labels.push(`${r.race_results.grade ?? ""}${r.place ?? "×"}着`);
  }
  // 平均ベース。走数3未満は縮める(1走の好走を過大評価しない)
  const pts = (total / runs.length) * Math.min(1, runs.length / 3) * 10;
  return { pts, label: labels.join(" ") };
}

// 騎手の重賞複勝率スコア。騎乗5回未満は標本不足として中立。
export function scoreJockey(rides: JockeyRow[]): { pts: number; rate: number | null } {
  if (rides.length < 5) return { pts: 0, rate: null };
  const top3 = rides.filter((r) => r.place != null && r.place <= 3).length;
  const rate = top3 / rides.length;
  return { pts: rate * 30, rate };
}

// 出馬表(RaceCard)ごとに全馬を採点する。Supabase から履歴を読めない場合は空を返す。
export async function buildPredictions(cards: RaceCard[]): Promise<RacePrediction[]> {
  if (cards.length === 0) return [];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url?.startsWith("http") || !anonKey) return [];

  const allNames = [...new Set(cards.flatMap((c) => c.horses.map((h) => h.name)))];
  const allJockeys = [...new Set(cards.flatMap((c) => c.horses.map((h) => h.jockey)).filter(Boolean))] as string[];
  if (allNames.length === 0) return [];

  let hist: HistRow[] = [];
  let jhist: JockeyRow[] = [];
  try {
    const supabase = createClient(url, anonKey);
    // id 順 + range() でページングしないと max-rows(1000行)で切られる
    const [h, j] = await Promise.all([
      fetchAllRows((from, to) =>
        supabase
          .from("result_horses")
          .select("name, place, race_results(date, grade, surface, distance)")
          .in("name", allNames)
          .order("id")
          .range(from, to),
      ),
      fetchAllRows<JockeyRow>((from, to) =>
        supabase
          .from("result_horses")
          .select("jockey, place")
          .in("jockey", allJockeys)
          .order("id")
          .range(from, to),
      ),
    ]);
    if (h == null || j == null) return [];
    hist = h as unknown as HistRow[];
    jhist = j;
  } catch {
    return [];
  }

  const now = new Date();
  return cards.map((card) => {
    const withWeight = card.horses.filter((h) => h.weightCarry != null);
    const avgWeight =
      withWeight.length > 0
        ? withWeight.reduce((s, h) => s + (h.weightCarry ?? 0), 0) / withWeight.length
        : 0;

    const scored = card.horses.map((h) => {
      // 障害(J.G*)は平地の予想材料から除外
      const runs = hist.filter(
        (r) => r.name === h.name && !String(r.race_results?.grade ?? "").startsWith("J"),
      );
      const hs = scoreHorse(runs, now);
      const js = scoreJockey(jhist.filter((r) => r.jockey === h.jockey));
      const wPts = h.weightCarry != null && avgWeight > 0 ? (avgWeight - h.weightCarry) * 2 : 0;
      return {
        name: h.name,
        jockey: h.jockey,
        weightCarry: h.weightCarry,
        total: hs.pts + js.pts + wPts,
        barPct: 0, // 後で埋める
        horsePts: hs.pts,
        jockeyPts: js.pts,
        weightPts: wPts,
        jockeyRate: js.rate,
        runsLabel: hs.label,
        mark: null as string | null,
      };
    });
    scored.sort((a, b) => b.total - a.total);
    const max = Math.max(...scored.map((s) => s.total), 1);
    scored.forEach((s, i) => {
      s.mark = MARKS[i] ?? null;
      s.barPct = Math.max(2, Math.round((Math.max(s.total, 0) / max) * 100));
    });

    return {
      raceId: card.id,
      raceName: card.name,
      dayLabel: card.dayLabel,
      track: card.track,
      raceNo: card.raceNo,
      grade: card.grade,
      avgWeight,
      horses: scored,
    };
  });
}
