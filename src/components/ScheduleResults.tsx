"use client";

import { useState } from "react";
import type { RaceResult, RaceCard, Grade } from "@/lib/racing-data";
import { WAKU_COLORS } from "@/lib/racing-data";
import type { RacePrediction } from "@/lib/predict";
import { GradeBadge, Umaban } from "@/components/racing-bits";

export interface ScheduleDay {
  date: string;
  dayLabel: string;
  weekday: string;
  tracks: { name: string; kai: string; nichime: string }[];
  gradeRaces: { name: string; grade: Grade; track: string }[];
}

function ScheduleSection({ days }: { days: ScheduleDay[] }) {
  if (days.length === 0) {
    return (
      <p className="rounded border border-[var(--turf)] bg-white/70 px-5 py-6 text-sm text-[var(--ink-soft)]">
        日程データがまだありません(月1回の自動取得で更新されます)
      </p>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {days.map((day) => (
        <div
          key={day.date}
          className="result-card border bg-white/70"
          style={{ borderColor: "var(--turf)", borderWidth: 1.5 }}
        >
          <div
            className="flex items-baseline gap-2 px-4 py-2"
            style={{ background: "var(--turf)", color: "var(--paper)" }}
          >
            <span className="font-display text-2xl font-bold">{day.dayLabel}</span>
            <span
              className="text-sm font-bold"
              style={{
                color:
                  day.weekday === "日"
                    ? "#f2a0a0"
                    : day.weekday === "土"
                      ? "#9fc3f0"
                      : undefined,
              }}
            >
              ({day.weekday})
            </span>
            {day.gradeRaces.map((g) => (
              <span key={g.name} className="ml-auto flex items-center gap-1 text-xs">
                <GradeBadge grade={g.grade} />
                <span className="font-bold">{g.name}</span>
              </span>
            ))}
          </div>
          <ul className="space-y-1.5 px-4 py-3">
            {day.tracks.map((t) => (
              <li key={t.name} className="flex items-center gap-3 text-sm">
                <span
                  className="w-14 py-0.5 text-center font-bold"
                  style={{ background: "var(--paper-dark)", border: "1px solid var(--dirt)" }}
                >
                  {t.name}
                </span>
                <span style={{ color: "var(--ink-soft)" }}>
                  {[t.kai, t.nichime].filter(Boolean).join(" ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ResultCard({ r }: { r: RaceResult }) {
  return (
    <div
      className="result-card border bg-white/70"
      style={{ borderColor: "var(--turf)", borderWidth: 1.5 }}
    >
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5"
        style={{ borderColor: "var(--paper-dark)" }}
      >
        {r.grade && <GradeBadge grade={r.grade} />}
        <span className="font-display text-lg font-bold">{r.name}</span>
        <span className="text-xs font-bold" style={{ color: "var(--ink-soft)" }}>
          {r.dayLabel} {r.track}
          {r.raceNo}R・{r.course}・{r.going}
        </span>
        <span className="font-display ml-auto text-sm italic" style={{ color: "var(--turf)" }}>
          {r.time}
        </span>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {r.top3.map((h) => (
            <tr
              key={h.pos}
              className="border-b last:border-b-0"
              style={{ borderColor: "var(--paper-dark)" }}
            >
              <td
                className="font-display w-12 py-2 pl-4 text-base font-bold"
                style={{ color: h.pos === 1 ? "var(--gold)" : "var(--ink-soft)" }}
              >
                {h.pos}着
              </td>
              <td className="w-10">
                <Umaban waku={h.waku} num={h.umaban} />
              </td>
              <td className="font-bold">{h.name}</td>
              <td className="pr-3 text-right" style={{ color: "var(--ink-soft)" }}>
                {h.jockey}
              </td>
              <td className="w-20 pr-4 text-right text-xs" style={{ color: "var(--ink-soft)" }}>
                {h.pop}番人気
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-4 px-4 py-2 text-xs" style={{ background: "var(--paper-dark)" }}>
        {r.payoutWin && (
          <span>
            単勝{" "}
            <b className="font-display text-sm" style={{ color: "var(--turf)" }}>
              {r.payoutWin}
            </b>
          </span>
        )}
        <span className="ml-auto" style={{ color: "var(--ink-soft)" }}>
          {r.date}
        </span>
      </div>
    </div>
  );
}

// 枠/馬番チップ。枠順未確定(番号 null)なら灰色の「-」を出す。
function EntryUmaban({ waku, num }: { waku: number | null; num: number | null }) {
  if (num == null || waku == null) {
    return (
      <span
        className="umaban"
        style={{ background: "#e5e0d2", color: "#8a8266", border: "1px solid var(--dirt)" }}
      >
        –
      </span>
    );
  }
  const c = WAKU_COLORS[waku] ?? { bg: "#ddd", fg: "#1a1a1a" };
  return (
    <span
      className="umaban"
      style={{
        background: c.bg,
        color: c.fg,
        border: c.border ? `1px solid ${c.border}` : "1px solid transparent",
      }}
    >
      {num}
    </span>
  );
}

function EntryCard({ r }: { r: RaceCard }) {
  return (
    <div
      className="result-card border bg-white/70"
      style={{ borderColor: "var(--turf)", borderWidth: 1.5 }}
    >
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5"
        style={{ borderColor: "var(--paper-dark)" }}
      >
        {r.grade && <GradeBadge grade={r.grade} />}
        <span className="font-display text-lg font-bold">{r.name}</span>
        <span className="text-xs font-bold" style={{ color: "var(--ink-soft)" }}>
          {r.dayLabel} {r.track}
          {r.raceNo}R{r.course ? `・${r.course}` : ""}
        </span>
        <span className="ml-auto text-xs" style={{ color: "var(--ink-soft)" }}>
          {r.horses.length}頭
        </span>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {r.horses.map((h) => (
            <tr
              key={h.name}
              className="border-b last:border-b-0"
              style={{ borderColor: "var(--paper-dark)" }}
            >
              <td className="w-10 py-2 pl-4">
                <EntryUmaban waku={h.waku} num={h.umaban} />
              </td>
              <td className="font-bold">{h.name}</td>
              <td className="w-12 text-center text-xs" style={{ color: "var(--ink-soft)" }}>
                {h.sexAge}
              </td>
              <td className="font-display w-14 text-right text-sm" style={{ color: "var(--turf)" }}>
                {h.weightCarry != null ? h.weightCarry.toFixed(1) : ""}
              </td>
              <td className="pr-3 text-right" style={{ color: "var(--ink-soft)" }}>
                {h.jockey}
              </td>
              <td className="w-24 pr-4 text-right text-xs" style={{ color: "var(--ink-soft)" }}>
                {h.trainer}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        className="px-4 py-2 text-xs"
        style={{ background: "var(--paper-dark)", color: "var(--ink-soft)" }}
      >
        {r.gateConfirmed ? "枠順確定・馬番順" : "枠順は前々日(金)に確定します。現在は50音順・枠/馬番は未定"}
      </div>
    </div>
  );
}

function EntriesSection({ raceCards }: { raceCards: RaceCard[] }) {
  if (raceCards.length === 0) {
    return (
      <p className="rounded border border-[var(--turf)] bg-white/70 px-5 py-6 text-sm text-[var(--ink-soft)]">
        出馬表データがまだありません(重賞の出馬表公開後に取得されます)
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {raceCards.map((r) => (
        <EntryCard key={r.id} r={r} />
      ))}
      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
        ※ 出馬表。データ出典:JRA公式。枠順確定後に枠番・馬番が反映されます。
      </p>
    </div>
  );
}

function PredictionCard({ p }: { p: RacePrediction }) {
  return (
    <div
      className="result-card border bg-white/70"
      style={{ borderColor: "var(--turf)", borderWidth: 1.5 }}
    >
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5"
        style={{ borderColor: "var(--paper-dark)" }}
      >
        {p.grade && <GradeBadge grade={p.grade} />}
        <span className="font-display text-lg font-bold">{p.raceName}</span>
        <span className="text-xs font-bold" style={{ color: "var(--ink-soft)" }}>
          {p.dayLabel} {p.track}
          {p.raceNo}R
        </span>
        <span className="ml-auto text-xs" style={{ color: "var(--ink-soft)" }}>
          簡易スコア順
        </span>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {p.horses.map((h) => (
            <tr
              key={h.name}
              className="border-b last:border-b-0"
              style={{ borderColor: "var(--paper-dark)" }}
            >
              <td
                className="font-display w-10 py-2 pl-4 text-center text-lg font-bold"
                style={{ color: h.mark === "◎" ? "var(--gold)" : "var(--ink)" }}
              >
                {h.mark ?? ""}
              </td>
              <td className="py-2">
                <div className="font-bold">{h.name}</div>
                <div className="mt-1 flex items-center gap-2">
                  <div
                    className="h-1.5 overflow-hidden rounded-full"
                    style={{ background: "var(--paper-dark)", width: 120 }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{ background: "var(--turf)", width: `${h.barPct}%` }}
                    />
                  </div>
                  <span className="font-display text-xs" style={{ color: "var(--turf)" }}>
                    {h.total.toFixed(1)}
                  </span>
                </div>
              </td>
              <td
                className="hidden max-w-40 pr-2 text-right text-xs sm:table-cell"
                style={{ color: "var(--ink-soft)" }}
              >
                {h.runsLabel}
              </td>
              <td className="w-40 pr-4 text-right text-xs" style={{ color: "var(--ink-soft)" }}>
                <div>{h.jockey}</div>
                <div>
                  {h.jockeyRate != null ? `重賞複勝率${Math.round(h.jockeyRate * 100)}%` : "騎手データ少"}
                  {h.weightCarry != null ? ` / ${h.weightCarry.toFixed(1)}kg` : ""}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        className="px-4 py-2 text-xs"
        style={{ background: "var(--paper-dark)", color: "var(--ink-soft)" }}
      >
        スコア = 過去1年の重賞実績(グレード・直近・中距離適性で重み付け)+ 騎手の重賞複勝率 + 斤量差
      </div>
    </div>
  );
}

function PredictionsSection({ predictions }: { predictions: RacePrediction[] }) {
  if (predictions.length === 0) {
    return (
      <p className="rounded border border-[var(--turf)] bg-white/70 px-5 py-6 text-sm text-[var(--ink-soft)]">
        予想データがまだありません(出馬表の取得後に自動で採点されます)
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {predictions.map((p) => (
        <PredictionCard key={p.raceId} p={p} />
      ))}
      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
        ※ 過去1年の重賞結果のみを材料にした簡易スコアです。精度は未検証・的中を保証するものではありません。馬券の購入は自己責任で。
      </p>
    </div>
  );
}

function ResultsSection({
  results,
  isSample,
}: {
  results: RaceResult[];
  isSample: boolean;
}) {
  if (results.length === 0) {
    return (
      <p className="rounded border border-[var(--turf)] bg-white/70 px-5 py-6 text-sm text-[var(--ink-soft)]">
        結果データがまだありません
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {results.map((r) => (
        <ResultCard key={r.id} r={r} />
      ))}
      {isSample ? (
        <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
          ※ 馬名・結果はデザイン確認用のサンプルです。結果データ取得後に JRA 公式の実データへ差し替わります。
        </p>
      ) : (
        <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
          ※ 直近の重賞レース結果。データ出典:JRA公式。単勝払戻は今後の対応で追加予定です。
        </p>
      )}
    </div>
  );
}

type TabKey = "schedule" | "entries" | "predictions" | "results";

const TAB_HEADINGS: Record<TabKey, [string, string]> = {
  schedule: ["今後の開催日程", "RACE CALENDAR"],
  entries: ["今週の出馬表", "RACE CARD"],
  predictions: ["今週の予想", "PREDICTIONS"],
  results: ["先週の結果", "LAST WEEK RESULTS"],
};

const TAB_LABELS: Record<TabKey, string> = {
  schedule: "開催日程",
  entries: "出馬表",
  predictions: "予想",
  results: "先週の結果",
};

export function ScheduleResults({
  days,
  results,
  resultsAreSample = false,
  raceCards = [],
  predictions = [],
}: {
  days: ScheduleDay[];
  results: RaceResult[];
  resultsAreSample?: boolean;
  raceCards?: RaceCard[];
  predictions?: RacePrediction[];
}) {
  const [tab, setTab] = useState<TabKey>("schedule");
  const [heading, subheading] = TAB_HEADINGS[tab];

  return (
    <>
      <div className="mb-8 flex">
        {(Object.keys(TAB_LABELS) as TabKey[]).map((key) => (
          <button
            key={key}
            className={`ticket-tab ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            {TAB_LABELS[key]}
          </button>
        ))}
      </div>

      <h2 className="rail-heading font-display mb-6 text-2xl font-bold">
        {heading}
        <span className="ml-3 text-sm font-normal" style={{ color: "var(--ink-soft)" }}>
          {subheading}
        </span>
      </h2>

      {tab === "schedule" && <ScheduleSection days={days} />}
      {tab === "entries" && <EntriesSection raceCards={raceCards} />}
      {tab === "predictions" && <PredictionsSection predictions={predictions} />}
      {tab === "results" && <ResultsSection results={results} isSample={resultsAreSample} />}
    </>
  );
}
