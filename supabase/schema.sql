-- JRA開催日程キャッシュ。/api/cron/fetch-schedule が月1で upsert する。
create table race_days (
  id         bigint generated always as identity primary key,
  date       date not null,               -- 開催日 (YYYY-MM-DD)
  track      text not null,               -- 競馬場名 (例: 福島, 小倉, 函館)
  kai        int,                          -- 開催回 (例: 2回 → 2)。取得できなければ null
  nichi      int,                          -- 開催何日目。現ソースには無いため基本 null
  fetched_at timestamptz default now(),   -- このレコードを取得した時刻
  unique (date, track)                     -- 同一日・同一競馬場は1行に集約 (upsert のキー)
);

-- 出馬表(1レース)。/api/cron/fetch-shutuba がクロールして upsert する。
create table races (
  id         bigint generated always as identity primary key,
  date       date not null,               -- 開催日 (YYYY-MM-DD)
  track      text not null,               -- 競馬場名 (例: 福島)
  race_no    int,                          -- 何レース目 (例: 11)。取得できるまで null
  name       text,                         -- レース名 (例: 七夕賞)
  grade      text,                         -- G1/G2/G3。無ければ null
  distance   int,                          -- 距離(メートル)。出馬表ヘッダから(フェーズ4A)
  surface    text,                         -- 芝/ダート/障(フェーズ4A)
  cname      text,                         -- 出馬表の pw01ses コード (再取得・デバッグ用)
  fetched_at timestamptz default now(),
  unique (date, track, race_no)            -- 同一開催日・場・R は1行 (upsert のキー)
);

-- 出走馬 (1頭 = 1行)。races に紐づく。
create table horses (
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
  -- 枠順は開催前々日(金曜)に確定するため、確定前は umaban が null。
  -- upsert キーは常に一意な馬名にする(枠順確定後の再取得で waku/umaban を更新)。
  unique (race_id, name)                   -- 同一レース内の同一馬は1行 (upsert のキー)
);

-- RLS: anon は読み取りのみ。書き込みは service_role(RLSバイパス)のバッチ/cronだけ。
alter table races  enable row level security;
alter table horses enable row level security;
create policy "races anon read"  on races  for select to anon using (true);
create policy "horses anon read" on horses for select to anon using (true);

-- ============================================================================
-- フェーズ3: 過去レース結果(成績)。scripts/backfill-graded-results.mjs が
-- JRA公式「過去レース結果検索」をクロールして upsert する(当面は重賞のみ)。
-- ============================================================================

-- レース結果(1レース = 1行)。
-- ⚠️ unique制約はフェーズ4Eで (date, track, name) → (date, track, race_no) に変更済み。
--   条件戦は同日同場に同名レース(例: 同じ「3歳未勝利」)が複数走るため、レース名では一意にならない。
--   適用済みのDBには supabase/migration-phase4e.sql を SQL Editor で実行する。
create table race_results (
  id         bigint generated always as identity primary key,
  date       date not null,               -- 開催日 (YYYY-MM-DD)
  track      text not null,               -- 競馬場名 (例: 函館)
  race_no    int,                          -- 何レース目 (例: 11)
  name       text not null,               -- レース名 (例: 七夕賞)
  grade      text,                         -- G1/G2/G3。無ければ null
  surface    text,                         -- 芝/ダート/障
  distance   int,                          -- 距離(メートル)
  going      text,                         -- 馬場状態 (良/稍重/重/不良)
  weather    text,                         -- 天候 (晴/曇/雨 など)
  cname      text,                         -- 結果ページの pw01sde コード (再取得・デバッグ用)
  fetched_at timestamptz default now(),
  unique (date, track, race_no)            -- 同一開催日・場・R は1行 (upsert のキー)
);

-- 着順(1頭 = 1行)。race_results に紐づく。
create table result_horses (
  id                bigint generated always as identity primary key,
  result_id         bigint not null references race_results(id) on delete cascade,
  place             int,                   -- 着順。中止/除外/失格などは null
  place_text        text,                  -- 生の着順表記 (中, 除, 失 など)
  waku              int,                   -- 枠番
  umaban            int,                   -- 馬番
  name              text not null,         -- 馬名
  sex_age           text,                  -- 性齢 (例: 牡3)
  weight_carry      numeric,               -- 斤量
  jockey            text,                  -- 騎手
  time              text,                  -- タイム (例: 1:45.5)
  margin            text,                  -- 着差
  last3f            numeric,               -- 推定上り (上がり3F)
  horse_weight      int,                   -- 馬体重
  horse_weight_diff int,                   -- 馬体重増減
  trainer           text,                  -- 調教師
  popularity        int,                   -- 人気
  fetched_at        timestamptz default now(),
  unique (result_id, umaban)               -- 同一レース内の同一馬番は1行 (upsert のキー)
);

-- RLS: anon は読み取りのみ。書き込みは service_role(RLSバイパス)のバッチだけ。
alter table race_results  enable row level security;
alter table result_horses enable row level security;

create policy "race_results anon read"  on race_results  for select to anon using (true);
create policy "result_horses anon read" on result_horses for select to anon using (true);

-- ============================================================================
-- フェーズ4A: 出馬表に埋まっている「過去4走」+ レースの距離/コース。
-- /api/cron/fetch-shutuba が出馬表と同時に upsert する(追加リクエストゼロ)。
--
-- ⚠️ 適用済みのDBには、以下の「4A適用SQL」だけを SQL Editor で実行する:
--   alter table races add column if not exists distance int;
--   alter table races add column if not exists surface  text;
--   + 下の create table horse_past_runs 〜 create policy まで
-- ============================================================================

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
