/**
 * Метрики музыкального качества плана Adaptive.
 *
 * Инварианты Piano Marvel (непрерывность, покрытие, три Summarize) проверяет
 * `adaptive-corpus-audit.ts`. Здесь измеряется другое: насколько разбиение
 * музыкально. Без этих чисел «стало лучше» — вопрос вкуса, а не проверяемое
 * утверждение.
 *
 * Ориентиры (см. docs/adaptive-learning-prd.md):
 *   M1 closureRate         ≥ 0.80   границы Phrase совпадают с закрытием
 *   M2 hypermeterAlignment ≥ 0.85   границы попадают на гиперметрическую опору
 *   M3 sectionRecall       = 1.00   каждый шов формы является границей Phrase
 *   M4 durationCv          ≤ 0.35   длительности Phrase внутри пьесы однородны
 *   M5 forcedCutRate       ≤ 0.02   границ внутри tie/жеста почти нет
 *   M6 navigationBreaks    = 0      упражнения не пересекают разрыв исполнения
 *   M7 boundaryPrecision   = 1.00   все границы допустимы по экспертной аннотации
 *      mandatoryRecall     = 1.00   обязательные границы аннотации присутствуют
 */

import type { AdaptiveLearningPlan } from "./adaptive-learning";
import type { SlicingExercise } from "./learning-plan";

export interface GroundTruth {
  /** Границы, которые обязаны присутствовать (номер такта, после которого разрез). */
  mandatory: number[];
  /** Полный список музыкально допустимых границ. */
  permissible: number[];
  /**
   * Диапазон тактов, для которого аннотация полна. Границы вне него не судятся:
   * аннотировать имеет смысл только то, в чём есть уверенность.
   */
  scope?: { from: number; to: number };
  /** Откуда взята аннотация: без этого её нельзя проверить и оспорить. */
  note: string;
}

export interface QualityMetrics {
  phrases: number;
  hypermeter: string;
  closureRate: number;
  /** null, если период выведен неуверенно и требовать выравнивания нельзя. */
  hypermeterAlignment: number | null;
  sectionRecall: number | null;
  durationCv: number;
  forcedCutRate: number;
  /** Phrase, пересекающие разрыв порядка исполнения: обязано быть нулём. */
  navigationBreaks: number;
  /** Bridge, специально накрывающие такой разрыв: это норма, а не нарушение. */
  navigationBridges: number;
  boundaryPrecision: number | null;
  mandatoryRecall: number | null;
}

/** Порог, при котором закрытие такта считается состоявшимся. */
const CLOSURE_THRESHOLD = 0.45;
/** Ниже этой уверенности гиперметр не требует выравнивания границ. */
const HYPERMETER_CONFIDENCE = 0.5;
const SECTION_THRESHOLD = 0.6;
/** Допуск сравнения с аннотацией, в тактах. */
const BOUNDARY_TOLERANCE = 1;

export function measurePlanQuality(
  plan: AdaptiveLearningPlan,
  groundTruth?: GroundTruth,
): QualityMetrics {
  const measures = plan.measures;
  const byMeasure = new Map(measures.map((measure) => [measure.measure, measure]));
  const internalBoundaries = plan.phraseChunks
    .slice(0, -1)
    .map((chunk) => chunk.endMeasure);

  const closed = internalBoundaries.filter(
    (boundary) => (byMeasure.get(boundary)?.closureAfter ?? 0) >= CLOSURE_THRESHOLD,
  ).length;
  const aligned = internalBoundaries.filter(
    (boundary) => byMeasure.get(boundary + 1)?.hyperDownbeatBefore,
  ).length;
  // Вынужденным считается разрез внутри жеста, который в этой партитуре что-то
  // значит. Там, где tie переносится почти через каждую черту (педальная фактура
  // Another Love — 97 черт из 120), разрез внутри tie неизбежен и не является
  // дефектом разбиения.
  const tieMatters = plan.salience.tie >= 0.15;
  const forced = internalBoundaries.filter((boundary) => {
    const measure = byMeasure.get(boundary);
    if (!measure) return false;
    return (
      measure.expressiveTempoContinuesAfter || (tieMatters && measure.tiedIntoNext)
    );
  }).length;

  const seams = measures
    .filter(
      (measure) =>
        measure.sectionBoundaryAfter >= SECTION_THRESHOLD &&
        measure.measure !== measures.at(-1)?.measure,
    )
    .map((measure) => measure.measure);
  const phraseEnds = new Set(plan.phraseChunks.map((chunk) => chunk.endMeasure));
  const coveredSeams = seams.filter((seam) => phraseEnds.has(seam)).length;

  const durations = plan.phraseChunks.map((chunk) => chunkSeconds(plan, chunk));
  const meanDuration =
    durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length);
  const variance =
    durations.reduce((sum, value) => sum + (value - meanDuration) ** 2, 0) /
    Math.max(1, durations.length);
  const durationCv = meanDuration > 0 ? Math.sqrt(variance) / meanDuration : 0;

  const crossesBreak = (chunk: SlicingExercise) =>
    measures.some(
      (measure) =>
        measure.navigationBreakAfter &&
        measure.measure >= chunk.startMeasure &&
        measure.measure < chunk.endMeasure,
    );
  // Нарушение — это Phrase поверх разрыва исполнения. Bridge, наоборот, обязан его
  // накрывать, а Review и Summarize собирают партитуру целиком и пересекают репризы
  // по определению.
  const navigationBreaks = plan.phraseChunks.filter(crossesBreak).length;
  const navigationBridges = plan.bridgeChunks.filter(crossesBreak).length;

  // Допуск в один такт — не поблажка, а свойство материала: при фразовой элизии
  // каденция приходится на сильную долю такта, которым уже начинается следующая
  // фраза (Moonlight, m.9), и «правильных» ответов ровно два.
  const near = (values: number[], target: number) =>
    values.some((value) => Math.abs(value - target) <= BOUNDARY_TOLERANCE);
  const judged = groundTruth?.scope
    ? internalBoundaries.filter(
        (boundary) =>
          boundary >= (groundTruth.scope as { from: number }).from &&
          boundary <= (groundTruth.scope as { to: number }).to,
      )
    : internalBoundaries;
  const boundaryPrecision =
    groundTruth && groundTruth.permissible.length > 0 && judged.length > 0
      ? judged.filter((boundary) => near(groundTruth.permissible, boundary)).length /
        judged.length
      : null;
  const mandatoryRecall =
    groundTruth && groundTruth.mandatory.length > 0
      ? groundTruth.mandatory.filter((boundary) => near([...phraseEnds], boundary))
          .length / groundTruth.mandatory.length
      : null;

  return {
    phrases: plan.phraseChunks.length,
    hypermeter: `${plan.hypermeter.period}@${plan.hypermeter.phase} (${plan.hypermeter.confidence.toFixed(2)})`,
    closureRate: internalBoundaries.length
      ? round(closed / internalBoundaries.length, 3)
      : 1,
    hypermeterAlignment:
      plan.hypermeter.confidence >= HYPERMETER_CONFIDENCE && internalBoundaries.length
        ? round(aligned / internalBoundaries.length, 3)
        : null,
    sectionRecall: seams.length ? round(coveredSeams / seams.length, 3) : null,
    durationCv: round(durationCv, 3),
    forcedCutRate: internalBoundaries.length
      ? round(forced / internalBoundaries.length, 3)
      : 0,
    navigationBreaks,
    navigationBridges,
    boundaryPrecision: boundaryPrecision === null ? null : round(boundaryPrecision, 3),
    mandatoryRecall: mandatoryRecall === null ? null : round(mandatoryRecall, 3),
  };
}

function chunkSeconds(plan: AdaptiveLearningPlan, chunk: SlicingExercise): number {
  return plan.measures
    .filter(
      (measure) =>
        measure.measure >= chunk.startMeasure && measure.measure <= chunk.endMeasure,
    )
    .reduce((sum, measure) => sum + measure.estSeconds, 0);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
