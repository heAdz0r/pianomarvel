<script lang="ts">
export type FingeringHand = "right" | "left";
export type FingeringStaffPosition = "upper" | "lower";

export interface FingeringDurationVariant {
  voiceId: number;
  durationType: number;
  durationNumerator: number;
  durationDenominator: number;
  dots: number;
  grace: boolean;
  finger?: string;
}

export interface FingeringNoteFacts {
  step: number;
  octave: number;
  accidental: number;
  drawnAccidental?: number;
  durationType: number;
  durationNumerator: number;
  durationDenominator: number;
  dots: number;
  fingers: string[];
  hand?: FingeringHand;
  staffNumber: number;
  staffPosition?: FingeringStaffPosition;
  voiceIds: number[];
  tie: boolean;
  tuplet?: {
    actual: number;
    normal?: number;
  };
  chord: boolean;
  grace: boolean;
  durationVariants?: FingeringDurationVariant[];
  /** Пауза: у неё нет высоты, но есть длительность, доля и рука. */
  rest?: boolean;
  /** Позиция атаки внутри такта в четвертях. */
  onsetQuarters?: number;
  /**
   * Полный интервал метрического счёта. Для шестнадцатой это «Раз-и», для
   * целой в 4/4 — «Раз-и-Два-и-Три-и-Четыре-и».
   */
  beatLabel?: string;
  /** Номер такта из партитуры: в окне из нескольких тактов он неочевиден. */
  measureLabel?: string;
}

export interface FingeringNoteTooltip {
  pitch: string;
  duration: string;
  finger?: string;
  fingerLabel: "Палец" | "Пальцы";
  handAndStaff: string;
  voice: string;
  context: string[];
  ariaLabel: string;
  rest: boolean;
  /** Полная метрическая позиция или интервал, которые занимает событие. */
  beat?: string;
  /**
   * Стоит ли говорить про мелодическую линию. В одноголосной фактуре «линия 1»
   * не сообщает ученику ничего, кроме лишней строки.
   */
  showVoice: boolean;
}

export interface SharedUnisonCandidate<TTarget, TFacts> {
  target?: TTarget;
  pitchKey: string;
  printObject: boolean;
  sharesVisibleUnison: boolean;
  facts: TFacts;
}

export interface MeasureVisibleSymbol {
  id: string;
  kind: string;
  label: string;
  detail: string;
  count: number;
  interactive?: "clef" | "key" | "time";
  unknown?: boolean;
}

/** Карточка активного обозначения такта: один сигнал — одна карточка. */
export interface AttributeCard {
  id: string;
  kind: string;
  role: string;
  title: string;
  detail: string;
  /** К каким станам относится сигнал, человеческими словами. */
  scope: string;
}

const ATTRIBUTE_ROLES: Record<string, string> = {
  clef: "Ключ",
  key: "Тональность",
  time: "Размер",
};

/**
 * Одинаковый сигнал на двух станах — это один сигнал. Раньше панель печатала
 * «Размер 4/4 · стан 1» и «Размер 4/4 · стан 2» как два независимых факта, и
 * половина учебной панели состояла из дублей.
 */
export function attributeCardsFromSymbols(
  symbols: readonly MeasureVisibleSymbol[],
): AttributeCard[] {
  const cards = new Map<string, AttributeCard & { staves: Set<string> }>();
  for (const symbol of symbols) {
    if (!symbol.interactive) continue;
    // Из «си♭, ми♭, ля♭ · стан 1. Тоника…» вынимаем номер стана и общий текст.
    const staff = /стан\s+([\wа-яё-]+)/i.exec(symbol.detail)?.[1] ?? "";
    const detail = symbol.detail.replace(/\s*·\s*стан\s+[\wа-яё-]+/i, "");
    const key = `${symbol.kind}|${symbol.label}|${detail}`;
    const existing = cards.get(key);
    if (existing) {
      if (staff) existing.staves.add(staff);
      continue;
    }
    cards.set(key, {
      id: symbol.id,
      kind: symbol.kind,
      role: ATTRIBUTE_ROLES[symbol.kind] ?? "Обозначение",
      title: symbol.label,
      detail,
      scope: "",
      staves: new Set(staff ? [staff] : []),
    });
  }
  return [...cards.values()].map(({ staves, ...card }) => ({
    ...card,
    scope: staves.size >= 2
      ? "оба стана"
      : staves.has("1")
        ? "верхний стан · правая"
        : staves.has("2")
          ? "нижний стан · левая"
          : "",
  }));
}

export interface GuideDetail {
  title: string;
  summary: string;
  lines: string[];
  ariaLabel: string;
}

/**
 * Что происходит в конкретной клетке метрической сетки.
 *
 * `attack` — здесь берётся новый звук, `rest` — выписанная пауза,
 * `hold` — ничего не начинается, но звук тянется с прошлой клетки,
 * `silent` — тишина без выписанной паузы (например, хвост неполного такта).
 */
export type RhythmCellKind = "attack" | "rest" | "hold" | "silent";

/**
 * Действие одной руки в одной позиции общего счёта.
 *
 * Общая клетка не может честно описать фортепианную фактуру: пока правая рука
 * берёт восьмые, левая может держать целую. Поэтому агрегированный `kind`
 * сохранён только для проигрывателя и старых читателей, а учебный UI строится
 * по двум независимым состояниям рук.
 */
export interface RhythmHandState {
  kind: RhythmCellKind;
  /** Число отдельных атак внутри позиции счёта. */
  attackOnsets: number;
  /** Число новых нот с артикуляцией staccato. */
  staccatoAttacks: number;
  /** Число одновременно взятых нот: значение > 1 означает аккорд. */
  attackNotes: number;
  /** Сколько нот этой руки уже звучало к началу позиции. */
  heldNotes: number;
  /** Сколько выписанных пауз перекрывает позицию. */
  restEvents: number;
  /** Сколько выписанных пауз начинается именно в этой позиции. */
  restStarts: number;
  /** Реальные длительности перекрывающих позицию событий из MusicXML. */
  durations: string[];
  /** Линия длительности входит в позицию слева. */
  continuesFrom: boolean;
  /** Линия длительности доходит до правой границы позиции. */
  continuesAfter: boolean;
}

export interface RhythmHandSummary {
  hand: FingeringHand;
  attacks: string[];
  holds: string[];
  rests: string[];
}

export interface RhythmSyncopation {
  hand: FingeringHand;
  start: string;
  crossed: string;
  duration: string;
}

export interface RhythmCountItem {
  offsetQuarters: number;
  pulse: number;
  syllable: string;
  label: string;
  pulseStart: boolean;
  kind: RhythmCellKind;
  hands: FingeringHand[];
  /** Независимые дорожки правой и левой руки на общей метрической оси. */
  handStates: Record<FingeringHand, RhythmHandState>;
  /** Сколько новых звуков берётся внутри этого счёта: две шестнадцатые — два. */
  attacksInside: number;
  /** Внутри счёта больше одной атаки — по учебнику это «две на раз». */
  offGrid: boolean;
}

export interface RhythmCountGuide {
  meter?: string;
  pulse: string;
  pickup: boolean;
  actualQuarters: number;
  expectedQuarters?: number;
  /** Реальное разрешение ритма внутри доли: 1, 2, 3 или 4 позиции. */
  subdivisions: number;
  pulseCount: number;
  /** Непрерывная сетка счёта: доли и их подразделения без пропусков. */
  cells: RhythmCountItem[];
  /** Только клетки с событием; сохранено для совместимости старых читателей. */
  items: RhythmCountItem[];
  /** Краткая учебная инструкция отдельно для каждой присутствующей руки. */
  handSummaries: RhythmHandSummary[];
  /** Синкопы с точной рукой и позициями общего счёта. */
  syncopations: RhythmSyncopation[];
  explanation: string;
  /** Строка для счёта вслух с разрешением фактического ритма такта. */
  spoken: string;
}

/** Одна нота для проигрывания такта; паузы сюда не попадают. */
export interface MeasurePlaybackNote {
  onsetQuarters: number;
  durationQuarters: number;
  midi: number;
  hand: FingeringHand;
  grace: boolean;
}

export interface MeasurePlayback {
  notes: MeasurePlaybackNote[];
  /** Длина проигрываемого такта в четвертях. */
  quarters: number;
  /** Длина доли в четвертях: 1 для 4/4, 1.5 для 6/8. */
  pulseLength: number;
  /**
   * Действующий темп партитуры в четвертях в минуту. `undefined` означает, что
   * в MusicXML темпа нет — интерфейс обязан сказать это прямо.
   */
  quarterBpm?: number;
}

export interface MeasureLearningData {
  measureIndex: number;
  measureLabels: string[];
  symbols: MeasureVisibleSymbol[];
  rhythm: RhythmCountGuide;
  playback: MeasurePlayback;
  glyphDetails: {
    clef: GuideDetail[];
    key: GuideDetail[];
    time: GuideDetail[];
  };
}

const RUSSIAN_NOTE_NAMES: Record<number, string> = {
  0: "до",
  2: "ре",
  4: "ми",
  5: "фа",
  7: "соль",
  9: "ля",
  11: "си",
};

const ACCIDENTAL_LABELS: Record<number, { symbol: string; label: string }> = {
  0: { symbol: "♯", label: "диез" },
  1: { symbol: "♭", label: "бемоль" },
  3: { symbol: "♮", label: "бекар" },
  4: { symbol: "𝄪", label: "дубль-диез" },
  5: { symbol: "𝄫", label: "дубль-бемоль" },
  6: { symbol: "♯♯♯", label: "тройной диез" },
  7: { symbol: "♭♭♭", label: "тройной бемоль" },
  8: { symbol: "¼♯", label: "четвертитоновый диез" },
  9: { symbol: "¼♭", label: "четвертитоновый бемоль" },
  10: { symbol: "♭̸", label: "слэш-бемоль" },
  11: { symbol: "¾♯", label: "трёхчетвертитоновый диез" },
  12: { symbol: "¾♭", label: "трёхчетвертитоновый бемоль" },
  13: { symbol: "¼♯", label: "слэш-четверть-диез" },
  14: { symbol: "♯̸", label: "слэш-диез" },
  15: { symbol: "♭̸♭̸", label: "двойной слэш-бемоль" },
  16: { symbol: "sori", label: "сори" },
  17: { symbol: "koron", label: "корон" },
};

const DURATION_LABELS: Record<number, string> = {
  1: "тысяча двадцать четвёртая",
  2: "пятьсот двенадцатая",
  3: "двести пятьдесят шестая",
  4: "сто двадцать восьмая",
  5: "шестьдесят четвёртая",
  6: "тридцать вторая",
  7: "шестнадцатая",
  8: "восьмая",
  9: "четвертная",
  10: "половинная",
  11: "целая",
  12: "бревис",
  13: "лонга",
  14: "максима",
};

function capitalise(value: string): string {
  return value ? value[0].toLocaleUpperCase("ru-RU") + value.slice(1) : value;
}

function effectiveAccidental(facts: FingeringNoteFacts): number {
  // OSMD uses 2 for "none". A courtesy/printed accidental belongs to the
  // graphical note, while the source pitch may still report "none".
  return facts.accidental === 2
    && facts.drawnAccidental !== undefined
    && facts.drawnAccidental !== 2
    ? facts.drawnAccidental
    : facts.accidental;
}

function formatDots(dots: number): string {
  if (dots === 1) return "с точкой";
  if (dots === 2) return "с двумя точками";
  if (dots > 2) return `с ${dots} точками`;
  return "";
}

/**
 * Названия длительностей по доле целой: нужны, когда в MusicXML нет `<type>`
 * (OSMD отдаёт тогда `NoteType.UNDEFINED`). Раньше в таком случае ученик читал
 * «1/8 целой» — служебную дробь вместо слова «восьмая».
 */
const FRACTION_DURATION_LABELS: Record<string, string> = {
  "4/1": "четыре целых",
  "2/1": "две целых",
  "1/1": "целая",
  "1/2": "половинная",
  "1/4": "четвертная",
  "1/8": "восьмая",
  "1/16": "шестнадцатая",
  "1/32": "тридцать вторая",
  "1/64": "шестьдесят четвёртая",
  "1/128": "сто двадцать восьмая",
  "3/2": "целая с точкой",
  "3/4": "половинная с точкой",
  "3/8": "четвертная с точкой",
  "3/16": "восьмая с точкой",
  "3/32": "шестнадцатая с точкой",
};

function reduceFraction(numerator: number, denominator: number): string {
  const gcd = (left: number, right: number): number =>
    right === 0 ? Math.abs(left) : gcd(right, left % right);
  const divisor = gcd(numerator, denominator) || 1;
  return `${numerator / divisor}/${denominator / divisor}`;
}

function formatDuration(facts: FingeringNoteFacts): string {
  const fraction = reduceFraction(facts.durationNumerator, facts.durationDenominator);
  const named = DURATION_LABELS[facts.durationType];
  const fromFraction = FRACTION_DURATION_LABELS[fraction];
  // Дробь с точкой уже содержит «с точкой», второй раз её не приписываем.
  const dots = named || !fromFraction ? formatDots(facts.dots) : "";
  const base = named ?? fromFraction ?? `доля ${fraction} целой`;
  const dotted = [base, dots].filter(Boolean).join(" ");
  return facts.grace ? `форшлаг · ${dotted}` : dotted;
}

function durationVariantFromFacts(
  facts: FingeringNoteFacts,
  voiceId: number,
): FingeringDurationVariant {
  return {
    voiceId,
    durationType: facts.durationType,
    durationNumerator: facts.durationNumerator,
    durationDenominator: facts.durationDenominator,
    dots: facts.dots,
    grace: facts.grace,
    finger: facts.fingers.find((value) => /^[1-5]$/.test(value.trim()))?.trim(),
  };
}

function durationVariantText(variant: FingeringDurationVariant): string {
  return formatDuration({
    ...variant,
    step: 0,
    octave: 0,
    accidental: 2,
    fingers: [],
    staffNumber: 1,
    voiceIds: [variant.voiceId],
    tie: false,
    chord: false,
  });
}

function durationVariantsForFacts(facts: FingeringNoteFacts): FingeringDurationVariant[] {
  const supplied = facts.durationVariants?.length
    ? facts.durationVariants
    : facts.voiceIds.map((voiceId) => durationVariantFromFacts(facts, voiceId));
  const unique = new Map<string, FingeringDurationVariant>();
  for (const variant of supplied) {
    const key = [
      variant.voiceId,
      variant.durationType,
      variant.durationNumerator,
      variant.durationDenominator,
      variant.dots,
      variant.grace,
      variant.finger ?? "",
    ].join("|");
    unique.set(key, variant);
  }
  return [...unique.values()].sort((left, right) => left.voiceId - right.voiceId);
}

function formatTooltipDuration(facts: FingeringNoteFacts): string {
  const variants = durationVariantsForFacts(facts);
  const distinctDurations = new Set(variants.map(durationVariantText));
  if (variants.length < 2 || distinctDurations.size < 2) return formatDuration(facts);
  return variants
    .map((variant) => `Линия ${variant.voiceId}: ${durationVariantText(variant)}`)
    .join(" · ");
}

function formatTuplet(tuplet: FingeringNoteFacts["tuplet"]): string | undefined {
  if (!tuplet) return undefined;
  const ratio = tuplet.normal ? ` ${tuplet.actual}:${tuplet.normal}` : "";
  if (tuplet.actual === 3) return `триоль${ratio}`;
  if (tuplet.actual === 2) return `дуоль${ratio}`;
  if (tuplet.actual === 5) return `квинтоль${ratio}`;
  return `туоль${ratio || ` ${tuplet.actual}`}`;
}

function formatStaff(facts: FingeringNoteFacts): string {
  const hand = facts.hand === "right"
    ? "Правая рука"
    : facts.hand === "left"
      ? "Левая рука"
      : undefined;
  const position = facts.staffPosition === "upper"
    ? "верхний стан"
    : facts.staffPosition === "lower"
      ? "нижний стан"
      : `стан ${facts.staffNumber}`;
  return hand ? `${hand} · ${position}` : capitalise(position);
}

function formatVoices(voiceIds: readonly number[]): string {
  const voices = [...new Set(voiceIds)]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return voices.length > 1
    ? `Мелодические линии ${voices.join(", ")}`
    : `Мелодическая линия ${voices[0] ?? "—"}`;
}

export function pickNoteheadByIndex<T>(
  noteheads: readonly T[],
  index: number,
): T | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  return noteheads[index];
}

export function groupSharedUnisonTargets<TTarget, TFacts>(
  candidates: readonly SharedUnisonCandidate<TTarget, TFacts>[],
): Map<TTarget, TFacts[]> {
  const grouped = new Map<TTarget, TFacts[]>();
  const visibleByPitch = new Map<string, TTarget>();
  for (const candidate of candidates) {
    if (!candidate.printObject || candidate.target === undefined) continue;
    const existing = grouped.get(candidate.target);
    if (existing) existing.push(candidate.facts);
    else grouped.set(candidate.target, [candidate.facts]);
    if (!visibleByPitch.has(candidate.pitchKey)) {
      visibleByPitch.set(candidate.pitchKey, candidate.target);
    }
  }
  for (const candidate of candidates) {
    if (candidate.printObject || !candidate.sharesVisibleUnison) continue;
    const target = candidate.target !== undefined && grouped.has(candidate.target)
      ? candidate.target
      : visibleByPitch.get(candidate.pitchKey);
    if (target === undefined) continue;
    grouped.get(target)?.push(candidate.facts);
  }
  return grouped;
}

export function mergeFingeringNoteFacts(
  facts: readonly FingeringNoteFacts[],
): FingeringNoteFacts | undefined {
  const first = facts[0];
  if (!first) return undefined;
  return {
    ...first,
    fingers: [...new Set(facts.flatMap((item) => item.fingers))],
    voiceIds: [...new Set(facts.flatMap((item) => item.voiceIds))],
    tie: facts.some((item) => item.tie),
    tuplet: facts.find((item) => item.tuplet)?.tuplet,
    chord: facts.some((item) => item.chord),
    grace: facts.some((item) => item.grace),
    durationVariants: facts.flatMap(durationVariantsForFacts),
  };
}

export function buildFingeringNoteTooltip(
  facts: FingeringNoteFacts,
): FingeringNoteTooltip {
  const rest = Boolean(facts.rest);
  const noteName = RUSSIAN_NOTE_NAMES[facts.step] ?? "нота";
  const accidental = rest ? undefined : ACCIDENTAL_LABELS[effectiveAccidental(facts)];
  const pitch = rest
    ? "Пауза"
    : capitalise(`${noteName}${accidental?.symbol ?? ""}${facts.octave}`);
  const duration = formatTooltipDuration(facts);
  const fingers = [...new Set(
    facts.fingers
      .map((finger) => finger.trim())
      .filter((finger) => /^[1-5]$/.test(finger)),
  )];
  const finger = fingers.length ? fingers.join(" / ") : undefined;
  const handAndStaff = formatStaff(facts);
  const voice = formatVoices(facts.voiceIds);
  const context = [
    accidental?.label,
    facts.tie ? "лига" : undefined,
    formatTuplet(facts.tuplet),
    facts.chord ? "аккорд" : undefined,
    rest ? "тишина, но время идёт" : undefined,
  ].filter((value): value is string => Boolean(value));
  const beat = facts.beatLabel ? `на счёт «${facts.beatLabel}»` : undefined;
  const spokenPitch = rest
    ? "Пауза"
    : `${noteName}${accidental ? `-${accidental.label}` : ""}, октава ${facts.octave}`;
  const ariaLabel = [
    capitalise(spokenPitch),
    duration,
    beat,
    finger ? `${fingers.length > 1 ? "пальцы" : "палец"} ${finger}` : undefined,
    handAndStaff,
    voice,
    ...context,
  ].filter(Boolean).join("; ");

  return {
    pitch,
    duration,
    finger,
    fingerLabel: fingers.length > 1 ? "Пальцы" : "Палец",
    handAndStaff,
    voice,
    context,
    ariaLabel,
    rest,
    beat: facts.beatLabel,
    showVoice: facts.voiceIds.length > 1 || (facts.voiceIds[0] ?? 1) > 1,
  };
}

export interface XmlNodeLite {
  name: string;
  attrs: Record<string, string>;
  children: XmlNodeLite[];
  text: string;
}

export interface ParsedLearningScore {
  documentNode: XmlNodeLite;
}

interface ClefState {
  sign: string;
  line?: number;
  octaveChange?: number;
  staff: number;
}

interface KeyState {
  fifths?: number;
  mode?: string;
  tonic?: string;
  staff: number;
  customAlterations: string[];
}

interface TimeState {
  beats: string[];
  beatTypes: number[];
  symbol?: string;
  senzaMisura: boolean;
  staff: number;
}

interface AttributeState {
  divisions: number;
  staves: number;
  clefs: Map<number, ClefState>;
  keys: Map<number, KeyState>;
  times: Map<number, TimeState>;
}

interface ContinuingSpan {
  kind: string;
  label: string;
  detail: string;
}

interface SpanState {
  active: Map<string, ContinuingSpan>;
}

interface TimedEvent {
  onset: number;
  duration: number;
  triplet: boolean;
  /** Выписанная пауза: время идёт, звука нет. */
  rest: boolean;
  staff: number;
  voice: number;
  /** Высота для проигрывания; у пауз отсутствует. */
  midi?: number;
  grace: boolean;
  /** Продолжение лиги из прошлого такта не является новой атакой. */
  tieStop: boolean;
  /** Staccato меняет физическое удержание, но не нотированную длительность. */
  staccato: boolean;
  /** Явная сторона из placement аппликатуры; важна для cross-staff. */
  hand?: FingeringHand;
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: "\"",
};

function decodeXml(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi,
    (_, entity: string) => {
      if (entity[0] === "#") {
        const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
        const raw = radix === 16 ? entity.slice(2) : entity.slice(1);
        const codePoint = Number.parseInt(raw, radix);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : `&${entity};`;
      }
      return XML_ENTITIES[entity.toLowerCase()] ?? `&${entity};`;
    },
  );
}

function localXmlName(value: string): string {
  return (value.split(":").at(-1) ?? value).toLowerCase();
}

function parseXmlAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    attrs[localXmlName(match[1])] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function parseXmlLite(xml: string): XmlNodeLite {
  const root: XmlNodeLite = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  const tokens =
    xml.match(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[\s\S]*?>|<\/?[^>]+>|[^<]+/g)
    ?? [];

  for (const token of tokens) {
    const current = stack.at(-1) ?? root;
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!DOCTYPE")) {
      continue;
    }
    if (token.startsWith("<![CDATA[")) {
      current.text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token.startsWith("<")) {
      const selfClosing = /\/\s*>$/.test(token);
      const body = token.slice(1, selfClosing ? token.lastIndexOf("/") : -1).trim();
      if (!body || body.startsWith("!")) continue;
      const space = body.search(/\s/);
      const rawName = space < 0 ? body : body.slice(0, space);
      const attrsSource = space < 0 ? "" : body.slice(space + 1);
      const node: XmlNodeLite = {
        name: localXmlName(rawName),
        attrs: parseXmlAttributes(attrsSource),
        children: [],
        text: "",
      };
      current.children.push(node);
      if (!selfClosing) stack.push(node);
      continue;
    }
    current.text += decodeXml(token);
  }
  return root;
}

export function parseMusicXmlLearningScore(xml: string): ParsedLearningScore {
  return { documentNode: parseXmlLite(xml) };
}

function xmlChildren(node: XmlNodeLite, name?: string): XmlNodeLite[] {
  return name ? node.children.filter((child) => child.name === name) : node.children;
}

function xmlChild(node: XmlNodeLite, name: string): XmlNodeLite | undefined {
  return node.children.find((child) => child.name === name);
}

function xmlDescendants(node: XmlNodeLite, name: string): XmlNodeLite[] {
  const matches: XmlNodeLite[] = [];
  for (const child of node.children) {
    if (child.name === name) matches.push(child);
    matches.push(...xmlDescendants(child, name));
  }
  return matches;
}

function xmlText(node: XmlNodeLite | undefined): string {
  if (!node) return "";
  return [node.text, ...node.children.map(xmlText)].join("").replace(/\s+/g, " ").trim();
}

function visibleXml(node: XmlNodeLite | undefined): boolean {
  return Boolean(node) && node!.attrs["print-object"] !== "no";
}

function finiteNumber(value: string, fallback?: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function freshAttributeState(): AttributeState {
  return {
    divisions: 1,
    staves: 1,
    clefs: new Map(),
    keys: new Map(),
    times: new Map(),
  };
}

function freshSpanState(): SpanState {
  return { active: new Map() };
}

function cloneAttributeState(state: AttributeState): AttributeState {
  return {
    divisions: state.divisions,
    staves: state.staves,
    clefs: new Map(state.clefs),
    keys: new Map(state.keys),
    times: new Map(state.times),
  };
}

function staffNumber(node: XmlNodeLite, defaultStaff = 0): number {
  return finiteNumber(node.attrs.number, defaultStaff) ?? defaultStaff;
}

function parseClefState(node: XmlNodeLite): ClefState {
  return {
    sign: xmlText(xmlChild(node, "sign")) || "unknown",
    line: finiteNumber(xmlText(xmlChild(node, "line"))),
    octaveChange: finiteNumber(xmlText(xmlChild(node, "clef-octave-change"))),
    staff: staffNumber(node, 1),
  };
}

function parseKeyState(node: XmlNodeLite): KeyState {
  const steps = xmlChildren(node, "key-step");
  const alters = xmlChildren(node, "key-alter");
  const customAlterations = steps.map((step, index) => {
    const alter = finiteNumber(xmlText(alters[index]), 0) ?? 0;
    const sign = alter === 0 ? "♮" : alter > 0 ? "♯".repeat(Math.round(alter)) : "♭".repeat(Math.round(-alter));
    return `${xmlText(step).toUpperCase()}${sign}`;
  });
  return {
    fifths: finiteNumber(xmlText(xmlChild(node, "fifths"))),
    mode: xmlText(xmlChild(node, "mode")).toLowerCase() || undefined,
    tonic:
      xmlText(xmlChild(node, "tonic"))
      || xmlText(xmlChild(node, "key-tonic"))
      || undefined,
    staff: staffNumber(node, 0),
    customAlterations,
  };
}

function parseTimeState(node: XmlNodeLite): TimeState {
  return {
    beats: xmlChildren(node, "beats").map(xmlText),
    beatTypes: xmlChildren(node, "beat-type")
      .map((child) => finiteNumber(xmlText(child)))
      .filter((value): value is number => value !== undefined && value > 0),
    symbol: node.attrs.symbol,
    senzaMisura: Boolean(xmlChild(node, "senza-misura")),
    staff: staffNumber(node, 0),
  };
}

function applyAttributes(node: XmlNodeLite, state: AttributeState): void {
  const divisions = finiteNumber(xmlText(xmlChild(node, "divisions")));
  if (divisions && divisions > 0) state.divisions = divisions;
  const staves = finiteNumber(xmlText(xmlChild(node, "staves")));
  if (staves && staves > 0) state.staves = staves;
  for (const clef of xmlChildren(node, "clef")) {
    const parsed = parseClefState(clef);
    state.clefs.set(parsed.staff, parsed);
  }
  for (const key of xmlChildren(node, "key")) {
    const parsed = parseKeyState(key);
    state.keys.set(parsed.staff, parsed);
  }
  for (const time of xmlChildren(node, "time")) {
    const parsed = parseTimeState(time);
    state.times.set(parsed.staff, parsed);
  }
}

const FIFTHS_CONTEXT: Record<number, { major: string; minor: string }> = {
  [-7]: { major: "до-бемоль мажор", minor: "ля-бемоль минор" },
  [-6]: { major: "соль-бемоль мажор", minor: "ми-бемоль минор" },
  [-5]: { major: "ре-бемоль мажор", minor: "си-бемоль минор" },
  [-4]: { major: "ля-бемоль мажор", minor: "фа минор" },
  [-3]: { major: "ми-бемоль мажор", minor: "до минор" },
  [-2]: { major: "си-бемоль мажор", minor: "соль минор" },
  [-1]: { major: "фа мажор", minor: "ре минор" },
  0: { major: "до мажор", minor: "ля минор" },
  1: { major: "соль мажор", minor: "ми минор" },
  2: { major: "ре мажор", minor: "си минор" },
  3: { major: "ля мажор", minor: "фа-диез минор" },
  4: { major: "ми мажор", minor: "до-диез минор" },
  5: { major: "си мажор", minor: "соль-диез минор" },
  6: { major: "фа-диез мажор", minor: "ре-диез минор" },
  7: { major: "до-диез мажор", minor: "ля-диез минор" },
};

const SHARP_ORDER = ["фа♯", "до♯", "соль♯", "ре♯", "ля♯", "ми♯", "си♯"];
const FLAT_ORDER = ["си♭", "ми♭", "ля♭", "ре♭", "соль♭", "до♭", "фа♭"];

function resolvedForStaff<T>(map: Map<number, T>, staff: number): T | undefined {
  return map.get(staff) ?? map.get(0) ?? map.get(1);
}

function clefDetail(clef: ClefState): GuideDetail {
  const sign = clef.sign.toUpperCase();
  const base =
    sign === "G" && clef.line === 2
      ? "Скрипичный ключ"
      : sign === "F" && clef.line === 4
        ? "Басовый ключ"
        : sign === "C" && clef.line === 3
          ? "Альтовый ключ"
          : sign === "C" && clef.line === 4
            ? "Теноровый ключ"
            : sign === "PERCUSSION"
              ? "Ударный ключ"
              : sign === "TAB"
                ? "Табулатурный ключ"
                : `Ключ ${clef.sign.toUpperCase()}`;
  const location = clef.line ? `${clef.sign.toUpperCase()} на ${clef.line}-й линейке` : clef.sign;
  const octave = clef.octaveChange
    ? `Транспонирует запись на ${Math.abs(clef.octaveChange)} окт. ${clef.octaveChange > 0 ? "вверх" : "вниз"}.`
    : "Определяет высоту нот на этом стане.";
  const summary = `${location} · стан ${clef.staff}`;
  return {
    title: base,
    summary,
    lines: [octave],
    ariaLabel: `${base}; ${summary}; ${octave}`,
  };
}

function keyAlterations(key: KeyState): string[] {
  if (key.customAlterations.length) return key.customAlterations;
  if (key.fifths === undefined || key.fifths === 0) return [];
  return key.fifths > 0
    ? SHARP_ORDER.slice(0, Math.min(7, key.fifths))
    : FLAT_ORDER.slice(0, Math.min(7, -key.fifths));
}

function keyDetail(key: KeyState): GuideDetail {
  const alterations = keyAlterations(key);
  const candidates = key.fifths === undefined ? undefined : FIFTHS_CONTEXT[key.fifths];
  const mode = key.mode;
  const explicitTonic = key.tonic?.trim();
  const current =
    explicitTonic && mode
      ? `Указано: ${explicitTonic}, лад ${mode}.`
      : mode === "major" && candidates
        ? `Указан мажор: ${candidates.major}.`
        : mode === "minor" && candidates
          ? `Указан минор: ${candidates.minor}.`
          : mode
            ? `Указан лад «${mode}», тоника не задана.`
            : candidates
              ? `Тоника не задана: возможны ${candidates.major} / ${candidates.minor}.`
              : "Тоника и лад в MusicXML не заданы.";
  const signature = alterations.length ? alterations.join(", ") : "без ключевых знаков";
  const summary = `${signature} · стан ${key.staff || "все"}`;
  return {
    title: "Ключевые знаки",
    summary,
    lines: [current],
    ariaLabel: `Ключевые знаки; ${summary}; ${current}`,
  };
}

function timeSignatureText(time: TimeState): string {
  if (time.senzaMisura) return "без размера";
  return time.beats
    .map((beats, index) => `${beats}/${time.beatTypes[index] ?? time.beatTypes[0] ?? "?"}`)
    .join(" + ");
}

function timeDetail(time: TimeState): GuideDetail {
  const meter = timeSignatureText(time);
  const symbol =
    time.symbol === "common"
      ? "общий размер C"
      : time.symbol === "cut"
        ? "alla breve ¢"
        : meter;
  const summary = `${symbol} · стан ${time.staff || "все"}`;
  return {
    title: "Размер",
    summary,
    lines: [time.senzaMisura ? "Свободный метр: фиксированная сетка счёта не строится." : "Верхнее число — доли, нижнее — длительность доли."],
    ariaLabel: `Размер; ${summary}`,
  };
}

function durationName(type: string, dots: number, rest: boolean, measureRest: boolean): string {
  if (measureRest) return "Пауза на весь такт";
  const names: Record<string, string> = {
    maxima: "максима",
    long: "лонга",
    breve: "бревис",
    whole: "целая",
    half: "половинная",
    quarter: "четвертная",
    eighth: "восьмая",
    "16th": "шестнадцатая",
    "32nd": "тридцать вторая",
    "64th": "шестьдесят четвёртая",
    "128th": "сто двадцать восьмая",
    "256th": "двести пятьдесят шестая",
    "512th": "пятьсот двенадцатая",
    "1024th": "тысяча двадцать четвёртая",
  };
  const base = names[type] ?? (type ? `длительность ${type}` : "длительность в divisions");
  const dotted = [base, formatDots(dots)].filter(Boolean).join(" ");
  return rest ? `${capitalise(dotted)} пауза` : `${capitalise(dotted)} нота`;
}

const SIMPLE_SYMBOL_LABELS: Record<string, [string, string]> = {
  "accent": ["Акцент", "Подчеркнуть атаку."],
  "strong-accent": ["Сильный акцент", "Резко подчеркнуть атаку."],
  "staccato": ["Стаккато", "Играть коротко, отделяя звук."],
  "tenuto": ["Тенуто", "Выдержать полную длительность."],
  "detached-legato": ["Портато", "Мягко отделённое легато."],
  "staccatissimo": ["Стаккатиссимо", "Очень короткая атака."],
  "spiccato": ["Спиккато", "Отрывистая артикуляция."],
  "breath-mark": ["Цезура дыхания", "Короткое разделение фразы."],
  "caesura": ["Цезура", "Явная пауза внутри фразы."],
  "fermata": ["Фермата", "Удержать дольше записанной длительности."],
  "trill-mark": ["Трель", "Быстро чередовать основную и соседнюю ступень."],
  "turn": ["Группетто", "Орнамент вокруг основной ноты."],
  "inverted-turn": ["Обращённое группетто", "Обращённый порядок соседних звуков."],
  "mordent": ["Мордент", "Короткий орнамент с соседней ступенью."],
  "inverted-mordent": ["Обращённый мордент", "Короткий обращённый орнамент."],
  "shake": ["Шейк", "Быстрое орнаментальное колебание."],
  "wavy-line": ["Волнистая линия", "Продолжение трели или орнамента."],
  "schleifer": ["Шлейфер", "Скользящий орнамент к основной ноте."],
  "up-bow": ["Смычок вверх", "Техническое обозначение штриха."],
  "down-bow": ["Смычок вниз", "Техническое обозначение штриха."],
  "harmonic": ["Флажолет", "Технический приём извлечения обертона."],
  "open-string": ["Открытая струна", "Играть без зажатия струны."],
  "snap-pizzicato": ["Щипок Бартока", "Резкий щипок струны."],
  "thumb-position": ["Позиция большого пальца", "Техническая позиция."],
  "heel": ["Пятка", "Педальная техника органа."],
  "toe": ["Носок", "Педальная техника органа."],
};

function symbolId(kind: string, label: string, detail: string): string {
  let hash = 2166136261;
  for (const char of `${kind}|${label}|${detail}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${kind}-${(hash >>> 0).toString(36)}`;
}

function addVisibleSymbol(
  symbols: Map<string, MeasureVisibleSymbol>,
  input: Omit<MeasureVisibleSymbol, "id" | "count"> & { count?: number },
): void {
  const id = symbolId(input.kind, input.label, input.detail);
  const existing = symbols.get(id);
  if (existing) {
    existing.count += input.count ?? 1;
    return;
  }
  symbols.set(id, { ...input, id, count: input.count ?? 1 });
}

function directionSpanKey(
  kind: string,
  direction: XmlNodeLite,
  symbol: XmlNodeLite,
): string {
  const staff = xmlText(xmlChild(direction, "staff")) || "1";
  return `${kind}:${staff}:${symbol.attrs.number || "1"}`;
}

function updateDirectionSpanState(
  direction: XmlNodeLite,
  state: SpanState,
): void {
  if (!visibleXml(direction)) return;
  for (const directionType of xmlChildren(direction, "direction-type")) {
    for (const symbol of xmlChildren(directionType).filter(visibleXml)) {
      const type = (symbol.attrs.type || "").toLowerCase();
      const key = directionSpanKey(symbol.name, direction, symbol);
      if (["stop", "discontinue"].includes(type)) {
        state.active.delete(key);
        continue;
      }
      if (symbol.name === "wedge" && ["crescendo", "diminuendo"].includes(type)) {
        state.active.set(key, {
          kind: "wedge",
          label: type === "crescendo"
            ? "Крещендо продолжается"
            : "Диминуэндо продолжается",
          detail: "Динамическая вилка началась в предыдущем такте и действует здесь.",
        });
      } else if (
        symbol.name === "pedal"
        && ["start", "resume", "sostenuto", "change"].includes(type)
      ) {
        state.active.set(key, {
          kind: "pedal",
          label: "Педаль продолжается",
          detail: "Педаль нажата в предыдущем такте и остаётся активной.",
        });
      } else if (symbol.name === "octave-shift" && ["up", "down"].includes(type)) {
        const size = symbol.attrs.size || "8";
        state.active.set(key, {
          kind: "octave-shift",
          label: `Октавный перенос продолжается · ${type} ${size}`,
          detail: "Октавный перенос начался раньше и действует в этом такте.",
        });
      } else if (symbol.name === "dashes" && type === "start") {
        state.active.set(key, {
          kind: "dashes",
          label: "Пунктирная линия продолжается",
          detail: "Текстовая пунктирная линия началась в предыдущем такте.",
        });
      } else if (symbol.name === "bracket" && type === "start") {
        state.active.set(key, {
          kind: "bracket",
          label: "Текстовая скобка продолжается",
          detail: "Исполнительское указание под скобкой началось раньше.",
        });
      }
    }
  }
}

function noteStaffAndVoice(note: XmlNodeLite): { staff: string; voice: string } {
  return {
    staff: xmlText(xmlChild(note, "staff")) || "1",
    voice: xmlText(xmlChild(note, "voice")) || "1",
  };
}

function notePitchKeyXml(note: XmlNodeLite): string {
  const pitch = xmlChild(note, "pitch");
  if (!pitch) return "unpitched";
  return [
    xmlText(xmlChild(pitch, "step")),
    xmlText(xmlChild(pitch, "alter")) || "0",
    xmlText(xmlChild(pitch, "octave")),
  ].join(":");
}

function updateNoteSpanState(note: XmlNodeLite, state: SpanState): void {
  if (!visibleXml(note)) return;
  const { staff, voice } = noteStaffAndVoice(note);
  for (const slur of xmlDescendants(note, "slur").filter(visibleXml)) {
    const type = (slur.attrs.type || "").toLowerCase();
    const key = `slur:${staff}:${voice}:${slur.attrs.number || "1"}`;
    if (type === "stop") state.active.delete(key);
    else if (type === "start") {
      state.active.set(key, {
        kind: "slur",
        label: "Фразировочная лига продолжается",
        detail: "Лига началась в предыдущем такте и сохраняет связность фразы.",
      });
    }
  }
  for (const tied of xmlDescendants(note, "tied").filter(visibleXml)) {
    const type = (tied.attrs.type || "").toLowerCase();
    const key = [
      "tie",
      staff,
      voice,
      notePitchKeyXml(note),
      tied.attrs.number || "1",
    ].join(":");
    if (type === "stop") state.active.delete(key);
    else if (type === "start") {
      state.active.set(key, {
        kind: "tie",
        label: "Лига длительности продолжается",
        detail: "Связанный звук начался раньше и продолжается через этот такт.",
      });
    }
  }
}

function updateMeasureSpanState(measure: XmlNodeLite, state: SpanState): void {
  for (const child of xmlChildren(measure)) {
    if (child.name === "direction") updateDirectionSpanState(child, state);
    else if (child.name === "note") updateNoteSpanState(child, state);
  }
}

function addContinuingSpanSymbols(
  symbols: Map<string, MeasureVisibleSymbol>,
  state: SpanState,
): void {
  for (const span of state.active.values()) addVisibleSymbol(symbols, span);
}

function pushGuideDetail(list: GuideDetail[], detail: GuideDetail): boolean {
  if (list.some((existing) => existing.ariaLabel === detail.ariaLabel)) return false;
  list.push(detail);
  return true;
}

function addNotationContainer(
  container: XmlNodeLite | undefined,
  kind: string,
  symbols: Map<string, MeasureVisibleSymbol>,
  skip: Set<string> = new Set(),
): void {
  if (!visibleXml(container)) return;
  for (const child of xmlChildren(container!)) {
    if (!visibleXml(child) || skip.has(child.name)) continue;
    const known = SIMPLE_SYMBOL_LABELS[child.name];
    const raw = xmlText(child);
    addVisibleSymbol(symbols, known
      ? { kind, label: known[0], detail: known[1] }
      : {
          kind: "unknown",
          label: raw ? `${child.name}: ${raw}` : `Обозначение «${child.name}»`,
          detail: "Видимое MusicXML-обозначение без отдельного учебного описания.",
          unknown: true,
        });
  }
}

function addNoteSymbols(
  note: XmlNodeLite,
  symbols: Map<string, MeasureVisibleSymbol>,
): void {
  if (!visibleXml(note)) return;
  const restNode = xmlChild(note, "rest");
  const rest = Boolean(restNode);
  const dots = xmlChildren(note, "dot").filter(visibleXml).length;
  const type = xmlText(xmlChild(note, "type")).toLowerCase();
  addVisibleSymbol(symbols, {
    kind: rest ? "rest" : "duration",
    label: durationName(type, dots, rest, restNode?.attrs.measure === "yes"),
    detail: rest ? "Записанная длительность тишины." : "Записанная длительность звука.",
  });

  const grace = xmlChild(note, "grace");
  if (visibleXml(grace)) {
    addVisibleSymbol(symbols, {
      kind: "grace",
      label: grace?.attrs.slash === "yes" ? "Форшлаг с перечёркиванием" : "Форшлаг",
      detail: "Украшение без самостоятельной метрической доли.",
    });
  }

  const accidental = xmlChild(note, "accidental");
  if (visibleXml(accidental)) {
    addVisibleSymbol(symbols, {
      kind: "accidental",
      label: `Альтерация: ${xmlText(accidental) || "знак"}`,
      detail: accidental?.attrs.cautionary === "yes"
        ? "Предупредительный знак альтерации."
        : "Изменяет высоту этой ноты.",
    });
  }

  for (const fingering of xmlDescendants(note, "fingering").filter(visibleXml)) {
    const value = xmlText(fingering);
    addVisibleSymbol(symbols, {
      kind: "fingering",
      label: value ? `Аппликатура ${value}` : "Аппликатура",
      detail: "Рекомендуемый палец для этой ноты.",
    });
  }

  const beams = xmlChildren(note, "beam").filter(visibleXml);
  if (beams.length) {
    addVisibleSymbol(symbols, {
      kind: "beam",
      label: beams.length > 1 ? "Несколько рёбер" : "Ребро",
      detail: "Объединяет короткие длительности в ритмическую группу.",
      count: beams.length,
    });
  }

  const timeModification = xmlChild(note, "time-modification");
  const tupletNodes = xmlDescendants(note, "tuplet").filter(visibleXml);
  if (tupletNodes.length) {
    for (const tuplet of tupletNodes) {
      const actual = xmlText(xmlChild(timeModification ?? tuplet, "actual-notes"));
      const normal = xmlText(xmlChild(timeModification ?? tuplet, "normal-notes"));
      const ratio = actual && normal ? `${actual}:${normal}` : "";
      addVisibleSymbol(symbols, {
        kind: "tuplet",
        label: ratio === "3:2" ? "Триоль 3:2" : ratio ? `Туоль ${ratio}` : "Туоль",
        detail: "Нерегулярное деление длительности.",
      });
    }
  }

  const tied = xmlDescendants(note, "tied").filter(visibleXml);
  if (tied.length) {
    addVisibleSymbol(symbols, {
      kind: "tie",
      label: "Лига длительности",
      detail: "Связывает одинаковые высоты в один непрерывный звук.",
      count: tied.length,
    });
  }

  const slurs = xmlDescendants(note, "slur").filter(visibleXml);
  if (slurs.length) {
    addVisibleSymbol(symbols, {
      kind: "slur",
      label: "Фразировочная лига",
      detail: "Показывает связную фразу; ноты всё равно берутся отдельно.",
      count: slurs.length,
    });
  }

  const arpeggiates = xmlDescendants(note, "arpeggiate").filter(visibleXml);
  const nonArpeggiates = xmlDescendants(note, "non-arpeggiate").filter(visibleXml);
  if (arpeggiates.length) {
    addVisibleSymbol(symbols, {
      kind: "arpeggiate",
      label: "Арпеджировать аккорд",
      detail: "Звуки аккорда берутся последовательно.",
      count: arpeggiates.length,
    });
  }
  if (nonArpeggiates.length) {
    addVisibleSymbol(symbols, {
      kind: "arpeggiate",
      label: "Не арпеджировать",
      detail: "Звуки аккорда берутся одновременно.",
      count: nonArpeggiates.length,
    });
  }

  for (const glissando of [
    ...xmlDescendants(note, "glissando"),
    ...xmlDescendants(note, "slide"),
  ].filter(visibleXml)) {
    addVisibleSymbol(symbols, {
      kind: "glissando",
      label: glissando.name === "slide" ? "Слайд" : "Глиссандо",
      detail: "Непрерывный или ступенчатый переход между высотами.",
    });
  }

  for (const tremolo of xmlDescendants(note, "tremolo").filter(visibleXml)) {
    addVisibleSymbol(symbols, {
      kind: "tremolo",
      label: `Тремоло${xmlText(tremolo) ? ` · ${xmlText(tremolo)} штр.` : ""}`,
      detail: tremolo.attrs.type === "unmeasured"
        ? "Нерегулярное быстрое повторение."
        : "Измеренное быстрое повторение.",
    });
  }

  const notehead = xmlChild(note, "notehead");
  if (
    visibleXml(notehead)
    && xmlText(notehead)
    && !["normal", "none"].includes(xmlText(notehead))
  ) {
    addVisibleSymbol(symbols, {
      kind: "notehead",
      label: `Особая головка: ${xmlText(notehead)}`,
      detail: "Форма головки несёт дополнительное исполнительское значение.",
    });
  }

  const articulations = xmlDescendants(note, "articulations");
  for (const container of articulations) addNotationContainer(container, "articulation", symbols);
  const ornaments = xmlDescendants(note, "ornaments");
  for (const container of ornaments) {
    addNotationContainer(
      container,
      "ornament",
      symbols,
      new Set(["tremolo", "accidental-mark"]),
    );
  }
  const technical = xmlDescendants(note, "technical");
  for (const container of technical) {
    addNotationContainer(container, "technical", symbols, new Set(["fingering"]));
  }
  for (const dynamics of xmlDescendants(note, "dynamics").filter(visibleXml)) {
    for (const dynamic of xmlChildren(dynamics).filter(visibleXml)) {
      addVisibleSymbol(symbols, {
        kind: "dynamic",
        label: `Динамика ${dynamic.name === "other-dynamics" ? xmlText(dynamic) : dynamic.name}`,
        detail: "Динамическое обозначение, привязанное к ноте.",
      });
    }
  }
  for (const accidentalMark of xmlDescendants(note, "accidental-mark").filter(visibleXml)) {
    addVisibleSymbol(symbols, {
      kind: "accidental",
      label: `Альтерация орнамента: ${xmlText(accidentalMark) || "знак"}`,
      detail: "Уточняет высоту вспомогательной ноты орнамента.",
    });
  }
  for (const otherNotation of xmlDescendants(note, "other-notation").filter(visibleXml)) {
    addVisibleSymbol(symbols, {
      kind: "unknown",
      label: xmlText(otherNotation) || "Другое обозначение",
      detail: "Видимое авторское MusicXML-обозначение.",
      unknown: true,
    });
  }

  const knownNotationContainers = new Set([
    "tied", "slur", "tuplet", "glissando", "slide", "ornaments", "technical",
    "articulations", "dynamics", "arpeggiate", "non-arpeggiate", "fermata",
    "accidental-mark", "other-notation",
  ]);
  for (const notations of xmlChildren(note, "notations")) {
    for (const child of xmlChildren(notations)) {
      if (!visibleXml(child) || knownNotationContainers.has(child.name)) continue;
      addVisibleSymbol(symbols, {
        kind: "unknown",
        label: `Обозначение «${child.name}»`,
        detail: xmlText(child) || "Видимое обозначение из MusicXML.",
        unknown: true,
      });
    }
  }

  for (const fermata of xmlDescendants(note, "fermata").filter(visibleXml)) {
    const known = SIMPLE_SYMBOL_LABELS.fermata;
    addVisibleSymbol(symbols, { kind: "fermata", label: known[0], detail: known[1] });
  }
}

function addDirectionSymbols(
  direction: XmlNodeLite,
  symbols: Map<string, MeasureVisibleSymbol>,
): void {
  if (!visibleXml(direction)) return;
  const dynamicNames = new Set([
    "p", "pp", "ppp", "pppp", "ppppp", "pppppp",
    "f", "ff", "fff", "ffff", "fffff", "ffffff",
    "mp", "mf", "sf", "sfp", "sfpp", "fp", "rf", "rfz", "sfz", "sffz", "fz",
  ]);
  const known = new Set([
    "rehearsal", "segno", "words", "coda", "wedge", "dynamics", "dashes",
    "bracket", "pedal", "metronome", "octave-shift", "harp-pedals", "damp",
    "damp-all", "eyeglasses", "string-mute", "scordatura", "image",
    "principal-voice", "accordion-registration", "percussion", "other-direction",
  ]);

  for (const directionType of xmlChildren(direction, "direction-type")) {
    for (const child of xmlChildren(directionType)) {
      if (!visibleXml(child)) continue;
      if (child.name === "dynamics") {
        for (const dynamic of xmlChildren(child).filter(visibleXml)) {
          const value = dynamic.name === "other-dynamics" ? xmlText(dynamic) : dynamic.name;
          addVisibleSymbol(symbols, {
            kind: "dynamic",
            label: `Динамика ${value || "—"}`,
            detail: dynamicNames.has(dynamic.name)
              ? "Уровень громкости или характер атаки."
              : "Авторское динамическое обозначение.",
          });
        }
      } else if (child.name === "wedge") {
        const type = child.attrs.type ?? "continue";
        addVisibleSymbol(symbols, {
          kind: "wedge",
          label: type === "crescendo" ? "Крещендо" : type === "diminuendo" ? "Диминуэндо" : "Вилка динамики",
          detail: type === "crescendo" ? "Постепенно громче." : type === "diminuendo" ? "Постепенно тише." : "Продолжение динамической вилки.",
        });
      } else if (child.name === "pedal") {
        addVisibleSymbol(symbols, {
          kind: "pedal",
          label: `Педаль · ${child.attrs.type ?? "mark"}`,
          detail: child.attrs.line === "yes" ? "Педализация показана линией." : "Знак управления правой педалью.",
        });
      } else if (child.name === "octave-shift") {
        addVisibleSymbol(symbols, {
          kind: "octave-shift",
          label: `Октавный перенос ${child.attrs.type ?? ""} ${child.attrs.size ?? "8"}`.trim(),
          detail: "Звучание переносится на указанное число ступеней.",
        });
      } else if (child.name === "metronome") {
        addVisibleSymbol(symbols, {
          kind: "metronome",
          label: "Метроном",
          detail: xmlText(child) || "Темповое значение.",
        });
      } else if (child.name === "words" || child.name === "rehearsal") {
        addVisibleSymbol(symbols, {
          kind: child.name,
          label: child.name === "rehearsal" ? `Репетиционная метка ${xmlText(child)}` : `Ремарка: ${xmlText(child)}`,
          detail: "Печатная авторская подсказка.",
        });
      } else if (child.name === "segno" || child.name === "coda") {
        addVisibleSymbol(symbols, {
          kind: "navigation",
          label: child.name === "segno" ? "Сеньо" : "Кода",
          detail: "Навигационный знак формы.",
        });
      } else {
        const friendly: Record<string, string> = {
          dashes: "Пунктирная линия",
          bracket: "Текстовая скобка",
          "harp-pedals": "Педали арфы",
          damp: "Глушение",
          "damp-all": "Полное глушение",
          eyeglasses: "Внимание исполнителя",
          "string-mute": "Сурдина",
          scordatura: "Скордатура",
          image: "Графическое обозначение",
          "principal-voice": "Главный голос",
          "accordion-registration": "Регистр аккордеона",
          percussion: "Ударное обозначение",
          "other-direction": "Авторское направление",
        };
        addVisibleSymbol(symbols, {
          kind: known.has(child.name) ? "direction" : "unknown",
          label: friendly[child.name] ?? `Направление «${child.name}»`,
          detail: xmlText(child) || "Видимое направление из MusicXML.",
          unknown: !known.has(child.name),
        });
      }
    }
  }
}

function addBarlineSymbols(
  barline: XmlNodeLite,
  symbols: Map<string, MeasureVisibleSymbol>,
): void {
  if (!visibleXml(barline)) return;
  for (const repeat of xmlChildren(barline, "repeat").filter(visibleXml)) {
    addVisibleSymbol(symbols, {
      kind: "repeat",
      label: repeat.attrs.direction === "backward" ? "Конец повтора" : "Начало повтора",
      detail: "Граница повторяемого фрагмента.",
    });
  }
  for (const ending of xmlChildren(barline, "ending").filter(visibleXml)) {
    addVisibleSymbol(symbols, {
      kind: "ending",
      label: `Вольта ${ending.attrs.number ?? ""}`.trim(),
      detail: `Альтернативное окончание · ${ending.attrs.type ?? "continue"}.`,
    });
  }
}

const STEP_PITCH_CLASSES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** MIDI-высота из `<pitch>`; нужна только для проигрывания такта. */
function pitchMidi(pitch: XmlNodeLite | undefined): number | undefined {
  if (!pitch) return undefined;
  const step = xmlText(xmlChild(pitch, "step")).toUpperCase();
  const octave = finiteNumber(xmlText(xmlChild(pitch, "octave")));
  const pitchClass = STEP_PITCH_CLASSES[step];
  if (pitchClass === undefined || octave === undefined) return undefined;
  const alter = finiteNumber(xmlText(xmlChild(pitch, "alter")), 0) ?? 0;
  return (octave + 1) * 12 + pitchClass + alter;
}

function parseTimedEvents(
  measure: XmlNodeLite,
  inheritedDivisions: number,
): { events: TimedEvent[]; actualQuarters: number } {
  const events: TimedEvent[] = [];
  let divisions = inheritedDivisions > 0 ? inheritedDivisions : 1;
  let cursor = 0;
  let maxEnd = 0;
  let lastNoteOnset = 0;

  for (const child of xmlChildren(measure)) {
    if (child.name === "attributes") {
      const changed = finiteNumber(xmlText(xmlChild(child, "divisions")));
      if (changed && changed > 0) divisions = changed;
      continue;
    }
    if (child.name === "backup" || child.name === "forward") {
      const duration = (finiteNumber(xmlText(xmlChild(child, "duration")), 0) ?? 0) / divisions;
      cursor = child.name === "backup" ? Math.max(0, cursor - duration) : cursor + duration;
      maxEnd = Math.max(maxEnd, cursor);
      continue;
    }
    if (child.name !== "note") continue;

    const chord = Boolean(xmlChild(child, "chord"));
    const grace = Boolean(xmlChild(child, "grace"));
    const duration = grace
      ? 0
      : (finiteNumber(xmlText(xmlChild(child, "duration")), 0) ?? 0) / divisions;
    const onset = chord ? lastNoteOnset : cursor;
    if (!chord) lastNoteOnset = cursor;

    if (visibleXml(child)) {
      const timeModification = xmlChild(child, "time-modification");
      const actual = finiteNumber(xmlText(xmlChild(timeModification ?? child, "actual-notes")));
      const normal = finiteNumber(xmlText(xmlChild(timeModification ?? child, "normal-notes")));
      const tieStop = [
        ...xmlChildren(child, "tie"),
        ...xmlDescendants(child, "tied"),
      ].some((tie) => tie.attrs.type === "stop");
      const staccato = xmlDescendants(child, "articulations").some(
        (articulations) =>
          Boolean(xmlChild(articulations, "staccato"))
          || Boolean(xmlChild(articulations, "staccatissimo")),
      );
      events.push({
        onset,
        duration,
        triplet: actual === 3 && normal === 2,
        rest: Boolean(xmlChild(child, "rest")),
        staff: finiteNumber(xmlText(xmlChild(child, "staff")), 1) ?? 1,
        voice: finiteNumber(xmlText(xmlChild(child, "voice")), 1) ?? 1,
        midi: pitchMidi(xmlChild(child, "pitch")),
        grace,
        tieStop,
        staccato,
        // `placement="above|below"` describes engraving, not the performing
        // hand. Hand and staff stay separate even when the music crosses staves.
        hand: undefined,
      });
    }
    maxEnd = Math.max(maxEnd, onset + duration);
    if (!chord && !grace) cursor += duration;
  }

  return { events, actualQuarters: Math.max(maxEnd, cursor) };
}

function summedBeats(value: string): number {
  return value
    .split("+")
    .map((part) => Number(part.trim()))
    .filter(Number.isFinite)
    .reduce((sum, part) => sum + part, 0);
}

function timeGeometry(time: TimeState | undefined): {
  expected?: number;
  pulseLength: number;
  pulses?: number;
  compound: boolean;
  pulseLabel: string;
} {
  if (!time || time.senzaMisura || !time.beats.length || !time.beatTypes.length) {
    return { pulseLength: 1, compound: false, pulseLabel: "свободный счёт" };
  }
  let expected = 0;
  let totalBeats = 0;
  for (let index = 0; index < time.beats.length; index += 1) {
    const beats = summedBeats(time.beats[index]);
    const beatType = time.beatTypes[index] ?? time.beatTypes[0];
    if (!beatType) continue;
    totalBeats += beats;
    expected += beats * (4 / beatType);
  }
  const beatType = time.beatTypes[0] ?? 4;
  const compound = time.beats.length === 1
    && beatType === 8
    && [6, 9, 12].includes(totalBeats);
  const pulseLength = compound ? 1.5 : 4 / beatType;
  const pulses = compound ? totalBeats / 3 : totalBeats;
  const pulseLabel = compound
    ? "пунктирная четверть"
    : beatType === 2
      ? "половинная"
      : beatType === 4
        ? "четверть"
        : beatType === 8
          ? "восьмая"
          : `1/${beatType}`;
  return { expected, pulseLength, pulses, compound, pulseLabel };
}

function near(value: number, target: number, tolerance = 0.035): boolean {
  return Math.abs(value - target) <= tolerance;
}

function compactNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function durationFromQuarters(value: number): string {
  const durations: Array<[number, string]> = [
    [4, "целая"],
    [3, "половинная с точкой"],
    [2, "половинная"],
    [1.5, "четверть с точкой"],
    [1, "четверть"],
    [0.75, "восьмая с точкой"],
    [0.5, "восьмая"],
    [0.25, "шестнадцатая"],
  ];
  return durations.find(([quarters]) => near(value, quarters, GRID_TOLERANCE))?.[1]
    ?? `нота на ${compactNumber(value)} четверти`;
}

const RUSSIAN_PULSE_WORDS = [
  "",
  "Раз",
  "Два",
  "Три",
  "Четыре",
  "Пять",
  "Шесть",
  "Семь",
  "Восемь",
  "Девять",
  "Десять",
  "Одиннадцать",
  "Двенадцать",
];

function pulseCountWord(pulse: number): string {
  return RUSSIAN_PULSE_WORDS[pulse] ?? String(pulse);
}

/**
 * Один словарь используется в таблице, hover и бегунке. Для шестнадцатых
 * русскоязычному начинающему понятнее «раз-та-и-та»: «и» остаётся ровно
 * посередине доли, а заимствованное из 1-e-&-a «е» не появляется без
 * объяснения. Тернарное деление сохраняет «раз-три-оль».
 */
const COUNT_SYLLABLES: Record<number, readonly string[]> = {
  1: [""],
  2: ["", "и"],
  3: ["", "три", "оль"],
  4: ["", "та", "и", "та"],
};

const GRID_TOLERANCE = 0.02;

/** Выбирает минимальную сетку, на которую попадают реальные границы событий. */
function chooseSubdivisions(
  events: readonly TimedEvent[],
  pulseLength: number,
  ternary: boolean,
): number {
  if (ternary) return 3;
  const boundaries = events.flatMap((event) => [
    event.onset,
    event.onset + event.duration,
  ]);
  const aligned = (value: number, subdivisions: number): boolean => {
    const step = pulseLength / subdivisions;
    return near(value / step, Math.round(value / step), GRID_TOLERANCE);
  };
  // Даже когда в такте только четверти, половинные или целая, учебная шкала
  // остаётся минимум восьмой: «Раз и Два и…». Иначе длинная нота выглядела
  // как четыре несвязанных слова и ученик не видел, сколько именно её держать.
  if (boundaries.every((value) => aligned(value, 2))) return 2;
  // Более мелкие длительности остаются честно видны через attacksInside,
  // но произносимая сетка не получает выдуманных слогов мельче шестнадцатой.
  return 4;
}

/** Множители длительности `<beat-unit>` относительно четверти. */
const BEAT_UNIT_QUARTERS: Record<string, number> = {
  maxima: 32,
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
};

/**
 * Действующий темп в четвертях в минуту на начало такта: последнее по времени
 * указание `<metronome>` или `<sound tempo>` из тактов до целевого включительно.
 * Ничего не выдумывает: без указаний возвращает `undefined`.
 */
export function resolveQuarterBpm(
  measures: readonly XmlNodeLite[],
  oneBasedMeasure: number,
): number | undefined {
  let quarterBpm: number | undefined;
  for (let index = 0; index < Math.min(measures.length, oneBasedMeasure); index += 1) {
    for (const node of xmlChildren(measures[index])) {
      if (node.name === "sound") {
        const tempo = finiteNumber(node.attrs.tempo);
        if (tempo && tempo > 0) quarterBpm = tempo;
        continue;
      }
      if (node.name !== "direction") continue;
      for (const sound of xmlDescendants(node, "sound")) {
        const tempo = finiteNumber(sound.attrs.tempo);
        if (tempo && tempo > 0) quarterBpm = tempo;
      }
      for (const metronome of xmlDescendants(node, "metronome")) {
        const perMinute = finiteNumber(xmlText(xmlChild(metronome, "per-minute")));
        if (!perMinute || perMinute <= 0) continue;
        const unit = xmlText(xmlChild(metronome, "beat-unit")).toLowerCase();
        const dots = xmlChildren(metronome, "beat-unit-dot").length;
        const base = BEAT_UNIT_QUARTERS[unit] ?? 1;
        // Точка добавляет половину, вторая — четверть исходной длительности.
        const dotted = base * (2 - 2 ** -dots);
        quarterBpm = perMinute * dotted;
      }
    }
  }
  return quarterBpm;
}

export function buildRhythmCountGuide(
  events: readonly TimedEvent[],
  time: TimeState | undefined,
  actualQuarters: number,
  implicit: boolean,
  firstMeasure: boolean,
  handByStaff: ReadonlyMap<number, FingeringHand> = new Map(),
): RhythmCountGuide {
  const geometry = timeGeometry(time);
  const expected = geometry.expected;
  const pickup = Boolean(
    expected
    && actualQuarters > 0
    && actualQuarters < expected - 0.001
    && (implicit || firstMeasure),
  );
  const pickupOffset = pickup && expected ? expected - actualQuarters : 0;
  const metered = Boolean(time) && !time!.senzaMisura;
  const counted = events.filter((event) => !event.grace);
  const ternary = geometry.compound || counted.some((event) => event.triplet);
  const subdivisions = chooseSubdivisions(counted, geometry.pulseLength, ternary);
  const step = geometry.pulseLength / subdivisions;
  // 6/8 — составной метр «Раз-и-а | Два-и-а», а не две записанные триоли.
  // «три-оль» оставляем только для явного `<time-modification>` 3:2.
  const syllables = geometry.compound
    ? ["", "и", "а"]
    : COUNT_SYLLABLES[subdivisions] ?? COUNT_SYLLABLES[2];
  const handOf = (staff: number): FingeringHand =>
    handByStaff.get(staff) ?? (staff <= 1 ? "right" : "left");
  const handOfEvent = (event: TimedEvent): FingeringHand =>
    event.hand ?? handOf(event.staff);

  const describeCell = (metricOffset: number): RhythmCountItem => {
    const pulseIndex = Math.max(0, Math.floor((metricOffset + 0.0001) / geometry.pulseLength));
    const subIndex = Math.round((metricOffset - pulseIndex * geometry.pulseLength) / step);
    const pulse = pulseIndex + 1;
    const pulseStart = subIndex === 0;
    const word = pulseCountWord(pulse);
    const syllable = pulseStart ? word : syllables[subIndex] ?? "и";
    // Всё, что попало внутрь счёта, принадлежит этому счёту: две шестнадцатые
    // играются «на раз», а не заводят себе отдельную позицию счёта.
    const inside = (event: TimedEvent): boolean => {
      const onset = event.onset + pickupOffset;
      return onset >= metricOffset - GRID_TOLERANCE
        && onset < metricOffset + step - GRID_TOLERANCE;
    };
    const cellEnd = metricOffset + step;
    const overlapsCell = (event: TimedEvent): boolean => {
      const start = event.onset + pickupOffset;
      const end = start + event.duration;
      return start < cellEnd - GRID_TOLERANCE && end > metricOffset + GRID_TOLERANCE;
    };
    const stateForHand = (hand: FingeringHand): RhythmHandState => {
      const handEvents = counted.filter((event) => handOfEvent(event) === hand);
      const attacks = handEvents.filter(
        (event) => !event.rest && !event.tieStop && inside(event),
      );
      const sounding = handEvents.filter((event) => !event.rest && overlapsCell(event));
      const held = sounding.filter(
        (event) =>
          (!event.staccato || event.tieStop)
          && (
            event.onset + pickupOffset < metricOffset - GRID_TOLERANCE
            || (
              event.tieStop
              && event.onset + pickupOffset <= metricOffset + GRID_TOLERANCE
            )
          ),
      );
      const incoming = handEvents.filter((event) => {
        const start = event.onset + pickupOffset;
        const end = start + event.duration;
        return (
          !event.staccato
          || event.tieStop
        ) && (
          start < metricOffset - GRID_TOLERANCE
          || (event.tieStop && start <= metricOffset + GRID_TOLERANCE)
        ) && end > metricOffset + GRID_TOLERANCE;
      });
      const rests = handEvents.filter((event) => event.rest && overlapsCell(event));
      const restStarts = handEvents.filter((event) => event.rest && inside(event));
      const overlappingEvents = handEvents.filter(overlapsCell);
      const attackOnsets = new Set(
        attacks.map((event) => Number((event.onset + pickupOffset).toFixed(4))),
      ).size;
      return {
        kind: attacks.length
          ? "attack"
          : held.length
            ? "hold"
            : rests.length
              ? "rest"
              : "silent",
        attackOnsets,
        staccatoAttacks: attacks.filter((event) => event.staccato).length,
        attackNotes: attacks.length,
        heldNotes: held.length,
        restEvents: rests.length,
        restStarts: restStarts.length,
        durations: [...new Set(
          overlappingEvents
            .filter((event) => event.duration > GRID_TOLERANCE)
            .map((event) => durationFromQuarters(event.duration)),
        )],
        // Линия входит только при строгом перекрытии клетки. Нота, закончившаяся
        // ровно на границе, не должна визуально тянуться ещё пол-клетки.
        continuesFrom: incoming.length > 0,
        // Ровно выписанная восьмая доходит до края своей восьмой клетки.
        // Благодаря этому линия на дорожке изображает длительность, а не
        // только мгновенную точку атаки.
        continuesAfter: overlappingEvents.some((event) =>
          (!event.staccato || event.tieStop)
          && event.onset + pickupOffset + event.duration >= cellEnd - GRID_TOLERANCE
        ),
      };
    };
    const handStates: Record<FingeringHand, RhythmHandState> = {
      right: stateForHand("right"),
      left: stateForHand("left"),
    };
    const attacks = counted.filter(
      (event) => !event.rest && !event.tieStop && inside(event),
    );
    const states = [handStates.right, handStates.left];
    const onsets = [...new Set(
      attacks.map((event) => Number((event.onset + pickupOffset).toFixed(4))),
    )];
    const kind: RhythmCellKind = states.some((state) => state.kind === "attack")
      ? "attack"
      : states.some((state) => state.kind === "hold")
        ? "hold"
        : states.some((state) => state.kind === "rest")
          ? "rest"
          : "silent";

    return {
      offsetQuarters: Number((metricOffset - pickupOffset).toFixed(6)),
      pulse,
      syllable,
      label: pulseStart ? word : `${word}-${syllable}`,
      pulseStart,
      kind,
      hands: (["right", "left"] as const).filter(
        (hand) => handStates[hand].kind !== "silent",
      ),
      handStates,
      /** Сколько раз внутри одного счёта берётся новый звук. */
      attacksInside: onsets.length,
      offGrid: onsets.length > 1,
    };
  };

  // Сетка непрерывна: доля существует, даже когда на ней ничего не начинается.
  // Именно этой доли не хватало ученику, когда счёт строился по атакам.
  const cells: RhythmCountItem[] = [];
  if (metered) {
    const gridStart = pickup ? pickupOffset : 0;
    const gridEnd = Math.max(
      gridStart + geometry.pulseLength,
      pickup
        ? expected ?? actualQuarters + pickupOffset
        : Math.max(expected ?? 0, actualQuarters),
    );
    for (let index = 0; gridStart + index * step < gridEnd - GRID_TOLERANCE; index += 1) {
      cells.push(describeCell(Number((gridStart + index * step).toFixed(6))));
    }
  }

  const items = cells.filter((cell) => cell.kind === "attack" || cell.kind === "rest");
  const spoken = cells
    .map((cell) => (cell.pulseStart ? cell.syllable.toLowerCase() : cell.syllable))
    .join(" ");
  const meter = time ? timeSignatureText(time) : undefined;
  const crowded = cells.filter((cell) => cell.attacksInside > 1).length;
  const labelsForHand = (hand: FingeringHand, kind: RhythmCellKind): string[] =>
    cells
      .filter((cell) => cell.handStates[hand].kind === kind)
      .map((cell) => `«${cell.label}»`);
  const handInstructions = (["right", "left"] as const)
    .flatMap((hand) => {
      const attacks = labelsForHand(hand, "attack");
      const holds = labelsForHand(hand, "hold");
      const rests = labelsForHand(hand, "rest");
      if (!attacks.length && !holds.length && !rests.length) return [];
      const name = hand === "right" ? "Правая рука" : "Левая рука";
      return [`${name}: ${[
        attacks.length ? `новые ноты — ${attacks.join(", ")}` : "новых нот нет",
        holds.length ? `на ${holds.join(", ")} звук тянется — держи` : "",
        rests.length ? `на ${rests.join(", ")} пауза — тишина, счёт продолжается` : "",
      ].filter(Boolean).join(" · ")}.`];
    });
  const handSummaries: RhythmHandSummary[] = (["right", "left"] as const)
    .flatMap((hand) => {
      const attacks = labelsForHand(hand, "attack").map((label) => label.slice(1, -1));
      const holds = labelsForHand(hand, "hold").map((label) => label.slice(1, -1));
      const rests = labelsForHand(hand, "rest").map((label) => label.slice(1, -1));
      return attacks.length || holds.length || rests.length
        ? [{ hand, attacks, holds, rests }]
        : [];
    });
  const metricOffsetOf = (cell: RhythmCountItem) => cell.offsetQuarters + pickupOffset;
  const syncopations: RhythmSyncopation[] = counted
    .filter(
      (event) => !event.rest && !event.tieStop && event.duration > GRID_TOLERANCE,
    )
    .flatMap((event) => {
      const start = event.onset + pickupOffset;
      const pulseIndex = Math.floor((start + GRID_TOLERANCE) / geometry.pulseLength);
      const pulseStart = pulseIndex * geometry.pulseLength;
      const nextPulse = pulseStart + geometry.pulseLength;
      if (
        start <= pulseStart + GRID_TOLERANCE
        || start + event.duration <= nextPulse + GRID_TOLERANCE
      ) return [];
      const startCell = cells.find((cell) => {
        const offset = metricOffsetOf(cell);
        return start >= offset - GRID_TOLERANCE
          && start < offset + step - GRID_TOLERANCE;
      });
      const crossedCell = cells.find(
        (cell) => cell.pulseStart && near(metricOffsetOf(cell), nextPulse, GRID_TOLERANCE),
      );
      if (!startCell || !crossedCell) return [];
      return [{
        start: startCell.label,
        crossed: crossedCell.label,
        duration: durationFromQuarters(event.duration),
        hand: handOfEvent(event),
      }];
    })
    .filter(
      (item, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.start === item.start
            && candidate.crossed === item.crossed
            && candidate.duration === item.duration
            && candidate.hand === item.hand,
        ) === index,
    );
  const explanation = !time
    ? "В партитуре нет действующего размера, поэтому сетку счёта строить не по чему."
    : time.senzaMisura
      ? "В партитуре указан свободный метр: ровной сетки счёта здесь нет."
      : !cells.length
        ? "В этом такте нет метрических позиций для счёта."
        : [
            pickup
              ? `Это затакт: он длится ${compactNumber(actualQuarters)} четверти и только заканчивает такт, поэтому счёт начинается не с «раз».`
              : "",
            "Обе строки читай по одному пульсу, но действия каждой руки выполняй отдельно.",
            ...handInstructions,
            geometry.compound
              ? "Размер составной: каждая большая доля делится на три — «раз-и-а»."
              : "",
            ...syncopations.map(
              (syncopation) =>
                `${syncopation.hand === "right" ? "Правая" : "Левая"} рука, синкопа: ${syncopation.duration} начинается на «${syncopation.start}» и проходит через «${syncopation.crossed}»; на «${syncopation.crossed}» новую ноту не нажимай — продолжай держать.`,
            ),
            crowded
              ? "Где стоит «×2» — на этот счёт играются две шестнадцатые."
              : "",
          ].filter(Boolean).join(" ");

  return {
    meter,
    pulse: geometry.pulseLabel,
    pickup,
    actualQuarters,
    expectedQuarters: expected,
    subdivisions,
    pulseCount: cells.filter((cell) => cell.pulseStart).length,
    cells,
    items,
    handSummaries,
    syncopations,
    explanation,
    spoken,
  };
}

function sortedSymbols(symbols: Map<string, MeasureVisibleSymbol>): MeasureVisibleSymbol[] {
  const order = [
    "clef", "key", "time", "duration", "rest", "fingering", "accidental", "beam",
    "tuplet", "tie", "slur", "articulation", "dynamic", "wedge", "dashes", "bracket", "pedal",
    "arpeggiate", "grace", "ornament", "repeat", "ending", "octave-shift",
    "tremolo", "glissando", "unknown",
  ];
  return [...symbols.values()].sort((left, right) => {
    const leftIndex = order.indexOf(left.kind);
    const rightIndex = order.indexOf(right.kind);
    return (leftIndex < 0 ? order.length : leftIndex)
      - (rightIndex < 0 ? order.length : rightIndex)
      || left.label.localeCompare(right.label, "ru");
  });
}

export function measureLearningFromScore(
  parsedScore: ParsedLearningScore,
  oneBasedMeasure: number,
): MeasureLearningData {
  const measureIndex = Math.max(1, Math.floor(oneBasedMeasure || 1));
  const documentNode = parsedScore.documentNode;
  const score = documentNode.children.find((node) => node.name === "score-partwise");
  const symbols = new Map<string, MeasureVisibleSymbol>();
  const glyphDetails: MeasureLearningData["glyphDetails"] = { clef: [], key: [], time: [] };
  const measureLabels: string[] = [];
  const allEvents: TimedEvent[] = [];
  /** Стабильная фортепианная семантика стана; ключ определяет высоту, не руку. */
  const handByStaff = new Map<number, FingeringHand>();
  const playbackNotes: MeasurePlaybackNote[] = [];
  let tempoMeasures: XmlNodeLite[] | undefined;
  let actualQuarters = 0;
  let guideTime: TimeState | undefined;
  let implicit = false;

  if (!score) {
    return {
      measureIndex,
      measureLabels,
      symbols: [],
      rhythm: buildRhythmCountGuide([], undefined, 0, false, measureIndex === 1),
      playback: { notes: [], quarters: 0, pulseLength: 1 },
      glyphDetails,
    };
  }

  for (const part of xmlChildren(score, "part")) {
    const measures = xmlChildren(part, "measure");
    const target = measures[measureIndex - 1];
    if (!target) continue;
    const state = freshAttributeState();
    const spans = freshSpanState();
    for (let index = 0; index < measureIndex - 1; index += 1) {
      for (const child of xmlChildren(measures[index], "attributes")) applyAttributes(child, state);
      updateMeasureSpanState(measures[index], spans);
    }
    addContinuingSpanSymbols(symbols, spans);

    const inherited = cloneAttributeState(state);
    let initial = cloneAttributeState(inherited);
    let timedContentStarted = false;
    for (const child of xmlChildren(target)) {
      if (child.name === "attributes") {
        applyAttributes(child, state);
        if (!timedContentStarted) initial = cloneAttributeState(state);
      } else if (child.name === "note" || child.name === "backup" || child.name === "forward") {
        timedContentStarted = true;
      }
    }

    measureLabels.push(target.attrs.number || String(measureIndex));
    implicit ||= target.attrs.implicit === "yes";
    const staffIds = new Set<number>();
    for (let staff = 1; staff <= initial.staves; staff += 1) staffIds.add(staff);
    for (const staff of [...initial.clefs.keys(), ...initial.keys.keys(), ...initial.times.keys()]) {
      if (staff > 0) staffIds.add(staff);
    }
    if (!staffIds.size) staffIds.add(1);

    for (const staff of [...staffIds].sort((left, right) => left - right)) {
      const clef = resolvedForStaff(initial.clefs, staff);
      if (!handByStaff.has(staff)) {
        handByStaff.set(staff, staff <= 1 ? "right" : "left");
      }
      if (clef) {
        const detail = clefDetail({ ...clef, staff });
        if (pushGuideDetail(glyphDetails.clef, detail)) {
          addVisibleSymbol(symbols, {
            kind: "clef",
            label: detail.title,
            detail: `${detail.summary}. ${detail.lines.join(" ")}`,
            interactive: "clef",
          });
        }
      }
      const key = resolvedForStaff(initial.keys, staff);
      if (key) {
        const detail = keyDetail({ ...key, staff });
        if (pushGuideDetail(glyphDetails.key, detail)) {
          addVisibleSymbol(symbols, {
            kind: "key",
            label: detail.title,
            detail: `${detail.summary}. ${detail.lines.join(" ")}`,
            interactive: "key",
          });
        }
      }
      const time = resolvedForStaff(initial.times, staff);
      if (time) {
        const detail = timeDetail({ ...time, staff });
        if (pushGuideDetail(glyphDetails.time, detail)) {
          addVisibleSymbol(symbols, {
            kind: "time",
            label: `${detail.title} ${timeSignatureText(time)}`,
            detail: `${detail.summary}. ${detail.lines.join(" ")}`,
            interactive: "time",
          });
        }
        guideTime ??= time;
      }
    }

    for (const attributes of xmlChildren(target, "attributes")) {
      for (const clefNode of xmlChildren(attributes, "clef").filter(visibleXml)) {
        const detail = clefDetail(parseClefState(clefNode));
        if (pushGuideDetail(glyphDetails.clef, detail)) {
          addVisibleSymbol(symbols, {
            kind: "clef",
            label: detail.title,
            detail: `${detail.summary}. ${detail.lines.join(" ")}`,
            interactive: "clef",
          });
        }
      }
      for (const keyNode of xmlChildren(attributes, "key").filter(visibleXml)) {
        const parsed = parseKeyState(keyNode);
        const detail = keyDetail({ ...parsed, staff: parsed.staff || 1 });
        if (pushGuideDetail(glyphDetails.key, detail)) {
          addVisibleSymbol(symbols, {
            kind: "key",
            label: detail.title,
            detail: `${detail.summary}. ${detail.lines.join(" ")}`,
            interactive: "key",
          });
        }
      }
      for (const timeNode of xmlChildren(attributes, "time").filter(visibleXml)) {
        const parsed = parseTimeState(timeNode);
        const detail = timeDetail({ ...parsed, staff: parsed.staff || 1 });
        if (pushGuideDetail(glyphDetails.time, detail)) {
          addVisibleSymbol(symbols, {
            kind: "time",
            label: `${detail.title} ${timeSignatureText(parsed)}`,
            detail: `${detail.summary}. ${detail.lines.join(" ")}`,
            interactive: "time",
          });
        }
      }
    }

    const timing = parseTimedEvents(target, inherited.divisions);
    allEvents.push(...timing.events);
    actualQuarters = Math.max(actualQuarters, timing.actualQuarters);
    tempoMeasures ??= measures;
    for (const event of timing.events) {
      if (event.rest || event.tieStop || event.midi === undefined) continue;
      playbackNotes.push({
        // Форшлаг звучит коротким опережением своей опоры, как его и играют.
        onsetQuarters: event.grace ? Math.max(0, event.onset - 0.125) : event.onset,
        // Staccato не имеет единой абсолютной длины. Для учебного preview
        // берём нейтральное ~45 % нотированной длительности: слышно раннее
        // отпускание, но ритмическое место ноты не меняется.
        durationQuarters: event.grace
          ? 0.125
          : event.staccato
            ? Math.max(0.125, event.duration * 0.45)
            : event.duration,
        midi: event.midi,
        hand: event.hand
          ?? handByStaff.get(event.staff)
          ?? (event.staff <= 1 ? "right" : "left"),
        grace: event.grace,
      });
    }

    for (const child of xmlChildren(target)) {
      if (child.name === "note") addNoteSymbols(child, symbols);
      else if (child.name === "direction") addDirectionSymbols(child, symbols);
      else if (child.name === "barline") addBarlineSymbols(child, symbols);
      else if (child.name === "harmony" && visibleXml(child)) {
        addVisibleSymbol(symbols, {
          kind: "harmony",
          label: "Аккордовый символ",
          detail: xmlText(child) || "Гармоническое обозначение над станом.",
        });
      } else if (child.name === "figured-bass" && visibleXml(child)) {
        addVisibleSymbol(symbols, {
          kind: "figured-bass",
          label: "Цифрованный бас",
          detail: xmlText(child) || "Интервальная разметка гармонии.",
        });
      }
    }
  }

  const rhythm = buildRhythmCountGuide(
    allEvents,
    guideTime,
    actualQuarters,
    implicit,
    measureIndex === 1,
    handByStaff,
  );
  const geometry = timeGeometry(guideTime);

  return {
    measureIndex,
    measureLabels: [...new Set(measureLabels)],
    symbols: sortedSymbols(symbols),
    rhythm,
    playback: {
      notes: playbackNotes.sort(
        (left, right) => left.onsetQuarters - right.onsetQuarters || left.midi - right.midi,
      ),
      // Затакт проигрывается ровно тем, что записано; полный такт — по размеру,
      // чтобы недобранный хвост не обрезал метроном.
      quarters: rhythm.pickup
        ? actualQuarters
        : Math.max(geometry.expected ?? 0, actualQuarters) || actualQuarters,
      pulseLength: geometry.pulseLength,
      quarterBpm: tempoMeasures
        ? resolveQuarterBpm(tempoMeasures, measureIndex)
        : undefined,
    },
    glyphDetails,
  };
}

export function parseMeasureLearning(
  xml: string,
  oneBasedMeasure: number,
): MeasureLearningData {
  return measureLearningFromScore(parseMusicXmlLearningScore(xml), oneBasedMeasure);
}

/** Сколько тактов в партитуре: нужно, чтобы окно показа не уезжало за конец. */
export function countMeasures(parsedScore: ParsedLearningScore): number {
  const score = parsedScore.documentNode.children.find(
    (node) => node.name === "score-partwise",
  );
  if (!score) return 0;
  return Math.max(
    0,
    ...xmlChildren(score, "part").map((part) => xmlChildren(part, "measure").length),
  );
}

/**
 * Полный произносимый интервал события. У короткой ноты это одна точная
 * позиция («Раз-и»), у целой в 4/4 — все восемь слогов до конца такта.
 * Таблица и tooltip получают данные из одних и тех же RhythmCountItem.
 */
export function countSpanAt(
  cells: readonly RhythmCountItem[],
  onsetQuarters: number,
  durationQuarters: number,
): string | undefined {
  const start = cells.find(
    (candidate) => Math.abs(candidate.offsetQuarters - onsetQuarters) <= 0.02,
  );
  if (!start) return undefined;
  const end = onsetQuarters + Math.max(0, durationQuarters);
  const covered = cells.filter(
    (cell) =>
      cell.offsetQuarters >= onsetQuarters - GRID_TOLERANCE
      && cell.offsetQuarters < end - GRID_TOLERANCE,
  );
  if (covered.length <= 1) return start.label;
  return covered.map((cell) => cell.syllable).join("-");
}

/**
 * Окно показа: сколько тактов рисуем и с какого начинаем. Если выбранный такт
 * ближе к концу, чем размер окна, окно сдвигается назад — ученик всё равно
 * видит выбранный такт, но экран не остаётся полупустым.
 */
export function measureWindowRange(
  selected: number,
  span: number,
  total: number,
): { from: number; to: number } {
  const size = Math.max(1, Math.floor(span));
  const last = total > 0 ? total : selected;
  const from = Math.max(1, Math.min(selected, last - size + 1));
  return { from, to: Math.min(last, from + size - 1) };
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import type {
  GraphicalMeasure,
  GraphicalNote,
  Note,
  OpenSheetMusicDisplay,
  VexFlowGraphicalNote,
} from "opensheetmusicdisplay";
import {
  MeasurePlayer,
  audioPlaybackSupported,
  buildWindowPlaybackPlan,
  cellAtPosition,
  type MeasurePlayerPlan,
} from "../measure-player";

const props = defineProps<{
  /** Полный MusicXML с уже встроенными <fingering>; MXL распаковывает сервер. */
  xml: string;
  /** Внутренний 1-based индекс такта, а не потенциально дублирующийся XML number. */
  measureNumber: number;
  /** Сколько тактов показывать на экране: 1, 3 или 5. */
  measureSpan?: number;
}>();

type ViewerState = "empty" | "loading" | "ready" | "error";

const surface = ref<HTMLElement>();
const scoreRoot = ref<HTMLElement>();
const rhythmOverview = ref<HTMLElement>();
const tooltipElement = ref<HTMLElement>();
const rhythmTooltipElement = ref<HTMLElement>();
const state = ref<ViewerState>("empty");
const errorMessage = ref("");
/** Один такт окна вместе с его смещением в общем времени окна. */
interface WindowMeasure {
  /** Абсолютный 1-based индекс такта в партитуре. */
  index: number;
  label: string;
  data: MeasureLearningData;
  /** Начало такта в четвертях от начала окна. */
  offsetQuarters: number;
}

const windowMeasures = ref<WindowMeasure[]>([]);
const totalMeasures = ref(0);
interface PositionedRhythmCellTooltip {
  count: string;
  hand: string;
  action: string;
  facts: string[];
  left: number;
  top: number;
  placement: "above" | "below";
}
const rhythmCellTooltip = ref<PositionedRhythmCellTooltip>();
let rhythmTooltipTarget: HTMLElement | undefined;

function positionRhythmCellTooltip(target: HTMLElement): void {
  const tooltip = rhythmTooltipElement.value;
  if (!tooltip || rhythmTooltipTarget !== target) return;
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const gutter = 12;
  const left = Math.max(
    gutter,
    Math.min(
      window.innerWidth - tooltipRect.width - gutter,
      targetRect.left + targetRect.width / 2 - tooltipRect.width / 2,
    ),
  );
  const fitsAbove = targetRect.top >= tooltipRect.height + gutter * 2;
  rhythmCellTooltip.value = rhythmCellTooltip.value
    ? {
        ...rhythmCellTooltip.value,
        left,
        top: fitsAbove
          ? targetRect.top - tooltipRect.height - 10
          : Math.min(
              window.innerHeight - tooltipRect.height - gutter,
              targetRect.bottom + 10,
            ),
        placement: fitsAbove ? "above" : "below",
      }
    : undefined;
}

function showRhythmCellTooltip(
  event: MouseEvent | FocusEvent,
  cell: RhythmCountItem,
  hand: FingeringHand,
): void {
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  rhythmTooltipTarget = target;
  const targetRect = target.getBoundingClientRect();
  rhythmCellTooltip.value = {
    ...handCellTooltip(cell, hand),
    left: Math.max(12, targetRect.left),
    top: targetRect.bottom + 10,
    placement: "below",
  };
  void nextTick(() => positionRhythmCellTooltip(target));
}

function hideRhythmCellTooltip(): void {
  rhythmTooltipTarget = undefined;
  rhythmCellTooltip.value = undefined;
}

const currentMeasure = computed(() =>
  Math.max(1, Math.floor(Number.isFinite(props.measureNumber) ? props.measureNumber : 1)),
);
const measureSpan = computed(() => {
  const span = Math.floor(props.measureSpan ?? 1);
  return span === 3 || span === 5 ? span : 1;
});
const windowRange = computed(() =>
  measureWindowRange(currentMeasure.value, measureSpan.value, totalMeasures.value),
);
const activeMeasureIndex = ref(currentMeasure.value);
const activeWindowMeasure = computed(
  () =>
    windowMeasures.value.find((measure) => measure.index === activeMeasureIndex.value)
    ?? windowMeasures.value[0],
);
const learningMeasure = computed(() => activeWindowMeasure.value?.data);
const scoreRange = computed(() => windowRange.value);
const learningAttributeSymbols = computed(
  () => learningMeasure.value?.symbols.filter((symbol) => symbol.interactive) ?? [],
);
const learningNotationSymbols = computed(
  () => learningMeasure.value?.symbols.filter((symbol) => !symbol.interactive) ?? [],
);

const attributeCards = computed(() =>
  attributeCardsFromSymbols(learningAttributeSymbols.value),
);

/**
 * Учебные категории обозначений. Ученику нужен ответ на вопрос «что мне с этим
 * делать», а не алфавитный список из двадцати чипов.
 */
const SYMBOL_GROUPS: Array<{ title: string; kinds: string[] }> = [
  { title: "Ритм и длительности", kinds: ["duration", "rest", "beam", "tuplet", "grace"] },
  { title: "Связывание", kinds: ["tie", "slur"] },
  { title: "Как играть", kinds: ["articulation", "ornament", "technical", "fermata", "tremolo", "glissando", "arpeggiate"] },
  { title: "Громкость", kinds: ["dynamic", "wedge"] },
  { title: "Педаль", kinds: ["pedal"] },
  { title: "Форма и повторы", kinds: ["repeat", "ending", "navigation", "rehearsal", "words", "octave-shift"] },
];

const symbolGroups = computed(() => {
  const rest = new Set(learningNotationSymbols.value.map((symbol) => symbol.id));
  const groups = SYMBOL_GROUPS.map((group) => {
    const symbols = learningNotationSymbols.value.filter(
      (symbol) => group.kinds.includes(symbol.kind),
    );
    for (const symbol of symbols) rest.delete(symbol.id);
    return { title: group.title, symbols };
  }).filter((group) => group.symbols.length);
  const others = learningNotationSymbols.value.filter((symbol) => rest.has(symbol.id));
  return others.length ? [...groups, { title: "Прочие знаки", symbols: others }] : groups;
});

/* ------------------------------------------------------------------ *
 * Счёт такта и проигрывание
 * ------------------------------------------------------------------ */

const DEFAULT_QUARTER_BPM = 72;
const TEMPO_RANGE = { min: 40, max: 160, step: 4 };

/** Клетка счёта в сквозном времени окна: по ней ходят бегунок и подсветка. */
interface WindowCell {
  cell: RhythmCountItem;
  globalQuarters: number;
  measureIndex: number;
  measureLabel: string;
}

const windowCells = computed<WindowCell[]>(() => {
  return windowMeasures.value.flatMap((measure) =>
    measure.data.rhythm.cells.map((cell) => ({
      cell,
      globalQuarters: Number((measure.offsetQuarters + cell.offsetQuarters).toFixed(6)),
      measureIndex: measure.index,
      measureLabel: measure.label,
    })),
  );
});
const cellOffsets = computed(() => windowCells.value.map((item) => item.globalQuarters));

/**
 * Счёт по тактам окна: каждая строка — такт, внутри — доли и их половины.
 * В окне из нескольких тактов ученик видит сквозной счёт, а не только выбранный.
 */
const rhythmRows = computed(() =>
  windowMeasures.value.map((measure) => {
    const cells = measure.data.rhythm.cells.map((cell) => ({
      cell,
      globalQuarters: Number((measure.offsetQuarters + cell.offsetQuarters).toFixed(6)),
      measureIndex: measure.index,
      measureLabel: measure.label,
    }));
    const beats: Array<{ pulse: number; cells: WindowCell[] }> = [];
    for (const item of cells) {
      const last = beats.at(-1);
      if (last && last.pulse === item.cell.pulse) last.cells.push(item);
      else beats.push({ pulse: item.cell.pulse, cells: [item] });
    }
    return {
      index: measure.index,
      label: measure.label,
      rhythm: measure.data.rhythm,
      cells,
      beats,
      warnings:
        measure.data.rhythm.syncopations.length
        + (measure.data.rhythm.pickup ? 1 : 0)
        + (measure.data.rhythm.subdivisions >= 4 ? 1 : 0),
    };
  }),
);

/** У фортепиано обе руки остаются видимыми даже в такте, где одна молчит. */
const rhythmHands: readonly FingeringHand[] = ["right", "left"];

function rhythmHandTitle(hand: FingeringHand): string {
  return hand === "right" ? "Правая" : "Левая";
}

function rhythmHandMark(state: RhythmHandState): string {
  if (state.kind === "attack") return "●";
  // Музыкальный rest-glyph зависит от SMuFL-шрифта и в системном шрифте
  // превращался в «решётку». Пустой круг стабилен и читается по легенде.
  if (state.kind === "rest") return state.restStarts ? "○" : "";
  return "";
}

function handCellTooltip(
  cell: RhythmCountItem,
  hand: FingeringHand,
): Pick<PositionedRhythmCellTooltip, "count" | "hand" | "action" | "facts"> {
  const state = cell.handStates[hand];
  const handName = hand === "right" ? "Правая рука · верхний стан" : "Левая рука · нижний стан";
  const action = state.kind === "attack"
    ? [
        state.heldNotes
          ? `продолжать держать ${state.heldNotes} ${state.heldNotes === 1 ? "ноту" : "ноты"}`
          : "",
        state.attackNotes > 1
          ? `взять одновременно ${state.attackNotes} ноты`
          : "взять новую ноту",
      ].filter(Boolean).join(" и ")
    : state.kind === "hold"
      ? "продолжать держать звук"
      : state.kind === "rest"
        ? "пауза — не играть"
        : "нового действия нет";
  return {
    count: cell.label,
    hand: handName,
    action,
    facts: [
      state.attackOnsets > 1
        ? `${state.attackOnsets} последовательные атаки внутри позиции`
        : "",
      state.staccatoAttacks
        ? "Staccato · сыграть коротко и отпустить"
        : "",
      state.durations.length
        ? `Нотированная длительность · ${state.durations.join(" / ")}`
        : "",
    ].filter(Boolean),
  };
}

const rhythmCoachNotes = computed(() =>
  activeWindowMeasure.value ? [activeWindowMeasure.value].flatMap((measure) => {
    const guide = measure.data.rhythm;
    const notes: Array<{ id: string; kind: string; label: string; text: string }> = [];
    if (guide.pickup) {
      notes.push({
        id: `${measure.index}-pickup`,
        kind: "pickup",
        label: `Такт ${measure.label} · затакт`,
        text: "Начинай с показанной позиции, не добавляй воображаемые доли.",
      });
    }
    for (const [index, syncopation] of guide.syncopations.entries()) {
      notes.push({
        id: `${measure.index}-syncopation-${index}`,
        kind: "syncopation",
        label: `Такт ${measure.label} · ${syncopation.hand === "right" ? "правая" : "левая"}`,
        text: `${syncopation.duration} начинается на «${syncopation.start}» и тянется через «${syncopation.crossed}».`,
      });
    }
    const crowded = guide.cells.filter((cell) =>
      cell.handStates.right.attackOnsets > 1 || cell.handStates.left.attackOnsets > 1
    ).length;
    if (crowded) {
      notes.push({
        id: `${measure.index}-crowded`,
        kind: "crowded",
        label: `Такт ${measure.label} · мелкое деление`,
        text: "Цифра у точки показывает, сколько нот успевает внутри одного слога счёта.",
      });
    }
    return notes;
  }) : [],
);

/**
 * Все атаки окна дробятся одинаково (например, всюду по две шестнадцатые на
 * счёт). Тогда метка «×2» на каждой клетке — шум: правило говорится один раз
 * словами, а сетка остаётся читаемой.
 */
const rhythmActionHints = computed(() => {
  const cells = windowCells.value.map((item) => item.cell);
  const states = cells.flatMap((cell) => [cell.handStates.right, cell.handStates.left]);
  const kinds = new Set(states.map((state) => state.kind));
  const hints: Array<{ kind: string; mark: string; text: string }> = [];
  if (kinds.has("attack")) hints.push({ kind: "attack", mark: "●", text: "сыграй ноту" });
  if (kinds.has("hold")) hints.push({ kind: "hold", mark: "─", text: "продолжай держать" });
  if (kinds.has("rest")) hints.push({ kind: "rest", mark: "○", text: "пауза — не играй" });
  return hints;
});

const player = new MeasurePlayer();
const playbackSupported = audioPlaybackSupported();
const playing = ref(false);
const audioLoading = ref(false);
const audioError = ref("");
const looping = ref(true);
const metronome = ref(true);
const playbackHands = ref<Record<FingeringHand, boolean>>({
  right: true,
  left: true,
});
const tempo = ref(DEFAULT_QUARTER_BPM);
const tempoFromScore = ref(false);
const activeCellIndex = ref(-1);
/**
 * Подробная таблица остаётся одной по высоте. Для окна 3/5 тактов верхняя
 * мини-карта показывает весь отрезок, а во время проигрывания подробный счёт
 * сам переключается на текущий такт.
 */
const detailedRhythmRows = computed(() => {
  const playingMeasure = windowCells.value[activeCellIndex.value]?.measureIndex;
  const index = playingMeasure ?? activeMeasureIndex.value;
  const row = rhythmRows.value.find((candidate) => candidate.index === index)
    ?? rhythmRows.value[0];
  return row ? [row] : [];
});
const playheadCountLabel = computed(
  () => windowCells.value[activeCellIndex.value]?.cell.label ?? "",
);
const countInPulse = ref(0);
let tempoTouched = false;
let animationFrame = 0;
let playbackRequest = 0;
let highlightedNoteheads: SVGElement[] = [];
let noteheadsByOnset = new Map<string, SVGElement[]>();
let onsetElements = new Map<string, SVGElement[]>();

/**
 * Геометрия бегунка: где по горизонтали находится каждая позиция такта.
 * Считается по фактическим координатам отрисованных знаков, а не по нотной
 * математике, — иначе линия разъезжается с гравировкой OSMD.
 */
interface PlayheadPoint {
  quarters: number;
  x: number;
}

const playhead = ref<{ x: number; top: number; height: number } | undefined>();
let playheadPoints: PlayheadPoint[] = [];
let playheadFrame = { left: 0, right: 0, top: 0, height: 0 };
let playheadReady = false;

function buildPlayheadGeometry(host: HTMLElement): void {
  playheadReady = false;
  playheadPoints = [];
  const root = scoreRoot.value;
  if (!root) return;
  const svg = host.querySelector<SVGSVGElement>("svg");
  const staveRects = Array.from(
    host.querySelectorAll<SVGElement>(".vf-stave, .staffline"),
  )
    .map((stave) => stave.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  const fallbackRect = svg?.getBoundingClientRect();
  const rects = staveRects.length
    ? staveRects
    : fallbackRect && fallbackRect.width > 0 && fallbackRect.height > 0
      ? [fallbackRect]
      : [];
  if (!rects.length) return;
  const rootRect = root.getBoundingClientRect();
  playheadFrame = {
    left: Math.min(...rects.map((rect) => rect.left)) - rootRect.left,
    right: Math.max(...rects.map((rect) => rect.right)) - rootRect.left,
    top: Math.min(...rects.map((rect) => rect.top)) - rootRect.top,
    height: Math.max(...rects.map((rect) => rect.bottom))
      - Math.min(...rects.map((rect) => rect.top)),
  };

  const byQuarters = new Map<number, number>();
  for (const [key, elements] of onsetElements) {
    const quarters = Number(key);
    if (!Number.isFinite(quarters) || !elements.length) continue;
    const left = Math.min(
      ...elements.map((element) => element.getBoundingClientRect().left),
    );
    const centre = left - rootRect.left;
    const existing = byQuarters.get(quarters);
    byQuarters.set(quarters, existing === undefined ? centre : Math.min(existing, centre));
  }
  playheadPoints = [...byQuarters.entries()]
    .map(([quarters, x]) => ({ quarters, x }))
    .sort((left, right) => left.quarters - right.quarters);
  // Даже если OSMD изменит внутренние классы нот, бегунок останется видимым и
  // пройдёт весь выбранный отрезок. Когда реальные координаты нот доступны,
  // они по-прежнему имеют приоритет и дают точное попадание в атаки и такты.
  if (!playheadPoints.length) {
    const total = playheadTotalQuarters();
    if (total > 0) {
      playheadPoints = [
        { quarters: 0, x: playheadFrame.left },
        { quarters: total, x: playheadFrame.right },
      ];
    }
  }
  playheadReady = playheadPoints.length > 0;
}

/** Линейная интерполяция между известными позициями знаков. */
function playheadX(quarters: number): number {
  if (!playheadPoints.length) return playheadFrame.left;
  const total = playheadTotalQuarters();
  const first = playheadPoints[0];
  if (quarters <= first.quarters) return first.x;
  for (let index = 1; index < playheadPoints.length; index += 1) {
    const point = playheadPoints[index];
    if (quarters < point.quarters) {
      const previous = playheadPoints[index - 1];
      const span = point.quarters - previous.quarters;
      const ratio = span > 0 ? (quarters - previous.quarters) / span : 0;
      return previous.x + (point.x - previous.x) * ratio;
    }
  }
  const last = playheadPoints[playheadPoints.length - 1];
  const tail = Math.max(0, total - last.quarters);
  if (tail <= 0) return last.x;
  const ratio = Math.min(1, (quarters - last.quarters) / tail);
  return last.x + (playheadFrame.right - last.x) * ratio;
}

function playheadTotalQuarters(): number {
  const last = windowMeasures.value.at(-1);
  if (!last) return 0;
  const length = last.data.playback.quarters > 0
    ? last.data.playback.quarters
    : last.data.rhythm.actualQuarters;
  return last.offsetQuarters + length;
}

function updatePlayhead(quarters: number | undefined): void {
  if (!playheadReady || quarters === undefined) {
    playhead.value = undefined;
    return;
  }
  playhead.value = {
    // getBoundingClientRect уже учитывает scrollLeft контейнера. Повторное
    // вычитание уводило линейку за левую границу после горизонтального скролла.
    x: playheadX(quarters),
    top: playheadFrame.top,
    height: playheadFrame.height,
  };
}

const canPlay = computed(
  () => playbackSupported
    && playheadTotalQuarters() > 0,
);
const selectedPlayback = computed(() => learningMeasure.value?.playback);
const tempoHint = computed(() =>
  tempoFromScore.value
    ? "темп из партитуры"
    : "в партитуре темп не указан",
);
const transportLabel = computed(() =>
  playing.value
    ? countInPulse.value
      ? `Отсчёт: ${countInPulse.value}`
      : "Играет"
    : "Остановлено",
);

function onsetKey(quarters: number): string {
  return quarters.toFixed(3);
}

function playbackPlan(): MeasurePlayerPlan | undefined {
  return buildWindowPlaybackPlan(
    windowMeasures.value.map((measure) => ({
      offsetQuarters: measure.offsetQuarters,
      quarters: measure.data.playback.quarters,
      pulseLength: measure.data.playback.pulseLength,
      notes: measure.data.playback.notes,
    })),
    rhythmHands.filter((hand) => playbackHands.value[hand]),
  );
}

function clearPlayingHighlight(): void {
  for (const notehead of highlightedNoteheads) notehead.classList.remove("is-playing");
  highlightedNoteheads = [];
}

function highlightPlaying(globalQuarters: number | undefined): void {
  clearPlayingHighlight();
  if (globalQuarters === undefined) return;
  const targets = noteheadsByOnset.get(onsetKey(globalQuarters)) ?? [];
  for (const notehead of targets) notehead.classList.add("is-playing");
  highlightedNoteheads = targets;
}

function revealOverviewMeasure(index: number): void {
  void nextTick(() => {
    const overview = rhythmOverview.value;
    if (!overview) return;
    const target = Array.from(
      overview.querySelectorAll<HTMLElement>("[data-measure-index]"),
    ).find((candidate) => Number(candidate.dataset.measureIndex) === index);
    if (!target || overview.scrollWidth <= overview.clientWidth) return;
    const overviewRect = overview.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const left = overview.scrollLeft
      + targetRect.left
      - overviewRect.left
      - (overview.clientWidth - targetRect.width) / 2;
    overview.scrollTo({
      left: Math.max(0, left),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  });
}

function followPlayback(): void {
  if (!playing.value) return;
  const position = player.position();
  if (position?.countIn) {
    countInPulse.value = position.countInPulse;
    if (activeCellIndex.value !== -1) {
      activeCellIndex.value = -1;
      clearPlayingHighlight();
    }
    updatePlayhead(undefined);
  } else if (position) {
    countInPulse.value = 0;
    const index = cellAtPosition(cellOffsets.value, position.quarters);
    const globalQuarters = position.quarters;
    if (index !== activeCellIndex.value) {
      activeCellIndex.value = index;
      const activeCell = windowCells.value[index];
      const activeCellQuarters = activeCell?.globalQuarters;
      highlightPlaying(activeCellQuarters);
      if (activeCell && activeCell.measureIndex !== activeMeasureIndex.value) {
        activeMeasureIndex.value = activeCell.measureIndex;
        revealOverviewMeasure(activeCell.measureIndex);
      }
    }
    updatePlayhead(globalQuarters);
  }
  animationFrame = requestAnimationFrame(followPlayback);
}

function stopPlayback(): void {
  playbackRequest += 1;
  audioLoading.value = false;
  player.onFinished = undefined;
  player.stop();
  playing.value = false;
  countInPulse.value = 0;
  activeCellIndex.value = -1;
  playhead.value = undefined;
  clearPlayingHighlight();
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
}

async function togglePlayback(): Promise<void> {
  if (audioLoading.value) return;
  if (playing.value) {
    stopPlayback();
    return;
  }
  const plan = playbackPlan();
  if (!plan) return;
  const request = ++playbackRequest;
  audioLoading.value = true;
  audioError.value = "";
  const started = await player.start(
    plan,
    {
      quarterBpm: tempo.value,
      loop: looping.value,
      metronome: metronome.value,
      countIn: true,
    },
  );
  if (request !== playbackRequest) {
    player.stop();
    return;
  }
  audioLoading.value = false;
  if (!started) {
    audioError.value = "Не удалось загрузить локальные семплы Grand Piano. Проверьте файлы аудио и повторите.";
    return;
  }
  player.onFinished = () => stopPlayback();
  playing.value = true;
  animationFrame = requestAnimationFrame(followPlayback);
}

function toggleLoop(): void {
  looping.value = !looping.value;
  player.setLoop(looping.value);
}

function toggleMetronome(): void {
  metronome.value = !metronome.value;
  player.setMetronome(metronome.value);
}

function togglePlaybackHand(hand: FingeringHand): void {
  if (playing.value || audioLoading.value) stopPlayback();
  playbackHands.value[hand] = !playbackHands.value[hand];
}

function setTempo(value: number): void {
  const clamped = Math.min(
    TEMPO_RANGE.max,
    Math.max(TEMPO_RANGE.min, Math.round(value)),
  );
  tempo.value = clamped;
  tempoTouched = true;
  player.setTempo(clamped);
}

function syncTempoWithScore(): void {
  const scoreTempo = selectedPlayback.value?.quarterBpm;
  tempoFromScore.value = scoreTempo !== undefined;
  if (tempoTouched) return;
  tempo.value = Math.min(
    TEMPO_RANGE.max,
    Math.max(TEMPO_RANGE.min, Math.round(scoreTempo ?? DEFAULT_QUARTER_BPM)),
  );
}

const CELL_ROLE_LABELS: Record<RhythmCellKind, string> = {
  attack: "новая нота",
  rest: "пауза",
  hold: "звук тянется",
  silent: "тишина",
};

function handCellAriaLabel(cell: RhythmCountItem, hand: FingeringHand): string {
  const state = cell.handStates[hand];
  const handName = hand === "right" ? "правая рука" : "левая рука";
  const detail = state.attackOnsets > 1
    ? `, ${state.attackOnsets} последовательные атаки`
    : state.attackNotes > 1
      ? `, аккорд из ${state.attackNotes} нот`
      : "";
  const held = state.kind === "attack" && state.heldNotes
    ? `, продолжая держать ${state.heldNotes} ${state.heldNotes === 1 ? "ноту" : "ноты"}`
    : "";
  return `${cell.label}, ${handName}: ${CELL_ROLE_LABELS[state.kind]}${detail}${held}`;
}

interface PositionedTooltip extends FingeringNoteTooltip {
  left: number;
  top: number;
  placement: "above" | "below";
  positioned: boolean;
}

interface PositionedGuideTooltip extends GuideDetail {
  left: number;
  top: number;
  placement: "above" | "below";
  positioned: boolean;
}

interface OriginalNoteheadAttributes {
  tabIndex: string | null;
  focusable: string | null;
  role: string | null;
  ariaLabel: string | null;
  ariaDescribedBy: string | null;
  hadHitClass: boolean;
  hadActiveClass: boolean;
}

const NOTE_TOOLTIP_ID = `fingering-note-tooltip-${useId()}`;
const GUIDE_TOOLTIP_ID = `fingering-guide-tooltip-${useId()}`;
const tooltip = ref<PositionedTooltip>();
const guideTooltip = ref<PositionedGuideTooltip>();
const guideTooltipElement = ref<HTMLElement>();

let osmd: OpenSheetMusicDisplay | undefined;
let loadedXml = "";
let disposed = false;
let requestVersion = 0;
let tooltipVersion = 0;
let guideTooltipVersion = 0;
let work = Promise.resolve();
let resizeObserver: ResizeObserver | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let observedWidth = 0;
let renderedScoreRange = "";
let learningXml = "";
let parsedLearningScore: ParsedLearningScore | undefined;
/**
 * Разбор одного такта стоит проход по всем предыдущим тактам: действующие ключ,
 * знаки и размер накапливаются с начала партии. Без кеша окно из пяти тактов
 * платило эту цену пять раз на каждое нажатие «дальше» — на «Clocks» это
 * десятки миллисекунд на такт и заметная задержка листания.
 */
const learningCache = new Map<number, MeasureLearningData>();
const LEARNING_CACHE_LIMIT = 64;
let noteInteractionController: AbortController | undefined;
let activeNotehead: SVGElement | undefined;
let hoveredNotehead: SVGElement | undefined;
let focusedNotehead: SVGElement | undefined;
let noteTooltipByTarget = new Map<SVGElement, FingeringNoteTooltip>();
let originalNoteheadAttributes = new Map<SVGElement, OriginalNoteheadAttributes>();
let activeGuideTarget: SVGElement | undefined;
let hoveredGuideTarget: SVGElement | undefined;
let focusedGuideTarget: SVGElement | undefined;
let guideDetailByTarget = new Map<SVGElement, GuideDetail>();
let originalGuideAttributes = new Map<SVGElement, OriginalNoteheadAttributes>();

function updateLearningMeasure(): void {
  const xml = props.xml.trim();
  if (!xml) {
    windowMeasures.value = [];
    totalMeasures.value = 0;
    learningXml = "";
    parsedLearningScore = undefined;
    learningCache.clear();
    return;
  }
  try {
    if (!parsedLearningScore || learningXml !== xml) {
      parsedLearningScore = parseMusicXmlLearningScore(xml);
      learningXml = xml;
      learningCache.clear();
      totalMeasures.value = countMeasures(parsedLearningScore);
    }
    const { from, to } = measureWindowRange(
      currentMeasure.value,
      measureSpan.value,
      totalMeasures.value,
    );
    const measures: WindowMeasure[] = [];
    let offsetQuarters = 0;
    for (let index = from; index <= to; index += 1) {
      const data = learningForMeasure(index);
      measures.push({
        index,
        label: data.measureLabels[0] ?? String(index),
        data,
        offsetQuarters,
      });
      offsetQuarters += data.playback.quarters > 0
        ? data.playback.quarters
        : data.rhythm.actualQuarters;
    }
    windowMeasures.value = measures;
    activeMeasureIndex.value = measures.some(
      (measure) => measure.index === currentMeasure.value,
    )
      ? currentMeasure.value
      : measures[0]?.index ?? currentMeasure.value;
    syncTempoWithScore();
  } catch {
    // The OSMD score remains usable even when optional educational metadata
    // contains malformed vendor XML.
    windowMeasures.value = [];
  }
}

function selectActiveMeasure(index: number): void {
  if (index === activeMeasureIndex.value) return;
  const candidate = windowMeasures.value.find((measure) => measure.index === index);
  if (!candidate) return;
  stopPlayback();
  hideRhythmCellTooltip();
  activeMeasureIndex.value = candidate.index;
  syncTempoWithScore();
  schedulePaint(false);
}

/** Учебные данные такта с кешем: одно и то же окно не разбирается дважды. */
function learningForMeasure(index: number): MeasureLearningData {
  const cached = learningCache.get(index);
  if (cached) return cached;
  const data = measureLearningFromScore(
    parsedLearningScore as ParsedLearningScore,
    index,
  );
  if (learningCache.size >= LEARNING_CACHE_LIMIT) {
    // Порядок вставки в Map — порядок обращения: выбрасываем самый старый такт.
    const oldest = learningCache.keys().next();
    if (!oldest.done) learningCache.delete(oldest.value);
  }
  learningCache.set(index, data);
  return data;
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/i, "") || "Не удалось отрисовать этот такт.";
}

function setMeasureWindow(
  viewer: OpenSheetMusicDisplay,
  from: number,
  to: number = from,
): void {
  viewer.setOptions({
    drawFromMeasureNumber: from,
    drawUpToMeasureNumber: to,
    useXMLMeasureNumbers: false,
    drawFingerings: true,
  });

  // OSMD interprets the public options as 1-based indices, but additionally
  // shifts them when the score starts with an implicit pickup. The UI already
  // supplies an internal index, so pin the indices and disable that second shift.
  viewer.EngravingRules.MinMeasureToDrawIndex = from - 1;
  viewer.EngravingRules.MaxMeasureToDrawIndex = to - 1;
  viewer.EngravingRules.MinMeasureToDrawNumber = 0;
  viewer.EngravingRules.MaxMeasureToDrawNumber = 0;
  viewer.EngravingRules.RenderMultipleRestMeasures = false;
}

function restoreAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function clearActiveNotehead(): void {
  if (!activeNotehead) return;
  activeNotehead.classList.remove("is-active");
  restoreAttribute(
    activeNotehead,
    "aria-describedby",
    originalNoteheadAttributes.get(activeNotehead)?.ariaDescribedBy ?? null,
  );
  activeNotehead = undefined;
}

function hideNoteTooltip(): void {
  tooltipVersion += 1;
  clearActiveNotehead();
  tooltip.value = undefined;
}

function clearActiveGuideTarget(): void {
  if (!activeGuideTarget) return;
  activeGuideTarget.classList.remove("is-active");
  restoreAttribute(
    activeGuideTarget,
    "aria-describedby",
    originalGuideAttributes.get(activeGuideTarget)?.ariaDescribedBy ?? null,
  );
  activeGuideTarget = undefined;
}

function hideGuideTooltip(): void {
  guideTooltipVersion += 1;
  clearActiveGuideTarget();
  guideTooltip.value = undefined;
}

function positionNoteTooltip(target: SVGElement, version: number): void {
  if (
    disposed
    || version !== tooltipVersion
    || target !== activeNotehead
    || !tooltip.value
  ) return;
  const root = scoreRoot.value;
  const tip = tooltipElement.value;
  if (!root || !tip || !target.isConnected) return;

  const rootRect = root.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const gap = 10;
  const inset = 10;
  const maxLeft = Math.max(inset, rootRect.width - tip.offsetWidth - inset);
  const left = Math.min(
    Math.max(inset, targetRect.left - rootRect.left + targetRect.width / 2 - tip.offsetWidth / 2),
    maxLeft,
  );
  let top = targetRect.top - rootRect.top - tip.offsetHeight - gap;
  let placement: PositionedTooltip["placement"] = "above";

  if (top < inset) {
    top = targetRect.bottom - rootRect.top + gap;
    placement = "below";
  }
  top = Math.min(
    Math.max(inset, top),
    Math.max(inset, rootRect.height - tip.offsetHeight - inset),
  );
  tooltip.value = {
    ...tooltip.value,
    left,
    top,
    placement,
    positioned: true,
  };
}

function showNoteTooltip(
  target: SVGElement,
  noteTooltip: FingeringNoteTooltip,
): void {
  hideGuideTooltip();
  clearActiveNotehead();
  const version = ++tooltipVersion;
  activeNotehead = target;
  target.classList.add("is-active");
  target.setAttribute("aria-describedby", NOTE_TOOLTIP_ID);
  tooltip.value = {
    ...noteTooltip,
    left: 0,
    top: 0,
    placement: "above",
    positioned: false,
  };
  void nextTick(() => positionNoteTooltip(target, version));
}

function positionGuideTooltip(target: SVGElement, version: number): void {
  if (
    disposed
    || version !== guideTooltipVersion
    || target !== activeGuideTarget
    || !guideTooltip.value
  ) return;
  const root = scoreRoot.value;
  const tip = guideTooltipElement.value;
  if (!root || !tip || !target.isConnected) return;
  const rootRect = root.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const inset = 10;
  const gap = 10;
  const maxLeft = Math.max(inset, rootRect.width - tip.offsetWidth - inset);
  const left = Math.min(
    Math.max(inset, targetRect.left - rootRect.left + targetRect.width / 2 - tip.offsetWidth / 2),
    maxLeft,
  );
  let top = targetRect.top - rootRect.top - tip.offsetHeight - gap;
  let placement: PositionedGuideTooltip["placement"] = "above";
  if (top < inset) {
    top = targetRect.bottom - rootRect.top + gap;
    placement = "below";
  }
  top = Math.min(
    Math.max(inset, top),
    Math.max(inset, rootRect.height - tip.offsetHeight - inset),
  );
  guideTooltip.value = {
    ...guideTooltip.value,
    left,
    top,
    placement,
    positioned: true,
  };
}

function showGuideTooltip(target: SVGElement, detail: GuideDetail): void {
  hideNoteTooltip();
  clearActiveGuideTarget();
  const version = ++guideTooltipVersion;
  activeGuideTarget = target;
  target.classList.add("is-active");
  target.setAttribute("aria-describedby", GUIDE_TOOLTIP_ID);
  guideTooltip.value = {
    ...detail,
    left: 0,
    top: 0,
    placement: "above",
    positioned: false,
  };
  void nextTick(() => positionGuideTooltip(target, version));
}

function activateGuideTooltip(target: SVGElement | undefined): void {
  const detail = target ? guideDetailByTarget.get(target) : undefined;
  if (!target || !detail) {
    hideGuideTooltip();
    return;
  }
  showGuideTooltip(target, detail);
}

function activateNoteTooltip(target: SVGElement | undefined): void {
  const noteTooltip = target ? noteTooltipByTarget.get(target) : undefined;
  if (!target || !noteTooltip) {
    hideNoteTooltip();
    return;
  }
  showNoteTooltip(target, noteTooltip);
}

function teardownNoteInteractions(): void {
  tooltipVersion += 1;
  guideTooltipVersion += 1;
  clearPlayingHighlight();
  noteheadsByOnset = new Map();
  onsetElements = new Map();
  playheadPoints = [];
  playheadReady = false;
  playhead.value = undefined;
  noteInteractionController?.abort();
  noteInteractionController = undefined;
  clearActiveNotehead();
  clearActiveGuideTarget();
  tooltip.value = undefined;
  guideTooltip.value = undefined;
  hoveredNotehead = undefined;
  focusedNotehead = undefined;
  hoveredGuideTarget = undefined;
  focusedGuideTarget = undefined;

  for (const [target, original] of originalNoteheadAttributes) {
    restoreAttribute(target, "tabindex", original.tabIndex);
    restoreAttribute(target, "focusable", original.focusable);
    restoreAttribute(target, "role", original.role);
    restoreAttribute(target, "aria-label", original.ariaLabel);
    restoreAttribute(target, "aria-describedby", original.ariaDescribedBy);
    target.classList.toggle("fingering-note-hit", original.hadHitClass);
    target.classList.toggle("is-active", original.hadActiveClass);
  }
  for (const [target, original] of originalGuideAttributes) {
    restoreAttribute(target, "tabindex", original.tabIndex);
    restoreAttribute(target, "focusable", original.focusable);
    restoreAttribute(target, "role", original.role);
    restoreAttribute(target, "aria-label", original.ariaLabel);
    restoreAttribute(target, "aria-describedby", original.ariaDescribedBy);
    target.classList.toggle("fingering-symbol-hit", original.hadHitClass);
    target.classList.toggle("is-active", original.hadActiveClass);
  }
  originalNoteheadAttributes.clear();
  originalGuideAttributes.clear();
  noteTooltipByTarget.clear();
  guideDetailByTarget.clear();
}

function noteheadElement(
  graphicalNote: GraphicalNote,
  host: HTMLElement,
): SVGElement | undefined {
  const vexflowNote = graphicalNote as VexFlowGraphicalNote;
  // У паузы нет головки: целью становится вся её группа, иначе пауза
  // остаётся единственным музыкальным знаком без наведения и без озвучки.
  if (graphicalNote.sourceNote?.isRest()) {
    if (typeof vexflowNote.getSVGGElement !== "function") return undefined;
    const group = vexflowNote.getSVGGElement();
    return group instanceof SVGElement && host.contains(group) ? group : undefined;
  }
  if (typeof vexflowNote.getNoteheadSVGs !== "function") return undefined;
  const index = Number.isInteger(vexflowNote.vfnoteIndex)
    ? vexflowNote.vfnoteIndex
    : vexflowNote.vfnote?.[1];
  const noteheads = vexflowNote
    .getNoteheadSVGs()
    .filter((element): element is HTMLElement => Boolean(element));
  const target = pickNoteheadByIndex(noteheads, index);
  return target instanceof SVGElement && host.contains(target) ? target : undefined;
}

function fingeringInstruction(note: Note) {
  return note.Fingering
    ?? note.ParentVoiceEntry.TechnicalInstructions
      .find((instruction) => instruction.sourceNote === note && instruction.type === 0);
}

function fingeringValue(note: Note): string | undefined {
  return fingeringInstruction(note)?.value?.trim() || undefined;
}

function noteFacts(
  graphicalNote: GraphicalNote,
  graphicalMeasure: GraphicalMeasure,
  staffNumber: number,
  onsetQuarters?: number,
  beatLabel?: string,
  measureLabel?: string,
): FingeringNoteFacts | undefined {
  const note = graphicalNote.sourceNote;
  const pitch = note?.Pitch;
  const rest = Boolean(note?.isRest());
  if (!note || (!rest && !pitch)) return undefined;
  const length = note.Length;
  const tuplet = note.NoteTuplet;
  const fingering = fingeringInstruction(note);
  // Generated MusicXML writes placement from the hand selected by the model,
  // including the guarded cross-staff transfer. Fall back to staff semantics
  // for source notes without a fingering placement.
  const hand: FingeringHand | undefined = fingering?.placement === 0
    ? "right"
    : fingering?.placement === 1
      ? "left"
      : graphicalMeasure.isPianoRightHand()
        ? "right"
        : graphicalMeasure.isPianoLeftHand()
          ? "left"
          : undefined;
  const staffPosition: FingeringStaffPosition | undefined =
    graphicalMeasure.isUpperStaffOfInstrument()
      ? "upper"
      : graphicalMeasure.isLowerStaffOfInstrument()
        ? "lower"
        : undefined;
  const chordNotes = note.ParentVoiceEntry.Notes.filter((candidate) => !candidate.isRest());
  const xmlOctaveOffset = pitch
    ? (pitch.constructor as { OctaveXmlDifference?: number }).OctaveXmlDifference ?? 3
    : 0;

  const voiceId = note.ParentVoiceEntry.ParentVoice.VoiceId;
  const finger = rest ? undefined : fingeringValue(note);
  return {
    rest,
    onsetQuarters,
    beatLabel,
    measureLabel,
    step: pitch?.FundamentalNote ?? 0,
    octave: pitch ? pitch.Octave + xmlOctaveOffset : 0,
    accidental: pitch?.Accidental ?? 2,
    drawnAccidental: graphicalNote.DrawnAccidental,
    durationType: note.NoteTypeXml,
    durationNumerator: length.GetExpandedNumerator(),
    durationDenominator: length.Denominator,
    dots: note.DotsXml,
    fingers: [finger].filter((value): value is string => Boolean(value)),
    hand,
    staffNumber,
    staffPosition,
    voiceIds: [voiceId],
    tie: Boolean(note.NoteTie),
    tuplet: tuplet
      ? {
          actual: tuplet.TupletLabelNumber,
          normal: note.NormalNotes > 0 ? note.NormalNotes : undefined,
        }
      : undefined,
    chord: chordNotes.length > 1,
    grace: note.IsGraceNote,
    durationVariants: [{
      voiceId,
      durationType: note.NoteTypeXml,
      durationNumerator: length.GetExpandedNumerator(),
      durationDenominator: length.Denominator,
      dots: note.DotsXml,
      grace: note.IsGraceNote,
      finger,
    }],
  };
}

function notePitchKey(graphicalNote: GraphicalNote): string {
  const note = graphicalNote.sourceNote;
  if (Number.isFinite(note.halfTone)) return `halftone:${note.halfTone}`;
  const pitch = note.Pitch;
  return pitch
    ? `pitch:${pitch.FundamentalNote}:${pitch.Octave}:${pitch.Accidental}`
    : `note:${note.NoteAsString}`;
}

/** Позиция графической группы нот внутри такта в четвертях. */
function staffEntryOnset(staffEntry: { relInMeasureTimestamp?: { RealValue: number } }): number | undefined {
  const real = staffEntry.relInMeasureTimestamp?.RealValue;
  return Number.isFinite(real) ? Number(((real as number) * 4).toFixed(6)) : undefined;
}

function collectNoteTargets(
  viewer: OpenSheetMusicDisplay,
  host: HTMLElement,
): {
  targets: Map<SVGElement, FingeringNoteFacts[]>;
  byOnset: Map<string, SVGElement[]>;
  byPosition: Map<string, SVGElement[]>;
} {
  const targets = new Map<SVGElement, FingeringNoteFacts[]>();
  const byOnset = new Map<string, SVGElement[]>();
  const byPosition = new Map<string, SVGElement[]>();

  // Все показанные 1/3/5 тактов интерактивны. Временные ключи ниже сквозные,
  // поэтому активный такт и playhead не перепутаются с первым тактом окна.
  for (const windowMeasure of windowMeasures.value) {
    const graphicalMeasures =
      viewer.GraphicSheet?.MeasureList?.[windowMeasure.index - 1] ?? [];
    const cells = windowMeasure.data.rhythm.cells;

    graphicalMeasures.forEach((graphicalMeasure, staffIndex) => {
      if (!graphicalMeasure) return;
      for (const staffEntry of graphicalMeasure.staffEntries) {
        const local = staffEntryOnset(staffEntry);
        const global = local === undefined
          ? undefined
          : Number((windowMeasure.offsetQuarters + local).toFixed(6));
        const candidates: SharedUnisonCandidate<SVGElement, FingeringNoteFacts>[] = [];
        for (const voiceEntry of staffEntry.graphicalVoiceEntries) {
          for (const graphicalNote of voiceEntry.notes) {
            const facts = noteFacts(
              graphicalNote,
              graphicalMeasure,
              staffIndex + 1,
              local,
              local === undefined
                ? undefined
                : countSpanAt(
                    cells,
                    local,
                    Math.max(0, graphicalNote.sourceNote.Length.RealValue * 4),
                  ),
              windowMeasure.label,
            );
            if (!facts) continue;
            const note = graphicalNote.sourceNote;
            const printObject = note.PrintObject !== false;
            const target = noteheadElement(graphicalNote, host);
            if (target && global !== undefined) {
              const key = global.toFixed(3);
              // Подсветка звучащего — только для нот; геометрия бегунка — по всем
              // знакам, включая паузы, иначе линия «проскакивает» тишину.
              if (!facts.rest) {
                const bucket = byOnset.get(key);
                if (bucket) {
                  if (!bucket.includes(target)) bucket.push(target);
                } else byOnset.set(key, [target]);
              }
              const positioned = byPosition.get(key);
              if (positioned) {
                if (!positioned.includes(target)) positioned.push(target);
              } else byPosition.set(key, [target]);
            }
            candidates.push({
              target,
              pitchKey: notePitchKey(graphicalNote),
              printObject,
              sharesVisibleUnison:
                !printObject && note.sharesNoteheadWithVisibleUnisonNote(),
              facts,
            });
          }
        }
        for (const [target, groupedFacts] of groupSharedUnisonTargets(candidates)) {
          const existing = targets.get(target);
          if (existing) existing.push(...groupedFacts);
          else targets.set(target, groupedFacts);
        }
      }
    });
  }

  return { targets, byOnset, byPosition };
}

function bindNoteInteractions(
  viewer: OpenSheetMusicDisplay,
  host: HTMLElement,
): void {
  teardownNoteInteractions();
  const { targets, byOnset, byPosition } = collectNoteTargets(viewer, host);
  noteheadsByOnset = byOnset;
  onsetElements = byPosition;
  buildPlayheadGeometry(host);

  const controller = new AbortController();
  noteInteractionController = controller;
  const orderedTargets = [...targets.keys()];
  const setRovingTarget = (active: SVGElement) => {
    for (const candidate of orderedTargets) {
      candidate.setAttribute("tabindex", candidate === active ? "0" : "-1");
    }
  };

  for (const [targetIndex, [target, targetFacts]] of [...targets.entries()].entries()) {
    const facts = mergeFingeringNoteFacts(targetFacts);
    if (!facts) continue;
    const noteTooltip = buildFingeringNoteTooltip(facts);
    noteTooltipByTarget.set(target, noteTooltip);
    originalNoteheadAttributes.set(target, {
      tabIndex: target.getAttribute("tabindex"),
      focusable: target.getAttribute("focusable"),
      role: target.getAttribute("role"),
      ariaLabel: target.getAttribute("aria-label"),
      ariaDescribedBy: target.getAttribute("aria-describedby"),
      hadHitClass: target.classList.contains("fingering-note-hit"),
      hadActiveClass: target.classList.contains("is-active"),
    });
    target.classList.add("fingering-note-hit");
    target.setAttribute("tabindex", targetIndex === 0 ? "0" : "-1");
    target.setAttribute("focusable", "true");
    target.setAttribute("role", "img");
    target.setAttribute("aria-label", noteTooltip.ariaLabel);

    target.addEventListener("pointerenter", () => {
      hoveredNotehead = target;
      showNoteTooltip(target, noteTooltip);
    }, { signal: controller.signal });
    target.addEventListener("pointerleave", () => {
      if (hoveredNotehead === target) hoveredNotehead = undefined;
      activateNoteTooltip(focusedNotehead ?? hoveredNotehead);
    }, { signal: controller.signal });
    target.addEventListener("focus", () => {
      setRovingTarget(target);
      focusedNotehead = target;
      showNoteTooltip(target, noteTooltip);
    }, { signal: controller.signal });
    target.addEventListener("blur", () => {
      if (focusedNotehead === target) focusedNotehead = undefined;
      activateNoteTooltip(hoveredNotehead);
    }, { signal: controller.signal });
    target.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hoveredNotehead = undefined;
        focusedNotehead = undefined;
        hideNoteTooltip();
        (target as SVGElement & { blur?: () => void }).blur?.();
        return;
      }
      const currentIndex = orderedTargets.indexOf(target);
      const destination =
        event.key === "Home"
          ? orderedTargets[0]
          : event.key === "End"
            ? orderedTargets.at(-1)
            : event.key === "ArrowRight" || event.key === "ArrowDown"
              ? orderedTargets[(currentIndex + 1) % orderedTargets.length]
              : event.key === "ArrowLeft" || event.key === "ArrowUp"
                ? orderedTargets[(currentIndex - 1 + orderedTargets.length) % orderedTargets.length]
                : undefined;
      if (!destination) return;
      event.preventDefault();
      setRovingTarget(destination);
      destination.focus();
    }, { signal: controller.signal });
  }

  const reposition = () => {
    if (activeNotehead) positionNoteTooltip(activeNotehead, tooltipVersion);
    if (activeGuideTarget) positionGuideTooltip(activeGuideTarget, guideTooltipVersion);
  };
  host.addEventListener("scroll", reposition, {
    signal: controller.signal,
    passive: true,
  });
  window.addEventListener("resize", reposition, {
    signal: controller.signal,
    passive: true,
  });
}

function bindGlyphInteractions(
  host: HTMLElement,
  learning: MeasureLearningData | undefined,
): void {
  const controller = noteInteractionController;
  if (!controller || !learning) return;
  const groups: Array<{
    selector: string;
    details: GuideDetail[];
  }> = [
    { selector: ".vf-clef", details: learning.glyphDetails.clef },
    { selector: ".vf-keysignature", details: learning.glyphDetails.key },
    { selector: ".vf-timesignature", details: learning.glyphDetails.time },
  ];

  for (const group of groups) {
    if (!group.details.length) continue;
    const targets = Array.from(host.querySelectorAll<SVGElement>(group.selector));
    targets.forEach((target, index) => {
      const detail = group.details[index] ?? group.details.at(-1);
      if (!detail) return;
      guideDetailByTarget.set(target, detail);
      originalGuideAttributes.set(target, {
        tabIndex: target.getAttribute("tabindex"),
        focusable: target.getAttribute("focusable"),
        role: target.getAttribute("role"),
        ariaLabel: target.getAttribute("aria-label"),
        ariaDescribedBy: target.getAttribute("aria-describedby"),
        hadHitClass: target.classList.contains("fingering-symbol-hit"),
        hadActiveClass: target.classList.contains("is-active"),
      });
      target.classList.add("fingering-symbol-hit");
      target.setAttribute("tabindex", "0");
      target.setAttribute("focusable", "true");
      target.setAttribute("role", "img");
      target.setAttribute("aria-label", detail.ariaLabel);

      target.addEventListener("pointerenter", () => {
        hoveredGuideTarget = target;
        showGuideTooltip(target, detail);
      }, { signal: controller.signal });
      target.addEventListener("pointerleave", () => {
        if (hoveredGuideTarget === target) hoveredGuideTarget = undefined;
        activateGuideTooltip(focusedGuideTarget ?? hoveredGuideTarget);
      }, { signal: controller.signal });
      target.addEventListener("focus", () => {
        focusedGuideTarget = target;
        showGuideTooltip(target, detail);
      }, { signal: controller.signal });
      target.addEventListener("blur", () => {
        if (focusedGuideTarget === target) focusedGuideTarget = undefined;
        activateGuideTooltip(hoveredGuideTarget);
      }, { signal: controller.signal });
      target.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        hoveredGuideTarget = undefined;
        focusedGuideTarget = undefined;
        hideGuideTooltip();
        (target as SVGElement & { blur?: () => void }).blur?.();
      }, { signal: controller.signal });
    });
  }
}

async function paint(version: number): Promise<void> {
  if (disposed || version !== requestVersion) return;
  const host = surface.value;
  const xml = props.xml.trim();
  if (!host || !xml) {
    teardownNoteInteractions();
    state.value = "empty";
    osmd?.clear();
    loadedXml = "";
    renderedScoreRange = "";
    return;
  }

  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (disposed || version !== requestVersion) return;
  if (host.clientWidth < 80) return;

  try {
    const range = scoreRange.value;
    const rangeKey = `${range.from}:${range.to}`;
    const resetScoreViewport = loadedXml !== xml || renderedScoreRange !== rangeKey;
    if (!osmd) {
      const { OpenSheetMusicDisplay: Viewer } = await import("opensheetmusicdisplay");
      if (disposed || version !== requestVersion) return;
      osmd = new Viewer(host, {
        backend: "svg",
        autoResize: false,
        drawingParameters: "compacttight",
        pageFormat: "Endless",
        drawCredits: false,
        drawTitle: false,
        drawSubtitle: false,
        drawComposer: false,
        drawLyricist: false,
        drawLyrics: false,
        drawPartNames: false,
        drawPartAbbreviations: false,
        drawMeasureNumbers: false,
        drawMetronomeMarks: false,
        drawFingerings: true,
        fingeringPosition: "auto",
        useXMLMeasureNumbers: false,
        drawFromMeasureNumber: range.from,
        drawUpToMeasureNumber: range.to,
        alignRests: 2,
        stretchLastSystemLine: true,
      });
    }

    setMeasureWindow(osmd, range.from, range.to);
    if (loadedXml !== xml) {
      await osmd.load(xml);
      if (disposed || version !== requestVersion) return;
      loadedXml = xml;
      totalMeasures.value = osmd.Sheet?.SourceMeasures?.length ?? totalMeasures.value;
      updateLearningMeasure();
    }

    setMeasureWindow(osmd, scoreRange.value.from, scoreRange.value.to);
    teardownNoteInteractions();
    osmd.render();
    if (disposed || version !== requestVersion) return;
    if (resetScoreViewport) {
      // При переходе с 1 на 3/5 тактов браузер сохранял scrollLeft старого SVG,
      // из-за чего новый лист начинался за левой границей контейнера.
      host.scrollLeft = 0;
      host.scrollTop = 0;
    }
    renderedScoreRange = rangeKey;

    const svg = host.querySelector("svg");
    svg?.setAttribute("role", "group");
    svg?.setAttribute(
      "aria-label",
      range.from === range.to
        ? `Нотная запись такта ${range.from} с аппликатурой`
        : `Нотная запись тактов ${range.from}–${range.to} с аппликатурой`,
    );
    bindNoteInteractions(osmd, host);
    bindGlyphInteractions(host, learningMeasure.value);
    state.value = "ready";
    errorMessage.value = "";
  } catch (error) {
    if (disposed || version !== requestVersion) return;
    teardownNoteInteractions();
    state.value = "error";
    errorMessage.value = friendlyError(error);
  }
}

function schedulePaint(showLoading = true): void {
  const version = ++requestVersion;
  teardownNoteInteractions();
  if (showLoading && props.xml.trim()) state.value = "loading";
  work = work
    .catch(() => undefined)
    .then(() => paint(version));
}

/** Уход со вкладки не должен оставлять звук играть в фоне. */
function onVisibilityChange(): void {
  if (document.hidden) stopPlayback();
}

onMounted(() => {
  updateLearningMeasure();
  document.addEventListener("visibilitychange", onVisibilityChange);
  resizeObserver = new ResizeObserver((entries) => {
    const width = entries.at(-1)?.contentRect.width ?? 0;
    if (width <= 0 || Math.abs(width - observedWidth) < 1) return;
    observedWidth = width;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => schedulePaint(false), 100);
  });
  if (surface.value) resizeObserver.observe(surface.value);
  schedulePaint();
});

watch(
  () => [props.xml, props.measureNumber, props.measureSpan] as const,
  () => {
    // Новый такт — новый материал: звук прошлого такта обязан замолчать.
    stopPlayback();
    updateLearningMeasure();
    schedulePaint();
  },
);

onBeforeUnmount(() => {
  disposed = true;
  requestVersion += 1;
  stopPlayback();
  player.dispose();
  document.removeEventListener("visibilitychange", onVisibilityChange);
  teardownNoteInteractions();
  resizeObserver?.disconnect();
  if (resizeTimer) clearTimeout(resizeTimer);
  osmd?.clear();
  osmd = undefined;
});
</script>

<template>
  <section
    ref="scoreRoot"
    class="fingering-score"
    :class="`is-${state}`"
    :aria-busy="state === 'loading'"
    aria-live="polite"
  >
    <div v-if="state === 'loading'" class="fingering-score-loading" role="status">
      <span class="score-skeleton is-short" />
      <span class="score-skeleton" />
      <span class="score-skeleton" />
      <span class="sr-only">Готовлю нотную запись такта…</span>
    </div>
    <div
      ref="surface"
      class="fingering-score-surface"
      data-testid="fingering-osmd"
    />
    <!-- Бегунок счёта: ученик видит, где именно он находится по нотам. -->
    <div
      v-if="playhead"
      class="score-playhead"
      data-testid="score-playhead"
      aria-hidden="true"
      :style="{
        left: `${playhead.x}px`,
        top: `${playhead.top}px`,
        height: `${playhead.height}px`,
      }"
    >
      <span v-if="playheadCountLabel">{{ playheadCountLabel }}</span>
    </div>
    <Teleport to="body">
      <div
        v-if="rhythmCellTooltip"
        ref="rhythmTooltipElement"
        class="rhythm-cell-tooltip"
        :class="`is-${rhythmCellTooltip.placement}`"
        :style="{
          left: `${rhythmCellTooltip.left}px`,
          top: `${rhythmCellTooltip.top}px`,
        }"
        role="tooltip"
      >
        <span class="rhythm-tooltip-heading">
          <strong>{{ rhythmCellTooltip.count }}</strong>
          <small>{{ rhythmCellTooltip.hand }}</small>
        </span>
        <p>{{ rhythmCellTooltip.action }}</p>
        <ul v-if="rhythmCellTooltip.facts.length">
          <li v-for="fact in rhythmCellTooltip.facts" :key="fact">{{ fact }}</li>
        </ul>
      </div>
    </Teleport>
    <aside
      v-if="state === 'ready' && learningMeasure"
      class="measure-learning"
      aria-label="Учебный помощник выбранного такта"
    >
      <div
        v-if="attributeCards.length"
        class="measure-attributes"
        aria-label="Активные ключ, знаки и размер"
      >
        <div
          v-for="card in attributeCards"
          :key="card.id"
          class="measure-attribute-card"
          tabindex="0"
          :aria-label="`${card.role}: ${card.title}. ${card.detail}`"
        >
          <span>
            {{ card.role }}
            <i v-if="card.scope">· {{ card.scope }}</i>
          </span>
          <strong>{{ card.title }}</strong>
          <small>{{ card.detail }}</small>
        </div>
      </div>

      <section class="rhythm-guide" aria-label="Счёт такта и проигрывание">
        <header class="rhythm-head">
          <div class="rhythm-title">
            <span>Счёт такта</span>
            <strong>{{ learningMeasure.rhythm.meter || "размер не указан" }}</strong>
            <small>доля — {{ learningMeasure.rhythm.pulse }}</small>
          </div>
          <span v-if="learningMeasure.rhythm.pickup" class="rhythm-pickup">затакт</span>
        </header>

        <div v-if="canPlay" class="rhythm-transport">
          <button
            type="button"
            class="rhythm-play"
            :class="{ 'is-playing': playing }"
            :aria-label="audioLoading ? 'Загружаю Grand Piano' : playing ? 'Остановить' : 'Проиграть под метроном'"
            :disabled="audioLoading"
            @click="togglePlayback"
          >
            <span class="rhythm-play-glyph" aria-hidden="true">{{ audioLoading ? "…" : playing ? "■" : "▶" }}</span>
            <span>{{ audioLoading ? "Grand Piano" : playing ? (countInPulse ? `И ${countInPulse}` : "Стоп") : "Играть" }}</span>
          </button>

          <div class="rhythm-switches" role="group" aria-label="Режим проигрывания">
            <button
              type="button"
              class="rhythm-switch"
              :class="{ 'is-on': looping }"
              :aria-pressed="looping"
              aria-label="Повторять по кругу"
              @click="toggleLoop"
            >
              <span class="rhythm-switch-glyph" aria-hidden="true">↻</span>
              <span class="rhythm-switch-label">Повтор</span>
            </button>
            <button
              type="button"
              class="rhythm-switch"
              :class="{ 'is-on': metronome }"
              :aria-pressed="metronome"
              aria-label="Клик метронома"
              @click="toggleMetronome"
            >
              <span class="rhythm-switch-glyph" aria-hidden="true">♩</span>
              <span class="rhythm-switch-label">Метроном</span>
            </button>
          </div>

          <div class="rhythm-tempo" :title="`${tempo} удара в минуту · ${tempoHint}`">
            <button
              type="button"
              aria-label="Темп медленнее"
              :disabled="tempo <= TEMPO_RANGE.min"
              @click="setTempo(tempo - TEMPO_RANGE.step)"
            >
              −
            </button>
            <b>{{ tempo }}</b>
            <button
              type="button"
              aria-label="Темп быстрее"
              :disabled="tempo >= TEMPO_RANGE.max"
              @click="setTempo(tempo + TEMPO_RANGE.step)"
            >
              +
            </button>
          </div>
          <span class="rhythm-tempo-hint">{{ tempoHint }}</span>
          <span class="sr-only" role="status" aria-live="polite">{{ transportLabel }}</span>
        </div>
        <p v-if="audioError" class="rhythm-audio-error" role="alert">
          {{ audioError }}
        </p>

        <div
          v-if="rhythmActionHints.length"
          class="rhythm-action-key"
          aria-label="Как читать схему такта"
        >
          <span
            v-for="hint in rhythmActionHints"
            :key="hint.kind"
            :class="`is-${hint.kind}`"
          >
            <b>{{ hint.mark }}</b>
            {{ hint.text }}
          </span>
        </div>

        <nav
          v-if="rhythmRows.length > 1"
          ref="rhythmOverview"
          class="rhythm-overview"
          aria-label="Выбрать такт для подробного разбора"
        >
          <button
            v-for="row in rhythmRows"
            :key="`overview-${row.index}`"
            type="button"
            class="rhythm-overview-item"
            :data-measure-index="row.index"
            :class="{ 'is-active': row.index === activeMeasureIndex }"
            :aria-pressed="row.index === activeMeasureIndex"
            :aria-current="row.index === activeMeasureIndex ? 'step' : undefined"
            @click="selectActiveMeasure(row.index)"
          >
            <span class="rhythm-overview-title">
              <small>Такт</small>
              <b>{{ row.label }}</b>
              <i>{{ row.rhythm.subdivisions }} поз. на долю</i>
            </span>
            <span
              v-for="hand in rhythmHands"
              :key="`${row.index}-${hand}`"
              class="rhythm-overview-lane"
              :class="[`is-${hand}`, { 'is-muted': !playbackHands[hand] }]"
              :style="{ '--rhythm-cell-total': String(Math.max(1, row.cells.length)) }"
              aria-hidden="true"
            >
              <i
                v-for="item in row.cells"
                :key="`${hand}-${item.globalQuarters}`"
                :class="`is-${item.cell.handStates[hand].kind}`"
              />
            </span>
            <span v-if="row.warnings" class="rhythm-overview-warning">
              {{ row.warnings }} {{ row.warnings === 1 ? "подсказка" : "подсказки" }}
            </span>
          </button>
        </nav>

        <section
          v-if="rhythmRows.length"
          class="rhythm-detail"
          aria-label="Подробный счёт выбранных тактов"
        >
          <header class="rhythm-detail-head">
            <span>
              <small>Подробный разбор</small>
              <strong>
                Такт {{ detailedRhythmRows[0]?.label }}
              </strong>
            </span>
            <p>
              Говори слоги слева направо ровно. Точка — нажми клавишу,
              линия — продолжай держать.
            </p>
          </header>

          <div class="rhythm-detail-measures">
            <section
              v-for="row in detailedRhythmRows"
              :key="`detail-${row.index}`"
              class="rhythm-measure-detail"
              :aria-label="`Счёт такта ${row.label}: ${row.rhythm.spoken}`"
            >
              <header class="rhythm-measure-detail-title">
                <small>Такт</small>
                <strong>{{ row.label }}</strong>
              </header>
              <div class="rhythm-detail-grid" :class="{ 'is-live': playing }">
                <div class="rhythm-detail-labels">
                  <span aria-hidden="true"><b>Скажи</b><small>вслух ровно</small></span>
                  <button
                    v-for="hand in rhythmHands"
                    :key="`label-${row.index}-${hand}`"
                    type="button"
                    class="rhythm-hand-label-toggle"
                    :class="[`is-${hand}`, { 'is-off': !playbackHands[hand] }]"
                    :aria-pressed="playbackHands[hand]"
                    :aria-label="`${playbackHands[hand] ? 'Отключить' : 'Включить'} ${hand === 'right' ? 'правую' : 'левую'} руку в проигрывании`"
                    @click="togglePlaybackHand(hand)"
                  >
                    <i aria-hidden="true">{{ playbackHands[hand] ? "●" : "○" }}</i>
                    <span>
                      <b>{{ rhythmHandTitle(hand) }}</b>
                      <small>{{ hand === "right" ? "верхний стан" : "нижний стан" }}</small>
                    </span>
                  </button>
                </div>

                <div
                  class="rhythm-beat-columns"
                  :style="{ '--rhythm-beat-total': String(Math.max(1, row.beats.length)) }"
                >
                  <section
                    v-for="beat in row.beats"
                    :key="`${row.index}-${beat.pulse}`"
                    class="rhythm-beat-column"
                    :style="{ '--rhythm-subdivision-total': String(Math.max(1, beat.cells.length)) }"
                  >
                    <div class="rhythm-spoken-subgrid" aria-hidden="true">
                      <b
                        v-for="item in beat.cells"
                        :key="`spoken-${row.index}-${item.globalQuarters}`"
                        :class="{
                          'is-pulse': item.cell.pulseStart,
                          'is-active': playing
                            && windowCells[activeCellIndex]?.globalQuarters === item.globalQuarters,
                        }"
                      >
                        {{ item.cell.syllable }}
                      </b>
                    </div>

                    <div
                      v-for="hand in rhythmHands"
                      :key="`${row.index}-${beat.pulse}-${hand}`"
                      class="rhythm-hand-subgrid"
                      :class="[`is-${hand}`, { 'is-muted': !playbackHands[hand] }]"
                    >
                      <button
                        type="button"
                        class="rhythm-mobile-hand-label"
                        :class="{ 'is-off': !playbackHands[hand] }"
                        :aria-pressed="playbackHands[hand]"
                        :aria-label="`${playbackHands[hand] ? 'Отключить' : 'Включить'} ${hand === 'right' ? 'правую' : 'левую'} руку в проигрывании`"
                        @click="togglePlaybackHand(hand)"
                      >
                        {{ rhythmHandTitle(hand) }}
                      </button>
                      <span
                        v-for="item in beat.cells"
                        :key="`${row.index}-${hand}-${item.globalQuarters}`"
                        class="rhythm-hand-cell"
                        :class="[
                          `is-${item.cell.handStates[hand].kind}`,
                          {
                            'continues-from': item.cell.handStates[hand].continuesFrom,
                            'continues-after': item.cell.handStates[hand].continuesAfter,
                            'has-held-notes': item.cell.handStates[hand].heldNotes > 0,
                            'is-staccato': item.cell.handStates[hand].staccatoAttacks > 0,
                            'has-rest-start': item.cell.handStates[hand].restStarts > 0,
                            'is-crowded': item.cell.handStates[hand].attackOnsets > 1,
                            'is-active': playing
                              && windowCells[activeCellIndex]?.globalQuarters === item.globalQuarters,
                          },
                        ]"
                        :aria-label="handCellAriaLabel(item.cell, hand)"
                        :tabindex="playbackHands[hand] ? 0 : -1"
                        @mouseenter="showRhythmCellTooltip($event, item.cell, hand)"
                        @mouseleave="hideRhythmCellTooltip"
                        @focus="showRhythmCellTooltip($event, item.cell, hand)"
                        @blur="hideRhythmCellTooltip"
                        @click="showRhythmCellTooltip($event, item.cell, hand)"
                      >
                        <i class="rhythm-cell-mark" aria-hidden="true">
                          {{ rhythmHandMark(item.cell.handStates[hand]) }}
                        </i>
                        <em
                          v-if="
                            item.cell.handStates[hand].attackOnsets > 1
                            || item.cell.handStates[hand].attackNotes > 1
                          "
                          class="rhythm-cell-count"
                          :class="{
                            'is-sequence': item.cell.handStates[hand].attackOnsets > 1,
                          }"
                          aria-hidden="true"
                        >
                          {{
                            item.cell.handStates[hand].attackOnsets > 1
                              ? `${item.cell.handStates[hand].attackOnsets} атаки`
                              : `аккорд · ${item.cell.handStates[hand].attackNotes}`
                          }}
                        </em>
                      </span>
                    </div>
                  </section>
                </div>
              </div>
            </section>
          </div>
        </section>

        <ul v-if="rhythmCoachNotes.length" class="rhythm-coach-notes">
          <li
            v-for="note in rhythmCoachNotes"
            :key="note.id"
            :class="`is-${note.kind}`"
          >
            <b>{{ note.label }}</b>
            <span>{{ note.text }}</span>
          </li>
        </ul>

        <p v-if="!canPlay && playbackSupported" class="rhythm-explanation">
          Здесь нечего проигрывать: в показанных тактах нет ни одной звучащей позиции.
        </p>
        <p v-else-if="!playbackSupported" class="rhythm-explanation">
          Браузер не даёт воспроизводить звук, поэтому доступен только письменный счёт.
        </p>
      </section>

      <details v-if="symbolGroups.length" class="measure-symbols">
        <summary>
          <span>Что ещё написано в этом такте</span>
          <strong>{{ learningNotationSymbols.length }} знаков</strong>
        </summary>
        <div class="measure-symbol-groups">
          <section
            v-for="group in symbolGroups"
            :key="group.title"
            class="measure-symbol-group"
          >
            <h4>{{ group.title }}</h4>
            <div class="measure-symbol-list">
              <span
                v-for="symbol in group.symbols"
                :key="symbol.id"
                class="measure-symbol-chip"
                :class="{ 'is-unknown': symbol.unknown }"
                tabindex="0"
                :aria-label="`${symbol.label}. ${symbol.detail}${symbol.count > 1 ? `. Встречается ${symbol.count} раз.` : ''}`"
              >
                <b class="measure-symbol-name">{{ symbol.label }}</b>
                <i v-if="symbol.count > 1" class="measure-symbol-count">×{{ symbol.count }}</i>
                <small>{{ symbol.detail }}</small>
              </span>
            </div>
          </section>
        </div>
      </details>
    </aside>
    <div
      v-if="tooltip"
      :id="NOTE_TOOLTIP_ID"
      ref="tooltipElement"
      class="fingering-note-tooltip"
      :class="[
        `is-${tooltip.placement}`,
        { 'is-positioned': tooltip.positioned },
      ]"
      :style="{
        left: `${tooltip.left}px`,
        top: `${tooltip.top}px`,
      }"
      role="tooltip"
      aria-live="off"
    >
      <div class="fingering-note-tooltip-heading">
        <strong>{{ tooltip.pitch }}</strong>
        <span>{{ tooltip.duration }}</span>
      </div>
      <dl>
        <div v-if="tooltip.beat" class="fingering-note-tooltip-count">
          <dt>Счёт</dt>
          <dd>«{{ tooltip.beat }}»</dd>
        </div>
        <div v-if="tooltip.finger">
          <dt>{{ tooltip.fingerLabel }}</dt>
          <dd>{{ tooltip.finger }}</dd>
        </div>
        <div>
          <dt>Рука</dt>
          <dd>{{ tooltip.handAndStaff }}</dd>
        </div>
        <div v-if="tooltip.showVoice">
          <dt>Линия</dt>
          <dd>{{ tooltip.voice }}</dd>
        </div>
      </dl>
      <p v-if="tooltip.rest" class="fingering-note-tooltip-voice">
        Пауза — это тоже время: звука нет, а счёт продолжается.
      </p>
      <p v-else-if="tooltip.showVoice" class="fingering-note-tooltip-voice">
        Мелодическая линия — независимый ритмический слой на стане.
      </p>
      <div v-if="tooltip.context.length" class="fingering-note-tooltip-context">
        <span v-for="item in tooltip.context" :key="item">{{ item }}</span>
      </div>
    </div>
    <div
      v-if="guideTooltip"
      :id="GUIDE_TOOLTIP_ID"
      ref="guideTooltipElement"
      class="score-guide-tooltip"
      :class="[
        `is-${guideTooltip.placement}`,
        { 'is-positioned': guideTooltip.positioned },
      ]"
      :style="{
        left: `${guideTooltip.left}px`,
        top: `${guideTooltip.top}px`,
      }"
      role="tooltip"
      aria-live="off"
    >
      <strong>{{ guideTooltip.title }}</strong>
      <span>{{ guideTooltip.summary }}</span>
      <p v-for="line in guideTooltip.lines" :key="line">{{ line }}</p>
    </div>
    <div v-if="state === 'empty'" class="fingering-score-empty">
      Выберите такт, чтобы увидеть оригинальную нотную запись.
    </div>
    <div v-else-if="state === 'error'" class="fingering-score-error" role="alert">
      <strong>Нотный стан не отрисован</strong>
      <span>{{ errorMessage }}</span>
      <button type="button" @click="schedulePaint()">Повторить</button>
    </div>
  </section>
</template>

<style scoped>
.fingering-score {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 240px;
  overflow: visible;
  border: 1px solid var(--tbl-line-soft);
  border-radius: 16px;
  background:
    radial-gradient(circle at 50% -24%, rgba(87, 132, 255, 0.07), transparent 42%),
    rgba(255, 255, 255, 0.9);
}

.fingering-score-surface {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  max-height: 460px;
  overflow: auto;
  padding: 12px 16px 4px;
  scrollbar-width: thin;
  transition: opacity 160ms ease;
}

.is-loading .fingering-score-surface {
  opacity: 0;
}

.fingering-score-surface :deep(svg) {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
}

.fingering-score-surface :deep(.fingering-note-hit),
.fingering-score-surface :deep(.fingering-symbol-hit) {
  cursor: help;
  outline: none;
  transition: filter 120ms ease;
}

.fingering-score-surface :deep(.fingering-note-hit.is-active),
.fingering-score-surface :deep(.fingering-symbol-hit.is-active) {
  filter:
    drop-shadow(0 0 1px rgba(255, 255, 255, 0.98))
    drop-shadow(0 0 3px rgba(21, 87, 255, 0.94))
    drop-shadow(0 0 7px rgba(21, 87, 255, 0.4));
}

.fingering-note-tooltip {
  position: absolute;
  z-index: 4;
  width: max-content;
  max-width: min(292px, calc(100% - 20px));
  padding: 12px 14px;
  border: 1px solid rgba(72, 111, 192, 0.24);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow:
    0 18px 40px rgba(41, 66, 119, 0.16),
    0 3px 10px rgba(41, 66, 119, 0.1);
  color: #182c53;
  opacity: 0;
  pointer-events: none;
  overflow-wrap: anywhere;
  transform: translateY(2px);
  transition: opacity 100ms ease, transform 100ms ease;
}

.fingering-note-tooltip.is-positioned {
  opacity: 1;
  transform: translateY(0);
}

.fingering-note-tooltip::after {
  position: absolute;
  left: 50%;
  width: 9px;
  height: 9px;
  border-right: 1px solid rgba(72, 111, 192, 0.24);
  border-bottom: 1px solid rgba(72, 111, 192, 0.24);
  background: rgba(255, 255, 255, 0.98);
  content: "";
}

.fingering-note-tooltip.is-above::after {
  bottom: -5px;
  transform: translateX(-50%) rotate(45deg);
}

.fingering-note-tooltip.is-below::after {
  top: -5px;
  transform: translateX(-50%) rotate(225deg);
}

.fingering-note-tooltip-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(77, 105, 166, 0.13);
}

.fingering-note-tooltip-heading strong {
  color: #102754;
  font: 700 var(--text-section)/1 var(--display);
  letter-spacing: -0.01em;
}

.fingering-note-tooltip-heading span {
  color: #6f80a4;
  text-align: right;
  font: 600 var(--text-caption)/1.35 var(--mono);
}

.fingering-note-tooltip dl {
  display: grid;
  gap: 5px;
  margin: 9px 0 0;
}

.fingering-note-tooltip dl > div {
  display: grid;
  grid-template-columns: minmax(72px, auto) minmax(0, 1fr);
  align-items: baseline;
  gap: 12px;
}

.fingering-note-tooltip dl > .fingering-note-tooltip-count {
  grid-template-columns: 1fr;
  gap: 4px;
}

.fingering-note-tooltip-count dd {
  text-align: left;
  line-height: 1.55;
}

.fingering-note-tooltip dt {
  color: #8a99b7;
  font: 600 var(--text-caption)/1.35 var(--mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.fingering-note-tooltip dd {
  min-width: 0;
  margin: 0;
  color: #183264;
  text-align: right;
  font: 650 var(--text-caption)/1.4 var(--mono);
}

.fingering-note-tooltip-context {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 9px;
}

.fingering-note-tooltip-context span {
  padding: 3px 6px;
  border: 1px solid rgba(70, 108, 190, 0.15);
  border-radius: 999px;
  background: rgba(72, 116, 215, 0.07);
  color: #49669f;
  font: 650 var(--text-caption)/1 var(--mono);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.fingering-note-tooltip-voice {
  margin: 8px 0 0;
  color: #7a89a8;
  font: 500 var(--text-caption)/1.4 var(--mono);
}

.measure-learning {
  position: relative;
  display: grid;
  gap: 10px;
  min-width: 0;
  overflow: hidden;
  padding: 12px 16px 16px;
  border-top: 1px solid rgba(86, 119, 187, 0.12);
  background:
    linear-gradient(180deg, rgba(242, 247, 255, 0.38), rgba(255, 255, 255, 0.82));
}

.measure-attributes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr));
  gap: 8px;
}

.measure-attribute-card {
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid rgba(66, 105, 185, 0.14);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 5px 16px rgba(44, 73, 132, 0.045);
  outline: none;
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}

/* Наведение меняет только цвет и тень: любое изменение геометрии на тач-экране
   читается как скачок вёрстки, потому что hover там залипает после тапа. */
@media (hover: hover) and (pointer: fine) {
  .measure-attribute-card:hover {
    border-color: rgba(34, 91, 210, 0.42);
    box-shadow: 0 8px 22px rgba(37, 78, 160, 0.1);
  }
}

.measure-attribute-card:focus-visible {
  border-color: rgba(34, 91, 210, 0.42);
  box-shadow: 0 8px 22px rgba(37, 78, 160, 0.1);
}

.measure-attribute-card > span {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  color: #8796b4;
  font: 650 var(--text-caption)/1.3 var(--mono);
  letter-spacing: 0.11em;
  text-transform: uppercase;
}

.measure-attribute-card > span i {
  color: #a3b0c8;
  font-style: normal;
  letter-spacing: 0.06em;
}

.measure-attribute-card strong {
  color: #163063;
  font: 700 var(--text-label)/1.35 var(--display);
}

.measure-attribute-card small {
  color: #6d7fa2;
  font: 500 var(--text-caption)/1.45 var(--mono);
}

.rhythm-guide {
  position: relative;
  min-width: 0;
  overflow: hidden;
  padding: 11px 12px;
  border: 1px solid rgba(64, 106, 194, 0.14);
  border-radius: 11px;
  background: rgba(247, 250, 255, 0.88);
}

.rhythm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.rhythm-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  min-width: 0;
}

.rhythm-title > span {
  color: #8795b1;
  font: 650 var(--text-caption)/1 var(--mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.rhythm-title strong {
  color: #163063;
  font: 700 var(--text-body)/1.1 var(--display);
}

.rhythm-title small {
  color: #8493b0;
  font: 500 var(--text-caption)/1 var(--mono);
}

.rhythm-pickup {
  flex: none;
  padding: 4px 7px;
  border: 1px solid rgba(214, 142, 54, 0.23);
  border-radius: 999px;
  background: rgba(250, 191, 89, 0.11);
  color: #916120;
  font: 700 var(--text-caption)/1 var(--mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.rhythm-coach-notes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.rhythm-coach-notes li {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid rgba(70, 107, 183, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.58);
}

.rhythm-coach-notes b {
  color: #345caa;
  font: 750 var(--text-caption)/1.2 var(--mono);
}

.rhythm-coach-notes span {
  color: #7182a2;
  font: 500 var(--text-caption)/1.45 var(--mono);
}

.rhythm-coach-notes .is-syncopation {
  border-color: rgba(187, 122, 34, 0.2);
  background: rgba(255, 247, 231, 0.7);
}

/* --- Транспорт: играть, цикл, метроном, темп --- */

.rhythm-transport {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.rhythm-play,
.rhythm-switch,
.rhythm-tempo {
  /* Фиксированная высота: на тач-экранах контрол не должен менять размер. */
  min-height: 34px;
  border: 1px solid rgba(31, 87, 209, 0.2);
  border-radius: 999px;
  background: #fff;
  font: 700 var(--text-caption)/1 var(--mono);
}

.rhythm-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 96px;
  padding: 0 14px;
  border-color: transparent;
  background: linear-gradient(180deg, #2f6ae0, #1f51bd);
  color: #fff;
  cursor: pointer;
  font-size: var(--text-caption);
  transition: background 120ms ease;
}

.rhythm-play.is-playing {
  background: linear-gradient(180deg, #d8562f, #b83f1d);
}

.rhythm-play:focus-visible,
.rhythm-switch:focus-visible,
.rhythm-tempo button:focus-visible {
  outline: 2px solid #2f6ae0;
  outline-offset: 2px;
}

.rhythm-play:active,
.rhythm-switch:active,
.rhythm-tempo button:not(:disabled):active {
  transform: scale(0.97);
}

.rhythm-play-glyph {
  font-size: var(--text-caption);
}

.rhythm-switches {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.rhythm-switch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 10px;
  color: #8593b0;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}

.rhythm-switch.is-on {
  border-color: rgba(31, 87, 209, 0.45);
  background: rgba(39, 94, 218, 0.1);
  color: #1d4aa8;
}

.rhythm-switch-glyph {
  font-size: var(--text-label);
}

.rhythm-switch-label {
  font: 700 var(--text-caption)/1 var(--mono);
}

@media (hover: hover) and (pointer: fine) {
  .rhythm-play:hover {
    background: linear-gradient(180deg, #3e77e8, #265dcf);
  }

  .rhythm-play.is-playing:hover {
    background: linear-gradient(180deg, #e06541, #c44926);
  }

  .rhythm-switch:hover {
    border-color: rgba(31, 87, 209, 0.36);
    background: rgba(39, 94, 218, 0.065);
    color: #315da9;
  }
}

.rhythm-tempo {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
}

.rhythm-tempo button {
  min-width: 26px;
  min-height: 26px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #4c6ba6;
  cursor: pointer;
  font: 700 var(--text-body)/1 var(--mono);
}

.rhythm-tempo button:disabled {
  opacity: 0.35;
  cursor: default;
}

.rhythm-tempo b {
  min-width: 30px;
  color: #163063;
  text-align: center;
  font: 800 var(--text-label)/1 var(--display);
  font-variant-numeric: tabular-nums;
}

.rhythm-tempo-hint {
  color: #93a1bd;
  font: 500 var(--text-caption)/1.2 var(--mono);
}

@media (hover: hover) and (pointer: fine) {
  .rhythm-tempo button:not(:disabled):hover {
    background: rgba(39, 94, 218, 0.1);
  }
}

.rhythm-action-key {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 12px;
  padding: 0 2px;
  color: #7283a3;
  font: 600 var(--text-caption)/1.25 var(--mono);
}

.rhythm-action-key span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.rhythm-action-key b {
  min-width: 18px;
  color: #2759ba;
  text-align: center;
  font: 800 var(--text-caption)/1 var(--mono);
}

.rhythm-action-key .is-rest b {
  color: #a76f22;
}

.rhythm-audio-error {
  margin: 10px 0 0;
  padding: 10px 12px;
  border: 1px solid rgba(181, 66, 48, 0.22);
  border-radius: 10px;
  background: rgba(255, 240, 237, 0.88);
  color: #9c3f31;
  font: 600 var(--text-label)/1.45 var(--ui);
}

/* --- Сетка счёта --- */

.rhythm-hand-cell {
  z-index: 1;
  min-height: 34px;
  color: #aab4c8;
}

/*
 * Временная ось читается буквально: точка — начало ноты, линия — её
 * длительность до следующей позиции счёта. Если в другой руке в это время
 * начинаются новые ноты, её собственная линия всё равно остаётся непрерывной.
 */
.rhythm-hand-cell.continues-from::before,
.rhythm-hand-cell.continues-after::before,
.rhythm-hand-cell.is-hold::before {
  position: absolute;
  z-index: -1;
  top: 50%;
  height: 2px;
  border-radius: 2px;
  background: currentColor;
  content: "";
}

.rhythm-hand-cell.continues-from::before {
  right: 50%;
  left: 0;
}

.rhythm-hand-cell.continues-after::before {
  right: 0;
  left: 50%;
}

.rhythm-hand-cell.continues-from.continues-after::before,
.rhythm-hand-cell.is-hold.continues-from.continues-after::before {
  right: 0;
  left: 0;
}

.rhythm-cell-mark {
  position: relative;
  z-index: 1;
  min-width: 14px;
  padding: 2px;
  border-radius: 999px;
  background: transparent;
  text-align: center;
  font-size: var(--text-caption);
  font-style: normal;
  line-height: 1;
}

.rhythm-hand-cell.is-attack .rhythm-cell-mark {
  background: #fbfcff;
  color: #1f51bd;
  font-size: var(--text-caption);
}

.rhythm-hand-cell.is-rest .rhythm-cell-mark {
  color: #b07a2c;
  font-size: var(--text-caption);
}

.rhythm-hand-cell.is-rest.has-rest-start .rhythm-cell-mark {
  background: #fbfcff;
}

.rhythm-hand-cell.is-rest::before {
  height: 1px;
  background:
    repeating-linear-gradient(90deg, #c18a3f 0 4px, transparent 4px 7px);
}

.rhythm-hand-cell.is-crowded {
  outline: 1px dashed rgba(176, 122, 44, 0.45);
  outline-offset: -3px;
}

.rhythm-hand-cell:focus {
  outline: none;
}

.rhythm-hand-cell:hover,
.rhythm-hand-cell:focus-visible {
  z-index: 30;
  background: rgba(234, 241, 255, 0.96);
  box-shadow: inset 0 0 0 1px rgba(31, 87, 209, 0.28);
}

.rhythm-cell-count {
  position: absolute;
  top: 1px;
  left: 50%;
  z-index: 2;
  min-width: 12px;
  padding: 1px 3px;
  border-radius: 999px;
  background: #fff5e4;
  color: #b07a2c;
  text-align: center;
  font: 800 var(--text-caption)/1 var(--mono);
  font-style: normal;
}

/* Окно 1/3/5 — навигация, а не пять ужатых учебных таблиц. */
.rhythm-overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 8px;
  min-width: 0;
  margin-top: 14px;
}

.rhythm-overview-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
  min-width: 0;
  min-height: 78px;
  padding: 10px 11px;
  overflow: hidden;
  border: 1px solid rgba(70, 107, 183, 0.14);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.68);
  color: #183d82;
  cursor: pointer;
  text-align: left;
  transition:
    border-color 160ms ease,
    background 160ms ease,
    box-shadow 160ms ease,
    color 160ms ease;
}

.rhythm-overview-item.is-active {
  border-color: rgba(31, 87, 209, 0.48);
  background: linear-gradient(145deg, rgba(231, 239, 255, 0.96), #fff);
  box-shadow: 0 8px 20px rgba(31, 75, 166, 0.1);
}

.rhythm-overview-item:focus-visible {
  outline: 2px solid #2762d8;
  outline-offset: 2px;
}

.rhythm-overview-title {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
}

.rhythm-overview-title small,
.rhythm-overview-title i,
.rhythm-overview-warning {
  font: 650 var(--text-caption)/1.2 var(--mono);
}

.rhythm-overview-title small {
  color: #8393b0;
  text-transform: uppercase;
}

.rhythm-overview-title b {
  font: 800 var(--text-section)/1 var(--display);
}

.rhythm-overview-title i {
  margin-left: auto;
  overflow: hidden;
  color: #8b9ab5;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: normal;
}

.rhythm-overview-lane {
  display: grid;
  grid-template-columns: repeat(var(--rhythm-cell-total, 16), minmax(0, 1fr));
  gap: 2px;
  min-width: 0;
  height: 5px;
}

.rhythm-overview-lane i {
  min-width: 0;
  border-radius: 999px;
  background: rgba(119, 139, 176, 0.16);
}

.rhythm-overview-lane.is-right i.is-attack {
  background: #2962cf;
}

.rhythm-overview-lane.is-left i.is-attack {
  background: #7185a6;
}

.rhythm-overview-lane i.is-hold {
  background: rgba(61, 97, 164, 0.38);
}

.rhythm-overview-lane i.is-rest {
  background: rgba(177, 124, 49, 0.34);
}

.rhythm-overview-lane.is-muted {
  opacity: 0.2;
  filter: grayscale(1);
}

.rhythm-overview-warning {
  color: #9b6d2a;
}

.rhythm-detail {
  min-width: 0;
  margin-top: 12px;
  padding: 14px;
  border: 1px solid rgba(70, 107, 183, 0.16);
  border-radius: 15px;
  background: linear-gradient(180deg, rgba(249, 251, 255, 0.98), rgba(255, 255, 255, 0.9));
}

.rhythm-detail-measures {
  display: grid;
  min-width: 0;
  gap: 16px;
  margin-top: 16px;
}

.rhythm-measure-detail {
  min-width: 0;
}

.rhythm-measure-detail + .rhythm-measure-detail {
  padding-top: 16px;
  border-top: 1px solid rgba(70, 107, 183, 0.14);
}

.rhythm-measure-detail-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.rhythm-measure-detail-title small {
  color: #8796b4;
  font: 700 var(--text-caption)/1 var(--mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.rhythm-measure-detail-title strong {
  color: #183f89;
  font: 800 var(--text-section)/1 var(--display);
}

.rhythm-detail-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 20px;
  padding: 0 2px 12px;
  border-bottom: 1px solid rgba(70, 107, 183, 0.12);
}

.rhythm-detail-head span {
  display: grid;
  gap: 3px;
}

.rhythm-detail-head small {
  color: #8292b0;
  font: 700 var(--text-caption)/1.2 var(--mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.rhythm-detail-head strong {
  color: #122f65;
  font: 800 var(--text-page)/1.1 var(--display);
}

.rhythm-detail-head p {
  max-width: 560px;
  margin: 0;
  color: #6e7f9e;
  font: 500 var(--text-label)/1.45 var(--ui);
}

.rhythm-detail-grid {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  min-width: 0;
  margin-top: 8px;
  overflow: clip;
  border: 1px solid rgba(70, 107, 183, 0.12);
  border-radius: 12px;
}

.rhythm-detail-labels {
  display: grid;
  grid-template-rows: 44px 48px 48px;
  background: rgba(242, 246, 255, 0.78);
}

.rhythm-detail-labels span {
  display: grid;
  align-content: center;
  gap: 3px;
  padding: 0 12px;
  border-bottom: 1px solid rgba(70, 107, 183, 0.12);
}

.rhythm-detail-labels span:last-child {
  border-bottom: 0;
}

.rhythm-hand-label-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 0 10px;
  border: 0;
  border-bottom: 1px solid rgba(70, 107, 183, 0.12);
  background: transparent;
  color: #245ac0;
  cursor: pointer;
  text-align: left;
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
}

.rhythm-hand-label-toggle:last-child {
  border-bottom: 0;
}

.rhythm-hand-label-toggle > i {
  flex: 0 0 auto;
  width: 14px;
  font: 800 var(--text-caption)/1 var(--mono);
  font-style: normal;
}

.rhythm-hand-label-toggle > span {
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: 0;
  border: 0;
}

.rhythm-hand-label-toggle b,
.rhythm-hand-label-toggle small {
  color: currentColor;
}

.rhythm-hand-label-toggle.is-left {
  color: #647b9f;
}

.rhythm-hand-label-toggle.is-off {
  background: rgba(125, 137, 160, 0.08);
  color: #9ba5b7;
  opacity: 0.72;
}

.rhythm-hand-label-toggle:focus-visible {
  position: relative;
  z-index: 2;
  outline: 2px solid #2762d8;
  outline-offset: -3px;
}

@media (hover: hover) and (pointer: fine) {
  .rhythm-hand-label-toggle:hover {
    background: rgba(39, 94, 218, 0.08);
  }
}

.rhythm-detail-labels b {
  color: #183f89;
  font: 800 var(--text-label)/1 var(--mono);
  text-transform: uppercase;
}

.rhythm-detail-labels small {
  color: #8c9ab4;
  font: 650 var(--text-caption)/1.1 var(--ui);
}

.rhythm-detail-labels .rhythm-hand-label-toggle b,
.rhythm-detail-labels .rhythm-hand-label-toggle small {
  color: currentColor;
}

.rhythm-beat-columns {
  display: grid;
  grid-template-columns: repeat(var(--rhythm-beat-total, 1), minmax(0, 1fr));
  min-width: 0;
}

.rhythm-beat-column {
  display: grid;
  grid-template-rows: 44px 48px 48px;
  min-width: 0;
  border-left: 1px solid rgba(54, 94, 173, 0.18);
}

.rhythm-beat-column:first-child {
  border-left: 0;
}

.rhythm-spoken-subgrid,
.rhythm-hand-subgrid {
  display: grid;
  grid-template-columns: repeat(var(--rhythm-subdivision-total, 1), minmax(0, 1fr));
  min-width: 0;
  border-bottom: 1px solid rgba(70, 107, 183, 0.1);
}

.rhythm-spoken-subgrid {
  align-items: stretch;
}

.rhythm-hand-subgrid:last-child {
  border-bottom: 0;
}

.rhythm-spoken-subgrid b {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 0 2px;
  color: #315da9;
  font: 800 clamp(var(--text-section), 1.35vw, 20px)/1 var(--display);
}

.rhythm-spoken-subgrid b.is-pulse {
  color: #1b4ca9;
  font: 800 clamp(var(--text-section), 1.35vw, 20px)/1 var(--display);
}

.rhythm-spoken-subgrid b.is-active {
  background: #e53935;
  color: #fff;
}

.rhythm-hand-subgrid.is-right .rhythm-hand-cell {
  color: #245ac0;
}

.rhythm-hand-subgrid.is-left .rhythm-hand-cell {
  color: #6a7f9f;
}

.rhythm-hand-subgrid.is-muted {
  background: rgba(137, 147, 164, 0.08);
  filter: grayscale(1);
  opacity: 0.34;
}

.rhythm-hand-subgrid.is-muted .rhythm-hand-cell {
  color: #9da6b6;
  pointer-events: none;
}

.rhythm-mobile-hand-label {
  display: none;
}

.rhythm-hand-cell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 48px;
}

.rhythm-hand-cell.has-held-notes.is-attack::before {
  background: currentColor;
}

.rhythm-hand-cell.is-staccato.is-attack::after {
  position: absolute;
  top: calc(50% - 1px);
  left: 50%;
  width: 22%;
  height: 2px;
  border-radius: 2px;
  background: currentColor;
  content: "";
}

.rhythm-cell-count {
  top: 2px;
  left: 50%;
  max-width: calc(100% - 4px);
  overflow: hidden;
  padding: 2px 4px;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-caption);
  transform: translateX(-50%);
}

.rhythm-cell-tooltip {
  position: fixed;
  z-index: 10000;
  width: min(320px, calc(100vw - 24px));
  padding: 12px 14px;
  border: 1px solid rgba(108, 142, 211, 0.3);
  border-radius: 12px;
  background: #102b61;
  box-shadow: 0 18px 48px rgba(17, 40, 84, 0.3);
  color: #f5f8ff;
  pointer-events: none;
  text-align: left;
  white-space: normal;
  transform: none;
  font: 600 var(--text-label)/1.45 var(--ui);
}

.rhythm-cell-tooltip.is-above,
.rhythm-cell-tooltip.is-below {
  transform: none;
}

.rhythm-tooltip-heading {
  display: grid;
  gap: 3px;
  padding-bottom: 9px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.18);
}

.rhythm-tooltip-heading strong {
  color: #fff;
  font: 800 var(--text-section)/1.1 var(--display);
}

.rhythm-tooltip-heading small {
  color: #b9caec;
  font: 650 var(--text-caption)/1.3 var(--ui);
}

.rhythm-cell-tooltip p {
  margin: 10px 0 0;
  color: #fff;
  font: 650 var(--text-label)/1.4 var(--ui);
}

.rhythm-cell-tooltip ul {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding: 0;
  color: #c6d5f1;
  list-style: none;
  font: 500 var(--text-caption)/1.4 var(--ui);
}

.rhythm-cell-tooltip li::before {
  margin-right: 6px;
  color: #78a2ff;
  content: "•";
}

.score-playhead {
  position: absolute;
  z-index: 12;
  width: 4px;
  border-radius: 2px;
  background: linear-gradient(180deg, #ef4444, #d51f27);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.78), 0 0 14px rgba(229, 57, 53, 0.62);
  pointer-events: none;
}

.score-playhead::before {
  position: absolute;
  inset: 0 -5px;
  border-radius: 7px;
  background: rgba(229, 57, 53, 0.14);
  content: "";
}

.score-playhead span {
  position: absolute;
  top: -25px;
  left: 50%;
  min-width: max-content;
  padding: 4px 7px;
  border-radius: 7px;
  background: #d9272e;
  box-shadow: 0 5px 14px rgba(179, 27, 35, 0.28);
  color: #fff;
  text-align: center;
  transform: translateX(-50%);
  font: 750 var(--text-caption)/1 var(--ui);
}

.rhythm-hand-cell.is-active {
  background: #1f51bd;
  color: #fff;
  box-shadow: 0 0 0 2px rgba(31, 81, 189, 0.22);
}

.rhythm-hand-cell.is-active .rhythm-cell-mark {
  background: transparent;
  color: #fff;
}

.rhythm-explanation {
  margin: 10px 0 0;
  color: #7888a6;
  font: 500 var(--text-caption)/1.5 var(--mono);
}

.fingering-score-surface :deep(.is-playing) {
  fill: #d9272e;
  stroke: #d9272e;
}

.measure-symbols {
  border: 1px solid rgba(70, 108, 190, 0.13);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.76);
}

.measure-symbols summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  color: #29477d;
  cursor: pointer;
  list-style: none;
  font: 650 var(--text-caption)/1 var(--mono);
}

.measure-symbols summary::-webkit-details-marker {
  display: none;
}

.measure-symbols summary::before {
  color: #4c70b8;
  content: "＋";
}

.measure-symbols[open] summary::before {
  content: "−";
}

.measure-symbols summary span {
  flex: 1;
}

.measure-symbols summary strong {
  color: #8a98b4;
  font-size: var(--text-caption);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.measure-symbol-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 12px 12px;
}

.measure-symbol-groups {
  display: grid;
  gap: 10px;
  padding: 0 12px 12px;
}

.measure-symbol-group h4 {
  margin: 0 0 5px;
  color: #8796b4;
  font: 650 var(--text-caption)/1 var(--mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.measure-symbol-chip {
  display: grid;
  gap: 2px;
  max-width: 260px;
  padding: 7px 10px;
  border: 1px solid rgba(72, 108, 181, 0.13);
  border-radius: 10px;
  background: rgba(243, 247, 255, 0.7);
  color: #4d6697;
  outline: none;
  transition: border-color 120ms ease, background 120ms ease;
}

@media (hover: hover) and (pointer: fine) {
  .measure-symbol-chip:hover {
    border-color: rgba(31, 87, 209, 0.4);
    background: rgba(44, 99, 219, 0.08);
  }
}

.measure-symbol-chip:focus-visible {
  border-color: rgba(31, 87, 209, 0.4);
  background: rgba(44, 99, 219, 0.08);
}

.measure-symbol-chip.is-unknown {
  border-style: dashed;
  color: #73809a;
}

.measure-symbol-name {
  color: #22406f;
  font: 700 var(--text-caption)/1.25 var(--mono);
}

.measure-symbol-count {
  color: #1f56bc;
  font: 700 var(--text-caption)/1 var(--mono);
  font-style: normal;
}

.measure-symbol-chip small {
  color: #7b8aa8;
  font: 500 var(--text-caption)/1.4 var(--mono);
}

.score-guide-tooltip {
  position: absolute;
  z-index: 5;
  width: max-content;
  max-width: min(310px, calc(100% - 20px));
  padding: 12px 14px;
  border: 1px solid rgba(63, 102, 184, 0.24);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.985);
  box-shadow:
    0 18px 40px rgba(41, 66, 119, 0.16),
    0 3px 10px rgba(41, 66, 119, 0.1);
  opacity: 0;
  pointer-events: none;
  transform: translateY(2px);
  transition: opacity 100ms ease, transform 100ms ease;
}

.score-guide-tooltip.is-positioned {
  opacity: 1;
  transform: translateY(0);
}

.score-guide-tooltip strong,
.score-guide-tooltip span {
  display: block;
}

.score-guide-tooltip strong {
  color: #102754;
  font: 700 var(--text-body)/1.2 var(--display);
}

.score-guide-tooltip span {
  margin-top: 4px;
  color: #526c9d;
  font: 650 var(--text-caption)/1.4 var(--mono);
}

.score-guide-tooltip p {
  margin: 7px 0 0;
  color: #7484a3;
  font: 500 var(--text-caption)/1.45 var(--mono);
}

.fingering-score-loading {
  position: absolute;
  z-index: 1;
  inset: 0;
  display: grid;
  align-content: center;
  gap: 28px;
  padding: 48px 8%;
  background: rgba(255, 255, 255, 0.92);
}

.score-skeleton {
  display: block;
  height: 2px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    rgba(104, 134, 202, 0.12) 18%,
    rgba(63, 101, 190, 0.32) 48%,
    rgba(104, 134, 202, 0.12) 82%
  );
  background-size: 220% 100%;
  animation: score-shimmer 1.25s ease-in-out infinite;
}

.score-skeleton.is-short {
  width: 64%;
}

.fingering-score-empty,
.fingering-score-error {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  padding: 32px;
  text-align: center;
  color: var(--muted-2);
  font: 600 var(--text-label)/1.5 var(--mono);
}

.fingering-score-error strong {
  color: #8b3c27;
  font: 700 var(--text-section)/1.3 var(--display);
}

.fingering-score-error button {
  margin-top: 8px;
  padding: 8px 16px;
  border: 1px solid var(--tbl-line);
  border-radius: 999px;
  background: var(--tbl-paper);
  color: var(--tbl-accent-deep);
  cursor: pointer;
  font: 700 var(--text-caption)/1 var(--mono);
  transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
}

.fingering-score-error button:hover {
  border-color: var(--tbl-accent);
  background: rgba(21, 87, 255, 0.06);
}

.fingering-score-error button:active {
  transform: scale(0.97);
}

.fingering-score-error button:focus-visible {
  outline: 2px solid var(--tbl-accent);
  outline-offset: 3px;
}

@keyframes score-shimmer {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}

@media (max-width: 720px) {
  .fingering-score {
    min-height: 200px;
    border-radius: 12px;
  }

  .fingering-score-surface {
    max-height: 400px;
    padding-inline: 8px;
  }

  .fingering-note-tooltip {
    padding: 10px 12px;
  }

  .fingering-note-tooltip-heading {
    gap: 10px;
  }

  .measure-learning {
    padding-inline: 8px;
  }

  .measure-attributes {
    grid-template-columns: 1fr;
  }

  .rhythm-guide {
    padding: 12px 8px;
  }

  .rhythm-head {
    align-items: flex-start;
  }

  .rhythm-title small {
    flex-basis: 100%;
    line-height: 1.35;
  }

  /* Транспорт на телефоне: главное действие занимает всю первую строку,
     режимы и темп остаются крупными touch-target во второй. */
  .rhythm-transport {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }

  .rhythm-play {
    grid-column: 1 / -1;
    width: 100%;
    min-height: 44px;
  }

  .rhythm-switches {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    min-width: 0;
  }

  .rhythm-switch {
    width: auto;
    min-height: 44px;
    padding-inline: 8px;
  }

  .rhythm-tempo {
    min-height: 44px;
  }

  .rhythm-tempo-hint {
    grid-column: 1 / -1;
  }

  .rhythm-overview {
    display: grid;
    grid-auto-columns: 138px;
    grid-auto-flow: column;
    grid-template-columns: none;
    margin-inline: -2px;
    padding: 2px 2px 8px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
  }

  .rhythm-overview-item {
    min-height: 76px;
    scroll-snap-align: start;
  }

  .rhythm-detail {
    padding: 10px;
  }

  .rhythm-detail-measures {
    gap: 16px;
  }

  .rhythm-detail-head {
    display: grid;
    gap: 8px;
  }

  .rhythm-detail-head p {
    font-size: var(--text-label);
  }

  .rhythm-detail-grid {
    display: block;
    overflow: visible;
    border: 0;
  }

  .rhythm-detail-labels {
    display: none;
  }

  .rhythm-beat-columns {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .rhythm-beat-column {
    /*
     * Высоты обязаны совпадать с внутренними строками: spoken = 44,
     * hand-cell = min-height 48. Прежние 42/46 px заставляли содержимое
     * перелезать в соседнюю строку даже при корректной ширине.
     */
    grid-template-rows: 44px 48px 48px;
    overflow: hidden;
    border: 1px solid rgba(54, 94, 173, 0.16);
    border-radius: 10px;
  }

  .rhythm-beat-column:first-child {
    border-left: 1px solid rgba(54, 94, 173, 0.16);
  }

  .rhythm-spoken-subgrid {
    grid-template-columns: repeat(var(--rhythm-subdivision-total, 1), minmax(40px, 1fr));
  }

  .rhythm-hand-subgrid {
    grid-template-columns: 64px repeat(var(--rhythm-subdivision-total, 1), minmax(40px, 1fr));
  }

  .rhythm-mobile-hand-label {
    display: flex;
    align-items: center;
    padding-left: 10px;
    border: 0;
    background: rgba(238, 243, 253, 0.82);
    color: #264c90;
    cursor: pointer;
    font: 750 var(--text-caption)/1 var(--mono);
    text-transform: uppercase;
  }

  .rhythm-mobile-hand-label.is-off {
    color: #9aa5b8;
  }

  .rhythm-cell-count {
    max-width: 82px;
  }

  .measure-symbol-chip {
    max-width: none;
  }
}

@media (forced-colors: active) {
  .fingering-score-surface :deep(.fingering-note-hit.is-active),
  .fingering-score-surface :deep(.fingering-symbol-hit.is-active) {
    filter: none;
    stroke: Highlight;
    stroke-width: 1px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .score-skeleton {
    animation: none;
  }

  .fingering-score-surface,
  .fingering-score-error button,
  .fingering-note-tooltip,
  .score-guide-tooltip,
  .measure-attribute-card,
  .measure-symbol-chip,
  .fingering-score-surface :deep(.fingering-note-hit),
  .fingering-score-surface :deep(.fingering-symbol-hit) {
    transition: none;
  }
}
</style>
