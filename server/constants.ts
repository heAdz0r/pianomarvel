// CHANGED (new file): единый источник правды по диапазонам/значениям формы
// Piano Marvel. Раньше 1–18 / 30–240 были «магическими числами», раскиданными
// по piano.ts и App.vue без валидации. Теперь и сервер, и клиент опираются на
// одни и те же границы.

export const DIFFICULTY = { min: 1, max: 18, default: 5 } as const;
export const TEMPO = { min: 30, max: 240 } as const;

export type AssessmentMode = "Learn & Play" | "Play Only" | "Learn Only";

/** Значения select `data[Piece][assessment_mode]` на форме. */
export const ASSESSMENT_MODE_VALUES: Record<AssessmentMode, string> = {
  "Learn & Play": "0",
  "Play Only": "1",
  "Learn Only": "2",
};

/** Ограничить число диапазоном [min, max]; вернуть undefined для не-числа. */
export function clamp(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}
