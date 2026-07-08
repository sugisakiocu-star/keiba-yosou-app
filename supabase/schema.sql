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
  cname      text,                         -- 出馬表の pw01ses コード (再取得・デバッグ用)
  fetched_at timestamptz default now(),
  unique (date, track, race_no)            -- 同一開催日・場・R は1行 (upsert のキー)
);

-- 出走馬 (1頭 = 1行)。races に紐づく。
create table horses (
  id           bigint generated always as identity primary key,
  race_id      bigint not null references races(id) on delete cascade,
  waku         int,                        -- 枠番
  umaban       int,                        -- 馬番
  name         text not null,              -- 馬名
  sex_age      text,                       -- 性齢 (例: 牡4)
  weight_carry numeric,                    -- 斤量
  jockey       text,                       -- 騎手
  trainer      text,                       -- 調教師
  fetched_at   timestamptz default now(),
  unique (race_id, umaban)                 -- 同一レース内の同一馬番は1行 (upsert のキー)
);
