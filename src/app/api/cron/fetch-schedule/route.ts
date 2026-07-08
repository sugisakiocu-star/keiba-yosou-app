import { NextResponse } from "next/server";
import { fetchRaceDays, type RaceDay } from "@/lib/scrape/jra-calendar";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

export async function GET(request: Request) {
  // Vercel Cron は Authorization: Bearer <CRON_SECRET> を付けて叩く。
  // CRON_SECRET 未設定なら照合しない（ローカル検証用）。
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const thisMonth = { year: now.getFullYear(), month: now.getMonth() + 1 };
  const targets = [thisMonth, nextMonth(thisMonth.year, thisMonth.month)];

  const raceDays: RaceDay[] = [];
  for (const t of targets) {
    raceDays.push(...(await fetchRaceDays(t.year, t.month)));
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({
      fetched: raceDays.length,
      written: 0,
      note: "SUPABASE_SERVICE_ROLE_KEY 未設定のため書き込みをスキップしました",
    });
  }

  const { error } = await supabase
    .from("race_days")
    .upsert(raceDays, { onConflict: "date,track" });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ fetched: raceDays.length, written: raceDays.length });
}
