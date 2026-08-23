/**
 * Воспроизводимый read-only прогон аппликатуры по локальному корпусу.
 *
 * Пример:
 *   bun run bench:fingering -- ~/Downloads/musescore_sheets
 *
 * Скрипт ничего не записывает в партитуры. Каталоги обходятся рекурсивно,
 * результаты печатаются JSON-ом, чтобы snapshot можно было сохранить и
 * сравнить между ревизиями.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";

import { planFingering, type FingeringReport } from "./fingering";
import { readScoreContainer, stripFingering } from "./fingering-xml";
import { parseScore } from "./fingering-score";
import type { Finger } from "./fingering-model";

const SCORE_EXTENSIONS = new Set([".mxl", ".musicxml", ".xml"]);

export interface FingeringBenchRow {
  path: string;
  /** Поддерживаемые атаки без grace и tie-продолжений. */
  attacks: number;
  /** Атаки, для которых цифра намеренно не печатается. */
  suppressed: number;
  /** Напечатанные атаки; сохранено как `notes` для совместимости snapshot. */
  notes: number;
  reference: "technical" | "numeric-lyrics" | null;
  authored: number;
  matched: number;
  agreement: number | null;
  /** Полная целевая функция; старое имя сохранено для совместимости snapshot. */
  costPerNote: number;
  /** Только эргономическая часть, сопоставимая между версиями педагогических приоров. */
  ergonomicCostPerNote: number;
  /** Вклад педагогических приоров в полную целевую функцию. */
  pedagogyAdjustmentPerNote: number;
  patternNotes: number;
  warnings: string[];
  elapsedMs: number;
}

async function scoreFiles(inputs: string[]): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    if (path.split(sep).some((segment) => segment.toLowerCase() === "fingered")) {
      return;
    }
    const info = await stat(path);
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      await Promise.all(entries.map((entry) => visit(join(path, entry.name))));
      return;
    }
    if (SCORE_EXTENSIONS.has(extname(path).toLowerCase())) found.push(path);
  };
  await Promise.all(inputs.map(visit));
  return found.sort((left, right) => left.localeCompare(right));
}

function referenceFingerings(xml: string): {
  kind: FingeringBenchRow["reference"];
  values: Map<number, Finger>;
} {
  const score = parseScore(xml);
  const technical = new Map(
    score.notes.flatMap((note) =>
      note.fingering === undefined
        ? []
        : [[note.index, note.fingering as Finger] as const],
    ),
  );
  if (technical.size > 0) return { kind: "technical", values: technical };

  // Некоторые педагогические MusicXML-файлы (в частности экспортированные
  // таблицы гамм) хранят эталонные цифры как numeric lyrics. Принимаем такой
  // слой за gold только при высокой плотности и отсутствии обычного текста:
  // случайная цифра в песенном тексте не должна стать псевдо-аппликатурой.
  const playable = score.notes.filter((note) => note.midi !== undefined && !note.tieStop);
  const lyricBearing = playable.filter((note) => /<lyric(?=[\s>])/i.test(note.body));
  const numericLyrics = new Map<number, Finger>();
  for (const note of lyricBearing) {
    const texts = [...note.body.matchAll(/<text(?=[\s>])[^>]*>\s*([1-5])\s*<\/text>/gi)];
    if (texts.length === 1) numericLyrics.set(note.index, Number(texts[0][1]) as Finger);
  }
  const dense =
    numericLyrics.size >= 8 &&
    numericLyrics.size >= playable.length * 0.6 &&
    numericLyrics.size === lyricBearing.length;
  return dense
    ? { kind: "numeric-lyrics", values: numericLyrics }
    : { kind: null, values: new Map() };
}

export async function benchmarkFingering(inputs: string[]): Promise<FingeringBenchRow[]> {
  const rows: FingeringBenchRow[] = [];
  for (const path of await scoreFiles(inputs)) {
    const started = performance.now();
    const container = await readScoreContainer(path);
    try {
      const reference = referenceFingerings(container.xml);
      const plan = planFingering(stripFingering(container.xml), {
        mode: "rebuild",
        comparisonFingerings: reference.values,
      });
      const report: FingeringReport = plan.report;
      const attacks = parseScore(container.xml).notes.filter(
        (note) => plan.hands.has(note.index) && !note.grace && !note.tieStop,
      );
      const printed = attacks.filter(
        (note) => plan.assignments.has(note.index) && !plan.suppressed.has(note.index),
      ).length;
      rows.push({
        path,
        attacks: attacks.length,
        suppressed: attacks.length - printed,
        notes: printed,
        reference: reference.kind,
        authored: report.existing.total,
        matched: report.existing.matched,
        agreement:
          report.existing.total === 0
            ? null
            : Number((report.existing.matched / report.existing.total).toFixed(4)),
        costPerNote: report.stats.costPerNote,
        ergonomicCostPerNote: report.stats.ergonomicCostPerNote,
        pedagogyAdjustmentPerNote: report.stats.pedagogyAdjustmentPerNote,
        patternNotes: report.stats.patternNotes,
        warnings: report.warnings,
        elapsedMs: Number((performance.now() - started).toFixed(1)),
      });
    } finally {
      if (container.workDir) await rm(container.workDir, { recursive: true, force: true });
    }
  }
  return rows;
}

if (import.meta.main) {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error("Передайте путь к .mxl/.musicxml или каталогу с корпусом.");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(await benchmarkFingering(inputs), null, 2));
  }
}
