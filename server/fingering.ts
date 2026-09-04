/**
 * Подбор аппликатуры по партитуре.
 *
 * Слои и обоснование каждого решения — docs/fingering-prd.md §6.
 * Коротко: эргономическая модель Parncutt (fingering-model.ts) даёт стоимость,
 * педагогические паттерны (гаммы, арпеджио, альбертиев бас) дают приоры, а
 * beam-поиск по событиям руки выбирает минимум. Всё детерминировано.
 */

import {
  DEFAULT_WEIGHTS,
  addParts,
  interPressInterval,
  motionScale as tempoScale,
  tempoWeights,
  blackKeyCosts,
  chordFeasible,
  emptyParts,
  isBlackKey,
  positionChangeCosts,
  spanTables,
  threeFourFiveCost,
  transitionFeasible,
  transitionParts,
  weakFingerCost,
  weigh,
  type CostParts,
  type Finger,
  type Hand,
  type Key,
  type RuleWeights,
  type SpanTables,
} from "./fingering-model";
import { isPlayable, parseScore, type ParsedNote, type ParsedScore } from "./fingering-score";
import { PEDAGOGY, detectPatterns } from "./fingering-patterns";
import { futureCosts, positionContext, type PositionTouch } from "./fingering-context";
import { consolidateMotifs, consolidateRecurrences } from "./fingering-motifs";
import {
  FINGERING_SEARCH,
  type FingeringPattern,
  type HandEvent,
  type Hint,
} from "./fingering-types";

export { PEDAGOGY, degreeFingers, scaleThumbDegrees } from "./fingering-patterns";
export { FINGERING_SEARCH } from "./fingering-types";
export type { FingeringPattern } from "./fingering-types";

export type HandSpanPreset = "small" | "medium" | "large";
export type FingeringMode = "fill" | "rebuild";

const HAND_SPAN_SCALE: Record<HandSpanPreset, number> = {
  small: 0.9,
  medium: 1,
  large: 1.1,
};

/** Пороги детекции: издательская аппликатура никогда не стоит на каждой ноте. */
export const DETECTION = {
  present: 0.6,
  ignore: 0.05,
};

export interface FingeringCoverage {
  totalNotes: number;
  annotatedNotes: number;
  coverage: number;
  hasFingering: boolean;
  partial: boolean;
}

export interface MeasureLoad {
  index: number;
  number: string;
  right: { positionChanges: number; cost: number };
  left: { positionChanges: number; cost: number };
}

export interface FingeringStats {
  notes: number;
  rightNotes: number;
  leftNotes: number;
  positionChanges: number;
  thumbOnBlack: number;
  /** Полная целевая функция: эргономика + педагогические приоры. */
  costPerNote: number;
  /** Только положительная эргономическая часть Parncutt. */
  ergonomicCostPerNote: number;
  /** Разница между полной целью и эргономикой. */
  pedagogyAdjustmentPerNote: number;
  patternNotes: number;
}

export interface FingeringTrace {
  noteIndex: number;
  measure: string;
  hand: Hand;
  midi: number;
  finger: Finger;
  pattern?: FingeringPattern["kind"];
  reasons: Array<{ rule: keyof CostParts; points: number }>;
  adjustments: Array<{ kind: string; points: number }>;
}

export interface FingeringReport {
  coverage: FingeringCoverage;
  measures: MeasureLoad[];
  patterns: FingeringPattern[];
  stats: FingeringStats;
  /** Совпадение с уже проставленной в партитуре аппликатурой. */
  existing: { matched: number; total: number };
  warnings: string[];
}

export interface FingeringPlan {
  /** Ключ — `ParsedNote.index`. */
  assignments: Map<number, Finger>;
  /** Фактически выбранная рука; placement нельзя выводить только из staff. */
  hands: Map<number, Hand>;
  /**
   * Ноты, у которых палец известен, но печатать его не нужно: продолжения лиги
   * (звук не берётся заново) и «лишние» ноты сверхшироких аккордов. Цифра на
   * них — визуальный шум, которого нет ни в одном издании.
   */
  suppressed: Set<number>;
  report: FingeringReport;
  trace: FingeringTrace[];
}

export interface FingeringOptions {
  mode?: FingeringMode;
  handSpan?: HandSpanPreset;
  weights?: RuleWeights;
  /** Разметка исходной версии для честного сравнения после `stripFingering`. */
  comparisonFingerings?: ReadonlyMap<number, Finger>;
  /** Трассировка объёмная, поэтому собирается по запросу. */
  trace?: boolean;
}

/** Доля нот с уже проставленной аппликатурой. */
export function analyzeFingeringCoverage(xml: string): FingeringCoverage {
  return coverageOf(parseScore(xml));
}

function coverageOf(score: ParsedScore): FingeringCoverage {
  const playable = score.notes.filter((note) => isPlayable(note) && !note.tieStop);
  const annotated = playable.filter((note) => note.fingering !== undefined);
  const total = playable.length;
  const coverage = total === 0 ? 0 : annotated.length / total;
  return {
    totalNotes: total,
    annotatedNotes: annotated.length,
    coverage,
    hasFingering: coverage >= DETECTION.present,
    partial: coverage > DETECTION.ignore && coverage < DETECTION.present,
  };
}

/* ------------------------------------------------------------------ *
 * События руки
 * ------------------------------------------------------------------ */

function keyOf(note: ParsedNote): Key {
  return { midi: note.midi as number, black: isBlackKey(note.midi as number) };
}

/**
 * Разделение рук. Приоритет: нотоносец → отдельные партии → голоса на одной
 * строке → регистр (docs/fingering-prd.md §6.2).
 *
 * Возвращает готовый определитель, потому что решение по голосам принимается
 * один раз для всей партитуры, а не для каждой ноты.
 */
function handResolver(score: ParsedScore, notes: ParsedNote[]): (note: ParsedNote) => Hand {
  if (score.parts === 1 && score.staves >= 2) {
    const voiceStaves = new Map<string, Map<string, number>>();
    for (const note of notes) {
      const key = `${note.partId}:${note.voice}`;
      const counts = voiceStaves.get(key) ?? new Map<string, number>();
      counts.set(note.staff, (counts.get(note.staff) ?? 0) + 1);
      voiceStaves.set(key, counts);
    }
    const crossStaffHands = new Map<string, Hand>();
    for (const [voice, counts] of voiceStaves) {
      if (counts.size < 2) continue;
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const total = ranked.reduce((sum, [, count]) => sum + count, 0);
      if (ranked[0][1] / total < 0.75) continue;
      crossStaffHands.set(voice, ranked[0][0] === "1" ? "R" : "L");
    }
    return (note) =>
      crossStaffHands.get(`${note.partId}:${note.voice}`) ??
      (note.staff === "1" ? "R" : "L");
  }
  if (score.parts >= 2) {
    return (note) => (note.partIndex === 0 ? "R" : "L");
  }

  // Один нотоносец, два голоса — это сжатая запись двух рук (Hanon, этюды):
  // верхний голос играет правая. Так же это трактует MusicXML: voice 1 — верхний.
  const byVoice = new Map<string, { sum: number; count: number }>();
  for (const note of notes) {
    const bucket = byVoice.get(note.voice) ?? { sum: 0, count: 0 };
    bucket.sum += note.midi as number;
    bucket.count += 1;
    byVoice.set(note.voice, bucket);
  }
  if (byVoice.size === 2) {
    const ranked = [...byVoice.entries()]
      .map(([voice, bucket]) => ({ voice, mean: bucket.sum / bucket.count }))
      .sort((left, right) => right.mean - left.mean);
    if (ranked[0].mean - ranked[1].mean >= 3) {
      const upper = ranked[0].voice;
      return (note) => (note.voice === upper ? "R" : "L");
    }
  }

  const pitches = notes.map((note) => note.midi as number).sort((a, b) => a - b);
  const range = (pitches[pitches.length - 1] ?? 60) - (pitches[0] ?? 60);
  if (range > 24) return (note) => ((note.midi as number) >= 60 ? "R" : "L");

  // Диапазон в пределах двух октав — это одна рука; какая именно, говорит ключ.
  const sign = score.clefs.get(`${notes[0]?.partId ?? "P1"}:1`) ?? "";
  const hand: Hand = sign === "F" ? "L" : sign === "G" ? "R" : (pitches[0] ?? 60) >= 48 ? "R" : "L";
  return () => hand;
}

function buildEvents(
  notes: ParsedNote[],
  mode: FingeringMode,
  inherited: Map<number, number>,
): HandEvent[] {
  const byOnset = new Map<string, ParsedNote[]>();
  for (const note of notes) {
    const key = note.onset.toFixed(4);
    const bucket = byOnset.get(key);
    if (bucket) bucket.push(note);
    else byOnset.set(key, [note]);
  }

  const events: HandEvent[] = [];
  const onsets = [...byOnset.keys()].sort((a, b) => Number(a) - Number(b));
  let previous: HandEvent | undefined;
  let previousEnd = 0;
  const activeSlurs = new Set<string>();

  const slurKey = (note: ParsedNote, number: string): string =>
    `${note.partId}:${note.staff}:${note.voice}:${number}`;

  for (const onsetKey of onsets) {
    const bucket = (byOnset.get(onsetKey) as ParsedNote[]).slice().sort(
      (a, b) => (a.midi as number) - (b.midi as number),
    );
    const onset = Number(onsetKey);
    const kept = bucket.length <= 5 ? bucket : [...bucket.slice(0, 2), ...bucket.slice(-3)];
    const spilled = bucket.filter((note) => !kept.includes(note));

    const hardBreakBefore =
      kept.some((note) => note.hardBreakBefore) &&
      (!previous || previous.measureIndex !== kept[0].measureIndex);
    const gapBefore = hardBreakBefore
      ? FINGERING_SEARCH.resetGap
      : previous
        ? Math.max(0, onset - previousEnd)
        : 0;
    const slurredBefore = Boolean(
      previous &&
        kept.some(
          (note) =>
            note.slurStops.length > 0 ||
            [...activeSlurs].some((key) =>
              key.startsWith(`${note.partId}:${note.staff}:${note.voice}:`),
            ),
        ),
    );
    const event: HandEvent = {
      index: events.length,
      onset,
      measureIndex: kept[0].measureIndex,
      measureNumber: kept[0].measureNumber,
      notes: kept,
      keys: kept.map(keyOf),
      spilled,
      gapBefore,
      ipiBefore: previous
        ? interPressInterval(onset - previous.onset, kept[0].tempo)
        : undefined,
      slurredBefore,
      beamBegin: kept.some((note) => note.beamBegin),
      beamEnd: kept.some((note) => note.beamEnd),
      hardBreakBefore,
      fixed: kept.map((note) =>
        mode === "fill" && note.fingering !== undefined ? (note.fingering as Finger) : undefined,
      ),
    };
    events.push(event);
    for (const note of spilled) {
      const neighbor = kept.reduce((best, candidate) =>
        Math.abs((candidate.midi as number) - (note.midi as number)) <
        Math.abs((best.midi as number) - (note.midi as number))
          ? candidate
          : best,
      );
      inherited.set(note.index, neighbor.index);
    }
    for (const note of kept) {
      for (const number of note.slurStops) activeSlurs.delete(slurKey(note, number));
      for (const number of note.slurStarts) activeSlurs.add(slurKey(note, number));
    }
    previous = event;
    previousEnd = Math.max(...kept.map((note) => note.onset + note.duration));
  }
  return events;
}

/* ------------------------------------------------------------------ *
 * Кандидаты
 * ------------------------------------------------------------------ */

function combinations(size: number): Finger[][] {
  const result: Finger[][] = [];
  const walk = (start: number, current: Finger[]): void => {
    if (current.length === size) {
      result.push([...current]);
      return;
    }
    for (let finger = start; finger <= 5; finger += 1) {
      current.push(finger as Finger);
      walk(finger + 1, current);
      current.pop();
    }
  };
  walk(1, []);
  return result;
}

const COMBINATION_CACHE = new Map<number, Finger[][]>();
const EVENT_EPSILON = 1e-4;
const MAX_CROSS_HAND_DURATION = 1;

interface CandidateSet {
  values: Finger[][];
  /** Нет ни одной физически допустимой формы: значения только для продолжения DP. */
  relaxed: boolean;
  /**
   * Общая вертикаль физически не берётся, но независимые MusicXML-голоса
   * берутся по отдельности. Это модель арпеджирования/педальной подхватки,
   * а не настоящий одновременный аккорд.
   */
  voiceSplit: boolean;
  /**
   * Вертикаль шире руки, но это выдержанный аккорд: пианист берёт его снизу
   * вверх под педалью. Форма законная, только играется не разом — и ученику
   * это нужно сказать словами, а не молча снять цифры.
   */
  rolled: boolean;
}

/**
 * Минимальная длительность аккорда, при которой размах берётся разложенно.
 * Считаем в секундах, а не в долях: разложение трёх звуков занимает около
 * 0.15 с независимо от того, записаны они половинными или восьмыми. 0.35 с
 * оставляет запас — аккорд заметно переживает собственное разложение. Ниже
 * этой границы приём слышен как ошибка, а не как приём.
 */
const ROLLED_MIN_SECONDS = 0.35;

/** Все ноты отрезка берутся одной позицией руки. */
function grabFeasible(
  keys: Key[],
  assign: Finger[],
  from: number,
  to: number,
  hand: Hand,
  tables: SpanTables,
): boolean {
  for (let i = from; i < to; i += 1) {
    for (let j = i + 1; j < to; j += 1) {
      if (!chordFeasible(tables, hand, assign[i], keys[i], assign[j], keys[j])) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Аккорд шире руки, взятый снизу вверх под педалью. Рука здесь не тянется, а
 * перемещается: сначала берёт нижние звуки, отпускает их в педаль и доходит до
 * верхних. Поэтому условие — два достижимых хвата подряд, а не одна форма на
 * весь размах и не «соседние пары»: между соседними звуками децимы всё равно
 * оказывается интервал, который соседние пальцы не берут.
 */
function rolledChordCandidates(
  keys: Key[],
  fixed: Array<Finger | undefined>,
  hand: Hand,
  tables: SpanTables,
): Finger[][] {
  return orientedFingerings(keys.length, hand).filter((assign) => {
    for (let i = 0; i < assign.length; i += 1) {
      if (fixed[i] !== undefined && fixed[i] !== assign[i]) return false;
    }
    for (let split = 1; split < assign.length; split += 1) {
      if (
        grabFeasible(keys, assign, 0, split, hand, tables)
        && grabFeasible(keys, assign, split, assign.length, hand, tables)
      ) {
        return true;
      }
    }
    return false;
  });
}

/** Русское склонение «полутон» по числу: 21 полутон, 23 полутона, 16 полутонов. */
function semitoneWord(count: number): string {
  const tail = count % 10;
  const teen = count % 100;
  if (teen >= 11 && teen <= 14) return "полутонов";
  if (tail === 1) return "полутон";
  if (tail >= 2 && tail <= 4) return "полутона";
  return "полутонов";
}

/** Разложить можно только выдержанный аккорд, а не вертикаль в быстром пассаже. */
function isRollableChord(event: HandEvent): boolean {
  if (event.notes.length < 3) return false;
  if (event.notes.some((note) => note.grace)) return false;
  const shortest = Math.min(...event.notes.map((note) => note.duration));
  const seconds = interPressInterval(shortest, event.notes[0]?.tempo);
  // Темп в партитуре не указан: движок трактует такое место как спокойное
  // (см. motionScale), поэтому границу держим по нотной длительности.
  return seconds === undefined
    ? shortest >= 1 - EVENT_EPSILON
    : seconds >= ROLLED_MIN_SECONDS;
}

function noteVoice(note: ParsedNote): string {
  return `${note.partId}:${note.voice}`;
}

function orientedFingerings(size: number, hand: Hand): Finger[][] {
  let base = COMBINATION_CACHE.get(size);
  if (!base) {
    base = combinations(size);
    COMBINATION_CACHE.set(size, base);
  }
  return base.map((combo) => (hand === "R" ? combo : [...combo].reverse()));
}

function strictChordCandidates(
  keys: Key[],
  fixed: Array<Finger | undefined>,
  hand: Hand,
  tables: SpanTables,
): Finger[][] {
  // Пальцы в аккорде не перекрещиваются: в правой руке они растут вместе с
  // высотой, в левой — убывают.
  return orientedFingerings(keys.length, hand).filter((assign) => {
    for (let i = 0; i < assign.length; i += 1) {
      if (fixed[i] !== undefined && fixed[i] !== assign[i]) return false;
    }
    for (let i = 0; i + 1 < assign.length; i += 1) {
      for (let j = i + 1; j < assign.length; j += 1) {
        if (!chordFeasible(tables, hand, assign[i], keys[i], assign[j], keys[j])) {
          return false;
        }
      }
    }
    return true;
  });
}

function candidatesFor(event: HandEvent, hand: Hand, tables: SpanTables): CandidateSet {
  const size = event.notes.length;
  const oriented = orientedFingerings(size, hand);
  const fixed = event.fixed;
  const filtered = strictChordCandidates(event.keys, fixed, hand, tables);
  if (filtered.length > 0) {
    return { values: filtered, relaxed: false, voiceSplit: false, rolled: false };
  }

  // MuseScore нередко кодирует педально удержанный бас и следующий аккорд
  // разными голосами с одним onset. Сначала выше проверяется строгий реальный
  // аккорд; только если он невозможен, разрешаем независимые формы голосов.
  // Пальцы между голосами могут повторяться: ранний слой отпускается под педаль.
  const layers = new Map<string, number[]>();
  for (let index = 0; index < event.notes.length; index += 1) {
    const voice = noteVoice(event.notes[index]);
    const indices = layers.get(voice);
    if (indices) indices.push(index);
    else layers.set(voice, [index]);
  }
  if (layers.size > 1) {
    const layerOptions: Array<{ indices: number[]; assignments: Finger[][] }> = [];
    for (const indices of layers.values()) {
      let combinationsForLayer = COMBINATION_CACHE.get(indices.length);
      if (!combinationsForLayer) {
        combinationsForLayer = combinations(indices.length);
        COMBINATION_CACHE.set(indices.length, combinationsForLayer);
      }
      const assignments = combinationsForLayer
        .map((combo) => (hand === "R" ? combo : [...combo].reverse()))
        .filter((assign) => {
          for (let i = 0; i < assign.length; i += 1) {
            const eventIndex = indices[i];
            if (
              fixed[eventIndex] !== undefined &&
              fixed[eventIndex] !== assign[i]
            ) {
              return false;
            }
          }
          for (let i = 0; i + 1 < assign.length; i += 1) {
            for (let j = i + 1; j < assign.length; j += 1) {
              if (
                !chordFeasible(
                  tables,
                  hand,
                  assign[i],
                  event.keys[indices[i]],
                  assign[j],
                  event.keys[indices[j]],
                )
              ) {
                return false;
              }
            }
          }
          return true;
        });
      if (assignments.length === 0) {
        layerOptions.length = 0;
        break;
      }
      layerOptions.push({ indices, assignments });
    }
    if (layerOptions.length === layers.size) {
      let combined: Finger[][] = [new Array<Finger>(size)];
      for (const layer of layerOptions) {
        const next: Finger[][] = [];
        for (const partial of combined) {
          for (const assignment of layer.assignments) {
            const value = [...partial];
            for (let i = 0; i < layer.indices.length; i += 1) {
              value[layer.indices[i]] = assignment[i];
            }
            next.push(value);
          }
        }
        combined = next;
      }
      return { values: combined, relaxed: false, voiceSplit: true, rolled: false };
    }
  }

  /*
   * Выдержанный аккорд шире руки — не «форма не найдена», а разложенный
   * аккорд под педалью. Раньше такая вертикаль уходила в relaxed и теряла
   * цифры целиком: в «Cornfield Chase» из-за децимы F2–A3 бас оставался без
   * аппликатуры в девяти тактах, хотя пальцы 5-3-2 очевидны.
   */
  if (isRollableChord(event)) {
    const rolled = rolledChordCandidates(event.keys, fixed, hand, tables);
    if (rolled.length > 0) {
      return { values: rolled, relaxed: false, voiceSplit: false, rolled: true };
    }
  }

  // Сохраняем DP живым, но такие назначения не попадут в XML: вызывающий
  // подавит их и выдаст точное предупреждение вместо ложного соблюдения M5.
  const relaxed = oriented.filter((assign) =>
    assign.every((finger, index) => fixed[index] === undefined || fixed[index] === finger),
  );
  return {
    values: relaxed.length > 0 ? relaxed : oriented,
    relaxed: true,
    voiceSplit: false,
    rolled: false,
  };
}

function sortedNotes(notes: ParsedNote[]): ParsedNote[] {
  return [...notes].sort(
    (left, right) =>
      (left.midi as number) - (right.midi as number) || left.index - right.index,
  );
}

function hasStrictShape(
  notes: ParsedNote[],
  hand: Hand,
  tables: SpanTables,
): boolean {
  const ordered = sortedNotes(notes);
  return (
    strictChordCandidates(
      ordered.map(keyOf),
      ordered.map((note) =>
        note.fingering === undefined ? undefined : (note.fingering as Finger),
      ),
      hand,
      tables,
    ).length > 0
  );
}

function allVoiceLayersAreStaccato(notes: ParsedNote[]): boolean {
  // В MusicXML артикуляция аккорда обычно записана только на его базовой ноте.
  const layers = new Map<string, ParsedNote[]>();
  for (const note of notes) {
    const layer = layers.get(noteVoice(note));
    if (layer) layer.push(note);
    else layers.set(noteVoice(note), [note]);
  }
  return [...layers.values()].every((layer) => layer.some((note) => note.staccato));
}

function slurredNotes(notes: ParsedNote[]): Set<number> {
  const active = new Set<string>();
  const result = new Set<number>();
  const ordered = [...notes].sort(
    (left, right) => left.onset - right.onset || left.index - right.index,
  );
  for (const note of ordered) {
    const prefix = `${noteVoice(note)}:`;
    const activeInVoice = [...active].some((key) => key.startsWith(prefix));
    if (activeInVoice || note.slurStarts.length > 0 || note.slurStops.length > 0) {
      result.add(note.index);
    }
    for (const number of note.slurStops) active.delete(`${prefix}${number}`);
    for (const number of note.slurStarts) active.add(`${prefix}${number}`);
  }
  return result;
}

function redistributionGuard(
  notes: ParsedNote[],
  notesInSlur: ReadonlySet<number>,
): boolean {
  if (notes.some((note) => note.grace || note.tieStart || note.tieStop)) return false;
  if (notes.some((note) => notesInSlur.has(note.index))) return false;
  if (notes.some((note) => note.fingering !== undefined)) return false;
  if (notes.some((note) => /<(?:non-)?arpeggiate(?=[\s/>])/i.test(note.body))) return false;
  const ends = notes.map((note) => note.onset + note.duration);
  return (
    notes.every(
      (note) =>
        note.duration > EVENT_EPSILON &&
        note.duration <= MAX_CROSS_HAND_DURATION + EVENT_EPSILON,
    ) &&
    ends.every((end) => Math.abs(end - ends[0]) <= EVENT_EPSILON)
  );
}

/**
 * Консервативный fallback для явно двухручного одновременного созвучия.
 *
 * Нота переносится между руками только когда написанная на одном нотоносце
 * двухзвучная форма физически невозможна, а единственное не пересекающее руки
 * разбиение делает обе вертикали строгими. Любая неоднозначность, legato,
 * удержание или авторская цифра оставляет исходное честное предупреждение.
 */
function redistributeUnplayableDyads(
  score: ParsedScore,
  notes: ParsedNote[],
  hands: Map<number, Hand>,
  tables: SpanTables,
): Set<number> {
  const transfers = new Set<number>();
  if (score.parts !== 1 || score.stavesByPart.get(0) !== 2) return transfers;
  const notesInSlur = slurredNotes(notes);

  const byOnset = new Map<string, ParsedNote[]>();
  for (const note of notes) {
    const key = `${note.partId}:${note.onset.toFixed(4)}`;
    const bucket = byOnset.get(key);
    if (bucket) bucket.push(note);
    else byOnset.set(key, [note]);
  }
  const groups = [...byOnset.values()].sort(
    (left, right) =>
      left[0].onset - right[0].onset || left[0].index - right[0].index,
  );

  for (const simultaneous of groups) {
    const onset = simultaneous[0].onset;
    const partId = simultaneous[0].partId;

    const proposals: Array<{
      note: ParsedNote;
      to: Hand;
    }> = [];
    for (const from of ["R", "L"] as Hand[]) {
      const to: Hand = from === "R" ? "L" : "R";
      const source = sortedNotes(
        simultaneous.filter((note) => hands.get(note.index) === from),
      );
      const recipient = sortedNotes(
        simultaneous.filter((note) => hands.get(note.index) === to),
      );
      if (source.length !== 2 || recipient.length === 0 || recipient.length >= 5) {
        continue;
      }
      if (new Set(source.map(noteVoice)).size !== 1) continue;
      if (source.filter((note) => note.chord).length !== 1) continue;
      const sourceStaff = from === "R" ? "1" : "2";
      const recipientStaff = to === "R" ? "1" : "2";
      if (!source.every((note) => note.staff === sourceStaff)) continue;
      if (!recipient.every((note) => note.staff === recipientStaff)) continue;
      const involved = [...source, ...recipient];
      if (!redistributionGuard(involved, notesInSlur)) continue;
      const commonEnd = involved[0].onset + involved[0].duration;
      const heldAcrossOnset = notes.some(
        (note) =>
          note.partId === partId &&
          note.onset < onset - EVENT_EPSILON &&
          note.onset + note.duration > onset + EVENT_EPSILON,
      );
      const attackBeforeRelease = notes.some(
        (note) =>
          note.partId === partId &&
          note.onset > onset + EVENT_EPSILON &&
          note.onset < commonEnd - EVENT_EPSILON,
      );
      if (heldAcrossOnset || attackBeforeRelease) continue;
      if (!allVoiceLayersAreStaccato(source) || !allVoiceLayersAreStaccato(recipient)) {
        continue;
      }
      if (hasStrictShape(source, from, tables)) continue;
      if (!hasStrictShape(recipient, to, tables)) continue;

      const moved = from === "R" ? source[0] : source[source.length - 1];
      const sourceAfter = source.filter((note) => note.index !== moved.index);
      const recipientAfter = sortedNotes([...recipient, moved]);
      const leftAfter = from === "R" ? recipientAfter : sourceAfter;
      const rightAfter = from === "R" ? sourceAfter : recipientAfter;
      const leftHigh = Math.max(...leftAfter.map((note) => note.midi as number));
      const rightLow = Math.min(...rightAfter.map((note) => note.midi as number));
      if (leftHigh >= rightLow) continue;
      if (!hasStrictShape(sourceAfter, from, tables)) continue;
      if (!hasStrictShape(recipientAfter, to, tables)) continue;

      proposals.push({ note: moved, to });
    }

    if (proposals.length !== 1) continue;
    const proposal = proposals[0];
    hands.set(proposal.note.index, proposal.to);
    transfers.add(proposal.note.index);
  }
  return transfers;
}

/* ------------------------------------------------------------------ *
 * Стоимость
 * ------------------------------------------------------------------ */

interface EventChain {
  lowFinger: Finger;
  lowKey: Key;
  highFinger: Finger;
  highKey: Key;
}

function chainOf(event: HandEvent, assign: Finger[]): EventChain {
  const last = event.notes.length - 1;
  return {
    lowFinger: assign[0],
    lowKey: event.keys[0],
    highFinger: assign[last],
    highKey: event.keys[last],
  };
}

/** Вертикальная стоимость аккорда: правила растяжения между соседними нотами. */
function verticalParts(
  tables: SpanTables,
  hand: Hand,
  event: HandEvent,
  assign: Finger[],
  voiceSplit = false,
): CostParts {
  const parts = emptyParts();
  const layers = new Map<string, number[]>();
  for (let index = 0; index < event.notes.length; index += 1) {
    const voice = voiceSplit ? noteVoice(event.notes[index]) : "strict";
    const indices = layers.get(voice);
    if (indices) indices.push(index);
    else layers.set(voice, [index]);
  }
  for (const indices of layers.values()) {
    for (let offset = 0; offset + 1 < indices.length; offset += 1) {
      const i = indices[offset];
      const j = indices[offset + 1];
      const [f, from, g, to] =
        hand === "R"
          ? [assign[i], event.keys[i], assign[j], event.keys[j]]
          : [assign[j], event.keys[j], assign[i], event.keys[i]];
      const pair = transitionParts(tables, hand, f, from, g, to);
      pair.weakFinger = 0;
      pair.thumbPassing = 0;
      addParts(parts, pair);
    }
  }
  // Раздельные голосовые формы требуют как минимум одной передачи под педаль.
  if (voiceSplit) parts.voiceRelease += Math.max(0, layers.size - 1);
  for (const finger of assign) parts.weakFinger += weakFingerCost(finger);
  return parts;
}

/**
 * Перенос всей формы руки: событие целиком — параллельный сдвиг предыдущего.
 *
 * Только в этом случае повтор пальца между аккордами не является дефектом:
 * октавы и трезвучия действительно играют одной формой, перенося её целиком.
 * Если же один голос стоит на месте, а другой движется (педальный бас под
 * мелодией, выдержанная нижняя нота под верхней линией), движущийся голос
 * мелодический, и повторить в нём палец на другой высоте нельзя — рука либо
 * отрывается, либо звук рвётся. Прежняя проверка `polyphonic` объявляла
 * переносом любую пару, где хоть одно событие многозвучно, и такие места
 * получали 3-3-2 на нисходящей линии вместо связного 5-4-3.
 */
function isBlockTransfer(previous: HandEvent, event: HandEvent): boolean {
  if (previous.keys.length !== event.keys.length) return false;
  // Сдвиг берётся по нижнему голосу и обязан совпасть у всех остальных.
  // Нулевой сдвиг нижнего голоса сам по себе ничего не значит: выдержанный
  // бас под движущимся верхом — это мелодия, а не перенос формы.
  const delta = event.keys[0].midi - previous.keys[0].midi;
  return event.keys.every((key, index) => key.midi - previous.keys[index].midi === delta);
}

/**
 * Цена повтора пальца, который сама модель считает недостижимым.
 *
 * Запрещать нельзя: пианист снимет руку и поставит палец заново — это
 * некрасиво, но возможно, а жёсткий запрет оставлял 526 нот вовсе без цифры
 * (луч поиска опустошался). Поэтому очень дорого, но конечно.
 *
 * Величина соразмерна тому, что модель берёт за настоящую смену позиции
 * (правила 4 и 5 в быстром месте дают около 12 очков): недостижимый повтор
 * должен стоить примерно вдвое дороже законного переноса руки. Замер по
 * корпусу: 12 убирает 73 % таких мест, 24 — 92 %, но вчетверо дороже
 * смены позиции уже искажает соседние решения (расхождений в одинаковых
 * тактах становится 85 вместо 74).
 */
const UNREACHABLE_REPEAT = 12;

/**
 * Достижим ли переход в каждом из крайних голосов.
 *
 * Проверяется только повтор пальца: остальные пары уже отфильтрованы
 * `candidatesFor`, а растяжения сверх практического предела в мелодическом
 * ходе честнее оценивать ценой, чем запрещать.
 */
function stepReachable(
  tables: SpanTables,
  hand: Hand,
  from: EventChain,
  to: EventChain,
): boolean {
  const line = (f: Finger, a: Key, g: Finger, b: Key): boolean => {
    if (f !== g || a.midi === b.midi) return true;
    // Скачок шире квинты рука переносит целиком — повтор пальца там норма.
    if (Math.abs(b.midi - a.midi) > 7) return true;
    return transitionFeasible(tables, hand, f, a, g, b);
  };
  return (
    line(from.lowFinger, from.lowKey, to.lowFinger, to.lowKey) &&
    line(from.highFinger, from.highKey, to.highFinger, to.highKey)
  );
}

/**
 * Горизонтальная стоимость: среднее по нижнему и верхнему голосу события.
 */
function horizontalParts(
  tables: SpanTables,
  hand: Hand,
  from: EventChain,
  to: EventChain,
  polyphonic: boolean,
): CostParts {
  const parts = emptyParts();
  const low = transitionParts(tables, hand, from.lowFinger, from.lowKey, to.lowFinger, to.lowKey);
  const high = transitionParts(
    tables,
    hand,
    from.highFinger,
    from.highKey,
    to.highFinger,
    to.highKey,
  );
  low.weakFinger = 0;
  high.weakFinger = 0;
  if (polyphonic) {
    low.sameFinger = 0;
    high.sameFinger = 0;
  }
  addParts(parts, low, 0.5);
  addParts(parts, high, 0.5);
  return parts;
}

function tripleParts(
  tables: SpanTables,
  hand: Hand,
  a: EventChain,
  b: EventChain,
  c: EventChain,
): CostParts {
  const parts = emptyParts();
  const low = positionChangeCosts(
    tables,
    hand,
    [a.lowFinger, b.lowFinger, c.lowFinger],
    [a.lowKey, b.lowKey, c.lowKey],
  );
  const high = positionChangeCosts(
    tables,
    hand,
    [a.highFinger, b.highFinger, c.highFinger],
    [a.highKey, b.highKey, c.highKey],
  );
  parts.positionChangeCount = (low.positionChangeCount + high.positionChangeCount) / 2;
  parts.positionChangeSize = (low.positionChangeSize + high.positionChangeSize) / 2;
  parts.threeFourFive =
    (threeFourFiveCost(a.lowFinger, b.lowFinger, c.lowFinger) +
      threeFourFiveCost(a.highFinger, b.highFinger, c.highFinger)) /
    2;
  return parts;
}

/** Ближайшая по высоте нота соседнего события вместе с её пальцем. */
function nearestNeighbour(
  event: HandEvent | undefined,
  assign: Finger[] | undefined,
  midi: number,
): { key: Key; finger?: Finger } | undefined {
  if (!event) return undefined;
  let bestIndex = 0;
  for (let index = 0; index < event.keys.length; index += 1) {
    if (
      Math.abs(event.keys[index].midi - midi)
      < Math.abs(event.keys[bestIndex].midi - midi)
    ) {
      bestIndex = index;
    }
  }
  return { key: event.keys[bestIndex], finger: assign?.[bestIndex] };
}

/** Правила 10 и 11 для всех нот события с учётом реальных соседей. */
function blackParts(
  event: HandEvent,
  assign: Finger[],
  previous?: HandEvent,
  next?: HandEvent,
  previousAssign?: Finger[],
  nextAssign?: Finger[],
): CostParts {
  const parts = emptyParts();
  for (let i = 0; i < assign.length; i += 1) {
    const key = event.keys[i];
    const before = nearestNeighbour(previous, previousAssign, key.midi);
    const after = nearestNeighbour(next, nextAssign, key.midi);
    const costs = blackKeyCosts(
      assign[i],
      key,
      before?.key,
      after?.key,
      before?.finger,
      after?.finger,
    );
    parts.thumbOnBlack += costs.thumbOnBlack;
    parts.fiveOnBlack += costs.fiveOnBlack;
  }
  return parts;
}

/* ------------------------------------------------------------------ *
 * Поиск
 * ------------------------------------------------------------------ */

interface SearchState {
  key: string;
  cost: number;
  previousKey: string | null;
  candidate: number;
  previousCandidate: number;
  touches: PositionTouch[];
  held: HeldFinger[];
  step: StepCost;
}

interface HeldFinger {
  noteIndex: number;
  finger: Finger;
  partId: string;
  voice: string;
  key: Key;
  end: number;
}

type ReleasedLayerRole = "bass" | "inner" | "upper";

/**
 * Цена досрочного снятия нотированно удержанного слоя другого голоса.
 *
 * Нижний бас часто записан полной длительностью ради голосоведения, хотя
 * пианист снимает его перед следующим аккордом; поэтому такое снятие остаётся
 * возможным и без явного знака педали. Верхний/внутренний слой без педали
 * получает штраф порядка смены всей позиции: простой полифонический случай
 * сохранит пальцевое удержание, а физически невозможная вертикаль всё же
 * сможет честно перейти в артикулированное снятие. При явной педали все роли
 * дешевле, но мелодический верх всё равно дороже басовой передачи.
 */
const CROSS_VOICE_RELEASE_COST = {
  bassWithPedal: 1,
  bassWithoutPedal: 2,
  innerWithPedal: 3,
  upperWithPedal: 4,
  innerWithoutPedal: 8,
  upperWithoutPedal: 12,
} as const;

function releasedLayerRole(layer: HeldFinger[], event: HandEvent): ReleasedLayerRole {
  const layerLow = Math.min(...layer.map((item) => item.key.midi));
  const layerHigh = Math.max(...layer.map((item) => item.key.midi));
  const eventLow = Math.min(...event.keys.map((key) => key.midi));
  const eventHigh = Math.max(...event.keys.map((key) => key.midi));
  if (layerHigh < eventLow) return "bass";
  if (layerLow > eventHigh) return "upper";
  return "inner";
}

function crossVoiceReleaseCost(
  layer: HeldFinger[],
  event: HandEvent,
): number | undefined {
  const role = releasedLayerRole(layer, event);
  const partId = layer[0]?.partId;
  const pedalDown = event.notes.some(
    (note) => note.partId === partId && note.damperPedal,
  );
  if (role === "bass") {
    return pedalDown
      ? CROSS_VOICE_RELEASE_COST.bassWithPedal
      : CROSS_VOICE_RELEASE_COST.bassWithoutPedal;
  }
  if (role === "upper") {
    return pedalDown
      ? CROSS_VOICE_RELEASE_COST.upperWithPedal
      : CROSS_VOICE_RELEASE_COST.upperWithoutPedal;
  }
  return pedalDown
    ? CROSS_VOICE_RELEASE_COST.innerWithPedal
    : CROSS_VOICE_RELEASE_COST.innerWithoutPedal;
}

interface StepCost {
  parts: CostParts;
  extra: number;
  adjustments: Array<{ kind: string; points: number }>;
  /**
   * Веса шага уже с поправкой на реальную скорость этого перехода. Темп внутри
   * пьесы меняется, поэтому множитель принадлежит шагу, а не всему решению.
   */
  weights: RuleWeights;
}

interface TransitionResult {
  step: StepCost;
  touches: PositionTouch[];
  held: HeldFinger[];
}

interface SolveResult {
  chosen: number[];
  candidates: Finger[][][];
  relaxed: boolean[];
  voiceSplit: boolean[];
  /** Событие взято разложенно: аккорд шире руки, но выдержан под педалью. */
  rolled: boolean[];
  stepCosts: StepCost[];
  degradedEvents: Set<number>;
}

function solveHand(
  events: HandEvent[],
  hand: Hand,
  tables: SpanTables,
  weights: RuleWeights,
  hints: Map<number, Hint>,
): SolveResult {
  const candidateSets = events.map((event) => candidatesFor(event, hand, tables));
  const candidates = candidateSets.map((set) => set.values);
  const relaxed = candidateSets.map((set) => set.relaxed);
  const voiceSplit = candidateSets.map((set) => set.voiceSplit);
  const rolled = candidateSets.map((set) => set.rolled);
  const degradedEvents = new Set<number>();
  if (events.length === 0) {
    return {
      chosen: [],
      candidates,
      relaxed,
      voiceSplit,
      rolled,
      stepCosts: [],
      degradedEvents,
    };
  }

  const transition = (
    k: number,
    candidate: number,
    previousState: SearchState | undefined,
  ): TransitionResult | undefined => {
    const event = events[k];
    const assign = candidates[k][candidate];
    // Скорость шага задаёт не длительность в четвертях, а реальный интервал
    // между атаками: одна и та же восьмая при ♩=40 и ♩=180 требует разного.
    const stepWeights = tempoWeights(weights, event.ipiBefore);
    const parts = emptyParts();
    let extra = 0;
    const adjustments: Array<{ kind: string; points: number }> = [];
    let held = (event.hardBreakBefore ? [] : previousState?.held ?? [])
      .filter((item) => item.end > event.onset + 1e-4)
      .map((item) => ({ ...item }));

    const heldByVoice = new Map<string, HeldFinger[]>();
    for (const item of held) {
      const layer = heldByVoice.get(item.voice);
      if (layer) layer.push(item);
      else heldByVoice.set(item.voice, [item]);
    }
    const releasedVoices = new Set<string>();
    let releaseCost = 0;
    for (const [voice, layer] of heldByVoice) {
      const sameVoiceActive = event.notes.some((note) => noteVoice(note) === voice);
      let incompatible = false;
      for (const item of layer) {
        for (let index = 0; index < event.notes.length; index += 1) {
          const key = event.keys[index];
          const [lowFinger, lowKey, highFinger, highKey] =
            item.key.midi <= key.midi
              ? [item.finger, item.key, assign[index], key]
              : [assign[index], key, item.finger, item.key];
          if (
            item.finger === assign[index] ||
            !chordFeasible(tables, hand, lowFinger, lowKey, highFinger, highKey)
          ) {
            incompatible = true;
            break;
          }
        }
        if (incompatible) break;
      }
      if (!incompatible) continue;
      if (sameVoiceActive) return undefined;
      const cost = crossVoiceReleaseCost(layer, event);
      if (cost === undefined) return undefined;
      releasedVoices.add(voice);
      releaseCost += cost;
    }
    if (releasedVoices.size > 0) {
      held = held.filter((item) => !releasedVoices.has(item.voice));
      parts.voiceRelease += releaseCost;
    }

    addParts(parts, verticalParts(tables, hand, event, assign, voiceSplit[k]));

    const hint = hints.get(event.index);
    const hintMatched = Boolean(
      hint
      && (hint.fingers
        ? hint.fingers.length === assign.length
          && hint.fingers.every((finger, index) => finger === assign[index])
        : assign.length === 1 && assign[0] === hint.finger),
    );
    if (hint && hintMatched) {
      extra += hint.bonus;
      adjustments.push({ kind: hint.kind, points: hint.bonus });
    }

    if (previousState) {
      const previousCandidate = previousState.candidate;
      const previousPrevious = previousState.previousCandidate;
      const previous = events[k - 1];
      const previousAssign = candidates[k - 1][previousCandidate];
      const from = chainOf(previous, previousAssign);
      const to = chainOf(event, assign);
      const previousHint = hints.get(previous.index);
      // Фразовая лига над артикулированным аккордом — знак фразы, а не приказ
      // связать звуки пальцами: аккомпанемент играется переносом кисти.
      const articulatedUnderSlur =
        event.notes.length > 1 && event.notes.some((note) => note.staccato);
      const freePatternCrossing = Boolean(
        hint?.freeBefore &&
          hintMatched &&
          (!event.slurredBefore || articulatedUnderSlur) &&
          (hint.kind === "fiveFinger" ||
            hint.kind === "accompaniment" ||
            (hint.kind === "arpeggio" &&
              previousHint?.kind === "arpeggio" &&
              previousAssign.length === 1 &&
              previousAssign[0] === previousHint.finger)),
      );
      const broken =
        event.hardBreakBefore ||
        event.gapBefore >= FINGERING_SEARCH.resetGap ||
        freePatternCrossing;

      if (!broken) {
        const polyphonic =
          (previous.notes.length > 1 || event.notes.length > 1) &&
          isBlockTransfer(previous, event);
        addParts(parts, horizontalParts(tables, hand, from, to, polyphonic));
        // Повтор пальца на другой клавише внутри позиции физически недостижим:
        // палец нельзя снять и поставить заново, не сняв руку. Раньше это
        // проверялось только под лигой, а в остальных местах лишь оценивалось
        // в 8 очков — и покупалось, когда обход стоил дороже. Так в Clocks
        // возникало 2@C#5 → 2@B♭4 за 227 мс: переход, который сама модель
        // (`transitionFeasible`) считает нереальным. Широкий скачок и
        // скольжение с чёрной на белую остаются законными, перенос всей формы
        // руки в параллельном движении — тоже.
        if (!polyphonic && !stepReachable(tables, hand, from, to)) {
          extra += UNREACHABLE_REPEAT * tempoScale(event.ipiBefore);
          adjustments.push({ kind: "unreachableRepeat", points: UNREACHABLE_REPEAT });
        }
        if (
          event.slurredBefore &&
          previous.notes.length === 1 &&
          event.notes.length === 1
        ) {
          // Только явная MusicXML-лига означает обязательное пальцевое legato.
          // Соприкасающиеся длительности без staccato могут переартикулироваться
          // или связываться педалью и потому влияют на цену, но не отсекают путь.
          if (
            previousAssign[0] === assign[0] &&
            previous.keys[0].midi !== event.keys[0].midi
          ) {
            extra += Number.POSITIVE_INFINITY;
          }
          if (
            !transitionFeasible(tables, hand, from.lowFinger, from.lowKey, to.lowFinger, to.lowKey) ||
            !transitionFeasible(tables, hand, from.highFinger, from.highKey, to.highFinger, to.highKey)
          ) {
            extra += Number.POSITIVE_INFINITY;
          }
        }
        if (previousPrevious >= 0) {
          const older = events[k - 2];
          if (previous.gapBefore < FINGERING_SEARCH.resetGap) {
            addParts(
              parts,
              tripleParts(
                tables,
                hand,
                chainOf(older, candidates[k - 2][previousPrevious]),
                from,
                to,
              ),
            );
          }
        }
      }

      // Правила 10 и 11 для предыдущего события: соседи известны только сейчас.
      addParts(
        parts,
        blackParts(
          previous,
          previousAssign,
          events[k - 2],
          broken ? undefined : event,
          previousPrevious >= 0 ? candidates[k - 2][previousPrevious] : undefined,
          broken ? undefined : assign,
        ),
      );

      // Повторяющаяся нота: быстрый повтор — чередование, медленный — тот же палец.
      if (previous.notes.length === 1 && event.notes.length === 1 &&
          previous.keys[0].midi === event.keys[0].midi) {
        const fast = event.notes[0].duration <= FINGERING_SEARCH.fastRepeat;
        const same = previousAssign[0] === assign[0];
        if (fast && !same) {
          extra += PEDAGOGY.priors.repeatAlternation;
          adjustments.push({
            kind: "repeatAlternation",
            points: PEDAGOGY.priors.repeatAlternation,
          });
        }
        if (!fast && same) {
          extra += PEDAGOGY.priors.repeatSame;
          adjustments.push({ kind: "repeatSame", points: PEDAGOGY.priors.repeatSame });
        }
      }
    }

    const context = positionContext(
      previousState?.touches ?? [], event, assign, hand, tables,
      Boolean(hint?.freeBefore && hintMatched && !event.slurredBefore),
    );
    if (context.cost) {
      extra += context.cost;
      adjustments.push({ kind: "positionContinuity", points: context.cost });
    }
    held.push(
      ...event.notes
        .filter((note) => note.duration > 0)
        .map((note, index) => ({
          noteIndex: note.index,
          finger: assign[index],
          partId: note.partId,
          voice: noteVoice(note),
          key: event.keys[index],
          end: note.onset + note.duration,
        })),
    );
    held.sort((left, right) => left.noteIndex - right.noteIndex);
    return { step: { parts, extra, adjustments, weights: stepWeights }, held, touches: context.touches };
  };

  // Rank partial paths by an estimate of the entire remaining score, across bars.
  // This pairwise relaxation omits held-note and three-note constraints; the
  // forward solver remains authoritative and this potential is not a guarantee.
  const future = futureCosts(candidates.map(set => set.length), (k, fromIndex, toIndex) => {
    const previous = events[k - 1];
    const event = events[k];
    const assign = candidates[k][toIndex];
    const from = candidates[k - 1][fromIndex];
    const parts = verticalParts(tables, hand, event, assign, voiceSplit[k]);
    const hint = hints.get(event.index);
    const matched = hint && (hint.fingers
      ? hint.fingers.every((finger, i) => finger === assign[i])
      : assign.length === 1 && hint.finger === assign[0]);
    if (!event.hardBreakBefore && event.gapBefore < FINGERING_SEARCH.resetGap &&
        !(matched && hint.freeBefore && !event.slurredBefore)) {
      addParts(parts, horizontalParts(tables, hand, chainOf(previous, from),
        chainOf(event, assign), isBlockTransfer(previous, event)));
    }
    return weigh(parts, tempoWeights(weights, event.ipiBefore)) + (matched ? hint.bonus : 0);
  });

  let layer = new Map<string, SearchState>();
  for (let candidate = 0; candidate < candidates[0].length; candidate += 1) {
    const result = transition(0, candidate, undefined);
    if (!result) continue;
    const key = stateKey(-1, candidate, result.held, result.touches);
    layer.set(key, {
      key,
      cost: stepValue(result.step, weights),
      previousKey: null,
      candidate,
      previousCandidate: -1,
      touches: result.touches,
      held: result.held,
      step: result.step,
    });
  }

  const history: Array<Map<string, SearchState>> = [layer];
  for (let k = 1; k < events.length; k += 1) {
    const next = new Map<string, SearchState>();
    for (const state of layer.values()) {
      for (let candidate = 0; candidate < candidates[k].length; candidate += 1) {
        const result = transition(k, candidate, state);
        if (!result) continue;
        const cost = state.cost + stepValue(result.step, weights);
        if (!Number.isFinite(cost)) continue;
        const key = stateKey(state.candidate, candidate, result.held, result.touches);
        const existing = next.get(key);
        if (
          !existing ||
          cost < existing.cost - 1e-9 ||
          (Math.abs(cost - existing.cost) <= 1e-9 &&
            fingerSum(candidates[k][candidate]) < fingerSum(candidates[k][existing.candidate]))
        ) {
          next.set(key, {
            key,
            cost,
            previousKey: state.key,
            candidate,
            previousCandidate: state.candidate,
            touches: result.touches,
            held: result.held,
            step: result.step,
          });
        }
      }
    }
    if (next.size === 0) {
      // Слой может опустеть из-за противоречивых авторских ограничений или
      // неразрешимого удержания внутри одного голоса. Сегмент продолжается,
      // но событие помечается как деградация и не печатается.
      degradedEvents.add(k);
      const previous = bestState(layer);
      for (let candidate = 0; candidate < candidates[k].length; candidate += 1) {
        const parts = verticalParts(
          tables,
          hand,
          events[k],
          candidates[k][candidate],
          voiceSplit[k],
        );
        const step: StepCost = {
          parts,
          extra: 0,
          adjustments: [],
          weights: tempoWeights(weights, events[k].ipiBefore),
        };
        const held = events[k].notes.map((note, index) => ({
          noteIndex: note.index,
          finger: candidates[k][candidate][index],
          partId: note.partId,
          voice: noteVoice(note),
          key: events[k].keys[index],
          end: note.onset + note.duration,
        }));
        const touches = positionContext([], events[k], candidates[k][candidate], hand, tables).touches;
        const key = stateKey(-1, candidate, held, touches);
        next.set(key, {
          key,
          cost: (previous?.cost ?? 0) + stepValue(step, weights),
          previousKey: previous?.key ?? null,
          candidate,
          previousCandidate: -1,
          held,
          touches,
          step,
        });
      }
    }
    layer = prune(next, FINGERING_SEARCH.beam, future[k]);
    history.push(layer);
  }

  // Правила 10 и 11 для последнего события: следующего соседа нет.
  let best: SearchState | undefined;
  const tailWeights = tempoWeights(weights, events[events.length - 1].ipiBefore);
  for (const state of layer.values()) {
    const tail =
      state.cost +
      weigh(
        blackParts(
          events[events.length - 1],
          candidates[events.length - 1][state.candidate],
          events[events.length - 2],
          undefined,
          state.previousCandidate >= 0
            ? candidates[events.length - 2]?.[state.previousCandidate]
            : undefined,
          undefined,
        ),
        tailWeights,
      );
    if (!best || tail < best.cost) best = { ...state, cost: tail };
  }

  const chosen: number[] = new Array(events.length).fill(0);
  const selectedStates: SearchState[] = new Array(events.length);
  let cursor: SearchState | undefined = best ? layer.get(best.key) : undefined;
  for (let k = events.length - 1; k >= 0 && cursor; k -= 1) {
    chosen[k] = cursor.candidate;
    selectedStates[k] = cursor;
    const previousKey: string | null = cursor.previousKey;
    cursor = previousKey === null ? undefined : history[k - 1]?.get(previousKey);
  }

  const stepCosts = selectedStates.map((state) => ({
    parts: { ...state.step.parts },
    extra: state.step.extra,
    adjustments: [...state.step.adjustments],
    weights: state.step.weights,
  }));
  addParts(
    stepCosts[stepCosts.length - 1].parts,
    blackParts(
      events[events.length - 1],
      candidates[events.length - 1][chosen[events.length - 1]],
      events[events.length - 2],
      undefined,
      events.length >= 2
        ? candidates[events.length - 2][chosen[events.length - 2]]
        : undefined,
      undefined,
    ),
  );

  return {
    chosen,
    candidates,
    relaxed,
    voiceSplit,
    rolled,
    stepCosts,
    degradedEvents,
  };
}

function stepValue(step: StepCost, weights: RuleWeights): number {
  return weigh(step.parts, step.weights ?? weights) + step.extra;
}

function stateKey(previous: number, candidate: number, held: HeldFinger[], touches: PositionTouch[]): string {
  const active = held
    .map((item) => `${item.noteIndex}:${item.finger}`)
    .sort()
    .join(",");
  const position = touches.map(touch => `${touch.voice}:${touch.key.midi}:${touch.finger}:${touch.onset}`).join(",");
  return `${previous}|${candidate}|${active}|${position}`;
}

function fingerSum(assign: Finger[]): number {
  return assign.reduce((total, finger) => total + finger, 0);
}

function prune(states: Map<string, SearchState>, beam: number, future: number[]): Map<string, SearchState> {
  if (states.size <= beam) return states;
  const sorted = [...states.values()].sort((left, right) =>
    (left.cost + future[left.candidate]) - (right.cost + future[right.candidate]) || left.key.localeCompare(right.key));
  return new Map(sorted.slice(0, beam).map((state) => [state.key, state]));
}

function bestState(states: Map<string, SearchState>): SearchState | undefined {
  let best: SearchState | undefined;
  for (const state of states.values()) if (!best || state.cost < best.cost) best = state;
  return best;
}

/* ------------------------------------------------------------------ *
 * Публичный вход
 * ------------------------------------------------------------------ */

export function planFingering(xml: string, options: FingeringOptions = {}): FingeringPlan {
  const score = parseScore(xml);
  const mode = options.mode ?? "fill";
  const tables = spanTables(HAND_SPAN_SCALE[options.handSpan ?? "medium"]);
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const warnings = [...score.warnings];

  const playable = score.notes.filter(isPlayable);
  const coverage = coverageOf(score);
  const assignments = new Map<number, Finger>();
  const hands = new Map<number, Hand>();
  const suppressed = new Set<number>();
  const trace: FingeringTrace[] = [];
  const patterns: FingeringPattern[] = [];

  if (playable.length === 0) {
    warnings.push("В партитуре нет звучащих нот с высотой.");
    return {
      assignments,
      hands,
      suppressed,
      trace,
      report: emptyReport(coverage, warnings),
    };
  }

  const eligible = playable.filter(
    (note) => Number(note.staff) <= 2 && note.partIndex <= 1,
  );
  const ignored = playable.length - eligible.length;
  if (ignored > 0) {
    warnings.push(
      `Пропущено нот вне первых двух нотоносцев/партий: ${ignored}; аппликатура строится только для фортепианного слоя.`,
    );
  }

  const resolveHand = handResolver(score, eligible);
  for (const note of eligible) hands.set(note.index, resolveHand(note));
  const crossHandTransfers = redistributeUnplayableDyads(
    score,
    eligible,
    hands,
    tables,
  );

  const inherited = new Map<number, number>();
  const tieSources = new Map<number, number>();
  const measures = new Map<number, MeasureLoad>();
  const unprintableByMeasure = new Map<
    string,
    {
      measureIndex: number;
      measureNumber: string;
      hand: Hand;
      events: number;
      notes: number;
    }
  >();
  /** Выдержанные аккорды шире руки: цифры печатаются, приём объясняется. */
  const rolledByMeasure = new Map<
    string,
    { measureIndex: number; measureNumber: string; hand: Hand; span: number }
  >();
  let positionChanges = 0;
  let thumbOnBlack = 0;
  let objectiveCost = 0;
  let ergonomicCost = 0;
  let patternNotes = 0;
  const counts: Record<Hand, number> = { R: 0, L: 0 };

  for (const hand of ["R", "L"] as Hand[]) {
    const handNotes = eligible.filter((note) => hands.get(note.index) === hand);
    if (handNotes.length === 0) continue;

    // Продолжение лиги-tie наследует палец атаки и в поиске не участвует.
    const activeTies = new Map<string, ParsedNote>();
    const attacks = handNotes.filter((note) => {
      const key = `${note.partId}:${note.staff}:${note.voice}:${note.midi}`;
      const source = note.tieStop ? activeTies.get(key) : undefined;
      if (source) {
        tieSources.set(note.index, source.index);
        if (!note.tieStart) activeTies.delete(key);
        return false;
      }
      if (note.tieStart) activeTies.set(key, note);
      return true;
    });

    const events = buildEvents(attacks, mode, inherited);
    const detected = detectPatterns(events, hand, score, tables, weights);
    patterns.push(...detected.patterns);

    // Первый проход: полный контекст, никаких ограничений по повторам.
    let solved = solveHand(events, hand, tables, weights, detected.hints);
    // Приоры, действовавшие на итоговом решении: отчёт должен считать нотами
    // в фигурах и те, что пришли из согласования повторов.
    let effectiveHints: ReadonlyMap<number, Hint> = detected.hints;
    // Второй проход: одинаковые фигуры получают одну форму руки. Кандидатов
    // придумывает не этот слой, а первый проход — см. `fingering-motifs.ts`.
    const consolidated = consolidateMotifs(
      events,
      new Map(events.map((event, k) => [event.index, solved.candidates[k][solved.chosen[k]]])),
      hand,
      tables,
      weights,
      detected.covered,
    );
    if (consolidated.fingers.size > 0) {
      const merged = new Map(detected.hints);
      for (const [eventIndex, assign] of consolidated.fingers) {
        if (merged.has(eventIndex)) continue;
        merged.set(eventIndex, {
          finger: assign[0],
          fingers: assign,
          bonus: PEDAGOGY.priors.ostinato,
          kind: "ostinato",
        });
      }
      solved = solveHand(events, hand, tables, weights, merged);
      effectiveHints = merged;
      for (const cycle of consolidated.cycles) {
        patterns.push({
          kind: "ostinato",
          hand,
          fromMeasure: cycle.fromMeasure,
          toMeasure: cycle.toMeasure,
          label: "повторяющаяся фигура",
        });
      }
    }

    // Третий проход: одинаковый материал, стоящий не подряд. Смежные повторы
    // уже сведены выше; здесь выравнивается такт, вернувшийся через страницу.
    const recurring = consolidateRecurrences(
      events,
      new Map(events.map((event, k) => [event.index, solved.candidates[k][solved.chosen[k]]])),
      hand,
      tables,
      weights,
      detected.covered,
    );
    if (recurring.size > 0) {
      const merged = new Map(effectiveHints);
      for (const [eventIndex, assign] of recurring) {
        merged.set(eventIndex, {
          finger: assign[0],
          fingers: assign,
          bonus: PEDAGOGY.priors.ostinato,
          kind: "ostinato",
        });
      }
      solved = solveHand(events, hand, tables, weights, merged);
      effectiveHints = merged;
    }
    const { chosen, candidates, relaxed, voiceSplit, rolled, stepCosts, degradedEvents } = solved;

    for (let k = 0; k < events.length; k += 1) {
      const event = events[k];
      const assign = candidates[k][chosen[k]];
      const step = stepCosts[k];
      const parts = step.parts;
      // Отчёт намеренно считается базовыми весами: темповый множитель нужен
      // решателю, а метрика должна оставаться сравнимой между ревизиями.
      const rawCost = weigh(parts, weights);
      const totalStepCost = rawCost + step.extra;
      const printable = !relaxed[k] && !degradedEvents.has(k);
      const countedNotes = printable ? event.notes.filter((note) => !note.grace).length : 0;
      ergonomicCost += rawCost;
      objectiveCost += totalStepCost;
      // Считаем события, а не очки: очки правила 4 равны 2 за полную смену.
      const changed = printable && parts.positionChangeCount > 0 ? 1 : 0;
      positionChanges += changed;
      thumbOnBlack += printable
        ? assign.filter(
            (finger, index) => !event.notes[index].grace && finger === 1 && event.keys[index].black,
          ).length
        : 0;
      counts[hand] += countedNotes;

      if (printable && rolled[k]) {
        const midis = event.notes.map((note) => note.midi as number);
        const span = Math.max(...midis) - Math.min(...midis);
        const rolledKey = `${event.measureIndex}:${hand}`;
        const previous = rolledByMeasure.get(rolledKey);
        if (!previous || span > previous.span) {
          rolledByMeasure.set(rolledKey, {
            measureIndex: event.measureIndex,
            measureNumber: event.measureNumber,
            hand,
            span,
          });
        }
      }

      if (!printable) {
        for (const note of event.notes) suppressed.add(note.index);
        const warningKey = `${event.measureIndex}:${hand}`;
        const aggregate = unprintableByMeasure.get(warningKey) ?? {
          measureIndex: event.measureIndex,
          measureNumber: event.measureNumber,
          hand,
          events: 0,
          notes: 0,
        };
        aggregate.events += 1;
        aggregate.notes += event.notes.length;
        unprintableByMeasure.set(warningKey, aggregate);
      }

      const load = measures.get(event.measureIndex) ?? {
        index: event.measureIndex,
        number: event.measureNumber,
        right: { positionChanges: 0, cost: 0 },
        left: { positionChanges: 0, cost: 0 },
      };
      const side = hand === "R" ? load.right : load.left;
      side.positionChanges += changed;
      side.cost += printable ? rawCost : 0;
      measures.set(event.measureIndex, load);

      const hint = effectiveHints.get(event.index);
      const hintApplied = Boolean(
        hint
        && (hint.fingers
          ? hint.fingers.length === assign.length
            && hint.fingers.every((finger, index) => finger === assign[index])
          : assign.length === 1 && assign[0] === hint.finger),
      );
      if (printable && hintApplied) patternNotes += countedNotes;

      for (let i = 0; i < event.notes.length; i += 1) {
        assignments.set(event.notes[i].index, assign[i]);
        if (options.trace && printable) {
          trace.push({
            noteIndex: event.notes[i].index,
            measure: event.measureNumber,
            hand,
            midi: event.keys[i].midi,
            finger: assign[i],
            pattern: hintApplied ? hint?.kind : undefined,
            // В трассировку идёт вклад в цель, а не сырые очки правила:
            // отключённое весом правило не должно выглядеть причиной выбора.
            reasons: (Object.keys(parts) as Array<keyof CostParts>)
              .map((rule) => ({ rule, points: parts[rule] * step.weights[rule] }))
              .filter((reason) => reason.points > 0)
              .sort((left, right) => right.points - left.points)
              .slice(0, 4)
              .map((reason) => ({ rule: reason.rule, points: Number(reason.points.toFixed(2)) })),
            adjustments: [
              ...step.adjustments.map((adjustment) => ({
                kind: adjustment.kind,
                points: Number(adjustment.points.toFixed(2)),
              })),
              ...(crossHandTransfers.has(event.notes[i].index)
                ? [{ kind: "crossHandTransfer", points: 0 }]
                : []),
            ],
          });
        }
      }
      for (const note of event.spilled) {
        const source = inherited.get(note.index);
        const sourceFinger = source === undefined ? undefined : assignments.get(source);
        if (sourceFinger) assignments.set(note.index, sourceFinger);
        suppressed.add(note.index);
      }
    }
    const spilledMeasures = [
      ...new Set(
        events
          .filter((event) => event.spilled.length > 0)
          .map((event) => event.measureNumber),
      ),
    ];
    if (spilledMeasures.length > 0) {
      warnings.push(
        `Такты ${spilledMeasures.join(", ")}: в одной руке больше пяти одновременных нот; лишние цифры подавлены, соседний палец сохранён только во внутреннем плане.`,
      );
    }
  }

  for (const aggregate of [...rolledByMeasure.values()].sort(
    (left, right) =>
      left.measureIndex - right.measureIndex || left.hand.localeCompare(right.hand),
  )) {
    const side = aggregate.hand === "R" ? "правая" : "левая";
    warnings.push(
      `Такт ${aggregate.measureNumber}, ${side} рука: аккорд шире руки `
      + `(${aggregate.span} ${semitoneWord(aggregate.span)}) — `
      + "берётся снизу вверх под педалью, а не разом; цифры показывают порядок пальцев.",
    );
  }

  for (const aggregate of [...unprintableByMeasure.values()].sort(
    (left, right) =>
      left.measureIndex - right.measureIndex || left.hand.localeCompare(right.hand),
  )) {
    const side = aggregate.hand === "R" ? "правая" : "левая";
    warnings.push(
      aggregate.events === 1
        ? `Такт ${aggregate.measureNumber}, ${side} рука: физически допустимая форма не найдена; автоматические цифры для события не напечатаны.`
        : `Такт ${aggregate.measureNumber}, ${side} рука: физически допустимая форма не найдена для нескольких событий (событий: ${aggregate.events}, нот: ${aggregate.notes}); автоматические цифры для них не напечатаны.`,
    );
  }

  for (const [target, source] of tieSources) {
    const finger = assignments.get(source);
    if (finger) assignments.set(target, finger);
    suppressed.add(target);
  }
  for (const [target, source] of inherited) {
    const finger = assignments.get(source);
    if (finger && !assignments.has(target)) assignments.set(target, finger);
  }

  const comparison =
    options.comparisonFingerings ??
    new Map(
      playable
        .filter((note) => note.fingering !== undefined)
        .map((note) => [note.index, note.fingering as Finger]),
    );
  const matched = [...comparison].filter(
    ([noteIndex, finger]) => assignments.get(noteIndex) === finger,
  ).length;
  const notes = counts.R + counts.L;

  return {
    assignments,
    hands,
    suppressed,
    trace,
    report: {
      coverage,
      measures: [...measures.values()].sort((left, right) => left.index - right.index),
      patterns,
      stats: {
        notes,
        rightNotes: counts.R,
        leftNotes: counts.L,
        positionChanges: Number(positionChanges.toFixed(1)),
        thumbOnBlack: Number(thumbOnBlack.toFixed(1)),
        costPerNote: notes === 0 ? 0 : Number((objectiveCost / notes).toFixed(3)),
        ergonomicCostPerNote:
          notes === 0 ? 0 : Number((ergonomicCost / notes).toFixed(3)),
        pedagogyAdjustmentPerNote:
          notes === 0 ? 0 : Number(((objectiveCost - ergonomicCost) / notes).toFixed(3)),
        patternNotes,
      },
      existing: { matched, total: comparison.size },
      warnings: [...new Set(warnings)],
    },
  };
}

function emptyReport(coverage: FingeringCoverage, warnings: string[]): FingeringReport {
  return {
    coverage,
    measures: [],
    patterns: [],
    stats: {
      notes: 0,
      rightNotes: 0,
      leftNotes: 0,
      positionChanges: 0,
      thumbOnBlack: 0,
      costPerNote: 0,
      ergonomicCostPerNote: 0,
      pedagogyAdjustmentPerNote: 0,
      patternNotes: 0,
    },
    existing: { matched: 0, total: 0 },
    warnings: [...new Set(warnings)],
  };
}
