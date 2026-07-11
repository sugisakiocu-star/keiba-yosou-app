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
//   node scripts/ev-scan.mjs --raw                        … favorite-longshot bias補正なし(旧動作)
//   node scripts/ev-scan.mjs --include-thin               … 薄商いプールの除外を無効化(観察用)

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
const RAW = args.includes("--raw");

// ---- favorite-longshot bias の実測補正(既定でON、--rawで無効) ----
// 係数の出典: scripts/pool-bias-check.mjs(払戻8,453R・平地全レース・2023-07〜2026-07、2026-07-11完走後計測)。
// 単勝の実測回収率÷0.8 = 「オッズ暗黙勝率に掛けるべき倍率」。人気順位はレース内の単勝オッズ昇順。
// payouts.local.json が増えたら pool-bias-check.mjs を再実行して以下を更新すること。
// 適用ルール(非対称):
//   - 確率を「上げる」補正(factor>1)は偽のEV>1を製造しうるので、CIが1を明確に除外するまで適用しない。
//   - 確率を「下げる」補正(factor<1)はEVを抑える安全方向。10人気〜は3つの計測すべてで方向一致。
// 実測値(2026-07-11・payoutsクロール完走後の確定値 n=8,453R。適用ルール: CIが1を除外する帯のみ補正):
//   1人気×0.987 CI[0.95,1.02] / 2-3×0.979 CI[0.95,1.01] → CIが1を跨ぐので補正なし
//   4-6×0.937 CI[0.89,0.98] ←CIが1を除外・今回から適用
//   7-9×0.966 CI[0.89,1.05] → 補正なし
//   10〜×0.779 CI[0.68,0.89] ←CIが1を除外。旧×0.56(重賞387Rのみの初期値)から緩和
// 履歴: 初期値は重賞387Rベースの×0.56(10人気〜のみ)。全レース8,453Rで再計測した結果、
//   FLバイアスは残るが重賞オンリーの推定より穏やか(×0.78)と確定。条件戦固有の歪みは
//   多重比較補正後ゼロ(pool-bias-check.mjs --by all)なので、階級別の係数分離はしない。
// ⚠️ これは単勝(勝率)の補正。Harvilleが人気薄の複勝系確率を過大評価する問題は別で残る。
const CALIB = [
  { maxRank: 3, factor: 1.0 },
  { maxRank: 6, factor: 0.94 },
  { maxRank: 9, factor: 1.0 },
  { maxRank: Infinity, factor: 0.78 },
];
const calibFactor = (rank) => CALIB.find((c) => rank <= c.maxRank).factor;
const INCLUDE_THIN = args.includes("--include-thin");

// ---- 薄商いプールの検知 ----
// 前日夜などプールに金が入っていない時間帯は、EVがいくら高く出ても「歪み」ではなく「まだ誰も
// 買っていないだけ」(実例: 金曜20:54の小倉4Rは異なる馬連2組が同額1379.5倍、複勝下限>単勝の逆転あり)。
// シグナル: (a)複勝下限が単勝を上回る馬がいる (b)馬連のオッズ値の重複が多い (c)オッズ未成立の組がある
function poolThinness(race, entries) {
  const fukuAnomaly = entries.filter(([, h]) => h.fukuMin != null && h.tan != null && h.fukuMin > h.tan).length;
  const umaOdds = Object.values(race.umaren ?? {}).filter((v) => v != null);
  const dupFrac = umaOdds.length > 0 ? 1 - new Set(umaOdds).size / umaOdds.length : 0;
  const nPairs = (entries.length * (entries.length - 1)) / 2;
  const missingFrac = nPairs > 0 ? 1 - umaOdds.length / nPairs : 0;
  // 3連複プールにも同じ検査(取得時のみ)。組数が多いぶん薄さが出やすい
  const trioOdds = Object.values(race.trio ?? {}).filter((v) => v != null);
  let trioThin = false;
  if (trioOdds.length > 0) {
    const nTrios = (entries.length * (entries.length - 1) * (entries.length - 2)) / 6;
    trioThin = 1 - new Set(trioOdds).size / trioOdds.length > 0.15 || 1 - trioOdds.length / nTrios > 0.05;
  }
  const thin = fukuAnomaly > 0 || dupFrac > 0.15 || missingFrac > 0.05 || trioThin;
  return { thin, fukuAnomaly, dupFrac, missingFrac, trioThin };
}

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
// P(1着a,2着b,3着c) = p_a × p_b/(1−p_a) × p_c/(1−p_a−p_b)(Plackett-Luceの3段展開)。
// この pabc を全順列で回して各券種の理論確率に集計する:
//   top2Pair:  "i-j"(昇順) → iとjが1-2着(順不同)   … 馬連
//   top3In:    馬番 → 3着内                        … 複勝
//   pairBoth3: "i-j"(昇順) → 両方3着内             … ワイド
//   top3Set:   "i-j-k"(昇順) → 3頭が1-3着(順不同)  … 3連複(6順列の和)
//   top3Exact: "i-j-k"(着順) → この順どおり        … 3連単(1順列そのもの)
function harville(p) {
  const ids = Object.keys(p).map(Number);
  const top2Pair = new Map(); // 順不同ペアが1-2着
  const top3In = new Map(ids.map((i) => [i, 0])); // 3着内
  const pairBoth3 = new Map(); // 順不同ペアが両方3着内
  const top3Set = new Map(); // 順不同トリオが1-3着
  const top3Exact = new Map(); // 着順どおりのトリオ
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
        top3Exact.set(`${a}-${b}-${c}`, pabc);
        const k3 = [a, b, c].sort((x, y) => x - y).join("-");
        top3Set.set(k3, (top3Set.get(k3) ?? 0) + pabc);
      }
    }
  }
  return { top2Pair, top3In, pairBoth3, top3Set, top3Exact };
}

// ---- --self-test: 理論確率の恒等式チェック(オッズデータ不要のロジック検証) ----
// 3連単・3連複の計算式が正しければ、どんな勝率ベクトルでも以下が厳密に成り立つ:
//   Σ3連単(全順列)=1 / Σ3連複(全組)=1 / Σ複勝=3 / Σ馬連=1 / Σワイド=3(1レースに3ペア)
// さらに一様勝率(全馬1/n)なら全順列が等確率 = 閉形式 1/(n(n-1)(n-2)) と一致するはず。
if (args.includes("--self-test")) {
  const n = 10;
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const approx = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;
  const uni = Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, 1 / n]));
  const h = harville(uni);
  const skewRaw = Array.from({ length: n }, (_, i) => 1 / (i + 1.5)); // 人気に傾けた非一様ケース
  const Zs = skewRaw.reduce((a, b) => a + b, 0);
  const h2 = harville(Object.fromEntries(skewRaw.map((v, i) => [i + 1, v / Zs])));
  const checks = [
    ["一様: Σ3連単(全順列) = 1", approx(sum(h.top3Exact), 1)],
    ["一様: Σ3連複(全組) = 1", approx(sum(h.top3Set), 1)],
    ["一様: Σ複勝(3着内) = 3", approx(sum(h.top3In), 3)],
    ["一様: Σ馬連 = 1", approx(sum(h.top2Pair), 1)],
    ["一様: Σワイド = 3", approx(sum(h.pairBoth3), 3)],
    ["一様: 3連単1点 = 1/(n(n-1)(n-2))", approx(h.top3Exact.get("1-2-3"), 1 / (n * (n - 1) * (n - 2)))],
    ["一様: 3連複1点 = 6/(n(n-1)(n-2))", approx(h.top3Set.get("1-2-3"), 6 / (n * (n - 1) * (n - 2)))],
    [
      "3連複 = 同じ3頭の3連単6順列の和",
      approx(
        h2.top3Set.get("2-5-8"),
        ["2-5-8", "2-8-5", "5-2-8", "5-8-2", "8-2-5", "8-5-2"].reduce((a, k) => a + h2.top3Exact.get(k), 0),
      ),
    ],
    ["非一様: Σ3連単 = 1", approx(sum(h2.top3Exact), 1)],
    ["非一様: Σ3連複 = 1", approx(sum(h2.top3Set), 1)],
    ["非一様: Σ複勝 = 3", approx(sum(h2.top3In), 3)],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "self-test: 全チェックPASS" : "self-test: 失敗あり");
  process.exit(ok ? 0 : 1);
}

// ---- スキャン ----
const findings = [];
let thinSkipped = 0;
let scanned = 0;
for (const snap of snaps) {
  for (const race of snap.races) {
    const entries = Object.entries(race.horses).filter(([, h]) => h.tan != null && h.tan > 0);
    const n = entries.length;
    if (n < 8) continue; // 複勝2着払い・ワイド無しの少頭数は対象外(ルールが変わるため)
    scanned++;
    const health = poolThinness(race, entries);
    if (health.thin && !INCLUDE_THIN) {
      thinSkipped++;
      continue;
    }
    const inv = entries.map(([u, h]) => [Number(u), 1 / h.tan]);
    const overround = inv.reduce((a, [, v]) => a + v, 0);
    const p = Object.fromEntries(inv.map(([u, v]) => [u, v / overround]));
    if (!RAW) {
      // FLバイアス補正: オッズ昇順=人気順位を出し、帯ごとの実測倍率を掛けてレース内で再正規化
      const ranked = [...entries].sort((a, b) => a[1].tan - b[1].tan);
      ranked.forEach(([u], i) => {
        p[Number(u)] *= calibFactor(i + 1);
      });
      const Zc = Object.values(p).reduce((a, b) => a + b, 0);
      for (const u of Object.keys(p)) p[u] /= Zc;
    }
    const { top2Pair, top3In, pairBoth3, top3Set, top3Exact } = harville(p);
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
    // 3連複(fetch-odds.mjs parseTrioの出力。キーは3頭を昇順ソート済み=top3Setのキーと同形式)
    for (const [key, odds] of Object.entries(race.trio ?? {})) {
      const prob = top3Set.get(key);
      if (prob != null && odds != null) findings.push(ctx("3連複", key, prob, odds));
    }
    // 3連単(parseTierceの出力。キーは着順どおり=top3Exactのキーと同形式)
    // ⚠️ 3連系は人気薄が絡む組み合わせが大半で、FLバイアス補正の有無がEVに最も効く券種。
    //    さらにHarville自体が人気薄の上位来訪を過大評価する既知バイアスも3頭分複利で効くので、
    //    ここのEV>1は複勝・馬連以上に保守的に見ること。
    for (const [key, odds] of Object.entries(race.tierce ?? {})) {
      const prob = top3Exact.get(key);
      if (prob != null && odds != null) findings.push(ctx("3連単", key, prob, odds));
    }
  }
}

// ---- レポート ----
console.log(`■ EVスキャン  スナップショット${snaps.length}件(${snaps.map((s) => `${s.date} ${s.track}[${s.label}]`).join(", ")})`);
console.log(
  RAW
    ? "  補正: なし(--raw。人気薄のEVはfavorite-longshot biasで過大表示される)"
    : `  補正: favorite-longshot bias実測補正あり(人気帯×${CALIB.map((c) => c.factor).join("/")}、出典pool-bias-check.mjs 8,453R)`,
);
if (thinSkipped > 0)
  console.log(
    `  ⚠️ 薄商い判定で${thinSkipped}/${scanned}レースを除外(複勝下限>単勝の逆転・馬連オッズの重複/欠落)。` +
      `プールに金が入る当日朝以降のスナップショットで再実行を推奨(--include-thinで強制表示)`,
  );
console.log(`  検査した買い目: ${findings.length}件  (EV=理論確率×実オッズ、1.0超=単勝市場基準で過小評価)`);

// プール別のEV分布(市場の整合性チェック)
for (const bet of ["複勝", "ワイド", "馬連", "3連複", "3連単"]) {
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
