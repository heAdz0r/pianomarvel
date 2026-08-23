/**
 * Открытие партитуры в стороннем нотаторе — способ проверить сгенерированную
 * аппликатуру глазами, а не только по цифрам отчёта.
 *
 * macOS-only, как и остальной локальный инструментарий проекта
 * (`pickFileNative` в server/index.ts тоже опирается на системный диалог).
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const APPLICATION_DIRS = ["/Applications", join(homedir(), "Applications")];
/** Открываем только партитуры: `open` не должен превращаться в «запусти что угодно». */
const OPENABLE = new Set([".mxl", ".musicxml", ".xml"]);
const EDITOR_PATTERN = /^(MuseScore|Finale|Sibelius|Dorico)\b/i;

/**
 * Выбор нотатора из списка приложений. Между версиями выигрывает старшая
 * (`MuseScore 4` важнее `MuseScore 3`), между программами — порядок в
 * `EDITOR_PATTERN`: MuseScore открывает MusicXML без диалогов импорта.
 */
export function pickScoreEditor(entries: string[]): string | undefined {
  const candidates = entries
    .filter((entry) => entry.endsWith(".app") && EDITOR_PATTERN.test(entry))
    .map((entry) => {
      const name = entry.slice(0, -".app".length);
      const version = Number(name.match(/(\d+(?:\.\d+)?)\s*$/)?.[1] ?? 0);
      return { entry, name, version };
    });
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => {
    const preferred = /^MuseScore/i;
    const leftMuse = preferred.test(left.name) ? 0 : 1;
    const rightMuse = preferred.test(right.name) ? 0 : 1;
    if (leftMuse !== rightMuse) return leftMuse - rightMuse;
    if (left.version !== right.version) return right.version - left.version;
    return left.name.localeCompare(right.name);
  });
  return candidates[0].name;
}

/** Имя установленного нотатора или `undefined`, если ни одного нет. */
export function findScoreEditor(): string | undefined {
  const entries = APPLICATION_DIRS.flatMap((dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  });
  return pickScoreEditor(entries);
}

export interface OpenScoreResult {
  /** Приложение, которым открыли; `undefined` — системный обработчик по умолчанию. */
  app?: string;
  revealed: boolean;
}

/**
 * Открывает файл в нотаторе или показывает его в Finder.
 *
 * `reveal` нужен, когда нотатора нет или пользователь хочет забрать файл
 * руками: `open -R` подсвечивает файл в папке, ничего не запуская.
 */
export async function openScoreFile(
  path: string,
  options: { reveal?: boolean } = {},
): Promise<OpenScoreResult> {
  if (!existsSync(path)) throw new Error(`Файл не найден: ${path}`);
  if (!OPENABLE.has(extname(path).toLowerCase())) {
    throw new Error("Открывать можно только файлы партитуры (.mxl, .musicxml, .xml).");
  }

  if (options.reveal) {
    await run(["open", "-R", path]);
    return { revealed: true };
  }

  const app = findScoreEditor();
  await run(app ? ["open", "-a", app, path] : ["open", path]);
  return { app, revealed: false };
}

async function run(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(error.trim() || `Не удалось выполнить ${command.join(" ")}`);
  }
}
