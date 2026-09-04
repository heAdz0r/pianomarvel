/**
 * Независимый педагогический слой аппликатуры: распознавание устойчивых
 * учебных фигур и приоры, которые он передаёт общему beam-поиску.
 */

import {
  isBlackKey,
  type Finger,
  type Hand,
  type RuleWeights,
  type SpanTables,
} from "./fingering-model";
import { findCycles } from "./fingering-motifs";
import { applyPositionFrame } from "./fingering-frames";
import type { ParsedNote, ParsedScore } from "./fingering-score";
import {
  FINGERING_SEARCH,
  type FingeringPattern,
  type HandEvent,
  type Hint,
} from "./fingering-types";

export type { FingeringPattern, HandEvent, Hint } from "./fingering-types";

/**
 * Константы педагогического слоя. Каждая — с музыкальным обоснованием;
 * тест чувствительности не даёт им превратиться в подгонку.
 */
export const PEDAGOGY = {
  /** Минимальная длина гаммообразного пассажа. */
  scaleRun: 8,
  /** Минимальная длина арпеджио. */
  arpeggioRun: 6,
  /**
   * Приоры паттернов (отрицательные — это скидка).
   *
   * Величина не подгонка, а измеренный компромисс. Замер по локальному корпусу
   * (согласие с авторской аппликатурой, gold-тесты канонических гамм):
   *
   *   приор | Hanon  | гаммы  | канон гамм в тестах
   *    −8   | 0.7507 | 0.9563 | ломается (фа мажор)
   *   −12   | 0.7517 | 0.9805 | держится
   *   −16   | 0.7555 | 0.9862 | держится
   *   −20   | 0.7536 | 0.9885 | держится
   *
   * Взято −16: лучшее согласие с живой авторской аппликатурой Hanon при
   * сохранении школьного канона. Меньшие значения проигрывают потому, что
   * модель Parncutt по своей природе одноголосно-эргономична и не знает правил
   * школы: без доминирующей скидки она предпочитает локально удобные, но
   * непедагогичные варианты. Это ограничение, выраженное ценой, а не вес в
   * смысле §6.8 — уменьшать его без повторного замера нельзя.
   */
  priors: {
    scale: -16,
    fiveFinger: -16,
    arpeggio: -8,
    alberti: -3,
    ostinato: -16,
    accompaniment: -10,
    repeatAlternation: -2,
    repeatSame: -1,
  },
};

/* ------------------------------------------------------------------ *
 * Педагогические паттерны
 * ------------------------------------------------------------------ */

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const NATURAL_MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];
const HARMONIC_MINOR_STEPS = [0, 2, 3, 5, 7, 8, 11];
const MELODIC_MINOR_STEPS = [0, 2, 3, 5, 7, 9, 11];

/**
 * Расстановка больших пальцев в гамме. Выводится из трёх правил школы:
 * большой палец только на белой клавише, между большими пальцами 3 или 4
 * ступени, 4-й палец в октаве один раз. Критерии выбора отличаются для рук —
 * см. docs/fingering-prd.md §6.6.1.
 */
export function scaleThumbDegrees(scalePitchClasses: number[], hand: Hand): number[] {
  const white = scalePitchClasses.map((pc) => !isBlackKey(60 + pc));
  const candidates: number[][] = [];
  for (let degree = 0; degree < 7; degree += 1) {
    const other = (degree + 3) % 7;
    if (white[degree] && white[other]) {
      const pair = [degree, other].sort((a, b) => a - b);
      if (!candidates.some((item) => item[0] === pair[0] && item[1] === pair[1])) {
        candidates.push(pair);
      }
    }
  }
  if (candidates.length === 0) return [];

  const blackGroups: Array<{ first: number; last: number }> = [];
  for (let degree = 0; degree < 7; degree += 1) {
    if (white[degree]) continue;
    const previous = (degree + 6) % 7;
    if (!white[previous]) continue;
    let last = degree;
    while (!white[(last + 1) % 7]) last = (last + 1) % 7;
    blackGroups.push({ first: degree, last });
  }

  const scored = candidates.map((thumbs) => {
    const fingers = degreeFingers(thumbs, hand);
    const fourDegree = fingers.indexOf(4);
    const hasBlack = white.some((value) => !value);
    const blackFollowed = blackGroups.every((group) => thumbs.includes((group.last + 1) % 7));
    const blackPreceded = blackGroups.every((group) => thumbs.includes((group.first + 6) % 7));
    const fourOnBlack = fourDegree >= 0 && !white[fourDegree];
    const thumbOnTonic = thumbs.includes(0);
    const fiveOnTonic = thumbs.includes(0) && thumbs.includes(4);
    const tonicStartsThreeGroup =
      thumbOnTonic && thumbs.includes(3);
    const score =
      hand === "R"
        ? [
            blackFollowed ? 1 : 0,
            hasBlack && fourOnBlack ? 1 : 0,
            thumbOnTonic ? 1 : 0,
            tonicStartsThreeGroup ? 1 : 0,
          ]
        : [
            fiveOnTonic ? 1 : 0,
            blackPreceded ? 1 : 0,
            hasBlack && fourOnBlack ? 1 : 0,
            thumbOnTonic ? 1 : 0,
          ];
    return { thumbs, score };
  });

  scored.sort((left, right) => {
    for (let i = 0; i < left.score.length; i += 1) {
      if (left.score[i] !== right.score[i]) return right.score[i] - left.score[i];
    }
    return left.thumbs[0] - right.thumbs[0];
  });
  return scored[0].thumbs;
}

/** Палец для каждой ступени: в правой руке вверх от большого, в левой — вниз. */
export function degreeFingers(thumbs: number[], hand: Hand): Finger[] {
  return Array.from({ length: 7 }, (_, degree) => {
    let distance = 0;
    while (distance < 7) {
      const probe = hand === "R" ? (degree - distance + 7) % 7 : (degree + distance) % 7;
      if (thumbs.includes(probe)) break;
      distance += 1;
    }
    return Math.min(5, distance + 1) as Finger;
  });
}

function scaleStepsFor(
  pitchClasses: Set<number>,
  tonic: number,
  mode: "major" | "minor" | "any" = "any",
): number[] | undefined {
  const candidates =
    mode === "major"
      ? [MAJOR_STEPS]
      : mode === "minor"
        ? [NATURAL_MINOR_STEPS, HARMONIC_MINOR_STEPS, MELODIC_MINOR_STEPS]
        : [MAJOR_STEPS, NATURAL_MINOR_STEPS, HARMONIC_MINOR_STEPS, MELODIC_MINOR_STEPS];
  for (const steps of candidates) {
    const scale = new Set(steps.map((step) => (tonic + step) % 12));
    if ([...pitchClasses].every((pc) => scale.has(pc))) return steps;
  }
  return undefined;
}

export function detectPatterns(
  events: HandEvent[],
  hand: Hand,
  score: ParsedScore,
  tables: SpanTables,
  weights: RuleWeights,
): { hints: Map<number, Hint>; patterns: FingeringPattern[]; covered: Set<number> } {
  const hints = new Map<number, Hint>();
  const patterns: FingeringPattern[] = [];
  const single = events.map((event) =>
    event.notes.length === 1 && !event.notes[0].grace ? event.keys[0].midi : undefined,
  );

  const covered = new Set<number>();
  const cover = (start: number, length: number): void => {
    for (let offset = 0; offset < length; offset += 1) covered.add(start + offset);
  };

  // Измеренный повтор — более сильное свидетельство, чем случайное совпадение
  // трёх нот с формой арпеджио: короткий шаблонный обрывок внутри цикла
  // уступает общему слою, а длинные школьные фигуры — нет.
  const cycled = new Set<number>();
  for (const cycle of findCycles(events)) {
    for (let offset = 0; offset < cycle.length; offset += 1) cycled.add(cycle.start + offset);
  }

  let index = 0;
  while (index < events.length) {
    const frame = applyPositionFrame(events, index, hand, tables, weights, hints, PEDAGOGY.priors.fiveFinger);
    if (frame > 0) {
      patterns.push({ kind: "fiveFinger", hand, fromMeasure: events[index].measureIndex,
        toMeasure: events[index + frame - 1].measureIndex, label: "единая позиция повторяющейся фигуры" });
      cover(index, frame);
      index += frame;
      continue;
    }
    const fiveFinger = applyFiveFingerCellHint(events, single, index, hand, hints);
    if (fiveFinger > 0) {
      patterns.push({
        kind: "fiveFinger",
        hand,
        fromMeasure: events[index].measureIndex,
        toMeasure: events[index + fiveFinger - 1].measureIndex,
        label: "устойчивая пятипальцевая позиция",
      });
      cover(index, fiveFinger);
      index += fiveFinger;
      continue;
    }
    const scale = extendRun(
      single,
      events,
      index,
      (step) => Math.abs(step) >= 1 && Math.abs(step) <= 3,
    );
    if (scale >= PEDAGOGY.scaleRun) {
      const applied = applyScaleHint(events, single, index, scale, hand, score, hints);
      if (applied) {
        patterns.push({
          kind: "scale",
          hand,
          fromMeasure: events[index].measureIndex,
          toMeasure: events[index + scale - 1].measureIndex,
          label: applied,
        });
        cover(index, scale);
        index += scale;
        continue;
      }
    }
    const arpeggioArch = applyArpeggioArchHint(single, events, index, hand, hints);
    if (arpeggioArch > 0) {
      patterns.push({
        kind: "arpeggio",
        hand,
        fromMeasure: events[index].measureIndex,
        toMeasure: events[index + arpeggioArch - 1].measureIndex,
        label: "арпеджио",
      });
      cover(index, arpeggioArch);
      index += arpeggioArch;
      continue;
    }
    const arpeggio = extendRun(
      single,
      events,
      index,
      (step) => Math.abs(step) >= 3 && Math.abs(step) <= 5,
    );
    if (arpeggio >= PEDAGOGY.arpeggioRun && applyArpeggioHint(single, index, arpeggio, hand, hints)) {
      patterns.push({
        kind: "arpeggio",
        hand,
        fromMeasure: events[index].measureIndex,
        toMeasure: events[index + arpeggio - 1].measureIndex,
        label: "арпеджио",
      });
      cover(index, arpeggio);
      index += arpeggio;
      continue;
    }
    const accompaniment = applyAccompanimentHint(events, index, hand, hints);
    if (accompaniment) {
      patterns.push({
        kind: "accompaniment",
        hand,
        fromMeasure: events[index].measureIndex,
        toMeasure: events[index + accompaniment.length - 1].measureIndex,
        label: accompaniment.label,
      });
      cover(index, accompaniment.length);
      index += accompaniment.length;
      continue;
    }
    const alberti = applyAlbertiHint(single, index, hand, hints);
    if (alberti > 0) {
      patterns.push({
        kind: "alberti",
        hand,
        fromMeasure: events[index].measureIndex,
        toMeasure: events[index + alberti - 1].measureIndex,
        label: "альбертиев бас",
      });
      cover(index, alberti);
      index += alberti;
      continue;
    }
    if (
      arpeggio >= 3 &&
      arpeggio <= 4 &&
      !cycled.has(index) &&
      applyArpeggioFragmentHint(single, events, index, arpeggio, hand, hints)
    ) {
      patterns.push({
        kind: "arpeggio",
        hand,
        fromMeasure: events[index].measureIndex,
        toMeasure: events[index + arpeggio - 1].measureIndex,
        label: "короткое арпеджио",
      });
      cover(index, arpeggio);
      index += arpeggio;
      continue;
    }
    index += 1;
  }

  // `covered` отдаётся наружу: согласование повторяющихся фигур не должно
  // трогать участки, у которых уже есть школьное решение со своим приором.
  return { hints, patterns, covered };
}

/**
 * Компактная учебная ячейка с неизменной рамкой руки.
 *
 * Это структурный, а не корпусный детектор: одна beam-группа (или целый такт
 * без beam-разметки), равные короткие длительности, ровно пять высот в
 * диапазоне не шире большой сексты. В такой фигуре повтор одной высоты тем же
 * пальцем и зеркальная карта рук педагогически важнее общего штрафа WeakFinger.
 */
function applyFiveFingerCellHint(
  events: HandEvent[],
  single: Array<number | undefined>,
  start: number,
  hand: Hand,
  hints: Map<number, Hint>,
): number {
  const first = events[start];
  if (!first || single[start] === undefined) return 0;

  let end = start;
  if (first.beamBegin) {
    while (
      end < events.length &&
      events[end].measureIndex === first.measureIndex &&
      single[end] !== undefined
    ) {
      if (events[end].beamEnd) break;
      end += 1;
    }
    if (end >= events.length || !events[end].beamEnd) return 0;
  } else {
    const atMeasureStart =
      start === 0 || events[start - 1].measureIndex !== first.measureIndex;
    if (!atMeasureStart) return 0;
    while (
      end + 1 < events.length &&
      events[end + 1].measureIndex === first.measureIndex &&
      single[end + 1] !== undefined
    ) {
      end += 1;
    }
    if (events.slice(start, end + 1).some((event) => event.beamBegin || event.beamEnd)) {
      return 0;
    }
  }

  const length = end - start + 1;
  if (length < 7) return 0;
  const cell = events.slice(start, end + 1);
  const voice = first.notes[0].voice;
  const duration = first.notes[0].duration;
  if (
    duration <= 0 ||
    duration > FINGERING_SEARCH.fastRepeat ||
    cell.some(
      (event, offset) =>
        event.notes.length !== 1 ||
        event.notes[0].grace ||
        event.notes[0].voice !== voice ||
        Math.abs(event.notes[0].duration - duration) > 1e-4 ||
        (offset > 0 && event.gapBefore > 1e-4),
    )
  ) {
    return 0;
  }

  const pitches = [...new Set(single.slice(start, end + 1) as number[])].sort(
    (left, right) => left - right,
  );
  if (pitches.length !== 5 || pitches[4] - pitches[0] > 9) return 0;

  const fingerByPitch = new Map<number, Finger>(
    pitches.map((midi, rank) => [
      midi,
      (hand === "R" ? rank + 1 : 5 - rank) as Finger,
    ]),
  );
  for (let offset = 0; offset < length; offset += 1) {
    hints.set(events[start + offset].index, {
      finger: fingerByPitch.get(single[start + offset] as number) as Finger,
      bonus: PEDAGOGY.priors.fiveFinger,
      kind: "fiveFinger",
      freeBefore: offset === 0,
    });
  }
  return length;
}

/** Длина однонаправленного пробега от `start`, шаги которого проходят проверку. */
function extendRun(
  single: Array<number | undefined>,
  events: HandEvent[],
  start: number,
  accept: (step: number) => boolean,
): number {
  const first = single[start];
  const second = single[start + 1];
  if (first === undefined || second === undefined) return 0;
  if (events[start + 1].gapBefore > 1e-4) return 0;
  if (!sameKeyContext(events[start], events[start + 1])) return 0;
  const direction = Math.sign(second - first);
  if (direction === 0 || !accept(second - first)) return 0;
  let length = 2;
  while (start + length < single.length) {
    if (events[start + length].gapBefore > 1e-4) break;
    if (!sameKeyContext(events[start + length - 1], events[start + length])) break;
    const previous = single[start + length - 1];
    const current = single[start + length];
    if (previous === undefined || current === undefined) break;
    const step = current - previous;
    if (Math.sign(step) !== direction || !accept(step)) break;
    length += 1;
  }
  return length;
}

function sameKeyContext(left: HandEvent, right: HandEvent): boolean {
  const a = left.notes[0];
  const b = right.notes[0];
  return a.keyFifths === b.keyFifths && a.keyMode === b.keyMode;
}

function applyScaleHint(
  events: HandEvent[],
  single: Array<number | undefined>,
  start: number,
  length: number,
  hand: Hand,
  score: ParsedScore,
  hints: Map<number, Hint>,
): string | undefined {
  const pitchClasses = new Set<number>();
  for (let i = start; i < start + length; i += 1) {
    pitchClasses.add(((single[i] as number) % 12 + 12) % 12);
  }
  if (pitchClasses.size < 5) return undefined;

  const scale = resolveScale(pitchClasses, events[start].notes[0], score, single, start, length);
  if (!scale) return undefined;
  const { tonic, steps } = scale;

  const scalePitchClasses = steps.map((step) => (tonic + step) % 12);
  const thumbs = scaleThumbDegrees(scalePitchClasses, hand);
  if (thumbs.length === 0) return undefined;
  const fingers = degreeFingers(thumbs, hand);

  const run: Finger[] = [];
  for (let i = start; i < start + length; i += 1) {
    const pc = ((single[i] as number) % 12 + 12) % 12;
    const degree = scalePitchClasses.indexOf(pc);
    run.push(degree < 0 ? (0 as unknown as Finger) : fingers[degree]);
  }
  const ascending = (single[start + 1] as number) > (single[start] as number);
  // На нижнем краю LH-вверх / RH-вниз большой палец означает не
  // подкладывание, а завершение предыдущей группы. Если ниже нот больше нет,
  // продолжаем пальцы от следующей ступени: C-dur LH начинается 5-4-3-2-1,
  // B-dur LH — 4-3-2-1.
  if (
    run.length >= 2 &&
    run[0] === 1 &&
    ((hand === "L" && ascending) || (hand === "R" && !ascending))
  ) {
    run[0] = Math.min(5, run[1] + 1) as Finger;
  }
  // Конец пробега: подкладывать большой палец больше некуда, группа просто
  // продолжается (до мажор кончается на 5, фа мажор — на 4).
  const last = run.length - 1;
  if (run[last] === 1 && last >= 2 && run[last - 1] > run[last - 2]) {
    run[last] = Math.min(5, run[last - 1] + 1) as Finger;
  }
  for (let i = 0; i < run.length; i += 1) {
    if (!run[i]) continue;
    hints.set(events[start + i].index, {
      finger: run[i],
      bonus: PEDAGOGY.priors.scale,
      kind: "scale",
    });
  }
  return `гамма от ${scaleTonicName(tonic, events[start].notes[0])}`;
}

/**
 * Тональность гаммы: сначала ключевые знаки, затем перебор тоник, у которых
 * все высоты пассажа укладываются в диатонику.
 */
function resolveScale(
  pitchClasses: Set<number>,
  firstNote: ParsedNote,
  score: ParsedScore,
  single: Array<number | undefined>,
  start: number,
  length: number,
): { tonic: number; steps: number[] } | undefined {
  const fifths = firstNote.keyFifths ?? score.fifths;
  const mode = firstNote.keyMode ?? (score.minorMode ? "minor" : undefined);
  if (fifths !== undefined && Number.isFinite(fifths)) {
    const major = ((fifths * 7) % 12 + 12) % 12;
    const tonic = mode === "minor" ? (major + 9) % 12 : major;
    const steps = scaleStepsFor(pitchClasses, tonic, mode ?? "major");
    if (steps) return { tonic, steps };
  }

  const first = (((single[start] as number) % 12) + 12) % 12;
  const last = (((single[start + length - 1] as number) % 12) + 12) % 12;
  const ordered = [
    ...(first === last ? [first] : []),
    first,
    ...[...pitchClasses].sort((a, b) => a - b),
    ...Array.from({ length: 12 }, (_, candidate) => candidate),
  ];
  for (const candidate of [...new Set(ordered)]) {
    const steps = scaleStepsFor(pitchClasses, candidate);
    if (steps) return { tonic: candidate, steps };
  }
  return undefined;
}

const PITCH_NAMES = ["до", "до♯", "ре", "ми♭", "ми", "фа", "фа♯", "соль", "ля♭", "ля", "си♭", "си"];

function pitchName(pitchClass: number): string {
  return PITCH_NAMES[((pitchClass % 12) + 12) % 12];
}

function scaleTonicName(tonic: number, firstNote: ParsedNote): string {
  if (
    firstNote.step &&
    firstNote.midi !== undefined &&
    ((firstNote.midi % 12) + 12) % 12 === tonic
  ) {
    const names: Record<string, string> = {
      C: "до",
      D: "ре",
      E: "ми",
      F: "фа",
      G: "соль",
      A: "ля",
      B: "си",
    };
    const accidental =
      firstNote.alter === -2
        ? "-дубль-бемоль"
        : firstNote.alter === -1
          ? "-бемоль"
          : firstNote.alter === 1
            ? "-диез"
            : firstNote.alter === 2
              ? "-дубль-диез"
              : "";
    return `${names[firstNote.step] ?? firstNote.step}${accidental}`;
  }
  return pitchName(tonic);
}

const CHORD_INTERVALS = new Set([
  "0,3,6",
  "0,3,7",
  "0,4,7",
  "0,4,8",
  "0,3,6,9",
  "0,3,6,10",
  "0,3,7,10",
  "0,4,7,10",
  "0,4,7,11",
]);

function chordRoot(pitchClasses: Set<number>): number | undefined {
  if (pitchClasses.size < 3 || pitchClasses.size > 4) return undefined;
  for (const root of [...pitchClasses].sort((a, b) => a - b)) {
    const intervals = [...pitchClasses]
      .map((pitchClass) => ((pitchClass - root) % 12 + 12) % 12)
      .sort((a, b) => a - b)
      .join(",");
    if (CHORD_INTERVALS.has(intervals)) return root;
  }
  return undefined;
}

/**
 * Арпеджио: правая вверх 1-2-3 с 5 на вершине, левая вверх 5, дальше 3-2-1.
 * Ломаное трезвучие не играется пальцевым легато (Gát, Ortmann), поэтому
 * перекладывание внутри фигуры штрафом не считается.
 */
function applyArpeggioHint(
  single: Array<number | undefined>,
  start: number,
  length: number,
  hand: Hand,
  hints: Map<number, Hint>,
): boolean {
  const pitchClasses = new Set<number>();
  for (let i = start; i < start + length; i += 1) {
    pitchClasses.add(((single[i] as number) % 12 + 12) % 12);
  }
  if (chordRoot(pitchClasses) === undefined) return false;
  const ascending = (single[start + 1] as number) > (single[start] as number);
  const lowerInterval = Math.abs((single[start + 1] as number) - (single[start] as number));
  const upperInterval = Math.abs((single[start + 2] as number) - (single[start + 1] as number));
  const leftMiddle = (lowerInterval >= upperInterval ? 3 : 4) as Finger;

  for (let offset = 0; offset < length; offset += 1) {
    let finger: Finger;
    let freeBefore = false;
    if (hand === "R" && ascending) {
      finger = ([1, 2, 3] as Finger[])[offset % 3];
      if (offset === length - 1) finger = 5;
      freeBefore = offset > 0 && offset % 3 === 0;
    } else if (hand === "R") {
      finger = offset === 0 ? 5 : ([3, 2, 1] as Finger[])[(offset - 1) % 3];
      freeBefore = offset > 1 && (offset - 1) % 3 === 0;
    } else if (ascending) {
      finger = offset === 0 ? 5 : ([leftMiddle, 2, 1] as Finger[])[(offset - 1) % 3];
      freeBefore = offset > 1 && (offset - 1) % 3 === 0;
    } else {
      finger = ([1, 2, leftMiddle] as Finger[])[offset % 3];
      if (offset === length - 1) finger = 5;
      freeBefore = offset > 0 && offset % 3 === 0;
    }
    hints.set(start + offset, {
      finger,
      bonus: PEDAGOGY.priors.arpeggio,
      kind: "arpeggio",
      freeBefore,
    });
  }
  return true;
}

/** Арка трезвучия: 1-2-3-5-3-2-1 (зеркально для LH). */
function applyArpeggioArchHint(
  single: Array<number | undefined>,
  events: HandEvent[],
  start: number,
  hand: Hand,
  hints: Map<number, Hint>,
): number {
  const run = single.slice(start, start + 7);
  if (run.length !== 7 || run.some((midi) => midi === undefined)) return 0;
  const notes = run as number[];
  if (
    !(notes[0] < notes[1] &&
      notes[1] < notes[2] &&
      notes[2] < notes[3] &&
      notes[4] === notes[2] &&
      notes[5] === notes[1] &&
      notes[6] === notes[0])
  ) {
    return 0;
  }
  if (
    events.slice(start + 1, start + 7).some((event, offset) =>
      event.gapBefore > 1e-4 || !sameKeyContext(events[start + offset], event)
    )
  ) {
    return 0;
  }
  const pitchClasses = new Set(notes.map((midi) => ((midi % 12) + 12) % 12));
  if (chordRoot(pitchClasses) === undefined) return 0;

  const lowerInterval = notes[1] - notes[0];
  const upperInterval = notes[2] - notes[1];
  const leftMiddle = (lowerInterval >= upperInterval ? 3 : 4) as Finger;
  const fingers: Finger[] =
    hand === "R"
      ? [1, 2, 3, 5, 3, 2, 1]
      : [5, leftMiddle, 2, 1, 2, leftMiddle, 5];
  for (let offset = 0; offset < fingers.length; offset += 1) {
    hints.set(events[start + offset].index, {
      finger: fingers[offset],
      bonus: PEDAGOGY.priors.arpeggio,
      kind: "arpeggio",
    });
  }
  return 7;
}

/** Изолированная монотонная трезвучная/септаккордовая фигура из 3–4 нот. */
function applyArpeggioFragmentHint(
  single: Array<number | undefined>,
  events: HandEvent[],
  start: number,
  length: number,
  hand: Hand,
  hints: Map<number, Hint>,
): boolean {
  // A direction change or a barline alone does not isolate a musical fragment.
  const before = events[start];
  const after = events[start + length];
  const startsPhrase = start === 0 || before.hardBreakBefore ||
    before.gapBefore >= FINGERING_SEARCH.resetGap;
  const endsPhrase = !after || after.hardBreakBefore ||
    after.gapBefore >= FINGERING_SEARCH.resetGap;
  if (!startsPhrase || !endsPhrase) return false;
  const notes = single.slice(start, start + length) as number[];
  const pitchClasses = new Set(notes.map((midi) => ((midi % 12) + 12) % 12));
  if (chordRoot(pitchClasses) === undefined) return false;

  const ascending = notes[1] > notes[0];
  const ordered = [...notes].sort((a, b) => a - b);
  const base: Finger[] =
    length === 3
      ? [
          1,
          ordered[1] - ordered[0] >= ordered[2] - ordered[1] ? 3 : 2,
          5,
        ]
      : [1, 2, 3, 5];
  const fingerByPitch = new Map<number, Finger>(
    ordered.map((midi, index) => [
      midi,
      hand === "R" ? base[index] : (6 - base[index]) as Finger,
    ]),
  );
  for (let offset = 0; offset < length; offset += 1) {
    hints.set(events[start + offset].index, {
      finger: fingerByPitch.get(notes[offset]) as Finger,
      bonus: PEDAGOGY.priors.arpeggio,
      kind: "arpeggio",
      freeBefore: offset === 0 && !ascending,
    });
  }
  return true;
}

/**
 * Аккомпанемент «бас + аккорд»: низкий одиночный звук на сильной доле и
 * повторяющийся аккорд над ним (вальсовое «бас — аккорд — аккорд», эстрадное
 * «бас — аккорд»).
 *
 * Почему нужен отдельный приор. Эргономическая модель одноголосна: она видит
 * штраф правила 6 за 5-й палец и предпочитает поставить на бас 3-й, а затем
 * подкладывать большой под аккорд. Пианист играет иначе: 5-й палец — опора,
 * рука переносится на аккорд кистью целиком, а не пальцевым legato. Так учат
 * все школы аккомпанемента, и так удобнее любой руке, независимо от растяжки.
 *
 * Аппликатура выводится из интервалов самой фигуры, а не из таблицы: бас —
 * крайний палец (5 в левой, 1 в правой), верх аккорда — большой в левой и 5-й
 * в правой, середина — по величине промежутка.
 */
function applyAccompanimentHint(
  events: HandEvent[],
  start: number,
  hand: Hand,
  hints: Map<number, Hint>,
): { length: number; label: string } | undefined {
  const units: Array<{ bass: number; chords: number[] }> = [];
  let cursor = start;
  let shape: number | undefined;

  while (cursor < events.length) {
    const bass = events[cursor];
    if (!isSingleSounding(bass)) break;
    const chords: number[] = [];
    let probe = cursor + 1;
    while (probe < events.length && chords.length < 3) {
      const candidate = events[probe];
      if (
        candidate.notes.length < 2
        || candidate.notes.length > 4
        || candidate.notes.some((note) => note.grace)
        || candidate.gapBefore > 1e-4
        || candidate.hardBreakBefore
      ) break;
      // Аккорд обязан лежать над басом: иначе это не аккомпанемент, а фактура.
      if (Math.min(...candidate.keys.map((key) => key.midi)) - bass.keys[0].midi < 3) break;
      chords.push(probe);
      probe += 1;
    }
    if (chords.length === 0) break;
    if (shape === undefined) shape = chords.length;
    else if (chords.length !== shape) break;
    if (units.length > 0 && (bass.gapBefore > 1e-4 || bass.hardBreakBefore)) break;
    units.push({ bass: cursor, chords });
    cursor = probe;
  }

  // Либо полная вальсовая фигура в одном такте, либо повторение фигуры.
  if (!units.length) return undefined;
  if (units.length < 2 && (shape ?? 0) < 2) return undefined;

  for (const unit of units) {
    const bassEvent = events[unit.bass];
    hints.set(bassEvent.index, {
      finger: hand === "L" ? 5 : 1,
      bonus: PEDAGOGY.priors.accompaniment,
      kind: "accompaniment",
      freeBefore: true,
    });
    for (const chordIndex of unit.chords) {
      const chord = events[chordIndex];
      const fingers = accompanimentChordFingers(
        chord.keys.map((key) => key.midi),
        hand,
      );
      if (!fingers) continue;
      hints.set(chord.index, {
        finger: fingers[0],
        fingers,
        bonus: PEDAGOGY.priors.accompaniment,
        kind: "accompaniment",
        freeBefore: true,
      });
    }
  }

  const last = units[units.length - 1];
  const length = last.chords[last.chords.length - 1] - start + 1;
  return {
    length,
    label: (shape ?? 0) >= 2 ? "бас и аккорды (вальсовый аккомпанемент)" : "бас и аккорд",
  };
}

function isSingleSounding(event: HandEvent): boolean {
  return event.notes.length === 1 && !event.notes[0].grace;
}

/**
 * Пальцы аккорда аккомпанемента снизу вверх. В левой руке большой палец берёт
 * верхний звук — он ближе к следующей опоре; в правой рука зеркальна.
 */
export function accompanimentChordFingers(
  midis: readonly number[],
  hand: Hand,
): Finger[] | undefined {
  const ascending = [...midis].sort((left, right) => left - right);
  if (ascending.length < 2 || ascending.length > 4) return undefined;
  const gapFinger = (semitones: number): Finger =>
    semitones <= 2 ? 2 : semitones <= 5 ? 3 : semitones <= 8 ? 4 : 5;

  // Строим форму для левой руки: сверху вниз 1, затем по промежуткам.
  const left: Finger[] = new Array(ascending.length);
  const top = ascending.length - 1;
  left[top] = 1;
  if (ascending.length === 2) {
    left[0] = gapFinger(ascending[1] - ascending[0]);
  } else {
    left[top - 1] = gapFinger(ascending[top] - ascending[top - 1]);
    left[0] = 5;
    if (ascending.length === 4) {
      left[1] = Math.min(4, Math.max(2, left[0] - 1)) as Finger;
    }
  }
  // Пальцы не должны совпадать и обязаны идти по возрастанию высоты вниз.
  const unique = new Set(left);
  if (unique.size !== left.length) return undefined;
  return hand === "L" ? left : left.map((finger) => (6 - finger) as Finger);
}

/**
 * Альбертиев бас: фигура «низ — верх — середина — верх», повторяющаяся хотя бы
 * дважды. Постоянство аппликатуры важнее локального оптимума (C.P.E. Bach).
 */
function applyAlbertiHint(
  single: Array<number | undefined>,
  start: number,
  hand: Hand,
  hints: Map<number, Hint>,
): number {
  const figure = single.slice(start, start + 4);
  if (figure.some((value) => value === undefined)) return 0;
  const [low, high, middle, highAgain] = figure as number[];
  if (!(low < middle && middle < high && high === highAgain)) return 0;
  if (
    chordRoot(
      new Set([low, middle, high].map((midi) => ((midi % 12) + 12) % 12)),
    ) === undefined
  ) {
    return 0;
  }

  let repeats = 0;
  while (
    start + repeats * 4 + 3 < single.length &&
    single[start + repeats * 4] === low &&
    single[start + repeats * 4 + 1] === high &&
    single[start + repeats * 4 + 2] === middle &&
    single[start + repeats * 4 + 3] === high
  ) {
    repeats += 1;
  }
  if (repeats < 2) return 0;

  const pattern: Finger[] = hand === "L" ? [5, 1, 3, 1] : [1, 5, 3, 5];
  for (let i = 0; i < repeats * 4; i += 1) {
    hints.set(start + i, {
      finger: pattern[i % 4],
      bonus: PEDAGOGY.priors.alberti,
      kind: "alberti",
    });
  }
  return repeats * 4;
}

