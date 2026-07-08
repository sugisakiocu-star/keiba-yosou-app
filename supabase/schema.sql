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
