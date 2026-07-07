import { mockRaces } from "@/lib/mock-data";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-zinc-50 py-10 px-4 font-sans dark:from-emerald-950/30 dark:to-black">
      <main className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="flex items-center gap-3 rounded-xl bg-gradient-to-r from-emerald-800 to-emerald-700 px-5 py-4 shadow-sm">
          <span className="text-3xl">🏇</span>
          <div>
            <h1 className="text-xl font-bold text-white">
              競馬予想アプリ
            </h1>
            <p className="text-xs text-emerald-100">
              レース一覧（ダミーデータ）
            </p>
          </div>
        </header>

        {mockRaces.map((race) => (
          <section
            key={race.id}
            className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="flex items-center justify-between gap-2 border-b-2 border-amber-400 bg-zinc-50 px-5 py-3 dark:bg-zinc-900/60">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                  {race.name}
                </h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {race.venue} / {race.date}
                </p>
              </div>
              <span className="text-2xl">🏆</span>
            </div>

            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="py-2 pr-2 pl-5 font-medium">馬番</th>
                  <th className="py-2 pr-2 font-medium">馬名</th>
                  <th className="py-2 pr-2 font-medium">オッズ</th>
                  <th className="py-2 pr-2 font-medium">人気</th>
                  <th className="py-2 pr-5 font-medium">予想</th>
                </tr>
              </thead>
              <tbody>
                {race.horses.map((horse) => (
                  <tr
                    key={horse.number}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
                  >
                    <td className="py-2 pr-2 pl-5 text-zinc-700 dark:text-zinc-300">
                      {horse.number}
                    </td>
                    <td className="py-2 pr-2 font-medium text-zinc-900 dark:text-zinc-50">
                      {horse.name}
                    </td>
                    <td className="py-2 pr-2 text-zinc-700 dark:text-zinc-300">
                      {horse.odds.toFixed(1)}
                    </td>
                    <td className="py-2 pr-2 text-zinc-700 dark:text-zinc-300">
                      {horse.popularity}
                    </td>
                    <td className="py-2 pr-5">
                      {horse.popularity === 1 && (
                        <div className="flex flex-col gap-0.5">
                          <span className="w-fit rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-300">
                            予想◎
                          </span>
                          {horse.reason && (
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              {horse.reason}
                            </span>
                          )}
                        </div>
                      )}
                      {horse.popularity === 2 && (
                        <div className="flex flex-col gap-0.5">
                          <span className="w-fit rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                            予想◯
                          </span>
                          {horse.reason && (
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              {horse.reason}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </main>
    </div>
  );
}
