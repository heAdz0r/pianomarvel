/**
 * CHANGED (new file) — закрывает gap #7 из architecture.md.
 *
 * Таблица жанров и шкала сложности раньше были «сняты один раз вручную» и
 * устаревали молча, если Piano Marvel менял форму. Этот скрипт открывает
 * реальную форму /uploads/editSong/ в залогиненном профиле, вычитывает <option>
 * из <select>-ов и перегенерирует server/genres.ts автоматически.
 *
 *   bun run scrape           # показать, что нашлось, и перезаписать genres.ts
 *   bun run scrape --dry     # только показать, ничего не писать
 *
 * Требует активной сессии (bun run login один раз).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getContext, isLoggedIn, closeContext } from "./browser";

const EDIT_SONG_URL = "https://pianomarvel.com/uploads/editSong/";
const GENRES_FILE = join(import.meta.dir, "genres.ts");

interface Option {
  value: string;
  label: string;
}

async function readOptions(selector: string): Promise<Option[]> {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto(EDIT_SONG_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(selector, { timeout: 20000 });
    return await page.$$eval(`${selector} option`, (opts) =>
      opts
        .map((o) => ({ value: (o as HTMLOptionElement).value, label: (o.textContent ?? "").trim() }))
        .filter((o) => o.value !== "" && o.label !== ""),
    );
  } finally {
    await page.close().catch(() => undefined);
  }
}

function renderGenresFile(genres: Option[]): string {
  const entries = genres
    .map((g) => {
      const key = /[^A-Za-z0-9_]/.test(g.label) ? JSON.stringify(g.label) : g.label;
      return `  ${key}: ${Number(g.value)},`;
    })
    .join("\n");

  return `// CHANGED: этот файл можно перегенерировать из живой формы — \`bun run scrape\`.
// Последний скрейп фиксирует «название жанра → id» из select формы Piano Marvel.
export const GENRES: Record<string, number> = {
${entries}
};

export const GENRE_NAMES = Object.keys(GENRES);

export function genreNamesToValues(names: string[]): string[] {
  return names
    .map((n) => GENRES[n])
    .filter((v): v is number => typeof v === "number")
    .map(String);
}
`;
}

async function main() {
  const dryRun = process.argv.includes("--dry");

  if (!(await isLoggedIn())) {
    console.error("Не залогинен на pianomarvel.com. Сначала: bun run login");
    await closeContext();
    process.exit(1);
  }

  const [genres, difficulty] = await Promise.all([
    readOptions('select[name="data[Piece][genres][]"]'),
    readOptions('select[name="data[Piece][difficulty]"]'),
  ]);

  console.log(`\nЖанры (${genres.length}):`);
  for (const g of genres) console.log(`  ${g.value}\t${g.label}`);

  const diffValues = difficulty.map((d) => Number(d.value)).filter(Number.isFinite);
  if (diffValues.length) {
    console.log(
      `\nСложность: ${Math.min(...diffValues)}–${Math.max(...diffValues)} (${diffValues.length} значений)`,
    );
    console.log("  → если диапазон изменился, поправьте DIFFICULTY в server/constants.ts");
  }

  if (genres.length && !dryRun) {
    writeFileSync(GENRES_FILE, renderGenresFile(genres), "utf8");
    console.log(`\n✅ server/genres.ts перезаписан (${genres.length} жанров).`);
  } else if (dryRun) {
    console.log("\n(--dry: genres.ts не тронут)");
  } else {
    console.log("\n⚠ Жанры не найдены — genres.ts не тронут (возможно, поменялась разметка формы).");
  }

  await closeContext();
}

main().catch(async (err) => {
  console.error(err);
  await closeContext().catch(() => undefined);
  process.exit(1);
});
