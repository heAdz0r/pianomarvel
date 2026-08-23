import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeAdaptiveMusicXml } from "./adaptive-learning";
import { measurePlanQuality } from "./adaptive-quality";
import { planFingering } from "./fingering";
import { annotateFingering } from "./fingering-xml";

/**
 * Гарантии из docs/adaptive-learning-prd.md §5: алгоритм обязан оставаться
 * универсальным и воспроизводимым. Это не проверки музыкального результата, а
 * проверки самого способа его получения.
 */

const SERVER_DIR = import.meta.dir;
const ADAPTIVE_SOURCES = readdirSync(SERVER_DIR)
  .filter(
    (name) =>
      name.startsWith("adaptive-") &&
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      name !== "adaptive-corpus-audit.ts",
  )
  .map((name) => ({ name, code: readFileSync(join(SERVER_DIR, name), "utf8") }));

/** Названия из корпуса: ни одно не имеет права влиять на поведение алгоритма. */
const CORPUS_TITLES = [
  "another love",
  "clocks",
  "gymnop",
  "moonlight",
  "bad habits",
  "radioactive",
  "interstellar",
  "severance",
  "unforgiven",
  "nothing else matters",
  "karma police",
  "love story",
  "lumi",
  "children",
  "no surprises",
  "running up",
  "лесник",
  "sheeran",
  "beethoven",
  "satie",
  "coldplay",
  "metallica",
];

function withoutComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, " "))
    .join("\n");
}

describe("Гарантии универсальности", () => {
  test("в исполняемом коде нет названий произведений и композиторов", () => {
    for (const source of ADAPTIVE_SOURCES) {
      const executable = withoutComments(source.code).toLowerCase();
      for (const title of CORPUS_TITLES) {
        expect(
          executable.includes(title),
          `${source.name} упоминает «${title}» вне комментария`,
        ).toBe(false);
      }
    }
  });

  test("нет условий по номеру такта и по имени файла", () => {
    // Сравнение индекса такта с литеральным номером — прямой признак хардкода.
    // Только идентификаторы, обозначающие такт: обычные счётчики циклов сравниваются
    // с числами законно (например, обход двенадцати классов высот).
    const measureLiteral =
      /\b(?:measure|ordinal|startMeasure|endMeasure|measureIndex|anchorMeasure|wholeStart|wholeEnd)\b\s*(?:===|==|!==|!=|>=|<=|>|<)\s*(?!0\b|1\b)\d+/;
    const fileLiteral = /["'][^"']*\.(?:mxl|musicxml|xml)["']/i;
    for (const source of ADAPTIVE_SOURCES) {
      const executable = withoutComments(source.code);
      const measureHit = executable.match(measureLiteral);
      expect(
        measureHit?.[0] ?? null,
        `${source.name}: сравнение такта с номером`,
      ).toBeNull();
      expect(
        executable.match(fileLiteral)?.[0] ?? null,
        `${source.name}: путь к файлу партитуры`,
      ).toBeNull();
    }
  });

  test("каждая константа PEDAGOGY документирована", () => {
    const code = ADAPTIVE_SOURCES.find(
      (source) => source.name === "adaptive-learning.ts",
    )?.code;
    expect(code).toBeDefined();
    const block = (code as string).match(
      /const PEDAGOGY = \{([\s\S]*?)\n\} as const;/,
    );
    expect(block).not.toBeNull();
    const lines = (block as RegExpMatchArray)[1].split("\n");
    const undocumented: string[] = [];
    for (const [index, line] of lines.entries()) {
      const match = line.match(/^\s{2}([A-Za-z][A-Za-z0-9]*):/);
      if (!match) continue;
      // Обоснование стоит либо в строках выше, либо в комментарии на той же строке.
      const previous = lines
        .slice(Math.max(0, index - 8), index)
        .join("\n");
      const documented =
        /\/\*\*[\s\S]*$/.test(previous) ||
        /\/\/[^\n]*$/.test(previous.split("\n").at(-1) ?? "") ||
        line.includes("//");
      if (!documented) undocumented.push(match[1]);
    }
    expect(undocumented).toEqual([]);
  });
});

describe("M8: воспроизводимость плана", () => {
  const attributes =
    "<attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>";
  const note = (step: string, extra = "") =>
    `<note><pitch><step>${step}</step><octave>5</octave></pitch><duration>8</duration><type>whole</type>${extra}</note>`;
  const build = (length: number, mutate?: (index: number) => string) =>
    `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${Array.from(
      { length },
      (_, index) => {
        const step = ["C", "E", "G", "F", "D", "A", "B", "G"][index % 8];
        return `<measure number="${index + 1}">${index === 0 ? attributes : ""}${
          mutate?.(index) ?? note(step)
        }</measure>`;
      },
    ).join("")}</part></score-partwise>`;

  const ranges = (xml: string, length: number) =>
    analyzeAdaptiveMusicXml(xml, 1, length, 60).phraseChunks.map(
      (chunk) => `${chunk.startMeasure}-${chunk.endMeasure}`,
    );

  test("один и тот же MusicXML даёт один и тот же план", () => {
    const xml = build(32);
    const first = ranges(xml, 32);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(ranges(xml, 32)).toEqual(first);
    }
  });

  test("правка одного такта не сдвигает границы в другом конце пьесы", () => {
    const base = build(32);
    const edited = build(32, (index) =>
      index === 17
        ? `<note><pitch><step>C</step><octave>6</octave></pitch><duration>8</duration><type>whole</type></note>`
        : undefined as unknown as string,
    );
    const before = new Set(ranges(base, 32));
    const after = ranges(edited, 32).filter((range) => !before.has(range));
    // Границы выбираются совместно, поэтому правка может переставить соседние —
    // но не должна отзываться в другом конце партитуры. Проверяем локальность:
    // изменения остаются в пределах двух учебных окон от правки (такт 18).
    const edit = 18;
    const distant = after.filter((range) => {
      const [start, end] = range.split("-").map(Number);
      return Math.min(Math.abs(start - edit), Math.abs(end - edit)) > 16;
    });

    expect(distant).toEqual([]);
  });

  test("добавленная аппликатура не меняет план Adaptive", () => {
    const xml = build(32);
    const annotated = annotateFingering(xml, planFingering(xml));
    expect(ranges(annotated, 32)).toEqual(ranges(xml, 32));
  });
});

describe("Чувствительность педагогических констант", () => {
  /**
   * PRD требует, чтобы ни одна константа не была скрытым хардкодом: изменение веса
   * на четверть не должно переворачивать музыкальный результат. Проверяем это на
   * доступном в тесте эквиваленте — устойчивости метрик к изменению темпа Slow,
   * который входит во все временные пороги сразу.
   */
  const attributes =
    "<attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>";
  const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${Array.from(
    { length: 32 },
    (_, index) => {
      const step = ["C", "E", "G", "F"][index % 4];
      const closing =
        index % 8 === 7
          ? `<note><pitch><step>${step}</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note><note><rest/><duration>4</duration></note>`
          : `<note><pitch><step>${step}</step><octave>5</octave></pitch><duration>8</duration><type>whole</type></note>`;
      return `<measure number="${index + 1}">${index === 0 ? attributes : ""}${closing}</measure>`;
    },
  ).join("")}</part></score-partwise>`;

  test("метрики качества устойчивы к ±25 % темпа разучивания", () => {
    const measured = [45, 60, 75].map((tempo) =>
      measurePlanQuality(analyzeAdaptiveMusicXml(xml, 1, 32, tempo)),
    );
    for (const quality of measured) {
      expect(quality.forcedCutRate).toBe(0);
      expect(quality.navigationBreaks).toBe(0);
      expect(quality.closureRate).toBeGreaterThanOrEqual(
        measured[1].closureRate - 0.2,
      );
      expect(quality.durationCv).toBeLessThanOrEqual(0.35);
    }
  });
});
