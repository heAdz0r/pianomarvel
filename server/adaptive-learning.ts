import { readScoreXml } from "./scoreAnalyzer";
import type { SlicingExercise } from "./learning-plan";
import {
  extractCombinedMeasures,
  extractMeasureNotes,
  quarterBeatsPerMeasure,
  soundingOf,
  attacksOf,
  type NoteEvent,
  type MeasureNotes,
} from "./adaptive-notes";
import { analyzeMelody, type MelodySurface } from "./adaptive-melody";
import { analyzeHarmony, type HarmonyAnalysis } from "./adaptive-harmony";
import { analyzeStructure, type StructureAnalysis } from "./adaptive-structure";
import { analyzeNavigation, type NavigationGraph } from "./adaptive-navigation";

/**
 * Педагогические настройки — именованные и тестируемые ограничения оптимизатора.
 * Они не являются таймингами ожидания UI: реальные границы запускаются признаками
 * партитуры, а эти значения лишь не дают одному chunk поглотить целый раздел.
 */
const PEDAGOGY = {
  /** Учебный минимум длины фразы, когда партитура не даёт своей длины. */
  fallbackPhraseMeasures: 4,
  /** Короче двух тактов фрагмент не является музыкальной мыслью. */
  minPhraseMeasures: 2,
  /** Базовый потолок длины; при известном темпе его заменяет предел по секундам. */
  maxPhraseMeasures: 8,
  /** Ниже этой доли целевой нагрузки фрагмент недогружен для отдельной работы. */
  minTargetLoadRatio: 0.55,
  /** Выше этой доли целевой нагрузки фрагмент перегружен для одного подхода. */
  maxTargetLoadRatio: 1.55,
  /** Масштаб штрафа за слабую границу относительно шкалы силы границ. */
  boundaryReward: 0.42,
  /** Максимум шкалы силы границы: значение явной формальной метки. */
  hardBoundaryScore: 8,
  /** Цена пересечения явной границы раздела, когда иначе возникнет микрофраза. */
  hardBoundaryCrossPenalty: 3.2,
  /**
   * Явно выписанный tempo-span (`rall. -----`, `accel. -----`) — единый
   * исполнительский жест. Его начало сильнее обычной мягкой границы, но слабее
   * смены формального раздела: rallentando может находиться и внутри большой фразы.
   */
  expressiveBoundaryCrossPenalty: 2.4,
  /** Tie избегается, но не может растянуть учебный Phrase до десятков тактов. */
  tieCutPenalty: 10,
  /** Внутренний разрез протяжённого tempo-span допускается только как аварийный. */
  expressiveSpanCutPenalty: 12,
  /**
   * Hairpin / cresc. — направленная выразительная дуга, но не абсолютный запрет:
   * длинное crescendo может содержать несколько самостоятельных учебных фраз.
   */
  dynamicSpanCutPenalty: 1.35,
  /** Длинная мелодическая лига — мягкая фразовая связность. */
  melodicSlurCutPenalty: 0.9,
  /** Неявный rit./accel. без линии не распространяем бесконечно. */
  maxImplicitTempoGestureMeasures: 8,
  /** Музыкальное время контекста с каждой стороны обычного и tempo-перехода. */
  bridgeContextSeconds: 2.5,
  expressiveBridgeContextSeconds: 3,
  /** Защита от огромных Bridge в быстрых сложных и очень медленных пьесах. */
  maxBridgeContextMeasures: 3,
  /**
   * Минимальный суммарный сигнал музыкальной границы, который участвует в выводе
   * естественной длины фразы. Три балла уже дают конец slur либо сочетание
   * метрической опоры со спадом нагрузки; прежний порог 4 игнорировал оба случая
   * и склеивал две самостоятельные четырёхтактовые фразы в одну восьмитактовую.
   */
  phraseBoundaryScore: 3,
  // Целевая длительность отрезка на медленном темпе (сек). Мягкий сигнал,
  // складывается с нагрузкой по нотам, а не заменяет её: короткий по тактам
  // отрезок из плотных долгих нот может быть длиннее по времени, чем
  // длинный отрезок из редких быстрых пассажей.
  minChunkSeconds: 12,
  /** Верхний предел одного подхода на медленном темпе. */
  maxChunkSeconds: 45,
  /** Ниже этой длительности отдельный Phrase теряет учебный смысл. */
  minStandaloneChunkSeconds: 8,
  /** Сколько фраз максимум собирает один обзорный кусок, если структура молчит. */
  maxReviewPhrases: 4,
  /** Review должен быть заметно крупнее учебного Phrase, если пьеса это позволяет. */
  minReviewMeasures: 8,
  /** Верхняя комфортная длительность Review на Slow; минимум две Phrase важнее лимита. */
  maxReviewSeconds: 100,
  /** Мягкий предел печатных тактов Review; минимум две Phrase важнее лимита. */
  maxReviewMeasures: 24,
  /** Относительная величина численной смены темпа, ниже которой это агогика. */
  tempoChangeRatio: 0.05,
  /** Вес отсутствия музыкального закрытия в цене границы Phrase. */
  closureWeight: 2.6,
  /** Вес несовпадения с гиперметрической сеткой партитуры. */
  hypermeterWeight: 1.1,
  /**
   * Цена пересечения шва формы. Шов выводится из повторности и новизны, поэтому он
   * не «мягкий сигнал»: возврат репризы или начало припева обязаны быть границей
   * Phrase, иначе упражнение сшивает два разных раздела.
   */
  sectionCrossPenalty: 6,
  /** Вес выравнивания длительностей Phrase внутри пьесы (дисциплина времени). */
  durationSpreadWeight: 0.9,
  /**
   * Разрыв порядка исполнения (вольта→вольта, `To Coda`, реприза) внутри одного
   * упражнения тренирует последовательность, которой не существует. Штраф выше
   * любого музыкального выигрыша, но не абсолютный запрет: на вырожденной разметке
   * лучше выдать план с предупреждением, чем не выдать ничего.
   */
  navigationCrossPenalty: 24,
} as const;

const NOTE_SPEED: Record<string, number> = {
  whole: 0.25,
  half: 0.5,
  quarter: 1,
  eighth: 2,
  "16th": 4,
  "32nd": 8,
  "64th": 12,
  "128th": 16,
};

interface RawMeasureProfile {
  ordinal: number;
  noteCount: number;
  chordCount: number;
  accidentalCount: number;
  tupletCount: number;
  voices: number;
  fastestNote: number;
  maxLeap: number;
  fullRest: boolean;
  signature: string;
  quarterBeats: number;
  tiedIntoNext: boolean;
  hasLyrics: boolean;
  /** Последняя текстовая строка такта не закрыта пунктуацией и продолжается дальше. */
  lyricOpenEnded: boolean;
  /**
   * Число нотных позиций в такте = end_tick, который Piano Marvel ожидает в
   * server-method-162. Формула снята с живых данных и совпала на всех проверенных
   * тактах: считаем различные позиции начала событий (ноты И паузы), `<chord>` — та
   * же позиция, `<grace>` не считается, `<backup>`/`<forward>` двигают курсор.
   */
  tickCount: number;
  /** Реальные атаки без добавочных нот аккорда. */
  attackCount: number;
  /** Наибольшее число одновременно взятых нот в одном аккорде. */
  maxChordSize: number;
  /** Первые и последние высоты по нотоносцам для сложности стыка. */
  firstPitchByStaff: Record<string, number>;
  lastPitchByStaff: Record<string, number>;
  /** Орнаменты повышают моторную плотность независимо от accidentals. */
  ornamentCount: number;
  /** Сила окончания фразировочной лиги: 0 локальная/нет, 1 слабая, 2 мелодическая. */
  slurBoundaryStrength: number;
  melodicSlurEvents: GestureEvent[];
  /** Начала протяжённых tempo directions внутри этого такта, связанные с dashes. */
  expressiveTempoStarts: ExpressiveTempoMarker[];
  /** Номера dashed-линий, заканчивающихся внутри этого такта. */
  expressiveTempoStops: string[];
  tempoGestureEvents: GestureEvent[];
  /** Все значимые tempo arrivals/gestures в начале такта. */
  tempoTransitionLabels: string[];
  /** Явные playback-tempo из `<sound tempo>`. */
  soundTempos: number[];
  /** Все темповые указания такта с позицией внутри такта, 0..1. */
  tempoMarks: Array<{ tempo: number; position: number }>;
  /** Явный возврат к основному темпу (`a tempo`, `tempo primo`, `in tempo`). */
  tempoReset: boolean;
  tempoResetScopes: string[];
  /** Начала и окончания динамических линий (wedge либо `cresc. -----`). */
  dynamicGestureStarts: ExpressiveTempoMarker[];
  dynamicGestureStops: string[];
  dynamicGestureEvents: GestureEvent[];
  /** Нормализованный уровень pp…ff / sfz, если он указан. */
  dynamicLevel?: number;
  /** Вход/выход из 8va/15ma — технический, а не формальный переход. */
  registerShiftTransition: boolean;
  /** `<pedal type="start">` — взятие педали; часто совпадает с началом гармонии. */
  pedalStarts: number;
  /** `<pedal type="stop|change">` — снятие/смена педали; прямой признак шва. */
  pedalReleases: number;
  /** Смена ключа внутри пьесы: левая рука уходит в скрипичный и обратно. */
  clefChange: boolean;
  /** Доля атак с артикуляционными знаками — режим штриха, а не отдельный акцент. */
  articulationRatio: number;
  /** Арпеджио/глиссандо: отдельный технический приём. */
  gestureTechniques: number;
  /** `<print new-system="yes">` — слабая подсказка гравёра о конце строки-фразы. */
  systemBreak: boolean;
  boundaryBefore: BoundarySignal[];
  boundaryAfter: BoundarySignal[];
}

interface ExpressiveTempoMarker {
  id: string;
  label: string;
  /** false для `rit.` без dashed-span: окончание выводится из контекста. */
  explicit: boolean;
}

type GestureEvent =
  | { type: "start"; marker: ExpressiveTempoMarker }
  | { type: "stop"; id: string };

interface BoundarySignal {
  score: number;
  reason: string;
  hard?: boolean;
}

export interface AdaptiveMeasureProfile extends RawMeasureProfile {
  measure: number;
  load: number;
  boundaryScoreAfter: number;
  boundaryReasonsAfter: string[];
  hardBoundaryAfter: boolean;
  /** Оценка длительности такта на медленном темпе (сек); 0, если темп не передан. */
  estSeconds: number;
  /** Нельзя штатно заканчивать фрагмент: продолжается tie или expressive tempo-span. */
  forbiddenAfter: boolean;
  /** После такта продолжается протяжённое rall./rit./accel./rubato direction. */
  expressiveTempoContinuesAfter: boolean;
  /** Активные expressive tempo directions после этого такта. */
  expressiveTempoLabelsAfter: string[];
  /** После такта продолжается crescendo/diminuendo; это мягкая связность. */
  dynamicGestureContinuesAfter: boolean;
  dynamicGestureLabelsAfter: string[];
  melodicSlurContinuesAfter: boolean;
  /** Нормализованные музыкальные переходы, требующие отдельной склейки. */
  transitionLabelsBefore: string[];
  /** Сила музыкального закрытия после такта, [0,1]: каденция, пауза, лига, форма. */
  closureAfter: number;
  /** Тип каденции после такта, если она распознана. */
  cadenceTypeAfter: string;
  /** Такт — гиперметрически сильный (начало периода). */
  hyperDownbeatBefore: boolean;
  /** Сила формального шва после такта, [0,1]. */
  sectionBoundaryAfter: number;
  /** 1 — материал такта встречается впервые; меньше — уже отработан. */
  materialNovelty: number;
  /** После такта прерывается порядок исполнения: вольта, реприза, `To Coda`. */
  navigationBreakAfter: boolean;
}

export interface AdaptiveConfidenceDetails {
  form: "high" | "medium" | "low";
  expressive: "high" | "medium" | "low";
  motor: "high" | "medium" | "low";
  mapping: "high" | "medium" | "low";
}

export interface AdaptiveSection {
  /** Номера тактов Piano Marvel. */
  startMeasure: number;
  endMeasure: number;
  /** Метка класса материала: A, A', B… */
  label: string;
}

/**
 * Порядок учебного маршрута внутри одного списка Chopped.
 *
 * `score` — список читается как партитура: Phrase, его Bridge, следующий Phrase.
 * `stage` — список читается как лестница навыка: сперва ВСЕ отрезки, затем ВСЕ
 * мостики, затем обзоры и трети. Стык тренируется тогда, когда обе его стороны
 * уже выучены, а не посреди разбора материала.
 */
export type AdaptiveChunkOrder = "score" | "stage";

export const DEFAULT_ADAPTIVE_CHUNK_ORDER: AdaptiveChunkOrder = "stage";

export interface AdaptiveLearningPlan {
  chunks: SlicingExercise[];
  /** Каким порядком собран `chunks`. Нужен диагностике и проверке видимости. */
  chunkOrder: AdaptiveChunkOrder;
  phraseChunks: SlicingExercise[];
  bridgeChunks: SlicingExercise[];
  reviewChunks: SlicingExercise[];
  summaryChunks: SlicingExercise[];
  measures: AdaptiveMeasureProfile[];
  /** Выведенный из партитуры гиперметр: период, фаза и уверенность. */
  hypermeter: { period: number; phase: number; confidence: number };
  /** Разделы формы, выведенные из повторности и новизны. */
  sections: AdaptiveSection[];
  /** Информативность каждого типа сигнала в этой партитуре, [0,1]. */
  salience: Record<SignalKind, number>;
  confidence: "high" | "medium" | "low";
  confidenceDetails: AdaptiveConfidenceDetails;
  warnings: string[];
}

const ADAPTIVE_PLAN_CACHE_LIMIT = 8;
// План детерминирован по содержимому, диапазону Whole и учебному темпу. Небольшой
// FIFO-кеш снимает повторный полный анализ при «Обновить».
const planCache = new Map<string, AdaptiveLearningPlan>();
let adaptivePlanComputations = 0;

/** Сбрасывает кеш планов между тестами и бенчмарками. */
export function clearAdaptivePlanCache(): void {
  planCache.clear();
  adaptivePlanComputations = 0;
}

/** Диагностика кеша нужна тесту ключа и подтверждает отсутствие повторного анализа. */
export function adaptivePlanCacheStats(): { entries: number; computations: number } {
  return { entries: planCache.size, computations: adaptivePlanComputations };
}

export async function buildAdaptiveLearningPlan(
  path: string,
  wholeStart: number,
  wholeEnd: number,
  slowTempoBpm?: number,
  // CHANGED: порядок маршрута — часть плана, поэтому он же часть ключа кеша.
  chunkOrder: AdaptiveChunkOrder = DEFAULT_ADAPTIVE_CHUNK_ORDER,
): Promise<AdaptiveLearningPlan> {
  const xml = await readScoreXml(path);
  const hash = new Bun.CryptoHasher("sha256").update(xml).digest("hex");
  const key = `${hash}:${wholeStart}:${wholeEnd}:${slowTempoBpm ?? ""}:${chunkOrder}`;
  const cached = planCache.get(key);
  if (cached) return structuredClone(cached);
  adaptivePlanComputations += 1;
  const plan = analyzeAdaptiveMusicXml(xml, wholeStart, wholeEnd, slowTempoBpm, chunkOrder);
  planCache.set(key, structuredClone(plan));
  while (planCache.size > ADAPTIVE_PLAN_CACHE_LIMIT) {
    const oldest = planCache.keys().next().value;
    if (oldest === undefined) break;
    planCache.delete(oldest);
  }
  return structuredClone(plan);
}

export function analyzeAdaptiveMusicXml(
  xml: string,
  wholeStart: number,
  wholeEnd: number,
  slowTempoBpm?: number,
  // CHANGED: порядок маршрута задаётся вызывающим; по умолчанию — лестница навыка.
  chunkOrder: AdaptiveChunkOrder = DEFAULT_ADAPTIVE_CHUNK_ORDER,
): AdaptiveLearningPlan {
  if (!/<score-(?:partwise|timewise)\b/i.test(xml)) {
    throw new Error("Adaptive: файл не содержит партитуру MusicXML.");
  }
  if (!Number.isInteger(wholeStart) || !Number.isInteger(wholeEnd) || wholeEnd < wholeStart) {
    throw new Error("Adaptive: у Whole некорректный диапазон тактов.");
  }

  const bodies = extractCombinedMeasures(xml);
  // CHANGED: 0-0 — это «Piano Marvel ещё не посчитал такты» (так приходит свежая
  // загрузка), а не пьеса из одного такта. Сравнивать не с чем, поэтому границы
  // берутся из MusicXML; настоящее несовпадение (0-5 против 2 тактов) ловится ниже.
  if (wholeStart === 0 && wholeEnd === 0) {
    wholeStart = 1;
    wholeEnd = bodies.length;
  }
  const wholeLength = wholeEnd - wholeStart + 1;
  if (bodies.length !== wholeLength) {
    throw new Error(
      `Adaptive: MusicXML содержит ${bodies.length} тактов, а Whole в Piano Marvel — ${wholeLength}. ` +
        "Автоматическое смещение границ небезопасно; проверьте затакт, повторы или выбранный MusicXML.",
    );
  }

  // Длительности тактов считает общий разбор: `<time>` встречается только при смене
  // размера, а затакт и senza misura измеряются по фактическим нотам.
  const quarterBeats = quarterBeatsPerMeasure(bodies);
  // Нотная модель строится один раз и переиспользуется профилем, мелодией,
  // гармонией и структурой вместо повторных regex-сканов каждого такта.
  const noteMeasures = extractMeasureNotes(bodies, quarterBeats);
  let divisions = 1;
  const raw = bodies.map((measure, index) => {
    const parsedDivisions = Number(tagValue(measure.body, "divisions"));
    if (Number.isFinite(parsedDivisions) && parsedDivisions > 0) divisions = parsedDivisions;
    return profileMeasure(
      measure.body,
      index,
      quarterBeats[index],
      divisions,
      noteMeasures[index],
    );
  });
  const context = buildMusicalContext(bodies, raw, noteMeasures);
  const measures = enrichProfiles(raw, wholeStart, slowTempoBpm, context);
  // Индексы строятся один раз на план: Bridge/Review/Summarize обращаются к тактам
  // по номеру внутри вложенных циклов.
  const measureByNumber = indexMeasures(measures);
  const positionOf = indexPositions(measures);
  const phraseChunks = optimizePhrases(measures, context, slowTempoBpm);
  const bridgeChunks = buildBridgeChunks(
    phraseChunks,
    measures,
    context,
    measureByNumber,
    positionOf,
  );
  const reviewChunks = buildReviewChunks(
    phraseChunks,
    measures,
    context,
    measureByNumber,
    positionOf,
  );
  const summaryChunks = buildSummaryChunks(
    phraseChunks,
    measures,
    context,
    measureByNumber,
    positionOf,
  );
  const structuralSignals = measures.filter((measure) => measure.boundaryScoreAfter >= 4).length;
  const formalSignals = measures.filter(
    (measure) =>
      measure.hardBoundaryAfter ||
      measure.boundaryReasonsAfter.some((reason) =>
        /репетицион|повтор|вольт|тактовая черта|формальная метка|навигация|обозначение раздела/i.test(
          reason,
        ),
      ),
  ).length;
  const expressiveSignals = measures.filter(
    (measure) =>
      measure.tempoTransitionLabels.length > 0 ||
      measure.dynamicGestureStarts.length > 0,
  ).length;
  const motorCoverage =
    measures.filter(
      (measure) =>
        measure.attackCount > 0 &&
        Object.keys(measure.firstPitchByStaff).length > 0,
    ).length / Math.max(1, measures.length);
  const confidenceDetails: AdaptiveConfidenceDetails = {
    form:
      formalSignals >= Math.max(2, Math.ceil(phraseChunks.length / 4))
        ? "high"
        : formalSignals > 0
          ? "medium"
          : "low",
    expressive:
      expressiveSignals >= 2
        ? "high"
        : expressiveSignals > 0
          ? "medium"
          : "low",
    motor:
      motorCoverage >= 0.85
        ? "high"
        : motorCoverage >= 0.55
          ? "medium"
          : "low",
    mapping: "high",
  };
  const confidence: AdaptiveLearningPlan["confidence"] =
    confidenceDetails.form === "high" && confidenceDetails.motor === "high"
      ? "high"
      : confidenceDetails.form !== "low" ||
          confidenceDetails.expressive !== "low" ||
          confidenceDetails.motor !== "low"
        ? "medium"
        : "low";
  const warnings: string[] = [];
  if (structuralSignals === 0) {
    warnings.push("В MusicXML нет явных структурных меток; использованы нагрузка и метрическая симметрия.");
  }
  const forcedTieCuts = phraseChunks
    .slice(0, -1)
    .filter((chunk) => measures[chunk.endMeasure - wholeStart]?.tiedIntoNext)
    .map((chunk) => chunk.endMeasure);
  if (forcedTieCuts.length > 0) {
    warnings.push(
      context.salience.tie < 0.15
        ? `Педальная фактура: tie переносится почти через каждую тактовую черту, поэтому границы выбраны по музыкальным признакам; стыки ${forcedTieCuts.join(", ")} закрыты Bridge.`
        : `Длинная последовательность tie превысила учебное окно; границы ${forcedTieCuts.join(", ")} покрыты Bridge.`,
    );
  }
  const forcedExpressiveCuts = phraseChunks
    .slice(0, -1)
    .filter(
      (chunk) =>
        measures[chunk.endMeasure - wholeStart]?.expressiveTempoContinuesAfter,
    )
    .map((chunk) => chunk.endMeasure);
  if (forcedExpressiveCuts.length > 0) {
    warnings.push(
      `Протяжённый tempo gesture превысил учебное окно; границы ${forcedExpressiveCuts.join(", ")} покрыты Bridge.`,
    );
  }
  const navigationCrossings = phraseChunks.filter((chunk) =>
    measures.some(
      (measure) =>
        measure.navigationBreakAfter &&
        measure.measure >= chunk.startMeasure &&
        measure.measure < chunk.endMeasure,
    ),
  );
  if (navigationCrossings.length > 0) {
    warnings.push(
      `Порядок исполнения прерывается внутри Phrase ${navigationCrossings
        .map((chunk) => `${chunk.startMeasure}-${chunk.endMeasure}`)
        .join(", ")}: короткая вольта или прыжок не образуют самостоятельного ` +
        "непрерывного диапазона Piano Marvel. Стыки закрыты отдельными Bridge.",
    );
  }
  if (summaryChunks.length === 0) {
    warnings.push(
      "Для трёх Summarize-частей нужно минимум три Adaptive Phrase; короткая пьеса завершается Review и Whole.",
    );
  }

  return {
    // CHANGED: порядок маршрута больше не зашит — его выбирает orderChunks.
    chunks: orderChunks(chunkOrder, {
      phraseChunks,
      bridgeChunks,
      reviewChunks,
      summaryChunks,
    }),
    chunkOrder,
    phraseChunks,
    bridgeChunks,
    reviewChunks,
    summaryChunks,
    measures,
    hypermeter: context.structure.hypermeter,
    sections: context.structure.sections.map((section) => ({
      startMeasure: wholeStart + section.start,
      endMeasure: wholeStart + section.end,
      label: section.label,
    })),
    salience: context.salience,
    confidence,
    confidenceDetails,
    warnings,
  };
}

/**
 * Музыкальный контекст партитуры: ноты, мелодия, гармония, форма и информативность
 * сигналов. Считается один раз и передаётся во все уровни разбиения, чтобы Phrase,
 * Bridge, Review и Summarize опирались на одну и ту же картину музыки.
 */
export interface MusicalContext {
  notes: MeasureNotes[];
  melody: MelodySurface;
  harmony: HarmonyAnalysis;
  structure: StructureAnalysis;
  navigation: NavigationGraph;
  salience: Record<SignalKind, number>;
}

export type SignalKind =
  | "tie"
  | "slur"
  | "tempoGesture"
  | "dynamicGesture"
  | "pedalRelease"
  | "melodyGap"
  | "cadence"
  | "formal";

function buildMusicalContext(
  bodies: Array<{ attributes: string; body: string }>,
  raw: RawMeasureProfile[],
  notes: MeasureNotes[],
): MusicalContext {
  const melody = analyzeMelody(notes);
  const harmony = analyzeHarmony(notes, melody.stream);
  const formalBoundaryAfter = raw.map(
    (measure, index) =>
      measure.boundaryAfter.some((signal) => signal.hard) ||
      (raw[index + 1]?.boundaryBefore.some((signal) => signal.hard) ?? false),
  );
  const structure = analyzeStructure(
    notes,
    metricAccents(raw, notes, melody, harmony, formalBoundaryAfter),
    formalBoundaryAfter,
  );
  const navigation = analyzeNavigation(bodies);
  return {
    notes,
    melody,
    harmony,
    structure,
    navigation,
    salience: {
      tie: salience(raw, (measure) => measure.tiedIntoNext),
      slur: salience(raw, (measure) => measure.slurBoundaryStrength > 0),
      tempoGesture: salience(raw, (measure) => measure.expressiveTempoStarts.length > 0),
      dynamicGesture: salience(raw, (measure) => measure.dynamicGestureStarts.length > 0),
      pedalRelease: salience(raw, (measure) => measure.pedalReleases > 0),
      melodyGap: salience(raw, (_, index) => (melody.melodyGapAfter[index] ?? 0) >= 0.4),
      cadence: salience(raw, (_, index) => (harmony.cadenceAfter[index] ?? 0) >= 0.5),
      formal: salience(raw, (_, index) => formalBoundaryAfter[index]),
    },
  };
}

/**
 * Информативность сигнала в конкретной партитуре: log(1/p) / log(N).
 *
 * Признак, срабатывающий почти на каждой тактовой черте, ничего не различает — в
 * Another Love tie переносится через 97 черт из 120, и абсолютный запрет на разрез
 * внутри tie там бессмыслен. Признак, встречающийся считанные разы, наоборот, несёт
 * максимум информации. Поэтому веса и запреты умножаются на эту величину вместо
 * фиксированных порогов.
 */
function salience(
  raw: RawMeasureProfile[],
  fires: (measure: RawMeasureProfile, index: number) => boolean,
): number {
  const count = raw.length;
  if (count < 2) return 0;
  const hits = raw.filter((measure, index) => fires(measure, index)).length;
  if (hits === 0) return 0;
  const rate = Math.max(hits / count, 1 / count);
  return Math.max(0, Math.min(1, Math.log(1 / rate) / Math.log(count)));
}

/**
 * Метрические акценты для оценки фазы гиперметра: где слушатель чувствует начало
 * нового периода. Собираем независимые свидетельства — смену гармонии, окончание
 * предыдущей фразы, каденцию, смену динамики, взятие педали и явные метки нотации.
 */
function metricAccents(
  raw: RawMeasureProfile[],
  notes: MeasureNotes[],
  melody: MelodySurface,
  harmony: HarmonyAnalysis,
  formalBoundaryAfter: boolean[],
): number[] {
  let previousDynamic: number | undefined;
  return raw.map((measure, index) => {
    const dynamicChange =
      measure.dynamicLevel !== undefined &&
      previousDynamic !== undefined &&
      measure.dynamicLevel !== previousDynamic
        ? 1
        : 0;
    if (measure.dynamicLevel !== undefined) previousDynamic = measure.dynamicLevel;
    const previous = raw[index - 1];
    return Math.max(
      index === 0 ? 1 : 0,
      // Смена гармонии — слабее конкретного фразового признака: при гармоническом
      // ритме в один такт она срабатывает везде и сама по себе фазу не задаёт.
      (harmony.harmonicChangeAt[index] ?? 0) * 0.5,
      melody.melodyGapAfter[index - 1] ?? 0,
      harmony.cadenceAfter[index - 1] ?? 0,
      formalBoundaryAfter[index - 1] ? 1 : 0,
      // Конец лиги и локальный перелом мелодии в предыдущем такте — свидетельство,
      // что новая группа начинается именно здесь; без них фаза периода угадывалась.
      previous && previous.slurBoundaryStrength > 0 ? 0.8 : 0,
      (melody.lbdmAfter[index - 1] ?? 0) * 0.8,
      measure.pedalStarts > 0 ? 0.5 : 0,
      dynamicChange * 0.6,
    );
  });
}

const elementPatterns = new Map<string, RegExp>();
const tagAttributePatterns = new Map<string, RegExp>();
const attributePatterns = new Map<string, RegExp>();
const tagValuePatterns = new Map<string, RegExp>();

function extractElements(xml: string, tag: string): Array<{ attributes: string; body: string }> {
  let pattern = elementPatterns.get(tag);
  if (!pattern) {
    pattern = new RegExp(`<${tag}(?=\\s|>)([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
    elementPatterns.set(tag, pattern);
  }
  return Array.from(xml.matchAll(pattern), (match) => ({
    attributes: match[1] ?? "",
    body: match[2] ?? "",
  }));
}

/** Атрибуты пустых MusicXML-элементов вида `<dashes .../>`, `<breath-mark/>`. */
function extractTagAttributes(xml: string, tag: string): string[] {
  let pattern = tagAttributePatterns.get(tag);
  if (!pattern) {
    pattern = new RegExp(`<${tag}(?=\\s|/|>)([^>]*)\\/?>`, "gi");
    tagAttributePatterns.set(tag, pattern);
  }
  return Array.from(xml.matchAll(pattern), (match) => match[1] ?? "");
}

/**
 * `number="1"` уникален только внутри своего part/staff и типа линии. Объединённый
 * рояльный такт содержит несколько партий, поэтому без scope одна рука могла
 * случайно закрыть dashed/wedge другой партии.
 */
function extractScopedDirections(
  body: string,
): Array<{ scope: string; body: string; offset: number }> {
  const fromSource = (source: string, scope: string) => {
    const result: Array<{ scope: string; body: string; offset: number }> = [];
    let cursor = 0;
    let previousOnset = 0;
    const pattern =
      /<(note|backup|forward|direction)(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/gi;
    for (const match of source.matchAll(pattern)) {
      const kind = (match[1] ?? "").toLowerCase();
      const inner = match[2] ?? "";
      const duration = Number(tagValue(inner, "duration")) || 0;
      if (kind === "backup") {
        cursor -= duration;
      } else if (kind === "forward") {
        cursor += duration;
      } else if (kind === "note") {
        if (/<grace(?=\s|\/|>)/i.test(inner)) continue;
        const chord = /<chord(?=\s|\/|>)/i.test(inner);
        if (!chord) {
          previousOnset = cursor;
          cursor += duration;
        } else {
          cursor = Math.max(cursor, previousOnset + duration);
        }
      } else {
        const writtenOffset = Number(tagValue(inner, "offset")) || 0;
        result.push({ scope, body: inner, offset: cursor + writtenOffset });
      }
    }
    return result;
  };
  const adaptiveParts = extractElements(body, "adaptive-part");
  if (adaptiveParts.length > 0) {
    return adaptiveParts.flatMap((part, partIndex) => {
      const partId = attributeValue(part.attributes, "index") || String(partIndex);
      return fromSource(part.body, `part:${partId}`);
    });
  }
  const timewiseParts = extractElements(body, "part");
  if (timewiseParts.length > 0) {
    return timewiseParts.flatMap((part, partIndex) => {
      const partId = attributeValue(part.attributes, "id") || String(partIndex);
      return fromSource(part.body, `part:${partId}`);
    });
  }
  return fromSource(body, "part:0");
}

function profileMeasure(
  body: string,
  ordinal: number,
  measureQuarterBeats: number,
  divisions: number,
  measureNotes: MeasureNotes,
): RawMeasureProfile {
  const notes = measureNotes.events.filter((note) => !note.grace);
  const sounding = notes.filter((note) => !note.rest);
  const attacks = sounding.filter((note) => !note.chord);
  let currentChordSize = 0;
  let maxChordSize = 0;
  for (const note of sounding) {
    currentChordSize = note.chord ? currentChordSize + 1 : 1;
    maxChordSize = Math.max(maxChordSize, currentChordSize);
  }
  const firstPitchByStaff: Record<string, number> = {};
  const lastPitchByStaff: Record<string, number> = {};
  for (const note of attacks) {
    const pitch = note.midi;
    if (pitch === undefined) continue;
    const staff = note.staff;
    firstPitchByStaff[staff] ??= pitch;
    lastPitchByStaff[staff] = pitch;
  }
  const leadingAttacks = attacks.filter(
    (note) =>
      note.staff === "1" && note.voice === "1",
  );
  const slurStopNotes = sounding.filter((note) =>
    note.slurs.some((slur) => slur.type === "stop"),
  );
  const melodicSlurStops = slurStopNotes.filter(
    (note) => note.staff === "1" && note.voice === "1",
  ).length;
  const slurStopStreams = new Set(
    slurStopNotes.map((note) => `${note.staff}:${note.voice}`),
  ).size;
  const slurBoundaryStrength =
    melodicSlurStops > 0 ? (slurStopStreams > 1 ? 2 : 1) : 0;
  const melodicSlurEvents: GestureEvent[] = [];
  for (const note of sounding) {
    if (note.staff !== "1" || note.voice !== "1") continue;
    for (const slur of note.slurs) {
      const id = `${note.part}:staff:1:voice:1:slur:${slur.number}`;
      const type = slur.type;
      if (type === "start") {
        melodicSlurEvents.push({
          type: "start",
          marker: {
            id,
            label: "melodic slur",
            explicit: true,
          },
        });
      } else if (type === "stop") {
        melodicSlurEvents.push({ type: "stop", id });
      }
    }
  }
  const ornamentCount = sounding.filter((note) => note.ornament).length;
  // Наличие tie-start где-то внутри такта ещё не означает перенос через barline:
  // связь может закончиться на следующей ноте того же такта.
  const tiedIntoNext = hasTieAcrossMeasure(measureNotes);
  // Позиции сравниваются на сетке 1e-6 доли четверти, а не по значению с плавающей
  // точкой. Модель хранит onset в четвертях, и накопление 1/3 (триоли Moonlight) даёт
  // 1.9999999999999998 вместо 2 — на прежней целочисленной арифметике в divisions
  // такого не было. Из-за этого end_tick для server-method-162 расходился на 83
  // такта корпуса из 1484: Set считал одну и ту же позицию за две.
  const tickCount = Math.max(
    1,
    new Set(notes.map((event) => Math.round(event.onset * 1e6))).size,
  );
  const streams = new Map<string, number[]>();
  for (const note of attacks) {
    if (note.midi === undefined) continue;
    const stream = streams.get(note.stream) ?? [];
    stream.push(note.midi);
    streams.set(note.stream, stream);
  }
  const leaps = [...streams.values()].flatMap((stream) =>
    stream.slice(1).map((pitch, index) => Math.abs(pitch - stream[index])),
  );
  const speeds = notes.map((note) => NOTE_SPEED[note.type] ?? 1);
  const voices = new Set(notes.map((note) => `${note.staff}:${note.voice}`));
  const fullRest = sounding.length === 0 && notes.length > 0;
  const quarterBeats = measureQuarterBeats;
  const articulatedAttacks = attacks.filter((note) => note.articulations.length > 0).length;
  const gestureTechniques = sounding.filter(
    (note) => note.arpeggiate || note.glissando,
  ).length;
  const clefChange = ordinal > 0 && /<clef(?=\s|>)/i.test(body);
  const systemBreak = /<print\b[^>]*\bnew-(?:system|page)=["']yes["']/i.test(body);
  let pedalStarts = 0;
  let pedalReleases = 0;
  for (const attributes of extractTagAttributes(body, "pedal")) {
    const type = attributeValue(attributes, "type").toLowerCase();
    if (type === "start" || type === "sostenuto") pedalStarts += 1;
    else if (type === "stop" || type === "change" || type === "discontinue") {
      pedalReleases += 1;
    }
  }
  const lyrics = extractElements(body, "lyric");
  const lyricTexts = lyrics
    .map((lyric) => tagValue(lyric.body, "text"))
    .filter(Boolean);
  const lyricOpenEnded = lyrics.some((lyric) => {
    const syllabic = tagValue(lyric.body, "syllabic").toLowerCase();
    const extend = extractTagAttributes(lyric.body, "extend")
      .map((attributes) => attributeValue(attributes, "type").toLowerCase())
      .at(-1);
    return (
      syllabic === "begin" ||
      syllabic === "middle" ||
      extend === "" ||
      extend === "start" ||
      extend === "continue"
    );
  });
  const expressiveTempoStarts: ExpressiveTempoMarker[] = [];
  const expressiveTempoStops: string[] = [];
  const tempoGestureEvents: GestureEvent[] = [];
  const tempoTransitionLabels = new Set<string>();
  const tempoRegionLabels = new Set<string>();
  const soundTempos: number[] = [];
  const dynamicGestureStarts: ExpressiveTempoMarker[] = [];
  const dynamicGestureStops: string[] = [];
  const dynamicGestureEvents: GestureEvent[] = [];
  const dynamicLevels: number[] = [];
  const tempoResetScopes = new Set<string>();
  const formalBeforeLabels = new Set<string>();
  const formalAfterLabels = new Set<string>();
  let registerShiftTransition = false;
  let tempoReset = false;
  const tempoMarks: Array<{ tempo: number; position: number }> = [];
  for (const direction of extractScopedDirections(body)) {
    const staff = tagValue(direction.body, "staff") || "1";
    const scope = `${direction.scope}:staff:${staff}`;
    const words = extractElements(direction.body, "words")
      .map((item) => stripTags(item.body))
      .join(" ");
    const tempoGesture = expressiveTempoLabel(words);
    const dynamicGesture = expressiveDynamicLabel(words);
    const tempoRegion = tempoRegionLabel(words);
    if (tempoGesture) tempoTransitionLabels.add(tempoGesture);
    if (tempoRegion) {
      tempoTransitionLabels.add(tempoRegion);
      tempoRegionLabels.add(tempoRegion);
    }
    if (isTempoReset(words)) {
      tempoReset = true;
      tempoResetScopes.add(scope);
      tempoTransitionLabels.add("a tempo");
    }
    if (/<segno(?=\s|\/|>)/i.test(direction.body)) {
      formalBeforeLabels.add("segno");
    }
    if (/<coda(?=\s|\/|>)/i.test(direction.body)) {
      formalBeforeLabels.add("coda");
    }
    if (/\bD\.?\s*S\.?\b|\bdal\s+segno\b/i.test(words)) {
      formalAfterLabels.add("D.S.");
    }
    if (/\bD\.?\s*C\.?\b|\bda\s+capo\b/i.test(words)) {
      formalAfterLabels.add("D.C.");
    }
    if (/\bfine\b/i.test(words)) formalAfterLabels.add("Fine");
    if (/\bto\s+coda\b|\bal\s+coda\b/i.test(words)) {
      formalAfterLabels.add("To Coda");
    }
    let explicitTempoStart = false;
    for (const attributes of extractTagAttributes(direction.body, "dashes")) {
      const number = attributeValue(attributes, "number") || "1";
      // Вид линии входит в идентификатор: dashed `cresc.` и dashed `rall.` могут иметь
      // одинаковый number в одном scope, и без этого один закрывал бы другой.
      const tempoId = `${scope}:dashes:${number}:tempo`;
      const dynamicId = `${scope}:dashes:${number}:dynamic`;
      const type = attributeValue(attributes, "type").toLowerCase();
      if (type === "start" && tempoGesture) {
        const marker = { id: tempoId, label: tempoGesture, explicit: true };
        expressiveTempoStarts.push(marker);
        tempoGestureEvents.push({ type: "start", marker });
        explicitTempoStart = true;
      } else if (type === "start" && dynamicGesture) {
        const marker = { id: dynamicId, label: dynamicGesture, explicit: true };
        dynamicGestureStarts.push(marker);
        dynamicGestureEvents.push({ type: "start", marker });
      } else if (type === "stop") {
        // Какая именно линия закрылась, знает только тот, у кого она открыта:
        // события уходят в оба слоя, а активную дугу находит enrichProfiles.
        expressiveTempoStops.push(tempoId);
        dynamicGestureStops.push(dynamicId);
        tempoGestureEvents.push({ type: "stop", id: tempoId });
        dynamicGestureEvents.push({ type: "stop", id: dynamicId });
      }
    }
    if (tempoGesture && !explicitTempoStart && ordinal > 0) {
      const marker = {
        id: `${scope}:implicit-tempo:${ordinal}:${tempoGesture}`,
        label: tempoGesture,
        explicit: false,
      };
      expressiveTempoStarts.push(marker);
      tempoGestureEvents.push({ type: "start", marker });
    }
    for (const attributes of extractTagAttributes(direction.body, "wedge")) {
      const number = attributeValue(attributes, "number") || "1";
      const id = `${scope}:wedge:${number}`;
      const type = attributeValue(attributes, "type").toLowerCase();
      if (type === "crescendo" || type === "diminuendo") {
        const marker = { id, label: type, explicit: true };
        dynamicGestureStarts.push(marker);
        dynamicGestureEvents.push({ type: "start", marker });
      } else if (type === "stop") {
        dynamicGestureStops.push(id);
        dynamicGestureEvents.push({ type: "stop", id });
      }
    }
    for (const dynamics of extractElements(direction.body, "dynamics")) {
      const level = dynamicLevel(dynamics.body);
      if (level !== undefined) dynamicLevels.push(level);
    }
    const durationUnits = Math.max(1, measureQuarterBeats * divisions);
    const position = direction.offset / durationUnits;
    // `<metronome>` встречается в 16 партитурах корпуса из 18 и часто без `<sound>`:
    // без него настоящие смены темпа терялись, а playback-рубато считалось за них.
    for (const metronome of extractElements(direction.body, "metronome")) {
      const perMinute = Number(tagValue(metronome.body, "per-minute"));
      const unit = tagValue(metronome.body, "beat-unit").toLowerCase();
      if (!Number.isFinite(perMinute) || perMinute <= 0) continue;
      const unitQuarters =
        ({
          whole: 4,
          half: 2,
          quarter: 1,
          eighth: 0.5,
          "16th": 0.25,
        } as Record<string, number>)[unit] ?? 1;
      const dotted = /<beat-unit-dot(?=\s|\/|>)/i.test(metronome.body) ? 1.5 : 1;
      tempoMarks.push({ tempo: perMinute * unitQuarters * dotted, position });
    }
    for (const attributes of extractTagAttributes(direction.body, "sound")) {
      const tempo = Number(attributeValue(attributes, "tempo"));
      if (Number.isFinite(tempo) && tempo > 0) {
        soundTempos.push(tempo);
        tempoMarks.push({ tempo, position });
      }
      if (attributeValue(attributes, "segno")) formalBeforeLabels.add("segno");
      if (attributeValue(attributes, "coda")) formalBeforeLabels.add("coda");
      if (attributeValue(attributes, "dalsegno")) formalAfterLabels.add("D.S.");
      if (attributeValue(attributes, "dacapo")) formalAfterLabels.add("D.C.");
      if (attributeValue(attributes, "tocoda")) formalAfterLabels.add("To Coda");
      if (attributeValue(attributes, "fine")) formalAfterLabels.add("Fine");
    }
    for (const attributes of extractTagAttributes(direction.body, "octave-shift")) {
      const type = attributeValue(attributes, "type").toLowerCase();
      if (type === "up" || type === "down" || type === "stop") {
        registerShiftTransition = true;
      }
    }
  }
  const boundaryBefore: BoundarySignal[] = [];
  const boundaryAfter: BoundarySignal[] = [];

  if (/<rehearsal(?=\s|>)/i.test(body)) boundaryBefore.push(signal(9, "репетиционная метка", true));
  for (const label of formalBeforeLabels) {
    boundaryBefore.push(signal(9, `формальная метка ${label}`, true));
  }
  for (const label of formalAfterLabels) {
    boundaryAfter.push(signal(9, `навигация ${label}`, true));
  }
  // Смена тональности/метра/темпа может происходить внутри непрерывной фразы.
  // Сама по себе она является кандидатом границы, но становится жёсткой только
  // вместе с паузой, двойной чертой, rehearsal/section label или ферматой.
  if (/<key(?=\s|>)/i.test(body) && ordinal > 0) boundaryBefore.push(signal(4, "смена тональности"));
  if (/<time(?=\s|>)/i.test(body) && ordinal > 0) boundaryBefore.push(signal(2, "смена размера"));
  // Численные смены темпа проверяются на относительную величину в enrichProfiles:
  // экспортёры пишут `<sound tempo>` на каждый рубато-жест (в Gymnopédie их 37), и
  // без порога каждое такое значение превращалось в формальную границу раздела.
  for (const marker of expressiveTempoStarts) {
    boundaryBefore.push(signal(marker.explicit ? 6 : 5, `начало ${marker.label}`));
  }
  if (tempoReset && ordinal > 0) boundaryBefore.push(signal(5, "возврат a tempo"));
  if (ordinal > 0) {
    for (const label of tempoRegionLabels) {
      boundaryBefore.push(signal(5, `новый ${label}`));
    }
  }
  if (/<words(?=\s|>)[^>]*>\s*(?:intro|verse|chorus|bridge|coda|trio|refrain|куплет|припев|кода)/i.test(body)) {
    boundaryBefore.push(signal(8, "обозначение раздела", true));
  }
  // Barline направлен атрибутом location: "left" — это граница ПЕРЕД тактом (например
  // forward-repeat в начале припева), "right"/без атрибута — ПОСЛЕ такта. Раньше код
  // тестировал тело такта целиком и относил любой barline к границе после него, из-за
  // чего forward-repeat смещал структурную границу на такт вперёд.
  for (const barline of extractElements(body, "barline")) {
    const before = /location=["']left["']/i.test(barline.attributes);
    const target = before ? boundaryBefore : boundaryAfter;
    if (/<ending\b[^>]*\btype=["']start["']/i.test(barline.body)) {
      target.push(signal(4, "начало вариантной вольты"));
    }
    if (/<ending\b[^>]*\btype=["'](?:stop|discontinue)["']/i.test(barline.body)) {
      target.push(signal(4, "конец вариантной вольты"));
    }
    if (/<repeat\b[^>]*direction=["']backward["']/i.test(barline.body)) {
      target.push(signal(10, "конец повтора", true));
    }
    if (/<repeat\b[^>]*direction=["']forward["']/i.test(barline.body)) {
      target.push(signal(9, "начало повтора", true));
    }
    if (/<bar-style>\s*(?:light-light|light-heavy|heavy-light|heavy-heavy)\s*<\/bar-style>/i.test(barline.body)) {
      target.push(signal(8, "двойная тактовая черта", true));
    }
  }
  if (/<fermata(?=\s|\/|>)/i.test(body)) boundaryAfter.push(signal(7, "фермата", true));
  if (/<caesura(?=\s|\/|>)/i.test(body)) boundaryAfter.push(signal(8, "цезура", true));
  if (/<breath-mark(?=\s|\/|>)/i.test(body)) boundaryAfter.push(signal(5, "дыхание"));
  if (slurBoundaryStrength > 0) {
    boundaryAfter.push(
      signal(
        slurBoundaryStrength,
        slurBoundaryStrength > 1
          ? "согласованное окончание мелодической лиги"
          : "окончание мелодической лиги",
      ),
    );
  }
  if (fullRest) boundaryAfter.push(signal(6, "полная пауза", true));

  return {
    ordinal,
    noteCount: sounding.length,
    chordCount: sounding.filter((note) => note.chord).length,
    accidentalCount: sounding.filter((note) => note.accidental).length,
    tupletCount: sounding.filter((note) => note.tuplet).length,
    voices: Math.max(1, voices.size),
    fastestNote: Math.max(1, ...speeds),
    maxLeap: Math.max(0, ...leaps),
    fullRest,
    signature: motifFingerprint(leadingAttacks.length ? leadingAttacks : attacks),
    quarterBeats,
    tiedIntoNext,
    hasLyrics: lyricTexts.length > 0,
    lyricOpenEnded,
    tickCount,
    attackCount: attacks.length,
    maxChordSize,
    firstPitchByStaff,
    lastPitchByStaff,
    ornamentCount,
    slurBoundaryStrength,
    melodicSlurEvents,
    expressiveTempoStarts,
    expressiveTempoStops,
    tempoGestureEvents,
    tempoTransitionLabels: [...tempoTransitionLabels],
    soundTempos,
    tempoReset,
    tempoResetScopes: [...tempoResetScopes],
    dynamicGestureStarts,
    dynamicGestureStops,
    dynamicGestureEvents,
    dynamicLevel: dynamicLevels.at(-1),
    registerShiftTransition,
    pedalStarts,
    pedalReleases,
    clefChange,
    articulationRatio: attacks.length ? articulatedAttacks / attacks.length : 0,
    gestureTechniques,
    systemBreak,
    tempoMarks,
    boundaryBefore,
    boundaryAfter,
  };
}

function enrichProfiles(
  raw: RawMeasureProfile[],
  wholeStart: number,
  slowTempoBpm: number | undefined,
  context: MusicalContext,
): AdaptiveMeasureProfile[] {
  const baseLoads = computeLoads(raw, context);
  interface ActiveGesture {
    label: string;
    implicit: boolean;
    startedAt: number;
  }
  const activeTempoSpans = new Map<string, ActiveGesture>();
  const tempoSpanStates = raw.map((measure, index) => {
    const endedLabels: string[] = [];
    for (const event of measure.tempoGestureEvents) {
      if (event.type === "start") {
        activeTempoSpans.set(event.marker.id, {
          label: event.marker.label,
          implicit: !event.marker.explicit,
          startedAt: index,
        });
      } else {
        const gesture = activeTempoSpans.get(event.id);
        if (gesture) endedLabels.push(gesture.label);
        activeTempoSpans.delete(event.id);
      }
    }
    // Некоторые экспортёры завершают dashed span только словом `a tempo`.
    // Возврат стоит в начале следующего такта, поэтому span заканчивается после
    // текущего и текущая граница остаётся допустимой.
    if (raw[index + 1]?.tempoReset && activeTempoSpans.size > 0) {
      const resetParts = new Set(
        raw[index + 1].tempoResetScopes.map((scope) => scope.split(":staff:")[0]),
      );
      for (const [id, gesture] of [...activeTempoSpans]) {
        const eventPart = id.split(":staff:")[0];
        if (resetParts.size === 0 || resetParts.has(eventPart)) {
          endedLabels.push(gesture.label);
          activeTempoSpans.delete(id);
        }
      }
    }
    // `rit.` без dashes получает ограниченный контекстный span: до reset / нового
    // tempo region / формальной остановки / учебного потолка. Так предпоследний rit.
    // не теряется, но одиночная надпись не делает неделимым весь остаток пьесы.
    const closesImplicit =
      measure.boundaryAfter.some((item) => item.hard) ||
      Boolean(raw[index + 1]?.tempoTransitionLabels.length) ||
      index === raw.length - 1;
    for (const [id, gesture] of [...activeTempoSpans]) {
      if (
        gesture.implicit &&
        (closesImplicit ||
          index - gesture.startedAt + 1 >=
            PEDAGOGY.maxImplicitTempoGestureMeasures)
      ) {
        endedLabels.push(gesture.label);
        activeTempoSpans.delete(id);
      }
    }
    return {
      continuesAfter: activeTempoSpans.size > 0,
      labelsAfter: [...activeTempoSpans.values()].map((item) => item.label),
      endedLabels: Array.from(new Set(endedLabels)),
    };
  });
  const activeDynamicSpans = new Map<string, ActiveGesture>();
  const dynamicSpanStates = raw.map((measure, index) => {
    const endedLabels: string[] = [];
    for (const event of measure.dynamicGestureEvents) {
      if (event.type === "start") {
        activeDynamicSpans.set(event.marker.id, {
          label: event.marker.label,
          implicit: !event.marker.explicit,
          startedAt: index,
        });
      } else {
        const gesture = activeDynamicSpans.get(event.id);
        if (gesture) endedLabels.push(gesture.label);
        activeDynamicSpans.delete(event.id);
      }
    }
    if (index === raw.length - 1) {
      endedLabels.push(...[...activeDynamicSpans.values()].map((item) => item.label));
      activeDynamicSpans.clear();
    }
    return {
      continuesAfter: activeDynamicSpans.size > 0,
      labelsAfter: [...activeDynamicSpans.values()].map((item) => item.label),
      endedLabels: Array.from(new Set(endedLabels)),
    };
  });
  const activeMelodicSlurs = new Map<string, number>();
  const melodicSlurStates = raw.map((measure, index) => {
    const endedLengths: number[] = [];
    for (const event of measure.melodicSlurEvents) {
      if (event.type === "start") {
        activeMelodicSlurs.set(event.marker.id, index);
      } else {
        const startedAt = activeMelodicSlurs.get(event.id);
        if (startedAt !== undefined) endedLengths.push(index - startedAt + 1);
        activeMelodicSlurs.delete(event.id);
      }
    }
    if (index === raw.length - 1) activeMelodicSlurs.clear();
    return {
      continuesAfter: activeMelodicSlurs.size > 0,
      endedLong: endedLengths.some((length) => length >= 2),
    };
  });
  let currentDynamic: number | undefined;
  const dynamicStates = raw.map((measure) => {
    const previous = currentDynamic;
    if (measure.dynamicLevel !== undefined) currentDynamic = measure.dynamicLevel;
    const delta =
      previous !== undefined && measure.dynamicLevel !== undefined
        ? measure.dynamicLevel - previous
        : 0;
    return { delta, current: currentDynamic };
  });
  const repeatedMotiveBefore = findRepeatedMotiveStarts(raw);
  const tempoChanges = detectTempoChanges(raw);
  const { melody, harmony, structure, salience: informativeness } = context;
  // Информативный сигнал сохраняет полный вес, «фоновый» — треть: полностью гасить
  // признак нельзя, иначе педальная фактура теряет и лиги, и паузы мелодии сразу.
  const weight = (kind: SignalKind) => 0.35 + 0.65 * informativeness[kind];

  return raw.map((measure, index) => {
    const signals = [
      ...measure.boundaryAfter,
      ...(raw[index + 1]?.boundaryBefore ?? []),
    ];
    for (const label of tempoSpanStates[index].endedLabels) {
      signals.push(signal(6, `конец ${label}`));
    }
    if (tempoChanges.before[index]) signals.push(signal(5, "смена темпа"));
    if (tempoChanges.after[index]) {
      signals.push(signal(5, "смена темпа в конце такта"));
    }
    // Каденция — главный признак конца музыкальной мысли в тональной музыке и
    // единственный доступный там, где нотация молчит (Moonlight, Gymnopédie).
    const cadence = harmony.cadenceAfter[index] ?? 0;
    if (cadence >= 0.45) {
      const type = harmony.cadenceTypeAfter[index];
      signals.push(
        signal(
          cadence * 8 * weight("cadence"),
          `каденция${type ? ` ${type}` : ""}`,
        ),
      );
    }
    const gap = melody.melodyGapAfter[index] ?? 0;
    if (gap >= 0.25) {
      signals.push(signal(2 + gap * 5 * weight("melodyGap"), "пауза в мелодии"));
    }
    const relief = melody.lbdmAfter[index] ?? 0;
    if (relief >= 0.45) signals.push(signal(relief * 3, "мелодический рельеф"));
    if (
      measure.pedalReleases > 0 &&
      (raw[index + 1]?.pedalStarts ?? 0) > 0
    ) {
      signals.push(signal(2 * weight("pedalRelease"), "смена педали"));
    }
    const seam = structure.sectionBoundaryAfter[index] ?? 0;
    if (seam >= 0.6) signals.push(signal(2 + seam * 5, "шов формы"));
    if (structure.hyperDownbeat[index + 1]) {
      signals.push(
        signal(hypermeterTier(index + 1, structure), "гиперметрическая опора"),
      );
    }
    if (raw[index + 1]?.systemBreak) signals.push(signal(0.5, "конец строки"));
    if (
      dynamicSpanStates[index].endedLabels.length > 0 &&
      Math.abs(dynamicStates[index + 1]?.delta ?? 0) >= 1
    ) {
      signals.push(signal(1, "динамическое прибытие"));
    }
    if (melodicSlurStates[index].endedLong) {
      signals.push(signal(2, "конец длинной мелодической лиги"));
    }
    const nextDynamicDelta = Math.abs(dynamicStates[index + 1]?.delta ?? 0);
    if (nextDynamicDelta >= 2) {
      signals.push(signal(nextDynamicDelta >= 3 ? 2 : 1, "контраст динамики"));
    }
    const next = baseLoads[index + 1];
    const previous = baseLoads[index - 1];
    if (
      next !== undefined &&
      previous !== undefined &&
      baseLoads[index] < Math.min(previous, next) * 0.72
    ) {
      signals.push(signal(2, "спад технической нагрузки"));
    }
    if (repeatedMotiveBefore.has(index + 1)) {
      signals.push(signal(1, "возврат двухтактового мотива"));
    }
    const transitionLabelsBefore = [...measure.tempoTransitionLabels];
    if (tempoChanges.labels[index]) {
      transitionLabelsBefore.push(tempoChanges.labels[index] as string);
    }
    if (Math.abs(dynamicStates[index].delta) >= 1) {
      transitionLabelsBefore.push("смена динамики");
    }
    if (measure.registerShiftTransition) {
      transitionLabelsBefore.push("смена регистра");
    }
    if (measure.clefChange) transitionLabelsBefore.push("смена ключа");
    if (harmony.keyChangeAt[index]) transitionLabelsBefore.push("модуляция");
    if (
      index > 0 &&
      Math.abs(measure.articulationRatio - raw[index - 1].articulationRatio) >= 0.5
    ) {
      transitionLabelsBefore.push("смена штриха");
    }
    if (
      index > 0 &&
      measure.pedalStarts > 0 !== raw[index - 1].pedalStarts > 0 &&
      Math.abs(measure.pedalStarts - raw[index - 1].pedalStarts) >= 2
    ) {
      transitionLabelsBefore.push("смена педализации");
    }
    if (
      index > 0 &&
      (measure.tupletCount > 0) !== (raw[index - 1].tupletCount > 0)
    ) {
      transitionLabelsBefore.push("смена ритмического деления");
    }
    if (measure.gestureTechniques > 0 && (raw[index - 1]?.gestureTechniques ?? 0) === 0) {
      transitionLabelsBefore.push("арпеджио/глиссандо");
    }
    if (measure.ornamentCount > 0 && (raw[index - 1]?.ornamentCount ?? 0) === 0) {
      transitionLabelsBefore.push("вход в орнамент");
    }
    if (
      index > 0 &&
      (Math.abs(measure.voices - raw[index - 1].voices) >= 2 ||
        Math.abs(measure.maxChordSize - raw[index - 1].maxChordSize) >= 2)
    ) {
      transitionLabelsBefore.push("смена плотности голосов");
    }
    if (
      index > 0 &&
      (raw[index - 1].boundaryAfter.some((item) =>
        /фермат|цезур|дыхани/.test(item.reason),
      ) ||
        raw[index - 1].fullRest)
    ) {
      transitionLabelsBefore.push("возобновление после остановки");
    }
    return {
      ...measure,
      measure: wholeStart + index,
      load: round(baseLoads[index], 3),
      closureAfter: round(
        Math.max(
          harmony.cadenceAfter[index] ?? 0,
          melody.melodyGapAfter[index] ?? 0,
          measure.slurBoundaryStrength > 0 ? 0.6 : 0,
          melodicSlurStates[index].endedLong ? 0.7 : 0,
          measure.fullRest ? 0.8 : 0,
          measure.boundaryAfter.some((item) => item.hard) ? 0.9 : 0,
          structure.sectionBoundaryAfter[index] ?? 0,
          measure.pedalReleases > 0 && (raw[index + 1]?.pedalStarts ?? 0) > 0 ? 0.5 : 0,
        ),
        3,
      ),
      cadenceTypeAfter: harmony.cadenceTypeAfter[index] ?? "",
      hyperDownbeatBefore: Boolean(structure.hyperDownbeat[index]),
      sectionBoundaryAfter: round(structure.sectionBoundaryAfter[index] ?? 0, 3),
      materialNovelty: round(structure.materialNovelty[index] ?? 1, 3),
      navigationBreakAfter: Boolean(context.navigation.discontinuityAfter[index]),
      boundaryScoreAfter: combineBoundarySignals(signals),
      boundaryReasonsAfter: Array.from(new Set(signals.map((item) => item.reason))),
      hardBoundaryAfter: signals.some((item) => item.hard),
      estSeconds: slowTempoBpm ? round((measure.quarterBeats * 60) / slowTempoBpm, 2) : 0,
      // Tie — сильный запрет на обычный cut point. Если цепочка длиннее учебного
      // окна, DP всё же режет её с большим штрафом, а buildBridgeChunks обязательно
      // добавляет перекрывающий переход. Аналогично не режем внутри явно
      // протяжённого tempo gesture: rall./rit./accel. осваивается одной дугой.
      forbiddenAfter:
        measure.tiedIntoNext || tempoSpanStates[index].continuesAfter,
      expressiveTempoContinuesAfter: tempoSpanStates[index].continuesAfter,
      expressiveTempoLabelsAfter: tempoSpanStates[index].labelsAfter,
      dynamicGestureContinuesAfter: dynamicSpanStates[index].continuesAfter,
      dynamicGestureLabelsAfter: dynamicSpanStates[index].labelsAfter,
      melodicSlurContinuesAfter: melodicSlurStates[index].continuesAfter,
      transitionLabelsBefore: Array.from(new Set(transitionLabelsBefore)),
    };
  });
}

/**
 * Численные смены темпа с порогом относительного изменения.
 *
 * Экспортёры пишут `<sound tempo>` на каждый рубато-жест: в Gymnopédie их 37 на 78
 * тактов, и раньше каждое такое значение давало «смену темпа» весом 5 и лишний
 * Bridge. Порог в 5 % отделяет настоящую смену темпа от воспроизведения агогики.
 */
function detectTempoChanges(raw: RawMeasureProfile[]): {
  before: boolean[];
  after: boolean[];
  labels: Array<string | undefined>;
} {
  const before = raw.map(() => false);
  const after = raw.map(() => false);
  const labels: Array<string | undefined> = raw.map(() => undefined);
  let running: number | undefined;
  for (const [index, measure] of raw.entries()) {
    const marks = [...measure.tempoMarks].sort(
      (left, right) => left.position - right.position,
    );
    for (const mark of marks) {
      const isInitial = running === undefined && index === 0;
      const changed =
        running === undefined
          ? !isInitial
          : Math.abs(mark.tempo - running) / running >= PEDAGOGY.tempoChangeRatio;
      running = mark.tempo;
      if (!changed) continue;
      labels[index] = `tempo ${round(mark.tempo, 2)}`;
      if (mark.position <= 0.2) before[index] = true;
      else if (mark.position >= 0.7) after[index] = true;
      else before[index] = true;
    }
  }
  return { before, after, labels };
}

/**
 * Вес гиперметрической опоры. Границы на кратных периоду тактах поддерживаются
 * слабее, чем на кратных двум и четырём периодам: так восьмитактовый период не
 * распадается на четыре двухтактовых обрывка, а сама опора не навязывается, если
 * период определён неуверенно.
 */
function hypermeterTier(index: number, structure: StructureAnalysis): number {
  const tier = structure.hyperTier[index] ?? 0;
  if (tier === 0) return 0;
  return tier * (0.4 + 0.6 * (structure.hyperConfidence[index] ?? 0));
}

/**
 * Учебная стоимость такта. Нормируется на музыкальное время: при смене размера
 * (в Nothing Else Matters их тринадцать) «нагрузка на такт» скачет из-за длины такта,
 * а не из-за трудности. К плотности добавляются реальные пианистические факторы —
 * растяжка аккорда, полиритм между руками, чёрные клавиши и перекрещивание рук, — и
 * скидка за уже освоенный материал: четвёртое повторение остинато требует меньше
 * внимания, чем первое.
 */
function computeLoads(
  raw: RawMeasureProfile[],
  context: MusicalContext,
): number[] {
  const quarterOf = (measure: RawMeasureProfile) => Math.max(0.5, measure.quarterBeats);
  const medianQuarters = Math.max(0.5, median(raw.map(quarterOf)));
  const medianAttackRate = Math.max(
    0.25,
    median(
      raw
        .map((measure) => measure.attackCount / quarterOf(measure))
        .filter((value) => value > 0),
    ),
  );
  const medianNoteRate = Math.max(
    0.25,
    median(
      raw
        .map((measure) => measure.noteCount / quarterOf(measure))
        .filter((value) => value > 0),
    ),
  );
  return raw.map((measure, index) => {
    const quarters = quarterOf(measure);
    const density =
      measure.attackCount / quarters / medianAttackRate +
      (measure.noteCount / quarters / medianNoteRate) * 0.25;
    const chordRatio = measure.chordCount / Math.max(1, measure.noteCount);
    const accidentalRatio = measure.accidentalCount / Math.max(1, measure.noteCount);
    const tupletRatio = measure.tupletCount / Math.max(1, measure.noteCount);
    const ergonomics = measureErgonomics(context.notes[index]);
    const intensity = Math.max(
      0.35,
      density +
        chordRatio * 1.4 +
        accidentalRatio * 0.55 +
        tupletRatio * 1.5 +
        Math.max(0, measure.voices - 1) * 0.45 +
        Math.max(0, Math.log2(measure.fastestNote)) * 0.32 +
        Math.min(1.5, measure.maxLeap / 12) +
        Math.max(0, measure.maxChordSize - 2) * 0.22 +
        measure.ornamentCount * 0.18 +
        measure.gestureTechniques * 0.12 +
        ergonomics +
        (measure.fullRest ? -0.4 : 0),
    );
    const familiarity = 0.75 + 0.25 * (context.structure.materialNovelty[index] ?? 1);
    return Math.max(0.2, intensity * (quarters / medianQuarters) * familiarity);
  });
}

/** Растяжка, полиритм, чёрные клавиши и перекрещивание рук — из нотной модели. */
function measureErgonomics(measure: MeasureNotes | undefined): number {
  if (!measure) return 0;
  const sounding = soundingOf(measure);
  if (sounding.length === 0) return 0;
  const byChord = new Map<string, number[]>();
  for (const note of sounding) {
    const key = `${note.stream}:${round(note.onset, 3)}`;
    const list = byChord.get(key) ?? [];
    list.push(note.midi as number);
    byChord.set(key, list);
  }
  let stretch = 0;
  for (const pitches of byChord.values()) {
    const span = Math.max(...pitches) - Math.min(...pitches);
    if (span > 9) stretch = Math.max(stretch, Math.min(0.6, (span - 9) / 12));
  }
  const staves = new Map<string, number[]>();
  const tupletStaves = new Set<string>();
  for (const note of sounding) {
    const list = staves.get(note.staff) ?? [];
    list.push(note.midi as number);
    staves.set(note.staff, list);
    if (note.tuplet) tupletStaves.add(note.staff);
  }
  // Триоли в одной руке против ровных длительностей в другой — самостоятельная
  // координационная трудность, которую плотность нот не отражает.
  const polyrhythm =
    staves.size > 1 && tupletStaves.size > 0 && tupletStaves.size < staves.size
      ? 0.5
      : 0;
  const blackKeys =
    sounding.filter((note) => [1, 3, 6, 8, 10].includes((note.midi as number) % 12))
      .length / sounding.length;
  const upper = staves.get("1");
  const lower = staves.get("2");
  const crossing =
    upper && lower && Math.min(...upper) < Math.max(...lower) - 2 ? 0.3 : 0;
  return stretch + polyrhythm + blackKeys * 0.2 + crossing;
}

function optimizePhrases(
  measures: AdaptiveMeasureProfile[],
  context: MusicalContext,
  slowTempoBpm?: number,
): SlicingExercise[] {
  const count = measures.length;
  if (count === 0) return [];
  const musicalSpan = deriveTargetSpan(measures, context);
  const medianSeconds = median(measures.map((measure) => measure.estSeconds));
  // Музыкальная длина фразы и учебное окно времени должны требовать одного и того
  // же: иначе баланс нагрузки тянет к четырём тактам, а секунды — к четырнадцати, и
  // цена границы перестаёт что-либо означать. На очень медленной музыке решает
  // музыкальная длина, на очень быстрой — минимальная длительность упражнения.
  const targetSpan =
    slowTempoBpm && medianSeconds > 0
      ? Math.min(
          Math.max(musicalSpan, PEDAGOGY.minChunkSeconds / medianSeconds),
          Math.max(
            PEDAGOGY.minPhraseMeasures,
            PEDAGOGY.maxChunkSeconds / medianSeconds,
          ),
        )
      : musicalSpan;
  const targetLoad = Math.max(0.5, median(measures.map((measure) => measure.load)) * targetSpan);
  const maxSpan = deriveMaxSpan(measures, slowTempoBpm);
  const targetSeconds = slowTempoBpm ? medianSeconds * targetSpan : 0;
  // Сила границы измеряется относительно самой партитуры: абсолютная шкала баллов
  // заполнена по-разному у пьесы с репризами и у пьесы без единой метки.
  const boundaryReference = Math.max(
    1,
    quantile(
      measures.map((measure) => measure.boundaryScoreAfter),
      0.9,
    ),
  );
  const closureReference = quantile(
    measures.map((measure) => measure.closureAfter),
    0.9,
  );
  const tieFactor = 0.25 + 0.75 * context.salience.tie;
  const gestureFactor = 0.25 + 0.75 * context.salience.tempoGesture;
  const dynamicFactor = 0.25 + 0.75 * context.salience.dynamicGesture;
  const slurFactor = 0.25 + 0.75 * context.salience.slur;
  const prefix = [0];
  for (const measure of measures) prefix.push(prefix[prefix.length - 1] + measure.load);
  const prefixSeconds = [0];
  for (const measure of measures) prefixSeconds.push(prefixSeconds[prefixSeconds.length - 1] + measure.estSeconds);
  // Четыре члена цены — суммы по внутренним границам фрагмента. Префиксы убирают
  // повторный проход по окну для каждой пары start/end.
  const prefixHard = buildPrefix(measures, (measure) =>
    measure.hardBoundaryAfter ? 1 : 0,
  );
  const prefixExpressive = buildPrefix(measures, (_, index) =>
    measures[index + 1]?.tempoTransitionLabels.length ? 1 : 0,
  );
  const prefixSection = buildPrefix(measures, (measure) =>
    measure.sectionBoundaryAfter >= 0.6 ? measure.sectionBoundaryAfter ** 2 : 0,
  );
  const prefixNavigation = buildPrefix(measures, (_, index) =>
    context.navigation.discontinuityAfter[index] ? 1 : 0,
  );

  const costs = Array<number>(count + 1).fill(Number.POSITIVE_INFINITY);
  const previous = Array<number>(count + 1).fill(-1);
  costs[0] = 0;

  for (let end = 1; end <= count; end += 1) {
    // Обычную границу с tie избегаем большим штрафом. Абсолютный запрет здесь
    // создавал 20–30-тактовые Phrase на педальной фактуре; вынужденный разрез
    // дополнительно страхуется Bridge и явным warning.
    const earliest = Math.max(0, end - maxSpan);
    for (let start = earliest; start < end; start += 1) {
      if (!Number.isFinite(costs[start])) continue;
      const span = end - start;
      const load = prefix[end] - prefix[start];
      const ratio = load / targetLoad;
      const boundary = end === count ? PEDAGOGY.hardBoundaryScore : measures[end - 1].boundaryScoreAfter;
      let cost = costs[start] + Math.abs(Math.log(Math.max(0.05, ratio)));
      const internalEnd = end - 1;
      cost +=
        (prefixHard[internalEnd] - prefixHard[start]) *
        PEDAGOGY.hardBoundaryCrossPenalty;
      cost +=
        (prefixExpressive[internalEnd] - prefixExpressive[start]) *
        PEDAGOGY.expressiveBoundaryCrossPenalty;
      // Печатное соседство внутри фрагмента должно быть исполнительским: Phrase не
      // может содержать конец первой вольты и начало второй или переход через `To Coda`.
      cost +=
        (prefixNavigation[internalEnd] - prefixNavigation[start]) *
        PEDAGOGY.navigationCrossPenalty;
      // Запреты умножаются на информативность признака в этой партитуре: там, где
      // tie переносится почти через каждую черту, он перестаёт быть аргументом.
      if (end !== count && measures[end - 1].tiedIntoNext) {
        cost += PEDAGOGY.tieCutPenalty * tieFactor;
      }
      if (
        end !== count &&
        measures[end - 1].expressiveTempoContinuesAfter
      ) {
        cost += PEDAGOGY.expressiveSpanCutPenalty * gestureFactor;
      }
      if (
        end !== count &&
        measures[end - 1].dynamicGestureContinuesAfter
      ) {
        cost += PEDAGOGY.dynamicSpanCutPenalty * dynamicFactor;
      }
      if (
        end !== count &&
        measures[end - 1].melodicSlurContinuesAfter
      ) {
        cost += PEDAGOGY.melodicSlurCutPenalty * slurFactor;
      }
      if (end !== count) {
        // Главный музыкальный член: фраза обязана заканчиваться закрытием, а не
        // там, где сошёлся баланс нагрузки.
        // Закрытие измеряется относительно самой партитуры: если каденций, пауз и
        // лиг в ней нет вовсе, этот член превращался бы в постоянный налог на любой
        // разрез и запрещал бы резать даже по гиперметрической сетке.
        cost +=
          PEDAGOGY.closureWeight *
          (1 -
            (closureReference > 0.05
              ? Math.min(1, measures[end - 1].closureAfter / closureReference)
              : 1));
        if (!measures[end].hyperDownbeatBefore) {
          cost +=
            PEDAGOGY.hypermeterWeight *
            (0.3 + 0.7 * (context.structure.hyperConfidence[end] ?? 0));
        }
        cost +=
          (prefixSection[internalEnd] - prefixSection[start]) *
          PEDAGOGY.sectionCrossPenalty;
      }
      // Не награда за границу, а штраф за слабую границу. Награда за каждый разрез
      // делала выгодным резать чаще: с богатым набором признаков почти каждая черта
      // получала высокий балл, и Phrase рассыпался на четырёхтактовые обрывки.
      // Штраф, наоборот, оставляет ровно те границы, которые музыка подтверждает.
      cost +=
        PEDAGOGY.hardBoundaryScore *
        PEDAGOGY.boundaryReward *
        (1 - Math.min(1, boundary / boundaryReference));
      if (span < PEDAGOGY.minPhraseMeasures && end !== count && !measures[end - 1].hardBoundaryAfter) {
        cost += 1.4;
      }
      if (ratio < PEDAGOGY.minTargetLoadRatio) cost += PEDAGOGY.minTargetLoadRatio - ratio;
      if (ratio > PEDAGOGY.maxTargetLoadRatio) cost += (ratio - PEDAGOGY.maxTargetLoadRatio) * 1.7;
      if (slowTempoBpm) {
        // Мягкая поправка по реальной длительности на Slow — независимая от плотности
        // нот: складывается с ratio-штрафом выше, а не заменяет его.
        const seconds = prefixSeconds[end] - prefixSeconds[start];
        // Потолок по медианному такту не спасает партитуру с неоднородными тактами
        // (Interstellar: смены размера растягивали двенадцать тактов до 72 секунд).
        // Поэтому длительность ограничивается прямо в переборе, но только если у
        // фрагмента есть альтернатива короче учебного минимума по тактам.
        if (
          seconds > PEDAGOGY.maxChunkSeconds &&
          span > PEDAGOGY.minPhraseMeasures
        ) {
          continue;
        }
        if (seconds < PEDAGOGY.minChunkSeconds) cost += (PEDAGOGY.minChunkSeconds - seconds) * 0.05;
        else if (seconds > PEDAGOGY.maxChunkSeconds) cost += (seconds - PEDAGOGY.maxChunkSeconds) * 0.06;
        if (targetSeconds > 0 && seconds > 0) {
          cost +=
            PEDAGOGY.durationSpreadWeight *
            Math.abs(Math.log(seconds / targetSeconds));
        }
      }
      if (cost < costs[end]) {
        costs[end] = cost;
        previous[end] = start;
      }
    }
  }

  if (previous[count] < 0) {
    throw new Error("Adaptive: не удалось построить непрерывное разбиение партитуры.");
  }
  const ranges: Array<[number, number]> = [];
  for (let end = count; end > 0; ) {
    const start = previous[end];
    ranges.push([start, end - 1]);
    end = start;
  }
  ranges.reverse();
  const mergedRanges = mergeMicroRanges(ranges, measures, maxSpan, slowTempoBpm);
  // Заголовки короткие и на английском: Piano Marvel — англоязычный сервис, а причина
  // границы всё равно видна в логе плана, в названии упражнения она только мешает.
  return mergedRanges.map(([start, end], index) => {
    const first = measures[start];
    const last = measures[end];
    return exercise(
      `A${index + 1} (m. ${first.measure}-${last.measure})`,
      first.measure,
      last.measure,
      last.tickCount,
    );
  });
}

interface BridgeCandidate {
  anchorMeasure: number;
  phraseLabel?: string;
  expressive: boolean;
  tempoReset: boolean;
  vulnerability: number;
  /** Короткий ASCII-код типа перехода для заголовка упражнения. */
  kind?: string;
}

/**
 * Таксономия музыкальных переходов. Обязательные тренируются всегда: смена размера
 * и возобновление после остановки — координационные события, а навигационный прыжок
 * вообще не существует в печатном соседстве. Остальные включаются, если стык этой
 * партитуры действительно уязвим.
 */
const TRANSITION_KINDS: Array<{
  label: string;
  kind: string;
  mandatory: boolean;
}> = [
  { label: "смена размера", kind: "meter", mandatory: true },
  { label: "возобновление после остановки", kind: "stop", mandatory: true },
  { label: "модуляция", kind: "key", mandatory: false },
  { label: "смена ключа", kind: "hands", mandatory: false },
  { label: "смена регистра", kind: "hands", mandatory: false },
  { label: "смена ритмического деления", kind: "poly", mandatory: false },
  { label: "смена штриха", kind: "artic", mandatory: false },
  { label: "смена педализации", kind: "pedal", mandatory: false },
  { label: "арпеджио/глиссандо", kind: "tech", mandatory: false },
  { label: "вход в орнамент", kind: "orn", mandatory: false },
  { label: "смена плотности голосов", kind: "voices", mandatory: false },
  { label: "смена динамики", kind: "dyn", mandatory: false },
];

/** Уязвимость стыка: скачок нагрузки, перенос рук, смена фактуры и темпа. */
function junctionVulnerability(
  before: AdaptiveMeasureProfile | undefined,
  after: AdaptiveMeasureProfile | undefined,
): number {
  if (!before || !after) return 0;
  const speedChange = Math.abs(
    Math.log2(after.fastestNote / Math.max(1, before.fastestNote)),
  );
  const handShift =
    staffTransitionDistance(before.lastPitchByStaff, after.firstPitchByStaff) / 12;
  return (
    after.load +
    Math.abs(after.load - before.load) +
    after.maxLeap / 12 +
    Math.abs(after.voices - before.voices) * 0.7 +
    Math.abs(after.maxChordSize - before.maxChordSize) * 0.35 +
    handShift * 0.8 +
    speedChange * 0.5 +
    (after.registerShiftTransition ? 0.9 : 0) +
    (after.tempoTransitionLabels.length ? 1.2 : 0) -
    (before.hardBoundaryAfter ? 0.8 : 0)
  );
}

/**
 * Внутренние переходы, которые не совпали ни с одним стыком Phrase. Каждый получает
 * собственный Bridge, потому что это отдельный навык, а не часть фразы.
 */
function internalTransitionCandidates(
  measures: AdaptiveMeasureProfile[],
  context: MusicalContext,
  phraseAnchors: Set<number>,
): BridgeCandidate[] {
  // Порог уязвимости считается по всем стыкам тактов, а не по десяти стыкам Phrase:
  // на маленькой выборке медиана уезжает, и «значимым» оказывается каждый второй такт.
  const vulnerabilities = measures.map((measure, index) =>
    index === 0 ? 0 : junctionVulnerability(measures[index - 1], measure),
  );
  const center = median(vulnerabilities.slice(1));
  const deviation = median(
    vulnerabilities.slice(1).map((value) => Math.abs(value - center)),
  );
  const threshold = center + Math.max(0.1, deviation);
  const mandatory: BridgeCandidate[] = [];
  const optional: BridgeCandidate[] = [];
  const claimed = new Set<number>();
  for (const [index, measure] of measures.entries()) {
    if (index === 0 || phraseAnchors.has(measure.measure)) continue;
    const vulnerability = vulnerabilities[index];
    const significant = vulnerability >= threshold;
    const add = (kind: string, expressive: boolean, required: boolean) => {
      if (claimed.has(measure.measure)) return;
      claimed.add(measure.measure);
      (required ? mandatory : optional).push({
        anchorMeasure: measure.measure,
        expressive,
        tempoReset: measure.tempoReset,
        vulnerability,
        kind,
      });
    };
    if (
      context.navigation.discontinuityAfter[index - 1] ||
      context.navigation.landing[index]
    ) {
      add("nav", false, true);
    }
    if (measure.tempoTransitionLabels.length > 0) add("tempo", true, true);
    for (const entry of TRANSITION_KINDS) {
      if (!measure.transitionLabelsBefore.includes(entry.label)) continue;
      if (!entry.mandatory && !significant) continue;
      add(entry.kind, false, entry.mandatory);
    }
    if (measure.sectionBoundaryAfter >= 0.6 && significant) {
      add("texture", false, false);
    }
  }
  // Необязательные переходы — только самые уязвимые. Список упражнений остаётся
  // учебным маршрутом: шестьдесят переходов на двадцать фраз никто не проходит.
  const budget = Math.max(2, phraseAnchors.size);
  optional.sort((left, right) => right.vulnerability - left.vulnerability);
  return [...mandatory, ...optional.slice(0, budget)];
}

function buildBridgeChunks(
  phrases: SlicingExercise[],
  measures: AdaptiveMeasureProfile[],
  context: MusicalContext,
  measureByNumber: Map<number, AdaptiveMeasureProfile>,
  positionOf: Map<number, number>,
): SlicingExercise[] {
  if (phrases.length === 0 || measures.length === 0) return [];
  const phraseCandidates: BridgeCandidate[] = phrases.slice(0, -1).map((phrase, index) => {
    const next = phrases[index + 1];
    const before = measureByNumber.get(phrase.endMeasure);
    const after = measureByNumber.get(next.startMeasure);
    const vulnerability = junctionVulnerability(before, after);
    return {
      anchorMeasure: next.startMeasure,
      phraseLabel: `${index + 1}-${index + 2}`,
      expressive: Boolean(after?.tempoTransitionLabels.length),
      tempoReset: Boolean(after?.tempoReset),
      vulnerability,
    };
  });
  const center = median(phraseCandidates.map((candidate) => candidate.vulnerability));
  const deviation = median(
    phraseCandidates.map((candidate) => Math.abs(candidate.vulnerability - center)),
  );
  const phraseAnchors = new Set(phraseCandidates.map((item) => item.anchorMeasure));
  const internalCandidates = internalTransitionCandidates(
    measures,
    context,
    phraseAnchors,
  );
  const ranges = [...phraseCandidates, ...internalCandidates].map((candidate) => {
    const anchorIndex = positionOf.get(candidate.anchorMeasure) ?? -1;
    const contextSeconds =
      candidate.expressive ||
      candidate.vulnerability >= center + deviation * 0.5
        ? PEDAGOGY.expressiveBridgeContextSeconds
        : PEDAGOGY.bridgeContextSeconds;
    let startIndex = bridgeContextStart(measures, anchorIndex - 1, contextSeconds);
    if (candidate.tempoReset) {
      const gestureStart = precedingTempoGestureStart(measures, anchorIndex);
      const gestureLength = anchorIndex - gestureStart;
      // Короткий rit. учим целиком вместе с reset; у длинной дуги достаточно
      // последнего такта, чтобы Bridge не превращался во второй Review.
      startIndex =
        gestureLength > 0 && gestureLength <= 2
          ? gestureStart
          : Math.max(0, anchorIndex - 1);
    }
    let endIndex = bridgeContextEnd(
      measures,
      anchorIndex,
      contextSeconds,
    );
    if (
      candidate.expressive &&
      measures[anchorIndex].expressiveTempoContinuesAfter
    ) {
      endIndex = Math.min(
        measures.length - 1,
        Math.max(endIndex, anchorIndex + 1),
      );
    }
    return {
      ...candidate,
      start: measures[startIndex].measure,
      end: measures[endIndex].measure,
    };
  });
  // На каждом Phrase junction есть Bridge. Дополнительный внутренний tempo drill
  // схлопывается, если совпал с тем же музыкальным окном.
  const unique = new Map<string, (typeof ranges)[number]>();
  for (const range of ranges) {
    const key = `${range.start}:${range.end}`;
    const existing = unique.get(key);
    if (!existing || (!existing.phraseLabel && range.phraseLabel)) {
      unique.set(key, range);
    }
  }
  return [...unique.values()]
    .sort((left, right) => left.end - right.end || left.start - right.start)
    .map((range, index) => {
    const label = range.phraseLabel ?? `${range.kind ?? "T"}${index + 1}`;
    return exercise(
      `A.Bridge ${label} (m. ${range.start}-${range.end})`,
      range.start,
      range.end,
      measureByNumber.get(range.end)?.tickCount,
    );
  });
}

function bridgeContextStart(
  measures: AdaptiveMeasureProfile[],
  fromIndex: number,
  targetSeconds: number,
): number {
  let index = Math.max(0, fromIndex);
  let seconds = 0;
  let attacks = 0;
  let count = 0;
  while (index >= 0 && count < PEDAGOGY.maxBridgeContextMeasures) {
    seconds += measures[index].estSeconds;
    attacks += measures[index].attackCount;
    count += 1;
    if ((seconds > 0 ? seconds >= targetSeconds : attacks >= 6) && attacks >= 2) {
      break;
    }
    index -= 1;
  }
  return Math.max(0, index);
}

function bridgeContextEnd(
  measures: AdaptiveMeasureProfile[],
  fromIndex: number,
  targetSeconds: number,
): number {
  let index = Math.min(measures.length - 1, Math.max(0, fromIndex));
  let seconds = 0;
  let attacks = 0;
  let count = 0;
  while (index < measures.length && count < PEDAGOGY.maxBridgeContextMeasures) {
    seconds += measures[index].estSeconds;
    attacks += measures[index].attackCount;
    count += 1;
    if ((seconds > 0 ? seconds >= targetSeconds : attacks >= 6) && attacks >= 2) {
      break;
    }
    index += 1;
  }
  return Math.min(measures.length - 1, index);
}

function precedingTempoGestureStart(
  measures: AdaptiveMeasureProfile[],
  transitionIndex: number,
): number {
  let index = Math.max(0, transitionIndex - 1);
  while (index > 0 && measures[index - 1].expressiveTempoContinuesAfter) {
    index -= 1;
  }
  return index;
}

function staffTransitionDistance(
  before: Record<string, number>,
  after: Record<string, number>,
): number {
  const distances = Object.keys(after)
    .filter((staff) => before[staff] !== undefined)
    .map((staff) => Math.abs(after[staff] - before[staff]));
  return distances.length ? Math.max(...distances) : 0;
}

/**
 * Собирает фразы в обзорные упражнения — большие связные куски, которыми играется
 * вся композиция целиком (аналог Review в predict-режиме, но по нашим границам).
 *
 * Группа закрывается по структурной границе (конец повтора, двойная черта,
 * репетиционная метка), а если структура молчит — по лимиту фраз. Хвост никогда не
 * остаётся без обзора: последняя группа доклеивается к предыдущей, если в ней
 * осталась одна фраза. Обзоры идут подряд и вместе покрывают партитуру от первого
 * до последнего такта.
 */
function buildReviewChunks(
  phrases: SlicingExercise[],
  measures: AdaptiveMeasureProfile[],
  context: MusicalContext,
  measureByNumber: Map<number, AdaptiveMeasureProfile>,
  positionOf: Map<number, number>,
): SlicingExercise[] {
  if (phrases.length < 2) return [];
  const hardAfter = new Set(
    measures.filter((measure) => measure.hardBoundaryAfter).map((measure) => measure.measure),
  );
  // Обзор собирается по разделам формы, а не по счётчику фраз: если повторность и
  // новизна показали конец куплета, обзор закрывается там, даже без метки в файле.
  const sectionEnds = new Set(
    context.structure.sections.map(
      (section) => measures[section.end]?.measure ?? -1,
    ),
  );

  const groups: SlicingExercise[][] = [];
  let current: SlicingExercise[] = [];
  let currentSeconds = 0;
  const prefixSeconds = buildPrefix(measures, (measure) => measure.estSeconds);
  const phraseSeconds = (phrase: SlicingExercise) =>
    rangeFromPrefix(
      prefixSeconds,
      positionOf,
      phrase.startMeasure,
      phrase.endMeasure,
    );
  for (const [index, phrase] of phrases.entries()) {
    current.push(phrase);
    currentSeconds += phraseSeconds(phrase);
    const next = phrases[index + 1];
    const currentMeasures =
      phrase.endMeasure - current[0].startMeasure + 1;
    const structural =
      (hardAfter.has(phrase.endMeasure) || sectionEnds.has(phrase.endMeasure)) &&
      current.length >= 2 &&
      currentMeasures >= PEDAGOGY.minReviewMeasures;
    const nextWouldOverflow =
      current.length >= 2 &&
      next !== undefined &&
      (currentSeconds + phraseSeconds(next) > PEDAGOGY.maxReviewSeconds ||
        next.endMeasure - current[0].startMeasure + 1 > PEDAGOGY.maxReviewMeasures);
    if (
      structural ||
      current.length >= PEDAGOGY.maxReviewPhrases ||
      nextWouldOverflow
    ) {
      groups.push(current);
      current = [];
      currentSeconds = 0;
    }
  }
  if (current.length === 1 && groups.length > 0) {
    const previous = groups[groups.length - 1];
    if (previous.length > 2) {
      current.unshift(previous.pop()!);
      groups.push(current);
    } else {
      previous.push(current[0]);
    }
  } else if (current.length > 0) {
    groups.push(current);
  }
  // После структурного закрытия короткий хвост может состоять из двух небольших
  // Phrase и формально пройти правило `>= 2 phrases`, оставшись всего на 6–7 тактов.
  // Переносим сюда целые фразы из предыдущей группы; если донор сам станет слишком
  // коротким, объединяем оба обзора. Ни одна граница Phrase при этом не режется.
  for (let index = groups.length - 1; index > 0; index -= 1) {
    const span = (group: SlicingExercise[]) =>
      group.at(-1)!.endMeasure - group[0].startMeasure + 1;
    if (span(groups[index]) >= PEDAGOGY.minReviewMeasures) continue;
    const previous = groups[index - 1];
    while (
      span(groups[index]) < PEDAGOGY.minReviewMeasures &&
      previous.length > 2
    ) {
      const withoutLast = previous.slice(0, -1);
      if (span(withoutLast) < PEDAGOGY.minReviewMeasures) break;
      groups[index].unshift(previous.pop()!);
    }
    if (span(groups[index]) < PEDAGOGY.minReviewMeasures) {
      previous.push(...groups[index]);
      groups.splice(index, 1);
    }
  }
  return groups.map((group, index) => {
    const start = group[0].startMeasure;
    const end = group[group.length - 1].endMeasure;
    return exercise(
      `A.Review ${index + 1} (m. ${start}-${end})`,
      start,
      end,
      measureByNumber.get(end)?.tickCount,
    );
  });
}

/**
 * Финальная сборка перед Whole: три непрерывные крупные части. Обе границы
 * выбираются совместно только между Phrase. Оптимизатор держит каждую часть в
 * разумном диапазоне 18–48% общей длительности, но может отойти от точной трети
 * ради rehearsal/повтора/двойной черты и избегает вынужденного cut внутри tie.
 */
function buildSummaryChunks(
  phrases: SlicingExercise[],
  measures: AdaptiveMeasureProfile[],
  context: MusicalContext,
  measureByNumber: Map<number, AdaptiveMeasureProfile>,
  positionOf: Map<number, number>,
): SlicingExercise[] {
  if (phrases.length < 3) return [];
  const prefixMeasureWeight = buildPrefix(
    measures,
    (measure) => measure.estSeconds > 0 ? measure.estSeconds : measure.quarterBeats,
  );
  const prefix = [0];
  for (const phrase of phrases) {
    const weight = rangeFromPrefix(
      prefixMeasureWeight,
      positionOf,
      phrase.startMeasure,
      phrase.endMeasure,
    );
    prefix.push(prefix[prefix.length - 1] + Math.max(Number.EPSILON, weight));
  }
  const total = prefix.at(-1) ?? 0;
  const minimumPhrases = phrases.length >= 6 ? 2 : 1;
  let best: { first: number; second: number; cost: number } | undefined;

  for (let first = minimumPhrases; first <= phrases.length - minimumPhrases * 2; first += 1) {
    for (
      let second = first + minimumPhrases;
      second <= phrases.length - minimumPhrases;
      second += 1
    ) {
      const shares = [
        prefix[first] / total,
        (prefix[second] - prefix[first]) / total,
        (total - prefix[second]) / total,
      ];
      if (shares.some((share) => share < 0.18 || share > 0.48)) continue;
      const firstBoundary = measureByNumber.get(phrases[first - 1].endMeasure);
      const secondBoundary = measureByNumber.get(phrases[second - 1].endMeasure);
      const boundaryBenefit = [firstBoundary, secondBoundary].reduce(
        (sum, boundary) =>
          sum +
          Math.min(PEDAGOGY.hardBoundaryScore, boundary?.boundaryScoreAfter ?? 0) *
            0.08 +
          (boundary?.hardBoundaryAfter ? 0.45 : 0) +
          // Шов формы важнее арифметической трети: в Gymnopédie настоящая граница
          // половин — такт 39/40, и часть не должна проезжать её насквозь.
          (boundary?.sectionBoundaryAfter ?? 0) * 1.1 +
          (boundary?.closureAfter ?? 0) * 0.5 -
          (boundary?.forbiddenAfter ? 1.4 : 0) -
          insideRepeatPenalty(boundary, positionOf, context) -
          (boundary?.dynamicGestureContinuesAfter ? 0.7 : 0) -
          (boundary?.melodicSlurContinuesAfter ? 0.45 : 0),
        0,
      );
      const balanceCost =
        shares.reduce((sum, share) => sum + (share - 1 / 3) ** 2, 0) * 30;
      const cost = balanceCost - boundaryBenefit;
      if (!best || cost < best.cost) best = { first, second, cost };
    }
  }

  // При крайне неравномерных Phrase (редкий короткий MusicXML) безопаснее взять
  // ближайшие доступные границы к третям, чем резать внутри уже выверенной фразы.
  if (!best) {
    let fallbackCost = Number.POSITIVE_INFINITY;
    for (let first = 1; first < phrases.length - 1; first += 1) {
      for (let second = first + 1; second < phrases.length; second += 1) {
        const cost =
          Math.abs(prefix[first] / total - 1 / 3) +
          Math.abs(prefix[second] / total - 2 / 3);
        if (cost < fallbackCost) {
          fallbackCost = cost;
          best = { first, second, cost };
        }
      }
    }
  }
  if (!best) return [];

  const groups = [
    phrases.slice(0, best.first),
    phrases.slice(best.first, best.second),
    phrases.slice(best.second),
  ];
  return groups.map((group, index) => {
    const start = group[0].startMeasure;
    const end = group.at(-1)!.endMeasure;
    return exercise(
      `A.Summarize ${index + 1}/3 (m. ${start}-${end})`,
      start,
      end,
      measureByNumber.get(end)?.tickCount,
    );
  });
}

/**
 * Разрыв дословно повторяющегося блока: часть Summarize, которая начинается внутри
 * повтора, разрезает уже цельный музыкальный блок.
 */
function insideRepeatPenalty(
  boundary: AdaptiveMeasureProfile | undefined,
  positionOf: Map<number, number>,
  context: MusicalContext,
): number {
  if (!boundary) return 0;
  const index = positionOf.get(boundary.measure);
  if (index === undefined) return 0;
  return context.structure.insideRepeatBlock[index + 1] ? 1.2 : 0;
}

/** Индекс номера такта к профилю строится один раз на весь план. */
function indexMeasures(
  measures: AdaptiveMeasureProfile[],
): Map<number, AdaptiveMeasureProfile> {
  return new Map(measures.map((measure) => [measure.measure, measure]));
}

/** Отдельный индекс нужен там, где алгоритм обращается к соседней позиции массива. */
function indexPositions(
  measures: AdaptiveMeasureProfile[],
): Map<number, number> {
  return new Map(measures.map((measure, index) => [measure.measure, index]));
}

/** Префиксные суммы: сумма [from, toExclusive) равна разности двух элементов. */
export function buildPrefix<T>(
  values: T[],
  value: (item: T, index: number) => number,
): number[] {
  const prefix = [0];
  for (const [index, item] of values.entries()) {
    prefix.push(prefix[prefix.length - 1] + value(item, index));
  }
  return prefix;
}

function rangeFromPrefix(
  prefix: number[],
  positionOf: Map<number, number>,
  startMeasure: number,
  endMeasure: number,
): number {
  const from = positionOf.get(startMeasure);
  const to = positionOf.get(endMeasure);
  if (from === undefined || to === undefined) return 0;
  return prefix[to + 1] - prefix[from];
}

/**
 * Собирает единый список Chopped из четырёх педагогических уровней.
 *
 * `score` — исторический порядок: всё сортируется по позиции в нотах, поэтому
 * список читается как партитура. Он единственный удовлетворяет наблюдавшемуся
 * ограничению Piano Marvel «строка с меньшим концом такта после строки с большим
 * концом не отображается»: `endMeasure` монотонно не убывает.
 *
 * `stage` — учебная лестница: сперва ВСЕ отрезки, затем ВСЕ мостики, затем обзоры
 * и трети; внутри уровня по-прежнему порядок партитуры. Мостик тренируется, когда
 * обе его стороны уже разобраны, а не разрывает разбор посередине. Монотонность
 * `endMeasure` при этом нарушается намеренно: если Piano Marvel действительно
 * прячет такие строки, verifyExercisesVisible сообщит об этом явно, а откат
 * выполняется переключением порядка обратно на `score`.
 *
 * Дедупликация идёт по уже собранному порядку, поэтому при совпадении диапазона и
 * заголовка выживает экземпляр более раннего уровня.
 */
function orderChunks(
  order: AdaptiveChunkOrder,
  stages: {
    phraseChunks: SlicingExercise[];
    bridgeChunks: SlicingExercise[];
    reviewChunks: SlicingExercise[];
    summaryChunks: SlicingExercise[];
  },
): SlicingExercise[] {
  const { phraseChunks, bridgeChunks, reviewChunks, summaryChunks } = stages;
  if (order === "stage") {
    return deduplicateExercises([
      ...sortByScorePosition(phraseChunks),
      ...sortByScorePosition(bridgeChunks),
      ...sortByScorePosition(reviewChunks),
      ...sortByScorePosition(summaryChunks),
    ]);
  }
  return sortByScorePosition(
    deduplicateExercises([
      ...phraseChunks,
      ...bridgeChunks,
      ...reviewChunks,
      ...summaryChunks,
    ]),
  );
}

/** Список читается сверху вниз как партитура: по концу такта, короткое перед длинным. */
function sortByScorePosition(exercises: SlicingExercise[]): SlicingExercise[] {
  return [...exercises].sort((left, right) => {
    if (left.endMeasure !== right.endMeasure) return left.endMeasure - right.endMeasure;
    const leftSpan = left.endMeasure - left.startMeasure;
    const rightSpan = right.endMeasure - right.startMeasure;
    if (leftSpan !== rightSpan) return leftSpan - rightSpan;
    return left.startMeasure - right.startMeasure;
  });
}

function deriveTargetSpan(
  measures: AdaptiveMeasureProfile[],
  context: MusicalContext,
): number {
  const structural = measures
    .map((measure, index) => ({ measure, index }))
    .filter(({ measure }) => measure.boundaryScoreAfter >= PEDAGOGY.phraseBoundaryScore)
    .map(({ index }) => index + 1);
  const points = [0, ...structural, measures.length]
    .filter((value, index, values) => index === 0 || value !== values[index - 1]);
  // Несколько XML-событий в соседних тактах (hairpin arrival → новая dynamic →
  // tempo reset) образуют одну boundary zone, а не период пьесы в один такт.
  const distances = points
    .slice(1)
    .map((point, index) => point - points[index])
    .filter((distance) => distance >= PEDAGOGY.minPhraseMeasures);
  const inferred = distances.length ? median(distances) : PEDAGOGY.fallbackPhraseMeasures;
  const { period, confidence } = context.structure.hypermeter;
  const limit = Math.max(6, Math.min(8, period * 2));
  // Один двухтактовый период — это «основная мысль», а не фраза: цель не может быть
  // короче учебного минимума, иначе на медленной музыке Phrase распадается на
  // двухтактовые обрывки. Но и удваивать уже найденный четырёхтактовый период нельзя.
  const floor = Math.min(limit, PEDAGOGY.fallbackPhraseMeasures);
  const bounded = Math.max(floor, Math.min(limit, Math.round(inferred)));
  // Естественная длина фразы кратна периоду пьесы: в Clocks это 4 и 8 тактов, а не 5
  // и не 7. Округляем к ближайшему кратному, если период определён уверенно.
  if (confidence < 0.3 || period <= 1) return bounded;
  const multiples = [period, period * 2, period * 3, period * 4].filter(
    (value) => value >= floor && value <= limit,
  );
  if (multiples.length === 0) return bounded;
  return multiples.reduce((best, value) =>
    Math.abs(value - bounded) < Math.abs(best - bounded) ? value : best,
  );
}

/**
 * Суммарная «весомость» пересечённых швов формы. Квадрат силы разводит уверенные
 * улики и слабые: пересечь выписанную репризу гораздо хуже, чем нечёткий возврат
 * материала, который подтверждается только сходством усреднённых окон.
 */
/**
 * Верхняя граница длины фрагмента (в тактах) для окна DP-оптимизатора. Без темпа —
 * прежний фиксированный потолок. С темпом — расширяем его, если музыка настолько
 * медленная, что PEDAGOGY.maxPhraseMeasures тактов заведомо короче maxChunkSeconds
 * (иначе на очень медленных пьесах отрезки будут короче целевых секунд без
 * возможности это исправить), но не выше абсолютного потолка в 16 тактов.
 */
function deriveMaxSpan(measures: AdaptiveMeasureProfile[], slowTempoBpm?: number): number {
  if (!slowTempoBpm) return PEDAGOGY.maxPhraseMeasures;
  const seconds = measures.map((measure) => measure.estSeconds).filter((value) => value > 0);
  const avgSeconds = seconds.length ? median(seconds) : 0;
  if (avgSeconds <= 0) return PEDAGOGY.maxPhraseMeasures;
  // floor, а не round: округление вверх позволяло фрагменту превысить maxChunkSeconds.
  const byDuration = Math.floor(PEDAGOGY.maxChunkSeconds / avgSeconds);
  // На очень медленной музыке потолок в тактах обязан опускаться ниже
  // maxPhraseMeasures: восемь тактов Adagio при Slow = 31 BPM это 62 секунды, то есть
  // не учебный фрагмент, а полноценный обзор.
  return Math.max(
    PEDAGOGY.minPhraseMeasures,
    Math.min(Math.max(PEDAGOGY.maxPhraseMeasures, 16), Math.max(1, byDuration)),
  );
}

/**
 * Убирает формально корректные, но бесполезные для обучения микрофразы возле
 * повторов, вольт и коротких смен метра. Пересекается более слабая из соседних
 * границ; при равной силе выбирается результат ближе к целевой длительности.
 */
function mergeMicroRanges(
  source: Array<[number, number]>,
  measures: AdaptiveMeasureProfile[],
  maxSpan: number,
  slowTempoBpm?: number,
): Array<[number, number]> {
  const ranges = source.map((range) => [...range] as [number, number]);
  if (ranges.length < 2) return ranges;

  const seconds = (range: [number, number]) =>
    measures
      .slice(range[0], range[1] + 1)
      .reduce((sum, measure) => sum + measure.estSeconds, 0);
  const span = (range: [number, number]) => range[1] - range[0] + 1;
  const isMicro = (range: [number, number]) => {
    return (
      span(range) < PEDAGOGY.minPhraseMeasures ||
      Boolean(
        slowTempoBpm &&
          seconds(range) + Number.EPSILON < PEDAGOGY.minStandaloneChunkSeconds,
      )
    );
  };
  const mergeCost = (
    left: [number, number],
    right: [number, number],
    boundaryIndex: number,
  ) => {
    const merged: [number, number] = [left[0], right[1]];
    const duration = seconds(merged);
    const durationPenalty = slowTempoBpm
      ? Math.abs(duration - (PEDAGOGY.minChunkSeconds + PEDAGOGY.maxChunkSeconds) / 2) * 0.04 +
        Math.max(0, duration - PEDAGOGY.maxChunkSeconds) * 0.25
      : 0;
    const endingBelongsToLeadIn = measures[boundaryIndex].boundaryReasonsAfter.includes(
      "начало вариантной вольты",
    );
    return (
      measures[boundaryIndex].boundaryScoreAfter +
      durationPenalty +
      // Склейка через разрыв исполнения запрещена так же, как разрез внутри жеста:
      // иначе устранение микрофразы возвращало бы в упражнение несуществующую
      // последовательность вольт.
      (measures[boundaryIndex].navigationBreakAfter
        ? PEDAGOGY.navigationCrossPenalty
        : 0) -
      (endingBelongsToLeadIn ? PEDAGOGY.hardBoundaryScore * 2 : 0)
    );
  };

  /**
   * Если склейка микрофрагмента с соседом выходит за учебное окно, границу не
   * склеивают, а переносят: объединённый отрезок делится в самом сильном месте, где
   * обе половины остаются самостоятельными. Иначе двухтактовый хвост раздувал
   * соседнюю фразу до 18 тактов вместо честного 9 + 9.
   */
  const rebalance = (
    left: [number, number],
    right: [number, number],
  ): [[number, number], [number, number]] | undefined => {
    const from = left[0];
    const to = right[1];
    let best: { split: number; score: number } | undefined;
    for (let split = from; split < to; split += 1) {
      const head: [number, number] = [from, split];
      const tail: [number, number] = [split + 1, to];
      if (isMicro(head) || isMicro(tail)) continue;
      if (span(head) > maxSpan || span(tail) > maxSpan) continue;
      const score =
        measures[split].boundaryScoreAfter +
        measures[split].closureAfter * 4 -
        (measures[split].forbiddenAfter ? 6 : 0);
      if (!best || score > best.score) best = { split, score };
    }
    return best ? [[from, best.split], [best.split + 1, to]] : undefined;
  };

  for (let index = 0; index < ranges.length; ) {
    if (!isMicro(ranges[index])) {
      index += 1;
      continue;
    }
    const neighbour = index === 0 ? ranges[1] : ranges[index - 1];
    if (
      neighbour &&
      span([
        Math.min(ranges[index][0], neighbour[0]),
        Math.max(ranges[index][1], neighbour[1]),
      ]) > maxSpan
    ) {
      const [left, right] =
        index === 0 ? [ranges[index], neighbour] : [neighbour, ranges[index]];
      const balanced = rebalance(left, right);
      if (balanced) {
        const target = index === 0 ? 0 : index - 1;
        ranges.splice(target, 2, balanced[0], balanced[1]);
        index = Math.max(0, target);
        if (!isMicro(ranges[index])) index += 1;
        continue;
      }
    }
    if (index === 0) {
      ranges[1] = [ranges[0][0], ranges[1][1]];
      ranges.splice(0, 1);
      continue;
    }
    if (index === ranges.length - 1) {
      ranges[index - 1] = [ranges[index - 1][0], ranges[index][1]];
      ranges.splice(index, 1);
      index = Math.max(0, index - 1);
      continue;
    }

    const leftIsMicro = isMicro(ranges[index - 1]);
    const rightIsMicro = isMicro(ranges[index + 1]);
    // Цепочку коротких кандидатов сначала собираем в самостоятельный Phrase.
    // Иначе каждый следующий двухтактовый кусок выгоднее приклеивался к уже
    // полноценному левому соседу и на быстрых размерах 3/8 раздувал его до 20–30 тактов.
    const breaksRight = measures[ranges[index][1]]?.navigationBreakAfter ?? false;
    const breaksLeft = measures[ranges[index][0] - 1]?.navigationBreakAfter ?? false;
    if (breaksRight !== breaksLeft) {
      // Одна из сторон отделена разрывом исполнения — склеиваем только с другой.
      const target = breaksRight ? index - 1 : index + 1;
      if (target >= 0 && target < ranges.length) {
        const merged: [number, number] = [
          Math.min(ranges[index][0], ranges[target][0]),
          Math.max(ranges[index][1], ranges[target][1]),
        ];
        ranges.splice(Math.min(index, target), 2, merged);
        index = Math.max(0, Math.min(index, target));
        continue;
      }
    }
    if (!leftIsMicro && rightIsMicro) {
      ranges[index + 1] = [ranges[index][0], ranges[index + 1][1]];
      ranges.splice(index, 1);
      continue;
    }
    if (leftIsMicro && !rightIsMicro) {
      ranges[index - 1] = [ranges[index - 1][0], ranges[index][1]];
      ranges.splice(index, 1);
      index = Math.max(0, index - 1);
      continue;
    }

    const leftCost = mergeCost(ranges[index - 1], ranges[index], ranges[index][0] - 1);
    const rightCost = mergeCost(ranges[index], ranges[index + 1], ranges[index][1]);
    if (leftCost <= rightCost) {
      ranges[index - 1] = [ranges[index - 1][0], ranges[index][1]];
      ranges.splice(index, 1);
      index = Math.max(0, index - 1);
    } else {
      ranges[index + 1] = [ranges[index][0], ranges[index + 1][1]];
      ranges.splice(index, 1);
    }
  }
  return ranges;
}

/**
 * staffs шлём пустым: реальную длину (в живом Save это 8 элементов, а не 2) знает только
 * страница Piano Marvel, поэтому learning-adaptive-page подставляет её из фактического
 * запроса, а не из нашей догадки.
 */
function exercise(
  title: string,
  startMeasure: number,
  endMeasure: number,
  endTick?: number,
): SlicingExercise {
  return { title, startMeasure, endMeasure, staffs: [], startTick: 1, endTick };
}

function deduplicateExercises(exercises: SlicingExercise[]): SlicingExercise[] {
  const seen = new Set<string>();
  return exercises.filter((item) => {
    // Одинаковый диапазон допустим для разных педагогических уровней: например
    // A.Review 4 и A.Summarize 3/3 могут оба охватывать последние 16 тактов.
    const key = `${item.startMeasure}:${item.endMeasure}:${item.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Транспозиционно-инвариантный одноголосный отпечаток: интервалы + ритм. */
function motifFingerprint(notes: NoteEvent[]): string {
  const pitches = notes
    .map((note) => note.midi)
    .filter((pitch): pitch is number => pitch !== undefined);
  if (pitches.length === 0) return "";
  const intervals = pitches
    .slice(1)
    .map((pitch, index) => pitch - pitches[index])
    .join(",");
  const rhythm = notes
    .map((note) => {
      const type = note.type;
      if (type === "whole" || type === "half") return "long";
      if (type === "quarter") return "pulse";
      if (type === "eighth") return "subdivision";
      return type || "?";
    })
    .join(",");
  return `${pitches.length}:${intervals}|${rhythm}`;
}

/**
 * Одного совпавшего такта недостаточно: остинато иначе объявляло бы «возврат
 * мотива» на каждой границе. Ищем повтор двухтактового окна с дистанцией >= 4.
 */
function findRepeatedMotiveStarts(raw: RawMeasureProfile[]): Set<number> {
  const result = new Set<number>();
  const firstSeen = new Map<string, number>();
  for (let index = 0; index < raw.length - 1; index += 1) {
    const left = raw[index].signature;
    const right = raw[index + 1].signature;
    if (!left || !right) continue;
    const key = `${left}||${right}`;
    const previous = firstSeen.get(key);
    if (previous !== undefined && index - previous >= 4) {
      // Однотонный/длинный pickup непосредственно перед узнаваемым возвратом
      // принадлежит началу нового блока. Границу переносим перед pickup, не
      // привязываясь к номеру такта или конкретной пьесе.
      const start =
        index > 0 && raw[index - 1].attackCount <= 1
          ? index - 1
          : index;
      result.add(start);
    } else if (previous === undefined) {
      firstSeen.set(key, index);
    }
  }
  return result;
}

/**
 * Проверяет именно последнюю музыкальную позицию каждого staff/voice. Tie,
 * за которым в том же голосе есть другая атака или пауза, barline не пересекает.
 */
function hasTieAcrossMeasure(measure: MeasureNotes): boolean {
  const lastByStream = new Map<string, { onset: number; tieStart: boolean }>();
  for (const note of measure.events) {
    if (note.grace) continue;
    const previous = lastByStream.get(note.stream);
    if (note.chord && previous?.onset === note.onset) {
      previous.tieStart ||= !note.rest && note.tieStart;
    } else {
      lastByStream.set(note.stream, {
        onset: note.onset,
        tieStart: !note.rest && note.tieStart,
      });
    }
  }
  return [...lastByStream.values()].some((event) => event.tieStart);
}

function expressiveDynamicLabel(words: string): string | undefined {
  const normalized = stripTags(words).toLowerCase().replace(/\s+/g, " ").trim();
  if (/\bcresc(?:\.|\b)|\bcrescendo\b/.test(normalized)) return "crescendo";
  if (/\bdim(?:\.|\b)|\bdiminuendo\b|\bdecresc(?:\.|\b)|\bdecrescendo\b/.test(normalized)) {
    return "diminuendo";
  }
  return undefined;
}

/** Новая устойчивая tempo-region; gradual gestures классифицируются отдельно. */
function tempoRegionLabel(words: string): string | undefined {
  const normalized = stripTags(words)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(
    /\b(più\s+mosso|piu\s+mosso|meno\s+mosso|doppio\s+movimento|tempo\s+giusto|largo|lento|lent|adagio|andante|moderato|allegretto|allegro|vivace|presto|prestissimo|animato|agitato|maestoso)\b/,
  );
  return match?.[1];
}

function dynamicLevel(body: string): number | undefined {
  const match = body.match(
    /<(pppp|ppp|pp|p|mp|mf|f|ff|fff|ffff|sf|sfp|sfz|fp|fz)(?=\s|\/|>)/i,
  );
  if (!match) return undefined;
  return (
    {
      pppp: 0,
      ppp: 1,
      pp: 2,
      p: 3,
      mp: 4,
      mf: 5,
      f: 6,
      ff: 7,
      fff: 8,
      ffff: 9,
      sf: 7,
      sfp: 6,
      sfz: 7,
      fp: 5,
      fz: 7,
    } as Record<string, number>
  )[match[1].toLowerCase()];
}

/**
 * Дубли внутри одной смысловой категории насыщаются через max. Поэтому десяток
 * slur-stop не сильнее согласия независимых form + tempo + cadence признаков.
 */
function combineBoundarySignals(signals: BoundarySignal[]): number {
  const grouped = new Map<string, number>();
  for (const item of signals) {
    const reason = item.reason.toLowerCase();
    const category =
      item.hard ||
      /репетицион|повтор|вольт|тактова|формальн|навигац|раздел|шов формы/.test(reason)
        ? "form"
        : /каденци/.test(reason)
          ? "cadence"
          : /темп|tempo|rall|ritard|acceler|allarg|stringendo|rubato|calando|smorzando/.test(
                reason,
              )
            ? "tempo"
            : /фермат|цезур|дыхани|лиг|пауз/.test(reason)
              ? "phrase"
              : /рельеф/.test(reason)
                ? "melodic"
                : /педал/.test(reason)
                  ? "pedal"
                  : /динамик|crescendo|diminuendo/.test(reason)
                    ? "dynamic"
                    : /мотив/.test(reason)
                      ? "motive"
                      : /нагруз/.test(reason)
                        ? "motor"
                        : "metric";
    grouped.set(category, Math.max(grouped.get(category) ?? 0, item.score));
  }
  return [...grouped.values()].reduce((sum, score) => sum + score, 0);
}

function expressiveTempoLabel(words: string): string | undefined {
  const normalized = stripTags(words).toLowerCase().replace(/\s+/g, " ").trim();
  if (/\brall\.|\brallentando\b/.test(normalized)) return "rallentando";
  if (/\brit\.|\britardando\b|\britenuto\b/.test(normalized)) {
    return "ritardando";
  }
  if (/\baccel\.|\baccelerando\b/.test(normalized)) return "accelerando";
  if (/\ballarg\.|\ballargando\b/.test(normalized)) return "allargando";
  if (/\bstringendo\b/.test(normalized)) return "stringendo";
  if (/\brubato\b/.test(normalized)) return "rubato";
  if (/\bcalando\b/.test(normalized)) return "calando";
  if (/\bsmorzando\b|\bmorendo\b/.test(normalized)) return "smorzando";
  return undefined;
}

function isTempoReset(words: string): boolean {
  const normalized = stripTags(words)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return (
    /\ba\s+tempo\b/.test(normalized) ||
    /\bin\s+tempo\b/.test(normalized) ||
    /\btempo\s+(?:primo|i|1)\b/.test(normalized) ||
    /\bl'istesso\s+tempo\b/.test(normalized)
  );
}

function attributeValue(attributes: string, attribute: string): string {
  let pattern = attributePatterns.get(attribute);
  if (!pattern) {
    pattern = new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i");
    attributePatterns.set(attribute, pattern);
  }
  const match = attributes.match(pattern);
  return match?.[1]?.trim() ?? "";
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

function tagValue(xml: string, tag: string): string {
  let pattern = tagValuePatterns.get(tag);
  if (!pattern) {
    pattern = new RegExp(
      `<${tag}(?=\\s|>)[^>]*>([\\s\\S]*?)<\\/${tag}>`,
      "i",
    );
    tagValuePatterns.set(tag, pattern);
  }
  const match = xml.match(pattern);
  return match?.[1] ? stripTags(match[1]) : "";
}

function signal(score: number, reason: string, hard = false): BoundarySignal {
  return { score, reason, hard };
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
