import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adaptivePlanCacheStats,
  analyzeAdaptiveMusicXml,
  buildAdaptiveLearningPlan,
  clearAdaptivePlanCache,
} from "./adaptive-learning";

function note(step: string, type = "quarter", extra = ""): string {
  return `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><type>${type}</type>${extra}</note>`;
}

function score(measures: string[]): string {
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${measures
    .map((body, index) => `<measure number="${index + 1}">${body}</measure>`)
    .join("")}</part></score-partwise>`;
}

describe("Adaptive MusicXML segmentation", () => {
  test("соблюдает структурную границу и добавляет упражнение на переход", () => {
    const xml = score([
      `<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${note("C")}`,
      note("D"),
      note("E"),
      `${note("F")}<barline location="right"><bar-style>light-light</bar-style><repeat direction="backward"/></barline>`,
      `<direction><direction-type><rehearsal>B</rehearsal></direction-type></direction>${note("G")}`,
      ["C", "G", "D", "A", "E", "B", "F", "C"].map((pitch) => note(pitch, "16th")).join(""),
      note("D", "eighth", "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>"),
      `${note("C")}<notations><fermata/></notations>`,
    ]);

    const plan = analyzeAdaptiveMusicXml(xml, 1, 8);

    expect(plan.phraseChunks.some((chunk) => chunk.endMeasure === 4)).toBe(true);
    expect(plan.bridgeChunks.length).toBeGreaterThan(0);
    expect(
      plan.phraseChunks.slice(0, -1).every((chunk, index) =>
        plan.bridgeChunks.some(
          (bridge) =>
            bridge.startMeasure <= chunk.endMeasure &&
            bridge.endMeasure >= plan.phraseChunks[index + 1].startMeasure,
        ),
      ),
    ).toBe(true);
    // Короткие английские заголовки: A1, A.Bridge, A.Review, A.Summarize.
    expect(
      plan.chunks.every((chunk) =>
        /^A(?:\d+|\.(?:Bridge|Review|Summarize))\b/.test(chunk.title),
      ),
    ).toBe(true);
    expect(plan.chunks.every((chunk) => !/[А-Яа-я]/.test(chunk.title))).toBe(true);
    // CHANGED: монотонность конца такта — свойство порядка `score`, а не плана
    // вообще. В нём весь список читается как партитура, иначе PM скрывает поздно
    // добавленные Summarize с меньшим endMeasure после завершившего пьесу Review.
    const byScore = analyzeAdaptiveMusicXml(xml, 1, 8, undefined, "score");
    expect(
      byScore.chunks.every(
        (chunk, index) => index === 0 || chunk.endMeasure >= byScore.chunks[index - 1].endMeasure,
      ),
    ).toBe(true);
    expect(plan.summaryChunks.every((summary) => plan.chunks.includes(summary))).toBe(true);
    expect(plan.measures[5].load).toBeGreaterThan(plan.measures[1].load);
    expect(plan.confidence).not.toBe("low");
  });

  test("обзорные куски собирают фразы и покрывают партитуру до конца", () => {
    const xml = score(
      Array.from({ length: 24 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const barline =
          index === 7 || index === 15
            ? '<barline location="right"><bar-style>light-light</bar-style></barline>'
            : "";
        return `${attributes}${["C", "D", "E", "F"].map((pitch) => note(pitch)).join("")}${barline}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 24);

    expect(plan.reviewChunks.length).toBeGreaterThan(1);
    // Обзоры идут подряд и вместе накрывают всю партитуру без дыр и без хвоста.
    const ordered = [...plan.reviewChunks].sort((a, b) => a.startMeasure - b.startMeasure);
    expect(ordered[0].startMeasure).toBe(1);
    expect(ordered[ordered.length - 1].endMeasure).toBe(24);
    for (const [index, review] of ordered.entries()) {
      expect(review.endMeasure - review.startMeasure + 1).toBeGreaterThanOrEqual(8);
      if (index === 0) continue;
      expect(review.startMeasure).toBe(ordered[index - 1].endMeasure + 1);
    }
    // Каждый обзор длиннее отдельной фразы — иначе он не «большой кусок».
    const longestPhrase = Math.max(
      ...plan.phraseChunks.map((chunk) => chunk.endMeasure - chunk.startMeasure + 1),
    );
    expect(
      Math.max(...plan.reviewChunks.map((chunk) => chunk.endMeasure - chunk.startMeasure + 1)),
    ).toBeGreaterThan(longestPhrase);
    expect(plan.summaryChunks).toHaveLength(3);
    expect(plan.summaryChunks.map((chunk) => [chunk.startMeasure, chunk.endMeasure])).toEqual([
      [1, 8],
      [9, 16],
      [17, 24],
    ]);
    // CHANGED: инвариант монотонного endMeasure проверяется на порядке `score`.
    const byScore = analyzeAdaptiveMusicXml(xml, 1, 24, undefined, "score");
    expect(
      byScore.chunks.every(
        (chunk, index) => index === 0 || chunk.endMeasure >= byScore.chunks[index - 1].endMeasure,
      ),
    ).toBe(true);
  });

  test("оставляет один итоговый Review, если композиция содержит только две фразы", () => {
    const xml = score(
      Array.from({ length: 8 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        return `${attributes}${note(["C", "D", "E", "F"][index % 4])}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 8, 60);

    expect(plan.phraseChunks).toHaveLength(2);
    expect(plan.reviewChunks.map((chunk) => [chunk.startMeasure, chunk.endMeasure])).toEqual([
      [1, 8],
    ]);
  });

  test("не оставляет короткий хвостовой Review после структурных групп", () => {
    const xml = score(
      Array.from({ length: 19 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        return `${attributes}${note(["C", "D", "E", "F"][index % 4])}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 19, 60);

    expect(
      plan.reviewChunks.every(
        (chunk) => chunk.endMeasure - chunk.startMeasure + 1 >= 8,
      ),
    ).toBe(true);
    expect(plan.reviewChunks[0].startMeasure).toBe(1);
    expect(plan.reviewChunks.at(-1)?.endMeasure).toBe(19);
  });

  test("кеш плана учитывает темп и возвращает независимую копию", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pianomarvel-plan-cache-"));
    const path = join(dir, "score.musicxml");
    const xml = score(
      Array.from({ length: 8 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        return `${attributes}${note(["C", "D", "E", "F"][index % 4])}`;
      }),
    );
    try {
      await writeFile(path, xml);
      clearAdaptivePlanCache();
      const first = await buildAdaptiveLearningPlan(path, 1, 8, 60);
      first.phraseChunks[0].title = "mutated";
      const cached = await buildAdaptiveLearningPlan(path, 1, 8, 60);

      expect(cached.phraseChunks[0].title).not.toBe("mutated");
      expect(adaptivePlanCacheStats()).toEqual({ entries: 1, computations: 1 });

      await buildAdaptiveLearningPlan(path, 1, 8, 72);
      expect(adaptivePlanCacheStats()).toEqual({ entries: 2, computations: 2 });
    } finally {
      clearAdaptivePlanCache();
      await rm(dir, { recursive: true });
    }
  });

  test("останавливается до изменения Piano Marvel при несовпадении числа тактов", () => {
    expect(() => analyzeAdaptiveMusicXml(score([note("C"), note("D")]), 1, 3)).toThrow(
      "MusicXML содержит 2 тактов",
    );
  });

  test("нулевой диапазон Whole — это «ещё не вычислен», а не пьеса из одного такта", () => {
    // Свежезагруженная композиция приходит из Piano Marvel как Whole 0-0: сервер ещё
    // не посчитал такты. Сравнивать нечего, поэтому границы берутся из MusicXML —
    // прежде проверка читала это как «Whole — 1 такт» и отказывалась работать.
    const xml = score(Array.from({ length: 8 }, (_, index) => note(index % 2 ? "D" : "C")));

    const plan = analyzeAdaptiveMusicXml(xml, 0, 0);

    expect(plan.phraseChunks.length).toBeGreaterThan(0);
    expect(plan.phraseChunks[0].startMeasure).toBe(1);
    expect(Math.max(...plan.phraseChunks.map((chunk) => chunk.endMeasure))).toBe(8);
  });

  test("настоящее несовпадение по-прежнему останавливает работу", () => {
    expect(() => analyzeAdaptiveMusicXml(score([note("C"), note("D")]), 0, 5)).toThrow(
      "MusicXML содержит 2 тактов",
    );
  });

  test("не склеивает две фразы, отмеченные мягкими окончаниями slur", () => {
    const xml = score(
      Array.from({ length: 12 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const phraseEnd =
          index === 3 || index === 7
            ? "<notations><slur type=\"stop\" number=\"1\"/></notations>"
            : "";
        return `${attributes}${note(["C", "D", "E", "F"][index % 4], "quarter", phraseEnd)}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 12, 60);

    expect(plan.phraseChunks.map((chunk) => [chunk.startMeasure, chunk.endMeasure])).toEqual([
      [1, 4],
      [5, 8],
      [9, 12],
    ]);
  });

  test("создаёт bridge на каждой явной внутренней границе раздела", () => {
    const xml = score(
      Array.from({ length: 12 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const barline =
          index === 3 || index === 7
            ? "<barline location=\"right\"><bar-style>light-light</bar-style></barline>"
            : "";
        return `${attributes}${note("C")}${barline}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 12, 60);

    expect(
      plan.bridgeChunks.some(
        (chunk) => chunk.startMeasure <= 4 && chunk.endMeasure >= 5,
      ),
    ).toBe(true);
    expect(
      plan.bridgeChunks.some(
        (chunk) => chunk.startMeasure <= 8 && chunk.endMeasure >= 9,
      ),
    ).toBe(true);
  });

  test("сохраняет протяжённый rallentando одной Phrase и тренирует вход расширенным Bridge", () => {
    const xml = score(
      Array.from({ length: 16 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const rallentando =
          index === 4
            ? `<direction><direction-type><words>rall.</words></direction-type><direction-type><dashes type="start" number="2"/></direction-type></direction>`
            : index === 9
              ? `<direction><direction-type><dashes type="stop" number="2"/></direction-type></direction>`
              : index === 10
                ? `<direction><direction-type><words>a tempo</words></direction-type><sound tempo="120"/></direction>`
                : "";
        return `${attributes}${rallentando}${note(["C", "D", "E", "F"][index % 4])}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 16, 60);

    expect(
      plan.phraseChunks.some(
        (chunk) => chunk.startMeasure === 5 && chunk.endMeasure === 10,
      ),
    ).toBe(true);
    expect(
      plan.phraseChunks.some(
        (chunk) => chunk.startMeasure > 5 && chunk.startMeasure <= 10,
      ),
    ).toBe(false);
    expect(plan.measures[3].boundaryReasonsAfter).toContain(
      "начало rallentando",
    );
    expect(
      plan.measures
        .slice(4, 9)
        .every((measure) => measure.expressiveTempoContinuesAfter),
    ).toBe(true);
    expect(
      plan.bridgeChunks.some(
        (chunk) => chunk.startMeasure === 3 && chunk.endMeasure === 6,
      ),
    ).toBe(true);
  });

  test("понимает rit. без dashed-линии и отдельно тренирует внутренний a tempo", () => {
    const xml = score(
      Array.from({ length: 12 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const tempo =
          index === 4
            ? "<direction><direction-type><words>rit.</words></direction-type></direction>"
            : index === 6
              ? '<direction><direction-type><words>a tempo</words></direction-type><sound tempo="120"/></direction>'
              : "";
        return `${attributes}${tempo}${note(["C", "D", "E", "F"][index % 4])}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 12, 60);

    expect(plan.measures[4].expressiveTempoContinuesAfter).toBe(true);
    expect(plan.measures[5].expressiveTempoContinuesAfter).toBe(false);
    expect(plan.measures[6].transitionLabelsBefore).toContain("a tempo");
    expect(
      plan.bridgeChunks.some(
        (chunk) => chunk.startMeasure <= 5 && chunk.endMeasure >= 7,
      ),
    ).toBe(true);
  });

  test("отличает динамический cresc. dashed-span от tempo gesture", () => {
    const xml = score(
      Array.from({ length: 8 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const dynamic =
          index === 1
            ? '<direction><direction-type><words>cresc.</words></direction-type><direction-type><dashes type="start" number="1"/></direction-type></direction>'
            : index === 3
              ? '<direction><direction-type><dashes type="stop" number="1"/></direction-type></direction>'
              : "";
        return `${attributes}${dynamic}${note("C")}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 8, 60);

    expect(plan.measures[1].expressiveTempoStarts.length).toBe(0);
    expect(plan.measures[1].dynamicGestureStarts[0]?.label).toBe("crescendo");
    expect(plan.measures[1].dynamicGestureContinuesAfter).toBe(true);
    expect(plan.measures[2].dynamicGestureContinuesAfter).toBe(true);
  });

  test("изолирует одинаковые номера dashed-lines в разных партиях", () => {
    const measures = Array.from({ length: 6 }, (_, index) => {
      const attributes =
        index === 0
          ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
          : "";
      const tempo =
        index === 1
          ? '<direction><direction-type><words>rall.</words></direction-type><direction-type><dashes type="start" number="1"/></direction-type></direction>'
          : index === 4
            ? '<direction><direction-type><dashes type="stop" number="1"/></direction-type></direction>'
            : "";
      return `<measure number="${index + 1}">${attributes}${tempo}${note("C")}</measure>`;
    }).join("");
    const otherPart = Array.from({ length: 6 }, (_, index) => {
      const unrelatedStop =
        index === 2
          ? '<direction><direction-type><dashes type="stop" number="1"/></direction-type></direction>'
          : "";
      return `<measure number="${index + 1}">${unrelatedStop}${note("E")}</measure>`;
    }).join("");
    const xml = `<?xml version="1.0"?><score-partwise version="4.0">
      <part-list>
        <score-part id="P1"><part-name>Piano RH</part-name></score-part>
        <score-part id="P2"><part-name>Piano LH</part-name></score-part>
      </part-list>
      <part id="P1">${measures}</part><part id="P2">${otherPart}</part>
    </score-partwise>`;

    const plan = analyzeAdaptiveMusicXml(xml, 1, 6, 60);

    expect(plan.measures[2].expressiveTempoContinuesAfter).toBe(true);
    expect(plan.measures[3].expressiveTempoContinuesAfter).toBe(true);
    expect(plan.measures[4].expressiveTempoContinuesAfter).toBe(false);
  });

  test("не принимает внутренний tie-start за перенос через тактовую черту", () => {
    const xml = score([
      `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${note("C", "quarter", '<tie type="start"/>')}${note("D")}`,
      note("E"),
      note("F"),
      note("G"),
    ]);

    const plan = analyzeAdaptiveMusicXml(xml, 1, 4, 60);

    expect(plan.measures[0].tiedIntoNext).toBe(false);
    expect(plan.measures[0].forbiddenAfter).toBe(false);
  });

  test("не считает локальную лигу только в нижнем нотоносце сильной фразовой границей", () => {
    const lowerSlur = `<note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>1</voice><staff>2</staff><notations><slur type="stop" number="1"/></notations></note>`;
    const xml = score([
      `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${lowerSlur}`,
      note("D"),
      note("E"),
      note("F"),
    ]);

    const plan = analyzeAdaptiveMusicXml(xml, 1, 4, 60);

    expect(plan.measures[0].slurBoundaryStrength).toBe(0);
    expect(
      plan.measures[0].boundaryReasonsAfter.some((reason) => reason.includes("лиги")),
    ).toBe(false);
  });

  test("отслеживает длинную мелодическую лигу как мягкую связность", () => {
    const xml = score(
      Array.from({ length: 10 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const slur =
          index === 1
            ? '<notations><slur type="start" number="3"/></notations>'
            : index === 5
              ? '<notations><slur type="stop" number="3"/></notations>'
              : "";
        return `${attributes}${note("C", "quarter", slur)}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 10, 60);

    expect(
      plan.measures
        .slice(1, 5)
        .every((measure) => measure.melodicSlurContinuesAfter),
    ).toBe(true);
    expect(plan.measures[5].melodicSlurContinuesAfter).toBe(false);
    expect(plan.measures[5].boundaryReasonsAfter).toContain(
      "конец длинной мелодической лиги",
    );
  });

  test("учитывает позицию sound tempo внутри такта", () => {
    const xml = score([
      `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${note("C", "whole")}`,
      `<note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>80</per-minute></metronome></direction-type><sound tempo="80"/></direction>`,
      note("E", "whole"),
      note("F", "whole"),
    ]);

    const plan = analyzeAdaptiveMusicXml(xml, 1, 4, 60);

    expect(plan.measures[0].boundaryReasonsAfter).not.toContain("смена темпа");
    expect(plan.measures[1].boundaryReasonsAfter).toContain(
      "смена темпа в конце такта",
    );
  });

  test("распознаёт D.S./D.C./Fine как формальную навигацию", () => {
    const xml = score([
      `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${note("C")}`,
      note("D"),
      `<direction><direction-type><words>D.S.</words></direction-type></direction>${note("E")}`,
      note("F"),
      `<direction><direction-type><words>Fine</words></direction-type></direction>${note("G")}`,
      note("A"),
    ]);

    const plan = analyzeAdaptiveMusicXml(xml, 1, 6, 60);

    expect(plan.measures[2].boundaryReasonsAfter).toContain("навигация D.S.");
    expect(plan.measures[2].hardBoundaryAfter).toBe(true);
    expect(plan.measures[4].boundaryReasonsAfter).toContain("навигация Fine");
  });

  test("сохраняет связность текстовой фразы через границу chunk", () => {
    const xml = score(
      Array.from({ length: 12 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const phraseEnd =
          index === 3 || index === 7
            ? "<notations><slur type=\"stop\" number=\"1\"/></notations>"
            : "";
        const lyrics =
          index === 7
            ? "<lyric><syllabic>begin</syllabic><text>to</text></lyric>"
            : index === 8
              ? "<lyric><syllabic>end</syllabic><text>night</text></lyric>"
              : "";
        return `${attributes}${note("C", "quarter", `${phraseEnd}${lyrics}`)}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 12, 60);

    expect(plan.measures[7].lyricOpenEnded).toBe(true);
    expect(
      plan.bridgeChunks.some(
        (chunk) => chunk.startMeasure <= 8 && chunk.endMeasure >= 9,
      ),
    ).toBe(true);
  });

  test("не делает смену размера абсолютной границей и не оставляет микрофразу", () => {
    const xml = score(
      Array.from({ length: 12 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : index === 4
              ? "<attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>"
              : index === 5
                ? "<attributes><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
                : "";
        return `${attributes}${note("C")}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 12, 60);

    expect(plan.measures[3].boundaryReasonsAfter).toContain("смена размера");
    expect(plan.measures[3].hardBoundaryAfter).toBe(false);
    expect(
      plan.phraseChunks.every((chunk) => chunk.endMeasure - chunk.startMeasure + 1 >= 2),
    ).toBe(true);
  });

  test("сливает однотактовый хвост между соседними repeat-границами", () => {
    const xml = score(
      Array.from({ length: 10 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const barline =
          index === 3 || index === 4
            ? "<barline location=\"right\"><bar-style>light-heavy</bar-style><repeat direction=\"backward\"/></barline>"
            : "";
        return `${attributes}${note("C")}${barline}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 10, 60);

    expect(
      plan.phraseChunks.every((chunk) => chunk.endMeasure - chunk.startMeasure + 1 >= 2),
    ).toBe(true);
  });

  test("ограничивает длинную цепочку tie и страхует вынужденный cut через Bridge", () => {
    const xml = score(
      Array.from({ length: 20 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const tie = index < 19 ? "<tie type=\"start\"/>" : "<tie type=\"stop\"/>";
        return `${attributes}${note("C", "whole", tie)}`;
      }),
    );

    const plan = analyzeAdaptiveMusicXml(xml, 1, 20, 60);

    expect(
      Math.max(
        ...plan.phraseChunks.map(
          (chunk) => chunk.endMeasure - chunk.startMeasure + 1,
        ),
      ),
    ).toBeLessThanOrEqual(16);
    const forcedCuts = plan.phraseChunks
      .slice(0, -1)
      .filter((chunk) => plan.measures[chunk.endMeasure - 1].forbiddenAfter);
    expect(forcedCuts.length).toBeGreaterThan(0);
    expect(
      forcedCuts.every((chunk) =>
        plan.bridgeChunks.some(
          (bridge) =>
            bridge.startMeasure <= chunk.endMeasure &&
            bridge.endMeasure >= chunk.endMeasure + 1,
        ),
      ),
    ).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes("tie"))).toBe(true);
  });

  test("end_tick не удваивает позицию из-за накопления триольных долей", () => {
    // Фактура первой части Moonlight: двенадцать триольных восьмых в верхнем
    // нотоносце и две половинные в нижнем. В четвертях сумма 1/3 даёт
    // 1.9999999999999998, поэтому позиция «2.0» из второго нотоносца выглядела
    // отдельной, и end_tick для server-method-162 оказывался на единицу больше.
    const triplet = (step: string) =>
      `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>eighth</type><staff>1</staff><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>`;
    const half = (step: string) =>
      `<note><pitch><step>${step}</step><octave>2</octave></pitch><duration>24</duration><voice>2</voice><type>half</type><staff>2</staff></note>`;
    const upper = ["C", "E", "G", "C", "E", "G", "C", "E", "G", "C", "E", "G"]
      .map(triplet)
      .join("");
    const xml = score([
      `<attributes><divisions>12</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${upper}<backup><duration>48</duration></backup>${half("C")}${half("G")}`,
      `${upper}<backup><duration>48</duration></backup>${half("C")}${half("G")}`,
    ]);

    const plan = analyzeAdaptiveMusicXml(xml, 1, 2, 60);

    // Двенадцать триольных позиций; половинные попадают на первую и седьмую из них.
    expect(plan.measures.map((measure) => measure.tickCount)).toEqual([12, 12]);
  });

  test("считает реальную длительность явно помеченного затакта", () => {
    const xml = `<?xml version="1.0"?><score-partwise version="4.0">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1">
        <measure number="0" implicit="yes">
          <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
          <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
        <measure number="1">
          <note><rest/><duration>8</duration><type>whole</type></note>
        </measure>
      </part>
    </score-partwise>`;

    const plan = analyzeAdaptiveMusicXml(xml, 1, 2, 60);

    expect(plan.measures[0].quarterBeats).toBe(1);
    expect(plan.measures[0].estSeconds).toBe(1);
  });

  test("не раздувает Phrase цепочкой коротких кандидатов в быстром размере 3/8", () => {
    const measures = Array.from({ length: 36 }, (_, index) => {
      const attributes =
        index === 0
          ? `<attributes><divisions>2</divisions><time><beats>3</beats><beat-type>8</beat-type></time></attributes>`
          : "";
      const slur = index % 2 === 1 ? `<notations><slur type="stop"/></notations>` : "";
      return `${attributes}${note("C", "eighth", slur)}${note("E", "eighth")}${note("G", "eighth")}`;
    });
    const plan = analyzeAdaptiveMusicXml(score(measures), 1, 36, 108);

    expect(
      Math.max(
        ...plan.phraseChunks.map(
          (chunk) => chunk.endMeasure - chunk.startMeasure + 1,
        ),
      ),
    ).toBeLessThanOrEqual(16);
    expect(
      Math.min(
        ...plan.phraseChunks.map((chunk) =>
          plan.measures
            .slice(chunk.startMeasure - 1, chunk.endMeasure)
            .reduce((sum, measure) => sum + measure.estSeconds, 0),
        ),
      ),
    ).toBeGreaterThanOrEqual(8);
  });
});

describe("Порядок учебного маршрута", () => {
  /** Двадцать четыре такта дают все четыре уровня: Phrase, Bridge, Review, Summarize. */
  function longScore(): string {
    return score(
      Array.from({ length: 24 }, (_, index) => {
        const attributes =
          index === 0
            ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
            : "";
        const barline =
          index === 7 || index === 15
            ? '<barline location="right"><bar-style>light-light</bar-style></barline>'
            : "";
        return `${attributes}${["C", "D", "E", "F"].map((pitch) => note(pitch)).join("")}${barline}`;
      }),
    );
  }

  const stage = (title: string) =>
    /^A\d/.test(title)
      ? 0
      : title.startsWith("A.Bridge")
        ? 1
        : title.startsWith("A.Review")
          ? 2
          : 3;

  test("stage: сперва все отрезки, затем все мостики, затем обзоры и трети", () => {
    const plan = analyzeAdaptiveMusicXml(longScore(), 1, 24, undefined, "stage");

    expect(plan.chunkOrder).toBe("stage");
    expect(plan.bridgeChunks.length).toBeGreaterThan(0);
    expect(plan.reviewChunks.length).toBeGreaterThan(0);
    expect(plan.summaryChunks).toHaveLength(3);

    const stages = plan.chunks.map((chunk) => stage(chunk.title));
    // Уровень не убывает: ни один мостик не стоит между двумя отрезками.
    expect(stages.every((value, index) => index === 0 || value >= stages[index - 1])).toBe(true);
    // Все четыре уровня действительно присутствуют в маршруте.
    expect(new Set(stages)).toEqual(new Set([0, 1, 2, 3]));
    // Последний отрезок раньше первого мостика — это и есть просьба «сперва отрезки».
    expect(stages.lastIndexOf(0)).toBeLessThan(stages.indexOf(1));
  });

  test("stage: внутри каждого уровня сохраняется порядок партитуры", () => {
    const plan = analyzeAdaptiveMusicXml(longScore(), 1, 24, undefined, "stage");

    for (const level of [0, 1, 2, 3]) {
      const ends = plan.chunks
        .filter((chunk) => stage(chunk.title) === level)
        .map((chunk) => chunk.endMeasure);
      expect(ends.every((value, index) => index === 0 || value >= ends[index - 1])).toBe(true);
    }
  });

  test("порядок меняет только последовательность: состав маршрута одинаков", () => {
    const xml = longScore();
    const byStage = analyzeAdaptiveMusicXml(xml, 1, 24, undefined, "stage");
    const byScore = analyzeAdaptiveMusicXml(xml, 1, 24, undefined, "score");

    const key = (chunk: { startMeasure: number; endMeasure: number; title: string }) =>
      `${chunk.startMeasure}:${chunk.endMeasure}:${chunk.title}`;
    expect(byStage.chunks.map(key).sort()).toEqual(byScore.chunks.map(key).sort());
    // Ни одно упражнение не потеряно и не задвоено при перестановке уровней.
    expect(byStage.chunks).toHaveLength(new Set(byStage.chunks.map(key)).size);
    expect(byStage.chunks.length).toBe(
      byStage.phraseChunks.length +
        byStage.bridgeChunks.length +
        byStage.reviewChunks.length +
        byStage.summaryChunks.length,
    );
  });

  test("stage нарушает монотонность endMeasure намеренно, score — нет", () => {
    const xml = longScore();
    const monotonic = (chunks: Array<{ endMeasure: number }>) =>
      chunks.every((chunk, index) => index === 0 || chunk.endMeasure >= chunks[index - 1].endMeasure);

    expect(monotonic(analyzeAdaptiveMusicXml(xml, 1, 24, undefined, "score").chunks)).toBe(true);
    // Ограничение Piano Marvel «строка назад по партитуре не отображается» несовместимо
    // с блочной практикой: фиксируем это как известное свойство, а не как регресс.
    expect(monotonic(analyzeAdaptiveMusicXml(xml, 1, 24, undefined, "stage").chunks)).toBe(false);
  });

  test("порядок входит в ключ кеша плана", async () => {
    clearAdaptivePlanCache();
    const directory = await mkdtemp(join(tmpdir(), "adaptive-order-"));
    const path = join(directory, "score.musicxml");
    await writeFile(path, longScore(), "utf8");
    try {
      await buildAdaptiveLearningPlan(path, 1, 24, undefined, "stage");
      await buildAdaptiveLearningPlan(path, 1, 24, undefined, "stage");
      expect(adaptivePlanCacheStats().computations).toBe(1);
      await buildAdaptiveLearningPlan(path, 1, 24, undefined, "score");
      expect(adaptivePlanCacheStats().computations).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
