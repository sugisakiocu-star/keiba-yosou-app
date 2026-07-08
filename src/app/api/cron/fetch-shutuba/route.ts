import { NextResponse } from "next/server";
import { fetchRaceCard } from "@/lib/scrape/jra-shutuba";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// 当面のターゲットは今週の七夕賞(2026-07-12・福島・G3)のみ。
// クエリで上書き可能: ?date=2026-07-12&track=福島&race=七夕賞&debug=1
const DEFAULT_TARGET = { date: "2026-07-12", track: "福島", raceName: "七夕賞", grade: "G3" };

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const target = {
    date: searchParams.get("date") ?? DEFAULT_TARGET.date,
    track: searchParams.get("track") ?? DEFAULT_TARGET.track,
    raceName: searchParams.get("race") ?? DEFAULT_TARGET.raceName,
    grade: searchParams.get("grade") ?? DEFAULT_TARGET.grade,
    withSample: searchParams.get("debug") === "1",
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

  // 出馬表が未公開(目的日がインデックスに出ていない/レースが見つからない)なら書き込まずに状況を返す。
  if (!result.found || !result.race) {
    return NextResponse.json({
      target,
      found: false,
      note: "出馬表が未公開か、目的レースが見つかりませんでした(公開は例年 木曜頃)",
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
      debug: result.debug,
    });
  }

  const { data: raceRow, error: raceErr } = await supabase
    .from("races")
    .upsert(
      {
        date: result.race.date,
        track: result.race.track,
        race_no: result.race.raceNo,
        name: result.race.name,
        grade: result.race.grade,
        cname: result.race.cname,
      },
      { onConflict: "date,track,race_no" },
    )
    .select("id")
    .single();
  if (raceErr) {
    return NextResponse.json({ error: raceErr.message, target }, { status: 500 });
  }

  let horsesWritten = 0;
  if (result.horses.length > 0) {
    const rows = result.horses.map((h) => ({
      race_id: raceRow.id,
      waku: h.waku,
      umaban: h.umaban,
      name: h.name,
      sex_age: h.sexAge,
      weight_carry: h.weightCarry,
      jockey: h.jockey,
      trainer: h.trainer,
    }));
    const { error: horseErr } = await supabase
      .from("horses")
      .upsert(rows, { onConflict: "race_id,umaban" });
    if (horseErr) {
      return NextResponse.json({ error: horseErr.message, target }, { status: 500 });
    }
    horsesWritten = rows.length;
  }

  return NextResponse.json({
    target,
    found: true,
    race: result.race,
    horsesWritten,
    debug: result.debug,
  });
}
