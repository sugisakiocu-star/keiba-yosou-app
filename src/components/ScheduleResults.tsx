"use client";

import { useState } from "react";
import type { RaceResult, Grade } from "@/lib/racing-data";
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

export function ScheduleResults({
  days,
  results,
  resultsAreSample = false,
}: {
  days: ScheduleDay[];
  results: RaceResult[];
  resultsAreSample?: boolean;
}) {
  const [tab, setTab] = useState<"schedule" | "results">("schedule");

  return (
    <>
      <div className="mb-8 flex">
        <button
          className={`ticket-tab ${tab === "schedule" ? "active" : ""}`}
          onClick={() => setTab("schedule")}
        >
          開催日程
        </button>
        <button
          className={`ticket-tab ${tab === "results" ? "active" : ""}`}
          onClick={() => setTab("results")}
        >
          先週の結果
        </button>
      </div>

      <h2 className="rail-heading font-display mb-6 text-2xl font-bold">
        {tab === "schedule" ? "今後の開催日程" : "先週の結果"}
        <span className="ml-3 text-sm font-normal" style={{ color: "var(--ink-soft)" }}>
          {tab === "schedule" ? "RACE CALENDAR" : "LAST WEEK RESULTS"}
        </span>
      </h2>

      {tab === "schedule" ? (
        <ScheduleSection days={days} />
      ) : (
        <ResultsSection results={results} isSample={resultsAreSample} />
      )}
    </>
  );
}
