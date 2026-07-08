import { WAKU_COLORS, GRADE_COLORS } from "@/lib/racing-data";

// グレード章(G1青/G2赤/G3緑・斜めカット)
export function GradeBadge({
  grade,
  size = "md",
}: {
  grade: string;
  size?: "md" | "lg";
}) {
  return (
    <span
      className="grade-badge"
      style={{
        background: GRADE_COLORS[grade] ?? "#5a5344",
        fontSize: size === "lg" ? 18 : 12,
        padding: size === "lg" ? "2px 14px 3px 10px" : undefined,
      }}
    >
      {grade}
    </span>
  );
}

// 馬番チップ(枠番カラー)
export function Umaban({ waku, num }: { waku: number; num: number }) {
  const c = WAKU_COLORS[waku] ?? { bg: "#ddd", fg: "#1a1a1a" };
  return (
    <span
      className="umaban"
      style={{
        background: c.bg,
        color: c.fg,
        border: c.border ? `1px solid ${c.border}` : "1px solid transparent",
      }}
    >
      {num}
    </span>
  );
}
