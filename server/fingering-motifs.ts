/**
 * Повторяющиеся фигуры: единая форма руки вместо локальных тай-брейков.
 *
 * Зачем слой нужен. Модель Parncutt оценивает переход между соседними нотами и
 * тройку для смены позиции. Более длинного контекста у неё нет, поэтому две
 * одинаковые фигуры, стоящие в разных тактах, решаются независимо, и разница в
 * доли очка даёт разную аппликатуру на одном и том же мотиве. Пианист так не
 * играет: фигура разучивается один раз и повторяется одной формой руки.
 * Тот же вывод дают современные работы по автоматической аппликатуре —
 * Nakamura, Saito & Yoshii (2020) и Ramoneda et al. (2022, ArGNN): контекст
 * длиннее тройки нот заметно поднимает согласие с авторской разметкой.
 *
 * Чем слой отличается от прежнего детектора остинато. Тот требовал ровно
 * 3–4 разные высоты, распознаваемый аккордовый корень и одноголосные события,
 * а форму руки брал из зашитой таблицы (`[1, 2|3, 5]`). Любой аккорд внутри
 * фигуры обнулял распознавание, а таблица не знала ни темпа, ни соседних
 * тактов. Здесь нет ни таблиц и ни одного музыкального шаблона: цикл ищется
 * по самоподобию сигнатур событий.
 *
 * Слой ничего не изобретает. Он работает вторым проходом: аппликатуру выбирает
 * основной beam-поиск, знающий полный контекст, а здесь из ФАКТИЧЕСКИ выбранных
 * им форм отбирается одна на всю фигуру. Кандидаты — только те формы, которые
 * поиск сам поставил хотя бы на одном проведении, поэтому слой не может
 * породить хват, которого поиск не считал разумным; он лишь убирает разнобой
 * между проведениями. Попытка отдать выбор изолированному оптимизатору цикла
 * измерена и отвергнута: согласие с авторской аппликатурой падало
 * (Hanon 0.767 → 0.741), потому что цикл не видит того, что вокруг него.
 *
 * Непрерывность общих тонов — главное правило соседства. Если соседние фигуры
 * делят высоту, она обязана сохранить палец: рука остаётся на месте, меняются
 * только края хвата. Именно это отличает «5-2-1 / 4-2-1» (кисть стоит) от
 * «5-2-1 / 5-3-1» (кисть перекладывается на каждом такте).
 */

import {
  addParts,
  chordFeasible,
  emptyParts,
  fourFingerCost,
  interPressInterval,
  tempoWeights,
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
import type { HandEvent } from "./fingering-types";

export const MOTIF = {
  /** Наибольший период цикла в событиях: длиннее — это уже не фигура, а фраза. */
  maxPeriod: 8,
  /** Наименьший период: повтор одной ноты циклом не считается. */
  minPeriod: 2,
  /** Полных повторов, начиная с которых фигура признаётся повторяющейся. */
  minRepeats: 2,
  /** Наименьшая общая длина цикла в событиях. */
  minLength: 4,
  /** Событий сверх пяти нот в фигуре не бывает — это уже не форма руки. */
  maxNotesPerEvent: 5,
  /**
   * Цена смены пальца на высоте, общей с предыдущей фигурой.
   *
   * Величина выбрана по замеру: ниже 4 непрерывность проигрывает разнице в
   * доли очка между соседними формами и не срабатывает вовсе; в диапазоне
   * 4…16 результат на корпусе не меняется. Взята середина.
   */
  continuity: 6,
  /** Потолок перебора форм руки на цикл. */
  searchCap: 50_000,
  /** Кандидатов на сигнатуру после отсечения, если потолок превышен. */
  narrowedCandidates: 4,
} as const;

export interface MotifCycle {
  /** Индекс первого события цикла в массиве событий руки. */
  start: number;
  /** Период в событиях. */
  period: number;
  /** Полная длина, включая неполный хвост последнего повтора. */
  length: number;
}

/**
 * Сигнатура события — его набор высот. Одинаково работает для одной ноты и для
 * аккорда, поэтому двузвучие внутри фигуры больше не рвёт распознавание.
 */
export function signatureOf(event: HandEvent): string {
  return event.keys.map((key) => key.midi).join(".");
}

/** Событие пригодно для фигуры, если оно звучит и не является форшлагом. */
function usable(event: HandEvent): boolean {
  return (
    event.notes.length > 0 &&
    event.notes.length <= MOTIF.maxNotesPerEvent &&
    !event.notes.some((note) => note.grace)
  );
}

/** Внутри цикла разрывов быть не должно: пауза освобождает руку. */
function contiguous(events: HandEvent[], from: number, to: number): boolean {
  for (let index = from + 1; index <= to; index += 1) {
    const event = events[index];
    if (!event || !usable(event) || event.hardBreakBefore || event.gapBefore > 1e-4) return false;
  }
  return usable(events[from]);
}

/**
 * Максимальные циклы самоподобия.
 *
 * Ищутся жадно слева направо: в каждой точке берётся наибольший период, дающий
 * не меньше `minRepeats` полных повторов. Никаких музыкальных условий —
 * ни лада, ни аккордового корня, ни числа разных высот.
 */
export function findCycles(events: HandEvent[]): MotifCycle[] {
  const signatures = events.map((event) => (usable(event) ? signatureOf(event) : null));
  const cycles: MotifCycle[] = [];
  let index = 0;

  while (index < events.length) {
    let found: MotifCycle | undefined;
    for (let period = MOTIF.maxPeriod; period >= MOTIF.minPeriod; period -= 1) {
      if (index + period * MOTIF.minRepeats > events.length) continue;
      if (!contiguous(events, index, index + period * MOTIF.minRepeats - 1)) continue;

      let repeats = 1;
      while (index + (repeats + 1) * period <= events.length) {
        const offset = index + repeats * period;
        if (!contiguous(events, offset - 1, offset + period - 1)) break;
        let same = true;
        for (let step = 0; step < period; step += 1) {
          const left = signatures[index + step];
          const right = signatures[offset + step];
          if (left === null || left !== right) {
            same = false;
            break;
          }
        }
        if (!same) break;
        repeats += 1;
      }
      if (repeats < MOTIF.minRepeats) continue;

      // Неполный хвост повтора принадлежит той же фигуре: обрывать форму руки
      // на середине последнего проведения незачем.
      let length = repeats * period;
      while (
        index + length < events.length &&
        contiguous(events, index + length - 1, index + length) &&
        signatures[index + length] !== null &&
        signatures[index + length] === signatures[index + (length % period)]
      ) {
        length += 1;
      }
      if (length < MOTIF.minLength) continue;
      found = { start: index, period, length };
      break;
    }

    if (found) {
      cycles.push(found);
      index = found.start + found.length;
    } else {
      index += 1;
    }
  }

  return cycles;
}


/* ------------------------------------------------------------------ *
 * Согласование проведений
 * ------------------------------------------------------------------ */

/** Форма руки для одной сигнатуры: пальцы снизу вверх. */
export type GripMap = Map<string, Finger[]>;

const gripKey = (map: GripMap): string =>
  [...map.entries()].sort().map(([signature, assign]) => `${signature}=${assign.join(".")}`).join("|");

/** Вертикальная цена хвата события. Слабость пальца — на ноту, не на переход. */
function gripParts(
  tables: SpanTables,
  hand: Hand,
  keys: Key[],
  assign: Finger[],
): CostParts {
  const parts = emptyParts();
  for (let i = 0; i + 1 < keys.length; i += 1) {
    const [f, from, g, to] =
      hand === "R"
        ? [assign[i], keys[i], assign[i + 1], keys[i + 1]]
        : [assign[i + 1], keys[i + 1], assign[i], keys[i]];
    const pair = transitionParts(tables, hand, f, from, g, to);
    pair.weakFinger = 0;
    pair.fourFinger = 0;
    addParts(parts, pair);
  }
  for (const finger of assign) {
    parts.weakFinger += weakFingerCost(finger);
    parts.fourFinger += fourFingerCost(finger);
  }
  return parts;
}

/** Горизонтальная цена между событиями: край к краю, как в основном поиске. */
function linkParts(
  tables: SpanTables,
  hand: Hand,
  fromKeys: Key[],
  fromAssign: Finger[],
  toKeys: Key[],
  toAssign: Finger[],
): CostParts {
  const parts = emptyParts();
  const last = fromKeys.length - 1;
  const target = toKeys.length - 1;
  const low = transitionParts(
    tables, hand, fromAssign[0], fromKeys[0], toAssign[0], toKeys[0],
  );
  const high = transitionParts(
    tables, hand, fromAssign[last], fromKeys[last], toAssign[target], toKeys[target],
  );
  low.weakFinger = 0;
  low.fourFinger = 0;
  high.weakFinger = 0;
  high.fourFinger = 0;
  addParts(parts, low, 0.5);
  addParts(parts, high, 0.5);
  return parts;
}

/** Средний реальный интервал между атаками внутри окна. */
function windowIpi(window: HandEvent[]): number | undefined {
  const known = window
    .map((event) => event.ipiBefore)
    .filter((value): value is number => value !== undefined);
  if (known.length > 0) return known.reduce((sum, value) => sum + value, 0) / known.length;
  const first = window[0]?.notes[0];
  return interPressInterval(first?.duration ?? 0, first?.tempo);
}

/** Цена одного оборота фигуры данной формой, включая возврат в начало. */
function cycleCost(
  window: HandEvent[],
  grip: GripMap,
  hand: Hand,
  tables: SpanTables,
  weights: RuleWeights,
): number {
  let total = 0;
  for (let i = 0; i < window.length; i += 1) {
    const event = window[i];
    const assign = grip.get(signatureOf(event));
    if (!assign) return Number.POSITIVE_INFINITY;
    total += weigh(gripParts(tables, hand, event.keys, assign), weights);
    // Возврат из последнего события в первое повторяется столько же раз,
    // сколько сама фигура; линейная модель этого скачка не видит.
    const next = window[(i + 1) % window.length];
    const nextAssign = grip.get(signatureOf(next));
    if (!nextAssign) return Number.POSITIVE_INFINITY;
    total += weigh(
      linkParts(tables, hand, event.keys, assign, next.keys, nextAssign),
      weights,
    );
  }
  return total;
}

/** Высоты, сохраняющие палец при переходе от одной формы к другой. */
function sharedMismatches(previous: GripMap, next: GripMap): number {
  const fingerByPitch = new Map<number, Finger>();
  for (const [signature, assign] of previous) {
    signature.split(".").forEach((midi, index) => {
      fingerByPitch.set(Number(midi), assign[index]);
    });
  }
  let mismatched = 0;
  for (const [signature, assign] of next) {
    signature.split(".").forEach((midi, index) => {
      const held = fingerByPitch.get(Number(midi));
      if (held !== undefined && held !== assign[index]) mismatched += 1;
    });
  }
  return mismatched;
}

export interface MotifConsolidation {
  /** Индекс события руки → форма руки снизу вверх. */
  fingers: Map<number, Finger[]>;
  cycles: Array<{ start: number; length: number; fromMeasure: number; toMeasure: number }>;
}

/**
 * Единая форма руки на все проведения каждой фигуры.
 *
 * `chosen` — то, что уже выбрал полноконтекстный поиск. Для каждого цикла
 * собираются формы, реально поставленные на его проведениях, и из них
 * выбирается одна: по цене оборота плюс штраф за смену пальца на высоте,
 * общей с предыдущей соседней фигурой. Кандидаты ограничены наблюдёнными
 * формами, поэтому согласование не может ухудшить хват — только выровнять его.
 */
export function consolidateMotifs(
  events: HandEvent[],
  chosen: ReadonlyMap<number, Finger[]>,
  hand: Hand,
  tables: SpanTables,
  weights: RuleWeights,
  blocked: ReadonlySet<number>,
): MotifConsolidation {
  const fingers = new Map<number, Finger[]>();
  const cycles: MotifConsolidation["cycles"] = [];
  let previousGrip: GripMap | undefined;
  let previousEnd = -1;

  for (const cycle of findCycles(events)) {
    let claimed = false;
    for (let offset = 0; offset < cycle.length; offset += 1) {
      if (blocked.has(cycle.start + offset)) {
        claimed = true;
        break;
      }
    }
    // Гамма, арпеджио, альбертиев бас и фигуры аккомпанемента имеют школьное
    // решение со своим приором; общий слой их не трогает.
    if (claimed) {
      previousGrip = undefined;
      previousEnd = -1;
      continue;
    }

    const window = events.slice(cycle.start, cycle.start + cycle.period);
    // Формы, которые поиск действительно поставил хотя бы на одном проведении.
    const candidates = new Map<string, GripMap>();
    for (let base = 0; base + cycle.period <= cycle.length; base += cycle.period) {
      const grip: GripMap = new Map();
      let complete = true;
      for (let step = 0; step < cycle.period; step += 1) {
        const event = events[cycle.start + base + step];
        const assign = chosen.get(event.index);
        if (!assign) {
          complete = false;
          break;
        }
        const signature = signatureOf(event);
        const existing = grip.get(signature);
        // Проведение, внутри которого одна и та же высота получила разные
        // пальцы, само по себе не является формой руки.
        if (existing && existing.join(".") !== assign.join(".")) {
          complete = false;
          break;
        }
        grip.set(signature, assign);
      }
      if (complete && grip.size === new Set(window.map(signatureOf)).size) {
        candidates.set(gripKey(grip), grip);
      }
    }
    if (candidates.size === 0) {
      previousGrip = undefined;
      previousEnd = -1;
      continue;
    }

    const cycleWeights = tempoWeights(weights, windowIpi(window));
    const adjacent = previousEnd === cycle.start && previousGrip !== undefined;
    let best: { grip: GripMap; cost: number } | undefined;
    for (const grip of candidates.values()) {
      let cost = cycleCost(window, grip, hand, tables, cycleWeights);
      if (adjacent) {
        cost += MOTIF.continuity * sharedMismatches(previousGrip as GripMap, grip);
      }
      if (!best || cost < best.cost - 1e-9) best = { grip, cost };
    }
    if (!best || !Number.isFinite(best.cost)) {
      previousGrip = undefined;
      previousEnd = -1;
      continue;
    }

    for (let offset = 0; offset < cycle.length; offset += 1) {
      const event = events[cycle.start + offset];
      const assign = best.grip.get(signatureOf(event));
      if (!assign) continue;
      fingers.set(event.index, assign);
    }
    // Фигура попадает в отчёт независимо от того, пришлось ли что-то менять:
    // распознанное повторение — самостоятельная информация для разбора.
    cycles.push({
      start: cycle.start,
      length: cycle.length,
      fromMeasure: events[cycle.start].measureIndex,
      toMeasure: events[cycle.start + cycle.length - 1].measureIndex,
    });
    previousGrip = best.grip;
    previousEnd = cycle.start + cycle.length;
  }

  return { fingers, cycles };
}

/* ------------------------------------------------------------------ *
 * Повторы на расстоянии
 * ------------------------------------------------------------------ */

/**
 * Согласование ОДИНАКОВОГО материала, стоящего не подряд.
 *
 * `consolidateMotifs` работает по смежным циклам: фигура, повторённая тут же,
 * получает одну форму руки. Но тот же такт, вернувшийся через двадцать тактов,
 * решается заново и расходится на доли очка — в корпусе таких мест оставалось
 * 115. Пианист учит материал один раз; повторное проведение играется так же.
 *
 * Логика та же, что у циклов, и с тем же ограничением: слой не изобретает
 * аппликатуру, а выбирает между вариантами, которые поиск уже поставил на
 * разных проведениях. Цена считается вместе с входом и выходом из отрезка,
 * поэтому вариант, выигрывающий только в одном окружении, не навязывается
 * остальным.
 */
export function consolidateRecurrences(
  events: HandEvent[],
  chosen: ReadonlyMap<number, Finger[]>,
  hand: Hand,
  tables: SpanTables,
  weights: RuleWeights,
  blocked: ReadonlySet<number>,
): Map<number, Finger[]> {
  const result = new Map<number, Finger[]>();
  if (events.length === 0) return result;

  // Отрезки — такты руки. Такт остаётся естественной единицей повтора: он
  // совпадает с тем, как материал воспринимается и разучивается.
  const segments: Array<{ from: number; to: number }> = [];
  let from = 0;
  for (let i = 1; i <= events.length; i += 1) {
    if (i === events.length || events[i].measureIndex !== events[from].measureIndex) {
      segments.push({ from, to: i - 1 });
      from = i;
    }
  }

  const free = (index: number): boolean =>
    index >= 0 && index < events.length && !blocked.has(index) && Boolean(chosen.get(events[index].index));

  const groups = new Map<string, Array<{ from: number; to: number }>>();
  for (const segment of segments) {
    const length = segment.to - segment.from + 1;
    if (length < 3) continue;
    let usable = true;
    for (let i = segment.from; i <= segment.to; i += 1) if (!free(i)) { usable = false; break; }
    if (!usable) continue;
    const base = events[segment.from].onset;
    const signature = events
      .slice(segment.from, segment.to + 1)
      .map((event) => `${(event.onset - base).toFixed(3)}:${signatureOf(event)}`)
      .join("|");
    const bucket = groups.get(signature);
    if (bucket) bucket.push(segment);
    else groups.set(signature, [segment]);
  }

  for (const [, occurrences] of groups) {
    if (occurrences.length < 2) continue;
    const size = occurrences[0].to - occurrences[0].from + 1;

    const variants = new Map<string, { vector: Finger[][]; count: number }>();
    for (const occurrence of occurrences) {
      const vector: Finger[][] = [];
      for (let i = occurrence.from; i <= occurrence.to; i += 1) {
        vector.push(chosen.get(events[i].index) as Finger[]);
      }
      const key = vector.map((assign) => assign.join(".")).join("/");
      const seen = variants.get(key);
      if (seen) seen.count += 1;
      else variants.set(key, { vector, count: 1 });
    }
    if (variants.size < 2) continue;

    const window = events.slice(occurrences[0].from, occurrences[0].to + 1);
    const segmentWeights = tempoWeights(weights, windowIpi(window));

    // Цена варианта в ОДНОМ проведении, вместе с входом и выходом в него.
    const localScore = (vector: Finger[][], only: { from: number; to: number }): number => {
      let total = 0;
      for (const occurrence of [only]) {
        for (let k = 0; k < size; k += 1) {
          const event = events[occurrence.from + k];
          total += weigh(gripParts(tables, hand, event.keys, vector[k]), segmentWeights);
          if (k + 1 < size) {
            const next = events[occurrence.from + k + 1];
            total += weigh(
              linkParts(tables, hand, event.keys, vector[k], next.keys, vector[k + 1]),
              segmentWeights,
            );
          }
        }
        const before = occurrence.from - 1;
        if (free(before) && events[occurrence.from].gapBefore <= 1e-4) {
          total += weigh(
            linkParts(
              tables, hand,
              events[before].keys, chosen.get(events[before].index) as Finger[],
              events[occurrence.from].keys, vector[0],
            ),
            segmentWeights,
          );
        }
        const after = occurrence.to + 1;
        if (free(after) && events[after].gapBefore <= 1e-4) {
          total += weigh(
            linkParts(
              tables, hand,
              events[occurrence.to].keys, vector[size - 1],
              events[after].keys, chosen.get(events[after].index) as Finger[],
            ),
            segmentWeights,
          );
        }
      }
      return total;
    };

    // Побеждает вариант с наименьшей суммарной ценой по всем проведениям
    // (вместе с входами и выходами в каждое), при равенстве — тот, который
    // поиск поставил чаще: разнобой создают единичные тай-брейки.
    const list = [...variants.values()]
      .map((item) => ({
        ...item,
        cost: occurrences.reduce((sum, o) => sum + localScore(item.vector, o), 0),
      }))
      .filter((item) => Number.isFinite(item.cost))
      .sort((left, right) => left.cost - right.cost || right.count - left.count);
    const best = list[0];
    if (!best) continue;

    for (const occurrence of occurrences) {
      for (let k = 0; k < size; k += 1) {
        result.set(events[occurrence.from + k].index, best.vector[k]);
      }
    }
  }

  return result;
}
