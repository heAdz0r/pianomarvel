/**
 * Запись аппликатуры в MusicXML и сборка нового `.mxl`.
 *
 * Инвариант: оригинал никогда не открывается на запись. Результат кладётся в
 * подпапку `fingered/` рядом с исходником (docs/fingering-prd.md §7.3).
 *
 * Вставка точечная: содержимое `<note>` не переписывается, добавляется только
 * недостающий узел `<notations><technical><fingering>`. Так сохраняются
 * форматирование, `<beam>`, `<lyric>` и координаты оригинала.
 */

import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";

import {
  planFingering,
  type FingeringMode,
  type FingeringOptions,
  type FingeringPlan,
} from "./fingering";
import { parseScore, type ParsedNote } from "./fingering-score";

const MXL_MIMETYPE = "application/vnd.recordare.musicxml";
const MXL_MEDIA_TYPE = "application/vnd.recordare.musicxml+xml";
const ENCODING_MARK = "pianomarvel fingering";
const FINGERED_DIR = "fingered";
const PIANO_MARVEL_DIR = "piano-marvel";

function removeEmptyFingeringContainers(xml: string): string {
  let result = xml.replace(
    /[ \t]*<technical\s*>\s*<\/technical>\s*\n?/gi,
    "",
  );
  result = result.replace(/[ \t]*<technical\b[^>]*\/>\s*\n?/gi, "");
  result = result.replace(/[ \t]*<notations\b[^>]*>\s*<\/notations>\s*\n?/gi, "");
  return result;
}

/**
 * Удаляет всю имеющуюся аппликатуру вместе с опустевшими родителями.
 * Нужна для режима пересборки: старые цифры не должны накладываться на новые.
 */
export function stripFingering(xml: string): string {
  return removeEmptyFingeringContainers(
    xml.replace(/[ \t]*<fingering\b[^>]*(?:\/>|>[\s\S]*?<\/fingering>)\s*\n?/gi, ""),
  );
}

/**
 * Удаляет устаревшие альтернативные цифры, не затрагивая классическую
 * аппликатуру, уже заданную автором партитуры.
 */
export function stripAlternativeFingering(xml: string): string {
  let result = xml.replace(
    /[ \t]*<fingering\b(?=[^>]*\balternate=["']yes["'])[^>]*(?:\/>|>[\s\S]*?<\/fingering>)\s*\n?/gi,
    "",
  );
  result = result.replace(
    /[ \t]*<fingering\b[^>]*>\s*\([1-5]\)\s*<\/fingering>\s*\n?/gi,
    "",
  );
  return removeEmptyFingeringContainers(result);
}

interface Edit {
  at: number;
  text: string;
}

/**
 * Вставляет аппликатуру в разобранную партитуру.
 *
 * `placement` берётся из фактически выбранной моделью руки: у правой цифры над
 * станом, у левой — под ним. Это сохраняет читаемость двух голосов на одном
 * нотоносце и в печати. Абсолютные координаты (`default-x`/`default-y`) не
 * пишутся: нотатор сохраняет автоматическую раскладку. `relative-y` лишь
 * добавляет скромный зазор в 2 tenths, а `font-size=8` удерживает цифры
 * читаемыми в плотной фактуре.
 */
export function annotateFingering(
  xml: string,
  plan: FingeringPlan,
  options: { layout?: "resource" | "piano-marvel" } = {},
): string {
  const layout = options.layout ?? "resource";
  const source = stripAlternativeFingering(xml);
  const base = layout === "piano-marvel" ? stripFingering(source) : source;
  const score = parseScore(base);
  const edits: Edit[] = [];
  const candidates = score.notes.flatMap((note) => {
    const finger = plan.assignments.get(note.index);
    if (finger === undefined || plan.suppressed.has(note.index)) return [];
    if (layout === "resource" && /<fingering\b/i.test(note.body)) return [];
    const hand = plan.hands.get(note.index) ?? (note.staff === "2" ? "L" : "R");
    const placement = hand === "L" ? "below" : "above";
    return [{ note, finger, placement } as const];
  });

  if (layout === "resource") {
    for (const { note, finger, placement } of candidates) {
      edits.push(insertionFor(base, note, fingeringTag(finger, placement)));
    }
  } else {
    const groups = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      const { note, placement } = candidate;
      const key = [
        note.partIndex,
        note.measureIndex,
        note.staff,
        Math.round(note.measureOnset * 1_000_000),
        placement,
      ].join(":");
      const group = groups.get(key);
      if (group) group.push(candidate);
      else groups.set(key, [candidate]);
    }
    for (const group of groups.values()) {
      const anchor = group.reduce((current, candidate) =>
        candidate.note.index < current.note.index ? candidate : current
      );
      const tags = [...group]
        .sort((left, right) =>
          (right.note.midi ?? -Infinity) - (left.note.midi ?? -Infinity)
          || left.note.index - right.note.index
        )
        .map(({ finger, placement }) => fingeringTag(finger, placement))
        .join("");
      edits.push(insertionFor(base, anchor.note, tags));
    }
  }

  return markEncoding(applyEdits(base, edits));
}

function fingeringTag(
  finger: number,
  placement: "above" | "below",
): string {
    const relativeY = placement === "above" ? "2" : "-2";
    const attributes =
      `placement="${placement}" font-size="8" relative-y="${relativeY}"`;
  return `<fingering ${attributes}>${finger}</fingering>`;
}

/** Точка вставки и текст с отступами в стиле окружающего файла. */
function insertionFor(xml: string, note: ParsedNote, tag: string): Edit {
  const bodyStart = note.end - note.body.length - "</note>".length;
  const indent = indentAt(xml, note.start);
  const step = detectStep(xml, note);
  const inner = `${indent}${step}`;

  const notations = /<notations(?=[\s>])([^>]*)>([\s\S]*)<\/notations>/i.exec(note.body);
  if (notations) {
    const notationsInner = notations[2] ?? "";
    const notationsStart = bodyStart + (notations.index ?? 0);
    const technical = /<technical(?=[\s>])[^>]*>([\s\S]*?)<\/technical>/i.exec(notationsInner);
    if (technical) {
      const technicalInnerStart =
        notationsStart +
        notations[0].indexOf(notationsInner) +
        (technical.index ?? 0) +
        technical[0].indexOf(technical[1] ?? "");
      return lineEdit(xml, technicalInnerStart, [`${inner}${step.repeat(2)}${tag}`], true);
    }
    const closing = notationsStart + notations[0].lastIndexOf("</notations>");
    return lineEdit(xml, closing, [
      `${inner}${step}<technical>`,
      `${inner}${step.repeat(2)}${tag}`,
      `${inner}${step}</technical>`,
    ]);
  }

  // `<notations>` в схеме идёт после `<beam>`/`<staff>` и перед `<lyric>`/`<play>`.
  const tail = /<(?:lyric|play|listen)(?=[\s/>])/i.exec(note.body);
  const at = tail ? bodyStart + (tail.index ?? 0) : bodyStart + note.body.length;
  return lineEdit(xml, at, [
    `${inner}<notations>`,
    `${inner}${step}<technical>`,
    `${inner}${step.repeat(2)}${tag}`,
    `${inner}${step}</technical>`,
    `${inner}</notations>`,
  ]);
}

/**
 * Вставка целыми строками. Если перед точкой вставки на строке только отступ,
 * блок встаёт в начало строки — иначе получился бы двойной отступ и «лесенка»,
 * из-за которой файл читается хуже, чем экспорт нотатора.
 */
function lineEdit(xml: string, at: number, lines: string[], after = false): Edit {
  if (after) return { at, text: `\n${lines.join("\n")}` };
  const lineStart = xml.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const prefix = xml.slice(lineStart, at);
  if (/^[ \t]*$/.test(prefix)) {
    return { at: lineStart, text: `${lines.join("\n")}\n` };
  }
  return { at, text: lines.map((line) => line.trim()).join("") };
}

function indentAt(xml: string, offset: number): string {
  const lineStart = xml.lastIndexOf("\n", offset) + 1;
  const line = xml.slice(lineStart, offset);
  return /^[ \t]*$/.test(line) ? line : "";
}

/** Шаг отступа файла: сравниваем отступ ноты и её внутренних элементов. */
function detectStep(xml: string, note: ParsedNote): string {
  const outer = indentAt(xml, note.start);
  const inner = note.body.match(/\n([ \t]+)</);
  if (!inner) return outer.includes("\t") ? "\t" : "  ";
  const step = inner[1].slice(outer.length);
  return step.length > 0 ? step : outer.includes("\t") ? "\t" : "  ";
}

function applyEdits(xml: string, edits: Edit[]): string {
  const ordered = [...edits].sort((left, right) => right.at - left.at);
  let result = xml;
  for (const edit of ordered) {
    result = result.slice(0, edit.at) + edit.text + result.slice(edit.at);
  }
  return result;
}

/** Отметка происхождения цифр прямо в файле, а не только в интерфейсе. */
function markEncoding(xml: string): string {
  let result = xml;
  if (!/<identification(?=[\s>])/i.test(result)) {
    const partList = /<part-list(?=[\s>])/i.exec(result);
    if (!partList) return result;
    const at = partList.index ?? 0;
    const indent = indentAt(result, at);
    const block =
      `${indent}<identification>\n` +
      `${indent}  <encoding>\n` +
      `${indent}    <software>${ENCODING_MARK}</software>\n` +
      `${indent}  </encoding>\n` +
      `${indent}  <miscellaneous>\n` +
      `${indent}    <miscellaneous-field name="fingering-source">auto</miscellaneous-field>\n` +
      `${indent}  </miscellaneous>\n` +
      `${indent}</identification>\n`;
    return `${result.slice(0, at)}${block}${result.slice(at)}`;
  }

  if (!result.includes(ENCODING_MARK)) {
    const encoding = /<encoding>([\s\S]*?)<\/encoding>/i.exec(result);
    if (encoding) {
      const at = (encoding.index ?? 0) + encoding[0].lastIndexOf("</encoding>");
      const indent = indentAt(result, at);
      const tag = `<software>${ENCODING_MARK}</software>`;
      const inserted = indent ? `${indent}  ${tag}\n${indent}` : tag;
      result = `${result.slice(0, at - indent.length)}${inserted}${result.slice(at)}`;
    } else {
      const identification = /<identification(?=[\s>])[^>]*>/i.exec(result);
      if (identification) {
        const at = (identification.index ?? 0) + identification[0].length;
        result = `${result.slice(0, at)}\n    <encoding>\n      <software>${ENCODING_MARK}</software>\n    </encoding>${result.slice(at)}`;
      }
    }
  }

  if (!/miscellaneous-field\b[^>]*\bname=["']fingering-source["']/i.test(result)) {
    const closing = /<\/identification>/i.exec(result);
    if (closing) {
      const at = closing.index ?? 0;
      const indent = indentAt(result, at);
      const block =
        `${indent}  <miscellaneous>\n` +
        `${indent}    <miscellaneous-field name="fingering-source">auto</miscellaneous-field>\n` +
        `${indent}  </miscellaneous>\n`;
      result = `${result.slice(0, at)}${block}${result.slice(at)}`;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Чтение и сборка контейнера
 * ------------------------------------------------------------------ */

export interface ScoreContainer {
  /** Текст партитуры. */
  xml: string;
  /** Имя файла партитуры внутри архива (для .mxl). */
  entry: string;
  compressed: boolean;
  /** Временная папка с распакованным архивом; удаляется вызывающим. */
  workDir?: string;
}

export async function readScoreContainer(path: string): Promise<ScoreContainer> {
  if (extname(path).toLowerCase() !== ".mxl") {
    return { xml: await readFile(path, "utf8"), entry: basename(path), compressed: false };
  }

  const workDir = await mkdtemp(join(tmpdir(), "pm-fingering-"));
  await run(["unzip", "-qq", "-o", path, "-d", workDir], "Не удалось распаковать MXL");
  const entry = await resolveRootFile(workDir);
  const xml = await readFile(join(workDir, entry), "utf8");
  return { xml, entry, compressed: true, workDir };
}

async function resolveRootFile(workDir: string): Promise<string> {
  const containerPath = join(workDir, "META-INF", "container.xml");
  if (existsSync(containerPath)) {
    const container = await readFile(containerPath, "utf8");
    const fullPath = container.match(/<rootfile\b[^>]*\bfull-path=["']([^"']+)["']/i)?.[1];
    if (fullPath && existsSync(join(workDir, fullPath))) return fullPath;
  }
  const entries = await readdir(workDir, { withFileTypes: true, recursive: true } as never) as unknown as string[];
  const names = Array.isArray(entries) ? entries : [];
  const found = names.find(
    (name) => /\.(?:musicxml|xml)$/i.test(String(name)) && !String(name).startsWith("META-INF"),
  );
  if (!found) throw new Error("В MXL не найдена партитура MusicXML.");
  return String(found);
}

/** Собирает `.mxl`: mimetype первым и без сжатия, затем всё остальное. */
export async function writeMxl(workDir: string, entry: string, target: string): Promise<void> {
  const mimetypePath = join(workDir, "mimetype");
  if (!existsSync(mimetypePath)) await writeFile(mimetypePath, MXL_MIMETYPE, "ascii");

  const containerDir = join(workDir, "META-INF");
  const containerPath = join(containerDir, "container.xml");
  if (!existsSync(containerPath)) {
    await mkdir(containerDir, { recursive: true });
    await writeFile(
      containerPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<container>\n  <rootfiles>\n` +
        `    <rootfile full-path="${entry}" media-type="${MXL_MEDIA_TYPE}"/>\n` +
        `  </rootfiles>\n</container>\n`,
      "utf8",
    );
  }

  // Пишем во временный файл рядом с целью и переносим готовый архив на место:
  // при сбое zip прежняя версия остаётся целой.
  const staging = `${target}.building-${process.pid}-${randomUUID()}`;
  try {
    await run(["zip", "-q", "-X", "-0", staging, "mimetype"], "Не удалось создать MXL", workDir);
    const rest = (await readdir(workDir)).filter((name) => name !== "mimetype");
    await run(["zip", "-q", "-X", "-r", staging, ...rest], "Не удалось упаковать MXL", workDir);
    await rename(staging, target);
  } finally {
    if (existsSync(staging)) await rm(staging, { force: true });
  }
}

async function run(command: string[], message: string, cwd?: string): Promise<void> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", cwd });
  const error = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`${message}: ${error.trim() || command[0]}`);
}

/* ------------------------------------------------------------------ *
 * Публичный сценарий
 * ------------------------------------------------------------------ */

export interface BuildFingeringOptions extends FingeringOptions {
  mode?: FingeringMode;
  /** Куда писать; по умолчанию `<папка>/fingered/<имя>.mxl`. */
  target?: string;
}

export interface BuildFingeringResult {
  /** Стандартный файл ресурса: аппликатура привязана к каждой ноте. */
  path: string;
  /** Совместимый с Piano Marvel файл: одновременные цифры собраны колонкой. */
  uploadPath: string;
  plan: FingeringPlan;
  /** Готовый MusicXML для немедленного предпросмотра в браузере. */
  previewXml: string;
}

const targetQueues = new Map<string, Promise<void>>();

async function withTargetLock<T>(target: string, task: () => Promise<T>): Promise<T> {
  const previous = targetQueues.get(target) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  targetQueues.set(target, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (targetQueues.get(target) === queued) targetQueues.delete(target);
  }
}

function originalFingerings(xml: string): Map<number, 1 | 2 | 3 | 4 | 5> {
  return new Map(
    parseScore(xml).notes.flatMap((note) =>
      note.fingering === undefined
        ? []
        : [[note.index, note.fingering as 1 | 2 | 3 | 4 | 5] as const],
    ),
  );
}

/**
 * Производный файл ровно один на композицию: `fingered/<имя>.mxl`. Любая
 * пересборка перезаписывает его, а не плодит второй, третий и `.rebuilt` —
 * иначе рядом с партитурой быстро вырастает свалка почти одинаковых файлов.
 *
 * Если исходником указан уже сгенерированный файл (после загрузки в кеше
 * лежит именно он), результат ложится на его же место, а не в `fingered/fingered/`.
 */
export function targetPathFor(source: string): string {
  const directory = dirname(source);
  const name = basename(source, extname(source));
  if (basename(directory) === FINGERED_DIR) return join(directory, `${name}.mxl`);
  return join(directory, FINGERED_DIR, `${name}.mxl`);
}

export function uploadTargetPathFor(source: string): string {
  const resource = targetPathFor(source);
  return join(dirname(resource), PIANO_MARVEL_DIR, basename(resource));
}

/**
 * Полный сценарий: прочитать партитуру, при пересборке снять старую
 * аппликатуру, подобрать новую, записать ресурсный и PM-совместимый `.mxl`.
 */
export async function buildFingeredScore(
  source: string,
  options: BuildFingeringOptions = {},
): Promise<BuildFingeringResult> {
  const mode = options.mode ?? "fill";
  const target = options.target ?? targetPathFor(source);
  const uploadTarget = options.target
    ? join(dirname(target), PIANO_MARVEL_DIR, basename(target))
    : uploadTargetPathFor(source);
  return withTargetLock(target, async () => {
    const container = await readScoreContainer(source);
    let createdWorkDir: string | undefined;
    try {
      const cleanSource = stripAlternativeFingering(container.xml);
      const comparisonFingerings =
        mode === "rebuild" ? originalFingerings(cleanSource) : undefined;
      const base = mode === "rebuild" ? stripFingering(cleanSource) : cleanSource;
      const plan = planFingering(base, {
        ...options,
        mode,
        comparisonFingerings,
      });
      const annotated = annotateFingering(base, plan);
      const uploadAnnotated = annotateFingering(base, plan, { layout: "piano-marvel" });

      await mkdir(dirname(target), { recursive: true });
      await mkdir(dirname(uploadTarget), { recursive: true });
      const workDir =
        container.workDir ?? (createdWorkDir = await mkdtemp(join(tmpdir(), "pm-fingering-")));
      const entry = container.compressed
        ? container.entry
        : `${basename(source, extname(source))}.musicxml`;
      await mkdir(dirname(join(workDir, entry)), { recursive: true });
      await writeFile(join(workDir, entry), annotated, "utf8");
      await writeMxl(workDir, entry, target);
      await writeFile(join(workDir, entry), uploadAnnotated, "utf8");
      await writeMxl(workDir, entry, uploadTarget);
      return {
        path: target,
        uploadPath: uploadTarget,
        plan,
        previewXml: annotated,
      };
    } finally {
      if (container.workDir) await rm(container.workDir, { recursive: true, force: true });
      if (createdWorkDir) await rm(createdWorkDir, { recursive: true, force: true });
    }
  });
}

/** Разбор партитуры без побочных эффектов: только чтение и анализ. */
export async function analyzeScoreFingering(
  source: string,
  options: FingeringOptions = {},
): Promise<{ plan: FingeringPlan; xml: string; previewXml: string }> {
  const container = await readScoreContainer(source);
  try {
    const cleanSource = stripAlternativeFingering(container.xml);
    const comparisonFingerings =
      options.mode === "rebuild" ? originalFingerings(cleanSource) : undefined;
    const base = options.mode === "rebuild" ? stripFingering(cleanSource) : cleanSource;
    const plan = planFingering(base, { ...options, comparisonFingerings });
    return {
      plan,
      xml: base,
      previewXml: annotateFingering(base, plan),
    };
  } finally {
    if (container.workDir) await rm(container.workDir, { recursive: true, force: true });
  }
}

export function relativeTo(root: string, path: string): string {
  const value = relative(root, path);
  return value.startsWith("..") ? path : value;
}
