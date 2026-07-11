// 買い目メモの自動生成(フェーズ4L)。v2予想(predict.ts)の結果から、
// 「このレースは買う価値があるか・買うなら何をいくらまでか」を実測データに基づいて提案する。
//
// 根拠は全て scripts/bets-backtest.mjs / pool-bias-check.mjs の実測値(2026-07-11クロール完走後の確定値、n付き):
//  - 階級別のv2回収率(3連複、n=8,427R): 新馬・未勝利59.7%(3,652R) / 1〜3勝クラス61.5%(4,037R) /
//    OP・重賞85.1%(738R) → 条件戦はモデルが市場に大きく劣位。OP・重賞のみ市場ベースライン近辺で戦える。
//    ただしOP・重賞層はn=591→738で92.6%→85.1%に低下しており、点推定の揺らぎが大きい点に注意。
//  - OP・重賞層(n=738R)の券種別: 馬単92.6%・馬連90.0%・ワイド88.5%が相対上位(ただし上位1件除きは
//    いずれも81〜83%に収斂=超大穴1件の寄与が大きい)。単勝84.8%、複勝82.0%。
//  - どの券種・人気帯も平均回収率100%超えは無い(唯一最も堅いのは1番人気の複勝85.2%)。
//    → 「期待値プラスの買い方」は存在しない前提で、負けにくい形だけを提案する。
// 数字を更新したら(再計測時)このコメントと閾値も更新すること。

import type { RacePrediction } from "@/lib/predict";

export type RaceClassLayer = "OP・重賞" | "3勝クラス" | "1〜2勝クラス" | "新馬・未勝利" | "特別戦";

export type BetSuggestion = {
  layer: RaceClassLayer;
  // buy=本線として提案 / small=少額のみ / skip=見送り推奨
  stance: "buy" | "small" | "skip";
  stanceLabel: string;
  headline: string; // 総評1行
  points: string[]; // 根拠(箇条書き)
  bets: { label: string; amount: string }[]; // 推奨買い目(見送り時は空)
};

// 階級レイヤ判定。classWeight(predict.ts)と同じレース名パターンを表示用に分類し直したもの。
export function raceClassLayer(grade: string | null | undefined, raceName: string): RaceClassLayer {
  if (grade) return "OP・重賞";
  if (/新馬|未勝利|メイクデビュー/.test(raceName)) return "新馬・未勝利";
  if (/[3３]勝クラス/.test(raceName)) return "3勝クラス";
  if (/[1１2２]勝クラス/.test(raceName)) return "1〜2勝クラス";
  if (/オープン/.test(raceName)) return "OP・重賞";
  return "特別戦";
}

export function buildBetSuggestion(p: RacePrediction): BetSuggestion {
  const layer = raceClassLayer(p.grade ?? null, p.raceName);
  const [top, second, third] = p.horses;

  // 混戦度: 2位スコア/1位スコア。1に近いほど混戦。スコアが小さすぎる(材料不足)場合は判定しない。
  const hasScores = top != null && second != null && top.total > 5;
  const ratio = hasScores ? Math.max(0, second.total) / top.total : null;
  const shape = ratio == null ? "材料不足" : ratio < 0.75 ? "抜けた本命" : ratio < 0.9 ? "本命優位" : "混戦";

  const points: string[] = [];
  if (top) {
    const bits = [top.runsLabel, top.formLabel].filter((s) => s && !/なし/.test(s));
    points.push(`◎${top.name}: ${bits.length ? bits.join(" / ") : "スコア1位(材料は薄め)"}`);
    if (top.jockeyRate != null && top.jockeyRate >= 0.3)
      points.push(`◎の${top.jockey}は重賞複勝率${Math.round(top.jockeyRate * 100)}%と鞍上強化の後押し`);
    // 斤量利: フィールド平均より2kg以上軽いのは実測でも効く材料(夏の3歳軽量など)
    if (top.weightCarry != null && p.avgWeight > 0 && p.avgWeight - top.weightCarry >= 2)
      points.push(`◎は${top.weightCarry.toFixed(1)}kgで平均より${(p.avgWeight - top.weightCarry).toFixed(1)}kg軽く、斤量利あり`);
  }
  if (ratio != null && shape === "混戦" && third)
    points.push(`スコア上位が拮抗(2位${Math.round(ratio * 100)}%)。▲${third.name}まで紐を広げたい混戦形`);
  if (ratio != null && shape === "抜けた本命")
    points.push(`スコア2位に${Math.round((1 - ratio) * 100)}%差をつけた一強形`);

  // 階級ごとの提案(閾値の根拠はファイル先頭コメント)
  if (layer === "OP・重賞") {
    const bets =
      shape === "混戦"
        ? [
            { label: `ワイド ◎${top?.name ?? ""}-○${second?.name ?? ""}`, amount: "500円" },
            { label: `ワイド ◎${top?.name ?? ""}-▲${third?.name ?? ""}`, amount: "500円" },
          ]
        : [
            { label: `ワイド ◎${top?.name ?? ""}-○${second?.name ?? ""}`, amount: "1,000円" },
          ];
    return {
      layer,
      stance: "buy",
      stanceLabel: "○ 買える層(実測: OP・重賞はワイド88.5%と相対上位・n=738)",
      headline: `${shape}。ワイド◎-○を本線に`,
      points,
      bets,
    };
  }
  if (layer === "3勝クラス" || layer === "特別戦") {
    return {
      layer,
      stance: "small",
      stanceLabel: "△ 少額のみ(実測: 条件戦はモデルが市場に劣位)",
      headline: `${shape}。買うならワイド◎-○を少額まで`,
      points,
      bets: [{ label: `ワイド ◎${top?.name ?? ""}-○${second?.name ?? ""}`, amount: "〜500円" }],
    };
  }
  return {
    layer,
    stance: "skip",
    stanceLabel: "✕ 見送り推奨(実測: この層のv2回収率は市場比−25pt以上)",
    headline: "予想は参考表示のみ。馬券は見送りが最も回収率が高い選択",
    points,
    bets: [],
  };
}
