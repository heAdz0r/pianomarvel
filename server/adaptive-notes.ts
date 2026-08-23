/**
 * Структурная модель нот для Adaptive-анализа.
 *
 * Разбиение по тактам и regex-парсинг остаются такими же, как в
 * `adaptive-learning.ts` (Piano Marvel считает такты по печатной партитуре), но здесь
 * такт превращается в список событий с музыкальным временем. Мелодический слой,
 * гармония, повторность и гиперметр не могут работать по строкам XML: им нужны
 * высоты, доли и потоки.
 *
 * Единица времени — четверть. `<divisions>` у каждой партии своя и переносится между
 * тактами, поэтому курсор считается отдельно для каждой партии.
 */

export interface NoteEvent {
  /** Идентификатор партии в объединённом такте. */
  part: string;
  staff: string;
  voice: string;
  /** `part:staff:voice` — независимая музыкальная линия. */
  stream: string;
  /** Начало события от начала такта, в четвертях. */
  onset: number;
  /** Длительность в четвертях. */
  duration: number;
  /** MIDI-высота; undefined для паузы и для нот без `<pitch>`. */
  midi?: number;
  rest: boolean;
  /** Дополнительная нота аккорда: та же позиция, что у предыдущей. */
  chord: boolean;
  tieStart: boolean;
  tieStop: boolean;
  type: string;
  tuplet: boolean;
  accidental: boolean;
  grace: boolean;
  articulations: string[];
  ornament: boolean;
  arpeggiate: boolean;
  glissando: boolean;
  slurs: Array<{ type: string; number: string }>;
}

export interface MeasureNotes {
  /** Порядковый индекс такта от начала Whole. */
  index: number;
  events: NoteEvent[];
  /** Фактическая длительность такта в четвертях (по нотам). */
  actualQuarters: number;
  /** Номинальная длительность такта в четвертях (по размеру). */
  quarterBeats: number;
}

export interface CombinedMeasureBody {
  attributes: string;
  body: string;
}

const STEP_TO_PITCH_CLASS: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Явные пустые элементы (`<staccato/>`, `<tremolo/>`) и обычные пары тегов. */
const ARTICULATION_PATTERN =
  /<(staccato|staccatissimo|accent|strong-accent|tenuto|detached-legato|marcato|spiccato|portato)(?=[\s/>])/gi;
/** Без флага `g`: с ним `test` сохраняет lastIndex между вызовами и врёт через раз. */
const ORNAMENT_PATTERN =
  /<(?:trill-mark|turn|inverted-turn|delayed-turn|mordent|inverted-mordent|tremolo|wavy-line|schleifer)(?=[\s/>])/i;

/**
 * Такты партитуры, объединённые по всем партиям. Piano Marvel нумерует такты по
 * печатной партитуре, поэтому объединение идёт по индексу такта, а тело каждой партии
 * оборачивается в `<adaptive-part>`, чтобы `number="1"` одной руки не закрывал линию
 * другой.
 */
export function extractCombinedMeasures(xml: string): CombinedMeasureBody[] {
  if (/<score-timewise\b/i.test(xml)) {
    return matchElements(xml, "measure");
  }
  const parts = matchElements(xml, "part");
  if (parts.length === 0) return [];
  const byPart = parts.map((part) => matchElements(part.body, "measure"));
  const count = Math.max(0, ...byPart.map((measures) => measures.length));
  return Array.from({ length: count }, (_, index) => ({
    attributes: byPart.find((measures) => measures[index])?.[index]?.attributes ?? "",
    body: byPart
      .map(
        (measures, partIndex) =>
          `<adaptive-part index="${partIndex}">${measures[index]?.body ?? ""}</adaptive-part>`,
      )
      .join("\n"),
  }));
}

/**
 * Длительность каждого такта в четвертях. `<time>` в MusicXML появляется только при
 * смене размера, поэтому последнее известное значение переносится вперёд. Затакт,
 * `senza misura` и такты до первого `<time>` считаются по фактическим длительностям.
 */
export function quarterBeatsPerMeasure(
  bodies: CombinedMeasureBody[],
): number[] {
  let beats = 4;
  let beatType = 4;
  let hasKnownTime = false;
  const partDivisions = new Map<string, number>();
  return bodies.map((measure) => {
    const parsedBeats = Number(firstTagValue(measure.body, "beats"));
    const parsedBeatType = Number(firstTagValue(measure.body, "beat-type"));
    if (Number.isFinite(parsedBeats) && parsedBeats > 0) {
      beats = parsedBeats;
      hasKnownTime = true;
    }
    if (Number.isFinite(parsedBeatType) && parsedBeatType > 0) beatType = parsedBeatType;
    const nominal = (beats * 4) / beatType;
    const irregular =
      /\bimplicit=["']yes["']/i.test(measure.attributes) ||
      /\bnumber=["']0["']/i.test(measure.attributes) ||
      /<senza-misura(?=\s|\/|>)/i.test(measure.body) ||
      !hasKnownTime;
    if (!irregular) return nominal;
    const actual = actualQuartersOf(measure.body, partDivisions);
    return actual > 0 ? actual : nominal;
  });
}

function actualQuartersOf(
  body: string,
  partDivisions: Map<string, number>,
): number {
  let longest = 0;
  for (const part of splitParts(body)) {
    const declared = Number(firstTagValue(part.body, "divisions"));
    if (Number.isFinite(declared) && declared > 0) {
      partDivisions.set(part.id, declared);
    }
    const divisions = partDivisions.get(part.id) ?? 1;
    let cursor = 0;
    let maximum = 0;
    const pattern = /<(note|backup|forward)(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/gi;
    for (const match of part.body.matchAll(pattern)) {
      const kind = (match[1] ?? "").toLowerCase();
      const inner = match[2] ?? "";
      const duration = (Number(firstTagValue(inner, "duration")) || 0) / divisions;
      if (kind === "backup") {
        cursor -= duration;
        continue;
      }
      if (kind === "forward") {
        cursor += duration;
        maximum = Math.max(maximum, cursor);
        continue;
      }
      if (/<grace(?=\s|\/|>)/i.test(inner)) continue;
      if (/<chord(?=\s|\/|>)/i.test(inner)) continue;
      cursor += duration;
      maximum = Math.max(maximum, cursor);
    }
    longest = Math.max(longest, maximum);
  }
  return longest;
}

export function extractMeasureNotes(
  bodies: CombinedMeasureBody[],
  quarterBeatsByMeasure: number[],
): MeasureNotes[] {
  const partDivisions = new Map<string, number>();
  return bodies.map((measure, index) => {
    const parts = splitParts(measure.body);
    const events: NoteEvent[] = [];
    let actualQuarters = 0;
    for (const part of parts) {
      const declared = Number(firstTagValue(part.body, "divisions"));
      if (Number.isFinite(declared) && declared > 0) {
        partDivisions.set(part.id, declared);
      }
      const divisions = partDivisions.get(part.id) ?? 1;
      const partEvents = parsePartMeasure(part.body, part.id, divisions);
      events.push(...partEvents);
      const end = Math.max(
        0,
        ...partEvents
          .filter((event) => !event.grace)
          .map((event) => event.onset + event.duration),
      );
      actualQuarters = Math.max(actualQuarters, end);
    }
    return {
      index,
      events,
      actualQuarters,
      quarterBeats: quarterBeatsByMeasure[index] ?? actualQuarters,
    };
  });
}

function splitParts(body: string): Array<{ id: string; body: string }> {
  const wrapped = matchElements(body, "adaptive-part");
  if (wrapped.length > 0) {
    return wrapped.map((part, index) => ({
      id: `part:${attributeValue(part.attributes, "index") || index}`,
      body: part.body,
    }));
  }
  const timewise = matchElements(body, "part");
  if (timewise.length > 0) {
    return timewise.map((part, index) => ({
      id: `part:${attributeValue(part.attributes, "id") || index}`,
      body: part.body,
    }));
  }
  return [{ id: "part:0", body }];
}

/**
 * Курсор двигают только длительности звучащих событий. `<backup>`/`<forward>`
 * переносят его для второго нотоносца и второго голоса, `<chord>` возвращает на
 * позицию предыдущей атаки, `<grace>` не занимает времени.
 */
function parsePartMeasure(
  body: string,
  partId: string,
  divisions: number,
): NoteEvent[] {
  const events: NoteEvent[] = [];
  let cursor = 0;
  let previousOnset = 0;
  const pattern = /<(note|backup|forward)(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of body.matchAll(pattern)) {
    const kind = (match[1] ?? "").toLowerCase();
    const inner = match[2] ?? "";
    const duration = (Number(firstTagValue(inner, "duration")) || 0) / divisions;
    if (kind === "backup") {
      cursor -= duration;
      continue;
    }
    if (kind === "forward") {
      cursor += duration;
      continue;
    }
    const grace = /<grace(?=\s|\/|>)/i.test(inner);
    const chord = /<chord(?=\s|\/|>)/i.test(inner);
    const onset = grace ? cursor : chord ? previousOnset : cursor;
    const staff = firstTagValue(inner, "staff") || "1";
    const voice = firstTagValue(inner, "voice") || "1";
    events.push({
      part: partId,
      staff,
      voice,
      stream: `${partId}:${staff}:${voice}`,
      onset,
      duration: grace ? 0 : duration,
      midi: pitchOf(inner),
      rest: /<rest(?=\s|\/|>)/i.test(inner),
      chord,
      tieStart: /<tie\b[^>]*\btype=["']start["']/i.test(inner),
      tieStop: /<tie\b[^>]*\btype=["']stop["']/i.test(inner),
      type: firstTagValue(inner, "type").toLowerCase(),
      tuplet: /<time-modification(?=\s|>)/i.test(inner),
      accidental: /<alter>\s*-?[1-9]|<accidental(?=\s|>)/i.test(inner),
      grace,
      articulations: Array.from(inner.matchAll(ARTICULATION_PATTERN), (item) =>
        (item[1] ?? "").toLowerCase(),
      ),
      ornament: ORNAMENT_PATTERN.test(inner),
      arpeggiate: /<(?:arpeggiate|non-arpeggiate)(?=\s|\/|>)/i.test(inner),
      glissando: /<(?:glissando|slide)(?=\s|\/|>)/i.test(inner),
      slurs: Array.from(inner.matchAll(/<slur(?=[\s/>])([^>]*)>/gi), (item) => ({
        type: attributeValue(item[1] ?? "", "type").toLowerCase(),
        number: attributeValue(item[1] ?? "", "number") || "1",
      })),
    });
    if (!grace && !chord) {
      previousOnset = onset;
      cursor += duration;
    }
  }
  return events;
}

/** Звучащие атаки такта без добавочных нот аккорда, в порядке времени. */
export function attacksOf(measure: MeasureNotes): NoteEvent[] {
  return measure.events
    .filter((event) => !event.rest && !event.chord && !event.grace)
    .sort((left, right) => left.onset - right.onset);
}

/** Все звучащие ноты такта, включая ноты аккордов. */
export function soundingOf(measure: MeasureNotes): NoteEvent[] {
  return measure.events.filter(
    (event) => !event.rest && !event.grace && event.midi !== undefined,
  );
}

export function pitchOf(noteBody: string): number | undefined {
  const step = firstTagValue(noteBody, "step").toUpperCase();
  const octave = Number(firstTagValue(noteBody, "octave"));
  const alter = Number(firstTagValue(noteBody, "alter") || 0);
  const pitchClass = STEP_TO_PITCH_CLASS[step];
  if (pitchClass === undefined || !Number.isFinite(octave)) return undefined;
  return (octave + 1) * 12 + pitchClass + alter;
}

export function matchElements(
  xml: string,
  tag: string,
): Array<{ attributes: string; body: string }> {
  const pattern = elementPattern(tag);
  return Array.from(xml.matchAll(pattern), (match) => ({
    attributes: match[1] ?? "",
    body: match[2] ?? "",
  }));
}

export function attributeValue(attributes: string, attribute: string): string {
  const match = attributes.match(attributePattern(attribute));
  return match?.[1]?.trim() ?? "";
}

export function firstTagValue(xml: string, tag: string): string {
  const match = xml.match(tagValuePattern(tag));
  return match?.[1] ? match[1].replace(/<[^>]+>/g, "").trim() : "";
}

// Шаблоны зависят только от имени тега/атрибута. Их компиляция на каждую ноту
// была заметно дороже поиска по короткому XML-фрагменту.
const elementPatterns = new Map<string, RegExp>();
const attributePatterns = new Map<string, RegExp>();
const tagValuePatterns = new Map<string, RegExp>();

function elementPattern(tag: string): RegExp {
  let pattern = elementPatterns.get(tag);
  if (!pattern) {
    pattern = new RegExp(
      `<${tag}(?=\\s|>)([^>]*)>([\\s\\S]*?)<\\/${tag}>`,
      "gi",
    );
    elementPatterns.set(tag, pattern);
  }
  return pattern;
}

function attributePattern(attribute: string): RegExp {
  let pattern = attributePatterns.get(attribute);
  if (!pattern) {
    pattern = new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i");
    attributePatterns.set(attribute, pattern);
  }
  return pattern;
}

function tagValuePattern(tag: string): RegExp {
  let pattern = tagValuePatterns.get(tag);
  if (!pattern) {
    pattern = new RegExp(
      `<${tag}(?=\\s|>)[^>]*>([\\s\\S]*?)<\\/${tag}>`,
      "i",
    );
    tagValuePatterns.set(tag, pattern);
  }
  return pattern;
}
