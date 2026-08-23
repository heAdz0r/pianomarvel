import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  analyzeScoreFingering,
  buildFingeredScore,
  readScoreContainer,
  stripAlternativeFingering,
  targetPathFor,
  uploadTargetPathFor,
} from "./fingering-xml";
import { analyzeFingeringCoverage } from "./fingering";
import { parseScore } from "./fingering-score";

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pm-fingering-test-"));
  scratch.push(dir);
  return dir;
}

const NOTES = [60, 62, 64, 65, 67, 69, 71, 72];

function scoreXml(withFingering: boolean): string {
  const steps: Array<[string, number]> = [
    ["C", 4], ["D", 4], ["E", 4], ["F", 4], ["G", 4], ["A", 4], ["B", 4], ["C", 5],
  ];
  const notes = steps
    .map(
      ([step, octave], index) =>
        `      <note>\n` +
        `        <pitch><step>${step}</step><octave>${octave}</octave></pitch>\n` +
        `        <duration>1</duration>\n` +
        `        <voice>1</voice>\n` +
        `        <type>quarter</type>\n` +
        `        <staff>1</staff>\n` +
        (withFingering
          ? `        <notations>\n          <technical>\n            <fingering>${(index % 5) + 1}</fingering>\n          </technical>\n        </notations>\n`
          : "") +
        `      </note>`,
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<score-partwise version="4.0">\n` +
    `  <identification><encoding><software>test</software></encoding></identification>\n` +
    `  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>\n` +
    `  <part id="P1">\n` +
    `    <measure number="1">\n` +
    `      <attributes><divisions>1</divisions><key><fifths>0</fifths></key>` +
    `<time><beats>4</beats><beat-type>4</beat-type></time><staves>1</staves></attributes>\n` +
    notes +
    `\n    </measure>\n  </part>\n</score-partwise>\n`
  );
}

function polyphonicChordXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><staves>2</staves></attributes>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>4</duration><voice>5</voice><staff>2</staff></note>
      <note><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>5</voice><staff>2</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><voice>6</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>
`;
}

async function makeMxl(dir: string, name: string, withFingering: boolean): Promise<string> {
  const stage = join(dir, `${name}-stage`);
  await mkdir(join(stage, "META-INF"), { recursive: true });
  await writeFile(join(stage, "mimetype"), "application/vnd.recordare.musicxml", "ascii");
  await writeFile(
    join(stage, "META-INF", "container.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<container><rootfiles>` +
      `<rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>` +
      `</rootfiles></container>\n`,
    "utf8",
  );
  await writeFile(join(stage, "score.musicxml"), scoreXml(withFingering), "utf8");
  const target = join(dir, `${name}.mxl`);
  await Bun.spawn(["zip", "-q", "-X", "-0", target, "mimetype"], { cwd: stage }).exited;
  await Bun.spawn(["zip", "-q", "-X", "-r", target, "META-INF", "score.musicxml"], { cwd: stage })
    .exited;
  return target;
}

async function hash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function zipEntries(path: string): Promise<string[]> {
  const proc = Bun.spawn(["unzip", "-Z1", path], { stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.split(/\r?\n/).filter(Boolean);
}

describe("сборка нового .mxl", () => {
  test("анализ возвращает готовый MusicXML-предпросмотр без записи на диск", async () => {
    const dir = await workspace();
    const source = await makeMxl(dir, "score", false);
    const before = await hash(source);

    const result = await analyzeScoreFingering(source);

    expect(result.xml).not.toContain("<fingering");
    expect((result.previewXml.match(/<fingering\b/g) ?? []).length).toBe(NOTES.length);
    expect(parseScore(result.previewXml).notes.map((note) => note.fingering)).toEqual([
      1, 2, 3, 1, 2, 3, 4, 5,
    ]);
    expect(await hash(source)).toBe(before);
    expect(existsSync(join(dir, "fingered"))).toBe(false);
  });

  test("оригинал не меняется, рядом появляется fingered/", async () => {
    const dir = await workspace();
    const source = await makeMxl(dir, "score", false);
    const before = await hash(source);

    const result = await buildFingeredScore(source);

    expect(result.path).toBe(targetPathFor(source));
    expect(result.uploadPath).toBe(uploadTargetPathFor(source));
    expect(result.path).toContain(`${join("", "fingered")}`);
    expect(result.uploadPath).toContain(join("fingered", "piano-marvel"));
    expect(await hash(source)).toBe(before);
  });

  test("контейнер валиден: mimetype первым, container.xml на месте", async () => {
    const dir = await workspace();
    const source = await makeMxl(dir, "score", false);
    const result = await buildFingeredScore(source);

    const entries = await zipEntries(result.path);
    expect(entries[0]).toBe("mimetype");
    expect(entries).toContain("META-INF/container.xml");
    expect(entries).toContain("score.musicxml");
    expect((await zipEntries(result.uploadPath))[0]).toBe("mimetype");
  });

  test("в новом файле все ноты и полная аппликатура", async () => {
    const dir = await workspace();
    const source = await makeMxl(dir, "score", false);
    const result = await buildFingeredScore(source);

    const container = await readScoreContainer(result.path);
    expect(result.previewXml).toBe(container.xml);
    expect(parseScore(container.xml).notes.length).toBe(NOTES.length);
    const coverage = analyzeFingeringCoverage(container.xml);
    expect(coverage.annotatedNotes).toBe(NOTES.length);
    expect(coverage.hasFingering).toBe(true);
    await rm(container.workDir as string, { recursive: true, force: true });
  });

  test("режим rebuild стирает авторские цифры и ставит свои", async () => {
    const dir = await workspace();
    const source = await makeMxl(dir, "score", true);
    const before = await hash(source);

    const result = await buildFingeredScore(source, { mode: "rebuild" });
    expect(result.path).toBe(targetPathFor(source));
    expect(await hash(source)).toBe(before);

    const container = await readScoreContainer(result.path);
    expect((container.xml.match(/<fingering/g) ?? []).length).toBe(NOTES.length);
    // Гамма до мажор: наша модель ставит 1-2-3-1-2-3-4-5, а не исходное 1-2-3-4-5-1-2-3.
    const fingers = parseScore(container.xml).notes.map((note) => note.fingering);
    expect(fingers).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
    expect(result.plan.report.existing).toEqual({ matched: 3, total: NOTES.length });
    await rm(container.workDir as string, { recursive: true, force: true });
  });

  test("режим fill не трогает авторские цифры", async () => {
    const dir = await workspace();
    const source = await makeMxl(dir, "score", true);
    const result = await buildFingeredScore(source, { mode: "fill" });

    const container = await readScoreContainer(result.path);
    const fingers = parseScore(container.xml).notes.map((note) => note.fingering);
    expect(fingers).toEqual([1, 2, 3, 4, 5, 1, 2, 3]);
    expect(container.xml).toContain("<fingering>1</fingering>");
    expect(container.xml).not.toContain('font-size="8"');
    await rm(container.workDir as string, { recursive: true, force: true });
  });

  test("цифры размечены по нотоносцу и без «висящих» координат", async () => {
    const dir = await workspace();
    const source = await makeMxl(dir, "score", false);
    const result = await buildFingeredScore(source);

    const container = await readScoreContainer(result.path);
    expect(container.xml).toContain(
      '<fingering placement="above" font-size="8" relative-y="2">',
    );
    expect(container.xml).not.toMatch(/<fingering[^>]*default-[xy]=/);
    // Читаемость: каждая цифра на своей строке с отступом партитуры.
    expect(container.xml).toMatch(
      /\n\s+<fingering placement="above" font-size="8" relative-y="2">1<\/fingering>\n/,
    );
    await rm(container.workDir as string, { recursive: true, force: true });
  });

  test("на композицию остаются ровно ресурсная и PM-совместимая версии", async () => {
    const dir = await workspace();
    const source = await makeMxl(dir, "score", true);

    const fill = await buildFingeredScore(source, { mode: "fill" });
    const rebuild = await buildFingeredScore(source, { mode: "rebuild" });
    expect(rebuild.path).toBe(fill.path);

    const produced = (await readdir(join(dir, "fingered"))).sort();
    expect(produced).toEqual(["piano-marvel", "score.mxl"]);
    expect(await readdir(join(dir, "fingered", "piano-marvel"))).toEqual(["score.mxl"]);
  });

  test("сборка из уже сгенерированного файла не создаёт вложенную папку", async () => {
    const dir = await workspace();
    const source = await makeMxl(dir, "score", false);
    const first = await buildFingeredScore(source);

    // После загрузки в кеше лежит именно производный файл — повторный запуск
    // должен перезаписать его, а не уехать в fingered/fingered.
    const again = await buildFingeredScore(first.path, { mode: "rebuild" });
    expect(again.path).toBe(first.path);
    expect(existsSync(join(dir, "fingered", "fingered"))).toBe(false);
    expect((await readdir(join(dir, "fingered"))).sort()).toEqual([
      "piano-marvel",
      "score.mxl",
    ]);

    const container = await readScoreContainer(again.path);
    expect((container.xml.match(/<fingering/g) ?? []).length).toBe(NOTES.length);
    await rm(container.workDir as string, { recursive: true, force: true });
  });

  test("несжатый .musicxml тоже превращается в .mxl", async () => {
    const dir = await workspace();
    const source = join(dir, "plain.musicxml");
    await writeFile(source, scoreXml(false), "utf8");

    const result = await buildFingeredScore(source);
    expect(result.path.endsWith(".mxl")).toBe(true);
    const entries = await zipEntries(result.path);
    expect(entries[0]).toBe("mimetype");
    expect(entries).toContain("plain.musicxml");
  });

  test("параллельные сборки одного target сериализуются без общего staging", async () => {
    const dir = await workspace();
    const source = await makeMxl(dir, "score", true);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        buildFingeredScore(source, { mode: index % 2 === 0 ? "fill" : "rebuild" }),
      ),
    );

    expect(new Set(results.map((result) => result.path)).size).toBe(1);
    expect((await readdir(join(dir, "fingered"))).sort()).toEqual([
      "piano-marvel",
      "score.mxl",
    ]);
    const container = await readScoreContainer(results[0].path);
    expect(parseScore(container.xml).notes.length).toBe(NOTES.length);
    expect((container.xml.match(/<fingering/g) ?? []).length).toBe(NOTES.length);
    await rm(container.workDir as string, { recursive: true, force: true });
  });

  test("PM-версия собирает одновременные голоса в одну колонку цифр", async () => {
    const dir = await workspace();
    const source = join(dir, "polyphonic.musicxml");
    await writeFile(source, polyphonicChordXml(), "utf8");

    const result = await buildFingeredScore(source);
    const resource = await readScoreContainer(result.path);
    const upload = await readScoreContainer(result.uploadPath);
    const resourceNotes = parseScore(resource.xml).notes;
    const uploadNotes = parseScore(upload.xml).notes;

    expect(resourceNotes.map((note) => (note.body.match(/<fingering\b/g) ?? []).length))
      .toEqual([1, 1, 1, 1]);
    expect(uploadNotes.map((note) => (note.body.match(/<fingering\b/g) ?? []).length))
      .toEqual([1, 3, 0, 0]);
    const lowerDigits = [...uploadNotes[1]!.body.matchAll(/<fingering\b[^>]*>([1-5])<\/fingering>/g)]
      .map((match) => Number(match[1]));
    const expectedLowerDigits = resourceNotes
      .slice(1)
      .sort((left, right) => (right.midi ?? -Infinity) - (left.midi ?? -Infinity))
      .flatMap((note) => {
        const finger = result.plan.assignments.get(note.index);
        return finger === undefined ? [] : [finger];
      });
    expect(lowerDigits).toEqual(expectedLowerDigits);
    expect(upload.xml).not.toContain("alternate=");
    expect(upload.xml).not.toMatch(/<fingering\b[^>]*>\s*\([1-5]\)/);

    await rm(resource.workDir as string, { recursive: true, force: true });
    await rm(upload.workDir as string, { recursive: true, force: true });
  });

  test("устаревшие альтернативы удаляются, классические цифры остаются", () => {
    const xml = scoreXml(true).replace(
      "<fingering>1</fingering>",
      '<fingering>1</fingering><fingering alternate="yes">3</fingering><fingering>(4)</fingering>',
    );
    const cleaned = stripAlternativeFingering(xml);

    expect(cleaned).toContain("<fingering>1</fingering>");
    expect(cleaned).not.toContain("alternate=");
    expect(cleaned).not.toContain("<fingering>(4)</fingering>");
  });
});
