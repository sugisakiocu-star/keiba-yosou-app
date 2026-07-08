// 競馬場のヒーロー背景(夕暮れの空・スタンド・照明塔・内ラチ・芝目・疾走する馬)。
// 純粋な SVG のみ。状態を持たないのでサーバーコンポーネントで描画できる。
export function RaceScene() {
  return (
    <svg
      viewBox="0 0 900 260"
      preserveAspectRatio="xMidYMax slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden
    >
      <defs>
        <linearGradient id="rs-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f3e6c2" />
          <stop offset="100%" stopColor="#e2c98f" />
        </linearGradient>
        <linearGradient id="rs-turf" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1d5c3a" />
          <stop offset="100%" stopColor="#0d2f1e" />
        </linearGradient>
      </defs>

      {/* 空 */}
      <rect x="0" y="0" width="900" height="96" fill="url(#rs-sky)" />

      {/* スタンド・照明塔 */}
      <g fill="#0d2f1e" opacity="0.5">
        <path d="M40,96 L40,66 L58,52 L210,52 L228,66 L228,96 Z" />
        <path d="M250,96 L250,58 L270,44 L470,44 L490,58 L490,96 Z" />
        <path d="M512,96 L512,64 L528,52 L640,52 L654,64 L654,96 Z" />
        <rect x="700" y="30" width="4" height="66" />
        <rect x="690" y="24" width="24" height="10" rx="2" />
        <rect x="820" y="38" width="4" height="58" />
        <rect x="810" y="32" width="24" height="10" rx="2" />
      </g>

      {/* 内ラチ(白レール) */}
      <line x1="0" y1="104" x2="900" y2="104" stroke="#f6f1e3" strokeWidth="4" />
      <g fill="#f6f1e3">
        {Array.from({ length: 23 }).map((_, i) => (
          <rect key={i} x={i * 40 + 8} y="104" width="4" height="12" />
        ))}
      </g>

      {/* ターフ + 芝目ストライプ */}
      <rect x="0" y="96" width="900" height="164" fill="url(#rs-turf)" />
      <g opacity="0.35">
        {Array.from({ length: 12 }).map((_, i) => (
          <polygon
            key={i}
            points={`${i * 80 - 20},96 ${i * 80 + 20},96 ${i * 80 + 60},260 ${i * 80 - 60},260`}
            fill={i % 2 === 0 ? "#1d5c3a" : "transparent"}
          />
        ))}
      </g>

      {/* 疾走する馬 + 騎手(金のシルエット) */}
      <g transform="translate(590,110) scale(1.15)" fill="#c9a227" stroke="#c9a227">
        <path d="M74,54 C58,42 46,44 34,56" fill="none" strokeWidth="7" strokeLinecap="round" />
        <path d="M74,60 C60,54 48,58 40,68" fill="none" strokeWidth="4" strokeLinecap="round" />
        <ellipse cx="118" cy="64" rx="46" ry="19" transform="rotate(-4 118 64)" strokeWidth="0" />
        <polygon points="146,52 170,28 184,36 160,64" strokeWidth="0" />
        <polygon points="168,26 190,32 202,44 194,50 174,42 164,36" strokeWidth="0" />
        <polygon points="170,27 175,14 180,26" strokeWidth="0" />
        <path d="M150,72 Q174,80 192,78 Q202,77 210,86" fill="none" strokeWidth="8" strokeLinecap="round" />
        <path d="M142,78 Q160,92 178,97" fill="none" strokeWidth="6" strokeLinecap="round" />
        <path d="M92,76 Q72,86 56,84 Q46,83 38,92" fill="none" strokeWidth="8" strokeLinecap="round" />
        <path d="M100,80 Q88,96 70,102" fill="none" strokeWidth="6" strokeLinecap="round" />
        <path d="M102,46 C110,28 132,24 146,36" fill="none" strokeWidth="10" strokeLinecap="round" />
        <circle cx="148" cy="30" r="8" strokeWidth="0" />
        <path d="M136,42 Q150,46 160,50" fill="none" strokeWidth="5" strokeLinecap="round" />
      </g>
    </svg>
  );
}
