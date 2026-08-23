import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { benchmarkFingering } from "./fingering-bench";

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTechnicalScaleCorpus(prefix = "pm-fingering-bench-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(directory);
  const path = join(directory, "scale.musicxml");
  const notes = ["C", "D", "E", "F", "G", "A", "B", "C"]
    .map(
      (step, index) =>
        `<note><pitch><step>${step}</step><octave>${index === 7 ? 5 : 4}</octave></pitch>` +
        `<duration>1</duration><voice>1</voice><staff>1</staff><notations><technical>` +
        `<fingering>${[1, 2, 3, 1, 2, 3, 4, 5][index]}</fingering>` +
        `</technical></notations></note>`,
    )
    .join("");
  await writeFile(
    path,
    `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>1</staves></attributes>${notes}</measure></part>` +
      `</score-partwise>`,
  );
  return directory;
}

test("bench рекурсивно читает корпус и считает авторское совпадение", async () => {
  const directory = await makeTechnicalScaleCorpus();
  const rows = await benchmarkFingering([directory]);
  expect(rows).toHaveLength(1);
  expect(rows[0].attacks).toBe(8);
  expect(rows[0].suppressed).toBe(0);
  expect(rows[0].notes).toBe(8);
  expect(rows[0].reference).toBe("technical");
  expect(rows[0].authored).toBe(8);
  expect(rows[0].matched).toBe(8);
  expect(rows[0].agreement).toBe(1);
});

test("bench разделяет эргономику и педагогический вклад полной цели", async () => {
  const directory = await makeTechnicalScaleCorpus("pm-fingering-bench-costs-");
  const [row] = await benchmarkFingering([directory]);

  expect(row.ergonomicCostPerNote).toBeGreaterThan(0);
  expect(row.costPerNote).toBeCloseTo(
    row.ergonomicCostPerNote + row.pedagogyAdjustmentPerNote,
    2,
  );
  expect(row.costPerNote).not.toBe(row.ergonomicCostPerNote);
});

test("JSON bench сохраняет старую objective-метрику и добавляет сопоставимые поля", async () => {
  const directory = await makeTechnicalScaleCorpus("pm-fingering-bench-json-");
  const [row] = await benchmarkFingering([directory]);
  const serialized = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;

  expect(serialized.costPerNote).toBe(row.costPerNote);
  expect(serialized.ergonomicCostPerNote).toBe(row.ergonomicCostPerNote);
  expect(serialized.pedagogyAdjustmentPerNote).toBe(row.pedagogyAdjustmentPerNote);
  expect(
    Object.keys(serialized).filter((key) =>
      [
        "costPerNote",
        "ergonomicCostPerNote",
        "pedagogyAdjustmentPerNote",
      ].includes(key),
    ),
  ).toMatchInlineSnapshot(`
    [
      "costPerNote",
      "ergonomicCostPerNote",
      "pedagogyAdjustmentPerNote",
    ]
  `);
});

test("bench принимает плотные numeric lyrics за переносимый gold corpus", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pm-fingering-bench-lyrics-"));
  scratch.push(directory);
  const path = join(directory, "scale-lyrics.musicxml");
  const fingers = [1, 2, 3, 1, 2, 3, 4, 5];
  const notes = ["C", "D", "E", "F", "G", "A", "B", "C"]
    .map(
      (step, index) =>
        `<note><pitch><step>${step}</step><octave>${index === 7 ? 5 : 4}</octave></pitch>` +
        `<duration>1</duration><voice>1</voice><staff>1</staff>` +
        `<lyric><text>${fingers[index]}</text></lyric></note>`,
    )
    .join("");
  await writeFile(
    path,
    `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>1</staves></attributes>${notes}</measure></part>` +
      `</score-partwise>`,
  );

  const rows = await benchmarkFingering([directory]);
  expect(rows).toHaveLength(1);
  expect(rows[0].reference).toBe("numeric-lyrics");
  expect(rows[0].authored).toBe(8);
  expect(rows[0].matched).toBe(8);
  expect(rows[0].agreement).toBe(1);
});

test("bench не принимает единичную цифру обычной лирики за аппликатуру", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pm-fingering-bench-song-"));
  scratch.push(directory);
  const path = join(directory, "song.musicxml");
  await writeFile(
    path,
    `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>1</staves></attributes>` +
      `<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration>` +
      `<voice>1</voice><staff>1</staff><lyric><text>1</text></lyric></note>` +
      `</measure></part></score-partwise>`,
  );

  const rows = await benchmarkFingering([directory]);
  expect(rows[0].reference).toBeNull();
  expect(rows[0].authored).toBe(0);
});

test("bench не включает производные партитуры из каталогов fingered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pm-fingering-bench-output-"));
  scratch.push(directory);
  const generated = join(directory, "fingered");
  await mkdir(generated);
  const xml =
    `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
    `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
    `<divisions>1</divisions><staves>1</staves></attributes>` +
    `<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration>` +
    `<voice>1</voice><staff>1</staff></note></measure></part></score-partwise>`;
  await writeFile(join(directory, "source.musicxml"), xml);
  await writeFile(join(generated, "source.musicxml"), xml);

  const rows = await benchmarkFingering([directory]);
  expect(rows).toHaveLength(1);
  expect(rows[0].path).toBe(join(directory, "source.musicxml"));
  expect(await benchmarkFingering([generated])).toEqual([]);
});
