/**
 * Гармонический слой (L2): тональность, аккордовые корни, гармонический ритм и
 * каденции.
 *
 * Зачем: `<harmony>` (буквенные обозначения аккордов) нет ни в одной партитуре
 * корпуса, а конец фразы в тональной музыке определяет именно каденция, а не число
 * тактов. Тональность оценивается корреляцией профиля длительностей высот с
 * профилями Krumhansl–Kessler, корни — сопоставлением шаблонов созвучий, каденция —
 * совпадением сразу нескольких признаков: движение корня, бас, метрическая позиция,
 * приход мелодии на устойчивую ступень и замедление гармонического ритма.
 */

import { attacksOf, soundingOf, type MeasureNotes } from "./adaptive-notes";
import { beatLength } from "./adaptive-melody";

export interface LocalKey {
  tonic: number;
  mode: "major" | "minor";
  confidence: number;
}

export interface ChordSlot {
  measure: number;
  onset: number;
  duration: number;
  root?: number;
  quality?: string;
  bass?: number;
  /** Сколько разных классов высот звучит в слоте. */
  distinctPitchClasses: number;
  /** Слот пуст (пауза во всех голосах). */
  empty: boolean;
}

export type CadenceType = "PAC" | "IAC" | "half" | "plagal" | "deceptive" | "";

export interface HarmonyAnalysis {
  globalKey: LocalKey;
  keys: LocalKey[];
  slots: ChordSlot[];
  /** Сила каденционного закрытия после такта i, [0,1]. */
  cadenceAfter: number[];
  cadenceTypeAfter: CadenceType[];
  /** Смена гармонии в начале такта i, [0,1] — материал для метрических акцентов. */
  harmonicChangeAt: number[];
  /** Локальная тональность в такте i отличается от предыдущей. */
  keyChangeAt: boolean[];
}

const KRUMHANSL_MAJOR = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const KRUMHANSL_MINOR = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

const CHORD_TEMPLATES: Array<{ quality: string; intervals: number[] }> = [
  { quality: "maj", intervals: [0, 4, 7] },
  { quality: "min", intervals: [0, 3, 7] },
  { quality: "dom7", intervals: [0, 4, 7, 10] },
  { quality: "maj7", intervals: [0, 4, 7, 11] },
  { quality: "min7", intervals: [0, 3, 7, 10] },
  { quality: "dim", intervals: [0, 3, 6] },
  { quality: "halfdim", intervals: [0, 3, 6, 10] },
  { quality: "sus4", intervals: [0, 5, 7] },
];

const CADENCE_WEIGHTS = {
  rootMotion: 0.3,
  bassArrival: 0.12,
  metric: 0.15,
  melodyArrival: 0.18,
  harmonicSlowdown: 0.15,
  contourRelease: 0.1,
} as const;

export function analyzeHarmony(
  measures: MeasureNotes[],
  melodyStream: string | undefined,
): HarmonyAnalysis {
  const count = measures.length;
  const profiles = measures.map((measure) => pitchClassProfile(measure));
  const globalKey = estimateKey(sumProfiles(profiles));
  const keys = profiles.map((_, index) => {
    const window = sumProfiles(
      profiles.slice(Math.max(0, index - 4), Math.min(count, index + 5)),
    );
    const local = estimateKey(window);
    // Локальная тональность принимается только если она заметно убедительнее общей:
    // иначе каждый проходящий аккорд объявлял бы модуляцию.
    return local.confidence > globalKey.confidence * 0.9 ? local : globalKey;
  });

  const slots = measures.flatMap((measure) => chordSlots(measure));
  const slotsByMeasure = new Map<number, ChordSlot[]>();
  for (const slot of slots) {
    const list = slotsByMeasure.get(slot.measure) ?? [];
    list.push(slot);
    slotsByMeasure.set(slot.measure, list);
  }
  const medianSlotDuration = median(
    slots.filter((slot) => !slot.empty).map((slot) => slot.duration),
  );

  const harmonicChangeAt = Array<number>(count).fill(0);
  for (let index = 0; index < count; index += 1) {
    const current = (slotsByMeasure.get(index) ?? []).find((slot) => !slot.empty);
    const previous = (slotsByMeasure.get(index - 1) ?? [])
      .filter((slot) => !slot.empty)
      .at(-1);
    if (!current || !previous) continue;
    harmonicChangeAt[index] =
      current.root === undefined || previous.root === undefined
        ? 0.3
        : current.root === previous.root && current.quality === previous.quality
          ? 0
          : 1;
  }

  const cadenceAfter = Array<number>(count).fill(0);
  const cadenceTypeAfter: CadenceType[] = Array<CadenceType>(count).fill("");
  for (let index = 0; index < count; index += 1) {
    const verdict = cadenceAt(
      measures,
      index,
      slotsByMeasure,
      keys[index],
      medianSlotDuration,
      melodyStream,
    );
    cadenceAfter[index] = verdict.score;
    cadenceTypeAfter[index] = verdict.type;
  }

  const keyChangeAt = keys.map((key, index) => {
    const previous = keys[index - 1];
    return Boolean(previous && (previous.tonic !== key.tonic || previous.mode !== key.mode));
  });

  return {
    globalKey,
    keys,
    slots,
    cadenceAfter,
    cadenceTypeAfter,
    harmonicChangeAt,
    keyChangeAt,
  };
}

export function pitchClassProfile(measure: MeasureNotes): number[] {
  const profile = Array<number>(12).fill(0);
  for (const note of soundingOf(measure)) {
    profile[(note.midi as number) % 12] += Math.max(0.25, note.duration);
  }
  return profile;
}

function sumProfiles(profiles: number[][]): number[] {
  const total = Array<number>(12).fill(0);
  for (const profile of profiles) {
    for (let index = 0; index < 12; index += 1) total[index] += profile[index];
  }
  return total;
}

/** Krumhansl–Schmuckler: корреляция профиля высот со всеми 24 тональностями. */
export function estimateKey(profile: number[]): LocalKey {
  const total = profile.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { tonic: 0, mode: "major", confidence: 0 };
  let best: LocalKey = { tonic: 0, mode: "major", confidence: 0 };
  let runnerUp = -Infinity;
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const mode of ["major", "minor"] as const) {
      const template = mode === "major" ? KRUMHANSL_MAJOR : KRUMHANSL_MINOR;
      const rotated = template.map(
        (_, index) => template[(index - tonic + 12) % 12],
      );
      const score = correlation(profile, rotated);
      if (score > best.confidence) {
        runnerUp = best.confidence;
        best = { tonic, mode, confidence: score };
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }
  }
  // Уверенность = отрыв от следующей гипотезы, а не абсолютная корреляция: на
  // нетональном материале корреляция может быть высокой у нескольких тональностей.
  const margin = Number.isFinite(runnerUp)
    ? Math.max(0, best.confidence - runnerUp)
    : 0;
  return { ...best, confidence: clamp01(best.confidence * 0.5 + margin * 2) };
}

/** Гармонические слоты нарезаются по долям: это самый устойчивый шаг для рояля. */
export function chordSlots(measure: MeasureNotes): ChordSlot[] {
  const beat = beatLength(measure);
  const quarters = Math.max(beat, measure.quarterBeats);
  const slots: ChordSlot[] = [];
  const sounding = soundingOf(measure);
  for (let onset = 0; onset < quarters - 1e-6; onset += beat) {
    const end = onset + beat;
    const active = sounding.filter(
      (note) => note.onset < end - 1e-6 && note.onset + note.duration > onset + 1e-6,
    );
    if (active.length === 0) {
      slots.push({
        measure: measure.index,
        onset,
        duration: beat,
        distinctPitchClasses: 0,
        empty: true,
      });
      continue;
    }
    const weights = Array<number>(12).fill(0);
    for (const note of active) {
      const overlap =
        Math.min(end, note.onset + note.duration) - Math.max(onset, note.onset);
      weights[(note.midi as number) % 12] += Math.max(0.1, overlap);
    }
    const bass = Math.min(...active.map((note) => note.midi as number)) % 12;
    const match = matchChord(weights, bass);
    slots.push({
      measure: measure.index,
      onset,
      duration: beat,
      root: match?.root,
      quality: match?.quality,
      bass,
      distinctPitchClasses: new Set(
        active.map((note) => (note.midi as number) % 12),
      ).size,
      empty: false,
    });
  }
  return mergeEqualSlots(slots);
}

function mergeEqualSlots(slots: ChordSlot[]): ChordSlot[] {
  const merged: ChordSlot[] = [];
  for (const slot of slots) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.empty === slot.empty &&
      previous.root === slot.root &&
      previous.quality === slot.quality
    ) {
      previous.duration += slot.duration;
      previous.distinctPitchClasses = Math.max(
        previous.distinctPitchClasses,
        slot.distinctPitchClasses,
      );
      continue;
    }
    merged.push({ ...slot });
  }
  return merged;
}

function matchChord(
  weights: number[],
  bass: number,
): { root: number; quality: string } | undefined {
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return undefined;
  let best: { root: number; quality: string; score: number } | undefined;
  for (let root = 0; root < 12; root += 1) {
    for (const template of CHORD_TEMPLATES) {
      const inside = template.intervals.reduce(
        (sum, interval) => sum + weights[(root + interval) % 12],
        0,
      );
      const outside = total - inside;
      const coverage = template.intervals.filter(
        (interval) => weights[(root + interval) % 12] > 0,
      ).length / template.intervals.length;
      const score =
        (inside / total) * 0.6 +
        coverage * 0.3 -
        (outside / total) * 0.35 +
        (root === bass ? 0.12 : 0) -
        template.intervals.length * 0.01;
      if (!best || score > best.score) best = { root, quality: template.quality, score };
    }
  }
  return best && best.score > 0.2 ? { root: best.root, quality: best.quality } : undefined;
}

function cadenceAt(
  measures: MeasureNotes[],
  index: number,
  slotsByMeasure: Map<number, ChordSlot[]>,
  key: LocalKey,
  medianSlotDuration: number,
  melodyStream: string | undefined,
): { score: number; type: CadenceType } {
  const measure = measures[index];
  if (!measure || key.confidence <= 0) return { score: 0, type: "" };
  const own = (slotsByMeasure.get(index) ?? []).filter((slot) => !slot.empty);
  if (own.length === 0) return { score: 0, type: "" };
  const arrival = own.at(-1) as ChordSlot;
  const before =
    own.length > 1
      ? own[own.length - 2]
      : (slotsByMeasure.get(index - 1) ?? []).filter((slot) => !slot.empty).at(-1);
  if (arrival.root === undefined) return { score: 0, type: "" };

  const degree = (pitchClass: number | undefined) =>
    pitchClass === undefined ? undefined : (pitchClass - key.tonic + 12) % 12;
  const arrivalDegree = degree(arrival.root);
  const beforeDegree = degree(before?.root);
  const isMinor = key.mode === "minor";
  const tonicDegree = 0;
  const dominantDegree = 7;
  const subdominantDegree = 5;
  const submediantDegree = isMinor ? 8 : 9;

  let type: CadenceType = "";
  let rootMotion = 0;
  if (arrivalDegree === tonicDegree && beforeDegree === dominantDegree) {
    type = "PAC";
    rootMotion = 1;
  } else if (arrivalDegree === tonicDegree && beforeDegree === 11) {
    type = "IAC";
    rootMotion = 0.85;
  } else if (arrivalDegree === tonicDegree && beforeDegree === subdominantDegree) {
    type = "plagal";
    rootMotion = 0.6;
  } else if (arrivalDegree === dominantDegree && beforeDegree !== dominantDegree) {
    type = "half";
    rootMotion = 0.55;
  } else if (arrivalDegree === submediantDegree && beforeDegree === dominantDegree) {
    type = "deceptive";
    rootMotion = 0.5;
  }
  // Никакого «любой тонический аккорд = каденция»: без гармонического движения это
  // просто продолжение фактуры. Одиночная нота тоже не образует созвучия — иначе
  // мелодия без аккомпанемента давала бы каденцию в каждом такте.
  if (rootMotion === 0) return { score: 0, type: "" };
  if (arrival.distinctPitchClasses < 2) return { score: 0, type: "" };
  if (
    before === undefined ||
    (before.root === arrival.root && before.quality === arrival.quality)
  ) {
    return { score: 0, type: "" };
  }

  const beat = beatLength(measure);
  const metric = arrival.onset <= 1e-6 ? 1 : arrival.onset % (beat * 2) <= 1e-6 ? 0.7 : 0.3;
  const bassArrival = arrival.bass !== undefined && arrival.bass === arrival.root ? 1 : 0.4;
  const slowdown =
    medianSlotDuration > 0
      ? clamp01((arrival.duration / medianSlotDuration - 1) / 1.5)
      : 0;

  const melodyNotes = melodyStream
    ? attacksOf(measure).filter(
        (note) => note.stream === melodyStream && note.midi !== undefined,
      )
    : [];
  const lastMelody = melodyNotes.at(-1);
  const melodyDegree = lastMelody
    ? ((lastMelody.midi as number) % 12 - key.tonic + 12) % 12
    : undefined;
  const stableDegrees = isMinor ? [0, 3, 7] : [0, 4, 7];
  const melodyArrival =
    melodyDegree === undefined
      ? 0.35
      : melodyDegree === 0
        ? 1
        : stableDegrees.includes(melodyDegree)
          ? 0.7
          : 0.15;
  const contourRelease = lastMelody
    ? clamp01(lastMelody.duration / Math.max(beat, 1e-6) / 2)
    : 0;

  const raw =
    CADENCE_WEIGHTS.rootMotion * rootMotion +
    CADENCE_WEIGHTS.bassArrival * bassArrival +
    CADENCE_WEIGHTS.metric * metric +
    CADENCE_WEIGHTS.melodyArrival * melodyArrival +
    CADENCE_WEIGHTS.harmonicSlowdown * slowdown +
    CADENCE_WEIGHTS.contourRelease * contourRelease;
  // Слабая тональная уверенность не должна навязывать каденции нетональной музыке.
  return { score: clamp01(raw * (0.4 + 0.6 * key.confidence)), type };
}

function correlation(left: number[], right: number[]): number {
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    covariance += a * b;
    leftVariance += a * a;
    rightVariance += b * b;
  }
  return leftVariance > 0 && rightVariance > 0
    ? covariance / Math.sqrt(leftVariance * rightVariance)
    : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
