import type { LearningStrategy } from "./learning-strategy";
import type { AdaptivePlanSummary } from "./learning-mode";

export type SlicingTab = "W" | "C" | "MIN";

export interface SlicingExercise {
  startMeasure: number;
  endMeasure: number;
  staffs: boolean[];
  title: string;
  /**
   * Позиция внутри такта, подтверждённая живым Save (server-method-162): tick — это
   * индекс нотной позиции ВНУТРИ такта (события нот и паузы; chord = та же позиция,
   * grace не считается), а не глобальный отсчёт. Predict всегда ставит start_tick=1
   * (начало такта) и end_tick = последняя позиция конечного такта. Поля необязательные:
   * predict-путь переиспользует ticks самого Piano Marvel, а adaptive считает их из
   * MusicXML, потому что DOM отдаёт только отрендеренные такты.
   */
  startTick?: number;
  endTick?: number;
}

export interface SlicingTabState {
  tempos: number[];
  exercises: SlicingExercise[];
}

export interface SlicingSnapshot {
  tabs: Record<SlicingTab, SlicingTabState>;
}

export type LearningStepType =
  | "set-tempos"
  | "predict-chopped"
  | "replace-chopped-adaptive"
  | "add-chopped-reviews"
  | "duplicate-chopped"
  | "remove-chopped-hands"
  | "split-hands";

export interface LearningStep {
  type: LearningStepType;
  tab: SlicingTab;
  tempos?: [number, number, number];
  chunks?: SlicingExercise[];
}

export interface LearningPlanOptions {
  strategy?: LearningStrategy;
  adaptiveChunks?: SlicingExercise[];
  /** Сводка Adaptive передаётся в статус, не участвуя в построении шагов. */
  adaptiveSummary?: AdaptivePlanSummary;
}

export interface ReviewChunk {
  startMeasure: number;
  endMeasure: number;
  title: string;
}

const TAB_ORDER: SlicingTab[] = ["W", "C", "MIN"];

export function calculateTempoProfile(fastTempo: number): [number, number, number] {
  const fast = clampTempo(fastTempo);
  return [clampTempo(fast * 0.6), clampTempo(fast * 0.8), fast];
}

/** Формирует действия для дополнения уже очищенной целевой базы. */
export function buildLearningPlan(
  snapshot: SlicingSnapshot,
  fastTempo: number,
  options: LearningPlanOptions = {},
): LearningStep[] {
  const strategy = options.strategy ?? "predict";
  const profile = calculateTempoProfile(fastTempo);
  const steps: LearningStep[] = [];
  const addChoppedReviews =
    strategy === "predict" &&
    (needsPrediction(snapshot) || needsReviewChunks(snapshot.tabs.C.exercises));

  for (const tab of TAB_ORDER) {
    const state = snapshot.tabs[tab];

    if (tab === "C") {
      if (strategy === "adaptive") {
        const chunks = requireAdaptiveChunks(options);
        if (!sameExercises(state.exercises, chunks)) {
          steps.push({ type: "replace-chopped-adaptive", tab, chunks, tempos: profile });
        }
      } else {
        const predictionNeeded = needsPrediction(snapshot);
        if (predictionNeeded) steps.push({ type: "predict-chopped", tab });
      }
    }
    if (tab === "C" && state.exercises.some((exercise) => handSuffix(exercise.title))) {
      steps.push({ type: "remove-chopped-hands", tab });
    }
    if (tab === "MIN" && needsMincedRefill(snapshot)) {
      steps.push({ type: "duplicate-chopped", tab });
    }
    if (tab !== "C" && !hasCompleteHands(state.exercises)) {
      steps.push({ type: "split-hands", tab });
    }

    // Темпы ставим ПОСЛЕ наполнения вкладки: Piano Marvel не сохраняет пустую вкладку,
    // поэтому set-tempos на ещё пустой C/MIN раньше вис на saveCurrentTab (waitForFunction 30s).
    if (!sameTempos(state.tempos, profile)) {
      steps.push({ type: "set-tempos", tab, tempos: profile });
    }
  }
  if (addChoppedReviews) {
    steps.push({ type: "add-chopped-reviews", tab: "C", tempos: profile });
  }
  return steps;
}

/**
 * Схема уже является чистой базой: один двуручный Whole и пустые Chopped/Minced.
 * Сбрасывать в таком состоянии нечего, а попытка это сделать вредна: у свежей
 * загрузки Piano Marvel ещё не посчитал такты (Whole приходит как 0-0), и reset
 * падал на ней с «не найден исходный двуручный Whole exercise».
 */
export function isCleanLearningBase(snapshot: SlicingSnapshot): boolean {
  const whole = snapshot.tabs.W.exercises;
  return (
    whole.length === 1 &&
    !handSuffix(whole[0].title) &&
    snapshot.tabs.C.exercises.length === 0 &&
    snapshot.tabs.MIN.exercises.length === 0
  );
}

/** Строгая проверка именно целевой схемы, включая отсутствие лишних упражнений. */
export function matchesTargetLearningMode(
  snapshot: SlicingSnapshot,
  fastTempo: number,
  options: LearningPlanOptions = {},
): boolean {
  const strategy = options.strategy ?? inferLearningStrategy(snapshot);
  const profile = calculateTempoProfile(fastTempo);
  if (TAB_ORDER.some((tab) => !sameTempos(snapshot.tabs[tab].tempos, profile))) return false;

  const wholeCombined = snapshot.tabs.W.exercises.filter((exercise) => !handSuffix(exercise.title));
  if (
    wholeCombined.length !== 1 ||
    snapshot.tabs.W.exercises.length !== 3 ||
    !hasExactHands(snapshot.tabs.W.exercises, wholeCombined)
  ) return false;

  const chopped = snapshot.tabs.C.exercises;
  if (chopped.some((exercise) => handSuffix(exercise.title))) return false;
  if (strategy === "predict" && inferLearningStrategy(snapshot) === "adaptive") return false;

  if (strategy === "adaptive") {
    const expected = options.adaptiveChunks;
    if (
      chopped.length === 0 ||
      !chopped.every((exercise) => isAdaptiveTitle(exercise.title)) ||
      (expected && !sameExercises(chopped, expected)) ||
      !coversRange(chopped, wholeCombined[0].startMeasure, wholeCombined[0].endMeasure)
    ) return false;
    const minced = snapshot.tabs.MIN.exercises;
    const mincedCombined = minced.filter((exercise) => !handSuffix(exercise.title));
    return (
      minced.length === chopped.length * 3 &&
      mincedCombined.length === chopped.length &&
      sameRanges(mincedCombined, chopped) &&
      hasExactHands(minced, mincedCombined)
    );
  }

  const phrases = chopped.filter((exercise) => !isReview(exercise.title));
  const reviews = chopped.filter((exercise) => isReview(exercise.title));
  const expectedReviews = buildReviewChunks(phrases);
  const wholeEnd = wholeCombined[0].endMeasure;
  if (
    phrases.length === 0 ||
    Math.max(...phrases.map((exercise) => exercise.endMeasure)) < wholeEnd ||
    reviews.length !== expectedReviews.length ||
    !sameRanges(reviews, expectedReviews)
  ) return false;

  const minced = snapshot.tabs.MIN.exercises;
  const mincedCombined = minced.filter((exercise) => !handSuffix(exercise.title));
  return (
    minced.length === phrases.length * 3 &&
    mincedCombined.length === phrases.length &&
    sameRanges(mincedCombined, phrases) &&
    hasExactHands(minced, mincedCombined)
  );
}

export function inferLearningStrategy(snapshot: SlicingSnapshot): LearningStrategy | "unknown" {
  const chopped = snapshot.tabs.C.exercises.filter(
    (exercise) => !handSuffix(exercise.title) && !isReview(exercise.title),
  );
  if (chopped.length === 0) return "unknown";
  return chopped.every((exercise) => isAdaptiveTitle(exercise.title))
    ? "adaptive"
    : "predict";
}

/**
 * Заголовки adaptive-схемы: фраза `A1 (m. 1-4)`, переход `A.Bridge 1-2 (...)`,
 * обзор `A.Review 1 (...)`, финальная треть `A.Summarize 1/3 (...)`. Учитываем и
 * старый префикс `Adaptive` — иначе схемы, построенные до укорочения названий,
 * считались бы чужими и пересоздавались.
 */
function isAdaptiveTitle(title: string): boolean {
  const canonical = canonicalExerciseTitle(title);
  return /^A(?:\d+|\.(?:Bridge|Review|Summarize))\b/i.test(canonical) || /^Adaptive\b/i.test(canonical);
}

function isAdaptiveExtra(title: string): boolean {
  const canonical = canonicalExerciseTitle(title);
  return /^A\.(?:Bridge|Review|Summarize)\b/i.test(canonical) || /^Adaptive\s+Bridge\b/i.test(canonical);
}

export function parseSlicingSnapshot(value: unknown): SlicingSnapshot {
  const tabs = emptyTabs();
  if (!Array.isArray(value)) return { tabs };

  for (const rawTab of value) {
    if (!rawTab || typeof rawTab !== "object") continue;
    const sortName = (rawTab as { sortName?: unknown }).sortName;
    if (!isTab(sortName)) continue;
    const data = (rawTab as { data?: unknown }).data;
    if (!data || typeof data !== "object") continue;
    const rawData = data as { tempos?: unknown; exercises?: unknown };
    tabs[sortName] = {
      tempos: Array.isArray(rawData.tempos)
        ? rawData.tempos.map(Number).filter(Number.isFinite)
        : [],
      exercises: Array.isArray(rawData.exercises)
        ? rawData.exercises.flatMap(parseExercise)
        : [],
    };
  }
  return { tabs };
}

export function inferFastTempo(snapshot: SlicingSnapshot, fallback = 100): number {
  const whole = snapshot.tabs.W;
  const fromTab = whole.tempos.at(-1);
  const fromExercise = whole.exercises.length
    ? Number((whole.exercises[0] as SlicingExercise & { tempos?: number[] }).tempos?.at(-1))
    : undefined;
  return clampTempo(fromTab || fromExercise || fallback);
}

export function buildReviewChunks(exercises: SlicingExercise[]): ReviewChunk[] {
  const phrases = exercises
    .filter((exercise) => !handSuffix(exercise.title) && !isReview(exercise.title))
    .sort((a, b) => a.startMeasure - b.startMeasure);
  const reviews: ReviewChunk[] = [];
  for (let index = 0; index + 3 < phrases.length; index += 4) {
    const group = phrases.slice(index, index + 4);
    const first = group[0];
    const last = group[3];
    reviews.push({
      startMeasure: first.startMeasure,
      endMeasure: last.endMeasure,
      title: `Review ${index + 1}–${index + 4} (m. ${first.startMeasure}-${last.endMeasure})`,
    });
  }
  return reviews;
}

export function hasCompleteHands(exercises: SlicingExercise[]): boolean {
  const combined = exercises.filter((exercise) => !handSuffix(exercise.title));
  if (combined.length === 0) return false;
  return combined.every((exercise) => {
    const sameRange = (candidate: SlicingExercise) =>
      candidate.startMeasure === exercise.startMeasure &&
      candidate.endMeasure === exercise.endMeasure &&
      exerciseBaseTitle(candidate.title) === exerciseBaseTitle(exercise.title);
    const hasRight = exercises.some(
      (candidate) => sameRange(candidate) && handSuffix(candidate.title) === "RH",
    );
    const hasLeft = exercises.some(
      (candidate) => sameRange(candidate) && handSuffix(candidate.title) === "LH",
    );
    return hasRight && hasLeft;
  });
}

function needsPrediction(snapshot: SlicingSnapshot): boolean {
  const chopped = snapshot.tabs.C.exercises.filter(
    (exercise) => !handSuffix(exercise.title) && !isReview(exercise.title),
  );
  if (chopped.length === 0) return true;
  const wholeEnd = Math.max(0, ...snapshot.tabs.W.exercises.map((exercise) => exercise.endMeasure));
  const choppedEnd = Math.max(...chopped.map((exercise) => exercise.endMeasure));
  return wholeEnd > 0 && choppedEnd < wholeEnd;
}

function needsReviewChunks(exercises: SlicingExercise[]): boolean {
  return buildReviewChunks(exercises).some(
    (review) =>
      !exercises.some(
        (exercise) =>
          isReview(exercise.title) &&
          exercise.startMeasure === review.startMeasure &&
          exercise.endMeasure === review.endMeasure,
      ),
  );
}

function requireAdaptiveChunks(options: LearningPlanOptions): SlicingExercise[] {
  if (!options.adaptiveChunks?.length) {
    throw new Error("Adaptive: план MusicXML не передан в Learn planner.");
  }
  return options.adaptiveChunks;
}

/**
 * Minced обязан быть копией текущего Chopped. Проверять только «пусто ли» нельзя:
 * при изменившемся разбиении Chopped заменяется, а Minced остаётся со старыми
 * границами — и схема расходится сама с собой.
 */
function needsMincedRefill(snapshot: SlicingSnapshot): boolean {
  const minced = snapshot.tabs.MIN.exercises;
  if (minced.length === 0) return true;
  const chopped = snapshot.tabs.C.exercises.filter(
    (exercise) => !handSuffix(exercise.title),
  );
  if (chopped.length === 0) return false;
  const mincedCombined = minced.filter((exercise) => !handSuffix(exercise.title));
  return !sameRanges(mincedCombined, chopped);
}

function sameExercises(actual: SlicingExercise[], expected: SlicingExercise[]): boolean {
  if (actual.length !== expected.length) return false;
  const normalize = (items: SlicingExercise[]) =>
    items.map(
      (item) =>
        `${item.startMeasure}:${item.endMeasure}:${canonicalExerciseTitle(item.title)}`,
    );
  const normalizedActual = normalize(actual);
  const normalizedExpected = normalize(expected);
  return normalizedActual.every((value, index) => value === normalizedExpected[index]);
}

function coversRange(exercises: SlicingExercise[], start: number, end: number): boolean {
  // Переходы и обзоры перекрывают соседние фразы, поэтому непрерывность считаем только
  // по самим фразам: иначе обзорный кусок замаскировал бы дыру в покрытии.
  const ranges = exercises
    .filter((exercise) => !isAdaptiveExtra(exercise.title))
    .sort((left, right) => left.startMeasure - right.startMeasure);
  if (ranges.length === 0 || ranges[0].startMeasure > start) return false;
  let covered = start - 1;
  for (const range of ranges) {
    if (range.startMeasure > covered + 1) return false;
    covered = Math.max(covered, range.endMeasure);
  }
  return covered >= end;
}

function parseExercise(value: unknown): SlicingExercise[] {
  if (!value || typeof value !== "object") return [];
  const raw = value as Record<string, unknown>;
  return [{
    startMeasure: numeric(raw.startMeasure ?? raw.start_measure),
    endMeasure: numeric(raw.endMeasure ?? raw.end_measure),
    staffs: Array.isArray(raw.staffs) ? raw.staffs.map(Boolean) : [],
    title: typeof (raw.exerciseTitle ?? raw.title) === "string"
      ? String(raw.exerciseTitle ?? raw.title).trim()
      : "",
  }];
}

function emptyTabs(): Record<SlicingTab, SlicingTabState> {
  return {
    W: { tempos: [], exercises: [] },
    C: { tempos: [], exercises: [] },
    MIN: { tempos: [], exercises: [] },
  };
}

function sameTempos(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && expected.every((tempo, index) => actual[index] === tempo);
}

function hasExactHands(exercises: SlicingExercise[], combined: SlicingExercise[]): boolean {
  return combined.every((exercise) => {
    const sameRange = (candidate: SlicingExercise) =>
      candidate.startMeasure === exercise.startMeasure &&
      candidate.endMeasure === exercise.endMeasure &&
      exerciseBaseTitle(candidate.title) === exerciseBaseTitle(exercise.title);
    return (
      exercises.filter(
        (candidate) => sameRange(candidate) && handSuffix(candidate.title) === "RH",
      ).length === 1 &&
      exercises.filter(
        (candidate) => sameRange(candidate) && handSuffix(candidate.title) === "LH",
      ).length === 1
    );
  });
}

function sameRanges(
  actual: Array<Pick<SlicingExercise, "startMeasure" | "endMeasure">>,
  expected: Array<Pick<SlicingExercise, "startMeasure" | "endMeasure">>,
): boolean {
  const range = (exercise: Pick<SlicingExercise, "startMeasure" | "endMeasure">) =>
    `${exercise.startMeasure}:${exercise.endMeasure}`;
  if (actual.length !== expected.length) return false;
  const actualRanges = actual.map(range).sort();
  const expectedRanges = expected.map(range).sort();
  return actualRanges.every((value, index) => value === expectedRanges[index]);
}

function isTab(value: unknown): value is SlicingTab {
  return value === "W" || value === "C" || value === "MIN";
}

function numeric(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clampTempo(value: number): number {
  return Math.min(240, Math.max(30, Math.round(value)));
}

function handSuffix(title: string): "RH" | "LH" | undefined {
  return title.match(/\s-\s(RH|LH)$/i)?.[1]?.toUpperCase() as "RH" | "LH" | undefined;
}

function isReview(title: string): boolean {
  return /^Review\b/i.test(canonicalExerciseTitle(title));
}

/**
 * Piano Marvel дописывает порядковый номер прямо в сохранённый title новых
 * упражнений (`A1…` → `1. A1…`). Номер — представление списка, а не часть
 * идентичности chunk: после Duplicate Chopped вкладка Minced получает уже другую
 * сквозную нумерацию. Все проверки стратегии и точного плана поэтому сравнивают
 * канонический заголовок без серверного ordinal.
 */
function canonicalExerciseTitle(title: string): string {
  return title.trim().replace(/^\d+\.\s*/, "");
}

function exerciseBaseTitle(title: string): string {
  return canonicalExerciseTitle(title).replace(/\s-\s(?:RH|LH)$/i, "");
}
