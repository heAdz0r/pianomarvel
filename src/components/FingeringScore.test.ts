import { describe, expect, test } from "bun:test";
import { parse } from "@vue/compiler-sfc";

interface FingeringScoreHelpers {
  attributeCardsFromSymbols: (
    symbols: Array<Record<string, unknown>>,
  ) => Array<{
    id: string;
    kind: string;
    role: string;
    title: string;
    detail: string;
    scope: string;
  }>;
  buildFingeringNoteTooltip: (facts: Record<string, unknown>) => {
    pitch: string;
    duration: string;
    finger?: string;
    fingerLabel: string;
    handAndStaff: string;
    voice: string;
    context: string[];
    ariaLabel: string;
    rest: boolean;
    beat?: string;
    showVoice: boolean;
  };
  mergeFingeringNoteFacts: (
    facts: Record<string, unknown>[],
  ) => Record<string, unknown> | undefined;
  groupSharedUnisonTargets: <TTarget, TFacts>(
    candidates: Array<{
      target?: TTarget;
      pitchKey: string;
      printObject: boolean;
      sharesVisibleUnison: boolean;
      facts: TFacts;
    }>,
  ) => Map<TTarget, TFacts[]>;
  pickNoteheadByIndex: <T>(noteheads: T[], index: number) => T | undefined;
  measureWindowRange: (
    selected: number,
    span: number,
    total: number,
  ) => { from: number; to: number };
  countSpanAt: (
    cells: Array<{
      offsetQuarters: number;
      syllable: string;
      label: string;
    }>,
    onsetQuarters: number,
    durationQuarters: number,
  ) => string | undefined;
  parseMeasureLearning: (xml: string, measure: number) => {
    measureIndex: number;
    measureLabels: string[];
    symbols: Array<{
      kind: string;
      label: string;
      detail: string;
      count: number;
      unknown?: boolean;
    }>;
    rhythm: {
      meter?: string;
      pulse: string;
      pickup: boolean;
      actualQuarters: number;
      expectedQuarters?: number;
      subdivisions: number;
      pulseCount: number;
      spoken: string;
      cells: Array<{
        offsetQuarters: number;
        pulse: number;
        syllable: string;
        label: string;
        pulseStart: boolean;
        kind: "attack" | "rest" | "hold" | "silent";
        hands: Array<"right" | "left">;
        handStates: Record<"right" | "left", {
          kind: "attack" | "rest" | "hold" | "silent";
          attackOnsets: number;
          staccatoAttacks: number;
          attackNotes: number;
          heldNotes: number;
          restEvents: number;
          restStarts: number;
          durations: string[];
          continuesFrom: boolean;
          continuesAfter: boolean;
        }>;
        attacksInside: number;
        offGrid: boolean;
      }>;
      items: Array<{
        offsetQuarters: number;
        pulse: number;
        syllable: string;
        label: string;
        attacksInside: number;
      }>;
      explanation: string;
    };
    playback: {
      notes: Array<{
        onsetQuarters: number;
        durationQuarters: number;
        midi: number;
        hand: "right" | "left";
        grace: boolean;
      }>;
      quarters: number;
      pulseLength: number;
      quarterBpm?: number;
    };
    glyphDetails: {
      clef: Array<{ title: string; summary: string; lines: string[] }>;
      key: Array<{ title: string; summary: string; lines: string[] }>;
      time: Array<{ title: string; summary: string; lines: string[] }>;
    };
  };
}

async function loadPureHelpers(): Promise<FingeringScoreHelpers> {
  const filename = new URL("./FingeringScore.vue", import.meta.url);
  const source = await Bun.file(filename).text();
  const { descriptor, errors } = parse(source, { filename: filename.pathname });
  if (errors.length) throw errors[0];
  if (!descriptor.script) throw new Error("FingeringScore.vue has no module script");

  const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
  const javascript = transpiler.transformSync(descriptor.script.content);
  const executable = javascript.replace(/^export\s+/gm, "");
  return Function(
    `${executable}
    return {
      attributeCardsFromSymbols,
      buildFingeringNoteTooltip,
      countSpanAt,
      groupSharedUnisonTargets,
      mergeFingeringNoteFacts,
      measureWindowRange,
      parseMeasureLearning,
      pickNoteheadByIndex,
    };`,
  )() as FingeringScoreHelpers;
}

const helpers = await loadPureHelpers();

function baseFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    step: 5,
    octave: 4,
    accidental: 0,
    drawnAccidental: 0,
    durationType: 8,
    durationNumerator: 1,
    durationDenominator: 12,
    dots: 0,
    fingers: ["2"],
    hand: "right",
    staffNumber: 1,
    staffPosition: "upper",
    voiceIds: [2],
    tie: true,
    tuplet: { actual: 3, normal: 2 },
    chord: true,
    grace: false,
    ...overrides,
  };
}

const EDUCATIONAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <staves>2</staves>
        <key><fifths>-3</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><rest measure="yes"/><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <note>
        <pitch><step>F</step><alter>1</alter><octave>4</octave></pitch>
        <duration>3</duration><voice>1</voice><type>eighth</type><dot/>
        <accidental cautionary="yes">sharp</accidental>
        <beam number="1">begin</beam>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <notations>
          <tied type="start"/>
          <slur type="start" number="1"/>
          <tuplet type="start"/>
          <arpeggiate/>
          <glissando type="start" number="1">gliss.</glissando>
          <articulations><staccato/></articulations>
          <ornaments>
            <trill-mark/>
            <tremolo type="single">2</tremolo>
            <accidental-mark>sharp</accidental-mark>
          </ornaments>
          <technical><fingering placement="above">2</fingering></technical>
          <dynamics><mf/></dynamics>
          <fermata/>
          <other-notation>Авторский знак</other-notation>
          <mystery-notation>Новый знак</mystery-notation>
        </notations>
      </note>
      <note>
        <chord/>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>3</duration><voice>1</voice><type>eighth</type><dot/>
      </note>
      <note>
        <grace slash="yes"/>
        <pitch><step>G</step><octave>4</octave></pitch>
        <voice>1</voice><type>eighth</type>
      </note>
      <note>
        <rest/><duration>4</duration><voice>1</voice><type>quarter</type>
      </note>
      <note print-object="no">
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>4</duration><voice>1</voice><type>quarter</type>
        <notations><technical><fingering>5</fingering></technical><other-notation>Секретный знак</other-notation></notations>
      </note>
      <direction>
        <direction-type>
          <dynamics><f/></dynamics>
          <wedge type="crescendo"/>
          <pedal type="start" line="yes"/>
          <octave-shift type="down" size="8"/>
          <future-symbol>Нейтральное будущее обозначение</future-symbol>
          <words print-object="no">Секретная ремарка</words>
        </direction-type>
      </direction>
      <barline location="right">
        <ending number="1" type="start">1.</ending>
        <repeat direction="backward"/>
      </barline>
    </measure>
  </part>
</score-partwise>`;

const CONTINUING_SPANS_XML = `<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction><direction-type><wedge type="crescendo" number="1"/></direction-type></direction>
      <direction><direction-type><pedal type="start" number="1" line="yes"/></direction-type></direction>
      <direction><direction-type><octave-shift type="down" number="1" size="8"/></direction-type></direction>
      <direction><direction-type><dashes type="start" number="1"/></direction-type></direction>
      <direction><direction-type><bracket type="start" number="1"/></direction-type></direction>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>whole</type>
        <notations><tied type="start" number="1"/><slur type="start" number="1"/></notations>
      </note>
      <backup><duration>4</duration></backup>
      <note>
        <pitch><step>G</step><octave>3</octave></pitch>
        <duration>4</duration><voice>2</voice><type>whole</type>
        <notations><slur type="start" number="1"/></notations>
      </note>
    </measure>
    <measure number="2">
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>whole</type>
        <notations><tied type="stop" number="1"/><tied type="start" number="1"/></notations>
      </note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><type>whole</type></note>
    </measure>
    <measure number="3">
      <direction><direction-type><wedge type="stop" number="1"/></direction-type></direction>
      <direction><direction-type><pedal type="stop" number="1" line="yes"/></direction-type></direction>
      <direction><direction-type><octave-shift type="stop" number="1" size="8"/></direction-type></direction>
      <direction><direction-type><dashes type="stop" number="1"/></direction-type></direction>
      <direction><direction-type><bracket type="stop" number="1"/></direction-type></direction>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>whole</type>
        <notations><tied type="stop" number="1"/><slur type="stop" number="1"/></notations>
      </note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>B</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><type>whole</type></note>
    </measure>
    <measure number="4">
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><voice>2</voice><type>whole</type>
        <notations><slur type="stop" number="1"/></notations>
      </note>
    </measure>
    <measure number="5">
      <note><rest measure="yes"/><duration>4</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

function rhythmScore(
  targetMeasure: string,
  {
    divisions,
    beats,
    beatType,
  }: { divisions: number; beats: number; beatType: number },
): string {
  return `<score-partwise version="4.0">
    <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1">
      <measure number="1">
        <attributes>
          <divisions>${divisions}</divisions>
          <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
          <clef><sign>G</sign><line>2</line></clef>
        </attributes>
        <note><rest measure="yes"/><duration>${divisions * beats * (4 / beatType)}</duration><voice>1</voice><type>whole</type></note>
      </measure>
      <measure number="2">${targetMeasure}</measure>
    </part>
  </score-partwise>`;
}

describe("FingeringScore: чистое сопоставление нот OSMD", () => {
  test("берёт головку с индексом конкретной ноты аккорда", () => {
    const lower = { id: "lower" };
    const upper = { id: "upper" };

    expect(helpers.pickNoteheadByIndex([lower, upper], 1)).toBe(upper);
    expect(helpers.pickNoteheadByIndex([lower, upper], -1)).toBeUndefined();
    expect(helpers.pickNoteheadByIndex([lower, upper], 2)).toBeUndefined();
  });

  test("строит русскую доступную подпись со всей музыкальной семантикой", () => {
    const tooltip = helpers.buildFingeringNoteTooltip(baseFacts());

    expect(tooltip).toMatchObject({
      pitch: "Фа♯4",
      duration: "восьмая",
      finger: "2",
      fingerLabel: "Палец",
      handAndStaff: "Правая рука · верхний стан",
      voice: "Мелодическая линия 2",
      context: ["диез", "лига", "триоль 3:2", "аккорд"],
    });
    expect(tooltip.ariaLabel).toContain("Фа-диез, октава 4");
    expect(tooltip.ariaLabel).toContain("палец 2");
    // Служебный номер стана из подписи убран: «верхний стан» уже всё говорит.
    expect(tooltip.handAndStaff).not.toContain("(");
    // Голос второй, поэтому про мелодическую линию сказать стоит.
    expect(tooltip.showVoice).toBe(true);
  });

  test("учитывает графический бекар и фильтрует пальцы вне диапазона 1–5", () => {
    const tooltip = helpers.buildFingeringNoteTooltip(baseFacts({
      step: 11,
      octave: 3,
      accidental: 2,
      drawnAccidental: 3,
      fingers: ["0", "3", "6", "3"],
      hand: "left",
      staffNumber: 2,
      staffPosition: "lower",
      voiceIds: [1],
      tie: false,
      tuplet: undefined,
      chord: false,
    }));

    expect(tooltip.pitch).toBe("Си♮3");
    expect(tooltip.finger).toBe("3");
    expect(tooltip.context).toEqual(["бекар"]);
    expect(tooltip.handAndStaff).toBe("Левая рука · нижний стан");
    // Одноголосная фактура: строка про мелодическую линию только мешала бы.
    expect(tooltip.showVoice).toBe(false);
  });

  test("без <type> длительность называется словом, а не дробью", () => {
    // OSMD отдаёт NoteType.UNDEFINED (0), когда в MusicXML нет <type>.
    const eighth = helpers.buildFingeringNoteTooltip(baseFacts({
      durationType: 0,
      durationNumerator: 1,
      durationDenominator: 8,
      tuplet: undefined,
    }));
    const dotted = helpers.buildFingeringNoteTooltip(baseFacts({
      durationType: 0,
      durationNumerator: 3,
      durationDenominator: 8,
      dots: 1,
      tuplet: undefined,
    }));
    const exotic = helpers.buildFingeringNoteTooltip(baseFacts({
      durationType: 0,
      durationNumerator: 5,
      durationDenominator: 16,
      tuplet: undefined,
    }));

    expect(eighth.duration).toBe("восьмая");
    // Дробь 3/8 уже означает «с точкой», второй раз это не приписывается.
    expect(dotted.duration).toBe("четвертная с точкой");
    // Совсем нестандартную длительность честно называем долей целой.
    expect(exotic.duration).toBe("доля 5/16 целой");
  });

  test("объединяет голоса и пальцы у общей унисонной головки", () => {
    const merged = helpers.mergeFingeringNoteFacts([
      baseFacts({
        fingers: ["1"],
        voiceIds: [1],
        tie: false,
        durationType: 10,
        durationNumerator: 1,
        durationDenominator: 2,
      }),
      baseFacts({
        fingers: ["5"],
        voiceIds: [3],
        chord: false,
        durationType: 9,
        durationNumerator: 1,
        durationDenominator: 4,
      }),
    ]);
    expect(merged).toBeDefined();

    const tooltip = helpers.buildFingeringNoteTooltip(merged!);
    expect(tooltip.finger).toBe("1 / 5");
    expect(tooltip.fingerLabel).toBe("Пальцы");
    expect(tooltip.voice).toBe("Мелодические линии 1, 3");
    expect(tooltip.duration).toBe(
      "Линия 1: половинная · Линия 3: четвертная",
    );
    expect(tooltip.context).toContain("лига");
    expect(tooltip.context).toContain("аккорд");
  });

  test("сливает скрытый унисон с видимой головкой, но игнорирует прочие скрытые ноты", () => {
    const visibleHead = { id: "visible-c4" };
    const otherHead = { id: "visible-e4" };
    const grouped = helpers.groupSharedUnisonTargets([
      {
        target: undefined,
        pitchKey: "C4",
        printObject: false,
        sharesVisibleUnison: true,
        facts: "скрытый голос 2",
      },
      {
        target: visibleHead,
        pitchKey: "C4",
        printObject: true,
        sharesVisibleUnison: false,
        facts: "видимый голос 1",
      },
      {
        target: otherHead,
        pitchKey: "E4",
        printObject: true,
        sharesVisibleUnison: false,
        facts: "видимый голос 1, ми",
      },
      {
        target: undefined,
        pitchKey: "D4",
        printObject: false,
        sharesVisibleUnison: false,
        facts: "обычная скрытая нота",
      },
    ]);

    expect(grouped.get(visibleHead)).toEqual([
      "видимый голос 1",
      "скрытый голос 2",
    ]);
    expect(grouped.get(otherHead)).toEqual(["видимый голос 1, ми"]);
    expect([...grouped.values()].flat()).not.toContain("обычная скрытая нота");
  });

  test("обозначает форшлаг и точки без потери длительности", () => {
    const tooltip = helpers.buildFingeringNoteTooltip(baseFacts({
      durationType: 9,
      durationNumerator: 3,
      durationDenominator: 8,
      dots: 2,
      grace: true,
      accidental: 2,
      drawnAccidental: 2,
      fingers: [],
      tie: false,
      tuplet: undefined,
      chord: false,
    }));

    expect(tooltip.duration).toBe("форшлаг · четвертная с двумя точками");
    expect(tooltip.finger).toBeUndefined();
  });
});

describe("FingeringScore: учебное чтение MusicXML", () => {
  test("показывает спаны, начатые раньше, и снимает их после stop", () => {
    const insideSpan = helpers.parseMeasureLearning(CONTINUING_SPANS_XML, 2);
    const labels = insideSpan.symbols.map((symbol) => symbol.label);
    expect(labels).toContain("Крещендо продолжается");
    expect(labels).toContain("Педаль продолжается");
    expect(labels).toContain("Октавный перенос продолжается · down 8");
    expect(labels).toContain("Пунктирная линия продолжается");
    expect(labels).toContain("Текстовая скобка продолжается");
    expect(labels).toContain("Фразировочная лига продолжается");
    expect(labels).toContain("Лига длительности продолжается");

    const secondVoiceStillActive = helpers.parseMeasureLearning(CONTINUING_SPANS_XML, 4);
    expect(
      secondVoiceStillActive.symbols.filter((symbol) =>
        symbol.label.endsWith("продолжается")
      ).map((symbol) => symbol.label),
    ).toEqual(["Фразировочная лига продолжается"]);

    const afterStop = helpers.parseMeasureLearning(CONTINUING_SPANS_XML, 5);
    expect(
      afterStop.symbols.some((symbol) => symbol.label.includes("продолжается")),
    ).toBe(false);
  });

  test("наследует ключ, знаки и размер и описывает полный набор видимых обозначений", () => {
    const learning = helpers.parseMeasureLearning(EDUCATIONAL_XML, 2);
    const kinds = new Set(learning.symbols.map((symbol) => symbol.kind));
    const requiredKinds = [
      "clef",
      "key",
      "time",
      "duration",
      "rest",
      "fingering",
      "accidental",
      "beam",
      "tuplet",
      "tie",
      "slur",
      "articulation",
      "dynamic",
      "wedge",
      "pedal",
      "arpeggiate",
      "grace",
      "ornament",
      "repeat",
      "ending",
      "octave-shift",
      "tremolo",
      "glissando",
      "unknown",
    ];

    expect(learning.measureLabels).toEqual(["2"]);
    for (const kind of requiredKinds) expect(kinds.has(kind)).toBe(true);
    expect(learning.glyphDetails.clef.map((detail) => detail.title)).toEqual([
      "Скрипичный ключ",
      "Басовый ключ",
    ]);
    expect(learning.glyphDetails.key).toHaveLength(2);
    expect(learning.glyphDetails.key[0]?.summary).toContain("си♭, ми♭, ля♭");
    expect(learning.glyphDetails.key[0]?.lines[0]).toContain(
      "ми-бемоль мажор / до минор",
    );
    expect(learning.glyphDetails.time[0]?.summary).toContain("4/4");
    expect(learning.symbols.some((symbol) =>
      symbol.label === "Восьмая с точкой нота"
    )).toBe(true);
    expect(learning.symbols.find((symbol) =>
      symbol.label.includes("future-symbol")
    )?.unknown).toBe(true);

    const serialized = JSON.stringify(learning);
    expect(serialized).not.toContain("Секретный знак");
    expect(serialized).not.toContain("Секретная ремарка");
  });

  test("строит счёт шестнадцатыми по реальным onset", () => {
    const sixteenth = `<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type></note>`;
    const learning = helpers.parseMeasureLearning(
      rhythmScore(sixteenth.repeat(4), { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(learning.rhythm.pickup).toBe(false);
    expect(learning.rhythm.subdivisions).toBe(4);
    expect(learning.rhythm.items.map((item) => item.label)).toEqual([
      "Раз",
      "Раз-та",
      "Раз-и",
      "Раз-та",
    ]);
    expect(learning.rhythm.items.map((item) => item.attacksInside)).toEqual([1, 1, 1, 1]);
    expect(learning.rhythm.spoken.startsWith("раз та и та")).toBe(true);
  });

  test("считает триоль как «Раз-три-оль»", () => {
    const triplet = `<note>
      <pitch><step>C</step><octave>4</octave></pitch>
      <duration>1</duration><voice>1</voice><type>eighth</type>
      <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
    </note>`;
    const learning = helpers.parseMeasureLearning(
      rhythmScore(triplet.repeat(3), { divisions: 3, beats: 4, beatType: 4 }),
      2,
    );

    expect(learning.rhythm.items.map((item) => item.label)).toEqual([
      "Раз",
      "Раз-три",
      "Раз-оль",
    ]);
  });

  test("группирует 6/8 по пунктирным четвертям", () => {
    const eighth = `<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>`;
    const learning = helpers.parseMeasureLearning(
      rhythmScore(eighth.repeat(6), { divisions: 2, beats: 6, beatType: 8 }),
      2,
    );

    expect(learning.rhythm.pulse).toBe("пунктирная четверть");
    expect(learning.rhythm.items.map((item) => item.label)).toEqual([
      "Раз",
      "Раз-и",
      "Раз-а",
      "Два",
      "Два-и",
      "Два-а",
    ]);
  });

  test("не выдумывает начало полного такта для затакта", () => {
    const pickup = `<score-partwise version="4.0">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1">
        <measure number="0" implicit="yes">
          <attributes>
            <divisions>2</divisions>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef><sign>G</sign><line>2</line></clef>
          </attributes>
          <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>
          <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>
        </measure>
      </part>
    </score-partwise>`;
    const learning = helpers.parseMeasureLearning(pickup, 1);

    expect(learning.rhythm.pickup).toBe(true);
    expect(learning.rhythm.actualQuarters).toBe(1);
    expect(learning.rhythm.items.map((item) => item.label)).toEqual([
      "Четыре",
      "Четыре-и",
    ]);
  });

  test("учитывает chord, backup, forward и скрытые события без дублей счёта", () => {
    const body = `
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><grace/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice><type>eighth</type></note>
      <forward><duration>4</duration></forward>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <backup><duration>12</duration></backup>
      <note print-object="no"><pitch><step>A</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>eighth</type></note>
      <note><pitch><step>B</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>eighth</type></note>
    `;
    const learning = helpers.parseMeasureLearning(
      rhythmScore(body, { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(learning.rhythm.items.map((item) => item.offsetQuarters)).toEqual([
      0,
      0.5,
      2,
    ]);
    expect(learning.rhythm.items.map((item) => item.label)).toEqual([
      "Раз",
      "Раз-и",
      "Три",
    ]);
  });
});

describe("FingeringScore: окно показа тактов", () => {
  const window = (selected: number, span: number, total: number) =>
    helpers.measureWindowRange(selected, span, total);

  test("окно из одного такта — это выбранный такт", () => {
    expect(window(4, 1, 20)).toEqual({ from: 4, to: 4 });
  });

  test("окно из трёх и пяти тактов начинается с выбранного", () => {
    expect(window(4, 3, 20)).toEqual({ from: 4, to: 6 });
    expect(window(4, 5, 20)).toEqual({ from: 4, to: 8 });
  });

  test("у конца партитуры окно сдвигается назад, а не обрезается", () => {
    expect(window(19, 3, 20)).toEqual({ from: 18, to: 20 });
    expect(window(20, 5, 20)).toEqual({ from: 16, to: 20 });
  });

  test("короткая партитура не выходит за свои границы", () => {
    expect(window(1, 5, 2)).toEqual({ from: 1, to: 2 });
    expect(window(1, 3, 0)).toEqual({ from: 1, to: 1 });
  });
});

describe("FingeringScore: пауза и учебные карточки", () => {
  test("пауза получает свой тултип, счёт и объяснение вместо высоты", () => {
    const tooltip = helpers.buildFingeringNoteTooltip(
      baseFacts({
        rest: true,
        fingers: [],
        tie: false,
        tuplet: undefined,
        chord: false,
        durationType: 9,
        durationNumerator: 1,
        durationDenominator: 4,
        beatLabel: "Два-и",
        hand: "left",
        staffPosition: "lower",
        staffNumber: 2,
      }),
    );

    expect(tooltip.rest).toBe(true);
    expect(tooltip.pitch).toBe("Пауза");
    expect(tooltip.beat).toBe("Два-и");
    expect(tooltip.finger).toBeUndefined();
    expect(tooltip.context).toContain("тишина, но время идёт");
    expect(tooltip.ariaLabel).toContain("Пауза");
    expect(tooltip.ariaLabel).toContain("на счёт «Два-и»");
    // Высота паузы не проговаривается: её не существует.
    expect(tooltip.ariaLabel).not.toContain("октава");
  });

  test("нота сообщает, на какой счёт она попадает", () => {
    const tooltip = helpers.buildFingeringNoteTooltip(baseFacts({ beatLabel: "Раз-и" }));

    expect(tooltip.rest).toBe(false);
    expect(tooltip.beat).toBe("Раз-и");
    expect(tooltip.ariaLabel).toContain("на счёт «Раз-и»");
  });

  test("одинаковый размер на двух станах — одна карточка, а не две", () => {
    const cards = helpers.attributeCardsFromSymbols([
      {
        id: "time-1",
        kind: "time",
        label: "Размер 4/4",
        detail: "4/4 · стан 1. Верхнее число — доли.",
        count: 1,
        interactive: "time",
      },
      {
        id: "time-2",
        kind: "time",
        label: "Размер 4/4",
        detail: "4/4 · стан 2. Верхнее число — доли.",
        count: 1,
        interactive: "time",
      },
      {
        id: "clef-1",
        kind: "clef",
        label: "Скрипичный ключ",
        detail: "G на 2-й линейке · стан 1. Определяет высоту.",
        count: 1,
        interactive: "clef",
      },
      {
        id: "noise",
        kind: "slur",
        label: "Фразировочная лига",
        detail: "Связная фраза.",
        count: 1,
      },
    ]);

    expect(cards).toHaveLength(2);
    expect(cards[0]?.role).toBe("Размер");
    expect(cards[0]?.scope).toBe("оба стана");
    expect(cards[0]?.detail).not.toContain("стан");
    expect(cards[1]?.role).toBe("Ключ");
    expect(cards[1]?.scope).toBe("верхний стан · правая");
    // Не-атрибутивные знаки в карточки не попадают.
    expect(cards.some((card) => card.kind === "slur")).toBe(false);
  });
});

describe("FingeringScore: метрическая сетка счёта", () => {
  const note = (
    step: string,
    duration: number,
    type: string,
    extra = "",
  ): string =>
    `<note><pitch><step>${step}</step><octave>4</octave></pitch>`
    + `<duration>${duration}</duration><voice>1</voice><type>${type}</type>${extra}</note>`;

  test("доля существует, даже когда на ней ничего не начинается", () => {
    const body = `${note("C", 4, "quarter")}${note("D", 8, "half")}${note("E", 4, "quarter")}`;
    const { rhythm } = helpers.parseMeasureLearning(
      rhythmScore(body, { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(rhythm.subdivisions).toBe(2);
    expect(rhythm.cells.map((cell) => cell.label)).toEqual([
      "Раз",
      "Раз-и",
      "Два",
      "Два-и",
      "Три",
      "Три-и",
      "Четыре",
      "Четыре-и",
    ]);
    // Третья доля — это та самая доля, которой не было в счёте по атакам.
    expect(rhythm.cells.map((cell) => cell.kind)).toEqual([
      "attack",
      "hold",
      "attack",
      "hold",
      "hold",
      "hold",
      "attack",
      "hold",
    ]);
    expect(rhythm.spoken).toBe("раз и два и три и четыре и");
    expect(rhythm.explanation).toContain("звук тянется");
  });

  test("выписанная пауза остаётся отдельной клеткой счёта", () => {
    const rest = `<note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>`;
    const body = `${note("C", 4, "quarter")}${rest}${note("D", 4, "quarter")}${rest}`;
    const { rhythm } = helpers.parseMeasureLearning(
      rhythmScore(body, { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(rhythm.cells.map((cell) => cell.kind)).toEqual([
      "attack",
      "hold",
      "rest",
      "rest",
      "attack",
      "hold",
      "rest",
      "rest",
    ]);
    expect(rhythm.explanation).toContain("тишина");
  });

  test("подразделение выбирается по самой мелкой атаке такта", () => {
    const body = `${note("C", 2, "eighth")}${note("D", 2, "eighth")}`
      + `${note("E", 4, "quarter")}${note("F", 8, "half")}`;
    const { rhythm } = helpers.parseMeasureLearning(
      rhythmScore(body, { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(rhythm.subdivisions).toBe(2);
    expect(rhythm.pulseCount).toBe(4);
    expect(rhythm.cells).toHaveLength(8);
    expect(rhythm.spoken).toBe("раз и два и три и четыре и");
    // Половинная нота с третьей доли тянется через «три-и», «четыре» и «четыре-и».
    expect(rhythm.cells.filter((cell) => cell.kind === "hold")).toHaveLength(4);
  });

  test("целая нота в 4/4 проговаривается по восьмым и тянется весь такт", () => {
    const { rhythm } = helpers.parseMeasureLearning(
      rhythmScore(note("C", 16, "whole"), { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(rhythm.spoken).toBe("раз и два и три и четыре и");
    expect(rhythm.cells.map((cell) => cell.handStates.right.kind)).toEqual([
      "attack",
      "hold",
      "hold",
      "hold",
      "hold",
      "hold",
      "hold",
      "hold",
    ]);
    expect(rhythm.cells[0]?.handStates.right.continuesAfter).toBe(true);
    expect(rhythm.cells.at(-1)?.handStates.right.continuesFrom).toBe(true);
    expect(helpers.countSpanAt(rhythm.cells, 0, 4)).toBe(
      "Раз-и-Два-и-Три-и-Четыре-и",
    );
  });

  test("длительность не заходит в следующую клетку после точной границы", () => {
    const body = [
      note("C", 4, "quarter"),
      note("D", 4, "quarter"),
      note("E", 4, "quarter"),
      note("F", 4, "quarter"),
    ].join("");
    const { rhythm } = helpers.parseMeasureLearning(
      rhythmScore(body, { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(rhythm.cells[2]?.label).toBe("Два");
    expect(rhythm.cells[2]?.handStates.right.continuesFrom).toBe(false);
  });

  test("staccato сохраняет нотированную длительность, но не велит держать клавишу", () => {
    const staccato = note(
      "C",
      4,
      "quarter",
      "<notations><articulations><staccato/></articulations></notations>",
    );
    const { rhythm } = helpers.parseMeasureLearning(
      rhythmScore(
        `${staccato}${note("D", 4, "quarter")}${note("E", 8, "half")}`,
        { divisions: 4, beats: 4, beatType: 4 },
      ),
      2,
    );

    expect(rhythm.cells[0]?.handStates.right.staccatoAttacks).toBe(1);
    expect(rhythm.cells[0]?.handStates.right.durations).toContain("четверть");
    expect(rhythm.cells[0]?.handStates.right.continuesAfter).toBe(false);
    expect(rhythm.cells[1]?.handStates.right.kind).toBe("silent");
  });

  test("одна рука может держать голос и одновременно взять новые ноты", () => {
    const polyphony = `<score-partwise version="4.0">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>1</divisions>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef><sign>G</sign><line>2</line></clef>
          </attributes>
          <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
          <backup><duration>4</duration></backup>
          <forward><duration>2</duration></forward>
          <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice><type>half</type></note>
          <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice><type>half</type></note>
        </measure>
      </part>
    </score-partwise>`;
    const { rhythm } = helpers.parseMeasureLearning(polyphony, 1);
    const onThree = rhythm.cells.find((cell) => cell.label === "Три");

    expect(onThree?.handStates.right.kind).toBe("attack");
    expect(onThree?.handStates.right.heldNotes).toBe(1);
    expect(onThree?.handStates.right.attackNotes).toBe(2);
  });

  test("пунктирная восьмая и шестнадцатая попадают на «Раз» и последнюю «Раз-та»", () => {
    const body = `${note("C", 3, "eighth", "<dot/>")}${note("D", 1, "16th")}`
      + `${note("E", 4, "quarter")}${note("F", 8, "half")}`;
    const { rhythm } = helpers.parseMeasureLearning(
      rhythmScore(body, { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(rhythm.subdivisions).toBe(4);
    expect(
      rhythm.items.slice(0, 2).map((cell) => cell.label),
    ).toEqual(["Раз", "Раз-та"]);
  });

  test("объясняет синкопу: четверть на «Два-и» тянется через «Три»", () => {
    const eighth = (step: string) => note(step, 2, "eighth");
    const body = [
      eighth("C"),
      eighth("D"),
      eighth("E"),
      note("F", 4, "quarter"),
      eighth("G"),
      eighth("A"),
      eighth("B"),
    ].join("");
    const { rhythm } = helpers.parseMeasureLearning(
      rhythmScore(body, { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(rhythm.cells.map((cell) => cell.kind)).toEqual([
      "attack",
      "attack",
      "attack",
      "attack",
      "hold",
      "attack",
      "attack",
      "attack",
    ]);
    expect(rhythm.explanation).toContain(
      "Правая рука: новые ноты — «Раз», «Раз-и», «Два», «Два-и», «Три-и», «Четыре», «Четыре-и»",
    );
    expect(rhythm.explanation).toContain(
      "Правая рука, синкопа: четверть начинается на «Два-и» и проходит через «Три»",
    );
  });

  test("руки размечены по стабильному стану, а не по действующему ключу", () => {
    const twoStaves = `<score-partwise version="4.0">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>1</divisions><staves>2</staves>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef number="1"><sign>G</sign><line>2</line></clef>
            <clef number="2"><sign>G</sign><line>2</line></clef>
          </attributes>
          <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
          <backup><duration>4</duration></backup>
          <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
        </measure>
      </part>
    </score-partwise>`;
    const { rhythm, playback } = helpers.parseMeasureLearning(twoStaves, 1);

    expect(rhythm.cells[0]?.hands.sort()).toEqual(["left", "right"]);
    expect(playback.notes.map((item) => item.hand).sort()).toEqual(["left", "right"]);
  });

  test("дорожки рук сохраняют длительность баса под атаками верхнего стана", () => {
    const upperEighths = ["C", "D", "E", "F", "G", "A", "B", "C"]
      .map((step, index) =>
        `<note><pitch><step>${step}</step><octave>${index === 7 ? 5 : 4}</octave></pitch>`
        + `<duration>1</duration><voice>1</voice><type>eighth</type><staff>1</staff></note>`
      )
      .join("");
    const twoHands = `<score-partwise version="4.0">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>2</divisions><staves>2</staves>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef number="1"><sign>G</sign><line>2</line></clef>
            <clef number="2"><sign>F</sign><line>4</line></clef>
          </attributes>
          ${upperEighths}
          <backup><duration>8</duration></backup>
          <note><pitch><step>C</step><octave>3</octave></pitch>
            <duration>8</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
        </measure>
      </part>
    </score-partwise>`;
    const { rhythm } = helpers.parseMeasureLearning(twoHands, 1);

    expect(rhythm.cells.map((cell) => cell.handStates.right.kind)).toEqual(
      Array(8).fill("attack"),
    );
    expect(rhythm.cells.map((cell) => cell.handStates.left.kind)).toEqual([
      "attack",
      "hold",
      "hold",
      "hold",
      "hold",
      "hold",
      "hold",
      "hold",
    ]);
    expect(rhythm.cells[0]?.handStates.left.continuesAfter).toBe(true);
    expect(rhythm.cells[7]?.handStates.left.continuesFrom).toBe(true);
    expect(rhythm.spoken).toBe("раз и два и три и четыре и");
  });

  test("tie-stop в новом такте остаётся удержанием и повторно не звучит", () => {
    const tied = `<score-partwise version="4.0">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>1</divisions>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef><sign>G</sign><line>2</line></clef>
          </attributes>
          <note><pitch><step>C</step><octave>4</octave></pitch>
            <duration>4</duration><voice>1</voice><type>whole</type>
            <tie type="start"/><notations><tied type="start"/></notations></note>
        </measure>
        <measure number="2">
          <note><pitch><step>C</step><octave>4</octave></pitch>
            <duration>4</duration><voice>1</voice><type>whole</type>
            <tie type="stop"/><notations><tied type="stop"/></notations></note>
        </measure>
      </part>
    </score-partwise>`;
    const { rhythm, playback } = helpers.parseMeasureLearning(tied, 2);

    expect(rhythm.cells[0]?.handStates.right.kind).toBe("hold");
    expect(rhythm.items).toHaveLength(0);
    expect(playback.notes).toHaveLength(0);
  });

  test("темп берётся из партитуры и не выдумывается", () => {
    const withTempo = `<direction><direction-type><metronome>
        <beat-unit>quarter</beat-unit><per-minute>96</per-minute>
      </metronome></direction-type></direction>${note("C", 4, "quarter")}`;
    const tempo = helpers.parseMeasureLearning(
      rhythmScore(withTempo, { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );
    const silent = helpers.parseMeasureLearning(
      rhythmScore(note("C", 4, "quarter"), { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(tempo.playback.quarterBpm).toBe(96);
    expect(silent.playback.quarterBpm).toBeUndefined();
  });

  test("проигрывание получает аккорд целиком и форшлаг с опережением", () => {
    const body = `${note("C", 4, "quarter")}`
      + `<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>`
      + `<note><grace/><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><voice>1</voice><type>eighth</type></note>`
      + `${note("G", 12, "half", "<dot/>")}`;
    const { playback } = helpers.parseMeasureLearning(
      rhythmScore(body, { divisions: 4, beats: 4, beatType: 4 }),
      2,
    );

    expect(playback.quarters).toBe(4);
    expect(playback.pulseLength).toBe(1);
    expect(playback.notes.map((item) => item.midi)).toEqual([60, 64, 66, 67]);
    const grace = playback.notes.find((item) => item.grace);
    expect(grace?.onsetQuarters).toBeCloseTo(0.875, 5);
    expect(grace?.durationQuarters).toBeCloseTo(0.125, 5);
  });
});
