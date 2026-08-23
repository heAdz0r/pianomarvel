import type { BrowserContext } from "playwright";
import {
  buildLearningPlan,
  calculateTempoProfile,
  hasCompleteHands,
  isCleanLearningBase, // CHANGED: сброс только там, где есть что удалять
  inferFastTempo,
  inferLearningStrategy,
  matchesTargetLearningMode,
  type LearningStep,
  type SlicingSnapshot,
  type SlicingTab,
} from "./learning-plan";
import {
  executeLearningStep,
  learningStepMessage,
  openSlicingTool,
  readSlicingSnapshot,
  waitForTabsHydrated,
  verifyExercisesVisible,
} from "./learning-page";
import { resetLearningMode } from "./learning-cleanup";
import { captureDiagnostics } from "./learning-diagnostics";
import { tlog } from "./log";
import { buildAdaptiveLearningPlan } from "./adaptive-learning";
// CHANGED: порядок учебного маршрута берётся из конфигурации, а не из умолчания модуля.
import { ADAPTIVE_CHUNK_ORDER } from "./learning-config";
import { measurePlanQuality } from "./adaptive-quality";
import type { LearningStrategy } from "./learning-strategy";
import type { LearningPlanOptions } from "./learning-plan";

/** Сводка плана Adaptive для интерфейса: без тяжёлых профилей всех тактов. */
export interface AdaptivePlanSummary {
  phrases: Array<{ start: number; end: number; title: string }>;
  bridges: number;
  reviews: number;
  summaries: number;
  hypermeter: { period: number; phase: number; confidence: number };
  sections: Array<{ start: number; end: number; label: string }>;
  quality: {
    closureRate: number;
    hypermeterAlignment: number | null;
    sectionRecall: number | null;
    durationCv: number;
    forcedCutRate: number;
    navigationBreaks: number;
  };
  warnings: string[];
  /** Причины границы для каждого конца Phrase: номер такта → список причин. */
  boundaryReasons: Record<number, string[]>;
}

export interface LearningStatus {
  pieceId: number;
  complete: boolean;
  classification: "ok" | "warning" | "missing";
  hasLearning: boolean;
  fastTempo: number;
  tempos: [number, number, number];
  tabs: Record<SlicingTab, { exercises: number; handsComplete: boolean }>;
  strategy: LearningStrategy | "unknown";
  /** Отсутствует у Predict и у старых записей кеша. */
  adaptive?: AdaptivePlanSummary;
}

export interface RunLearningOptions {
  strategy?: LearningStrategy;
  musicXmlPath?: string;
}

type ProgressReporter = (progress: number, message: string) => void;

/** Страница/контекст браузера погибли (крэш рендерера, закрытая вкладка). */
function isPageGone(error: unknown): boolean {
  return /Target page, context or browser has been closed|page has been closed|Execution context was destroyed|browser has been closed/i.test(
    String(error),
  );
}

/** Оставляет валидную схему без изменений, а WARN/NO полностью пересоздаёт по planner-алгоритму. */
export async function runLearningMode(
  context: BrowserContext,
  pieceId: number,
  report: ProgressReporter,
  options: RunLearningOptions = {},
): Promise<LearningStatus> {
  const logger = tlog();
  let page = await context.newPage();
  // Подняты из try: аварийная ветка перепроверяет схему теми же критериями, поэтому
  // ей нужны и темп, и параметры плана.
  let fastTempo = 0;
  let planOptions: LearningPlanOptions = { strategy: options.strategy ?? "predict" };
  try {
    report(3, "Открываю slicing tool");
    await logger.step("openSlicingTool", () => openSlicingTool(page, pieceId));
    let snapshot = await readSlicingSnapshot(page, pieceId);
    fastTempo = inferFastTempo(snapshot);
    planOptions = await resolvePlanOptions(snapshot, options, fastTempo);
    const initialStatus = summarizeStatus(pieceId, snapshot, fastTempo, planOptions);
    logger.info(`исходный статус: ${initialStatus.classification}, fastTempo=${fastTempo}`, initialStatus.tabs);
    // Сброс безусловный. Прежде он делался только при статусе не «ok», и это было
    // неверно: изменившийся музыкальный алгоритм даёт другие границы, а прежняя схема
    // формально остаётся «полной» — кнопка «Обновить» тогда ничего не переделывала.
    // Стоимость одного лишнего пересоздания меньше, чем риск оставить пьесу собранной
    // по устаревшей логике.
    // CHANGED: сброс безусловен только там, где есть что удалять. У свежей загрузки
    // схема уже пустая база (один двуручный Whole, пустые C/MIN), и reset на ней не
    // просто лишний — он падал, потому что Piano Marvel ещё не посчитал такты
    // (Whole приходит как 0-0) и шаблон Whole не проходил проверку диапазона.
    if (isCleanLearningBase(snapshot)) {
      logger.info("сброс не нужен: схема уже пустая база (один двуручный Whole, C/MIN пусты)");
      report(4, "Схема пуста — строю обучение с нуля");
    } else {
      report(4, "Удаляю старое обучение и создаю чистую схему");
      // CHANGED: число тактов из плана Adaptive чинит Whole, которому Piano Marvel не
      // посчитал диапазон (все упражнения приходят как 0-0). Для Predict его нет —
      // тогда reset честно откажется, а не запишет выдуманные границы.
      const wholeMeasures = planOptions.adaptiveChunks?.length
        ? Math.max(...planOptions.adaptiveChunks.map((chunk) => chunk.endMeasure))
        : undefined;
      await logger.step("resetLearningMode", () =>
        resetLearningMode(page, pieceId, fastTempo, report, wholeMeasures),
      );
      await logger.step("openSlicingTool (после сброса)", () => openSlicingTool(page, pieceId));
      snapshot = await readSlicingSnapshot(page, pieceId);
    }
    let steps = buildLearningPlan(snapshot, fastTempo, planOptions);
    logger.info(`план: ${steps.length} шагов`, steps.map(learningStepMessage));

    // План резюмируемый: buildLearningPlan всегда пересчитывает остаток от фактического
    // состояния. Поэтому гибель страницы (крэш рендерера на тяжёлых партитурах) — не
    // фатальна: открываем новую, перечитываем snapshot и продолжаем с места обрыва.
    // recoveries — счётчик попыток восстановления (как 4 клика у Predict), не тайминг.
    let done = 0;
    let recoveries = 0;
    while (steps.length > 0) {
      const step = steps[0];
      const total = done + steps.length;
      const start = 8 + Math.round((done / Math.max(1, total)) * 82);
      report(start, learningStepMessage(step));
      try {
        await logger.step(`шаг ${done + 1}/${total}: ${step.type} (${step.tab})`, () =>
          executeLearningStep(page, pieceId, step, report, start, total),
        );
        snapshot = await readSlicingSnapshot(page, pieceId);
        steps = steps.slice(1);
        done += 1;
      } catch (error) {
        if (!isPageGone(error) || recoveries >= 2) throw error;
        recoveries += 1;
        logger.warn(
          `страница браузера погибла на шаге ${step.type} (${step.tab}) — восстанавливаю (${recoveries}/2)`,
          error,
        );
        await page.close().catch(() => undefined);
        page = await context.newPage();
        await logger.step("openSlicingTool (восстановление)", () =>
          openSlicingTool(page, pieceId),
        );
        snapshot = await readSlicingSnapshot(page, pieceId);
        steps = buildLearningPlan(snapshot, fastTempo, planOptions); // остаток — от фактического состояния
        logger.info(`после восстановления осталось шагов: ${steps.length}`);
      }
    }

    const verified = await verifySchema();
    if (verified.remaining.length > 0 || !verified.status.complete) {
      throw new Error(
        verified.remaining.length > 0
          ? `Схема сохранена не полностью: ${verified.remaining.map(learningStepMessage).join(", ")}.`
          : "Схема содержит лишние или нецелевые упражнения после пересоздания.",
      );
    }
    report(100, "Обучающий режим готов");
    logger.info("схема подтверждена", verified.status.tabs);
    return verified.status;
  } catch (error) {
    // Падение шага само по себе ещё не результат. Схема могла быть уже собрана, а
    // сорваться могла последняя проверка или заведомо лишний шаг — решает фактическое
    // состояние, а не факт исключения. Перепроверяем теми же критериями, что и в
    // успешной ветке: остаток плана и строгое соответствие целевой схеме.
    const rescued = await verifySchema().catch(() => undefined);
    if (rescued && rescued.remaining.length === 0 && rescued.status.complete) {
      logger.warn(
        "шаг упал, но целевая схема уже собрана и подтверждена — принимаю результат",
        error,
      );
      report(100, "Обучающий режим готов");
      return rescued.status;
    }
    await captureDiagnostics(page, pieceId, logger, "run-failed");
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }

  async function verifySchema(): Promise<{
    remaining: LearningStep[];
    status: LearningStatus;
  }> {
    if (fastTempo <= 0) throw new Error("Схема не проверялась: темп ещё не определён.");
    report(93, "Проверяю сохранённую схему");
    await logger.step("openSlicingTool (проверка)", () =>
      openSlicingTool(page, pieceId, { interactive: false }),
    );
    // Свежая страница гидратирует вкладки постепенно; без этого ожидания проверка
    // успевала прочитать ещё пустой Chopped и объявляла шаг невыполненным.
    await logger.step("ожидание гидратации вкладок", () => waitForTabsHydrated(page, pieceId));
    const current = await readSlicingSnapshot(page, pieceId);
    const remaining = buildLearningPlan(current, fastTempo, planOptions);
    // CHANGED: сначала схема, потом её видимость. Проверка видимости отвечает на вопрос
    // «сохранено, но не показывается», поэтому имеет смысл только когда схема уже
    // сошлась. На незаполненном Chopped она искала все 29 упражнений и выбирала весь
    // потолок (в логе — 41 секунда) уже после того, как прогон и так упал.
    if (
      remaining.length === 0 &&
      planOptions.strategy === "adaptive" &&
      planOptions.adaptiveChunks?.length
    ) {
      const adaptiveChunks = planOptions.adaptiveChunks;
      await logger.step("проверка видимости Adaptive Chopped", () =>
        verifyExercisesVisible(page, pieceId, "C", adaptiveChunks),
      );
    }
    return {
      remaining,
      status: summarizeStatus(pieceId, current, fastTempo, planOptions),
    };
  }
}

export async function inspectLearningMode(
  context: BrowserContext,
  pieceId: number,
  musicXmlPath?: string,
): Promise<LearningStatus> {
  const logger = tlog();
  const page = await context.newPage();
  try {
    await logger.step("inspect: openSlicingTool", () =>
      openSlicingTool(page, pieceId, { interactive: false }),
    );
    const snapshot = await readSlicingSnapshot(page, pieceId);
    const fastTempo = inferFastTempo(snapshot);
    const inferred = inferLearningStrategy(snapshot);
    const options =
      inferred === "adaptive" && musicXmlPath
        ? await resolvePlanOptions(
            snapshot,
            { strategy: "adaptive", musicXmlPath },
            fastTempo,
          )
        : { strategy: inferred === "unknown" ? undefined : inferred };
    const status = summarizeStatus(pieceId, snapshot, fastTempo, options);
    logger.debug(`inspect: ${status.classification}`, status.tabs);
    return status;
  } finally {
    await page.close().catch(() => undefined);
  }
}

export function summarizeStatus(
  pieceId: number,
  snapshot: SlicingSnapshot,
  fastTempo: number,
  options: LearningPlanOptions = {},
): LearningStatus {
  const tabs = {
    W: tabSummary(snapshot, "W"),
    C: tabSummary(snapshot, "C"),
    MIN: tabSummary(snapshot, "MIN"),
  };
  const hasLearning =
    snapshot.tabs.C.exercises.length > 0 ||
    snapshot.tabs.MIN.exercises.length > 0 ||
    snapshot.tabs.W.exercises.length > 1;
  const complete = matchesTargetLearningMode(snapshot, fastTempo, options);
  return {
    pieceId,
    complete,
    classification: complete ? "ok" : hasLearning ? "warning" : "missing",
    hasLearning,
    fastTempo,
    tempos: calculateTempoProfile(fastTempo),
    tabs,
    strategy: inferLearningStrategy(snapshot),
    adaptive: options.adaptiveSummary,
  };
}

async function resolvePlanOptions(
  snapshot: SlicingSnapshot,
  options: RunLearningOptions,
  fastTempo: number,
): Promise<LearningPlanOptions> {
  const strategy = options.strategy ?? "predict";
  if (strategy === "predict") return { strategy };
  if (!options.musicXmlPath) {
    throw new Error(
      "Adaptive требует исходный MusicXML. Для этой композиции путь к файлу не сохранён.",
    );
  }
  const whole = longestCombinedWhole(snapshot);
  if (!whole) throw new Error("Adaptive: не найден исходный двуручный Whole exercise.");
  const adaptive = await buildAdaptiveLearningPlan(
    options.musicXmlPath,
    whole.startMeasure,
    whole.endMeasure,
    calculateTempoProfile(fastTempo)[0],
    ADAPTIVE_CHUNK_ORDER,
  );
  const quality = measurePlanQuality(adaptive);
  const adaptiveSummary = summarizeAdaptivePlan(adaptive);
  // Подпись плана в логе отвечает на вопрос «какой алгоритм на самом деле отработал»:
  // сервер запускается без watch, и после правки музыкальных модулей процесс нужно
  // перезапустить — иначе в памяти остаётся прежняя версия.
  tlog().info(
    `Adaptive MusicXML: ${adaptive.phraseChunks.length} фраз + ${adaptive.bridgeChunks.length} переходов + ` +
      `${adaptive.reviewChunks.length} review + ${adaptive.summaryChunks.length} summarize, ` +
      `порядок=${adaptive.chunkOrder}, ` +
      `confidence=${adaptive.confidence}, гиперметр ${quality.hypermeter}, ` +
      `closure ${quality.closureRate}, sections ${quality.sectionRecall ?? "n/a"}, ` +
      `durCV ${quality.durationCv}, forced ${quality.forcedCutRate}`,
    [
      ...adaptive.warnings,
      `фразы: ${adaptive.phraseChunks
        .map((chunk) => `${chunk.startMeasure}-${chunk.endMeasure}`)
        .join(", ")}`,
      `разделы: ${adaptive.sections
        .map((section) => `${section.label}${section.startMeasure}-${section.endMeasure}`)
        .join(" ")}`,
    ],
  );
  return { strategy, adaptiveChunks: adaptive.chunks, adaptiveSummary };
}

/** Читает снимок и считает сводку плана, ничего не изменяя на странице. */
export async function previewAdaptivePlan(
  context: BrowserContext,
  pieceId: number,
  musicXmlPath: string,
): Promise<AdaptivePlanSummary> {
  const logger = tlog();
  const page = await context.newPage();
  try {
    await logger.step("preview: openSlicingTool", () =>
      openSlicingTool(page, pieceId, { interactive: false }),
    );
    const snapshot = await readSlicingSnapshot(page, pieceId);
    const whole = longestCombinedWhole(snapshot);
    if (!whole) throw new Error("Adaptive: не найден исходный двуручный Whole exercise.");
    const fastTempo = inferFastTempo(snapshot);
    logger.info("preview: исходный Whole прочитан", {
      range: `${whole.startMeasure}-${whole.endMeasure}`,
      fastTempo,
      tabs: {
        W: snapshot.tabs.W.exercises.length,
        C: snapshot.tabs.C.exercises.length,
        MIN: snapshot.tabs.MIN.exercises.length,
      },
    });
    const plan = await logger.step("preview: анализ MusicXML", () =>
      buildAdaptiveLearningPlan(
        musicXmlPath,
        whole.startMeasure,
        whole.endMeasure,
        calculateTempoProfile(fastTempo)[0],
        ADAPTIVE_CHUNK_ORDER,
      ),
    );
    return summarizeAdaptivePlan(plan);
  } catch (error) {
    await captureDiagnostics(page, pieceId, logger, "preview-failed");
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Формирует компактную полезную нагрузку, общую для статуса и предпросмотра. */
export function summarizeAdaptivePlan(
  plan: Awaited<ReturnType<typeof buildAdaptiveLearningPlan>>,
): AdaptivePlanSummary {
  const quality = measurePlanQuality(plan);
  const byMeasure = new Map(plan.measures.map((measure) => [measure.measure, measure]));
  return {
    phrases: plan.phraseChunks.map((chunk) => ({
      start: chunk.startMeasure,
      end: chunk.endMeasure,
      title: chunk.title,
    })),
    bridges: plan.bridgeChunks.length,
    reviews: plan.reviewChunks.length,
    summaries: plan.summaryChunks.length,
    hypermeter: { ...plan.hypermeter },
    sections: plan.sections.map((section) => ({
      start: section.startMeasure,
      end: section.endMeasure,
      label: section.label,
    })),
    quality: {
      closureRate: quality.closureRate,
      hypermeterAlignment: quality.hypermeterAlignment,
      sectionRecall: quality.sectionRecall,
      durationCv: quality.durationCv,
      forcedCutRate: quality.forcedCutRate,
      navigationBreaks: quality.navigationBreaks,
    },
    warnings: [...plan.warnings],
    boundaryReasons: Object.fromEntries(
      plan.phraseChunks.map((chunk) => [
        chunk.endMeasure,
        [...(byMeasure.get(chunk.endMeasure)?.boundaryReasonsAfter ?? [])],
      ]),
    ),
  };
}

/** Самый длинный двуручный Whole — единый источник диапазона для build и preview. */
function longestCombinedWhole(snapshot: SlicingSnapshot) {
  return snapshot.tabs.W.exercises
    .filter((exercise) => !/\s-\s(?:RH|LH)$/i.test(exercise.title))
    .sort(
      (left, right) =>
        right.endMeasure - right.startMeasure - (left.endMeasure - left.startMeasure),
    )[0];
}

function tabSummary(snapshot: SlicingSnapshot, tab: SlicingTab) {
  return {
    exercises: snapshot.tabs[tab].exercises.length,
    handsComplete: hasCompleteHands(snapshot.tabs[tab].exercises),
  };
}
