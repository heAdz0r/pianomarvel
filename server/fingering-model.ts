/**
 * Эргономическая модель аппликатуры.
 *
 * Источник: Parncutt, R., Sloboda, J. A., Clarke, E. F., Raekallio, M., & Desain, P.
 * (1997). An Ergonomic Model of Keyboard Fingering for Melodic Fragments.
 * Music Perception, 14(4), 341–382. Таблица 1 и Приложение статьи.
 *
 * Уточнения: Jacobs, J. P. (2001). Refinements to the Ergonomic Model...
 * Music Perception, 18(4), 505–511 — повтор пальца, скольжение, подмена.
 *
 * Модель считает «очки трудности»: чем больше, тем труднее. Все матрицы заданы
 * для ПРАВОЙ руки; левая получается инверсией знака интервала (статья, §Table 1).
 *
 * Здесь только чистые функции стоимости — ни разбора XML, ни поиска.
 * Полный разбор проектных решений — docs/fingering-prd.md.
 */

export type Finger = 1 | 2 | 3 | 4 | 5;
export type Hand = "L" | "R";

export const FINGERS: readonly Finger[] = [1, 2, 3, 4, 5];

/** Клавиша: MIDI-высота и цвет. Цвет считается один раз при разборе партитуры. */
export interface Key {
  midi: number;
  black: boolean;
}

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

export function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
}

/**
 * Матрицы максимальных растяжений правой руки в полутонах (Приложение статьи).
 * Строка — первый палец пары, столбец — второй. Положительные значения под
 * диагональю означают перекладывание (палец над большим или большой под пальцем).
 */
const MAX_PRAC = [
  [0, 10, 12, 14, 15],
  [5, 0, 5, 7, 10],
  [4, -1, 0, 4, 7],
  [3, -1, -1, 0, 5],
  [1, -2, -1, -1, 0],
];
const MAX_COMF = [
  [0, 8, 10, 12, 13],
  [3, 0, 3, 5, 8],
  [2, -1, 0, 2, 5],
  [1, -1, -1, 0, 3],
  [-1, -2, -1, -1, 0],
];
const MAX_REL = [
  [0, 5, 7, 9, 10],
  [-1, 0, 2, 4, 6],
  [-3, -1, 0, 2, 4],
  [-5, -3, -1, 0, 2],
  [-7, -5, -3, -1, 0],
];

export interface SpanTables {
  prac: number[][];
  comf: number[][];
  rel: number[][];
}

/**
 * Таблицы с поправкой на размер руки. Статья прямо разрешает такое
 * масштабирование: «для меньшей руки достаточно умножить все значения
 * примерно на 0.9».
 */
export function spanTables(handSpan = 1): SpanTables {
  const scale = (matrix: number[][]): number[][] =>
    matrix.map((row) => row.map((value) => Math.round(value * handSpan)));
  return { prac: scale(MAX_PRAC), comf: scale(MAX_COMF), rel: scale(MAX_REL) };
}

const upper = (matrix: number[][], f: Finger, g: Finger): number => matrix[f - 1][g - 1];
/** MinX(f,g) = −MaxX(g,f) — тождество из Приложения статьи. */
const lower = (matrix: number[][], f: Finger, g: Finger): number => -matrix[g - 1][f - 1];

export const maxPrac = (t: SpanTables, f: Finger, g: Finger): number => upper(t.prac, f, g);
export const minPrac = (t: SpanTables, f: Finger, g: Finger): number => lower(t.prac, f, g);
export const maxComf = (t: SpanTables, f: Finger, g: Finger): number => upper(t.comf, f, g);
export const minComf = (t: SpanTables, f: Finger, g: Finger): number => lower(t.comf, f, g);
export const maxRel = (t: SpanTables, f: Finger, g: Finger): number => upper(t.rel, f, g);
export const minRel = (t: SpanTables, f: Finger, g: Finger): number => lower(t.rel, f, g);

/** Интервал в «правостороннем» виде: для левой руки зеркалим знак. */
export function normalizedInterval(hand: Hand, from: Key, to: Key): number {
  const raw = to.midi - from.midi;
  return hand === "R" ? raw : -raw;
}

export interface CostParts {
  /**
   * Повтор одного пальца на разных звуках. В модели Parncutt такие переходы
   * запрещены вовсе (Таблица 1 не содержит пар вида f-f). Jacobs (2001)
   * разрешает два исключения — повтор одной и той же ноты и скольжение с
   * чёрной клавиши на белую, — поэтому вместо запрета здесь штраф: он
   * оставляет исключения возможными и не создаёт тупиков в поиске.
   */
  sameFinger: number;
  /**
   * Досрочное снятие нотированно удержанного голоса другой руки/слоя. Это не
   * смена позиции: раньше цена снятия падала в `positionChangeCount` и учебная
   * карточка приписывала педальную передачу правилам 4 и 5.
   */
  voiceRelease: number;
  stretch: number;
  smallSpan: number;
  largeSpan: number;
  positionChangeCount: number;
  positionChangeSize: number;
  weakFinger: number;
  threeFourFive: number;
  threeToFour: number;
  fourOnBlack: number;
  thumbOnBlack: number;
  fiveOnBlack: number;
  thumbPassing: number;
  /**
   * Отдельная слабость 4-го пальца сверх правила 6.
   *
   * Правило 6 Parncutt берёт 1 очко и за 4-й, и за 5-й палец. Это упрощение:
   * 4-й палец не имеет собственного разгибателя (общий m. extensor digitorum
   * с 3-м и 5-м), поэтому в быстром пассаже он и медленнее, и менее независим,
   * тогда как 5-й — короткий, но независимый. Без этой добавки 4 и 5 стоят
   * одинаково, и тай-брейк по сумме пальцев систематически выбирает 4.
   */
  fourFinger: number;
  /**
   * Смещение кисти как целого между соседними событиями (правила 4 и 5
   * смотрят только на тройку и не видят медленного дрейфа). Считается по
   * «виртуальному положению большого пальца» и масштабируется темпом.
   */
  handShift: number;
}

export type RuleWeights = Record<keyof CostParts, number>;

/**
 * Веса правил. В оригинальной модели все правила складываются с весом 1 —
 * отклонение от единицы допустимо только с обоснованием и тестом
 * чувствительности (docs/fingering-prd.md §6.8).
 */
export const DEFAULT_WEIGHTS: RuleWeights = {
  sameFinger: 1,
  voiceRelease: 1,
  stretch: 1,
  smallSpan: 1,
  largeSpan: 1,
  positionChangeCount: 1,
  positionChangeSize: 1,
  weakFinger: 1,
  threeFourFive: 1,
  threeToFour: 1,
  fourOnBlack: 1,
  thumbOnBlack: 1,
  fiveOnBlack: 1,
  thumbPassing: 1,
  /**
   * Замер по корпусу: отдельная добавка за 4-й палец даёт −0.004 согласия
   * (Hanon 0.768 → 0.757) и по умолчанию выключена. Правило остаётся частью
   * модели: его можно включить весом для руки, которой 4-й палец даётся хуже
   * обычного, — тогда 4 и 5 перестают быть равноценными в тай-брейке.
   */
  fourFinger: 0,
  handShift: 1,
};

export function emptyParts(): CostParts {
  return {
    sameFinger: 0,
    voiceRelease: 0,
    stretch: 0,
    smallSpan: 0,
    largeSpan: 0,
    positionChangeCount: 0,
    positionChangeSize: 0,
    weakFinger: 0,
    threeFourFive: 0,
    threeToFour: 0,
    fourOnBlack: 0,
    thumbOnBlack: 0,
    fiveOnBlack: 0,
    thumbPassing: 0,
    fourFinger: 0,
    handShift: 0,
  };
}

export function addParts(target: CostParts, source: CostParts, factor = 1): CostParts {
  for (const key of Object.keys(target) as Array<keyof CostParts>) {
    target[key] += source[key] * factor;
  }
  return target;
}

export function weigh(parts: CostParts, weights: RuleWeights = DEFAULT_WEIGHTS): number {
  let total = 0;
  for (const key of Object.keys(parts) as Array<keyof CostParts>) {
    total += parts[key] * weights[key];
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * Темп
 * ------------------------------------------------------------------ */

/**
 * Поправка на скорость.
 *
 * Модель Parncutt откалибрована на «медленных и умеренных» одноголосных
 * фрагментах и сама по себе темпа не знает (статья, §Scope). Между тем
 * трудность движения зависит не от нотной длительности, а от реального
 * времени между атаками: перекладывание большого пальца, смена позиции и
 * повтор пальца, безобидные при ♩=60, при ♩=132 восьмыми (65 мс на ноту)
 * становятся физически невыполнимыми. Растяжение же — статическая поза,
 * оно дорожает медленнее: рука уже стоит в нужной форме.
 *
 * Поэтому вводится один множитель: `referenceIpi / ipi`, ограниченный
 * сверху. Правила движения берут его целиком, правила позы — корень
 * (вдвое более пологий рост). При неизвестном темпе множитель равен 1 и
 * модель ведёт себя в точности как прежде.
 */
export const TEMPO_MODEL = {
  /** Межнотовый интервал, при котором модель работает без поправки, с. */
  referenceIpi: 0.3,
  /** Ниже этого порога рост множителя останавливается: 5 нот/с уже предел. */
  floorIpi: 0.1,
  /** Ниже единицы множитель не опускается: медленный темп ничего не удешевляет. */
  maxScale: 3,
  /**
   * Полутонов свободного дрейфа кисти между соседними событиями.
   *
   * Опорная точка руки восстанавливается по одной ноте и её пальцу, поэтому
   * она заведомо приблизительна; допуск отсекает этот шум. Замер по корпусу
   * тянет допуск к нулю (0.8583 против 0.8533 при 2), но нулевой допуск ломает
   * школьный альбертиев бас: 5-1-3-1 проигрывает 5-1-2-1 полутора очками
   * мнимого переноса. Канон важнее пяти сотых процента согласия.
   */
  freeShift: 2,
} as const;

/** Секунды между атаками по длительности в четвертях и темпу (BPM четвертей). */
export function interPressInterval(
  quarters: number,
  tempo: number | undefined,
): number | undefined {
  if (!tempo || !Number.isFinite(tempo) || tempo <= 0) return undefined;
  if (!Number.isFinite(quarters) || quarters <= 0) return undefined;
  return (quarters * 60) / tempo;
}

/** Множитель трудности движения: 1 при неизвестном или спокойном темпе. */
export function motionScale(ipiSeconds: number | undefined): number {
  if (ipiSeconds === undefined) return 1;
  const ipi = Math.max(ipiSeconds, TEMPO_MODEL.floorIpi);
  return Math.min(TEMPO_MODEL.maxScale, Math.max(1, TEMPO_MODEL.referenceIpi / ipi));
}

/** Правила движения — полный множитель, правила позы — корень из него. */
const MOTION_RULES: ReadonlySet<keyof CostParts> = new Set([
  "sameFinger",
  "positionChangeCount",
  "positionChangeSize",
  "thumbPassing",
  "handShift",
]);

const POSTURE_RULES: ReadonlySet<keyof CostParts> = new Set([
  "stretch",
  "smallSpan",
  "largeSpan",
  "weakFinger",
  "fourFinger",
  "threeFourFive",
  "threeToFour",
  "fourOnBlack",
  "thumbOnBlack",
  "fiveOnBlack",
]);

const TEMPO_WEIGHT_CACHE = new Map<string, RuleWeights>();

/**
 * Веса, пересчитанные под конкретную скорость. Кэш нужен потому, что beam-поиск
 * зовёт это на каждом переходе каждого кандидата.
 */
export function tempoWeights(base: RuleWeights, ipiSeconds: number | undefined): RuleWeights {
  const scale = motionScale(ipiSeconds);
  if (scale === 1) return base;
  const rounded = Math.round(scale * 100) / 100;
  const cacheKey = `${rounded}|${base === DEFAULT_WEIGHTS ? "d" : JSON.stringify(base)}`;
  const cached = TEMPO_WEIGHT_CACHE.get(cacheKey);
  if (cached) return cached;
  const posture = Math.sqrt(rounded);
  const scaled = { ...base };
  for (const key of Object.keys(scaled) as Array<keyof CostParts>) {
    if (MOTION_RULES.has(key)) scaled[key] = base[key] * rounded;
    else if (POSTURE_RULES.has(key)) scaled[key] = base[key] * posture;
  }
  TEMPO_WEIGHT_CACHE.set(cacheKey, scaled);
  return scaled;
}

/**
 * «Виртуальное положение большого пальца» — точка отсчёта формы руки.
 *
 * Середина расслабленного диапазона между 1-м и взятым пальцем: если 3-й палец
 * стоит на C5, кисть расположена так, будто большой лежит около G4. Смещение
 * этой точки и есть перенос руки, независимый от того, какие пальцы играют.
 */
export function handAnchor(t: SpanTables, hand: Hand, finger: Finger, key: Key): number {
  const offset = (maxRel(t, 1, finger) + minRel(t, 1, finger)) / 2;
  return hand === "R" ? key.midi - offset : key.midi + offset;
}

/**
 * Перенос кисти сверх свободного дрейфа.
 *
 * Перекладывание большого пальца исключено: подкладывание и переброс — это и
 * есть школьный способ переместить руку связно, он уже оплачен правилом 12.
 * Без исключения гамма штрафуется дважды за одно и то же движение, и согласие
 * со школьным каноном падает (замер: 0.986 → 0.975 на корпусе гамм).
 */
export function handShiftCost(
  t: SpanTables,
  hand: Hand,
  f: Finger,
  from: Key,
  g: Finger,
  to: Key,
): number {
  const interval = normalizedInterval(hand, from, to);
  const crossing = (f === 1 && g !== 1 && interval < 0) || (f !== 1 && g === 1 && interval > 0);
  if (crossing) return 0;
  const travel = Math.abs(handAnchor(t, hand, g, to) - handAnchor(t, hand, f, from));
  return Math.max(0, travel - TEMPO_MODEL.freeShift);
}

/**
 * Правило 1 (Stretch): 2 очка за каждый полутон выхода за MaxComf/MinComf.
 */
export function stretchCost(t: SpanTables, f: Finger, g: Finger, interval: number): number {
  const high = maxComf(t, f, g);
  const low = minComf(t, f, g);
  if (interval > high) return 2 * (interval - high);
  if (interval < low) return 2 * (low - interval);
  return 0;
}

/**
 * Правила 2 и 3 (Small-Span / Large-Span). Пары с большим пальцем стоят
 * 1 очко за полутон, без большого — 2 очка.
 *
 * Приложение статьи: при f > g названия правил меняются местами (речь про
 * абсолютный размер интервала, а не про знак). На сумму это не влияет, но
 * разбивка совпадает с примерами статьи только с этой перестановкой.
 */
export function spanCosts(
  t: SpanTables,
  f: Finger,
  g: Finger,
  interval: number,
): { smallSpan: number; largeSpan: number } {
  const thumb = f === 1 || g === 1;
  const factor = thumb ? 1 : 2;
  const low = minRel(t, f, g);
  const high = maxRel(t, f, g);
  const belowRelaxed = interval < low ? factor * (low - interval) : 0;
  const aboveRelaxed = interval > high ? factor * (interval - high) : 0;
  return f > g
    ? { smallSpan: aboveRelaxed, largeSpan: belowRelaxed }
    : { smallSpan: belowRelaxed, largeSpan: aboveRelaxed };
}

/**
 * Штраф за повтор пальца. Скольжение с чёрной клавиши на белую соседним
 * движением руки — приём из школы (Jacobs, 2001), он почти бесплатен;
 * перенос пальца на произвольную другую ноту требует снять руку с клавиатуры.
 */
export const SAME_FINGER_LEAP = 8;

export function isFingerSlide(from: Key, to: Key): boolean {
  return Math.abs(to.midi - from.midi) <= 2 && from.black && !to.black;
}

/** Правило 6 (Weak-Finger): 1 очко за каждое использование 4-го или 5-го пальца. */
export function weakFingerCost(finger: Finger): number {
  return finger === 4 || finger === 5 ? 1 : 0;
}

/**
 * Добавка за 4-й палец (см. `CostParts.fourFinger`). Половина очка: правило 6
 * остаётся ведущим, добавка лишь разводит 4 и 5, которые у Parncutt равны.
 */
export const FOUR_FINGER_PENALTY = 0.5;

export function fourFingerCost(finger: Finger): number {
  return finger === 4 ? FOUR_FINGER_PENALTY : 0;
}

/** Правило 8 (Three-to-Four): 1 очко за переход 3 → 4. */
export function threeToFourCost(f: Finger, g: Finger): number {
  return f === 3 && g === 4 ? 1 : 0;
}

/** Правило 9 (Four-on-Black): 3 и 4 подряд в любом порядке, 3 на белой, 4 на чёрной. */
export function fourOnBlackCost(f: Finger, from: Key, g: Finger, to: Key): number {
  if (f === 3 && g === 4) return !from.black && to.black ? 1 : 0;
  if (f === 4 && g === 3) return from.black && !to.black ? 1 : 0;
  return 0;
}

/** Правило 7 (Three-Four-Five): 1 очко за тройку из 3, 4, 5 в любом порядке. */
export function threeFourFiveCost(f: Finger, g: Finger, h: Finger): number {
  const used = new Set([f, g, h]);
  return used.size === 3 && used.has(3) && used.has(4) && used.has(5) ? 1 : 0;
}

/**
 * Правило 12 (Thumb-Passing). Перекладывание — это переход, при котором
 * порядок пальцев противоречит направлению интервала. В таком переходе нота
 * большого пальца всегда лежит «выше» в нормализованных координатах.
 *
 * 0 очков: не-большой на чёрной → большой на белой (базовая аппликатура гамм);
 * 1 очко: одинаковый уровень (бел→бел, чёрн→чёрн);
 * 3 очка: не-большой на белой, большой на чёрной.
 */
export function thumbPassingCost(
  f: Finger,
  from: Key,
  g: Finger,
  to: Key,
  interval: number,
): number {
  const crossing = (f === 1 && g !== 1 && interval < 0) || (f !== 1 && g === 1 && interval > 0);
  if (!crossing) return 0;
  const thumbKey = f === 1 ? from : to;
  const otherKey = f === 1 ? to : from;
  if (thumbKey.black && !otherKey.black) return 3;
  return thumbKey.black === otherKey.black ? 1 : 0;
}

/**
 * Правила 10 и 11 (Thumb-on-Black, Five-on-Black). Обе зависят от цвета
 * соседних клавиш и от того, каким пальцем взята соседняя нота, поэтому
 * считаются для ноты с известным окружением. `previous`/`next` и их пальцы
 * могут отсутствовать на краях фрагмента.
 */
export function blackKeyCosts(
  finger: Finger,
  key: Key,
  previous?: Key,
  next?: Key,
  previousFinger?: Finger,
  nextFinger?: Finger,
): { thumbOnBlack: number; fiveOnBlack: number } {
  if (!key.black) return { thumbOnBlack: 0, fiveOnBlack: 0 };
  // Table 1: добавочные очки даёт только белая соседняя нота, взятая НЕ большим
  // пальцем. Скольжение большого пальца с чёрной на белую не наказывается.
  const penalised = (neighbour: Key | undefined, neighbourFinger: Finger | undefined): number =>
    neighbour && !neighbour.black && neighbourFinger !== 1 ? 2 : 0;
  const neighbours = penalised(previous, previousFinger) + penalised(next, nextFinger);
  if (finger === 1) return { thumbOnBlack: 1 + neighbours, fiveOnBlack: 0 };
  if (finger === 5) return { thumbOnBlack: 0, fiveOnBlack: neighbours };
  return { thumbOnBlack: 0, fiveOnBlack: 0 };
}

/**
 * Правила 4 и 5 (Position-Change-Count, Position-Change-Size) — считаются по
 * тройке последовательных нот.
 *
 * Смена позиции есть, когда интервал между первой и третьей нотой выходит за
 * MinComf/MaxComf пары (f1, f3). Полная смена: средняя нота играется большим
 * пальцем, её высота лежит между крайними, а интервал крайних выходит уже за
 * MinPrac/MaxPrac. Особый случай статьи: повторение ноты через одну (C-F-C
 * пальцами 2-5-1) считается половинной сменой нулевого размера.
 */
export function positionChangeCosts(
  t: SpanTables,
  hand: Hand,
  fingers: [Finger, Finger, Finger],
  keys: [Key, Key, Key],
): { positionChangeCount: number; positionChangeSize: number } {
  const [f1, f2, f3] = fingers;
  const [k1, k2, k3] = keys;
  const interval = normalizedInterval(hand, k1, k3);

  // Повтор пальца на разных клавишах — физический перенос кисти, а не позиция.
  // Диапазон пары (f1, f3) для такой тройки ничего не значит: один палец
  // дотянется куда угодно, если руку переставить. Правило же сравнивало
  // крайние ноты с этим диапазоном и объявляло тройку «без смены позиции» —
  // и тем ПООЩРЯЛО повтор. Из-за этого одноктавное арпеджио A-C-E-A получало
  // 1-1-2-5 (нулевая цена правил 4 и 5) вместо школьного 1-2-3-5, у которого
  // раскрытие кисти честно считается сменой позиции.
  const repeatMove =
    (f1 === f2 && k1.midi !== k2.midi && !isFingerSlide(k1, k2)
      ? Math.abs(k2.midi - k1.midi)
      : 0) +
    (f2 === f3 && k2.midi !== k3.midi && !isFingerSlide(k2, k3)
      ? Math.abs(k3.midi - k2.midi)
      : 0);
  if (repeatMove > 0) {
    return { positionChangeCount: 1, positionChangeSize: repeatMove };
  }

  if (k1.midi === k3.midi) {
    return f1 === f3
      ? { positionChangeCount: 0, positionChangeSize: 0 }
      : { positionChangeCount: 1, positionChangeSize: 0 };
  }

  const high = maxComf(t, f1, f3);
  const low = minComf(t, f1, f3);
  if (interval <= high && interval >= low) {
    return { positionChangeCount: 0, positionChangeSize: 0 };
  }

  const between =
    (k2.midi > Math.min(k1.midi, k3.midi) && k2.midi < Math.max(k1.midi, k3.midi));
  const full =
    f2 === 1 &&
    between &&
    (interval > maxPrac(t, f1, f3) || interval < minPrac(t, f1, f3));
  const size = interval > high ? interval - high : low - interval;
  return { positionChangeCount: full ? 2 : 1, positionChangeSize: size };
}

/**
 * Стоимость перехода между двумя соседними нотами одной руки: правила
 * 1, 2, 3, 8, 9, 12 плюс правило 6 для второй ноты.
 */
export function transitionParts(
  t: SpanTables,
  hand: Hand,
  f: Finger,
  from: Key,
  g: Finger,
  to: Key,
): CostParts {
  const parts = emptyParts();
  const interval = normalizedInterval(hand, from, to);
  if (f === g) {
    // Уточнение Jacobs (2001): растяжения тут нет — палец переносится, а не
    // растягивается. Бесплатны только повтор ноты и скольжение с чёрной на белую.
    parts.weakFinger = weakFingerCost(g);
    parts.fourFinger = fourFingerCost(g);
    if (from.midi === to.midi) return parts;
    if (isFingerSlide(from, to)) {
      parts.sameFinger = 1;
      return parts;
    }
    // Через скачок шире квинты рука всё равно переносится целиком, и повтор
    // пальца перестаёт быть дефектом: штраф остаётся только внутри позиции.
    const leap = Math.abs(to.midi - from.midi);
    parts.sameFinger = leap > 7 ? 1 : SAME_FINGER_LEAP;
    return parts;
  }
  const spans = spanCosts(t, f, g, interval);
  parts.stretch = stretchCost(t, f, g, interval);
  parts.smallSpan = spans.smallSpan;
  parts.largeSpan = spans.largeSpan;
  parts.threeToFour = threeToFourCost(f, g);
  parts.fourOnBlack = fourOnBlackCost(f, from, g, to);
  parts.thumbPassing = thumbPassingCost(f, from, g, to, interval);
  parts.weakFinger = weakFingerCost(g);
  parts.fourFinger = fourFingerCost(g);
  parts.handShift = handShiftCost(t, hand, f, from, g, to);
  return parts;
}

/**
 * Достижимость перехода: интервал должен укладываться в практический предел
 * пары пальцев. Повтор одного пальца допустим всегда (Jacobs, 2001).
 */
export function transitionFeasible(
  t: SpanTables,
  hand: Hand,
  f: Finger,
  from: Key,
  g: Finger,
  to: Key,
): boolean {
  if (f === g) return from.midi === to.midi || isFingerSlide(from, to);
  const interval = normalizedInterval(hand, from, to);
  return interval <= maxPrac(t, f, g) && interval >= minPrac(t, f, g);
}

/** Достижимость одновременного взятия двух нот аккорда. */
export function chordFeasible(
  t: SpanTables,
  hand: Hand,
  lowFinger: Finger,
  low: Key,
  highFinger: Finger,
  high: Key,
): boolean {
  if (lowFinger === highFinger) return false;
  const interval = normalizedInterval(hand, low, high);
  const [f, g] = hand === "R" ? [lowFinger, highFinger] : [highFinger, lowFinger];
  const span = Math.abs(interval);
  return span <= Math.abs(maxPrac(t, f, g)) && span >= 0;
}
