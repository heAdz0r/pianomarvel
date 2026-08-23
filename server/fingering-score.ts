/**
 * Разбор MusicXML для подбора аппликатуры.
 *
 * Отличие от `adaptive-notes.ts`: здесь для каждой ноты сохраняются смещения
 * элемента `<note>` в исходном тексте — без них нельзя точечно вставить
 * `<fingering>`, не переписывая партитуру целиком (docs/fingering-prd.md §7.1).
 *
 * Разбор регулярными выражениями — тот же приём, что во всём проекте: MusicXML
 * от MuseScore и Piano Marvel хорошо структурирован, а полноценный XML-парсер
 * тянул бы зависимость ради одного места.
 */

import { isBlackKey } from "./fingering-model";

export interface ParsedNote {
  /** Порядковый номер элемента `<note>` в документе — стабильный ключ. */
  index: number;
  /** Смещения элемента `<note>…</note>` в исходном XML. */
  start: number;
  end: number;
  body: string;
  partId: string;
  partIndex: number;
  /** Индекс такта внутри партии, от нуля. */
  measureIndex: number;
  /** Номер такта из атрибута `number`, если он есть. */
  measureNumber: string;
  staff: string;
  voice: string;
  /** Абсолютное время в четвертях от начала партии. */
  onset: number;
  /** Время атаки внутри текущего такта, в четвертях. */
  measureOnset: number;
  duration: number;
  midi?: number;
  /** Исходное написание высоты; MIDI не различает, например, D♯ и E♭. */
  step?: string;
  alter?: number;
  octave?: number;
  /** Действующий в этой точке ключ MusicXML; меняется внутри партии. */
  keyFifths?: number;
  keyMode?: "major" | "minor";
  /**
   * Действующий темп в четвертях в минуту. Модель Parncutt откалибрована на
   * медленных фрагментах и темпа не знает; без этого поля вся эргономика
   * одинакова для хорала и для шестнадцатых в presto.
   */
  tempo?: number;
  rest: boolean;
  chord: boolean;
  grace: boolean;
  tieStart: boolean;
  tieStop: boolean;
  slurStart: boolean;
  slurStop: boolean;
  /** Номера лиг MusicXML; нужны для независимого состояния каждого голоса. */
  slurStarts: string[];
  slurStops: string[];
  /** Границы основной (`number=1`) beam-группы — полезная фразовая единица. */
  beamBegin: boolean;
  beamEnd: boolean;
  /** Перед этой нотой стоит финальная/повторная тактовая черта. */
  hardBreakBefore: boolean;
  staccato: boolean;
  /**
   * Состояние правой педали в момент атаки. Учитываются графические
   * `<pedal>` и playback-атрибут `<sound damper-pedal="…">`.
   */
  damperPedal: boolean;
  /** Уже проставленная в партитуре аппликатура. */
  fingering?: number;
}

export interface ParsedScore {
  notes: ParsedNote[];
  /** Максимальное число нотоносцев среди партий. */
  staves: number;
  /** Число нотоносцев отдельно по каждой партии. */
  stavesByPart: Map<number, number>;
  /** Число партий с нотами. */
  parts: number;
  /** Знак ключа по ключу `<partId>:<staff>`: G — скрипичный, F — басовый. */
  clefs: Map<string, string>;
  /** Квинтовый круг из `<key><fifths>`, если объявлен. */
  fifths?: number;
  /** Первый объявленный темп партитуры в четвертях в минуту. */
  defaultTempo?: number;
  minorMode: boolean;
  warnings: string[];
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

const ELEMENT_PATTERN =
  /<(note|backup|forward|attributes|direction)(?=[\s>])[^>]*>([\s\S]*?)<\/\1>|<sound(?=[\s>])([^>]*)\/>/gi;
const MEASURE_PATTERN = /<measure(?=[\s>])([^>]*)>([\s\S]*?)<\/measure>/gi;
const PART_PATTERN = /<part(?=[\s>])([^>]*)>([\s\S]*?)<\/part>/gi;
const CLEF_PATTERN = /<clef(?=[\s>])([^>]*)>([\s\S]*?)<\/clef>/gi;

interface PedalChange {
  onset: number;
  down: boolean;
  order: number;
}

export function parseScore(xml: string): ParsedScore {
  const warnings: string[] = [];
  const notes: ParsedNote[] = [];
  const clefs = new Map<string, string>();
  const stavesByPart = new Map<number, number>();
  let staves = 1;
  let noteIndex = 0;
  let partIndex = 0;

  const fifthsRaw = firstTag(xml, "fifths");
  const fifths = fifthsRaw === "" ? undefined : Number(fifthsRaw);
  const minorMode = /<mode>\s*minor\s*<\/mode>/i.test(xml);
  const defaultTempo = firstTempo(xml);

  if (/<score-timewise\b/i.test(xml)) {
    warnings.push("score-timewise не поддерживается подбором аппликатуры.");
    return { notes, staves, stavesByPart, parts: 0, clefs, fifths, minorMode, warnings };
  }

  for (const part of matchAll(xml, PART_PATTERN)) {
    const partId = attribute(part.groups[0] ?? "", "id") || `P${partIndex + 1}`;
    const partNoteStart = notes.length;
    const pedalChanges: PedalChange[] = [];
    let pedalChangeOrder = 0;
    let partStaves = 1;
    let divisions = 1;
    let measureStart = 0;
    let measureIndex = 0;
    let keyFifths = fifths;
    let keyMode: "major" | "minor" | undefined = minorMode ? "minor" : undefined;
    let previousHardBreak = false;
    let tempo = defaultTempo;

    for (const measure of matchAll(part.groups[1] ?? "", MEASURE_PATTERN)) {
      const measureOffset = part.contentStart + measure.start;
      const measureNumber = attribute(measure.groups[0] ?? "", "number") || String(measureIndex + 1);
      const body = measure.groups[1] ?? "";
      const bodyOffset = measureOffset + measure.contentStart - measure.start;
      const hardBreakBefore = previousHardBreak || hasHardLeftBarline(body);

      let cursor = 0;
      let previousOnset = 0;
      let longest = 0;
      let graceRank = 0;

      for (const element of matchAll(body, ELEMENT_PATTERN)) {
        const directSoundAttributes = element.groups[2];
        const kind = directSoundAttributes === undefined
          ? (element.groups[0] ?? "").toLowerCase()
          : "sound";
        const inner = element.groups[1] ?? "";

        if (kind === "sound") {
          const declaredTempo = tempoAttribute(directSoundAttributes ?? "");
          if (declaredTempo !== undefined) tempo = declaredTempo;
          const down = damperPedalValue(attribute(directSoundAttributes ?? "", "damper-pedal"));
          if (down !== undefined) {
            pedalChanges.push({
              onset: measureStart + cursor,
              down,
              order: pedalChangeOrder++,
            });
          }
          continue;
        }

        if (kind === "attributes") {
          const declared = Number(firstTag(inner, "divisions"));
          if (Number.isFinite(declared) && declared > 0) divisions = declared;
          const declaredStaves = Number(firstTag(inner, "staves"));
          if (Number.isFinite(declaredStaves) && declaredStaves > 0) {
            staves = Math.max(staves, declaredStaves);
            partStaves = Math.max(partStaves, declaredStaves);
          }
          const declaredFifths = firstTag(inner, "fifths");
          if (declaredFifths !== "" && Number.isFinite(Number(declaredFifths))) {
            keyFifths = Number(declaredFifths);
          }
          const declaredMode = firstTag(inner, "mode").toLowerCase();
          if (declaredMode === "major" || declaredMode === "minor") {
            keyMode = declaredMode;
          }
          for (const clef of matchAll(inner, CLEF_PATTERN)) {
            const number = attribute(clef.groups[0] ?? "", "number") || "1";
            const sign = firstTag(clef.groups[1] ?? "", "sign").toUpperCase();
            const key = `${partId}:${number}`;
            if (sign && !clefs.has(key)) clefs.set(key, sign);
          }
          continue;
        }

        if (kind === "direction") {
          const declaredTempo = directionTempo(inner);
          if (declaredTempo !== undefined) tempo = declaredTempo;
          const offset = (Number(firstTag(inner, "offset")) || 0) / divisions;
          for (const down of directionPedalChanges(inner)) {
            pedalChanges.push({
              onset: measureStart + cursor + offset,
              down,
              order: pedalChangeOrder++,
            });
          }
          continue;
        }

        const duration = (Number(firstTag(inner, "duration")) || 0) / divisions;
        if (kind === "backup") {
          cursor -= duration;
          continue;
        }
        if (kind === "forward") {
          cursor += duration;
          longest = Math.max(longest, cursor);
          continue;
        }

        const grace = /<grace(?=[\s/>])/i.test(inner);
        const chord = /<chord(?=[\s/>])/i.test(inner);
        const pitch = pitchOf(inner);
        // Форшлаг звучит перед основной нотой и не занимает времени: сдвигаем его
        // на бесконечно малую величину, иначе он склеится с ней в один аккорд.
        graceRank = grace ? graceRank + 1 : 0;
        const onset = chord ? previousOnset : grace ? cursor - 0.01 + graceRank / 1000 : cursor;
        notes.push({
          index: noteIndex++,
          start: bodyOffset + element.start,
          end: bodyOffset + element.end,
          body: inner,
          partId,
          partIndex,
          measureIndex,
          measureNumber,
          staff: firstTag(inner, "staff") || "1",
          voice: firstTag(inner, "voice") || "1",
          onset: measureStart + onset,
          measureOnset: onset,
          duration: grace ? 0 : duration,
          midi: pitch?.midi,
          step: pitch?.step,
          alter: pitch?.alter,
          octave: pitch?.octave,
          keyFifths,
          keyMode,
          tempo,
          rest: /<rest(?=[\s/>])/i.test(inner),
          chord,
          grace,
          tieStart: /<tie\b[^>]*\btype=["']start["']/i.test(inner),
          tieStop: /<tie\b[^>]*\btype=["']stop["']/i.test(inner),
          slurStart: /<slur\b[^>]*\btype=["']start["']/i.test(inner),
          slurStop: /<slur\b[^>]*\btype=["']stop["']/i.test(inner),
          slurStarts: slurNumbers(inner, "start"),
          slurStops: slurNumbers(inner, "stop"),
          beamBegin: beamValue(inner) === "begin",
          beamEnd: beamValue(inner) === "end",
          hardBreakBefore,
          staccato: /<stacc(?:ato|atissimo)(?=[\s/>])/i.test(inner),
          damperPedal: false,
          fingering: parseFingering(inner),
        });

        if (!grace && !chord) {
          previousOnset = cursor;
          cursor += duration;
          longest = Math.max(longest, cursor);
        }
      }

      measureStart += longest;
      previousHardBreak = hasHardRightBarline(body);
      measureIndex += 1;
    }
    applyPedalTimeline(notes.slice(partNoteStart), pedalChanges);
    stavesByPart.set(partIndex, partStaves);
    partIndex += 1;
  }

  return {
    notes,
    staves,
    stavesByPart,
    parts: partIndex,
    clefs,
    fifths,
    defaultTempo,
    minorMode,
    warnings,
  };
}

/**
 * Темп из MusicXML в четвертях в минуту.
 *
 * `<sound tempo>` по спецификации уже задан в четвертях. `<metronome>` задан в
 * произвольной доле, поэтому переводится через длительность `<beat-unit>`
 * (с точками). Оба источника встречаются вперемешку: MuseScore пишет
 * `<metronome>` для видимого обозначения и `<sound>` для воспроизведения.
 */
const BEAT_UNIT_QUARTERS: Record<string, number> = {
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
};

function plausibleTempo(value: number): number | undefined {
  return Number.isFinite(value) && value >= 10 && value <= 400 ? value : undefined;
}

function tempoAttribute(attributes: string): number | undefined {
  const raw = attribute(attributes, "tempo");
  if (raw === "") return undefined;
  return plausibleTempo(Number(raw));
}

function metronomeTempo(inner: string): number | undefined {
  const block = inner.match(/<metronome\b[^>]*>([\s\S]*?)<\/metronome>/i)?.[1];
  if (!block) return undefined;
  const perMinute = Number(firstTag(block, "per-minute"));
  if (!Number.isFinite(perMinute) || perMinute <= 0) return undefined;
  const unit = firstTag(block, "beat-unit").trim().toLowerCase();
  const base = BEAT_UNIT_QUARTERS[unit];
  if (base === undefined) return undefined;
  const dots = (block.match(/<beat-unit-dot\b/gi) ?? []).length;
  // Точка добавляет половину предыдущей длительности: 1.5, 1.75, …
  const quarters = base * (2 - Math.pow(0.5, dots));
  return plausibleTempo(perMinute * quarters);
}

function directionTempo(inner: string): number | undefined {
  for (const match of inner.matchAll(/<sound\b([^>]*)\/?>/gi)) {
    const value = tempoAttribute(match[1] ?? "");
    if (value !== undefined) return value;
  }
  return metronomeTempo(inner);
}

/** Первый темп документа: нужен нотам, стоящим до первого обозначения. */
function firstTempo(xml: string): number | undefined {
  for (const match of xml.matchAll(/<sound\b([^>]*)\/?>/gi)) {
    const value = tempoAttribute(match[1] ?? "");
    if (value !== undefined) return value;
  }
  for (const match of xml.matchAll(/<direction(?=[\s>])[^>]*>([\s\S]*?)<\/direction>/gi)) {
    const value = metronomeTempo(match[1] ?? "");
    if (value !== undefined) return value;
  }
  return undefined;
}

function directionPedalChanges(inner: string): boolean[] {
  const changes: boolean[] = [];
  const pattern = /<pedal\b([^>]*)\/?>|<sound\b([^>]*)\/?>/gi;
  for (const match of inner.matchAll(pattern)) {
    const pedalAttributes = match[1];
    if (pedalAttributes !== undefined) {
      const type = attribute(pedalAttributes, "type").toLowerCase();
      if (type === "start" || type === "change" || type === "resume") changes.push(true);
      else if (type === "stop" || type === "discontinue") changes.push(false);
      continue;
    }
    const down = damperPedalValue(attribute(match[2] ?? "", "damper-pedal"));
    if (down !== undefined) changes.push(down);
  }
  return changes;
}

function damperPedalValue(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes") return true;
  if (normalized === "no") return false;
  if (normalized === "") return undefined;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric > 0 : undefined;
}

function applyPedalTimeline(notes: ParsedNote[], changes: PedalChange[]): void {
  const ordered = [...changes].sort(
    (left, right) => left.onset - right.onset || left.order - right.order,
  );
  const attacks = [...notes].sort(
    (left, right) => left.onset - right.onset || left.index - right.index,
  );
  let down = false;
  let changeIndex = 0;
  for (const note of attacks) {
    while (
      changeIndex < ordered.length &&
      ordered[changeIndex].onset <= note.onset + 1e-4
    ) {
      down = ordered[changeIndex].down;
      changeIndex += 1;
    }
    note.damperPedal = down;
  }
}

/** Звучащая нота с высотой: только такие получают палец. */
export function isPlayable(note: ParsedNote): boolean {
  return !note.rest && note.midi !== undefined;
}

export function isBlack(note: ParsedNote): boolean {
  return note.midi === undefined ? false : isBlackKey(note.midi);
}

function parseFingering(inner: string): number | undefined {
  const match = inner.match(/<fingering\b[^>]*>([^<]*)<\/fingering>/i);
  if (!match) return undefined;
  const value = Number((match[1] ?? "").trim());
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : undefined;
}

function slurNumbers(inner: string, type: "start" | "stop"): string[] {
  const result: string[] = [];
  const pattern = /<slur\b([^>]*)\/?>/gi;
  for (const match of inner.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    if (attribute(attributes, "type").toLowerCase() !== type) continue;
    result.push(attribute(attributes, "number") || "1");
  }
  return result;
}

function beamValue(inner: string): string {
  const match = inner.match(
    /<beam\b([^>]*)>([^<]*)<\/beam>/gi,
  );
  if (!match) return "";
  for (const beam of match) {
    const attributes = beam.match(/<beam\b([^>]*)>/i)?.[1] ?? "";
    if ((attribute(attributes, "number") || "1") !== "1") continue;
    return beam.replace(/<[^>]+>/g, "").trim().toLowerCase();
  }
  return "";
}

function hasHardLeftBarline(measureBody: string): boolean {
  return barlines(measureBody).some(
    ({ location, body }) =>
      location === "left" &&
      (/<bar-style>\s*heavy-light\s*<\/bar-style>/i.test(body) ||
        /<repeat\b[^>]*\bdirection=["']forward["']/i.test(body)),
  );
}

function hasHardRightBarline(measureBody: string): boolean {
  return barlines(measureBody).some(
    ({ location, body }) =>
      location !== "left" &&
      (/<bar-style>\s*(?:light-heavy|heavy-heavy)\s*<\/bar-style>/i.test(body) ||
        /<repeat\b[^>]*\bdirection=["']backward["']/i.test(body)),
  );
}

function barlines(measureBody: string): Array<{ location: string; body: string }> {
  return [...measureBody.matchAll(/<barline\b([^>]*)>([\s\S]*?)<\/barline>/gi)].map(
    (match) => ({
      location: (attribute(match[1] ?? "", "location") || "right").toLowerCase(),
      body: match[2] ?? "",
    }),
  );
}

function pitchOf(
  inner: string,
): { midi: number; step: string; alter: number; octave: number } | undefined {
  const step = firstTag(inner, "step").toUpperCase();
  const octave = Number(firstTag(inner, "octave"));
  const alter = Number(firstTag(inner, "alter") || 0);
  const pitchClass = STEP_TO_PITCH_CLASS[step];
  if (pitchClass === undefined || !Number.isFinite(octave)) return undefined;
  return { midi: (octave + 1) * 12 + pitchClass + alter, step, alter, octave };
}

interface Matched {
  /** Смещение всего элемента в переданной строке. */
  start: number;
  /** Смещение конца элемента (исключая). */
  end: number;
  /** Смещение начала содержимого элемента. */
  contentStart: number;
  groups: Array<string | undefined>;
}

function matchAll(source: string, pattern: RegExp): Matched[] {
  const regex = new RegExp(pattern.source, pattern.flags);
  const result: Matched[] = [];
  for (const match of source.matchAll(regex)) {
    const start = match.index ?? 0;
    const whole = match[0];
    const content = [...match.slice(1)].reverse().find((group) => group !== undefined) ?? "";
    const contentStart = content ? whole.lastIndexOf(content) : whole.length;
    result.push({
      start,
      end: start + whole.length,
      contentStart: start + contentStart,
      groups: match.slice(1),
    });
  }
  return result;
}

function firstTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? match[1].replace(/<[^>]+>/g, "").trim() : "";
}

function attribute(attributes: string, name: string): string {
  return attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? "";
}
