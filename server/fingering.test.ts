import { describe, expect, test } from "bun:test";
import {
  DETECTION,
  analyzeFingeringCoverage,
  degreeFingers,
  planFingering,
  scaleThumbDegrees,
} from "./fingering";
import { annotateFingering, stripFingering } from "./fingering-xml";
import { parseScore } from "./fingering-score";
import {
  DEFAULT_WEIGHTS,
  TEMPO_MODEL,
  isBlackKey,
  motionScale,
  positionChangeCosts,
  spanTables,
  tempoWeights,
  type Finger,
  type Hand,
  type RuleWeights,
} from "./fingering-model";

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const tables = spanTables(1);

/** Каноническая аппликатура мажорных гамм (сводные таблицы ABRSM/RCM). */
const MAJOR_SCALE_FINGERINGS: Record<string, { tonic: number; right: Finger[]; left: Finger[] }> = {
  "до": { tonic: 0, right: [1, 2, 3, 1, 2, 3, 4], left: [1, 4, 3, 2, 1, 3, 2] },
  "соль": { tonic: 7, right: [1, 2, 3, 1, 2, 3, 4], left: [1, 4, 3, 2, 1, 3, 2] },
  "ре": { tonic: 2, right: [1, 2, 3, 1, 2, 3, 4], left: [1, 4, 3, 2, 1, 3, 2] },
  "ля": { tonic: 9, right: [1, 2, 3, 1, 2, 3, 4], left: [1, 4, 3, 2, 1, 3, 2] },
  "ми": { tonic: 4, right: [1, 2, 3, 1, 2, 3, 4], left: [1, 4, 3, 2, 1, 3, 2] },
  "си": { tonic: 11, right: [1, 2, 3, 1, 2, 3, 4], left: [1, 3, 2, 1, 4, 3, 2] },
  "фа": { tonic: 5, right: [1, 2, 3, 4, 1, 2, 3], left: [1, 4, 3, 2, 1, 3, 2] },
  "си-бемоль": { tonic: 10, right: [4, 1, 2, 3, 1, 2, 3], left: [3, 2, 1, 4, 3, 2, 1] },
  "ми-бемоль": { tonic: 3, right: [3, 1, 2, 3, 4, 1, 2], left: [3, 2, 1, 4, 3, 2, 1] },
  "ля-бемоль": { tonic: 8, right: [3, 4, 1, 2, 3, 1, 2], left: [3, 2, 1, 4, 3, 2, 1] },
  "ре-бемоль": { tonic: 1, right: [2, 3, 1, 2, 3, 4, 1], left: [3, 2, 1, 4, 3, 2, 1] },
  "фа-диез": { tonic: 6, right: [2, 3, 4, 1, 2, 3, 1], left: [4, 3, 2, 1, 3, 2, 1] },
};

function scalePitchClasses(tonic: number): number[] {
  return MAJOR_STEPS.map((step) => (tonic + step) % 12);
}

const SHARP_STEPS: Array<[string, number]> = [
  ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0],
  ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];

function pitchXml(midi: number): string {
  const [step, alter] = SHARP_STEPS[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>`;
}

interface ScoreInput {
  right?: Array<number | number[]>;
  left?: Array<number | number[]>;
  fifths?: number;
  fingerings?: Record<number, number>;
  slur?: boolean;
  /** Четвертей в минуту; без него модель работает без поправки на скорость. */
  tempo?: number;
}

/** Минимальная фортепианная партитура: 4 четверти в такте, два нотоносца. */
function makeScore(input: ScoreInput): string {
  const right = input.right ?? [];
  const left = input.left ?? [];
  const measures = Math.max(1, Math.ceil(Math.max(right.length, left.length) / 4));
  let noteCounter = 0;

  const renderVoice = (
    events: Array<number | number[]>,
    from: number,
    voice: number,
    staff: number,
  ): string => {
    const slice = events.slice(from, from + 4);
    if (slice.length === 0) {
      return `<note><rest/><duration>4</duration><voice>${voice}</voice><staff>${staff}</staff></note>`;
    }
    return slice
      .map((event) => {
        const pitches = Array.isArray(event) ? event : [event];
        return pitches
          .map((midi, index) => {
            const finger = input.fingerings?.[noteCounter];
            noteCounter += 1;
            const notations = finger
              ? `<notations><technical><fingering>${finger}</fingering></technical></notations>`
              : input.slur
                ? `<notations><slur type="start" number="1"/></notations>`
                : "";
            return (
              `<note>${index > 0 ? "<chord/>" : ""}${pitchXml(midi)}` +
              `<duration>1</duration><voice>${voice}</voice><type>quarter</type>` +
              `<staff>${staff}</staff>${notations}</note>`
            );
          })
          .join("");
      })
      .join("");
  };

  const body = Array.from({ length: measures }, (_, index) => {
    const attributes =
      index === 0
        ? `<attributes><divisions>1</divisions><key><fifths>${input.fifths ?? 0}</fifths></key>` +
          `<time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>` +
          (input.tempo
            ? `<direction placement="above"><direction-type><metronome>` +
              `<beat-unit>quarter</beat-unit><per-minute>${input.tempo}</per-minute>` +
              `</metronome></direction-type><sound tempo="${input.tempo}"/></direction>`
            : "")
        : "";
    const rightVoice = renderVoice(right, index * 4, 1, 1);
    const leftVoice = renderVoice(left, index * 4, 2, 2);
    return `<measure number="${index + 1}">${attributes}${rightVoice}<backup><duration>4</duration></backup>${leftVoice}</measure>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">` +
    `<identification><encoding><software>test</software></encoding></identification>` +
    `<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>` +
    `<part id="P1">${body}</part></score-partwise>`;
}

function makeCrossVoiceReleaseScore(input: {
  heldMidi: number;
  currentMidi: number;
  heldFinger?: Finger;
  currentFinger?: Finger;
  pedal?: boolean;
  stopBeforeCurrent?: boolean;
}): string {
  const technical = (finger: Finger | undefined): string =>
    finger === undefined
      ? ""
      : `<notations><technical><fingering>${finger}</fingering></technical></notations>`;
  const pedalStart = input.pedal
    ? `<direction><direction-type><pedal type="start"/></direction-type></direction>`
    : "";
  const pedalStop = input.stopBeforeCurrent
    ? `<direction><direction-type><pedal type="stop"/></direction-type></direction>`
    : "";
  const body =
    pedalStart +
    `<note>${pitchXml(input.heldMidi)}<duration>3</duration><voice>1</voice><staff>1</staff>` +
    `${technical(input.heldFinger)}</note>` +
    `<backup><duration>3</duration></backup><forward><duration>1</duration></forward>` +
    pedalStop +
    `<note>${pitchXml(input.currentMidi)}<duration>1</duration><voice>2</voice><staff>1</staff>` +
    `${technical(input.currentFinger)}</note>`;
  return (
    `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
    `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
    `<divisions>1</divisions><staves>2</staves></attributes>${body}</measure></part>` +
    `</score-partwise>`
  );
}

function makeCrossHandChordScore(input: {
  right: number[];
  left: number[];
  rightStaccato?: boolean;
  leftStaccato?: boolean;
  rightSlur?: boolean;
  leftSlur?: boolean;
  rightArpeggiate?: boolean;
  leftArpeggiate?: boolean;
  authoredRightFinger?: Finger;
  authoredLeftFinger?: Finger;
  duration?: number;
}): string {
  const duration = input.duration ?? 1;
  const renderChord = (
    midis: number[],
    voice: number,
    staff: number,
    staccato: boolean,
    slur: boolean,
    arpeggiate: boolean,
    authoredFinger: Finger | undefined,
  ): string => {
    if (midis.length === 0) {
      return `<note><rest/><duration>${duration}</duration><voice>${voice}</voice>` +
        `<staff>${staff}</staff></note>`;
    }
    return midis
      .map((midi, index) => {
        const notations =
          index !== 0 ||
          (!staccato && !slur && !arpeggiate && authoredFinger === undefined)
            ? ""
            : `<notations>` +
              (staccato ? `<articulations><staccato/></articulations>` : "") +
              (slur ? `<slur type="start" number="1"/>` : "") +
              (arpeggiate ? `<arpeggiate/>` : "") +
              (authoredFinger === undefined
                ? ""
                : `<technical><fingering>${authoredFinger}</fingering></technical>`) +
              `</notations>`;
        return (
          `<note>${index > 0 ? "<chord/>" : ""}${pitchXml(midi)}` +
          `<duration>${duration}</duration><voice>${voice}</voice><type>eighth</type>` +
          `<staff>${staff}</staff>${notations}</note>`
        );
      })
      .join("");
  };
  const right = renderChord(
    input.right,
    1,
    1,
    input.rightStaccato ?? true,
    input.rightSlur ?? false,
    input.rightArpeggiate ?? false,
    input.authoredRightFinger,
  );
  const left = renderChord(
    input.left,
    5,
    2,
    input.leftStaccato ?? true,
    input.leftSlur ?? false,
    input.leftArpeggiate ?? false,
    input.authoredLeftFinger,
  );
  return (
    `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
    `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
    `<divisions>2</divisions><staves>2</staves></attributes>${right}` +
    `<backup><duration>${duration}</duration></backup>${left}</measure></part>` +
    `</score-partwise>`
  );
}

function makeCompressedPedagogicalCells(withSuffix = false): string {
  const right = [72, 74, 72, 76, 74, 77, 76, 79];
  const left = right.map((midi) => midi - 12);
  const renderBeam = (midis: number[], voice: number): string =>
    midis
      .map(
        (midi, index) =>
          `<note>${pitchXml(midi)}<duration>1</duration><voice>${voice}</voice>` +
          `<type>16th</type><beam number="1">${
            index === 0 ? "begin" : index === midis.length - 1 ? "end" : "continue"
          }</beam></note>`,
      )
      .join("");
  const measure = (number: number, high: number[], low: number[], final: boolean): string =>
    `<measure number="${number}">` +
    (number === 1
      ? `<attributes><divisions>4</divisions><time><beats>2</beats><beat-type>4</beat-type></time>` +
        `<clef><sign>F</sign><line>4</line></clef></attributes>`
      : "") +
    renderBeam(high, 1) +
    `<backup><duration>8</duration></backup>` +
    renderBeam(low, 2) +
    (final ? `<barline location="right"><bar-style>light-heavy</bar-style></barline>` : "") +
    `</measure>`;
  const first = measure(1, right, left, true);
  const suffix = withSuffix
    ? measure(2, [84, 79, 81, 76, 78, 74, 77, 72], [72, 67, 69, 64, 66, 62, 65, 60], false)
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">` +
    `<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>` +
    `<part id="P1">${first}${suffix}</part></score-partwise>`
  );
}

function fingersOf(xml: string, midis: number[], staff: string): Finger[] {
  const plan = planFingering(xml);
  const notes = parseScore(xml).notes.filter((note) => note.staff === staff && note.midi !== undefined);
  return notes.map((note) => plan.assignments.get(note.index) as Finger);
}

describe("детекция аппликатуры", () => {
  test("партитура без аппликатуры", () => {
    const coverage = analyzeFingeringCoverage(makeScore({ right: [60, 62, 64, 65] }));
    expect(coverage.annotatedNotes).toBe(0);
    expect(coverage.hasFingering).toBe(false);
    expect(coverage.partial).toBe(false);
    expect(coverage.totalNotes).toBe(4);
  });

  test("полная аппликатура распознаётся и не переписывается", () => {
    const xml = makeScore({ right: [60, 62, 64, 65], fingerings: { 0: 1, 1: 2, 2: 3, 3: 4 } });
    const coverage = analyzeFingeringCoverage(xml);
    expect(coverage.coverage).toBeGreaterThanOrEqual(DETECTION.present);
    expect(coverage.hasFingering).toBe(true);
  });

  test("частичная аппликатура", () => {
    const xml = makeScore({ right: [60, 62, 64, 65, 67, 69, 71, 72], fingerings: { 0: 1, 1: 2 } });
    const coverage = analyzeFingeringCoverage(xml);
    expect(coverage.partial).toBe(true);
    expect(coverage.hasFingering).toBe(false);
  });
});

describe("канонические гаммы", () => {
  for (const [name, expected] of Object.entries(MAJOR_SCALE_FINGERINGS)) {
    test(`${name} мажор — большой палец только на белой`, () => {
      const classes = scalePitchClasses(expected.tonic);
      for (const hand of ["R", "L"] as Hand[]) {
        const thumbs = scaleThumbDegrees(classes, hand);
        expect(thumbs.length).toBe(2);
        for (const degree of thumbs) {
          expect([1, 3, 6, 8, 10]).not.toContain(classes[degree]);
        }
      }
    });

    test(`${name} мажор — аппликатура школы, правая рука`, () => {
      const classes = scalePitchClasses(expected.tonic);
      expect(degreeFingers(scaleThumbDegrees(classes, "R"), "R")).toEqual(expected.right);
    });

    test(`${name} мажор — аппликатура школы, левая рука`, () => {
      const classes = scalePitchClasses(expected.tonic);
      expect(degreeFingers(scaleThumbDegrees(classes, "L"), "L")).toEqual(expected.left);
    });
  }
});

describe("подбор по партитуре", () => {
  test("до-мажорная гамма в правой руке получает 1-2-3-1-2-3-4-5", () => {
    const midis = [60, 62, 64, 65, 67, 69, 71, 72];
    const fingers = fingersOf(makeScore({ right: midis }), midis, "1");
    expect(fingers).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
  });

  test("до-мажорная гамма в левой руке получает 5-4-3-2-1-3-2-1", () => {
    const midis = [48, 50, 52, 53, 55, 57, 59, 60];
    const fingers = fingersOf(makeScore({ left: midis }), midis, "2");
    expect(fingers).toEqual([5, 4, 3, 2, 1, 3, 2, 1]);
  });

  test("фа-мажорная гамма: большой палец обходит си-бемоль", () => {
    const midis = [65, 67, 69, 70, 72, 74, 76, 77];
    const fingers = fingersOf(makeScore({ right: midis, fifths: -1 }), midis, "1");
    expect(fingers).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  test("си-мажорная гамма: большой палец не встаёт на чёрную", () => {
    const midis = [71, 73, 75, 76, 78, 80, 82, 83];
    const xml = makeScore({ right: midis, fifths: 5 });
    const fingers = fingersOf(xml, midis, "1");
    const black = midis.filter((_, index) => fingers[index] === 1).map((midi) => midi % 12);
    expect(black.every((pc) => ![1, 3, 6, 8, 10].includes(pc))).toBe(true);
  });

  test("мелодический и гармонический минор распознаются как гамма", () => {
    for (const midis of [
      [57, 59, 60, 62, 64, 66, 68, 69],
      [57, 59, 60, 62, 64, 65, 68, 69],
    ]) {
      const plan = planFingering(makeScore({ right: midis }));
      expect(plan.report.patterns.some((pattern) => pattern.kind === "scale")).toBe(true);
      const notes = parseScore(makeScore({ right: midis })).notes.filter(
        (note) => note.staff === "1" && note.midi !== undefined,
      );
      const thumbs = notes.filter((note) => plan.assignments.get(note.index) === 1);
      expect(thumbs.every((note) => ![1, 3, 6, 8, 10].includes((note.midi as number) % 12))).toBe(
        true,
      );
    }
  });

  test("смена ключа внутри партитуры меняет тонику следующей гаммы", () => {
    const first = [60, 62, 64, 65, 67, 69, 71, 72];
    const second = [64, 66, 68, 69, 71, 73, 75, 76];
    const xml = makeScore({ right: [...first, ...second], fifths: 0 }).replace(
      '<measure number="3">',
      '<measure number="3"><attributes><key><fifths>4</fifths><mode>major</mode></key></attributes>',
    );
    const plan = planFingering(xml);
    expect(plan.report.patterns.map((pattern) => pattern.label)).toEqual([
      "гамма от до",
      "гамма от ми",
    ]);
    const notes = parseScore(xml).notes.filter(
      (note) => note.staff === "1" && note.midi !== undefined,
    );
    expect(notes.slice(8).map((note) => plan.assignments.get(note.index))).toEqual([
      1, 2, 3, 1, 2, 3, 4, 5,
    ]);
  });

  test("до-мажорное арпеджио получает канонический рисунок обеих рук", () => {
    const right = [60, 64, 67, 72, 76, 79, 84];
    const left = [48, 52, 55, 60, 64, 67, 72];
    const rightXml = makeScore({ right });
    const leftXml = makeScore({ left });
    expect(fingersOf(rightXml, right, "1")).toEqual([1, 2, 3, 1, 2, 3, 5]);
    expect(fingersOf(leftXml, left, "2")).toEqual([5, 3, 2, 1, 3, 2, 1]);
    expect(
      planFingering(rightXml).report.patterns.some((pattern) => pattern.kind === "arpeggio"),
    ).toBe(true);
    expect(
      planFingering(leftXml).report.patterns.some((pattern) => pattern.kind === "arpeggio"),
    ).toBe(true);
  });

  test("короткое и арочное арпеджио получают школьные крайние пальцы", () => {
    const right = [60, 64, 67, 72, 67, 64, 60];
    const left = [48, 52, 55];
    expect(fingersOf(makeScore({ right }), right, "1")).toEqual([1, 2, 3, 5, 3, 2, 1]);
    expect(fingersOf(makeScore({ left }), left, "2")).toEqual([5, 3, 1]);
  });

  test("пятипальцевая педагогическая ячейка зеркально сохраняет рамку обеих рук", () => {
    const xml = makeCompressedPedagogicalCells();
    const score = parseScore(xml);
    const plan = planFingering(xml);
    const byHand = (hand: Hand): Finger[] =>
      score.notes
        .filter((note) => note.midi !== undefined && plan.hands.get(note.index) === hand)
        .map((note) => plan.assignments.get(note.index) as Finger);

    expect(byHand("R")).toEqual([1, 2, 1, 3, 2, 4, 3, 5]);
    expect(byHand("L")).toEqual([5, 4, 5, 3, 4, 2, 3, 1]);
    expect(byHand("L")).toEqual(byHand("R").map((finger) => (6 - finger) as Finger));
    expect(plan.report.patterns.filter((pattern) => pattern.kind === "fiveFinger")).toHaveLength(2);
    expect(plan.report.patterns.some((pattern) => pattern.label === "короткое арпеджио")).toBe(
      false,
    );
    expect(plan.report.measures[0].right.positionChanges).toBe(0);
    expect(plan.report.measures[0].left.positionChanges).toBe(0);
  });

  test("финальная черта делает аппликатуру префикса независимой от хвоста", () => {
    const prefixXml = makeCompressedPedagogicalCells();
    const extendedXml = makeCompressedPedagogicalCells(true);
    const prefix = planFingering(prefixXml);
    const extended = planFingering(extendedXml);
    const prefixNotes = parseScore(prefixXml).notes.filter((note) => note.midi !== undefined);

    expect(
      prefixNotes.map((note) => extended.assignments.get(note.index)),
    ).toEqual(prefixNotes.map((note) => prefix.assignments.get(note.index)));
  });

  test("вальсовый аккомпанемент: 5-й на басу, перенос кисти на аккорд", () => {
    // Фигура Indila «Love Story» и Гимнопедии Сати: бас на «раз» под фразовой
    // лигой, затем стаккатные аккорды. Пианист играет 5 / 3-1 / 3-1 переносом
    // кисти; чистая эргономика Parncutt ставила 3 на бас из-за штрафа за 5-й.
    const chord = [52, 55]
      .map(
        (midi, index) =>
          `<note>${index > 0 ? "<chord/>" : ""}${pitchXml(midi)}` +
          `<duration>1</duration><voice>5</voice><type>quarter</type><staff>2</staff>` +
          (index === 0
            ? `<notations><articulations><staccato/></articulations></notations>`
            : "") +
          `</note>`,
      )
      .join("");
    const bar =
      `<note>${pitchXml(45)}<duration>1</duration><voice>5</voice><type>quarter</type>` +
      `<staff>2</staff><notations><slur type="start" number="1"/></notations></note>` +
      chord + chord;
    const xml =
      `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>2</staves>` +
      `<time><beats>3</beats><beat-type>4</beat-type></time>` +
      `<clef number="1"><sign>G</sign><line>2</line></clef>` +
      `<clef number="2"><sign>F</sign><line>4</line></clef></attributes>${bar}` +
      `</measure><measure number="2">${bar}</measure></part></score-partwise>`;

    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    const fingerAt = (midi: number, onset: number) =>
      plan.assignments.get(
        (notes.find((note) => note.midi === midi && note.onset === onset) as { index: number })
          .index,
      );

    expect(plan.report.patterns.map((pattern) => pattern.kind)).toContain("accompaniment");
    for (const bassOnset of [0, 3]) {
      expect(fingerAt(45, bassOnset)).toBe(5);
    }
    for (const chordOnset of [1, 2, 4, 5]) {
      expect(fingerAt(52, chordOnset)).toBe(3);
      expect(fingerAt(55, chordOnset)).toBe(1);
    }
    expect(plan.report.warnings).toEqual([]);
  });

  test("одиночный бас без повторяющегося аккорда не считается аккомпанементом", () => {
    const single =
      `<note>${pitchXml(45)}<duration>1</duration><voice>5</voice><type>quarter</type><staff>2</staff></note>` +
      [52, 55]
        .map(
          (midi, index) =>
            `<note>${index > 0 ? "<chord/>" : ""}${pitchXml(midi)}` +
            `<duration>2</duration><voice>5</voice><type>half</type><staff>2</staff></note>`,
        )
        .join("");
    const xml =
      `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>2</staves>` +
      `<time><beats>3</beats><beat-type>4</beat-type></time>` +
      `<clef number="2"><sign>F</sign><line>4</line></clef></attributes>${single}` +
      `</measure></part></score-partwise>`;

    const plan = planFingering(xml);
    expect(plan.report.patterns.map((pattern) => pattern.kind)).not.toContain("accompaniment");
  });

  test("альбертиев бас сохраняет одну аппликатуру на повторениях", () => {
    const left = [48, 55, 52, 55, 48, 55, 52, 55];
    const xml = makeScore({ left });
    expect(fingersOf(xml, left, "2")).toEqual([5, 1, 3, 1, 5, 1, 3, 1]);
    expect(planFingering(xml).report.patterns.some((pattern) => pattern.kind === "alberti")).toBe(
      true,
    );
  });

  test("повторяющийся ломаный аккорд сохраняет одну форму руки", () => {
    const right = [75, 70, 67, 75, 70, 67, 75, 70];
    const xml = makeScore({ right, fifths: -3 });
    expect(fingersOf(xml, right, "1")).toEqual([5, 2, 1, 5, 2, 1, 5, 2]);
    expect(planFingering(xml).report.patterns).toContainEqual(
      expect.objectContaining({ kind: "ostinato", label: "повторяющаяся фигура" }),
    );
  });

  test("gold-паттерны гаммы и арпеджио устойчивы к ±25 % каждого веса", () => {
    const cases = [
      {
        xml: makeScore({ right: [60, 62, 64, 65, 67, 69, 71, 72] }),
        staff: "1",
        expected: [1, 2, 3, 1, 2, 3, 4, 5],
      },
      {
        xml: makeScore({ left: [48, 50, 52, 53, 55, 57, 59, 60] }),
        staff: "2",
        expected: [5, 4, 3, 2, 1, 3, 2, 1],
      },
      {
        xml: makeScore({ right: [60, 64, 67, 72, 76, 79, 84] }),
        staff: "1",
        expected: [1, 2, 3, 1, 2, 3, 5],
      },
      {
        xml: makeScore({ left: [48, 52, 55, 60, 64, 67, 72] }),
        staff: "2",
        expected: [5, 3, 2, 1, 3, 2, 1],
      },
    ] as const;

    for (const rule of Object.keys(DEFAULT_WEIGHTS) as Array<keyof RuleWeights>) {
      for (const factor of [0.75, 1.25]) {
        const weights = {
          ...DEFAULT_WEIGHTS,
          [rule]: DEFAULT_WEIGHTS[rule] * factor,
        };
        for (const sample of cases) {
          const plan = planFingering(sample.xml, { weights });
          const notes = parseScore(sample.xml).notes.filter(
            (note) => note.staff === sample.staff && note.midi !== undefined,
          );
          expect(
            notes.map((note) => plan.assignments.get(note.index)),
            `${rule} × ${factor}, staff ${sample.staff}`,
          ).toEqual([...sample.expected]);
        }
      }
    }
  });

  test("аккорды получают непересекающиеся пальцы", () => {
    const xml = makeScore({ right: [[60, 64, 67], [62, 65, 69]] });
    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter((note) => note.staff === "1" && note.midi);
    const fingers = notes.map((note) => plan.assignments.get(note.index) as number);
    expect(fingers.slice(0, 3)).toEqual([...fingers.slice(0, 3)].sort((a, b) => a - b));
    expect(new Set(fingers.slice(0, 3)).size).toBe(3);
  });

  test("аккорд левой руки нумеруется сверху вниз", () => {
    const xml = makeScore({ left: [[48, 55, 64]] });
    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter((note) => note.staff === "2" && note.midi);
    const fingers = notes.map((note) => plan.assignments.get(note.index) as number);
    expect(fingers[0]).toBeGreaterThan(fingers[2]);
  });

  test("невозможный по растяжению аккорд не получает печатных цифр", () => {
    const xml = makeScore({ right: [[36, 84]] });
    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(notes.every((note) => plan.suppressed.has(note.index))).toBe(true);
    expect(plan.report.warnings.some((warning) => warning.includes("физически допустимая"))).toBe(
      true,
    );
    expect(annotateFingering(xml, plan)).not.toContain("<fingering");
  });

  /*
   * «Cornfield Chase»: в басу лежит децима F2–A3 половинными. Разом рука её не
   * берёт, и раньше движок снимал цифры со всего события — ученик оставался
   * без аппликатуры в девяти тактах подряд и не понимал, как такое сыграть.
   * Пианист берёт такой аккорд снизу вверх под педалью; это законная форма, и
   * её нужно печатать вместе с объяснением приёма.
   */
  test("выдержанный аккорд шире руки печатается разложенным, а не пропадает", () => {
    const xml = makeCrossHandChordScore({
      right: [],
      left: [41, 48, 57],
      leftStaccato: false,
      duration: 6,
    });
    const plan = planFingering(xml, { mode: "rebuild" });
    const chord = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(chord).toHaveLength(3);
    expect(chord.every((note) => !plan.suppressed.has(note.index))).toBe(true);
    const fingers = chord.map((note) => plan.assignments.get(note.index));
    expect(fingers.every((finger) => finger !== undefined)).toBe(true);
    expect(new Set(fingers).size).toBe(3);
    expect(plan.report.warnings.some((warning) => warning.includes("шире руки"))).toBe(true);
    expect(annotateFingering(xml, plan)).toContain("<fingering");
  });

  test("короткий аккорд шире руки не выдаётся за разложенный", () => {
    // Восьмая при неизвестном темпе — не место для разложения: приём слышен
    // как ошибка, и честнее не печатать цифры вовсе.
    const xml = makeCrossHandChordScore({
      right: [],
      left: [41, 48, 57],
      leftStaccato: false,
      duration: 1,
    });
    const plan = planFingering(xml, { mode: "rebuild" });
    const chord = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(chord.every((note) => plan.suppressed.has(note.index))).toBe(true);
    expect(plan.report.warnings.some((warning) => warning.includes("шире руки"))).toBe(false);
    expect(
      plan.report.warnings.some((warning) => warning.includes("физически допустимая")),
    ).toBe(true);
  });

  test("аккорд в пределах руки разложенным не объявляется", () => {
    const xml = makeCrossHandChordScore({
      right: [],
      left: [48, 52, 55],
      leftStaccato: false,
      duration: 6,
    });
    const plan = planFingering(xml, { mode: "rebuild" });
    const chord = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(chord.every((note) => !plan.suppressed.has(note.index))).toBe(true);
    expect(plan.report.warnings.some((warning) => warning.includes("шире руки"))).toBe(false);
  });

  test("единственное физически допустимое разбиение переносит крайнюю ноту другой руке", () => {
    const xml = makeCrossHandChordScore({
      right: [61, 78],
      left: [54],
    });
    const plan = planFingering(xml, { trace: true });
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    const cSharp = notes.find((note) => note.midi === 61);
    const highFSharp = notes.find((note) => note.midi === 78);
    const bassFSharp = notes.find((note) => note.midi === 54);
    expect(cSharp).toBeDefined();
    expect(highFSharp).toBeDefined();
    expect(bassFSharp).toBeDefined();
    expect(plan.hands.get((cSharp as { index: number }).index)).toBe("L");
    expect(plan.hands.get((highFSharp as { index: number }).index)).toBe("R");
    expect(plan.hands.get((bassFSharp as { index: number }).index)).toBe("L");
    expect(notes.every((note) => !plan.suppressed.has(note.index))).toBe(true);
    expect(plan.report.warnings).toEqual([]);
    expect(
      plan.trace
        .find((entry) => entry.noteIndex === (cSharp as { index: number }).index)
        ?.adjustments.some((adjustment) => adjustment.kind === "crossHandTransfer"),
    ).toBe(true);

    const annotated = parseScore(annotateFingering(xml, plan)).notes;
    expect(annotated.find((note) => note.midi === 61)?.body).toContain('placement="below"');
    expect(annotated.find((note) => note.midi === 78)?.body).toContain('placement="above"');
  });

  test("крайняя нота неиграбельного аккорда симметрично передаётся правой руке", () => {
    const xml = makeCrossHandChordScore({
      right: [72],
      left: [48, 66],
    });
    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(plan.hands.get((notes.find((note) => note.midi === 66) as { index: number }).index)).toBe(
      "R",
    );
    expect(plan.hands.get((notes.find((note) => note.midi === 48) as { index: number }).index)).toBe(
      "L",
    );
    expect(notes.every((note) => !plan.suppressed.has(note.index))).toBe(true);
    expect(plan.report.warnings).toEqual([]);
  });

  test("перенос между руками не угадывается без получателя или для неоднозначного трезвучия", () => {
    for (const xml of [
      makeCrossHandChordScore({ right: [61, 78], left: [] }),
      makeCrossHandChordScore({ right: [61, 64, 78], left: [54] }),
    ]) {
      const plan = planFingering(xml);
      const wide = parseScore(xml).notes.filter(
        (note) => note.staff === "1" && note.midi !== undefined,
      );
      expect(wide.some((note) => plan.suppressed.has(note.index))).toBe(true);
      expect(plan.report.warnings.some((warning) => warning.includes("физически допустимая"))).toBe(
        true,
      );
    }
  });

  test("legato, arpeggiate, авторская цифра и отсутствие staccato запрещают автоперенос", () => {
    const insideActiveSlur =
      `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>2</divisions><staves>2</staves></attributes>` +
      `<note>${pitchXml(76)}<duration>1</duration><voice>1</voice><staff>1</staff>` +
      `<notations><slur type="start" number="1"/></notations></note>` +
      `<note>${pitchXml(61)}<duration>1</duration><voice>1</voice><staff>1</staff>` +
      `<notations><articulations><staccato/></articulations></notations></note>` +
      `<note><chord/>${pitchXml(78)}<duration>1</duration><voice>1</voice><staff>1</staff></note>` +
      `<backup><duration>2</duration></backup><forward><duration>1</duration></forward>` +
      `<note>${pitchXml(54)}<duration>1</duration><voice>5</voice><staff>2</staff>` +
      `<notations><articulations><staccato/></articulations></notations></note>` +
      `</measure></part></score-partwise>`;
    const guarded = [
      makeCrossHandChordScore({ right: [61, 78], left: [54], rightSlur: true }),
      makeCrossHandChordScore({ right: [61, 78], left: [54], rightArpeggiate: true }),
      makeCrossHandChordScore({ right: [61, 78], left: [54], authoredRightFinger: 1 }),
      makeCrossHandChordScore({ right: [61, 78], left: [54], rightStaccato: false }),
      insideActiveSlur,
    ];
    for (const xml of guarded) {
      const plan = planFingering(xml);
      const cSharp = parseScore(xml).notes.find((note) => note.midi === 61);
      expect(plan.hands.get((cSharp as { index: number }).index)).toBe("R");
      expect(plan.report.warnings.some((warning) => warning.includes("физически допустимая"))).toBe(
        true,
      );
    }
  });

  test("полная рука-получатель и удержание через onset запрещают автоперенос", () => {
    const fullRecipient = makeCrossHandChordScore({
      right: [61, 78],
      left: [54, 55, 56, 57, 58],
    });
    const heldAcrossOnset =
      `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>2</divisions><staves>2</staves></attributes>` +
      `<forward><duration>1</duration></forward>` +
      `<note>${pitchXml(61)}<duration>1</duration><voice>1</voice><staff>1</staff>` +
      `<notations><articulations><staccato/></articulations></notations></note>` +
      `<note><chord/>${pitchXml(78)}<duration>1</duration><voice>1</voice><staff>1</staff></note>` +
      `<backup><duration>2</duration></backup>` +
      `<note>${pitchXml(48)}<duration>2</duration><voice>6</voice><staff>2</staff></note>` +
      `<backup><duration>2</duration></backup><forward><duration>1</duration></forward>` +
      `<note>${pitchXml(54)}<duration>1</duration><voice>5</voice><staff>2</staff>` +
      `<notations><articulations><staccato/></articulations></notations></note>` +
      `</measure></part></score-partwise>`;
    for (const xml of [fullRecipient, heldAcrossOnset]) {
      const plan = planFingering(xml);
      const cSharp = parseScore(xml).notes.find((note) => note.midi === 61);
      expect(plan.hands.get((cSharp as { index: number }).index)).toBe("R");
      expect(plan.report.warnings.some((warning) => warning.includes("физически допустимая"))).toBe(
        true,
      );
    }
  });

  test("неиграбельная общая вертикаль разных голосов допускает педальную передачу", () => {
    const body =
      `<note>${pitchXml(36)}<duration>1</duration><voice>1</voice><staff>1</staff></note>` +
      `<backup><duration>1</duration></backup>` +
      `<note>${pitchXml(84)}<duration>1</duration><voice>2</voice><staff>1</staff></note>`;
    const xml =
      `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>2</staves></attributes>${body}</measure></part>` +
      `</score-partwise>`;
    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(notes.every((note) => !plan.suppressed.has(note.index))).toBe(true);
    expect(plan.report.warnings).toEqual([]);
    // Педальная передача — это снятие голоса, а не смена позиции руки:
    // цена по-прежнему начисляется, но правилам 4 и 5 не приписывается.
    expect(plan.report.stats.positionChanges).toBe(0);
    expect(plan.report.measures[0].right.cost).toBeGreaterThan(0);
  });

  test("играбельный аккорд разных голосов остаётся строгой общей формой", () => {
    const body =
      `<note>${pitchXml(60)}<duration>1</duration><voice>1</voice><staff>1</staff></note>` +
      `<backup><duration>1</duration></backup>` +
      `<note>${pitchXml(64)}<duration>1</duration><voice>2</voice><staff>1</staff></note>`;
    const xml =
      `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>2</staves></attributes>${body}</measure></part>` +
      `</score-partwise>`;
    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    const fingers = notes.map((note) => plan.assignments.get(note.index));
    expect(new Set(fingers).size).toBe(2);
    expect(plan.report.stats.positionChanges).toBe(0);
    expect(plan.report.warnings).toEqual([]);
  });

  test("нижний бас другого голоса допускает артикулированное снятие без знака педали", () => {
    const chord = [48, 54, 57, 62]
      .map(
        (midi, index) =>
          `<note>${index > 0 ? "<chord/>" : ""}${pitchXml(midi)}` +
          `<duration>2</duration><voice>5</voice><staff>2</staff></note>`,
      )
      .join("");
    const body =
      `<note>${pitchXml(38)}<duration>3</duration><voice>6</voice><staff>2</staff>` +
      `<notations><technical><fingering>5</fingering></technical></notations></note>` +
      `<backup><duration>3</duration></backup><forward><duration>1</duration></forward>${chord}`;
    const xml =
      `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>2</staves></attributes>${body}</measure></part>` +
      `</score-partwise>`;
    const plan = planFingering(xml, { mode: "fill" });
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(plan.assignments.get(notes[0].index)).toBe(5);
    expect(plan.assignments.get(notes[1].index)).toBe(5);
    expect(notes.every((note) => !plan.suppressed.has(note.index))).toBe(true);
    expect(plan.report.warnings).toEqual([]);
  });

  test("pedal start/change/stop и sound damper-pedal образуют временную шкалу", () => {
    const stopped = makeCrossVoiceReleaseScore({
      heldMidi: 72,
      currentMidi: 60,
      pedal: true,
      stopBeforeCurrent: true,
    });
    expect(parseScore(stopped).notes.map((note) => note.damperPedal)).toEqual([true, false]);

    const changed = stopped.replace('type="stop"', 'type="change"');
    expect(parseScore(changed).notes.map((note) => note.damperPedal)).toEqual([true, true]);
    const continued = stopped.replace('type="stop"', 'type="continue"');
    expect(parseScore(continued).notes.map((note) => note.damperPedal)).toEqual([true, true]);
    const discontinued = stopped.replace('type="stop"', 'type="discontinue"');
    expect(parseScore(discontinued).notes.map((note) => note.damperPedal)).toEqual([true, false]);
    const resumed = stopped.replace('type="start"', 'type="resume"');
    expect(parseScore(resumed).notes.map((note) => note.damperPedal)).toEqual([true, false]);

    const playback = stopped
      .replace(
        `<direction><direction-type><pedal type="start"/></direction-type></direction>`,
        `<sound damper-pedal="yes"/>`,
      )
      .replace(
        `<direction><direction-type><pedal type="stop"/></direction-type></direction>`,
        `<sound damper-pedal="no"/>`,
      );
    expect(parseScore(playback).notes.map((note) => note.damperPedal)).toEqual([true, false]);
  });

  test("двухголосие без педали не освобождает палец удержанной верхней ноты", () => {
    const xml = makeCrossVoiceReleaseScore({
      heldMidi: 72,
      currentMidi: 60,
      heldFinger: 5,
    });
    const plan = planFingering(xml, { mode: "fill" });
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(plan.assignments.get(notes[0].index)).toBe(5);
    expect(plan.assignments.get(notes[1].index)).not.toBe(5);
    expect(notes.every((note) => !plan.suppressed.has(note.index))).toBe(true);
  });

  test("pedal stop резко удорожает верхнюю передачу относительно активной педали", () => {
    const active = makeCrossVoiceReleaseScore({
      heldMidi: 72,
      currentMidi: 60,
      heldFinger: 1,
      currentFinger: 1,
      pedal: true,
    });
    const stopped = makeCrossVoiceReleaseScore({
      heldMidi: 72,
      currentMidi: 60,
      heldFinger: 1,
      currentFinger: 1,
      pedal: true,
      stopBeforeCurrent: true,
    });
    const activePlan = planFingering(active, { mode: "fill" });
    const stoppedPlan = planFingering(stopped, { mode: "fill" });
    const activeNotes = parseScore(active).notes.filter((note) => note.midi !== undefined);
    expect(activeNotes.every((note) => !activePlan.suppressed.has(note.index))).toBe(true);
    expect(stoppedPlan.report.stats.ergonomicCostPerNote).toBeGreaterThan(
      activePlan.report.stats.ergonomicCostPerNote,
    );
  });

  test("под явной педалью передача верхнего слоя дороже нижнего баса", () => {
    const bass = makeCrossVoiceReleaseScore({
      heldMidi: 48,
      currentMidi: 60,
      heldFinger: 1,
      currentFinger: 1,
      pedal: true,
    });
    const upper = makeCrossVoiceReleaseScore({
      heldMidi: 72,
      currentMidi: 60,
      heldFinger: 1,
      currentFinger: 1,
      pedal: true,
    });
    const bassCost = planFingering(bass, { mode: "fill" }).report.stats.ergonomicCostPerNote;
    const upperCost = planFingering(upper, { mode: "fill" }).report.stats.ergonomicCostPerNote;
    expect(upperCost).toBeGreaterThan(bassCost);
  });

  test("неиграбельные события агрегируются в одно предупреждение такта и руки", () => {
    const chord =
      `<note>${pitchXml(36)}<duration>1</duration><voice>1</voice><staff>1</staff></note>` +
      `<note><chord/>${pitchXml(84)}<duration>1</duration><voice>1</voice><staff>1</staff></note>`;
    const xml =
      `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>2</staves></attributes>${chord}${chord}` +
      `</measure></part></score-partwise>`;
    const plan = planFingering(xml);
    const warnings = plan.report.warnings.filter((warning) => warning.includes("Такт 1,"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("событий: 2, нот: 4");
  });

  test("соприкасающиеся длительности без лиги не требуют пальцевого legato", () => {
    const xml = makeScore({ left: [[48, 60], [50, 62], [52, 64], [53, 65]] });
    const plan = planFingering(xml);
    const left = parseScore(xml).notes.filter(
      (note) => note.staff === "2" && note.midi !== undefined,
    );
    expect(left.every((note) => !plan.suppressed.has(note.index))).toBe(true);
    expect(plan.report.warnings).toEqual([]);
  });

  test("явная лига требует пальцевого legato в одноголосии", () => {
    const xml = makeScore({ right: [60, 62], slur: true });
    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter(
      (note) => note.staff === "1" && note.midi !== undefined,
    );
    expect(plan.assignments.get(notes[0].index)).not.toBe(plan.assignments.get(notes[1].index));
    expect(notes.every((note) => !plan.suppressed.has(note.index))).toBe(true);
  });

  test("фразовая лига над движущимися аккордами не требует связать все голоса", () => {
    const xml = makeScore({ left: [[48, 60], [50, 62]], slur: true });
    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter(
      (note) => note.staff === "2" && note.midi !== undefined,
    );
    expect(notes.every((note) => !plan.suppressed.has(note.index))).toBe(true);
    expect(plan.report.warnings).toEqual([]);
  });

  test("длительно удерживаемая нота блокирует палец через несколько атак", () => {
    const body =
      `<note>${pitchXml(48)}<duration>4</duration><voice>1</voice><staff>1</staff>` +
      `<notations><technical><fingering>1</fingering></technical></notations></note>` +
      `<backup><duration>4</duration></backup><forward><duration>1</duration></forward>` +
      [50, 52, 53]
        .map(
          (midi) =>
            `<note>${pitchXml(midi)}<duration>1</duration><voice>1</voice><staff>1</staff></note>`,
        )
        .join("");
    const xml =
      `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>1</staves></attributes>${body}</measure></part>` +
      `</score-partwise>`;
    const plan = planFingering(xml, { mode: "fill" });
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(plan.assignments.get(notes[0].index)).toBe(1);
    expect(notes.slice(1).every((note) => plan.assignments.get(note.index) !== 1)).toBe(true);
  });

  test("tie наследует палец только в том же голосе", () => {
    const body =
      `<note>${pitchXml(60)}<duration>2</duration><tie type="start"/><voice>1</voice>` +
      `<staff>1</staff><notations><technical><fingering>5</fingering></technical></notations></note>` +
      `<backup><duration>2</duration></backup><forward><duration>1</duration></forward>` +
      `<note>${pitchXml(60)}<duration>1</duration><voice>2</voice><staff>1</staff>` +
      `<notations><technical><fingering>1</fingering></technical></notations></note>` +
      `<note>${pitchXml(60)}<duration>1</duration><tie type="stop"/><voice>1</voice><staff>1</staff></note>`;
    const xml =
      `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>` +
      `</score-part></part-list><part id="P1"><measure number="1"><attributes>` +
      `<divisions>1</divisions><staves>1</staves></attributes>${body}</measure></part>` +
      `</score-partwise>`;
    const plan = planFingering(xml, { mode: "fill" });
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(plan.assignments.get(notes[0].index)).toBe(5);
    expect(plan.assignments.get(notes[1].index)).toBe(1);
    expect(plan.assignments.get(notes[2].index)).toBe(5);
    expect(plan.suppressed.has(notes[2].index)).toBe(true);
  });

  test("третий нотоносец пропускается с предупреждением", () => {
    const extra =
      `<backup><duration>4</duration></backup><note>${pitchXml(36)}<duration>1</duration>` +
      `<voice>3</voice><staff>3</staff></note>`;
    const xml = makeScore({ right: [60], left: [48] })
      .replace("<staves>2</staves>", "<staves>3</staves>")
      .replace("</measure>", `${extra}</measure>`);
    const plan = planFingering(xml);
    const third = parseScore(xml).notes.find((note) => note.staff === "3" && note.midi !== undefined);
    expect(third).toBeDefined();
    expect(plan.assignments.has((third as { index: number }).index)).toBe(false);
    expect(plan.report.warnings.some((warning) => warning.includes("Пропущено нот"))).toBe(true);
  });

  test("cross-staff нота сохраняет доминирующую руку своего голоса", () => {
    const xml = makeScore({ left: [48, 50, 72, 53] })
      .replaceAll("<voice>2</voice>", "<voice>5</voice>")
      .replace(
        `${pitchXml(72)}<duration>1</duration><voice>5</voice><type>quarter</type><staff>2</staff>`,
        `${pitchXml(72)}<duration>1</duration><voice>5</voice><type>quarter</type><staff>1</staff>`,
      );
    const plan = planFingering(xml);
    const crossing = parseScore(xml).notes.find((note) => note.midi === 72);
    expect(crossing).toBeDefined();
    expect(plan.hands.get((crossing as { index: number }).index)).toBe("L");
    const annotated = annotateFingering(xml, plan);
    const crossingBody = parseScore(annotated).notes.find((note) => note.midi === 72)?.body;
    expect(crossingBody).toContain('placement="below"');
  });

  test("все звучащие ноты получают палец", () => {
    const xml = makeScore({ right: [60, 62, 64, 65, 67], left: [48, 50, 52, 53, 55] });
    const plan = planFingering(xml);
    const playable = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(playable.every((note) => plan.assignments.has(note.index))).toBe(true);
    expect(plan.report.stats.notes).toBe(playable.length);
  });

  test("результат детерминирован", () => {
    const xml = makeScore({ right: [60, 62, 64, 65, 67, 69, 71, 72], left: [48, 52, 55, 60] });
    const first = [...planFingering(xml).assignments.entries()];
    const second = [...planFingering(xml).assignments.entries()];
    expect(second).toEqual(first);
  });

  test("режим fill сохраняет авторские цифры", () => {
    const xml = makeScore({ right: [60, 62, 64, 65, 67, 69, 71, 72], fingerings: { 0: 2 } });
    const plan = planFingering(xml, { mode: "fill" });
    const notes = parseScore(xml).notes.filter((note) => note.midi !== undefined);
    expect(plan.assignments.get(notes[0].index)).toBe(2);
  });

  test("режим rebuild игнорирует авторские цифры", () => {
    const midis = [60, 62, 64, 65, 67, 69, 71, 72];
    const xml = stripFingering(makeScore({ right: midis, fingerings: { 0: 2, 1: 5 } }));
    expect(xml).not.toContain("<fingering");
    const fingers = fingersOf(xml, midis, "1");
    expect(fingers).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
  });

  test("отчёт считает нагрузку по тактам", () => {
    const xml = makeScore({ right: [60, 62, 64, 65, 67, 69, 71, 72] });
    const report = planFingering(xml).report;
    expect(report.measures.length).toBe(2);
    expect(Number.isFinite(report.stats.costPerNote)).toBe(true);
    expect(report.stats.ergonomicCostPerNote).toBeGreaterThan(0);
    expect(report.stats.costPerNote).toBeCloseTo(
      report.stats.ergonomicCostPerNote + report.stats.pedagogyAdjustmentPerNote,
      2,
    );
    expect(report.stats.costPerNote).not.toBe(report.stats.ergonomicCostPerNote);
    expect(report.patterns.some((pattern) => pattern.kind === "scale")).toBe(true);
  });

  test("трассировка объясняет выбор", () => {
    const xml = makeScore({ right: [60, 62, 64, 65, 67, 69, 71, 72] });
    const plan = planFingering(xml, { trace: true });
    expect(plan.trace.length).toBe(8);
    expect(plan.trace[0].hand).toBe("R");
    expect(plan.trace.some((item) => item.pattern === "scale")).toBe(true);
  });
});

describe("вставка в MusicXML", () => {
  test("нота без notations получает полный блок", () => {
    const xml = makeScore({ right: [60, 62, 64, 65], left: [48, 50, 52, 53] });
    const annotated = annotateFingering(xml, planFingering(xml));
    expect(annotated).toContain("<notations>");
    expect(annotated).toContain("<technical>");
    expect(annotated).toMatch(
      /<fingering placement="above" font-size="8" relative-y="2">\d<\/fingering>/,
    );
    expect(annotated).toMatch(
      /<fingering placement="below" font-size="8" relative-y="-2">\d<\/fingering>/,
    );
  });

  test("нота с notations получает technical внутрь", () => {
    const xml = makeScore({ right: [60, 62, 64, 65], slur: true });
    const annotated = annotateFingering(xml, planFingering(xml));
    expect((annotated.match(/<notations/g) ?? []).length).toBe(
      (xml.match(/<notations/g) ?? []).length,
    );
    expect(annotated).toContain("<slur");
    expect(annotated).toContain("<fingering");
  });

  test("повторная вставка ничего не дублирует", () => {
    const xml = makeScore({ right: [60, 62, 64, 65] });
    const once = annotateFingering(xml, planFingering(xml));
    const twice = annotateFingering(once, planFingering(once));
    expect(twice).toBe(once);
  });

  test("stripFingering снимает цифры и пустые обёртки", () => {
    const xml = makeScore({ right: [60, 62], fingerings: { 0: 1, 1: 2 } });
    const stripped = stripFingering(xml);
    expect(stripped).not.toContain("<fingering");
    expect(stripped).not.toContain("<technical>");
    expect(stripped).not.toContain("<notations>");
    expect(parseScore(stripped).notes.length).toBe(parseScore(xml).notes.length);
  });

  test("число нот и высоты не меняются", () => {
    const xml = makeScore({ right: [60, 62, 64, 65], left: [48, 50, 52, 53] });
    const annotated = annotateFingering(xml, planFingering(xml));
    const before = parseScore(xml).notes.map((note) => note.midi);
    const after = parseScore(annotated).notes.map((note) => note.midi);
    expect(after).toEqual(before);
  });

  test("на продолжении лиги цифра не печатается", () => {
    const xml = makeScore({ right: [60, 62] }).replace(
      "<duration>1</duration><voice>1</voice><type>quarter</type><staff>1</staff></note><note><pitch><step>D</step>",
      "<duration>1</duration><tie type=\"start\"/><voice>1</voice><type>quarter</type><staff>1</staff></note><note><pitch><step>C</step>",
    );
    const withTie = xml.replace(
      "<pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>",
      "<pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><tie type=\"stop\"/><voice>1</voice><type>quarter</type><staff>1</staff></note>",
    );
    const plan = planFingering(withTie);
    const notes = parseScore(withTie).notes.filter((note) => note.midi !== undefined);
    const tied = notes.filter((note) => note.tieStop);
    expect(tied.length).toBeGreaterThan(0);
    for (const note of tied) expect(plan.suppressed.has(note.index)).toBe(true);
    const annotated = annotateFingering(withTie, plan);
    expect((annotated.match(/<fingering/g) ?? []).length).toBe(notes.length - tied.length);
  });

  test("в файле остаётся отметка происхождения", () => {
    const xml = makeScore({ right: [60, 62] });
    const annotated = annotateFingering(xml, planFingering(xml));
    expect(annotated).toContain("pianomarvel fingering");
    expect(annotated).toContain(
      '<miscellaneous-field name="fingering-source">auto</miscellaneous-field>',
    );
  });

  test("одностановая левая рука получает placement below", () => {
    const xml = makeScore({ right: [36, 38, 40, 41] }).replace(
      "<staves>2</staves>",
      "<staves>1</staves>",
    );
    const annotated = annotateFingering(xml, planFingering(xml));
    expect(annotated).toContain(
      '<fingering placement="below" font-size="8" relative-y="-2">',
    );
    expect(annotated).not.toContain('<fingering placement="above"');
  });
});

describe("темп", () => {
  test("темп читается из <sound> и из <metronome> с точкой", () => {
    expect(parseScore(makeScore({ right: [60], tempo: 132 })).defaultTempo).toBe(132);
    const dotted = makeScore({ right: [60] }).replace(
      "</attributes>",
      "</attributes><direction><direction-type><metronome>" +
        "<beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>80</per-minute>" +
        "</metronome></direction-type></direction>",
    );
    // Четверть с точкой = 1.5 четверти, значит 80 таких долей = 120 четвертей.
    expect(parseScore(dotted).defaultTempo).toBe(120);
  });

  test("множитель скорости растёт только вниз от опорного интервала", () => {
    expect(motionScale(undefined)).toBe(1);
    expect(motionScale(1)).toBe(1);
    expect(motionScale(TEMPO_MODEL.referenceIpi)).toBe(1);
    expect(motionScale(TEMPO_MODEL.referenceIpi / 2)).toBeCloseTo(2, 5);
    expect(motionScale(0.001)).toBeCloseTo(TEMPO_MODEL.maxScale, 5);
  });

  test("правила движения дорожают быстрее правил позы", () => {
    const fast = tempoWeights(DEFAULT_WEIGHTS, TEMPO_MODEL.referenceIpi / 2);
    expect(fast.positionChangeCount).toBeCloseTo(2, 5);
    expect(fast.thumbPassing).toBeCloseTo(2, 5);
    expect(fast.handShift).toBeCloseTo(2, 5);
    expect(fast.stretch).toBeCloseTo(Math.SQRT2, 5);
    expect(fast.weakFinger).toBeCloseTo(Math.SQRT2, 5);
  });

  test("быстрый темп уводит фигуру от смены позиции", () => {
    const figure = [67, 72, 76, 79, 76, 72, 67, 72];
    const slow = fingersOf(makeScore({ right: figure, tempo: 40 }), figure, "1");
    const fast = fingersOf(makeScore({ right: figure, tempo: 200 }), figure, "1");
    const changes = (fingers: Finger[]): number =>
      fingers.filter((finger, index) => index > 0 && finger === 1 && fingers[index - 1] !== 1).length;
    expect(changes(fast)).toBeLessThanOrEqual(changes(slow));
  });
});

describe("повторяющиеся фигуры", () => {
  test("двузвучие внутри фигуры больше не выключает распознавание", () => {
    // Прежнее остинато опиралось на поток одиночных нот: любой аккорд делал
    // высоту «неизвестной» и весь такт возвращался к локальным тай-брейкам.
    const right: Array<number | number[]> = [
      [65, 73], 70, 67, [65, 73], 70, 67, [65, 73], 70,
    ];
    const xml = makeScore({ right, fifths: -3, tempo: 132 });
    const plan = planFingering(xml);
    expect(plan.report.patterns).toContainEqual(
      expect.objectContaining({ kind: "ostinato", label: "повторяющаяся фигура" }),
    );
    const notes = parseScore(xml).notes.filter((note) => note.staff === "1");
    const byPitch = new Map<number, Set<Finger>>();
    for (const note of notes) {
      const set = byPitch.get(note.midi as number) ?? new Set<Finger>();
      set.add(plan.assignments.get(note.index) as Finger);
      byPitch.set(note.midi as number, set);
    }
    // Одна высота — один палец на всех проведениях фигуры.
    for (const [, fingers] of byPitch) expect(fingers.size).toBe(1);
  });

  test("повтор фигуры удерживает форму руки и на неполном хвосте", () => {
    const right = [72, 76, 79, 72, 76, 79, 72, 76];
    const fingers = fingersOf(makeScore({ right, tempo: 132 }), right, "1");
    expect(fingers.slice(0, 3)).toEqual(fingers.slice(3, 6));
    expect(fingers.slice(0, 2)).toEqual(fingers.slice(6, 8));
  });
});

describe("перенос формы руки против мелодической линии", () => {
  test("выдержанный бас под нисходящим верхом не даёт повторять палец", () => {
    // Верх C5 → B4 → A4 → G4 при неподвижном D4; только белые клавиши, чтобы
    // не попасть на законное скольжение с чёрной на белую. Пока проверка
    // переноса смотрела только на многозвучность, повтор пальца в верхнем
    // голосе был бесплатным и линия получала 3-3-2 вместо связного спуска.
    const right: Array<number | number[]> = [[62, 72], [62, 71], [62, 69], [62, 67]];
    const xml = makeScore({ right, tempo: 132 });
    const plan = planFingering(xml);
    const top = parseScore(xml).notes
      .filter((note) => note.staff === "1" && note.chord)
      .map((note) => plan.assignments.get(note.index) as Finger);
    // Закон: соседние звуки движущегося голоса не могут делить палец.
    for (let i = 1; i < top.length; i += 1) expect(top[i]).not.toBe(top[i - 1]);
    // И линия идёт вниз вместе с высотой, а не скачет.
    expect(top).toEqual([...top].sort((left, right) => right - left));
  });

  test("параллельные октавы остаются переносом и повтор пальца в них свободен", () => {
    const right: Array<number | number[]> = [[60, 72], [62, 74], [64, 76], [65, 77]];
    const xml = makeScore({ right });
    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter((note) => note.staff === "1");
    const fingers = notes.map((note) => plan.assignments.get(note.index) as Finger);
    expect(fingers).toEqual([1, 5, 1, 5, 1, 5, 1, 5]);
  });
});

describe("повтор пальца — это перенос кисти, а не позиция", () => {
  test("правила 4 и 5 больше не объявляют тройку с повтором «без смены позиции»", () => {
    const key = (midi: number) => ({ midi, black: isBlackKey(midi) });
    // A4-C5-E5 пальцами 1-1-2: крайние ноты укладываются в MaxComf(1,2)=8,
    // и правило рапортовало ноль. Но большой физически переехал на терцию.
    const withRepeat = positionChangeCosts(tables, "R", [1, 1, 2], [key(69), key(72), key(76)]);
    expect(withRepeat.positionChangeCount).toBe(1);
    expect(withRepeat.positionChangeSize).toBe(3);
    // Скольжение с чёрной на белую тем же пальцем переносом не считается.
    const slide = positionChangeCosts(tables, "R", [2, 2, 3], [key(73), key(72), key(76)]);
    expect(slide.positionChangeCount).toBe(0);
  });

  test("одноктавное арпеджио получает 1-2-3-5, а не 1-1-2-5", () => {
    // Ля-минорное арпеджио шестнадцатыми. Пока повтор пальца обнулял правила
    // 4 и 5, вариант 1-1-2-5 стоил дешевле школьного: раскрытие кисти
    // штрафовалось, а переезд большого — нет.
    const right = [69, 72, 76, 81, 69, 72, 76, 81, 69, 72, 76, 81];
    const fingers = fingersOf(makeScore({ right, tempo: 120 }), right, "1");
    expect(fingers.slice(0, 4)).toEqual([1, 2, 3, 5]);
    expect(fingers.slice(4, 8)).toEqual([1, 2, 3, 5]);
    expect(fingers.slice(8, 12)).toEqual([1, 2, 3, 5]);
  });
});

describe("повторы на расстоянии", () => {
  test("одинаковые такты через чужой материал играются одинаково", () => {
    const phrase = [60, 64, 67, 72];
    const other = [77, 76, 74, 72];
    const right = [...phrase, ...other, ...phrase, ...other, ...phrase];
    const fingers = fingersOf(makeScore({ right, tempo: 120 }), right, "1");
    const at = (measure: number) => fingers.slice(measure * 4, measure * 4 + 4);
    expect(at(2)).toEqual(at(0));
    expect(at(4)).toEqual(at(0));
    expect(at(3)).toEqual(at(1));
  });
});

describe("недостижимый повтор пальца", () => {
  test("украшенный аккорд не оставляет палец на пути следующей ноты", () => {
    // Clocks, т.34: фигура C#5-B♭4-F4 идёт хватом 4-2-1, но первая C#5 несёт
    // сверху A♭5. Пока повтор пальца лишь оценивался, аккорд брался как 2+5 —
    // и второй палец должен был за 227 мс перепрыгнуть с C#5 на B♭4, то есть
    // выполнить переход, который `transitionFeasible` считает нереальным.
    const right: Array<number | number[]> = [
      [73, 80], 70, 65, 73, 70, 77, 75, 73,
      73, 70, 65, 73, 70, 65, 73, 79,
    ];
    const xml = makeScore({ right, fifths: -3, tempo: 132 });
    const plan = planFingering(xml);
    const notes = parseScore(xml).notes.filter((note) => note.staff === "1");
    const finger = (index: number) => plan.assignments.get(notes[index].index) as Finger;
    // Пальцы аккорда: нижний C#5, верхний A♭5.
    const [lower, upper] = [finger(0), finger(1)];
    expect(upper).toBeGreaterThan(lower);
    // Следующая нота не может достаться пальцу, только что игравшему C#5.
    expect(finger(2)).not.toBe(lower);
  });

  test("скольжение с чёрной на белую тем же пальцем остаётся законным", () => {
    const right = [73, 72, 74, 76];
    const fingers = fingersOf(makeScore({ right, fifths: -3, tempo: 132 }), right, "1");
    expect(fingers[0]).toBe(fingers[1]);
  });
});
