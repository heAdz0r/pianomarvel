// Genre name -> Piano Marvel <select> option value, captured from the live
// "New Song" form at https://pianomarvel.com/uploads/editSong/ on 2026-07-19.
// If Piano Marvel adds/renames genres this map will need a refresh — run
// `bun run server/login.ts --dump-genres` to re-scrape it.
export const GENRES: Record<string, number> = {
  Classical: 1,
  Holiday: 3,
  "Christian & Gospel": 5,
  "Jazz/Blues": 6,
  "Rock & Country": 8,
  Pop: 12,
  "TV & Film": 13,
  Sacred: 14,
  Contemporary: 15,
  "Scales & Exercises": 16,
  Institutional: 17,
  Methods: 18,
  World: 19,
  Folk: 20,
  "New Age Piano": 21,
  Musical: 22,
  "Video Game Music": 23,
};

export const GENRE_NAMES = Object.keys(GENRES);

export function genreNamesToValues(names: string[]): string[] {
  return names
    .map((n) => GENRES[n])
    .filter((v): v is number => typeof v === "number")
    .map(String);
}

/**
 * Жанр по умолчанию. Legacy-форма отклоняет отправку с «At least one genre is
 * required.», а анализатор партитуры возвращает пустой список, когда ни одно
 * ключевое слово не совпало, — поэтому жанр обязателен, а не опционален.
 */
export const DEFAULT_GENRE = "Contemporary";

/** Значения для `<select multiple>`: всегда хотя бы одно. */
export function resolveGenreValues(names: string[]): string[] {
  const values = genreNamesToValues(names);
  return values.length ? values : [String(GENRES[DEFAULT_GENRE])];
}

/**
 * Аварийный фолбэк, если карта жанров разошлась с живой формой: первый вариант
 * с непустым значением. `0` и пустая строка — это placeholder «не выбрано».
 */
export function pickFallbackGenreValue(
  options: Array<{ value: string; label: string }>,
): string | null {
  const usable = options.find((option) => option.value.trim() !== "" && option.value !== "0");
  return usable ? usable.value : null;
}
