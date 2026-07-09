-- フェーズ4A 適用SQL(適用済みDB向けの差分)。Supabase SQL Editor にこのまま貼って実行する。
-- 内容: races に距離/コース列を追加 + 過去4走テーブル horse_past_runs を新設。
-- ※ schema.sql(全体定義)にも同じ内容を反映済み。新規DBなら schema.sql だけでよい。

alter table races add column if not exists distance int;  -- 距離(メートル)
alter table races add column if not exists surface  text; -- 芝/ダート/障

-- 過去走 (1頭の1走 = 1行)。horses に紐づく。run_no 1=前走 … 4=4走前。
create table horse_past_runs (
  id           bigint generated always as identity primary key,
  horse_id     bigint not null references horses(id) on delete cascade,
  run_no       int not null,               -- 1=前走 … 4=4走前
  date         date,                        -- そのレースの開催日
  track        text,                        -- 競馬場 (例: 中山)
  race_name    text,                        -- レース名 (例: 迎春S)
  grade        text,                        -- G1/G2/G3/J.G*。平場・リステッドは null
  place        int,                         -- 着順。中止/除外などは null
  place_text   text,                        -- 生の着順表記 (例: "10着", "中止")
  field_size   int,                         -- 頭数
  umaban       int,                         -- そのレースでの馬番
  popularity   int,                         -- 人気
  jockey       text,                        -- 騎手
  weight_carry numeric,                     -- 斤量
  distance     int,                         -- 距離(メートル)
  surface      text,                        -- 芝/ダート/障
  time         text,                        -- 走破タイム (例: "2:32.3")
  going        text,                        -- 馬場状態 (良/稍重/重/不良)
  rating       int,                         -- JRAレーティング
  horse_weight int,                         -- 馬体重
  corners      text,                        -- コーナー通過順 (例: "2-2-2-1")
  last3f       numeric,                     -- 上がり3F (例: 37.5)
  fin_horse    text,                        -- 勝ち馬(自身が1着なら2着馬)
  fin_diff     numeric,                     -- 着差(秒)
  fetched_at   timestamptz default now(),
  unique (horse_id, run_no)                 -- 再取得時は同じ枠を上書き (upsert のキー)
);

alter table horse_past_runs enable row level security;
create policy "horse_past_runs anon read" on horse_past_runs for select to anon using (true);
