export type Horse = {
  number: number;
  name: string;
  odds: number;
  popularity: number;
  reason?: string;
};

export type Race = {
  id: string;
  name: string;
  date: string;
  venue: string;
  horses: Horse[];
};

export const mockRaces: Race[] = [
  {
    id: "race-1",
    name: "第10回 東京優駿記念",
    date: "2026-07-12(日) 15:40",
    venue: "東京競馬場",
    horses: [
      {
        number: 1,
        name: "サクラライトニング",
        odds: 3.2,
        popularity: 1,
        reason: "オッズ1位人気で信頼度高、直近3走とも連対",
      },
      { number: 2, name: "ミッドナイトブルー", odds: 5.8, popularity: 3 },
      { number: 3, name: "ゴールドフォーチュン", odds: 12.4, popularity: 5 },
      {
        number: 4,
        name: "ハリケーンダンサー",
        odds: 4.1,
        popularity: 2,
        reason: "前走上がり最速、東京コース実績も良好",
      },
      { number: 5, name: "シャイニングスター", odds: 8.9, popularity: 4 },
      { number: 6, name: "オーシャンビュー", odds: 24.6, popularity: 7 },
      { number: 7, name: "テンペストロード", odds: 18.2, popularity: 6 },
    ],
  },
  {
    id: "race-2",
    name: "夏季ステークス",
    date: "2026-07-12(日) 13:25",
    venue: "阪神競馬場",
    horses: [
      { number: 1, name: "クリムゾンフレア", odds: 6.5, popularity: 3 },
      {
        number: 2,
        name: "シルバーウィング",
        odds: 2.9,
        popularity: 1,
        reason: "鉄板の1番人気、休み明けでも仕上がり良好",
      },
      { number: 3, name: "ブレイブハート", odds: 15.3, popularity: 5 },
      {
        number: 4,
        name: "ノーザンライト",
        odds: 4.4,
        popularity: 2,
        reason: "得意の重馬場想定でここは狙い目",
      },
      { number: 5, name: "ファイヤーストーム", odds: 9.7, popularity: 4 },
    ],
  },
  {
    id: "race-3",
    name: "中京特別",
    date: "2026-07-13(月) 11:00",
    venue: "中京競馬場",
    horses: [
      { number: 1, name: "アルテミスの矢", odds: 7.2, popularity: 3 },
      {
        number: 2,
        name: "ブルーインパルス",
        odds: 3.6,
        popularity: 2,
        reason: "先行力があり展開が向けば一発",
      },
      {
        number: 3,
        name: "レジェンドロア",
        odds: 2.5,
        popularity: 1,
        reason: "圧倒的な1番人気、地元開催で近走安定",
      },
      { number: 4, name: "ウインドチェイサー", odds: 11.8, popularity: 5 },
      { number: 5, name: "スターダストキング", odds: 9.1, popularity: 4 },
      { number: 6, name: "パープルレイン", odds: 32.0, popularity: 8 },
      { number: 7, name: "サンライズエース", odds: 21.5, popularity: 7 },
      { number: 8, name: "モーニングデュー", odds: 17.9, popularity: 6 },
    ],
  },
];
