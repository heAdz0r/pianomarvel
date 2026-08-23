/**
 * Слои формы и метра (L3, L4): повторность, новизна, граф секций и гиперметр.
 *
 * Зачем: формальные метки (rehearsal, repeat, ending, segno/coda) есть только у 7
 * партитур корпуса из 18, а гиперметрическая периодичность и повторность измеримы
 * во всех. Форма выводится из самой музыки — как в MIR-практике: матрица
 * самоподобия по тактам, новизна ядром-шахматкой (Foote) и поиск повторяющихся
 * блоков; период И фаза гиперметра оцениваются вместе, вместо жёсткого правила
 * «каждые четыре такта».
 */

import {
  attacksOf,
  soundingOf,
  type MeasureNotes,
} from "./adaptive-notes";

export interface MeasureFeature {
  chroma: number[];
  bass: number[];
  rhythm: number[];
  texture: number[];
  /** Точный отпечаток такта: те же высоты в тех же позициях. */
  fingerprint: string;
  silent: boolean;
}

export interface Hypermeter {
  period: number;
  /** Индекс такта (0-based) первого сильного такта: downbeat при index % period === phase. */
  phase: number;
  /** Насколько уверенно период отличается от следующего кандидата, [0,1]. */
  confidence: number;
}

export interface SectionSpan {
  start: number;
  end: number;
  label: string;
}

export interface StructureAnalysis {
  features: MeasureFeature[];
  hypermeter: Hypermeter;
  /** Новизна материала на стыке тактов i/i+1, [0,1]. */
  novelty: number[];
  /** Сила формального шва после такта i, [0,1]. */
  sectionBoundaryAfter: number[];
  sections: SectionSpan[];
  /** Такт начинает блок, который дословно повторяется в другом месте партитуры. */
  repeatBlockStart: boolean[];
  /** Такт находится внутри дословно повторяющегося блока (кроме его начала). */
  insideRepeatBlock: boolean[];
  /** 1 — материал встречается впервые, меньше — уже отработан ранее. */
  materialNovelty: number[];
  /** Такт — гиперметрически сильный (начало периода своей секции). */
  hyperDownbeat: boolean[];
  /** Иерархический вес опоры: 3 — начало четырёх периодов, 2 — двух, 1 — периода. */
  hyperTier: number[];
  /** Уверенность гиперметра, действующая в этом такте. */
  hyperConfidence: number[];
  /** Гиперметр каждой секции: у вставки или припева фаза может отличаться. */
  sectionHypermeter: Hypermeter[];
}

const PERIOD_CANDIDATES = [2, 3, 4, 6, 8] as const;
/** Контраст блоков, который уже уверенно читается как смена материала. */
export const NOVELTY_REFERENCE = 0.35;
/** Ниже этого контраста пик новизны — рябь однородной фактуры, а не шов формы. */
const NOVELTY_FLOOR = 0.3;
/** Периодичность важнее акцентов; акценты решают, когда периоды равнозначны. */
const ACCENT_WEIGHT = 0.25;
/**
 * Ничья — только полное совпадение счёта. Более широкий допуск глушил настоящее
 * преимущество: разница между четырёх- и восьмитактовым периодом составляет тысячные.
 */
const PERIOD_TIE_EPSILON = 1e-6;

export function analyzeStructure(
  measures: MeasureNotes[],
  accents: number[],
  formalBoundaryAfter: boolean[],
): StructureAnalysis {
  const count = measures.length;
  const features = measures.map((measure) => measureFeature(measure));
  normalizeTexture(features);
  const hypermeter = estimateHypermeter(features, accents);
  // Окно новизны должно быть размера раздела, а не фразы: на двухтактовом окне любая
  // смена мелодии выглядит сменой формы, и однородная пьеса получает шов на каждом шагу.
  const window = Math.max(4, Math.min(8, hypermeter.period * 2));
  const novelty = noveltyCurve(features, window);
  const { repeatBlockStart, insideRepeatBlock, materialNovelty, segments, fuzzy } =
    repeatBlocks(features, window);
  const sectionBoundaryAfter = sectionSeams(
    novelty,
    segments,
    fuzzy,
    formalBoundaryAfter,
    features,
    window,
  );
  const sections = buildSections(sectionBoundaryAfter, features, hypermeter.period);
  // Гиперметр переоценивается внутри каждой секции: после нерегулярной вставки или
  // связки фаза сдвигается, и общий на всю пьесу период начинает спорить с музыкой.
  const sectionHypermeter = sections.map((section) => {
    const length = section.end - section.start + 1;
    // Пересматривается только ФАЗА: вставка нечётного такта или связка сдвигают
    // начало периода, но не его длину. Пересчёт самого периода на коротком отрезке
    // ломал четырёхтактовую сетку там, где она заведомо верна.
    if (length < hypermeter.period * 4) return hypermeter;
    const phase = bestPhaseWithin(
      accents,
      hypermeter.period,
      hypermeter.phase,
      section.start,
      section.end,
    );
    return phase === hypermeter.phase ? hypermeter : { ...hypermeter, phase };
  });
  const hyperDownbeat = Array<boolean>(count).fill(false);
  const hyperTier = Array<number>(count).fill(0);
  const hyperConfidence = Array<number>(count).fill(hypermeter.confidence);
  for (const [order, section] of sections.entries()) {
    const local = sectionHypermeter[order];
    // Иерархия опор считается от первой опоры секции: внутри раздела вторая и
    // четвёртая опоры весят больше, чем каждая следующая.
    let anchor = section.start;
    while (anchor <= section.end && anchor % local.period !== local.phase) anchor += 1;
    for (let index = section.start; index <= section.end; index += 1) {
      hyperConfidence[index] = local.confidence;
      const offset = index - anchor;
      if (offset < 0 || offset % local.period !== 0) continue;
      hyperDownbeat[index] = true;
      hyperTier[index] =
        offset % (local.period * 4) === 0 ? 3 : offset % (local.period * 2) === 0 ? 2 : 1;
    }
  }
  return {
    features,
    hypermeter,
    novelty,
    sectionBoundaryAfter,
    sections,
    repeatBlockStart,
    insideRepeatBlock,
    materialNovelty,
    hyperDownbeat,
    hyperTier,
    hyperConfidence,
    sectionHypermeter,
  };
}

export function measureFeature(measure: MeasureNotes): MeasureFeature {
  const chroma = Array<number>(12).fill(0);
  const bass = Array<number>(12).fill(0);
  const rhythm = Array<number>(8).fill(0);
  const sounding = soundingOf(measure);
  const quarters = Math.max(0.5, measure.quarterBeats);
  for (const note of sounding) {
    const weight = Math.max(0.25, note.duration);
    chroma[(note.midi as number) % 12] += weight;
  }
  const attacks = attacksOf(measure);
  for (const note of attacks) {
    const bin = Math.min(7, Math.max(0, Math.floor((note.onset / quarters) * 8)));
    rhythm[bin] += 1;
  }
  // Бас берём по самой низкой ноте каждой атаки: гармоническую функцию задаёт он,
  // а не общий набор высот.
  const byOnset = new Map<number, number>();
  for (const note of sounding) {
    const current = byOnset.get(note.onset);
    const midi = note.midi as number;
    if (current === undefined || midi < current) byOnset.set(note.onset, midi);
  }
  for (const midi of byOnset.values()) bass[midi % 12] += 1;
  const pitches = sounding.map((note) => note.midi as number);
  const texture = [
    attacks.length / quarters,
    new Set(sounding.map((note) => note.stream)).size,
    maxChordSize(measure),
    pitches.length ? mean(pitches) : 0,
    pitches.length ? Math.max(...pitches) - Math.min(...pitches) : 0,
  ];
  return {
    chroma: normalizeVector(chroma),
    bass: normalizeVector(bass),
    rhythm: normalizeVector(rhythm),
    texture,
    fingerprint: fingerprintOf(measure),
    silent: sounding.length === 0,
  };
}

function maxChordSize(measure: MeasureNotes): number {
  const counts = new Map<string, number>();
  for (const note of soundingOf(measure)) {
    const key = `${note.stream}:${note.onset}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function fingerprintOf(measure: MeasureNotes): string {
  const notes = soundingOf(measure);
  if (notes.length === 0) return "";
  return notes
    .map(
      (note) =>
        `${round(note.onset, 3)}:${note.midi}:${round(note.duration, 3)}`,
    )
    .sort()
    .join("|");
}

/** Текстурные признаки в разных единицах: приводим каждый столбец к [0,1] по пьесе. */
function normalizeTexture(features: MeasureFeature[]): void {
  const width = features[0]?.texture.length ?? 0;
  for (let column = 0; column < width; column += 1) {
    const values = features.map((feature) => feature.texture[column]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    for (const feature of features) {
      feature.texture[column] = span > 0 ? (feature.texture[column] - min) / span : 0;
    }
  }
}

const CHROMA_WEIGHT = 0.45;
const BASS_WEIGHT = 0.2;
const RHYTHM_WEIGHT = 0.2;
const TEXTURE_WEIGHT = 0.15;

export function similarity(left: MeasureFeature, right: MeasureFeature): number {
  if (left.silent && right.silent) return 1;
  if (left.silent !== right.silent) return 0.1;
  return combineSimilarity(
    cosine(left.chroma, right.chroma),
    cosine(left.bass, right.bass),
    cosine(left.rhythm, right.rhythm),
    textureSimilarity(left, right),
  );
}

function textureSimilarity(left: MeasureFeature, right: MeasureFeature): number {
  const textureDistance =
    left.texture.reduce(
      (sum, value, index) => sum + Math.abs(value - right.texture[index]),
      0,
    ) / Math.max(1, left.texture.length);
  return 1 - Math.min(1, textureDistance);
}

function combineSimilarity(
  chroma: number,
  bass: number,
  rhythm: number,
  texture: number,
): number {
  return (
    CHROMA_WEIGHT * chroma +
    BASS_WEIGHT * bass +
    RHYTHM_WEIGHT * rhythm +
    TEXTURE_WEIGHT * texture
  );
}

/**
 * Точная верхняя оценка по первому слагаемому: остальные компоненты не больше
 * единицы, поэтому заведомо слабую пару можно не досчитывать.
 */
function boundedSimilarity(
  left: MeasureFeature,
  right: MeasureFeature,
  threshold: number,
): number | undefined {
  if (left.silent || right.silent) {
    const value = similarity(left, right);
    return value >= threshold ? value : undefined;
  }
  const chroma = cosine(left.chroma, right.chroma);
  let upperBound = CHROMA_WEIGHT * chroma + (1 - CHROMA_WEIGHT);
  // Косинусные компоненты могут выходить за 1 на несколько ulp из-за Float64;
  // маленький запас не даёт точной верхней оценке ложно отсечь граничную пару.
  if (upperBound + 1e-12 < threshold) return undefined;
  const bass = cosine(left.bass, right.bass);
  upperBound =
    CHROMA_WEIGHT * chroma +
    BASS_WEIGHT * bass +
    RHYTHM_WEIGHT +
    TEXTURE_WEIGHT;
  if (upperBound + 1e-12 < threshold) return undefined;
  const rhythm = cosine(left.rhythm, right.rhythm);
  upperBound =
    CHROMA_WEIGHT * chroma +
    BASS_WEIGHT * bass +
    RHYTHM_WEIGHT * rhythm +
    TEXTURE_WEIGHT;
  if (upperBound + 1e-12 < threshold) return undefined;
  return combineSimilarity(chroma, bass, rhythm, textureSimilarity(left, right));
}

/**
 * Период и фаза выбираются совместно: сходство такта с тактом на расстоянии p
 * говорит о длине периода, а метрические акценты — о том, какой такт в нём первый.
 * Без фазы правило «каждые четыре такта» разъезжается с музыкой на любом затакте.
 */
export function estimateHypermeter(
  features: MeasureFeature[],
  accents: number[],
): Hypermeter {
  const count = features.length;
  if (count < 4) return { period: Math.max(1, Math.min(2, count)), phase: 0, confidence: 0 };
  const laggedSimilarity = (lag: number) => {
    if (lag >= count) return 0;
    let sum = 0;
    for (let index = 0; index + lag < count; index += 1) {
      sum += similarity(features[index], features[index + lag]);
    }
    return sum / Math.max(1, count - lag);
  };
  // Абсолютное сходство на лаге мало о чём говорит: у остинато оно высокое на всех
  // лагах. Периодичность — это превышение над средним уровнем сходства пьесы.
  const baseline = mean(
    [1, 2, 3, 4, 5, 6, 7, 8].filter((lag) => lag < count).map(laggedSimilarity),
  );
  // «Сильный» акцент — заметный по меркам этой партитуры, а не по абсолютной шкале.
  const accentThreshold = Math.max(0.5, quantile(accents, 0.75));
  const strongAccents = new Set(
    accents
      .map((value, index) => ({ value, index }))
      .filter((item) => item.value >= accentThreshold)
      .map((item) => item.index),
  );
  const scored: Array<{ period: number; phase: number; score: number }> = [];
  for (const period of PERIOD_CANDIDATES) {
    if (period >= count) continue;
    const selfSimilarity = laggedSimilarity(period) - baseline;
    let bestPhase = 0;
    let bestAccent = -Infinity;
    for (let phase = 0; phase < period; phase += 1) {
      // Гипотеза периода проверяется по сильным акцентам: сколько из них она
      // объясняет и сколько опор остаётся пустыми. Средние уровни для этого не годятся —
      // длинный период разбавляет необъяснённую опору ровно посередине и побеждает.
      let explained = 0;
      let downbeats = 0;
      let filledDownbeats = 0;
      for (let index = 0; index < count; index += 1) {
        const isDownbeat = index % period === phase;
        const strong = strongAccents.has(index);
        if (isDownbeat) {
          downbeats += 1;
          if (strong) filledDownbeats += 1;
        }
        if (strong && isDownbeat) explained += 1;
      }
      const contrast =
        strongAccents.size === 0
          ? 0
          : explained / strongAccents.size -
            0.5 * (1 - filledDownbeats / Math.max(1, downbeats));
      if (contrast > bestAccent) {
        bestAccent = contrast;
        bestPhase = phase;
      }
    }
    scored.push({
      period,
      phase: bestPhase,
      score: selfSimilarity + ACCENT_WEIGHT * Math.max(0, bestAccent),
    });
  }
  if (scored.length === 0) return { period: 2, phase: 0, confidence: 0 };
  scored.sort((left, right) => right.score - left.score || left.period - right.period);
  const best = scored[0];
  const tied = scored.filter((item) => item.score >= best.score - PERIOD_TIE_EPSILON);
  // При строгом равенстве берём наименьший период: он и есть единица повторения, а
  // группировку по два и четыре периода обеспечивает иерархический вес опоры.
  const chosen = tied.sort((left, right) => left.period - right.period)[0];
  const runnerUp = scored.find((item) => item.period !== chosen.period);
  const margin = runnerUp ? chosen.score - runnerUp.score : chosen.score;
  const confidence = clamp01(
    Math.max(0, chosen.score) * 2 + Math.max(0, margin) * 3,
  );
  return { period: chosen.period, phase: chosen.phase, confidence };
}

/**
 * Фаза периода внутри одного раздела. Возвращает общую фазу, если локальная не
 * объясняет сильные акценты раздела лучше неё.
 */
function bestPhaseWithin(
  accents: number[],
  period: number,
  globalPhase: number,
  from: number,
  to: number,
): number {
  const window = accents.slice(from, to + 1);
  const threshold = Math.max(0.5, quantile(window, 0.75));
  const strong = new Set(
    window
      .map((value, offset) => ({ value, index: from + offset }))
      .filter((item) => item.value >= threshold)
      .map((item) => item.index),
  );
  if (strong.size === 0) return globalPhase;
  const explained = (phase: number) =>
    [...strong].filter((index) => index % period === phase).length;
  let best = globalPhase;
  let bestScore = explained(globalPhase);
  for (let phase = 0; phase < period; phase += 1) {
    if (explained(phase) > bestScore) {
      bestScore = explained(phase);
      best = phase;
    }
  }
  return best;
}

/**
 * Новизна по Foote: сравниваем однородность блока «до» и блока «после» стыка с их
 * взаимным сходством. Пик означает, что материал сменился, а не просто повторился.
 */
export function noveltyCurve(features: MeasureFeature[], window: number): number[] {
  const count = features.length;
  const raw = Array<number>(count).fill(0);
  // Соседние окна многократно сравнивают одни и те же пары тактов. Храним только
  // полосу шириной 2w, которая нужна трём блокам вокруг одного стыка: O(n·w) памяти
  // вместо повторной векторной арифметики O(n·w²).
  const similarityBand = features.map((feature, index) => {
    const values = new Float64Array(window * 2 + 1);
    for (
      let distance = 0;
      distance < values.length && index + distance < count;
      distance += 1
    ) {
      values[distance] = similarity(feature, features[index + distance]);
    }
    return values;
  });
  const similarityAt = (left: number, right: number): number => {
    const first = Math.min(left, right);
    return similarityBand[first][Math.abs(left - right)];
  };
  const selfSum = (from: number): number => {
    let sum = 0;
    for (let left = from; left < from + window; left += 1) {
      for (let right = from; right < from + window; right += 1) {
        sum += similarityAt(left, right);
      }
    }
    return sum;
  };
  const shiftedSelfSum = (from: number, current: number): number => {
    const outgoing = from;
    const incoming = from + window;
    let next = current - similarityAt(outgoing, outgoing);
    for (let index = from + 1; index < from + window; index += 1) {
      next -= 2 * similarityAt(outgoing, index);
      next += 2 * similarityAt(incoming, index);
    }
    return next + similarityAt(incoming, incoming);
  };
  const crossSum = (leftFrom: number, rightFrom: number): number => {
    let sum = 0;
    for (let left = leftFrom; left < leftFrom + window; left += 1) {
      for (let right = rightFrom; right < rightFrom + window; right += 1) {
        sum += similarityAt(left, right);
      }
    }
    return sum;
  };
  if (count < window * 2) return raw;
  let beforeFrom = 0;
  let afterFrom = window;
  let beforeSelf = selfSum(beforeFrom);
  let afterSelf = selfSum(afterFrom);
  for (
    let index = window - 1;
    index + window < count;
    index += 1
  ) {
    // Самоподобие двух окон обновляется удалением/добавлением одной строки и
    // колонки O(w); взаимное сходство остаётся точным двойным блоком.
    raw[index] = clamp01(
      ((beforeSelf + afterSelf) / 2 - crossSum(beforeFrom, afterFrom)) /
        (window * window),
    );
    if (index + window + 1 >= count) continue;
    beforeSelf = shiftedSelfSum(beforeFrom, beforeSelf);
    afterSelf = shiftedSelfSum(afterFrom, afterSelf);
    beforeFrom += 1;
    afterFrom += 1;
  }
  // Нормализация на собственный максимум была бы ошибкой: у однородной пьесы она
  // превращает случайную рябь в «шов формы» силой 1.0. Контраст блоков — величина
  // абсолютная, поэтому масштабируем к фиксированному ориентиру.
  return raw.map((value) => clamp01(value / NOVELTY_REFERENCE));
}

function blockSimilarity(
  left: MeasureFeature[],
  right: MeasureFeature[],
): number {
  let sum = 0;
  for (const a of left) for (const b of right) sum += similarity(a, b);
  return sum / Math.max(1, left.length * right.length);
}

/**
 * Дословные повторы. Считаем только **максимальные** повторяющиеся сегменты: в
 * остинатной фактуре (Clocks — 52 повторяющихся четырёхтактовых окна) каждое окно
 * формально повторяется, и если брать окна, швом становится каждый такт. Максимальный
 * сегмент, наоборот, показывает настоящий блок формы: куплет, припев, вторую половину.
 */
function repeatBlocks(
  features: MeasureFeature[],
  window: number,
): {
  repeatBlockStart: boolean[];
  insideRepeatBlock: boolean[];
  materialNovelty: number[];
  segments: RepeatSegment[];
  fuzzy: Map<number, number>;
} {
  const count = features.length;
  const repeatBlockStart = Array<boolean>(count).fill(false);
  const insideRepeatBlock = Array<boolean>(count).fill(false);
  const occurrences = new Map<string, number>();
  const materialNovelty = Array<number>(count).fill(1);
  for (let index = 0; index < count; index += 1) {
    const key = features[index].fingerprint;
    if (!key) continue;
    const seen = occurrences.get(key) ?? 0;
    materialNovelty[index] = 1 / (1 + seen);
    occurrences.set(key, seen + 1);
  }
  // Нечёткие повторы: варьированное возвращение материала (другая гармонизация,
  // другая вязка ties, добавленный подголосок) не даёт точного совпадения тактов. В
  // Another Love точных повторов ноль при очевидной куплетной форме.
  const fuzzy = fuzzyRepeatStarts(features, window);
  for (const [start, strength] of fuzzy) {
    materialNovelty[start] = Math.min(materialNovelty[start], 1 - strength * 0.3);
    for (let offset = 1; offset < window && start + offset < count; offset += 1) {
      materialNovelty[start + offset] = Math.min(
        materialNovelty[start + offset],
        1 - strength * 0.3,
      );
    }
  }
  const segments = maximalRepeats(features, Math.max(window, 2));
  for (const segment of segments) {
    for (const start of [segment.first, segment.second]) {
      repeatBlockStart[start] = true;
      for (let offset = 1; offset < segment.length; offset += 1) {
        if (start + offset < count) insideRepeatBlock[start + offset] = true;
      }
    }
  }
  return { repeatBlockStart, insideRepeatBlock, materialNovelty, segments, fuzzy };
}

/**
 * Начала блоков, похожих на более ранние. Порог сходства — верхний квантиль
 * распределения этой же партитуры, а не константа: у остинатной фактуры похоже
 * всё, у сквозной — почти ничего.
 */
export function fuzzyRepeatStarts(
  features: MeasureFeature[],
  window: number,
): Map<number, number> {
  const count = features.length;
  const result = new Map<number, number>();
  fuzzyRepeatDiagnostics = { candidateCapacity: 0, peakStored: 0 };
  if (count < window * 2) return result;
  const means: MeasureFeature[] = [];
  for (let index = 0; index + window <= count; index += 1) {
    means.push(windowMean(features, index, window));
  }
  // Квантиль сначала локализуется в одной из 1000 корзин. Это заменяет массив
  // O(n²) объектов постоянной памятью, а точное значение уточняется лишь внутри
  // одной корзины, чтобы музыкальный результат остался побайтово прежним.
  const buckets = 1000;
  const histogram = new Int32Array(buckets);
  let total = 0;
  for (let to = window; to < means.length; to += 1) {
    for (let from = 0; from + window <= to; from += 1) {
      const value = boundedSimilarity(means[from], means[to], 0.9);
      const bucket = value === undefined
        ? 0
        : Math.min(buckets - 1, Math.floor(value * buckets));
      histogram[bucket] += 1;
      total += 1;
    }
  }
  if (total === 0) return result;
  const target = Math.min(total - 1, Math.max(0, Math.round((total - 1) * 0.98)));
  let beforeBucket = 0;
  let quantileBucket = 0;
  while (
    quantileBucket < buckets &&
    beforeBucket + histogram[quantileBucket] <= target
  ) {
    beforeBucket += histogram[quantileBucket];
    quantileBucket += 1;
  }
  let threshold = 0.9;
  const candidateBest = new Float64Array(means.length);
  const candidatePrevious = new Float64Array(means.length);
  for (let to = window; to < means.length; to += 1) {
    candidatePrevious[to] = similarity(means[to - window], means[to]);
  }
  if (quantileBucket >= 900) {
    threshold = Math.max(
      0.9,
      exactSimilarityQuantile(
        means,
        window,
        quantileBucket,
        target - beforeBucket,
        candidateBest,
      ),
    );
  } else {
    for (let to = window; to < means.length; to += 1) {
      for (let from = 0; from + window <= to; from += 1) {
        const value = boundedSimilarity(means[from], means[to], threshold);
        if (value !== undefined) {
          candidateBest[to] = Math.max(candidateBest[to], value);
        }
      }
    }
  }
  const headroom = Math.max(1e-6, 1 - threshold);
  for (let to = window; to < means.length; to += 1) {
    // Возврат раздела означает, что перед ним было другое: если предыдущее окно
    // такое же, это продолжение фактуры, а не форма. Иначе остинато объявляло бы
    // «возврат материала» на каждом такте.
    const previousValue = candidatePrevious[to];
    if (previousValue >= threshold) continue;
    const best = candidateBest[to];
    if (best < threshold) continue;
    // Нечёткий возврат — самая мягкая из формальных улик: он подтверждается только
    // сходством усреднённых окон. Его сила держится у нижней границы шва, чтобы
    // выписанный tie или лига могли оказаться весомее.
    const strength = clamp01(0.62 + ((best - threshold) / headroom) * 0.08);
    result.set(to, strength);
  }
  return result;
}

let fuzzyRepeatDiagnostics = { candidateCapacity: 0, peakStored: 0 };

/** Верхняя граница временного массива доказывает O(n) память точного квантиля. */
export function fuzzyRepeatMemoryStats(): {
  candidateCapacity: number;
  peakStored: number;
} {
  return { ...fuzzyRepeatDiagnostics };
}

/**
 * Точный order statistic внутри найденной корзины. Если значений больше линейного
 * лимита, диапазон дробится ещё раз и пары пересчитываются, а не сохраняются.
 * Поэтому результат совпадает с полной сортировкой, а память ограничена O(n).
 */
function exactSimilarityQuantile(
  means: MeasureFeature[],
  window: number,
  initialBucket: number,
  initialRank: number,
  candidateBest: Float64Array,
): number {
  const subdivisions = 2048;
  const candidateCapacity = Math.max(1024, means.length * 32);
  fuzzyRepeatDiagnostics.candidateCapacity = candidateCapacity;
  let lower = initialBucket / 1000;
  let upper = initialBucket === 999 ? 1 + 1e-9 : (initialBucket + 1) / 1000;
  let includeUpper = initialBucket === 999;
  let rank = initialRank;
  let firstPass = true;

  while (true) {
    const counts = new Int32Array(subdivisions);
    const stored: number[] = [];
    const span = upper - lower;
    let total = 0;
    let minimum = Number.POSITIVE_INFINITY;
    let minimumCount = 0;
    let maximum = Number.NEGATIVE_INFINITY;

    for (let to = window; to < means.length; to += 1) {
      for (let from = 0; from + window <= to; from += 1) {
        const value = boundedSimilarity(means[from], means[to], lower);
        if (value === undefined) continue;
        if (firstPass) {
          candidateBest[to] = Math.max(candidateBest[to], value);
        }
        if (value < lower || value > upper || (!includeUpper && value === upper)) continue;
        total += 1;
        if (stored.length < candidateCapacity) stored.push(value);
        if (value < minimum) {
          minimum = value;
          minimumCount = 1;
        } else if (value === minimum) {
          minimumCount += 1;
        }
        maximum = Math.max(maximum, value);
        const bucket = Math.min(
          subdivisions - 1,
          Math.max(0, Math.floor(((value - lower) / span) * subdivisions)),
        );
        counts[bucket] += 1;
      }
    }
    firstPass = false;
    fuzzyRepeatDiagnostics.peakStored = Math.max(
      fuzzyRepeatDiagnostics.peakStored,
      stored.length,
    );
    if (total === 0) return lower;
    rank = Math.min(total - 1, Math.max(0, rank));
    if (minimum === maximum) return minimum;
    if (total <= candidateCapacity) {
      stored.sort((left, right) => left - right);
      return stored[rank];
    }

    let before = 0;
    let selected = 0;
    for (; selected < subdivisions; selected += 1) {
      if (before + counts[selected] > rank) break;
      before += counts[selected];
    }
    rank -= before;
    const nextLower = lower + (span * selected) / subdivisions;
    const nextUpper = lower + (span * (selected + 1)) / subdivisions;
    const nextIncludeUpper = includeUpper && selected === subdivisions - 1;
    if (nextLower === lower && nextUpper === upper) {
      if (rank < minimumCount) return minimum;
      rank -= minimumCount;
      lower = nextUp(minimum);
      continue;
    }
    lower = nextLower;
    upper = nextUpper;
    includeUpper = nextIncludeUpper;
  }
}

/** Следующее представимое Float64-значение; нужно только для предельно узкой корзины. */
function nextUp(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}

function windowMean(
  features: MeasureFeature[],
  start: number,
  window: number,
): MeasureFeature {
  const block = features.slice(start, start + window);
  const average = (pick: (feature: MeasureFeature) => number[]) => {
    const width = pick(block[0]).length;
    const result = Array<number>(width).fill(0);
    for (const feature of block) {
      const vector = pick(feature);
      for (let index = 0; index < width; index += 1) result[index] += vector[index];
    }
    return result.map((value) => value / block.length);
  };
  return {
    chroma: average((feature) => feature.chroma),
    bass: average((feature) => feature.bass),
    rhythm: average((feature) => feature.rhythm),
    texture: average((feature) => feature.texture),
    fingerprint: "",
    silent: block.every((feature) => feature.silent),
  };
}

export interface RepeatSegment {
  first: number;
  second: number;
  length: number;
}

/**
 * Максимальные дословные повторы: пара позиций расширяется вперёд, пока такты
 * совпадают, и отбрасывается, если её можно было расширить назад (тогда она часть
 * более длинного повтора). Перекрывающиеся пары не считаются повтором.
 */
export function maximalRepeats(
  features: MeasureFeature[],
  minLength: number,
): RepeatSegment[] {
  const count = features.length;
  const byFingerprint = new Map<string, number[]>();
  for (let index = 0; index < count; index += 1) {
    const key = features[index].fingerprint;
    if (!key) continue;
    const list = byFingerprint.get(key) ?? [];
    list.push(index);
    byFingerprint.set(key, list);
  }
  const segments: RepeatSegment[] = [];
  for (const positions of byFingerprint.values()) {
    if (positions.length < 2) continue;
    // Сотни одинаковых позиций — остинато, а не полезный признак крупной формы.
    if (positions.length > 200) continue;
    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        const first = positions[left];
        const second = positions[right];
        if (
          features[first - 1] &&
          features[second - 1] &&
          features[first - 1].fingerprint === features[second - 1].fingerprint
        ) {
          continue; // расширяемо назад — не максимальный сегмент
        }
        let length = 0;
        while (
          second + length < count &&
          features[first + length].fingerprint ===
            features[second + length].fingerprint &&
          features[first + length].fingerprint
        ) {
          length += 1;
          if (first + length >= second) break;
        }
        if (length < minLength || second - first < length) continue;
        // Отрезок, сам составленный из более короткого повтора, — это остинато, а не
        // возврат раздела: у одного и того же такта, повторённого двенадцать раз,
        // формально «повторяется» любое окно.
        const block = features
          .slice(first, first + length)
          .map((feature) => feature.fingerprint);
        if (minimalPeriod(block) < block.length) continue;
        segments.push({ first, second, length });
      }
    }
  }
  return segments
    .sort((left, right) => right.length - left.length)
    .filter((segment, index, all) =>
      all.every(
        (other, otherIndex) =>
          otherIndex >= index ||
          !(
            other.first <= segment.first &&
            other.first + other.length >= segment.first + segment.length &&
            other.second <= segment.second &&
            other.second + other.length >= segment.second + segment.length
          ),
      ),
    );
}

/**
 * Швы секций: пики новизны выше внутрипьесного порога (медиана + MAD), начала
 * дословных повторов и явные формальные метки нотации.
 */
function sectionSeams(
  novelty: number[],
  segments: RepeatSegment[],
  fuzzy: Map<number, number>,
  formalBoundaryAfter: boolean[],
  features: MeasureFeature[],
  window: number,
): number[] {
  const count = novelty.length;
  const center = median(novelty);
  const deviation = median(novelty.map((value) => Math.abs(value - center)));
  const threshold = Math.max(
    NOVELTY_FLOOR,
    Math.min(0.85, center + Math.max(0.05, deviation * 2)),
  );
  // Швом считается начало длинного (не меньше двух периодов) дословного повтора:
  // это и есть возврат куплета, припева или второй половины пьесы.
  const longRepeatStarts = new Map<number, number>();
  for (const segment of segments) {
    // Возврат раздела бывает и коротким: реприза темы Moonlight — четыре такта.
    // Требование «не меньше двух окон» его теряло.
    if (segment.length < Math.max(4, window)) continue;
    const strength = clamp01(0.6 + segment.length / (window * 8));
    for (const start of [segment.first, segment.second]) {
      longRepeatStarts.set(start, Math.max(longRepeatStarts.get(start) ?? 0, strength));
    }
  }
  const result = Array<number>(count).fill(0);
  for (let index = 0; index < count; index += 1) {
    const isPeak =
      novelty[index] >= threshold &&
      novelty[index] >= (novelty[index - 1] ?? 0) &&
      novelty[index] >= (novelty[index + 1] ?? 0);
    // Пик, прошедший абсолютный порог, уже является швом: сила отражает величину
    // контраста, но не опускает подтверждённый шов ниже порога графа секций.
    let strength = isPeak ? clamp01(0.6 + novelty[index] * 0.4) : 0;
    const repeatStrength = longRepeatStarts.get(index + 1);
    if (repeatStrength !== undefined) strength = Math.max(strength, repeatStrength);
    const fuzzyStrength = fuzzy.get(index + 1);
    if (fuzzyStrength !== undefined) strength = Math.max(strength, fuzzyStrength);
    // Смена «есть мелодия / нет мелодии» — почти всегда шов формы (вступление,
    // интерлюдия, кода) даже без единой метки в файле.
    if (
      features[index + 1] &&
      features[index].silent !== features[index + 1].silent
    ) {
      strength = Math.max(strength, 0.75);
    }
    if (formalBoundaryAfter[index]) strength = Math.max(strength, 0.9);
    result[index] = clamp01(strength);
  }
  // Швы не могут стоять чаще, чем длится раздел: два такта — это фраза, а не форма.
  // Из близких кандидатов остаётся сильнейший, остальные гасятся.
  const minDistance = Math.max(4, window);
  const accepted: number[] = [];
  const order = result
    .map((strength, index) => ({ strength, index }))
    .filter((item) => item.strength > 0)
    .sort((left, right) => right.strength - left.strength || left.index - right.index);
  for (const item of order) {
    const tooClose = accepted.some(
      (index) => Math.abs(index - item.index) < minDistance,
    );
    // Явную метку нотации не гасим: это запись автора, а не догадка алгоритма.
    if (tooClose && !formalBoundaryAfter[item.index]) {
      result[item.index] = 0;
      continue;
    }
    accepted.push(item.index);
  }
  return result;
}

function buildSections(
  sectionBoundaryAfter: number[],
  features: MeasureFeature[],
  period: number,
): SectionSpan[] {
  const count = sectionBoundaryAfter.length;
  if (count === 0) return [];
  const cuts: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    if (sectionBoundaryAfter[index] >= 0.6) cuts.push(index);
  }
  // Секция короче двух периодов — это не форма, а фраза: такие швы не открывают
  // новую секцию, иначе граф формы распадается на десятки двухтактовых «секций».
  const minSection = Math.max(4, period * 2);
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const cut of cuts) {
    if (cut - start + 1 >= minSection) {
      spans.push({ start, end: cut });
      start = cut + 1;
    }
  }
  spans.push({ start, end: count - 1 });
  while (spans.length > 1) {
    const last = spans[spans.length - 1];
    if (last.end - last.start + 1 >= minSection) break;
    spans[spans.length - 2].end = last.end;
    spans.pop();
  }
  const labels: string[] = [];
  const prototypes: MeasureFeature[][] = [];
  for (const span of spans) {
    const block = features.slice(span.start, span.end + 1);
    let matched = -1;
    for (const [index, prototype] of prototypes.entries()) {
      if (blockSimilarity(block, prototype) >= 0.85) {
        matched = index;
        break;
      }
    }
    if (matched >= 0) {
      const base = labels[matched].replace(/'+$/, "");
      const variants = labels.filter((label) => label.startsWith(base)).length;
      labels.push(base + "'".repeat(variants));
    } else {
      prototypes.push(block);
      labels.push(String.fromCharCode(65 + (prototypes.length - 1) % 26));
    }
  }
  return spans.map((span, index) => ({ ...span, label: labels[index] }));
}

/** Наименьший период последовательности: длина, из которой она составлена целиком. */
function minimalPeriod(values: string[]): number {
  for (let period = 1; period < values.length; period += 1) {
    if (values.length % period !== 0) continue;
    let periodic = true;
    for (let index = period; index < values.length && periodic; index += 1) {
      if (values[index] !== values[index - period]) periodic = false;
    }
    if (periodic) return period;
  }
  return values.length;
}

function normalizeVector(vector: number[]): number[] {
  const sum = vector.reduce((total, value) => total + value, 0);
  return sum > 0 ? vector.map((value) => value / sum) : vector;
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm > 0 && rightNorm > 0
    ? dot / Math.sqrt(leftNorm * rightNorm)
    : 0;
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
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

function quantile(values: number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * share)),
  );
  return sorted[position];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
