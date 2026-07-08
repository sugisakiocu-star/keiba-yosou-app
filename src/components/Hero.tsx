import type { FeatureRace } from "@/lib/racing-data";
import { RaceScene } from "@/components/RaceScene";
import { GradeBadge } from "@/components/racing-bits";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function jstDate(iso: string): Date {
  return new Date(`${iso}T00:00:00+09:00`);
}

function daysUntil(iso: string): number {
  const diff = jstDate(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86_400_000));
}

function dayLabel(iso: string): string {
  const d = jstDate(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
}

// featured が無い(先の重賞メタが尽きた)場合は簡易ヘッダーだけ出す
export function Hero({ featured }: { featured: FeatureRace | null }) {
  if (!featured) {
    return (
      <section
        className="relative overflow-hidden"
        style={{ background: "var(--turf-deep)" }}
      >
        <RaceScene />
        <div className="relative mx-auto max-w-5xl px-5 py-10 sm:px-8">
          <h1
            className="font-display text-4xl font-bold"
            style={{ color: "#f6f1e3", textShadow: "0 2px 0 rgba(0,0,0,.35)" }}
          >
            今週の開催
          </h1>
        </div>
      </section>
    );
  }

  const d = daysUntil(featured.date);

  return (
    <section className="relative overflow-hidden" style={{ background: "var(--turf-deep)" }}>
      <RaceScene />
      <div className="relative mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
        <p
          className="font-display mb-2 text-sm italic tracking-[0.25em]"
          style={{ color: "var(--gold-bright)" }}
        >
          NEXT RACE
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <h1
            className="font-display text-5xl leading-none font-bold sm:text-6xl"
            style={{ color: "#f6f1e3", textShadow: "0 2px 0 rgba(0,0,0,.35)" }}
          >
            {featured.name}
          </h1>
          <GradeBadge grade={featured.grade} size="lg" />
        </div>
        <p
          className="mt-3 text-sm font-bold"
          style={{ color: "#efe8d2", textShadow: "0 1px 0 rgba(0,0,0,.4)" }}
        >
          {featured.note}
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2 text-sm font-bold">
          {[
            dayLabel(featured.date),
            `${featured.track} ${featured.raceNo}R`,
            featured.course,
          ].map((t) => (
            <span
              key={t}
              className="px-3 py-1"
              style={{
                background: "rgba(246,241,227,.92)",
                color: "var(--turf-deep)",
                boxShadow: "2px 2px 0 rgba(0,0,0,.3)",
              }}
            >
              {t}
            </span>
          ))}
          <span
            className="font-display px-3 py-1 italic"
            style={{
              background: "var(--gold)",
              color: "#241f18",
              boxShadow: "2px 2px 0 rgba(0,0,0,.3)",
            }}
          >
            {d === 0 ? "本日発走!" : `発走まで あと ${d} 日`}
          </span>
        </div>
        <p className="mt-6 text-xs" style={{ color: "#cfc7ae" }}>
          出馬表は公開後に自動取得予定
        </p>
      </div>
    </section>
  );
}
