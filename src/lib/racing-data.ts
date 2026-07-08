// 競馬場テーマUIで使う定数・型。
// - WAKU_COLORS / GRADE_COLORS は JRA 準拠の配色
// - FEATURE_RACES はヒーロー & 日程バッジ用の重賞メタ(race_days に grade が無いため当面ここで持つ)
// - SAMPLE_RESULTS は「先週の結果」のデザイン確認用サンプル(フェーズ3の結果パイプライン実装後に実データへ差し替え)

// JRA 枠番カラー(1白 2黒 3赤 4青 5黄 6緑 7橙 8桃)
export const WAKU_COLORS: Record<number, { bg: string; fg: string; border?: string }> = {
  1: { bg: "#ffffff", fg: "#1a1a1a", border: "#b5ad96" },
  2: { bg: "#221f1f", fg: "#ffffff" },
  3: { bg: "#c62828", fg: "#ffffff" },
  4: { bg: "#1e5aa8", fg: "#ffffff" },
  5: { bg: "#f2c500", fg: "#1a1a1a" },
  6: { bg: "#2e7d32", fg: "#ffffff" },
  7: { bg: "#e07020", fg: "#ffffff" },
  8: { bg: "#e58fb1", fg: "#1a1a1a" },
};

// JRA グレード配色(G1青 / G2赤 / G3緑)
export const GRADE_COLORS: Record<string, string> = {
  G1: "#1e5aa8",
  G2: "#c62828",
  G3: "#2e7d32",
};

export type Grade = "G1" | "G2" | "G3";

export interface FeatureRace {
  name: string;
  grade: Grade;
  date: string; // ISO (YYYY-MM-DD)
  track: string;
  raceNo: number;
  course: string;
  note: string;
}

// 当面の重賞メタ(必要になったら随時追記 / いずれ race_days・races から取得)
export const FEATURE_RACES: FeatureRace[] = [
  {
    name: "七夕賞",
    grade: "G3",
    date: "2026-07-12",
    track: "福島",
    raceNo: 11,
    course: "芝 2000m",
    note: "ハンデ戦・夏の福島名物重賞",
  },
  {
    name: "函館記念",
    grade: "G3",
    date: "2026-07-19",
    track: "函館",
    raceNo: 11,
    course: "芝 2000m",
    note: "洋芝の総合力が問われる夏の重賞",
  },
];

export interface ResultHorse {
  pos: number;
  waku: number;
  umaban: number;
  name: string;
  jockey: string;
  pop: number; // 人気
}

export interface RaceResult {
  id: string;
  date: string;
  dayLabel: string;
  track: string;
  raceNo: number;
  name: string;
  grade?: Grade;
  course: string;
  going: string; // 馬場状態
  time: string;
  top3: ResultHorse[];
  payoutWin?: string; // 単勝払戻(結果クロールでは未取得。将来対応)
}

// 先週の結果(サンプル)。実装ではフェーズ3の結果テーブルから取得する。
export const SAMPLE_RESULTS: RaceResult[] = [
  {
    id: "r1",
    date: "2026-07-05",
    dayLabel: "7/5(日)",
    track: "福島",
    raceNo: 11,
    name: "ラジオNIKKEI賞",
    grade: "G3",
    course: "芝 1800m",
    going: "良",
    time: "1:46.2",
    top3: [
      { pos: 1, waku: 5, umaban: 9, name: "サンプルホースA", jockey: "横山 武", pop: 2 },
      { pos: 2, waku: 7, umaban: 13, name: "サンプルホースB", jockey: "戸崎 圭", pop: 1 },
      { pos: 3, waku: 2, umaban: 3, name: "サンプルホースC", jockey: "菅原 明", pop: 6 },
    ],
    payoutWin: "¥460",
  },
  {
    id: "r2",
    date: "2026-07-05",
    dayLabel: "7/5(日)",
    track: "小倉",
    raceNo: 11,
    name: "CBC賞",
    grade: "G3",
    course: "芝 1200m",
    going: "良",
    time: "1:07.5",
    top3: [
      { pos: 1, waku: 8, umaban: 16, name: "サンプルホースD", jockey: "川田 将", pop: 1 },
      { pos: 2, waku: 3, umaban: 5, name: "サンプルホースE", jockey: "松山 弘", pop: 4 },
      { pos: 3, waku: 6, umaban: 11, name: "サンプルホースF", jockey: "幸 英明", pop: 9 },
    ],
    payoutWin: "¥210",
  },
  {
    id: "r3",
    date: "2026-07-04",
    dayLabel: "7/4(土)",
    track: "福島",
    raceNo: 11,
    name: "バーデンバーデンC",
    course: "芝 1200m",
    going: "稍重",
    time: "1:08.9",
    top3: [
      { pos: 1, waku: 4, umaban: 7, name: "サンプルホースG", jockey: "田辺 裕", pop: 3 },
      { pos: 2, waku: 1, umaban: 1, name: "サンプルホースH", jockey: "津村 明", pop: 5 },
      { pos: 3, waku: 8, umaban: 15, name: "サンプルホースI", jockey: "石川 裕", pop: 2 },
    ],
    payoutWin: "¥680",
  },
];
