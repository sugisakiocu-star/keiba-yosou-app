// 券種横断のfavorite-longshot bias実測。pool-bias-check.mjs(単勝・複勝)の拡張版で、
// 枠連・ワイド・馬連・馬単・3連複・3連単の「組み合わせ人気度」別の実測回収率を出す。
//
// 仮説: 「複雑な券種ほど大穴(不人気な組み合わせ)が過大に買われ、回収率の落ち込みが深い」
//
// 方法:
// - 各レースで買える全組み合わせ(馬連ならC(n,2)、3連単ならn(n-1)(n-2)…)を100円ずつ買ったと仮定。
// - 組み合わせの人気度 = 構成馬の人気順位の「平均」(合計÷頭数)。平均にすることで
//   単勝(1頭)〜3連単(3頭)まで同じバンド定義で比較できる。
// - 的中判定は payouts.local.json の各券種のnumリスト。枠連は同枠ゾロ目も含む。
// - 券種ごとに控除率が違う(単複20% / 枠連・馬連・ワイド22.5% / 馬単・3連複25% / 3連単27.5%)ので、
//   実測回収率だけでなく「相対回収率 = 実測 ÷ 控除後理論値」を併記する。歪みゼロなら全バンド1.00。
// - レース単位ブートストラップ(シード固定)で95%CI。超大穴1件の罠([[keiba-app-payout-concentration]])
//   対策としてtop1除外回収率も併記。
//
// 使い方(プロジェクト直下で):
//   node scripts/pool-bias-exotic.mjs [--bootstrap N(既定10000、0で省略)] [--graded-only|--nongraded-only]
// 注意: n=8,453Rのブートストラップは重い(数分)。バックグラウンド実行推奨。
// クロールなし(payouts.local.jsonとSupabase読み取りのみ)。

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BOOTSTRAP = Number(argOf("--bootstrap", "10000"));
const GRADED_ONLY = args.includes("--graded-only");
const NONGRADED_ONLY = args.includes("--nongraded-only");

try {
  process.loadEnvFile(".env");
} catch {}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const payouts = JSON.parse(fs.readFileSync(new URL("./payouts.local.json", import.meta.url).pathname, "utf-8"));
const resultIds = Object.keys(payouts).map(Number);
console.log(`払戻データ ${resultIds.length}レース分をロード`);

// ---- DBから人気・馬番・枠を取得(60レースずつ: 1000行上限対策) ----
const byResult = new Map();
const raceMeta = new Map();
const CHUNK = 60;
for (let i = 0; i < resultIds.length; i += CHUNK) {
  const ids = resultIds.slice(i, i + CHUNK);
  const [h, r] = await Promise.all([
    supabase.from("result_horses").select("result_id, umaban, waku, popularity, place_text").in("result_id", ids),
    supabase.from("race_results").select("id, date, grade, name, surface").in("id", ids),
  ]);
  if (h.error || r.error) {
    console.error("DB読み取りエラー:", h.error?.message ?? r.error?.message);
    process.exit(1);
  }
  for (const x of h.data) {
    if (!byResult.has(x.result_id)) byResult.set(x.result_id, []);
    byResult.get(x.result_id).push(x);
  }
  for (const x of r.data) raceMeta.set(x.id, x);
}

// ---- バンド定義: 構成馬の人気順位の平均(単勝〜3連単で共通) ----
const BANDS = [
  { label: "超人気(平均〜2.5) ", test: (a) => a <= 2.5 },
  { label: "人気(〜4)        ", test: (a) => a > 2.5 && a <= 4 },
  { label: "中位(〜6)        ", test: (a) => a > 4 && a <= 6 },
  { label: "やや穴(〜9)      ", test: (a) => a > 6 && a <= 9 },
  { label: "大穴(9超)        ", test: (a) => a > 9 },
];
const bandOf = (avg) => BANDS.findIndex((b) => b.test(avg));

// 券種定義: 控除後理論回収率(JRAの払戻率)と複雑度順
const TYPES = [
  { key: "win", label: "単勝  ", theo: 0.8, k: 1 },
  { key: "place", label: "複勝  ", theo: 0.8, k: 1 },
  { key: "wakuren", label: "枠連  ", theo: 0.775, k: 2 },
  { key: "wide", label: "ワイド", theo: 0.775, k: 2 },
  { key: "umaren", label: "馬連  ", theo: 0.775, k: 2 },
  { key: "umatan", label: "馬単  ", theo: 0.75, k: 2 },
  { key: "trio", label: "3連複 ", theo: 0.75, k: 3 },
  { key: "tierce", label: "3連単 ", theo: 0.725, k: 3 },
];
const isJump = (m) => String(m?.grade ?? "").startsWith("J") || m?.surface === "障" || /障害/.test(String(m?.name ?? ""));

// ---- レースごとに 券種×バンド の {bets, ret, hits} を作る(ブートストラップの単位) ----
// bets: 買った組み合わせ数(各100円) / ret: 的中払戻円 / hits: 的中組数
const perRace = [];
let usedRaces = 0;
let minDate = "9999";
let maxDate = "0000";
let unmatchedLines = 0; // 的中ラインの馬番が出走馬に見つからない件数(データ不整合の監視用)

for (const rid of resultIds) {
  const meta = raceMeta.get(rid);
  const horses = byResult.get(rid);
  if (!meta || !horses || isJump(meta)) continue;
  if (GRADED_ONLY && !meta.grade) continue;
  if (NONGRADED_ONLY && meta.grade) continue;
  const P = payouts[rid]?.payouts;
  if (!P?.win?.length) continue;
  const runners = horses.filter((h) => !/[取除]/.test(h.place_text ?? "") && h.popularity != null && h.umaban != null);
  if (runners.length < 6) continue;
  usedRaces++;
  if (meta.date < minDate) minDate = meta.date;
  if (meta.date > maxDate) maxDate = meta.date;

  const popByUmaban = new Map(runners.map((h) => [h.umaban, h.popularity]));
  const n = runners.length;
  const pops = runners.map((h) => h.popularity);

  // stats[typeIdx][bandIdx] = {bets, ret, hits}
  const stats = TYPES.map(() => BANDS.map(() => ({ bets: 0, ret: 0, hits: 0 })));
  const addBet = (ti, avg) => {
    const bi = bandOf(avg);
    if (bi >= 0) stats[ti][bi].bets++;
  };
  const addHit = (ti, avg, yen) => {
    const bi = bandOf(avg);
    if (bi < 0) return;
    stats[ti][bi].ret += yen;
    stats[ti][bi].hits++;
  };

  // --- 購入点数のカウント(組み合わせ人気度の分布) ---
  // 単勝・複勝: 全頭1点ずつ
  for (const p of pops) {
    addBet(0, p);
    addBet(1, p);
  }
  // 2頭系(ワイド/馬連: C(n,2)を1点ずつ、馬単: 順序ありでペアごとに2点)
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const avg = (pops[i] + pops[j]) / 2;
      addBet(3, avg); // wide
      addBet(4, avg); // umaren
      const bi = bandOf(avg); // umatan は同ペア2点
      if (bi >= 0) stats[5][bi].bets += 2;
    }
  // 3頭系(3連複: C(n,3)を1点、3連単: 組ごとに6点)
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        const avg = (pops[i] + pops[j] + pops[k]) / 3;
        const bi = bandOf(avg);
        if (bi >= 0) {
          stats[6][bi].bets += 1; // trio
          stats[7][bi].bets += 6; // tierce
        }
      }
  // 枠連: 出走枠のペア(同枠は2頭以上いる時のみゾロ目が買える)。人気度=各枠の最人気馬の平均
  const byWaku = new Map();
  for (const h of runners) {
    if (h.waku == null) continue;
    if (!byWaku.has(h.waku)) byWaku.set(h.waku, []);
    byWaku.get(h.waku).push(h.popularity);
  }
  const wakus = [...byWaku.keys()].sort((a, b) => a - b);
  const wakuAvg = new Map(); // "a-b" -> 人気度平均(的中判定でも使う)
  for (let i = 0; i < wakus.length; i++) {
    for (let j = i; j < wakus.length; j++) {
      const a = wakus[i];
      const b = wakus[j];
      let avg;
      if (a === b) {
        const ps = [...byWaku.get(a)].sort((x, y) => x - y);
        if (ps.length < 2) continue; // ゾロ目は同枠2頭以上のみ
        avg = (ps[0] + ps[1]) / 2;
      } else {
        avg = (Math.min(...byWaku.get(a)) + Math.min(...byWaku.get(b))) / 2;
      }
      wakuAvg.set(`${a}-${b}`, avg);
      addBet(2, avg);
    }
  }

  // --- 的中払戻の集計 ---
  const popOf = (numStr) => popByUmaban.get(Number(numStr));
  const lineAvg = (num, k) => {
    const parts = String(num).split("-");
    if (parts.length !== k) return null;
    let s = 0;
    for (const p of parts) {
      const pop = popOf(p);
      if (pop == null) return null;
      s += pop;
    }
    return s / k;
  };
  const apply = (ti, lines, k) => {
    for (const l of lines ?? []) {
      const avg = lineAvg(l.num, k);
      if (avg == null) {
        unmatchedLines++;
        continue;
      }
      addHit(ti, avg, l.yen);
    }
  };
  apply(0, P.win, 1);
  apply(1, P.place, 1);
  apply(3, P.wide, 2);
  apply(4, P.umaren, 2);
  apply(5, P.umatan, 2);
  apply(6, P.trio, 3);
  apply(7, P.tierce, 3);
  // 枠連は馬番でなく枠番なので専用処理(人気度はwakuAvgから)
  for (const l of P.wakuren ?? []) {
    const key = String(l.num).split("-").map(Number).sort((a, b) => a - b).join("-");
    const avg = wakuAvg.get(key);
    if (avg == null) {
      unmatchedLines++;
      continue;
    }
    addHit(2, avg, l.yen);
  }

  perRace.push(stats);
}
console.log(
  `集計対象 ${usedRaces}レース(平地のみ${GRADED_ONLY ? "・重賞のみ" : ""}${NONGRADED_ONLY ? "・非重賞のみ" : ""}、期間 ${minDate}〜${maxDate})`,
);
if (unmatchedLines > 0) console.log(`⚠️ 出走馬と突合できなかった的中ライン ${unmatchedLines}件(除外・取消がらみ。少数なら無視可)`);

// ---- ブートストラップ(レース単位、シード固定) ----
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
function bootstrapCI(ti, bi) {
  if (BOOTSTRAP <= 0) return null;
  const rand = mulberry32(42);
  const n = perRace.length;
  // 高速化: 対象セルだけ配列に展開してからリサンプリング
  const rets = new Float64Array(n);
  const bets = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    rets[i] = perRace[i][ti][bi].ret;
    bets[i] = perRace[i][ti][bi].bets;
  }
  const means = new Float64Array(BOOTSTRAP);
  for (let b = 0; b < BOOTSTRAP; b++) {
    let r = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
      const idx = (rand() * n) | 0;
      r += rets[idx];
      c += bets[idx];
    }
    means[b] = c > 0 ? r / (c * 100) : 0;
  }
  means.sort();
  return [means[Math.floor(0.025 * BOOTSTRAP)], means[Math.min(BOOTSTRAP - 1, Math.floor(0.975 * BOOTSTRAP))]];
}

// ---- レポート ----
// 相対回収率 = 実測回収率 ÷ 控除後理論値。歪みゼロなら全バンド1.00。1未満=そのバンドは過剰に買われている。
console.log("\n※ 相対 = 実測回収率 ÷ 控除後理論値(単複80% / 枠連・馬連・ワイド77.5% / 馬単・3連複75% / 3連単72.5%)");
const grandSummary = [];
TYPES.forEach((t, ti) => {
  console.log(`\n===== ${t.label.trim()}(理論${(t.theo * 100).toFixed(1)}%) 組み合わせ人気度バンド別 =====`);
  console.log("バンド              点数        的中   回収率(top1除外)  相対   95%CI");
  const rowSummary = [];
  BANDS.forEach((b, bi) => {
    let bets = 0;
    let ret = 0;
    let hits = 0;
    let top1 = 0;
    for (const r of perRace) {
      const st = r[ti][bi];
      bets += st.bets;
      ret += st.ret;
      hits += st.hits;
      if (st.ret > top1) top1 = st.ret;
    }
    if (bets === 0) return;
    const rate = ret / (bets * 100);
    const rateEx = (ret - top1) / (bets * 100);
    const ci = bootstrapCI(ti, bi);
    const ciTxt = ci ? `[${(ci[0] * 100).toFixed(1)},${(ci[1] * 100).toFixed(1)}]` : "-";
    console.log(
      `${b.label}  ${String(bets).padStart(9)}  ${String(hits).padStart(7)}  ${((rate * 100).toFixed(1) + "%").padStart(7)} (${((rateEx * 100).toFixed(1) + "%").padStart(6)})  ${(rate / t.theo).toFixed(2)}  ${ciTxt}`,
    );
    rowSummary.push({ band: bi, rel: rate / t.theo, ci: ci ? [ci[0] / t.theo, ci[1] / t.theo] : null, hits });
  });
  grandSummary.push({ type: t.label.trim(), theo: t.theo, rows: rowSummary });
});

// ---- 仮説の要約: 大穴バンドの相対回収率を券種(複雑度)順に並べる ----
console.log("\n===== 仮説サマリ: 大穴バンド(平均人気9超)の相対回収率(1.00=歪みなし、低いほど過大評価) =====");
for (const g of grandSummary) {
  const row = g.rows.find((r) => r.band === 4);
  if (!row) continue;
  const ciTxt = row.ci ? ` CI[${row.ci[0].toFixed(2)}, ${row.ci[1].toFixed(2)}]` : "";
  console.log(`  ${g.type}: ×${row.rel.toFixed(3)}${ciTxt}  (的中${row.hits}件)`);
}
console.log("\n===== 同・超人気バンド(平均人気〜2.5)の相対回収率 =====");
for (const g of grandSummary) {
  const row = g.rows.find((r) => r.band === 0);
  if (!row) continue;
  const ciTxt = row.ci ? ` CI[${row.ci[0].toFixed(2)}, ${row.ci[1].toFixed(2)}]` : "";
  console.log(`  ${g.type}: ×${row.rel.toFixed(3)}${ciTxt}  (的中${row.hits}件)`);
}
console.log(`
読み方:
- 相対回収率が1.00から下に乖離するほど「そのバンドが過剰に買われている(過大評価)」。
- 仮説「複雑な券種ほど大穴が過大評価」が正しければ、大穴バンドの相対回収率が
  単勝→馬連→3連単の順に下がっていくはず。
- バンドは構成馬の人気順位の平均。3頭系の「平均9超」は3頭とも大穴級を意味し、
  的中件数が極端に少ない(CIが広い)ので点推定を信じすぎないこと。
- ブートストラップはレース単位リサンプリング・シード固定(B=${BOOTSTRAP})。
- 券種間で母集団(点数の分布)が違うため、同バンドでも構成は同質ではない(平均のマジックに注意)。`);
