// ロジスティック回帰(条件付きロジット=レース内softmax)による重み学習の実験スクリプト。
// ローカルバッチ(クロールなし、DB読むだけ)。予想ロジック(predict.ts)は変更しない。
//
// 使い方(プロジェクト直下で):
//   node scripts/train-logreg.mjs
//   node scripts/train-logreg.mjs --train-from 2024-07-01 --test-from 2026-01-01
//   node scripts/train-logreg.mjs --with-pop --bootstrap 10000   # 市場超えの頑健性チェック
//   node scripts/train-logreg.mjs --with-pop --with-corners      # 4K: cornerGain特徴量込み
//
// 設計:
//   - 「レース内で誰が勝つか」を直接モデル化する条件付きロジット。
//     各馬の特徴ベクトル x に対し score = w·x、P(馬iが勝つ) = softmax(score_i) をレース内で計算し、
//     実際の勝ち馬の対数尤度を最大化する(フルバッチ勾配上昇+Adam+L2正則化)。
//   - リーク防止: 特徴量は全て「そのレースの開催日より前」の結果のみから計算(backtest.mjsと同じ思想)。
//   - 時系列split: 学習期間の近走ウィンドウが全レースデータ(2024年以降)に収まるよう、
//     既定で学習=2024-07-01〜test-from前日、検証=2026-01-01以降。
//   - 比較対象: 同じ検証レースで v2(手動重み)の◎ と 1番人気 を横並び集計。
//   - 確率のベースライン: 学習期間の「人気別勝率」をレース内正規化したものと log loss を比較。
//
// ⚠️ classWeight/isJumpRun/aptBonus は predict.ts / backtest.mjs と同じ定義(変更時は要同期)。

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

// ---- CLI引数 ----
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const TRAIN_FROM = argOf("--train-from", "2024-07-01");
const TEST_FROM = argOf("--test-from", "2026-01-01");
const EPOCHS = Number(argOf("--epochs", "400"));
const LR = Number(argOf("--lr", "0.05"));
const L2 = Number(argOf("--l2", "0.001"));
// --stages: Plackett-Luce の学習段数。1=勝ち馬のみ(従来)、3=1→2→3着の順序を学習(既定)。
// 3連単・3連複の精度向上が目的。同じレース数から取れる学習信号も実質3倍になる。
const STAGES = Number(argOf("--stages", "3"));
// --with-pop: 人気(=市場の評価)を特徴量に加える。「うちの特徴量は市場に上乗せできる情報を
// 持っているか」の検証用(Benter方式: 市場確率+ファンダメンタルズの合成が実運用のEVの本命)。
const WITH_POP = args.includes("--with-pop");
// --bootstrap N: 検証セットをレース単位でN回リサンプリングし、「モデルlogloss − 人気ベースラインlogloss」
// の平均差の95%信頼区間を出す。重賞69R程度の小標本で「市場超え」がノイズと区別できるかの判定用。
// 学習自体は決定的(フルバッチ+ゼロ初期化)なので、不確実性の源は検証レースのサンプリングのみ。
const BOOTSTRAP = Number(argOf("--bootstrap", "0"));
// --with-corners: scripts/corners.local.json(backfill-corners.mjsの出力)から cornerGain 特徴量を追加。
// cornerGain = 過去走の「最初のコーナー通過pct − 最終コーナーpct」(プラス=道中で順位を上げた)。
// 対象レース自身のコーナーは道中の情報=結果の一部でリークになるため、他の近走系特徴量と同じく
// 「対象レースより前の走」だけから計算する。クロール完走前でも動く(欠損は学習平均埋め)。
const WITH_CORNERS = args.includes("--with-corners");

// ---- env / supabase ----
try {
  process.loadEnvFile(".env");
} catch {
  /* .env が無ければ環境変数をそのまま使う */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env にありません");
  process.exit(1);
}
const supabase = createClient(url, key);

// ---- 4K: コーナー通過順データ(--with-corners時のみ読む) ----
// 形式: { result_id: { corners: { umaban: "3-3-4-5", ... }, ... } } (leg-style-check.mjsと同じ)
let cornersByResult = null;
if (WITH_CORNERS) {
  try {
    cornersByResult = JSON.parse(fs.readFileSync(new URL("./corners.local.json", import.meta.url).pathname, "utf-8"));
    console.log(`コーナーデータ ${Object.keys(cornersByResult).length}レース分をロード(--with-corners)`);
  } catch (e) {
    console.error("scripts/corners.local.json が読めません(--with-cornersにはbackfill-corners.mjsの出力が必要):", e.message);
    process.exit(1);
  }
}

// ---- 共通定義(predict.ts / backtest.mjs と同期) ----
const GRADE_W = { G1: 1.5, G2: 1.2, G3: 1.0 };
const placePts = (p) =>
  p === 1 ? 10 : p === 2 ? 7 : p === 3 ? 5 : p === 4 ? 3 : p === 5 ? 2 : p != null && p <= 9 ? 1 : 0;
function classWeight(grade, raceName) {
  const gw = GRADE_W[grade ?? ""];
  if (gw) return gw;
  const n = String(raceName ?? "");
  if (/新馬|未勝利|メイクデビュー/.test(n)) return 0.3;
  if (/[1１]勝クラス/.test(n)) return 0.5;
  if (/[2２]勝クラス/.test(n)) return 0.65;
  if (/[3３]勝クラス/.test(n)) return 0.8;
  if (/オープン/.test(n)) return 0.9;
  return 0.7;
}
const isJumpRun = (grade, raceName, surface) =>
  String(grade ?? "").startsWith("J") || surface === "障" || /障害/.test(String(raceName ?? ""));
function aptBonus(surface, distance, target) {
  if (target.distance == null || target.surface == null) return 0;
  if (surface !== target.surface) return 0;
  return Math.abs((distance ?? 0) - target.distance) <= 300 ? 1 : 0;
}

// ---- v2スコア(比較用。backtest.mjs と同一) ----
function scoreHorseV2(runs, now, target) {
  if (runs.length === 0) return 0;
  let total = 0;
  for (const r of runs) {
    const gw = classWeight(r.meta.grade, r.meta.name);
    const ageMonths = (now.getTime() - new Date(r.meta.date).getTime()) / (1000 * 3600 * 24 * 30);
    const rw = ageMonths <= 3 ? 1.2 : ageMonths <= 6 ? 1.0 : 0.8;
    const apt = r.place != null && r.place <= 5 ? aptBonus(r.meta.surface, r.meta.distance, target) : 0;
    total += placePts(r.place) * gw * rw + apt;
  }
  return (total / runs.length) * Math.min(1, runs.length / 3) * 10;
}
function scoreFormV2(past, target) {
  const runs = past.filter((p) => p.place != null);
  if (runs.length === 0) return 0;
  const recencyW = (n) => (n <= 1 ? 1.0 : n === 2 ? 0.75 : n === 3 ? 0.55 : 0.4);
  let raw = 0;
  let apt = 0;
  for (const p of runs) {
    const rw = recencyW(p.runNo);
    const strengthMul = p.fieldSize != null ? Math.min(1.2, Math.max(0.7, p.fieldSize / 14)) : 1;
    raw += placePts(p.place) * classWeight(p.grade, p.raceName) * rw * strengthMul;
    if (p.place <= 5) apt += aptBonus(p.surface, p.distance, target) * rw * 2;
  }
  return (raw / runs.length) * Math.min(1, runs.length / 2) * 6 + apt;
}
function scoreJockeyV2(nRides, nTop3) {
  if (nRides < 5) return 0;
  return (nTop3 / nRides) * 30;
}

// ---- データ一括ロード ----
async function fetchAll(table, cols, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).order(order).range(from, from + 999);
    if (error) {
      console.error(`DB読み取り失敗(${table}):`, error);
      process.exit(1);
    }
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
console.log("データロード中…");
const races = await fetchAll("race_results", "id, date, track, name, grade, surface, distance, going", "date");
const rows = await fetchAll(
  "result_horses",
  "result_id, place, place_text, name, jockey, weight_carry, popularity, waku, umaban, last3f, horse_weight, horse_weight_diff, trainer, sex_age",
  "id",
);
console.log(`  races=${races.length} horses=${rows.length}`);

const raceById = new Map(races.map((r) => [r.id, r]));
const byRace = new Map();
for (const h of rows) {
  if (!byRace.has(h.result_id)) byRace.set(h.result_id, []);
  byRace.get(h.result_id).push(h);
}
const fieldSizeByResult = new Map([...byRace].map(([id, list]) => [id, list.length]));

// 上がり3Fのレース内パーセンタイル(0=最速)を前計算
const last3fPct = new Map(); // `${result_id}:${name}` -> pct
for (const [rid, list] of byRace) {
  const withL3 = list.filter((h) => h.last3f != null);
  if (withL3.length < 2) continue;
  const sorted = [...withL3].sort((a, b) => a.last3f - b.last3f);
  sorted.forEach((h, i) => last3fPct.set(`${rid}:${h.name}`, i / (sorted.length - 1)));
}

// 馬・騎手ごとの履歴を「日付昇順ソート済み配列」にして二分探索で当日より前だけ引く
// (backtest.mjs の毎回filterはO(全履歴)で、全クラス数千レースの学習では遅すぎるため)
const byHorse = new Map();
const byJockey = new Map();
const byTrainer = new Map();
const byTrainerTrack = new Map(); // key: `${trainer}|${track}`
for (const h of rows) {
  const meta = raceById.get(h.result_id);
  if (!meta) continue;
  if (!byHorse.has(h.name)) byHorse.set(h.name, []);
  byHorse.get(h.name).push({
    date: meta.date,
    place: h.place,
    popularity: h.popularity,
    weightCarry: h.weight_carry,
    fieldSize: fieldSizeByResult.get(h.result_id) ?? null,
    l3pct: last3fPct.get(`${h.result_id}:${h.name}`) ?? null,
    resultId: h.result_id, // 4K: corners.local.json をレースIDで引くため
    umaban: h.umaban, // 4K: コーナー通過順は馬番キー
    meta,
  });
  if (h.jockey) {
    if (!byJockey.has(h.jockey)) byJockey.set(h.jockey, []);
    byJockey.get(h.jockey).push({ date: meta.date, top3: h.place != null && h.place <= 3 ? 1 : 0 });
  }
  if (h.trainer) {
    if (!byTrainer.has(h.trainer)) byTrainer.set(h.trainer, []);
    byTrainer.get(h.trainer).push({ date: meta.date, top3: h.place != null && h.place <= 3 ? 1 : 0 });
    const tt = `${h.trainer}|${meta.track}`;
    if (!byTrainerTrack.has(tt)) byTrainerTrack.set(tt, []);
    byTrainerTrack.get(tt).push({ date: meta.date, top3: h.place != null && h.place <= 3 ? 1 : 0 });
  }
}
for (const list of byHorse.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
for (const list of [...byJockey.values(), ...byTrainer.values(), ...byTrainerTrack.values()]) {
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  let acc = 0;
  for (const r of list) {
    acc += r.top3;
    r.cum = acc; // 自分を含む累積top3数
  }
}
const cutIdx = (list, date) => {
  // date より前の要素数(=最初の list[i].date >= date の i)
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].date < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
const jockeyStats = (jockey, date) => {
  const list = byJockey.get(jockey) ?? [];
  const n = cutIdx(list, date);
  return { n, top3: n > 0 ? list[n - 1].cum : 0 };
};
const trainerStats = (trainer, date) => {
  const list = byTrainer.get(trainer) ?? [];
  const n = cutIdx(list, date);
  return { n, top3: n > 0 ? list[n - 1].cum : 0 };
};
const trainerTrackStats = (trainer, track, date) => {
  const list = byTrainerTrack.get(`${trainer}|${track}`) ?? [];
  const n = cutIdx(list, date);
  return { n, top3: n > 0 ? list[n - 1].cum : 0 };
};
const horseRunsBefore = (name, date) => {
  const list = byHorse.get(name) ?? [];
  return list.slice(0, cutIdx(list, date)).filter((r) => !isJumpRun(r.meta.grade, r.meta.name, r.meta.surface));
};

// ---- 特徴量 ----
const FEATURES = [
  "formPts", // 近走4走: 着順pt×クラス重み×頭数補正(直近ほど重い) ※v2のscoreForm相当の生値
  "lastClassW", // 前走のクラス重み(格上/格下挑戦の指標)
  "aptRecent", // 近走4走のコース適性(同馬場±300mで5着内、直近重み付き)
  "l3fRecent", // 近走4走の上がり3Fレース内パーセンタイル平均(0=毎回最速で符号反転済み=大きいほど速い)
  "jockeyRate", // 騎手の複勝率(当日まで、5騎乗未満は学習全体平均で埋める)
  "wDiff", // レース平均斤量との差(軽いほど正)
  "daysSince", // 前走からの日数 log1p(休養明けの指標)
  "careerTop3", // 馬のキャリア複勝率
  "careerRuns", // キャリア出走数 log1p
  "debut", // 初出走ダミー(過去走情報が全部無いことをモデルに伝える)
  "wakuOuterD", // ダート1800m未満の外枠(7枠以上)ダミー ※多角分析で外枠有利が出た項目
  // ---- 4H追加: 市場が織り込みにくい候補(全て追加クロールゼロ) ----
  "hwDiff", // 当日の馬体重増減(発走前に発表されるので既知・リークではない)
  "hwDiffAbs", // 増減の絶対値(大幅増減はどちらでもマイナス、を学習できるように)
  "wetApt", // 道悪適性: 当日が稍重/重/不良のとき、過去の非・良馬場での5着内率(道悪経験なしは0.5)
  "wetToday", // 当日道悪ダミー(wetAptの基準点)
  "trackApt", // 同競馬場での過去5着内率(ローカル巧者。経験なしは0.5)
  // ---- 4I追加: 未使用DBカラム+ローテ系(全て追加クロールゼロ) ----
  "trainerRate", // 調教師の複勝率(当日まで、5出走未満は学習全体平均)
  "formPct", // 近走の相対着順(頭数で正規化した着順パーセンタイル、1=勝ち。直近重み付き)
  "outperf", // 近走で人気をどれだけ超えて走ったか((人気-着順)/頭数、直近重み付き)。市場の見落とし候補
  "distChange", // 前走からの距離変更(m/200、延長が正)
  "surfSwitch", // 前走と馬場種別(芝⇔ダート)が変わったダミー
  "wCarryChg", // 前走からの斤量増減(今日-前走、増が正)
  "classUp", // 昇級初戦ダミー(今日のクラス重み>前走)
  "femaleD", // 牝馬ダミー
  "age", // 年齢
  // ---- 4J追加: 残りのゼロクロール候補 ----
  "trainerTrackRate", // 調教師×競馬場の複勝率(当日まで、5出走未満は学習全体平均)。滞在競馬・得意場の指標
  "layoffRunNo", // 休養明け(90日以上の間隔)から何戦目か(1=休み明け初戦、上限6)。叩き良化型の指標
];
// ---- 4K追加(--with-corners時のみ): コーナー通過順から作る「道中の伸び」 ----
if (WITH_CORNERS) FEATURES.push("cornerGain"); // 近走4走の(最初のコーナーpct−最終コーナーpct)の直近重み付き平均。leg-style-check.mjsで先行検証済み
if (WITH_POP) FEATURES.push("popLog"); // log(人気)。市場のレース前評価(発走前に既知なのでリークではない)
const toNumSafe = (s) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const recencyW = (n) => (n <= 1 ? 1.0 : n === 2 ? 0.75 : n === 3 ? 0.55 : 0.4);

// ---- 4K: 過去1走ぶんの cornerGain(道中の伸び)。leg-style-check.mjs の legStyleOf と同じ正規化 ----
// 頭数はコーナー記録自体の頭数(rec.cornersのキー数)を使う。通過順が1コーナー分しか無い場合は
// 「道中の変化」が定義できないので欠損(null)扱い。
function cornerGainOf(run) {
  const rec = cornersByResult?.[run.resultId];
  const cornerStr = rec?.corners?.[run.umaban];
  if (!cornerStr) return null;
  const fieldSize = Object.keys(rec.corners).length;
  if (fieldSize < 2) return null;
  const parts = String(cornerStr).split("-").map(Number).filter((n) => Number.isFinite(n));
  if (parts.length < 2) return null;
  const firstPct = (parts[0] - 1) / (fieldSize - 1);
  const lastPct = (parts.at(-1) - 1) / (fieldSize - 1);
  return firstPct - lastPct; // プラス=道中で順位を上げた(差し・追込の伸び)
}

function buildFeatures(h, race, avgW) {
  const runs = horseRunsBefore(h.name, race.date);
  const target = { distance: race.distance, surface: race.surface };
  const last4 = runs.slice(-4).reverse(); // 新しい順
  const f = Object.fromEntries(FEATURES.map((k) => [k, 0]));
  if (runs.length === 0) {
    f.debut = 1;
  } else {
    const placed = last4.filter((r) => r.place != null);
    if (placed.length > 0) {
      let raw = 0;
      let apt = 0;
      let l3 = 0;
      let l3n = 0;
      placed.forEach((r, i) => {
        const rw = recencyW(i + 1);
        const strengthMul = r.fieldSize != null ? Math.min(1.2, Math.max(0.7, r.fieldSize / 14)) : 1;
        raw += placePts(r.place) * classWeight(r.meta.grade, r.meta.name) * rw * strengthMul;
        if (r.place <= 5) apt += aptBonus(r.meta.surface, r.meta.distance, target) * rw;
        if (r.l3pct != null) {
          l3 += 1 - r.l3pct;
          l3n++;
        }
      });
      f.formPts = raw / placed.length;
      f.aptRecent = apt;
      f.l3fRecent = l3n > 0 ? l3 / l3n : 0.5;
    }
    const last = last4[0];
    f.lastClassW = classWeight(last.meta.grade, last.meta.name);
    f.daysSince = Math.log1p(
      (new Date(race.date).getTime() - new Date(last.date).getTime()) / (1000 * 3600 * 24),
    );
    const top3 = runs.filter((r) => r.place != null && r.place <= 3).length;
    f.careerTop3 = top3 / runs.length;
    f.careerRuns = Math.log1p(runs.length);
  }
  const js = jockeyStats(h.jockey, race.date);
  f.jockeyRate = js.n >= 5 ? js.top3 / js.n : NaN; // NaN→後で学習平均で埋める
  f.wDiff = h.weight_carry != null && avgW > 0 ? avgW - Number(h.weight_carry) : 0;
  f.wakuOuterD =
    String(race.surface ?? "").startsWith("ダ") && (race.distance ?? 9999) < 1800 && h.waku != null && h.waku >= 7
      ? 1
      : 0;
  f.hwDiff = h.horse_weight_diff != null ? Number(h.horse_weight_diff) : 0;
  f.hwDiffAbs = Math.abs(f.hwDiff);
  const wetToday = race.going != null && race.going !== "良";
  f.wetToday = wetToday ? 1 : 0;
  if (wetToday) {
    const wetRuns = runs.filter((r) => r.meta.going != null && r.meta.going !== "良");
    f.wetApt = wetRuns.length > 0 ? wetRuns.filter((r) => r.place != null && r.place <= 5).length / wetRuns.length : 0.5;
  } else {
    f.wetApt = 0.5; // 当日良馬場なら中立
  }
  const trackRuns = runs.filter((r) => r.meta.track === race.track);
  f.trackApt = trackRuns.length > 0 ? trackRuns.filter((r) => r.place != null && r.place <= 5).length / trackRuns.length : 0.5;
  // ---- 4I ----
  const ts = trainerStats(h.trainer, race.date);
  f.trainerRate = ts.n >= 5 ? ts.top3 / ts.n : NaN; // NaN→後で学習平均で埋める
  // ---- 4J ----
  const tts = trainerTrackStats(h.trainer, race.track, race.date);
  f.trainerTrackRate = tts.n >= 5 ? tts.top3 / tts.n : NaN; // NaN→後で学習平均で埋める
  if (runs.length > 0) {
    // 休養明けから何戦目か: 今日を1戦目として、90日以上の間隔が出るまで遡って数える
    const ds = [...runs.map((r) => r.date), race.date];
    let runNo = 1;
    for (let i = ds.length - 1; i >= 1 && runNo < 6; i--) {
      const gap = (new Date(ds[i]).getTime() - new Date(ds[i - 1]).getTime()) / (1000 * 3600 * 24);
      if (gap >= 90) break;
      runNo++;
    }
    f.layoffRunNo = runNo;
  } else {
    f.layoffRunNo = 1; // 初出走はdebutダミーが担当
  }
  if (runs.length > 0) {
    const placed4 = last4.filter((r) => r.place != null && r.fieldSize != null && r.fieldSize > 1);
    let pct = 0;
    let outp = 0;
    let wsum = 0;
    placed4.forEach((r, i) => {
      const rw = recencyW(i + 1);
      pct += ((r.fieldSize - r.place) / (r.fieldSize - 1)) * rw;
      if (r.popularity != null) outp += ((r.popularity - r.place) / r.fieldSize) * rw;
      wsum += rw;
    });
    f.formPct = wsum > 0 ? pct / wsum : 0.5;
    f.outperf = wsum > 0 ? outp / wsum : 0;
    const last = last4[0];
    f.distChange = last.meta.distance != null && race.distance != null ? (race.distance - last.meta.distance) / 200 : 0;
    f.surfSwitch = last.meta.surface != null && race.surface != null && last.meta.surface !== race.surface ? 1 : 0;
    f.wCarryChg = last.weightCarry != null && h.weight_carry != null ? Number(h.weight_carry) - Number(last.weightCarry) : 0;
    f.classUp = classWeight(race.grade, race.name) > classWeight(last.meta.grade, last.meta.name) ? 1 : 0;
  } else {
    f.formPct = 0.5;
  }
  // ---- 4K: cornerGain(--with-corners時のみ) ----
  // ⚠️ リーク防止: 使うのは last4(=対象レースより前の走)のコーナーだけ。当該レース自身の
  // コーナー通過順は「道中の結果」そのものなので絶対に使わない。formPct等と同じ設計方針。
  if (WITH_CORNERS) {
    let g = 0;
    let gw = 0;
    last4.forEach((r, i) => {
      const gain = cornerGainOf(r);
      if (gain != null) {
        g += gain * recencyW(i + 1);
        gw += recencyW(i + 1);
      }
    });
    // 欠損(コーナー未クロール/初出走)は NaN → 後で jockeyRate 等と同じく学習全体平均で埋める
    f.cornerGain = gw > 0 ? g / gw : NaN;
  }
  const sa = String(h.sex_age ?? "");
  f.femaleD = sa.startsWith("牝") ? 1 : 0;
  f.age = toNumSafe(sa.match(/\d+/)?.[0]) ?? 4;
  if (WITH_POP) f.popLog = -Math.log(h.popularity ?? 10); // 符号反転: 人気薄ほど小さく
  return f;
}

// ---- 学習/検証データ構築 ----
console.log(`特徴量構築中… (学習=${TRAIN_FROM}〜${TEST_FROM}前日 / 検証=${TEST_FROM}〜)`);
const trainRaces = [];
const testRaces = [];
for (const race of races) {
  if (isJumpRun(race.grade, race.name, race.surface)) continue;
  if (race.date < TRAIN_FROM) continue;
  const entrants = (byRace.get(race.id) ?? []).filter(
    (h) => !/[取除]/.test(h.place_text ?? "") && h.place != null,
  );
  if (entrants.length < 6) continue;
  if (!entrants.some((h) => h.place === 1)) continue;
  const withW = entrants.filter((h) => h.weight_carry != null);
  const avgW = withW.length ? withW.reduce((s, h) => s + Number(h.weight_carry), 0) / withW.length : 0;
  const sample = {
    race,
    entrants: entrants.map((h) => ({ h, f: buildFeatures(h, race, avgW) })),
  };
  // 1〜3着のインデックス(Plackett-Luce用、着順昇順)
  sample.topIdx = sample.entrants
    .map((e, i) => [e.h.place, i])
    .filter(([p]) => p != null && p <= 3)
    .sort((a, b) => a[0] - b[0])
    .map(([, i]) => i);
  if (race.date < TEST_FROM) trainRaces.push(sample);
  else testRaces.push(sample);
}
console.log(`  学習 ${trainRaces.length}レース / 検証 ${testRaces.length}レース`);

// ---- 人気ベースラインの確率(学習期間の人気別勝率をレース内正規化) ----
// ※ 特徴量としても使うためここで構築(学習セットのみから作るのでリークなし)
const popWin = new Map(); // popularity -> {n, win}
for (const s of trainRaces)
  for (const e of s.entrants) {
    if (e.h.popularity == null) continue;
    const p = Math.min(e.h.popularity, 18);
    if (!popWin.has(p)) popWin.set(p, { n: 0, win: 0 });
    const st = popWin.get(p);
    st.n++;
    if (e.h.place === 1) st.win++;
  }
const popProb = (pop) => {
  if (pop == null) return 0.02;
  const st = popWin.get(Math.min(pop, 18));
  return st && st.n >= 30 ? Math.max(st.win / st.n, 0.001) : 0.02;
};
// --with-pop の popLog を「線形のlog順位」から「人気別実勝率テーブルのlog」に置き換える。
// ベースラインと同じ表現力を持たせたうえで、他特徴量が上乗せできるかを公平に測るため。
if (WITH_POP)
  for (const s of [...trainRaces, ...testRaces])
    for (const e of s.entrants) e.f.popLog = Math.log(popProb(e.h.popularity));

// 4K: cornerGainのカバレッジを表示(クロール進行中は欠損が多い前提。NaN埋め前に数える)
if (WITH_CORNERS) {
  const ents = [...trainRaces, ...testRaces].flatMap((s) => s.entrants);
  const ok = ents.filter((e) => !Number.isNaN(e.f.cornerGain)).length;
  console.log(
    `  cornerGainカバレッジ: ${ok}/${ents.length}頭 (${((ok / ents.length) * 100).toFixed(1)}%) ※欠損は学習平均で埋める`,
  );
}

// レート系のNaNを学習全体平均で埋める+標準化(平均0/分散1、学習セットの統計のみ使用)
// ⚠️ NaN埋めが必要な特徴量を追加したら必ずこのリストにも追加(忘れると全重みNaNになる)
for (const key of ["jockeyRate", "trainerRate", "trainerTrackRate", ...(WITH_CORNERS ? ["cornerGain"] : [])]) {
  const vals = trainRaces.flatMap((s) => s.entrants.map((e) => e.f[key])).filter((v) => !Number.isNaN(v));
  const m = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1);
  for (const s of [...trainRaces, ...testRaces])
    for (const e of s.entrants) if (Number.isNaN(e.f[key])) e.f[key] = m;
}

const mean = {};
const sd = {};
for (const k of FEATURES) {
  const vals = trainRaces.flatMap((s) => s.entrants.map((e) => e.f[k]));
  mean[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
  sd[k] = Math.sqrt(vals.reduce((a, b) => a + (b - mean[k]) ** 2, 0) / vals.length) || 1;
}
const vecOf = (f) => FEATURES.map((k) => (f[k] - mean[k]) / sd[k]);
for (const s of [...trainRaces, ...testRaces]) for (const e of s.entrants) e.x = vecOf(e.f);

// ---- 学習(条件付きロジット、フルバッチAdam) ----
console.log(`学習中… (epochs=${EPOCHS}, lr=${LR}, L2=${L2})`);
const D = FEATURES.length;
let w = new Array(D).fill(0);
const mAdam = new Array(D).fill(0);
const vAdam = new Array(D).fill(0);
const B1 = 0.9;
const B2 = 0.999;
const EPS = 1e-8;
function raceProbs(s, weights) {
  const scores = s.entrants.map((e) => e.x.reduce((acc, xi, d) => acc + xi * weights[d], 0));
  const mx = Math.max(...scores);
  const exps = scores.map((sc) => Math.exp(sc - mx));
  const Z = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / Z);
}
// Plackett-Luce: 1着→(残りから)2着→(残りから)3着 と段階的にsoftmaxを取り、
// 実際の順序の対数尤度を最大化する。STAGES=1なら従来の勝ち馬のみ学習と一致。
const dot = (x, weights) => x.reduce((acc, xi, d) => acc + xi * weights[d], 0);
for (let ep = 1; ep <= EPOCHS; ep++) {
  const grad = new Array(D).fill(0);
  let nll = 0;
  for (const s of trainRaces) {
    let remaining = s.entrants.map((_, i) => i);
    for (const t of s.topIdx.slice(0, STAGES)) {
      const scores = remaining.map((i) => dot(s.entrants[i].x, w));
      const mx = Math.max(...scores);
      const exps = scores.map((sc) => Math.exp(sc - mx));
      const Z = exps.reduce((a, b) => a + b, 0);
      const pt = exps[remaining.indexOf(t)] / Z;
      nll -= Math.log(Math.max(pt, 1e-12));
      remaining.forEach((i, k) => {
        const coef = (i === t ? 1 : 0) - exps[k] / Z;
        const x = s.entrants[i].x;
        for (let d = 0; d < D; d++) grad[d] += coef * x[d];
      });
      remaining = remaining.filter((i) => i !== t);
    }
  }
  for (let d = 0; d < D; d++) {
    const g = grad[d] / trainRaces.length - L2 * w[d];
    mAdam[d] = B1 * mAdam[d] + (1 - B1) * g;
    vAdam[d] = B2 * vAdam[d] + (1 - B2) * g * g;
    const mh = mAdam[d] / (1 - B1 ** ep);
    const vh = vAdam[d] / (1 - B2 ** ep);
    w[d] += (LR * mh) / (Math.sqrt(vh) + EPS);
  }
  if (ep % 100 === 0 || ep === 1)
    console.log(`  epoch ${String(ep).padStart(4)}  train NLL/race=${(nll / trainRaces.length).toFixed(4)}`);
}

// ---- 検証 ----
// 着順系メトリクス: 予想順位リスト(order=エントリindexの並び)と実際の着順から
// 3連単/3連複/6頭BOX/軸マルチの的中を判定
function rankHits(order, entrants) {
  const placeOf = (i) => entrants[i].h.place;
  const top3set = new Set(entrants.map((e, i) => i).filter((i) => placeOf(i) != null && placeOf(i) <= 3));
  const p3 = order.slice(0, 3);
  return {
    sanrentan: placeOf(p3[0]) === 1 && placeOf(p3[1]) === 2 && placeOf(p3[2]) === 3,
    sanrenpuku: p3.every((i) => top3set.has(i)),
    box6: [...top3set].every((i) => order.slice(0, 6).includes(i)), // 3連複6頭BOX(20点)相当
    // 3連単◎軸1頭マルチ・相手5頭(60点)相当: ◎が3着内 かつ 残り3着内2頭が予想2〜6位に含まれる
    axisMulti:
      top3set.has(order[0]) && [...top3set].filter((i) => i !== order[0]).every((i) => order.slice(1, 6).includes(i)),
  };
}

function evaluate(samples, label) {
  const mkR = () => ({ sanrentan: 0, sanrenpuku: 0, box6: 0, axisMulti: 0 });
  const st = {
    n: 0,
    model: { win: 0, top3: 0, top5: 0, ll: 0, r: mkR() },
    v2: { win: 0, top3: 0, top5: 0, r: mkR() },
    fav: { win: 0, top3: 0, ll: 0, r: mkR() },
  };
  const llPairs = []; // レースごとの [モデルlogloss, 人気ベースラインlogloss](--bootstrap用)
  const hitPairs = []; // レースごとの [モデル3連単, 人気順3連単, モデル3連複, 人気順3連複] の的中0/1(--bootstrap用)
  for (const s of samples) {
    const race = s.race;
    const target = { distance: race.distance, surface: race.surface };
    const now = new Date(race.date);
    const p = raceProbs(s, w);
    const winIdx = s.entrants.findIndex((e) => e.h.place === 1);

    // model
    const order = p.map((pi, i) => [pi, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    const pick = s.entrants[order[0]].h;
    st.n++;
    if (pick.place === 1) st.model.win++;
    if (pick.place <= 3) st.model.top3++;
    if (order.slice(0, 5).includes(winIdx)) st.model.top5++;
    st.model.ll -= Math.log(Math.max(p[winIdx], 1e-12));
    const mh = rankHits(order, s.entrants);
    for (const k of Object.keys(mh)) if (mh[k]) st.model.r[k]++;

    // v2(手動重み)
    const withW = s.entrants.filter((e) => e.h.weight_carry != null);
    const avgW = withW.length
      ? withW.reduce((sum, e) => sum + Number(e.h.weight_carry), 0) / withW.length
      : 0;
    const v2scores = s.entrants.map((e) => {
      const runs = horseRunsBefore(e.h.name, race.date).map((r) => ({ ...r, meta: r.meta }));
      const past = runs
        .slice(-4)
        .reverse()
        .map((r, i) => ({
          runNo: i + 1,
          place: r.place,
          fieldSize: r.fieldSize,
          distance: r.meta.distance,
          surface: r.meta.surface,
          grade: r.meta.grade,
          raceName: r.meta.name,
        }));
      const js = jockeyStats(e.h.jockey, race.date);
      const wPts = e.h.weight_carry != null && avgW > 0 ? (avgW - Number(e.h.weight_carry)) * 2 : 0;
      return scoreHorseV2(runs, now, target) + scoreFormV2(past, target) + scoreJockeyV2(js.n, js.top3) + wPts;
    });
    const v2order = v2scores.map((sc, i) => [sc, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    const v2pick = s.entrants[v2order[0]].h;
    if (v2pick.place === 1) st.v2.win++;
    if (v2pick.place <= 3) st.v2.top3++;
    if (v2order.slice(0, 5).includes(winIdx)) st.v2.top5++;
    const vh = rankHits(v2order, s.entrants);
    for (const k of Object.keys(vh)) if (vh[k]) st.v2.r[k]++;

    // 1番人気+人気ベースラインlog loss+人気順の着順メトリクス
    const fav = s.entrants.find((e) => e.h.popularity === 1);
    if (fav?.h.place === 1) st.fav.win++;
    if (fav?.h.place != null && fav.h.place <= 3) st.fav.top3++;
    const rawP = s.entrants.map((e) => popProb(e.h.popularity));
    const Z = rawP.reduce((a, b) => a + b, 0);
    st.fav.ll -= Math.log(Math.max(rawP[winIdx] / Z, 1e-12));
    llPairs.push([-Math.log(Math.max(p[winIdx], 1e-12)), -Math.log(Math.max(rawP[winIdx] / Z, 1e-12))]);
    const favOrder = s.entrants
      .map((e, i) => [e.h.popularity ?? 99, i])
      .sort((a, b) => a[0] - b[0])
      .map(([, i]) => i);
    const fh = rankHits(favOrder, s.entrants);
    for (const k of Object.keys(fh)) if (fh[k]) st.fav.r[k]++;
    hitPairs.push([mh.sanrentan ? 1 : 0, fh.sanrentan ? 1 : 0, mh.sanrenpuku ? 1 : 0, fh.sanrenpuku ? 1 : 0]);
  }
  const pc = (x) => ((x / Math.max(st.n, 1)) * 100).toFixed(1) + "%";
  console.log(`\n===== 検証: ${label} (${st.n}レース) =====`);
  console.log(
    `ロジ回帰(◎)  : 勝率 ${pc(st.model.win).padStart(6)} / 複勝率 ${pc(st.model.top3).padStart(6)} / 勝ち馬印5頭内 ${pc(st.model.top5)} / logloss ${(st.model.ll / st.n).toFixed(4)}`,
  );
  console.log(
    `v2(手動重み)  : 勝率 ${pc(st.v2.win).padStart(6)} / 複勝率 ${pc(st.v2.top3).padStart(6)} / 勝ち馬印5頭内 ${pc(st.v2.top5)}`,
  );
  console.log(
    `1番人気       : 勝率 ${pc(st.fav.win).padStart(6)} / 複勝率 ${pc(st.fav.top3).padStart(6)} / (人気ベースラインlogloss ${(st.fav.ll / st.n).toFixed(4)})`,
  );
  console.log(`--- 着順(3連系)メトリクス ---`);
  const rline = (name, r) =>
    `${name}: 3連単 ${pc(r.sanrentan).padStart(6)} / 3連複 ${pc(r.sanrenpuku).padStart(6)} / 3連複6頭BOX ${pc(r.box6).padStart(6)} / ◎軸マルチ60点 ${pc(r.axisMulti).padStart(6)}`;
  console.log(rline("ロジ回帰      ", st.model.r));
  console.log(rline("v2(手動重み)  ", st.v2.r));
  console.log(rline("人気順        ", st.fav.r));
  if (BOOTSTRAP > 0) {
    bootstrapReport(llPairs, label);
    bootstrapHitReport(hitPairs, label);
  }
}

// ---- ブートストラップ(--bootstrap N) ----
// レース単位のペア差 d_i = (モデルの-log p) − (人気ベースラインの-log p) をN回リサンプリングし、
// 平均差の95%信頼区間と「差>=0(=市場に勝てていない)になる確率」を出す。差が負=モデル優位。
// 学習は決定的(フルバッチAdam+ゼロ初期化)なので、不確実性の源は検証レースの標本抽出のみ。
// 乱数はシード固定(mulberry32)で毎回同じ結果になる(再現性のため)。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bootstrapReport(llPairs, label) {
  const n = llPairs.length;
  if (n === 0) return;
  const diffs = llPairs.map(([m, f]) => m - f);
  const obs = diffs.reduce((a, b) => a + b, 0) / n;
  const rand = mulberry32(42);
  const means = new Array(BOOTSTRAP);
  for (let b = 0; b < BOOTSTRAP; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[(rand() * n) | 0];
    means[b] = sum / n;
  }
  means.sort((a, b) => a - b);
  const q = (p) => means[Math.min(BOOTSTRAP - 1, Math.floor(p * BOOTSTRAP))];
  const pNotBetter = means.filter((m) => m >= 0).length / BOOTSTRAP;
  console.log(`--- ブートストラップ: logloss差(モデル−人気ベースライン、負=モデル優位) n=${n}R B=${BOOTSTRAP} ---`);
  console.log(
    `観測差 ${obs >= 0 ? "+" : ""}${obs.toFixed(4)} / 95%CI [${q(0.025).toFixed(4)}, ${q(0.975).toFixed(4)}] / P(差>=0) ${(pNotBetter * 100).toFixed(1)}%`,
  );
  console.log(
    q(0.975) < 0
      ? `→ 市場超えは統計的に有意(95%CIが0未満)`
      : `→ 95%CIが0を跨ぐ: この標本サイズでは「市場超え」と「誤差」を区別できない`,
  );
}

// ---- 3連系ヒット率の差のブートストラップ(--bootstrap時にloglossと併せて出力) ----
// レースごとの的中0/1のペア差 d_i = モデル的中 − 人気順的中(-1/0/+1)をリサンプリング。
// 的中イベント自体が数十件しかないので、点推定の差(例: 3.0% vs 2.7%)がノイズか判定するのが目的。
function bootstrapHitReport(hitPairs, label) {
  const n = hitPairs.length;
  if (n === 0) return;
  console.log(`--- ブートストラップ: 3連系ヒット率の差(モデル−人気順、正=モデル優位) n=${n}R B=${BOOTSTRAP} ---`);
  for (const [name, mi, fi] of [
    ["3連単", 0, 1],
    ["3連複", 2, 3],
  ]) {
    const diffs = hitPairs.map((p) => p[mi] - p[fi]);
    const mHits = hitPairs.reduce((a, p) => a + p[mi], 0);
    const fHits = hitPairs.reduce((a, p) => a + p[fi], 0);
    const obs = (mHits - fHits) / n;
    const rand = mulberry32(42);
    const means = new Array(BOOTSTRAP);
    for (let b = 0; b < BOOTSTRAP; b++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += diffs[(rand() * n) | 0];
      means[b] = sum / n;
    }
    means.sort((a, b) => a - b);
    const lo = means[Math.floor(0.025 * BOOTSTRAP)];
    const hi = means[Math.min(BOOTSTRAP - 1, Math.floor(0.975 * BOOTSTRAP))];
    const pNotBetter = means.filter((m) => m <= 0).length / BOOTSTRAP;
    console.log(
      `${name}: モデル${mHits}件(${((mHits / n) * 100).toFixed(1)}%) vs 人気順${fHits}件(${((fHits / n) * 100).toFixed(1)}%)  差 ${obs >= 0 ? "+" : ""}${(obs * 100).toFixed(2)}pt  95%CI [${(lo * 100).toFixed(2)}, ${(hi * 100).toFixed(2)}]  P(差<=0) ${(pNotBetter * 100).toFixed(1)}%${lo > 0 ? "  ← 有意にモデル優位" : hi < 0 ? "  ← 有意に人気順優位" : "  ← CIが0を跨ぐ=誤差と区別できない"}`,
    );
  }
}

evaluate(testRaces, `全クラス ${TEST_FROM}以降`);
evaluate(
  testRaces.filter((s) => s.race.grade && !s.race.grade.startsWith("J")),
  `平地重賞のみ ${TEST_FROM}以降`,
);

// ---- 学習された重み(標準化スケール=特徴量間で大小比較できる) ----
console.log("\n===== 学習された重み(標準化スケール、絶対値が大きいほど効いている) =====");
const ranked = FEATURES.map((k, d) => [k, w[d]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
for (const [k, wi] of ranked) console.log(`  ${k.padEnd(12)} ${wi >= 0 ? "+" : ""}${wi.toFixed(4)}`);
console.log(
  "\n※ 検証はホールドアウト(学習に未使用)。重みはpredict.tsへはまだ未反映(このスクリプトは実験専用)。",
);
