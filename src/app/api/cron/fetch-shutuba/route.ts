import { NextResponse } from "next/server";
import {
  fetchRaceCard,
  fetchUpcomingGradedCards,
  fetchAllRacesForDay,
  type RaceCard,
  type Horse,
} from "@/lib/scrape/jra-shutuba";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// 使い方:
//  - パラメータ無し(cron): 出馬表インデックスの「今後の重賞」を全て自動取得して upsert する。
//  - ?date=&track=&race=: 指定した1レースだけ取得(手動/デバッグ用)。例 ?date=2026-07-12&track=福島&race=七夕賞
//  - ?date=&track=&full=1: 指定した開催日・競馬場の「全レース」(条件戦込み)を一括取得(手動一括用)。
//    レース間は1.5秒間隔。例 ?date=2026-07-11&track=福島&full=1
// 枠順(馬番)は開催前日の朝に確定(土曜開催→金10時, 日曜開催→土10時)。それ以前は枠/馬番が空(null)で、確定後の再実行で埋まる。

// 1レース分(races 1行 + horses N行 + 過去4走)を upsert する。書き込んだ件数を返す。
async function upsertCard(
  supabase: SupabaseClient,
  race: RaceCard,
  horses: Horse[],
): Promise<{ horsesWritten: number; pastRunsWritten: number; pastRunsNote?: string } | { error: string }> {
  const raceBase = {
    date: race.date,
    track: race.track,
    race_no: race.raceNo,
    name: race.name,
    grade: race.grade,
    cname: race.cname,
  };
  let { data: raceRow, error: raceErr } = await supabase
    .from("races")
    .upsert(
      { ...raceBase, distance: race.distance, surface: race.surface },
      { onConflict: "date,track,race_no" },
    )
    .select("id")
    .single();
  // distance/surface 列が未適用(schema.sql の4Aセクション実行前)のDBでは旧カラム構成で書く。
  if (raceErr?.message.includes("column")) {
    ({ data: raceRow, error: raceErr } = await supabase
      .from("races")
      .upsert(raceBase, { onConflict: "date,track,race_no" })
      .select("id")
      .single());
  }
  if (raceErr || !raceRow) return { error: raceErr?.message ?? "races upsert failed" };

  if (horses.length === 0) return { horsesWritten: 0, pastRunsWritten: 0 };
  const rows = horses.map((h) => ({
    race_id: raceRow.id,
    waku: h.waku,
    umaban: h.umaban,
    name: h.name,
    sex_age: h.sexAge,
    weight_carry: h.weightCarry,
    jockey: h.jockey,
    trainer: h.trainer,
  }));
  const { data: horseRows, error: horseErr } = await supabase
    .from("horses")
    .upsert(rows, { onConflict: "race_id,name" })
    .select("id, name");
  if (horseErr) return { error: horseErr.message };

  // 過去4走(フェーズ4A)。horses のIDに紐付けて upsert。
  const idByName = new Map((horseRows ?? []).map((r) => [r.name as string, r.id as number]));
  const pastRows = horses.flatMap((h) => {
    const horseId = idByName.get(h.name);
    if (horseId == null) return [];
    return h.past.map((p, i) => ({
      horse_id: horseId,
      run_no: i + 1,
      date: p.date,
      track: p.track,
      race_name: p.raceName,
      grade: p.grade,
      place: p.place,
      place_text: p.placeText,
      field_size: p.fieldSize,
      umaban: p.umaban,
      popularity: p.popularity,
      jockey: p.jockey,
      weight_carry: p.weightCarry,
      distance: p.distance,
      surface: p.surface,
      time: p.time,
      going: p.going,
      rating: p.rating,
      horse_weight: p.horseWeight,
      corners: p.corners,
      last3f: p.last3f,
      fin_horse: p.finHorse,
      fin_diff: p.finDiff,
    }));
  });
  if (pastRows.length === 0) return { horsesWritten: rows.length, pastRunsWritten: 0 };
  const { error: pastErr } = await supabase
    .from("horse_past_runs")
    .upsert(pastRows, { onConflict: "horse_id,run_no" });
  if (pastErr) {
    // テーブル未適用(schema.sql の4AセクションをSQL Editorで実行前)でも出馬表本体は成功扱いにする。
    return { horsesWritten: rows.length, pastRunsWritten: 0, pastRunsNote: pastErr.message };
  }
  return { horsesWritten: rows.length, pastRunsWritten: pastRows.length };
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date");
  const race = searchParams.get("race");
  const track = searchParams.get("track");
  const full = searchParams.get("full");

  // ---- 全レースモード(?date & ?track & ?full=1 指定): 条件戦込みで開催日1日分を一括取得 ----
  if (date && track && full) {
    let result;
    try {
      result = await fetchAllRacesForDay(date, track);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e), date, track },
        { status: 502 },
      );
    }
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({
        mode: "full-day",
        date,
        track,
        debug: result.debug,
        found: result.cards.length,
        written: 0,
        note: "SUPABASE_SERVICE_ROLE_KEY 未設定のため書き込みをスキップしました",
      });
    }
    const written: { race: string; horses: number; pastRuns: number; note?: string }[] = [];
    const errors: { race: string; error: string }[] = [];
    for (const card of result.cards) {
      const label = `${card.race.date} ${card.race.track}${card.race.raceNo}R ${card.race.name}`;
      const w = await upsertCard(supabase, card.race, card.horses);
      if ("error" in w) errors.push({ race: label, error: w.error });
      else
        written.push({
          race: label,
          horses: w.horsesWritten,
          pastRuns: w.pastRunsWritten,
          ...(w.pastRunsNote ? { note: w.pastRunsNote } : {}),
        });
    }
    return NextResponse.json({ mode: "full-day", date, track, debug: result.debug, written, errors });
  }

  // ---- 単レースモード(?date & ?race 指定) ----
  if (date && race) {
    const target = {
      date,
      track: searchParams.get("track") ?? "",
      raceName: race,
      grade: searchParams.get("grade"),
    };
    let result;
    try {
      result = await fetchRaceCard(target);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e), target },
        { status: 502 },
      );
    }
    if (!result.found || !result.race) {
      return NextResponse.json({
        target,
        found: false,
        note: "出馬表が未公開か、目的レースが見つかりませんでした",
        debug: result.debug,
      });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({
        target,
        found: true,
        written: 0,
        race: result.race,
        horses: result.horses.length,
        note: "SUPABASE_SERVICE_ROLE_KEY 未設定のため書き込みをスキップしました",
      });
    }
    const w = await upsertCard(supabase, result.race, result.horses);
    if ("error" in w) return NextResponse.json({ error: w.error, target }, { status: 500 });
    return NextResponse.json({
      mode: "single",
      race: result.race,
      horsesWritten: w.horsesWritten,
      pastRunsWritten: w.pastRunsWritten,
      ...(w.pastRunsNote ? { pastRunsNote: w.pastRunsNote } : {}),
    });
  }

  // ---- cronモード(パラメータ無し): 今後の重賞を全取得 ----
  let discovered;
  try {
    discovered = await fetchUpcomingGradedCards();
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({
      mode: "cron",
      found: discovered.cards.length,
      written: 0,
      note: "SUPABASE_SERVICE_ROLE_KEY 未設定のため書き込みをスキップしました",
      races: discovered.cards.map((c) => `${c.race.date} ${c.race.track}${c.race.raceNo}R ${c.race.name}`),
    });
  }

  const written: { race: string; horses: number; pastRuns: number; note?: string }[] = [];
  const errors: { race: string; error: string }[] = [];
  for (const card of discovered.cards) {
    const label = `${card.race.date} ${card.race.track}${card.race.raceNo}R ${card.race.name}`;
    const w = await upsertCard(supabase, card.race, card.horses);
    if ("error" in w) errors.push({ race: label, error: w.error });
    else
      written.push({
        race: label,
        horses: w.horsesWritten,
        pastRuns: w.pastRunsWritten,
        ...(w.pastRunsNote ? { note: w.pastRunsNote } : {}),
      });
  }

  return NextResponse.json({
    mode: "cron",
    discovered: discovered.debug,
    written,
    errors,
  });
}
