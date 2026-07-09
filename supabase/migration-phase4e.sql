-- フェーズ4E 適用SQL(適用済みDB向けの差分)。Supabase SQL Editor にこのまま貼って実行する。
-- 内容: race_results のunique制約を (date, track, name) → (date, track, race_no) に変更。
-- 背景: 重賞に限らずOP/リステッド/条件戦まで結果を取得すると、同日同場に同名レース
--   (例: 同じ「3歳未勝利」が1日に複数レース)が複数走るため、レース名では一意にならない。
--   race_no ならレースを一意に特定できるため、こちらをupsertキーにする。
-- ※ schema.sql(全体定義)にも同じ内容を反映済み。新規DBなら schema.sql だけでよい。
-- 適用前提: 既存データに (date, track, race_no) の重複が無いこと(2026-07-10時点で確認済み・418件重複ゼロ)。

alter table race_results drop constraint race_results_date_track_name_key;
alter table race_results add constraint race_results_date_track_race_no_key unique (date, track, race_no);
