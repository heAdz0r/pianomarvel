/**
 * Разовая раскладка старой библиотеки в `<автор>/<композиция>/<файлы>`.
 *
 *   bun run server/musescore-relayout.ts
 *   bun run server/musescore-relayout.ts --apply
 */
import {
  existsSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { analyzeScoreFile } from "./scoreAnalyzer";
import { getCache } from "./cache";
import {
  MUSESCORE_SHEETS_ROOT,
  firstUsable,
  moveFile,
  pickAuthorCredit,
  removeEmptyAuthorDir,
  sanitizeBase,
} from "./musescore";

const BUNDLE_EXTENSIONS = new Set([".mxl", ".mid", ".midi", ".mp3", ".pdf"]);
/** Явно подтверждённые legacy-папки, которые были названием релиза/пьесы. */
const LEGACY_AUTHOR_ALIASES: Record<string, string> = {
  "clair-obscur-expedition-33": "lorien-testard",
  "exercises-1-to-30": "c-l-hanon",
  radioactive: "imagine-dragons",
};

export interface RelayoutEntry {
  path: string;
  title: string;
  composer: string;
  artist: string;
}

export interface RelayoutBundle {
  sourceDir: string;
  files: Array<{ from: string; to: string }>;
  skipped?: string;
}

/** Чистая фаза планирования: метаданные уже прочитаны, файловая система не меняется. */
export function planRelayout(
  entries: RelayoutEntry[],
  root = MUSESCORE_SHEETS_ROOT,
): RelayoutBundle[] {
  return entries.map((entry) => {
    const sourceDir = dirname(entry.path);
    const sourceBase = basename(entry.path, extname(entry.path));
    const title = firstUsable(entry.title, sourceBase);
    const relativePath = relative(root, entry.path);
    const relativeSegments = relativePath.split(sep);
    const currentAuthor =
      !relativePath.startsWith("..") && relativeSegments.length > 1
        ? relativeSegments[0]
        : undefined;
    // Текущая папка — уже курированная identity автора. Внутренние credits часто
    // содержат аранжировщика или список songwriters, поэтому не переименовываем
    // известного автора по MusicXML. Метаданные нужны только для legacy `unknown`.
    const metadataAuthor = pickAuthorCredit([entry.composer, entry.artist], title);
    const curatedAuthor = currentAuthor
      ? LEGACY_AUTHOR_ALIASES[currentAuthor] ?? currentAuthor
      : undefined;
    const author =
      curatedAuthor && curatedAuthor !== "unknown"
        ? curatedAuthor
        : metadataAuthor ?? curatedAuthor ?? "unknown";
    // Стабильный stem различает две редакции одного произведения и совпадает с
    // basename связанных MXL/MID/MP3/PDF.
    const targetDir = join(root, sanitizeBase(author), sanitizeBase(sourceBase));
    const files = readdirSync(sourceDir)
      .filter((name) => {
        const extension = extname(name).toLowerCase();
        return BUNDLE_EXTENSIONS.has(extension) &&
          basename(name, extension) === sourceBase;
      })
      .map((name) => ({
        from: join(sourceDir, name),
        to: join(targetDir, name),
      }));
    const fingered = join(sourceDir, "fingered", `${sourceBase}.mxl`);
    if (existsSync(fingered)) {
      files.push({
        from: fingered,
        to: join(targetDir, "fingered", `${sourceBase}.mxl`),
      });
    }
    const conflict = files.find((file) => file.from !== file.to && existsSync(file.to));
    if (conflict) {
      return {
        sourceDir,
        files,
        skipped: `цель занята: ${conflict.from} → ${conflict.to}`,
      };
    }
    return { sourceDir, files };
  });
}

export function applyRelayout(
  bundles: RelayoutBundle[],
  root = MUSESCORE_SHEETS_ROOT,
  onMove: (move: { from: string; to: string }) => void = () => {},
): { movedBundles: number; movedFiles: number; skipped: string[] } {
  let movedBundles = 0;
  let movedFiles = 0;
  const skipped: string[] = [];
  for (const bundle of bundles) {
    if (bundle.skipped) {
      skipped.push(`${bundle.sourceDir}: ${bundle.skipped}`);
      continue;
    }
    const conflict = bundle.files.find(
      (file) => file.from !== file.to && existsSync(file.to),
    );
    if (conflict) {
      skipped.push(`цель занята: ${conflict.from} → ${conflict.to}`);
      continue;
    }
    const pending = bundle.files.filter((file) => file.from !== file.to);
    if (pending.length === 0) continue;
    for (const file of pending) {
      moveFile(file.from, file.to);
      onMove(file);
      movedFiles += 1;
    }
    movedBundles += 1;
    const sourceDirs = Array.from(
      new Set(pending.map((file) => dirname(file.from))),
    ).sort((left, right) => right.length - left.length);
    for (const sourceDir of sourceDirs) removeEmptyAuthorDir(sourceDir, root);
  }
  return { movedBundles, movedFiles, skipped };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!existsSync(MUSESCORE_SHEETS_ROOT)) {
    console.log(`Папка не найдена: ${MUSESCORE_SHEETS_ROOT}`);
    return;
  }
  const paths = (readdirSync(MUSESCORE_SHEETS_ROOT, { recursive: true }) as string[])
    .filter(
      (path) =>
        extname(path).toLowerCase() === ".mxl" &&
        !path.split(sep).some((segment) => segment.toLowerCase() === "fingered"),
    )
    .map((path) => join(MUSESCORE_SHEETS_ROOT, path));
  const entries: RelayoutEntry[] = [];
  for (const path of paths) {
    const analysis = await analyzeScoreFile(path);
    entries.push({ path, ...analysis });
  }
  const bundles = planRelayout(entries);
  const rows = bundles.flatMap((bundle) =>
    bundle.files.map((file) => ({ откуда: file.from, куда: file.to })),
  );
  console.table(rows);
  for (const bundle of bundles) {
    if (bundle.skipped) console.warn(`Пропущено: ${bundle.sourceDir}: ${bundle.skipped}`);
  }
  if (!apply) {
    console.log(
      `План: перенести ${bundles.filter((bundle) => !bundle.skipped && bundle.files.some((file) => file.from !== file.to)).length} комплектов, ` +
        `${bundles.filter((bundle) => !bundle.skipped).flatMap((bundle) => bundle.files).filter((file) => file.from !== file.to).length} файлов. ` +
        `Добавьте --apply для выполнения.`,
    );
    return;
  }
  const moved: Array<{ from: string; to: string }> = [];
  const result = applyRelayout(bundles, MUSESCORE_SHEETS_ROOT, (move) => {
    moved.push(move);
  });
  const scoreSourceMoves = moved.filter(
    (move) =>
      extname(move.from).toLowerCase() === ".mxl" &&
      !move.from
        .split(sep)
        .some((segment) => segment.toLowerCase() === "fingered"),
  );
  const rebound = getCache().rebindScoreSourcePaths(scoreSourceMoves);
  console.log(`Перенесено ${result.movedBundles} комплектов, ${result.movedFiles} файлов.`);
  console.log(`Перепривязано ${rebound} канонических MusicXML в score_sources.`);
  for (const warning of result.skipped) {
    if (!bundles.some((bundle) => warning === `${bundle.sourceDir}: ${bundle.skipped}`)) {
      console.warn(`Пропущено: ${warning}`);
    }
  }
}

if (import.meta.main) await main();
