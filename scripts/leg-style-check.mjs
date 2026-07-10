// scripts/corners.local.json(コーナー通過順バックフィル、進行中)から脚質(逃げ/先行/差し/追込)を
// 判定するロジックの検証スクリプト。DBと突き合わせて「脚質別の勝率・複勝率」「人気との相関」を見る。
// クロール完了を待たずに、今ある分(部分データ)で判定ロジックが機能するか先に検証する目的。
// train-logreg.mjs への組み込みはコーナークロール完了後の別タスク(このスクリプトはその下ごしらえ)。
//
// 使い方(プロジェクト直下で):
//   node scripts/leg-style-check.mjs

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

try {
  process.loadEnvFile(".env");
} catch {}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const corners = JSON.parse(fs.readFileSync(new URL("./corners.local.json", import.meta.url).pathname, "utf-8"));
console.log(`コーナーデータ ${Object.keys(corners).length}レース分をロード`);

// ---- 脚質判定: 最初のコーナー通過順位を頭数で正規化 ----
// firstPct: 0に近い=先頭集団、1に近い=最後方。lastPct: 最終コーナー時点。
// gain = firstPct - lastPct: プラス=道中で順位を上げた(差し・追込の伸び)
function legStyleOf(cornerStr, fieldSize) {
  if (!cornerStr || fieldSize < 2) return null;
  const parts = cornerStr.split("-").map(Number).filter((n) => Number.isFinite(n));
  if (parts.length === 0) return null;
  const firstPct = (parts[0] - 1) / (fieldSize - 1);
  const lastPct = (parts.at(-1) - 1) / (fieldSize - 1);
  let style;
  if (firstPct <= 0.15) style = "逃げ";
  else if (firstPct <= 0.4) style = "先行";
  else if (firstPct <= 0.7) style = "差し";
  else style = "追込";
  return { style, firstPct, lastPct, gain: firstPct - lastPct };
}

// ---- DBから該当result_idのplace/popularityを取得(チャンク分割) ----
// 注意: Supabaseは1クエリの返り行数がデフォルト1000行で切り捨てられる。1レース平均14頭なので
// in句に500レース分渡すと7000行相当になり大半が欠落する(実際にハマった)。60件×平均14頭≒840行に留める。
const resultIds = Object.keys(corners).map(Number);
const byResult = new Map();
const CHUNK = 60;
for (let i = 0; i < resultIds.length; i += CHUNK) {
  const chunk = resultIds.slice(i, i + CHUNK);
  const { data, error } = await supabase
    .from("result_horses")
    .select("result_id, umaban, place, popularity, place_text")
    .in("result_id", chunk);
  if (error) {
    console.error("DB読み取りエラー:", error.message);
    process.exit(1);
  }
  for (const h of data) {
    if (!byResult.has(h.result_id)) byResult.set(h.result_id, []);
    byResult.get(h.result_id).push(h);
  }
}

// ---- 集計 ----
const stats = new Map(); // style -> {n, win, top3, popSum}
const addStat = (style, place, pop) => {
  if (!stats.has(style)) stats.set(style, { n: 0, win: 0, top3: 0, popSum: 0, popN: 0 });
  const s = stats.get(style);
  s.n++;
  if (place === 1) s.win++;
  if (place != null && place <= 3) s.top3++;
  if (pop != null) {
    s.popSum += pop;
    s.popN++;
  }
};

let matched = 0, unmatched = 0, nullStyle = 0;
const gains = [];
for (const [rid, rec] of Object.entries(corners)) {
  const horses = byResult.get(Number(rid));
  if (!horses) {
    unmatched++;
    continue;
  }
  const fieldSize = Object.keys(rec.corners).length;
  for (const h of horses) {
    if (/[取除]/.test(h.place_text ?? "")) continue;
    const cornerStr = rec.corners[h.umaban];
    const ls = legStyleOf(cornerStr, fieldSize);
    if (!ls) {
      nullStyle++;
      continue;
    }
    matched++;
    addStat(ls.style, h.place, h.popularity);
    if (h.place != null) gains.push({ gain: ls.gain, place: h.place, fieldSize });
  }
}
console.log(`マッチ済み ${matched}頭 / 脚質判定不可 ${nullStyle}頭 / DB未マッチレース ${unmatched}件\n`);

console.log("===== 脚質別の成績 =====");
console.log("脚質    n      勝率     複勝率    平均人気");
for (const style of ["逃げ", "先行", "差し", "追込"]) {
  const s = stats.get(style);
  if (!s) continue;
  console.log(
    `${style}  ${String(s.n).padStart(6)}  ${((s.win / s.n) * 100).toFixed(1).padStart(5)}%  ${((s.top3 / s.n) * 100).toFixed(1).padStart(6)}%  ${(s.popSum / s.popN).toFixed(2).padStart(6)}`,
  );
}

// gain(道中の順位変化)と着順の相関(ざっくり: gain上位20% vs 下位20%の複勝率比較)
gains.sort((a, b) => a.gain - b.gain);
const q20 = gains[Math.floor(gains.length * 0.2)]?.gain;
const q80 = gains[Math.floor(gains.length * 0.8)]?.gain;
const low = gains.filter((g) => g.gain <= q20);
const high = gains.filter((g) => g.gain >= q80);
const top3Rate = (arr) => (arr.filter((g) => g.place <= 3).length / arr.length) * 100;
console.log("\n===== 道中の伸び(gain)と複勝率 =====");
console.log(`gain下位20%(終始前め/失速型) n=${low.length}  複勝率=${top3Rate(low).toFixed(1)}%`);
console.log(`gain上位20%(道中で追い上げた) n=${high.length}  複勝率=${top3Rate(high).toFixed(1)}%`);
