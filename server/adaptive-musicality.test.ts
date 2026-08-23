import { describe, expect, test } from "bun:test";
import {
  extractCombinedMeasures,
  extractMeasureNotes,
  quarterBeatsPerMeasure,
} from "./adaptive-notes";
import { analyzeMelody, detectMelodyStream } from "./adaptive-melody";
import { analyzeHarmony, estimateKey, chordSlots } from "./adaptive-harmony";
import {
  analyzeStructure,
  estimateHypermeter,
  fuzzyRepeatStarts,
  fuzzyRepeatMemoryStats,
  maximalRepeats,
  measureFeature,
  noveltyCurve,
  NOVELTY_REFERENCE,
  similarity,
  type MeasureFeature,
} from "./adaptive-structure";
import { analyzeNavigation } from "./adaptive-navigation";
import { analyzeAdaptiveMusicXml, buildPrefix } from "./adaptive-learning";
import { measurePlanQuality } from "./adaptive-quality";

const ATTRIBUTES =
  "<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>";

function pitched(
  step: string,
  octave: number,
  duration: number,
  type: string,
  extra = "",
  staff = "1",
  voice = "1",
): string {
  return `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>${voice}</voice><type>${type}</type><staff>${staff}</staff>${extra}</note>`;
}

/** Ноты аккорда: вторая и последующие получают `<chord/>` — та же позиция во времени. */
function chord(
  steps: Array<[string, number]>,
  duration: number,
  type: string,
  staff = "2",
  voice = "2",
): string {
  return steps
    .map(([step, octave], index) =>
      index === 0
        ? pitched(step, octave, duration, type, "", staff, voice)
        : `<note><chord/><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>${voice}</voice><type>${type}</type><staff>${staff}</staff></note>`,
    )
    .join("");
}

/**
 * Верхний и нижний нотоносцы одного такта. Между ними обязателен `<backup>`: без
 * него курсор остаётся в конце такта и аккомпанемент попадает во второй такт —
 * именно так это и записывают реальные экспортёры.
 */
function stacked(top: string, bottom: string, duration = 8): string {
  return `${top}<backup><duration>${duration}</duration></backup>${bottom}`;
}

function rest(duration: number, staff = "1", voice = "1"): string {
  return `<note><rest/><duration>${duration}</duration><voice>${voice}</voice><staff>${staff}</staff></note>`;
}

function score(measures: string[]): string {
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${measures
    .map((body, index) => `<measure number="${index + 1}">${body}</measure>`)
    .join("")}</part></score-partwise>`;
}

function notesOf(xml: string) {
  const bodies = extractCombinedMeasures(xml);
  return extractMeasureNotes(bodies, quarterBeatsPerMeasure(bodies));
}

describe("Мелодический слой", () => {
  test("ведущим потоком становится верхний голос, а не аккомпанемент", () => {
    const xml = score(
      Array.from({ length: 6 }, (_, index) => {
        const melody = pitched(["C", "D", "E", "F", "G", "A"][index], 5, 8, "whole");
        const accompaniment =
          pitched("C", 3, 2, "quarter", "", "2", "2") +
          pitched("E", 3, 2, "quarter", "", "2", "2") +
          pitched("G", 3, 2, "quarter", "", "2", "2") +
          pitched("E", 3, 2, "quarter", "", "2", "2");
        return `${index === 0 ? ATTRIBUTES : ""}${stacked(melody, accompaniment)}`;
      }),
    );
    const notes = notesOf(xml);

    expect(detectMelodyStream(notes)).toBe("part:0:1:1");
  });

  test("пауза мелодии считается относительно нормы пьесы, а не абсолютно", () => {
    // Мелодия каждого такта занимает половину такта — это фактура, а не конец фразы.
    const uniform = notesOf(
      score(
        Array.from({ length: 8 }, (_, index) =>
          `${index === 0 ? ATTRIBUTES : ""}${pitched("C", 5, 4, "half")}${rest(4)}`,
        ),
      ),
    );
    expect(Math.max(...analyzeMelody(uniform).melodyGapAfter)).toBe(0);

    // Здесь мелодия молчит только после четвёртого такта: это уже граница.
    const single = notesOf(
      score(
        Array.from({ length: 8 }, (_, index) => {
          const body =
            index === 3
              ? `${pitched("C", 5, 4, "half")}${rest(4)}`
              : pitched("C", 5, 8, "whole");
          return `${index === 0 ? ATTRIBUTES : ""}${body}`;
        }),
      ),
    );
    const gaps = analyzeMelody(single).melodyGapAfter;
    expect(gaps[3]).toBeGreaterThanOrEqual(0.5);
    expect(gaps[1]).toBe(0);
  });

  test("LBDM отмечает перелом мелодии на скачке и удлинении длительностей", () => {
    const notes = notesOf(
      score([
        `${ATTRIBUTES}${pitched("C", 5, 2, "quarter")}${pitched("D", 5, 2, "quarter")}${pitched("E", 5, 2, "quarter")}${pitched("F", 5, 2, "quarter")}`,
        `${pitched("C", 6, 8, "whole")}`,
        `${pitched("C", 5, 2, "quarter")}${pitched("D", 5, 2, "quarter")}${pitched("E", 5, 2, "quarter")}${pitched("F", 5, 2, "quarter")}`,
        `${pitched("G", 5, 8, "whole")}`,
      ]),
    );
    const melody = analyzeMelody(notes);

    expect(melody.lbdmAfter[0]).toBeGreaterThan(0);
    expect(melody.longArrivalAfter[1]).toBe(true);
  });
});

describe("Гармонический слой", () => {
  test("тональность выводится из профиля длительностей высот", () => {
    const profile = Array<number>(12).fill(0);
    // Гамма до мажор с опорой на тонику и доминанту.
    for (const [pitchClass, weight] of [
      [0, 6],
      [2, 3],
      [4, 4],
      [5, 3],
      [7, 5],
      [9, 3],
      [11, 2],
    ] as Array<[number, number]>) {
      profile[pitchClass] = weight;
    }
    const key = estimateKey(profile);

    expect(key.tonic).toBe(0);
    expect(key.mode).toBe("major");
    expect(key.confidence).toBeGreaterThan(0);
  });

  test("аккордовые слоты определяют корень трезвучия и его бас", () => {
    const notes = notesOf(
      score([
        `${ATTRIBUTES}${chord([["C", 4], ["E", 4], ["G", 4]], 8, "whole")}`,
      ]),
    );
    const slots = chordSlots(notes[0]);

    expect(slots[0].root).toBe(0);
    expect(slots[0].quality).toBe("maj");
    expect(slots[0].bass).toBe(0);
    expect(slots[0].distinctPitchClasses).toBe(3);
  });

  test("V→I на сильной доле распознаётся как каденция, ostinato — нет", () => {
    const dominant = chord([["G", 3], ["B", 3], ["D", 4]], 8, "whole");
    const tonic = chord([["C", 3], ["E", 3], ["G", 3]], 8, "whole");
    const notes = notesOf(
      score([
        `${ATTRIBUTES}${stacked(pitched("E", 5, 8, "whole"), tonic)}`,
        `${stacked(pitched("D", 5, 8, "whole"), dominant)}`,
        `${stacked(pitched("C", 5, 8, "whole"), tonic)}`,
        `${stacked(pitched("C", 5, 8, "whole"), tonic)}`,
      ]),
    );
    const harmony = analyzeHarmony(notes, "part:0:1:1");

    expect(harmony.cadenceAfter[2]).toBeGreaterThan(0.45);
    expect(harmony.cadenceTypeAfter[2]).toBe("PAC");
    // Тот же тонический аккорд без гармонического движения каденции не образует.
    expect(harmony.cadenceAfter[3]).toBe(0);
  });
});

describe("Форма и гиперметр", () => {
  test("период и фаза выводятся вместе, а не задаются правилом «каждые четыре такта»", () => {
    const features = Array.from({ length: 16 }, (_, index) =>
      measureFeature(
        notesOf(
          score([`${ATTRIBUTES}${pitched(["C", "D", "E", "F"][index % 4], 5, 8, "whole")}`]),
        )[0],
      ),
    );
    const accents = features.map((_, index) => (index % 4 === 2 ? 1 : 0));
    const hypermeter = estimateHypermeter(features, accents);

    expect(hypermeter.period).toBe(4);
    expect(hypermeter.phase).toBe(2);
  });

  test("максимальный повтор находит блок формы и не считает остинато швом", () => {
    const ostinato = Array.from({ length: 12 }, () =>
      measureFeature(notesOf(score([`${ATTRIBUTES}${pitched("C", 5, 8, "whole")}`]))[0]),
    );
    expect(maximalRepeats(ostinato, 4)).toHaveLength(0);

    const steps = ["C", "D", "E", "F", "G", "A"];
    const withRepeat = [...steps, ...steps].map((step) =>
      measureFeature(notesOf(score([`${ATTRIBUTES}${pitched(step, 5, 8, "whole")}`]))[0]),
    );
    const repeats = maximalRepeats(withRepeat, 4);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toEqual({ first: 0, second: 6, length: 6 });
  });

  test("однородная фактура не получает ложных швов формы", () => {
    const notes = notesOf(
      score(
        Array.from({ length: 16 }, (_, index) =>
          `${index === 0 ? ATTRIBUTES : ""}${pitched(["C", "D", "E", "F"][index % 4], 5, 8, "whole")}`,
        ),
      ),
    );
    const structure = analyzeStructure(
      notes,
      notes.map(() => 0),
      notes.map(() => false),
    );

    expect(Math.max(...structure.sectionBoundaryAfter)).toBeLessThan(0.6);
  });
});

describe("Навигация", () => {
  test("шов между вольтами и D.S. образуют разрыв порядка исполнения", () => {
    const xml = score([
      `${ATTRIBUTES}<barline location="left"><repeat direction="forward"/></barline>${pitched("C", 5, 8, "whole")}`,
      `${pitched("D", 5, 8, "whole")}<barline location="right"><ending number="1" type="start"/></barline>`,
      `${pitched("E", 5, 8, "whole")}<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline>`,
      `${pitched("F", 5, 8, "whole")}<barline location="right"><ending number="2" type="start"/></barline>`,
      `<direction><direction-type><words>D.S.</words></direction-type></direction>${pitched("G", 5, 8, "whole")}`,
    ]);
    const navigation = analyzeNavigation(extractCombinedMeasures(xml));

    expect(navigation.discontinuityAfter[2]).toBe(true);
    expect(navigation.landing[0]).toBe(true);
    expect(navigation.jumps.some((jump) => jump.kind === "repeat-back")).toBe(true);
    expect(navigation.jumps.some((jump) => jump.kind === "dal-segno")).toBe(true);
  });

  test("Phrase не проходит сквозь шов вольт, а переход получает свой Bridge", () => {
    const measures = Array.from({ length: 16 }, (_, index) => {
      const step = ["C", "D", "E", "F"][index % 4];
      const barline =
        index === 7
          ? '<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline>'
          : index === 8
            ? '<barline location="left"><ending number="2" type="start"/></barline>'
            : "";
      return `${index === 0 ? ATTRIBUTES : ""}${barline}${pitched(step, 5, 8, "whole")}`;
    });
    const plan = analyzeAdaptiveMusicXml(score(measures), 1, 16, 60);

    expect(
      plan.phraseChunks.some(
        (chunk) => chunk.startMeasure <= 8 && chunk.endMeasure >= 9,
      ),
    ).toBe(false);
    expect(
      plan.bridgeChunks.some(
        (chunk) => chunk.startMeasure <= 8 && chunk.endMeasure >= 9,
      ),
    ).toBe(true);
  });
});

describe("Информативность сигналов и метрики", () => {
  test("tie, переносящийся почти через каждую черту, теряет вес запрета", () => {
    const tied = analyzeAdaptiveMusicXml(
      score(
        Array.from({ length: 24 }, (_, index) =>
          `${index === 0 ? ATTRIBUTES : ""}${stacked(
            pitched(["C", "D", "E", "F"][index % 4], 5, 8, "whole"),
            pitched(
              "C",
              4,
              8,
              "whole",
              index < 23 ? '<tie type="start"/>' : '<tie type="stop"/>',
              "2",
              "2",
            ),
          )}`,
        ),
      ),
      1,
      24,
      60,
    );
    const sparse = analyzeAdaptiveMusicXml(
      score(
        Array.from({ length: 24 }, (_, index) =>
          `${index === 0 ? ATTRIBUTES : ""}${pitched(
            ["C", "D", "E", "F"][index % 4],
            5,
            8,
            "whole",
            index === 5 ? '<tie type="start"/>' : index === 6 ? '<tie type="stop"/>' : "",
          )}`,
        ),
      ),
      1,
      24,
      60,
    );

    expect(tied.salience.tie).toBeLessThan(0.15);
    expect(sparse.salience.tie).toBeGreaterThan(tied.salience.tie);
    // Педальная фактура режется по музыке, а не растягивается в один огромный кусок.
    expect(
      Math.max(
        ...tied.phraseChunks.map((chunk) => chunk.endMeasure - chunk.startMeasure + 1),
      ),
    ).toBeLessThanOrEqual(16);
  });

  test("метрики качества считаются по плану и остаются в учебных пределах", () => {
    const plan = analyzeAdaptiveMusicXml(
      score(
        Array.from({ length: 24 }, (_, index) => {
          const step = ["C", "D", "E", "F"][index % 4];
          const closing = index % 8 === 7 ? `${rest(4)}` : "";
          const body = closing
            ? `${pitched(step, 5, 4, "half")}${closing}`
            : pitched(step, 5, 8, "whole");
          return `${index === 0 ? ATTRIBUTES : ""}${body}`;
        }),
      ),
      1,
      24,
      60,
    );
    const quality = measurePlanQuality(plan);

    expect(quality.phrases).toBeGreaterThan(1);
    expect(quality.forcedCutRate).toBe(0);
    expect(quality.navigationBreaks).toBe(0);
    expect(quality.durationCv).toBeLessThanOrEqual(0.35);
    expect(quality.closureRate).toBeGreaterThan(0);
  });
});

describe("Оптимизации анализа без изменения результата", () => {
  test("префиксные суммы совпадают с наивной суммой всех подотрезков", () => {
    const values = Array.from({ length: 50 }, (_, index) => (index * 17 + 3) % 23);
    const prefix = buildPrefix(values, (value) => value);
    for (let from = 0; from < values.length; from += 1) {
      for (let to = from + 1; to <= values.length; to += 1) {
        const naive = values.slice(from, to).reduce((sum, value) => sum + value, 0);
        expect(prefix[to] - prefix[from]).toBe(naive);
      }
    }
  });

  test("большая группа одинаковых отпечатков не считается формой", () => {
    const notes = notesOf(score(
      Array.from({ length: 400 }, (_, index) =>
        `${index === 0 ? ATTRIBUTES : ""}${pitched("C", 4, 8, "whole")}`,
      ),
    ));
    const features = notes.map(measureFeature);
    expect(maximalRepeats(features, 8)).toEqual([]);
  });

  test("нечёткий повтор находит явный возврат восьмитактового материала", () => {
    const feature = (pitch: number, fingerprint: string): MeasureFeature => ({
      chroma: Array.from({ length: 12 }, (_, index) => Number(index === pitch)),
      bass: Array.from({ length: 12 }, (_, index) => Number(index === pitch)),
      rhythm: Array.from({ length: 8 }, (_, index) => Number(index === pitch % 8)),
      texture: [pitch / 12, 0, 0, 0, 0],
      fingerprint,
      silent: false,
    });
    const opening = Array.from({ length: 8 }, (_, index) => feature(index, `a${index}`));
    const middle = Array.from({ length: 16 }, (_, index) => feature(11, `b${index}`));
    const ending = Array.from({ length: 8 }, (_, index) => feature(10, `c${index}`));
    const result = fuzzyRepeatStarts([...opening, ...middle, ...opening, ...ending], 8);
    expect([...result]).toEqual([[24, 0.7]]);
  });

  test("точный квантиль нечётких повторов хранит не больше O(n) кандидатов", () => {
    const feature = (pitch: number): MeasureFeature => ({
      chroma: Array.from({ length: 12 }, (_, index) => Number(index === pitch)),
      bass: Array.from({ length: 12 }, (_, index) => Number(index === pitch)),
      rhythm: Array.from({ length: 8 }, (_, index) => Number(index === pitch % 8)),
      texture: [pitch / 12, 0, 0, 0, 0],
      fingerprint: `p${pitch}`,
      silent: false,
    });
    const features = Array.from({ length: 400 }, (_, index) => feature(index % 12));

    fuzzyRepeatStarts(features, 8);
    const memory = fuzzyRepeatMemoryStats();

    expect(memory.peakStored).toBeLessThanOrEqual(memory.candidateCapacity);
    expect(memory.candidateCapacity).toBeLessThanOrEqual(features.length * 32);
  });

  test("инкрементальная novelty совпадает с наивным пересчётом блоков", () => {
    const feature = (pitch: number): MeasureFeature => ({
      chroma: Array.from({ length: 12 }, (_, index) => Number(index === pitch)),
      bass: Array.from({ length: 12 }, (_, index) => Number(index === (pitch + 5) % 12)),
      rhythm: Array.from({ length: 8 }, (_, index) => Number(index === pitch % 8)),
      texture: [pitch / 12, (pitch % 3) / 3, 0, 0, 0],
      fingerprint: `p${pitch}`,
      silent: false,
    });
    const features = Array.from({ length: 40 }, (_, index) =>
      feature((index * 5 + Math.floor(index / 7)) % 12),
    );
    const window = 4;
    const block = (left: MeasureFeature[], right: MeasureFeature[]) => {
      let sum = 0;
      for (const a of left) for (const b of right) sum += similarity(a, b);
      return sum / (left.length * right.length);
    };
    const expected = Array<number>(features.length).fill(0);
    for (let index = window - 1; index + window < features.length; index += 1) {
      const before = features.slice(index - window + 1, index + 1);
      const after = features.slice(index + 1, index + window + 1);
      const value = Math.max(
        0,
        Math.min(1, (block(before, before) + block(after, after)) / 2 - block(before, after)),
      );
      expected[index] = Math.max(0, Math.min(1, value / NOVELTY_REFERENCE));
    }

    const actual = noveltyCurve(features, window);
    for (const [index, value] of actual.entries()) {
      expect(value).toBeCloseTo(expected[index], 12);
    }
  });
});
