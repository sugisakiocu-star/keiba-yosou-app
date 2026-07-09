-- フェーズ2「出馬表」テーブル。Supabase SQL Editor で一度だけ実行する。
-- (service_role キーでは DDL を実行できないため手動適用が必要。race_days / race_results と同じ運用)
-- schema.sql の races / horses 部分と同一。既存テーブルには触れない。

-- 出馬表(1レース = 1行)。/api/cron/fetch-shutuba がクロールして upsert する。
create table if not exists races (
  id         bigint generated always as identity primary key,
  date       date not null,               -- 開催日 (YYYY-MM-DD)
  track      text not null,               -- 競馬場名 (例: 福島)
  race_no    int,                          -- 何レース目 (例: 11)
  name       text,                         -- レース名 (例: 七夕賞)
  grade      text,                         -- G1/G2/G3。無ければ null
  cname      text,                         -- 出馬表の pw01dde コード (再取得・デバッグ用)
  fetched_at timestamptz default now(),
  unique (date, track, race_no)            -- 同一開催日・場・R は1行 (upsert のキー)
);

-- 出走馬 (1頭 = 1行)。races に紐づく。
create table if not exists horses (
  id           bigint generated always as identity primary key,
  race_id      bigint not null references races(id) on delete cascade,
  waku         int,                        -- 枠番(枠順確定前は null)
  umaban       int,                        -- 馬番(枠順確定前は null)
  name         text not null,              -- 馬名
  sex_age      text,                       -- 性齢 (例: 牡4)
  weight_carry numeric,                    -- 斤量
  jockey       text,                       -- 騎手
  trainer      text,                       -- 調教師
  fetched_at   timestamptz default now(),
  unique (race_id, name)                   -- 枠順未確定でも一意になる馬名をキーにする
);

alter table races  enable row level security;
alter table horses enable row level security;
create policy "races anon read"  on races  for select to anon using (true);
create policy "horses anon read" on horses for select to anon using (true);
