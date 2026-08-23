/**
 * Мелодический слой (L1): выделение ведущего потока и локальные границы по Gestalt.
 *
 * Зачем: в корпусе реальных экспортов лиги есть у 6 партитур из 18, а ферматы и
 * breath-mark — ни у одной. Единственный всегда доступный источник фразовых
 * окончаний — сама мелодия: скачок интервала, рост IOI и пауза после долгой ноты.
 *
 * Модель локальных границ — LBDM (Cambouropoulos): для каждого параметрического
 * профиля (интервал высоты, IOI, пауза) считается степень изменения между соседними
 * интервалами и сила границы, профили нормируются и складываются с весами
 * 0.25 / 0.5 / 0.25.
 */

import {
  attacksOf,
  type MeasureNotes,
  type NoteEvent,
} from "./adaptive-notes";

export interface MelodySurface {
  /** Поток `part:staff:voice`, признанный ведущим; undefined, если мелодии нет. */
  stream?: string;
  /** Сила локальной границы на тактовой черте после такта i, [0,1]. */
  lbdmAfter: number[];
  /** Пауза мелодии на стыке тактов i/i+1 в долях среднего такта, [0,1]. */
  melodyGapAfter: number[];
  /** Мелодия молчит весь такт (вступление, интерлюдия, tutti-пауза). */
  melodySilent: boolean[];
  /** Последняя нота мелодии в такте длиннее доли — признак прибытия. */
  longArrivalAfter: boolean[];
  /** Мелодия в такте есть хотя бы у одного потока. */
  hasMelody: boolean;
}

interface TimedNote {
  measure: number;
  /** Абсолютное время начала в четвертях от начала партитуры. */
  onset: number;
  duration: number;
  midi: number;
}

const LBDM_WEIGHTS = { pitch: 0.25, ioi: 0.5, rest: 0.25 } as const;

export function analyzeMelody(measures: MeasureNotes[]): MelodySurface {
  const count = measures.length;
  const empty: MelodySurface = {
    lbdmAfter: Array<number>(count).fill(0),
    melodyGapAfter: Array<number>(count).fill(0),
    melodySilent: Array<boolean>(count).fill(false),
    longArrivalAfter: Array<boolean>(count).fill(false),
    hasMelody: false,
  };
  if (count === 0) return empty;
  const stream = detectMelodyStream(measures);
  if (!stream) return empty;

  const melodyByMeasure = measures.map((measure) =>
    attacksOf(measure).filter(
      (event) => event.stream === stream && event.midi !== undefined,
    ),
  );
  const restsByMeasure = measures.map((measure) =>
    measure.events.filter((event) => event.stream === stream && event.rest),
  );
  const starts = measureStartTimes(measures);
  const timed: TimedNote[] = [];
  for (const [index, notes] of melodyByMeasure.entries()) {
    for (const note of notes) {
      timed.push({
        measure: index,
        onset: starts[index] + note.onset,
        duration: note.duration,
        midi: note.midi as number,
      });
    }
  }

  const lbdmAfter = Array<number>(count).fill(0);
  const strengths = lbdmProfile(timed);
  for (const [index, strength] of strengths.entries()) {
    const from = timed[index];
    const to = timed[index + 1];
    if (!from || !to || to.measure === from.measure) continue;
    // Граница относится к последней тактовой черте перед следующей нотой мелодии:
    // если мелодия молчит несколько тактов, сигнал принадлежит месту её обрыва.
    lbdmAfter[from.measure] = Math.max(lbdmAfter[from.measure], strength);
  }

  const melodySilent = melodyByMeasure.map((notes) => notes.length === 0);
  const rawGap = Array<number>(count).fill(0);
  const longArrivalAfter = Array<boolean>(count).fill(false);
  for (let index = 0; index < count; index += 1) {
    const notes = melodyByMeasure[index];
    const last = notes.at(-1);
    const quarterBeats = Math.max(0.5, measures[index].quarterBeats);
    const trailing = last
      ? Math.max(0, quarterBeats - (last.onset + last.duration))
      : explicitRestQuarters(restsByMeasure[index], 0, quarterBeats);
    const next = measures[index + 1];
    const nextNotes = melodyByMeasure[index + 1] ?? [];
    const leading = next
      ? nextNotes.length > 0
        ? Math.max(0, nextNotes[0].onset)
        : Math.max(0, next.quarterBeats)
      : 0;
    const window = next
      ? (quarterBeats + Math.max(0.5, next.quarterBeats)) / 2
      : quarterBeats;
    rawGap[index] = clamp01((trailing + leading) / Math.max(0.5, window));
    const beat = beatLength(measures[index]);
    longArrivalAfter[index] = Boolean(last && last.duration >= beat * 1.5);
  }
  // Пауза считается относительно собственной нормы пьесы. В разреженной фактуре
  // мелодия заканчивается задолго до конца каждого такта, и абсолютная пауза
  // объявляла бы концом фразы каждую тактовую черту. Значение имеет превышение над
  // типичным для этой партитуры промежутком.
  const typicalGap = median(rawGap);
  const headroom = Math.max(0.15, 1 - typicalGap);
  const melodyGapAfter = rawGap.map((value) =>
    clamp01((value - typicalGap) / headroom),
  );

  return {
    stream,
    lbdmAfter,
    melodyGapAfter,
    melodySilent,
    longArrivalAfter,
    hasMelody: timed.length > 0,
  };
}

/**
 * Ведущий поток — тот, что чаще всего несёт самый верхний звучащий голос, при
 * прочих равных более одноголосный и присутствующий в большинстве тактов. Правило
 * универсально: оно одинаково отделяет правую руку от левой и вокальную партию от
 * фортепианной, не опираясь на `<part-name>`.
 */
export function detectMelodyStream(measures: MeasureNotes[]): string | undefined {
  interface StreamStats {
    top: number;
    present: number;
    single: number;
    onsets: number;
  }
  const stats = new Map<string, StreamStats>();
  const ensure = (stream: string) => {
    const existing = stats.get(stream);
    if (existing) return existing;
    const created: StreamStats = { top: 0, present: 0, single: 0, onsets: 0 };
    stats.set(stream, created);
    return created;
  };
  for (const measure of measures) {
    const sounding = measure.events.filter(
      (event) => !event.rest && !event.grace && event.midi !== undefined,
    );
    if (sounding.length === 0) continue;
    const highest = Math.max(...sounding.map((event) => event.midi as number));
    const seen = new Set<string>();
    for (const event of sounding) {
      const entry = ensure(event.stream);
      if (!seen.has(event.stream)) {
        seen.add(event.stream);
        entry.present += 1;
      }
      if (event.midi === highest) entry.top += 1;
      entry.onsets += 1;
      if (!event.chord) entry.single += 1;
    }
  }
  if (stats.size === 0) return undefined;
  const total = Math.max(1, measures.length);
  let best: { stream: string; score: number } | undefined;
  for (const [stream, entry] of stats) {
    const presence = entry.present / total;
    if (presence < 0.2) continue;
    const topShare = entry.top / Math.max(1, entry.onsets);
    const monophony = entry.single / Math.max(1, entry.onsets);
    const score = topShare * 1 + monophony * 0.35 + presence * 0.25;
    if (!best || score > best.score) best = { stream, score };
  }
  if (best) return best.stream;
  // Все потоки редкие: берём тот, у которого больше всего верхних нот.
  return [...stats.entries()].sort((left, right) => right[1].top - left[1].top)[0]?.[0];
}

/**
 * LBDM: r_i = |x_i − x_{i+1}| / (x_i + x_{i+1}), s_i = x_i · (r_{i−1} + r_i).
 * Возвращает силу границы между нотой i и i+1 в [0,1].
 */
export function lbdmProfile(notes: TimedNote[]): number[] {
  const transitions = notes.length - 1;
  if (transitions <= 0) return [];
  const pitch: number[] = [];
  const ioi: number[] = [];
  const rest: number[] = [];
  for (let index = 0; index < transitions; index += 1) {
    const from = notes[index];
    const to = notes[index + 1];
    pitch.push(Math.abs(to.midi - from.midi));
    ioi.push(Math.max(0, to.onset - from.onset));
    rest.push(Math.max(0, to.onset - (from.onset + from.duration)));
  }
  const combined = Array<number>(transitions).fill(0);
  for (const [profile, weight] of [
    [pitch, LBDM_WEIGHTS.pitch],
    [ioi, LBDM_WEIGHTS.ioi],
    [rest, LBDM_WEIGHTS.rest],
  ] as Array<[number[], number]>) {
    const strengths = boundaryStrengths(profile);
    for (let index = 0; index < transitions; index += 1) {
      combined[index] += strengths[index] * weight;
    }
  }
  const max = Math.max(...combined);
  return max > 0 ? combined.map((value) => value / max) : combined;
}

function boundaryStrengths(profile: number[]): number[] {
  const changes = profile.map((value, index) => {
    const next = profile[index + 1];
    if (next === undefined) return 0;
    const sum = value + next;
    return sum > 0 ? Math.abs(value - next) / sum : 0;
  });
  const strengths = profile.map(
    (value, index) => value * ((changes[index - 1] ?? 0) + (changes[index] ?? 0)),
  );
  const max = Math.max(...strengths, 0);
  return max > 0 ? strengths.map((value) => value / max) : strengths;
}

export function measureStartTimes(measures: MeasureNotes[]): number[] {
  const starts: number[] = [];
  let time = 0;
  for (const measure of measures) {
    starts.push(time);
    time += Math.max(measure.quarterBeats, measure.actualQuarters);
  }
  return starts;
}

/** Длина доли в четвертях: 6/8 и 3/8 группируются по три восьмых, а не по одной. */
export function beatLength(measure: MeasureNotes): number {
  const quarters = measure.quarterBeats;
  if (quarters >= 1.5 && Math.abs((quarters / 1.5) % 1) < 1e-6) return 1.5;
  return 1;
}

function explicitRestQuarters(
  rests: NoteEvent[],
  from: number,
  to: number,
): number {
  return rests
    .filter((rest) => rest.onset + rest.duration > from && rest.onset < to)
    .reduce(
      (sum, rest) =>
        sum +
        (Math.min(to, rest.onset + rest.duration) - Math.max(from, rest.onset)),
      0,
    );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
