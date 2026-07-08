import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// サーバー専用。service_role キーを使うため NEXT_PUBLIC_ を付けない env を参照する。
// 環境変数が無ければ null を返し、呼び出し側で書き込みをスキップできるようにする。
export function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}
