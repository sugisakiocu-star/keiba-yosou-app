# 競馬予想アプリ

個人開発の競馬予想Webアプリ（無料枠のみで完結する構成予定）。

技術スタック: Next.js（App Router）/ Vercel（Hobby）/ Supabase（Postgres, Free tier）。
詳細な運用ルール・エージェント構成は [CLAUDE.md](CLAUDE.md) を参照。

## 開発

```bash
npm install
npm run dev
```

[http://localhost:3000](http://localhost:3000) で確認できる。

Supabaseを使う場合は `.env.example` を `.env` にコピーし、値を埋める。
