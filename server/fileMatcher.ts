import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs"; // CHANGED: проверяем, что входной путь реально существует
import { dirname, basename, extname, join } from "node:path";

export type FileCategory = "midi" | "xml" | "audio" | "pdf" | "image";

const EXT_MAP: Record<string, FileCategory> = {
  ".mid": "midi",
  ".midi": "midi",
  ".mxl": "xml",
  ".musicxml": "xml",
  ".xml": "xml",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
};

const DECORATIVE_TOKENS = new Set([
  "arr",
  "arrangement",
  "audio",
  "cover",
  "instrumental",
  "karaoke",
  "official",
  "piano",
  "score",
  "sheet",
  "version",
]);

export interface MatchedFiles {
  baseName: string;
  dir: string;
  midi?: string;
  xml?: string;
  pdf?: string;
  image?: string;
  audio: string[];
  /** Files in the same folder that looked related but didn't get placed anywhere obvious. */
  extras: string[];
  warnings: string[];
}

/**
 * Given one file path (e.g. a .pdf the user just downloaded), look at every
 * other file in the same folder and pick out the ones that share the same
 * base name (ignoring extension, case-insensitive). Piano Marvel wants up to
 * five kinds of asset per song: a MIDI file, a MusicXML file, one or more
 * audio files, a PDF of the sheet music, and a thumbnail image.
 */
export async function findSiblingFiles(inputPath: string): Promise<MatchedFiles> {
  // CHANGED: раньше несуществующий путь падал с сырым ENOENT из readdir —
  // теперь понятная ошибка ещё до сканирования папки.
  if (!existsSync(inputPath)) {
    throw new Error(`Файл не найден: ${inputPath}`);
  }
  const dir = dirname(inputPath);
  const inputExt = extname(inputPath);
  const inputBase = basename(inputPath, inputExt);
  const normalizedBase = normalize(inputBase);

  const entries = await readdir(dir, { withFileTypes: true });
  // CHANGED: сортируем — readdir не гарантирует порядок, а от него зависел
  // порядок аудио-дорожек и extras (не воспроизводимо между запусками/ОС).
  const candidates = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort((left, right) => {
      const rank = (name: string): number => {
        const full = join(dir, name);
        if (full === inputPath) return 0;
        const base = basename(name, extname(name));
        return normalize(base) === normalizedBase ? 1 : 2;
      };
      return rank(left) - rank(right) || left.localeCompare(right);
    });
  const exactCategories = new Set(
    candidates.flatMap((name) => {
      const ext = extname(name).toLowerCase();
      const category = EXT_MAP[ext];
      const base = basename(name, extname(name));
      return category && normalize(base) === normalizedBase ? [category] : [];
    }),
  );

  const result: MatchedFiles = {
    baseName: inputBase,
    dir,
    audio: [],
    extras: [],
    warnings: [],
  };

  for (const name of candidates) {
    const ext = extname(name).toLowerCase();
    const base = basename(name, extname(name));
    const category = EXT_MAP[ext];
    const full = join(dir, name);

    const isSameFile = full === inputPath;
    const exactBase = normalize(base) === normalizedBase;
    const matchesBase = exactBase || hasRelatedName(inputBase, base);

    if (!matchesBase) continue;
    // Fuzzy нужен только когда для этой категории нет exact stem. Иначе две
    // редакции одной песни способны смешать MIDI одной версии с MXL другой.
    if (!exactBase && category && exactCategories.has(category)) continue;

    if (!category) {
      if (!isSameFile) result.extras.push(full);
      continue;
    }

    if (category === "audio") {
      result.audio.push(full);
    } else if (!result[category]) {
      result[category] = full;
    } else if (full !== result[category]) {
      // Same category, different file (e.g. two PDFs) — keep the first match,
      // note the rest so the UI can surface the ambiguity.
      result.extras.push(full);
    }
  }

  // Make sure the file the user actually pointed at is included even if our
  // category detection missed its extension for some reason.
  const inputCategory = EXT_MAP[inputExt.toLowerCase()];
  if (inputCategory === "audio") {
    if (!result.audio.includes(inputPath)) result.audio.push(inputPath);
  } else if (inputCategory && !result[inputCategory]) {
    result[inputCategory] = inputPath;
  } else if (!inputCategory) {
    result.warnings.push(
      `Не распознал тип файла "${basename(inputPath)}" (${inputExt || "без расширения"}).`,
    );
  }

  if (!result.midi && !result.xml) {
    result.warnings.push(
      "Не найден MIDI (.mid) или MusicXML (.mxl/.musicxml) файл — Piano Marvel требует хотя бы один из них для нотной дорожки.",
    );
  }
  if (!result.pdf) {
    result.warnings.push("Не найден PDF с нотами (необязательно, но обычно нужен).");
  }
  if (!result.image) {
    result.warnings.push("Не найдена картинка для превью (необязательно).");
  }
  if (result.audio.length === 0) {
    result.warnings.push("Не найден аудиофайл (необязательно, но полезен для прослушивания).");
  }

  return result;
}

/** Loosen up a filename for comparison: lowercase, collapse separators. */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Сопоставляет переставленные слова и безопасные служебные суффиксы. */
function hasRelatedName(reference: string, candidate: string): boolean {
  const referenceTokens = nameTokens(reference);
  const candidateTokens = nameTokens(candidate);
  if (referenceTokens.size === 0 || candidateTokens.size === 0) return false;

  let common = 0;
  for (const token of referenceTokens) {
    if (candidateTokens.has(token)) common += 1;
  }

  const shorter = Math.min(referenceTokens.size, candidateTokens.size);
  const longer = Math.max(referenceTokens.size, candidateTokens.size);
  return common >= 2 && common === shorter && common / longer >= 0.6;
}

function nameTokens(name: string): Set<string> {
  const tokens = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !DECORATIVE_TOKENS.has(token));
  return new Set(tokens);
}
