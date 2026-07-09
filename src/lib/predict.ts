// 簡易予想スコア(フェーズ4C→4A拡張)。
// 出馬表の各馬を、過去1年の重賞結果(race_results)+ 出馬表に埋まっていた直近4走(horse_past_runs)で採点する。
//
// スコア = 馬の重賞実績 + 近走の調子(フォーム)+ 騎手の重賞複勝率 + 斤量(ハンデ差)
//  - 重賞実績: 着順ポイント × グレード重み × 直近重み + 距離適性 を平均し、走数が少ないほど縮める
//  - 近走(4A): 直近4走の着順を前走ほど重く評価 + 当該コース(距離/芝ダ)適性。
//    重賞履歴に出てこない条件戦好走馬(サヴォーナ等)を拾うのが狙い。
//  - 騎手: 過去1年重賞の複勝率 × 30(騎乗5回未満は標本不足として中立=0)
//  - 斤量: (出走馬平均 − 自身の斤量) × 2(ハンデ戦では軽いほうがプラス)
//
// あくまで「まず動く」ための透明な採点。精度はバックテスト(scripts/backtest.mjs)で検証する。

import { createClient } from "@supabase/supabase-js";
import type { RaceCard, Grade, PastRun } from "@/lib/racing-data";

export interface PredictedHorse {
  mark: string | null; // ◎ ○ ▲ △(上位5頭)
  name: string;
  jockey: string | null;
  weightCarry: number | null;
  total: number; // 合計スコア
  barPct: number; // フィールド内最大を100とした相対値(バー表示用)
  horsePts: number;
  formPts: number; // 近走(直近4走)の調子スコア
  jockeyPts: number;
  weightPts: number;
  jockeyRate: number | null; // 騎手の重賞複勝率(標本不足なら null)
  runsLabel: string; // 例: "G3 1着・G2 2着・G3 6着" / "重賞実績なし"
  formLabel: string; // 例: "前走G2 10着 / 芝2000◎" / "近走データなし"
}

// 当該レースのコース条件(距離・芝ダ)。距離適性の判定に使う。
export type Target = { distance: number | null; surface: string | null };

// コース適性ボーナス: 同じ芝ダで、距離が目標の±300m以内なら 1、それ以外 0。
// target が不明(距離未取得)なら判定不能として 0。
function aptBonus(surface: string | null, distance: number | null, target: Target): number {
  if (target.distance == null || target.surface == null) return 0;
  if (surface !== target.surface) return 0;
  return Math.abs((distance ?? 0) - target.distance) <= 300 ? 1 : 0;
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
// target を渡すと距離適性を当該レースのコースで判定する(未指定なら適性ボーナス無し)。
export function scoreHorse(
  runs: HistRow[],
  now: Date,
  target: Target = { distance: null, surface: null },
): { pts: number; label: string } {
  if (runs.length === 0) return { pts: 0, label: "重賞実績なし" };
  let total = 0;
  const labels: string[] = [];
  for (const r of runs) {
    const gw = GRADE_W[r.race_results.grade ?? ""] ?? 1.0;
    const ageMonths = (now.getTime() - new Date(r.race_results.date).getTime()) / (1000 * 3600 * 24 * 30);
    const rw = ageMonths <= 3 ? 1.2 : ageMonths <= 6 ? 1.0 : 0.8; // 直近重視
    // 距離適性: 当該レースと同じ芝ダ・近い距離で5着以内なら +1
    const apt =
      r.place != null && r.place <= 5
        ? aptBonus(r.race_results.surface, r.race_results.distance, target)
        : 0;
    total += placePts(r.place) * gw * rw + apt;
    labels.push(`${r.race_results.grade ?? ""}${r.place ?? "×"}着`);
  }
  // 平均ベース。走数3未満は縮める(1走の好走を過大評価しない)
  const pts = (total / runs.length) * Math.min(1, runs.length / 3) * 10;
  return { pts, label: labels.join(" ") };
}

// 近走(直近4走)の調子スコア。past は最新順(runNo 1=前走)。
//  - 前走ほど重く着順を評価(recencyW)
//  - 頭数の多いレースでの好走を少し高く(strengthMul)
//  - 当該コース(距離/芝ダ)への適性を加点(全レース固定だった旧仕様のバグ解消)
export function scoreForm(past: PastRun[], target: Target): { pts: number; label: string } {
  const runs = past.filter((p) => p.place != null); // 中止・除外(place=null)は評価対象外
  if (runs.length === 0) return { pts: 0, label: "近走データなし" };
  const recencyW = (runNo: number): number =>
    runNo <= 1 ? 1.0 : runNo === 2 ? 0.75 : runNo === 3 ? 0.55 : 0.4;

  let raw = 0;
  let apt = 0;
  for (const p of runs) {
    const rw = recencyW(p.runNo);
    const strengthMul = p.fieldSize != null ? Math.min(1.2, Math.max(0.7, p.fieldSize / 14)) : 1;
    raw += placePts(p.place) * rw * strengthMul;
    if (p.place != null && p.place <= 5) apt += aptBonus(p.surface, p.distance, target) * rw * 2;
  }
  // 平均ベース。走数2未満は縮める。K=6 で重賞実績スコアと同オーダーに。
  const pts = (raw / runs.length) * Math.min(1, runs.length / 2) * 6 + apt;

  // ラベル: 前走成績 + 当該コース好走があれば印
  const p1 = runs.find((p) => p.runNo === 1) ?? runs[0];
  const aptRun = runs.find(
    (p) => p.place != null && p.place <= 5 && aptBonus(p.surface, p.distance, target) > 0,
  );
  const parts = [`前走${p1.grade ?? ""}${p1.placeText ?? ""}`];
  if (aptRun && target.distance != null)
    parts.push(`${target.surface}${target.distance}◎`);
  return { pts, label: parts.join(" / ") };
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
    const target: Target = { distance: card.distance, surface: card.surface };
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
      const hs = scoreHorse(runs, now, target);
      const fs = scoreForm(h.past ?? [], target);
      const js = scoreJockey(jhist.filter((r) => r.jockey === h.jockey));
      const wPts = h.weightCarry != null && avgWeight > 0 ? (avgWeight - h.weightCarry) * 2 : 0;
      return {
        name: h.name,
        jockey: h.jockey,
        weightCarry: h.weightCarry,
        total: hs.pts + fs.pts + js.pts + wPts,
        barPct: 0, // 後で埋める
        horsePts: hs.pts,
        formPts: fs.pts,
        jockeyPts: js.pts,
        weightPts: wPts,
        jockeyRate: js.rate,
        runsLabel: hs.label,
        formLabel: fs.label,
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
