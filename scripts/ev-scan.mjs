// オッズスナップショット(scripts/odds.local.json)から「プール間の価格の歪み」を検出するスキャナ。
// クロールなし・ローカル計算のみ。フェーズ4B→EV算出(最終ゴール)の第一歩。
//
// ロジック:
//   1. 単勝オッズ → 暗黙勝率 p_i = (1/odds_i) / Σ(1/odds_j)  (控除率を正規化で除去)
//   2. p から Harville モデルで全順列確率を展開し、複勝(3着内)・ワイド(2頭とも3着内)・
//      馬連(上位2頭)の理論確率を計算
//   3. EV = 理論確率 × 実オッズ。EVが高い=そのプールが単勝市場に比べて過小評価している候補
//
// ⚠️ 注意(解釈の前提):
//   - Harvilleは人気薄の複勝系確率を過大評価する既知バイアスがある(Henery/Stern割引は未実装)。
//     人気薄のEV>1は割り引いて見ること。
//   - 単勝市場のfavorite-longshot bias(人気薄の暗黙確率は真の勝率より過大)も未補正。
//     どちらのバイアスも「人気薄のEVを実際より高く見せる」方向に働く。
//   - つまりこのスキャナの出力は「買い目リスト」ではなく「歪み候補の観測ログ」。
//     スナップショットを貯めて結果と突き合わせ、補正係数を学習するのが次のステップ。
//
// 使い方(プロジェクト直下で):
//   node scripts/ev-scan.mjs                              … 最新日付の全スナップショットを走査
//   node scripts/ev-scan.mjs --label friday-evening --track 福島
//   node scripts/ev-scan.mjs --min-ev 0.95 --top 30

import fs from "node:fs";

const IN = new URL("./odds.local.json", import.meta.url).pathname;

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const LABEL = argOf("--label", null);
const TRACK = argOf("--track", null);
const DATE = argOf("--date", null);
const MIN_EV = Number(argOf("--min-ev", "0.9"));
const TOP = Number(argOf("--top", "25"));

const store = JSON.parse(fs.readFileSync(IN, "utf-8"));
let snaps = store.snapshots;
if (LABEL) snaps = snaps.filter((s) => s.label === LABEL);
if (TRACK) snaps = snaps.filter((s) => s.track === TRACK);
if (DATE) snaps = snaps.filter((s) => s.date === DATE);
if (!DATE && !LABEL) {
  const latest = snaps.map((s) => s.date).sort().at(-1);
  snaps = snaps.filter((s) => s.date === latest);
}
if (snaps.length === 0) {
  console.error("該当スナップショットなし");
  process.exit(1);
}
// 同一 (date,track,label) は最後(=最新取得)を採用
const uniq = new Map();
for (const s of snaps) uniq.set(`${s.date}|${s.track}|${s.label}`, s);
snaps = [...uniq.values()];

// ---- Harville展開: 勝率ベクトル p から順列確率を集計 ----
// 返り値: { top2Pair: Map("i-j"→P(iとjが1,2着)), top3Set: Map, top3In: Map(馬番→P(3着内)), pairBoth3: Map }
function harville(p) {
  const ids = Object.keys(p).map(Number);
  const top2Pair = new Map(); // 順不同ペアが1-2着
  const top3In = new Map(ids.map((i) => [i, 0])); // 3着内
  const pairBoth3 = new Map(); // 順不同ペアが両方3着内
  for (const a of ids) {
    for (const b of ids) {
      if (b === a) continue;
      const pab = p[a] * (p[b] / (1 - p[a]));
      const key2 = [a, b].sort((x, y) => x - y).join("-");
      top2Pair.set(key2, (top2Pair.get(key2) ?? 0) + pab);
      for (const c of ids) {
        if (c === a || c === b) continue;
        const pabc = pab * (p[c] / (1 - p[a] - p[b]));
        for (const m of [a, b, c]) top3In.set(m, top3In.get(m) + pabc);
        for (const [x, y] of [[a, b], [a, c], [b, c]]) {
          const k = [x, y].sort((u, v) => u - v).join("-");
          pairBoth3.set(k, (pairBoth3.get(k) ?? 0) + pabc);
        }
      }
    }
  }
  return { top2Pair, top3In, pairBoth3 };
}

// ---- スキャン ----
const findings = [];
for (const snap of snaps) {
  for (const race of snap.races) {
    const entries = Object.entries(race.horses).filter(([, h]) => h.tan != null && h.tan > 0);
    const n = entries.length;
    if (n < 8) continue; // 複勝2着払い・ワイド無しの少頭数は対象外(ルールが変わるため)
    const inv = entries.map(([u, h]) => [Number(u), 1 / h.tan]);
    const overround = inv.reduce((a, [, v]) => a + v, 0);
    const p = Object.fromEntries(inv.map(([u, v]) => [u, v / overround]));
    const { top2Pair, top3In, pairBoth3 } = harville(p);
    const ctx = (bet, target, prob, odds) => ({
      date: snap.date,
      track: snap.track,
      label: snap.label,
      raceNo: race.raceNo,
      bet,
      target,
      prob,
      odds,
      ev: prob * odds,
      names: String(target)
        .split("-")
        .map((u) => race.horses[u]?.name ?? "?")
        .join(" / "),
    });
    // 複勝(オッズ下限で保守的に)
    for (const [u, h] of entries) {
      if (h.fukuMin != null) findings.push(ctx("複勝", u, top3In.get(Number(u)), h.fukuMin));
    }
    // ワイド(下限)
    for (const [key, [min]] of Object.entries(race.wide ?? {})) {
      const prob = pairBoth3.get(key);
      if (prob != null && min != null) findings.push(ctx("ワイド", key, prob, min));
    }
    // 馬連
    for (const [key, odds] of Object.entries(race.umaren ?? {})) {
      const prob = top2Pair.get(key);
      if (prob != null && odds != null) findings.push(ctx("馬連", key, prob, odds));
    }
  }
}

// ---- レポート ----
console.log(`■ EVスキャン  スナップショット${snaps.length}件(${snaps.map((s) => `${s.date} ${s.track}[${s.label}]`).join(", ")})`);
console.log(`  検査した買い目: ${findings.length}件  (EV=理論確率×実オッズ、1.0超=単勝市場基準で過小評価)`);

// プール別のEV分布(市場の整合性チェック)
for (const bet of ["複勝", "ワイド", "馬連"]) {
  const evs = findings.filter((f) => f.bet === bet).map((f) => f.ev).sort((a, b) => a - b);
  if (evs.length === 0) continue;
  const q = (x) => evs[Math.floor(evs.length * x)] ?? evs.at(-1);
  const mean = evs.reduce((a, b) => a + b, 0) / evs.length;
  console.log(
    `  ${bet.padEnd(4)} n=${String(evs.length).padStart(5)}  平均EV=${mean.toFixed(3)}  中央値=${q(0.5).toFixed(3)}  p90=${q(0.9).toFixed(3)}  最大=${evs.at(-1).toFixed(3)}`,
  );
}

const hits = findings.filter((f) => f.ev >= MIN_EV).sort((a, b) => b.ev - a.ev).slice(0, TOP);
console.log(`\n===== EV上位(≥${MIN_EV})上位${TOP}件 =====`);
console.log("EV     確率    オッズ   買い目");
for (const f of hits) {
  console.log(
    `${f.ev.toFixed(3)}  ${(f.prob * 100).toFixed(1).padStart(5)}%  ${String(f.odds).padStart(6)}  ${f.track}${String(f.raceNo).padStart(2)}R ${f.bet} ${f.target}(${f.names}) [${f.label}]`,
  );
}
if (hits.length === 0) console.log("(該当なし)");
