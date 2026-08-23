/**
 * Общий контракт между разбором событий, педагогическим распознаванием и
 * beam-поиском. Модуль не зависит от реализации паттернов: основной solver
 * больше не импортирует собственные доменные типы из дочернего слоя.
 */

import type { Finger, Hand, Key } from "./fingering-model";
import type { ParsedNote } from "./fingering-score";

/** Параметры общего поиска, не являющиеся педагогическими приорами. */
export const FINGERING_SEARCH = {
  /** Пауза, после которой рука свободно переставляется (четверти). */
  resetGap: 1,
  /** Быстрый повтор ноты — чередование пальцев вместо повторения одного. */
  fastRepeat: 0.5,
  /** Ширина луча динамического поиска. */
  beam: 64,
} as const;

export interface FingeringPattern {
  kind: "scale" | "fiveFinger" | "arpeggio" | "alberti" | "ostinato" | "accompaniment";
  hand: Hand;
  fromMeasure: number;
  toMeasure: number;
  label: string;
}

export interface HandEvent {
  index: number;
  onset: number;
  measureIndex: number;
  measureNumber: string;
  notes: ParsedNote[];
  keys: Key[];
  /** Ноты сверх пяти: получают палец соседа, в поиске не участвуют. */
  spilled: ParsedNote[];
  gapBefore: number;
  /**
   * Реальное время между атакой предыдущего события и этой, в секундах.
   * `undefined`, если партитура не объявила темп.
   */
  ipiBefore?: number;
  /** Переход действительно находится внутри MusicXML `<slur>`. */
  slurredBefore: boolean;
  beamBegin: boolean;
  beamEnd: boolean;
  hardBreakBefore: boolean;
  fixed: Array<Finger | undefined>;
}

export interface Hint {
  finger: Finger;
  /**
   * Аппликатура аккорда снизу вверх. Одноголосному событию хватает `finger`, но
   * фигуры аккомпанемента задают форму руки целиком.
   */
  fingers?: Finger[];
  bonus: number;
  kind: FingeringPattern["kind"];
  /** Переход перед этой нотой является сменой группы, а не пальцевым legato. */
  freeBefore?: boolean;
}
