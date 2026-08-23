import type { AdaptiveChunkOrder } from "./adaptive-learning";

/**
 * Настраиваемые тайминги пайплайна Learn Mode.
 * Все значения в миллисекундах, переопределяются через env — можно ускорять/замедлять
 * прогон без правок кода (полезно при отладке flaky-автоматизации на живом сайте).
 */
function ms(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const LEARN_TIMING = {
  /**
   * Аварийный потолок одной задачи на общем профиле. Это не механизм ожидания:
   * потолок лишь не даёт зависшей задаче остановить общую очередь навсегда.
   */
  browserTaskCap: ms("BROWSER_TASK_CAP_MS", 600_000),
  /** Тайм-аут навигации/ожидания появления slicing-инструмента. */
  navTimeout: ms("LEARN_NAV_TIMEOUT_MS", 30_000),
  /** Верхняя граница ожидания готовности Angular вместо жёсткой паузы. */
  hydrateCap: ms("LEARN_HYDRATE_CAP_MS", 30_000),
  /**
   * Добавка к аварийному потолку на каждое упражнение там, где ожидание зависит от
   * длины списка. Плоский потолок в таких местах перестаёт быть аварийным: отрисовка
   * 156 строк Minced не успевала в 30 секунд, и потолок сам становился механизмом
   * ожидания. Это по-прежнему потолок — завершение определяет состояние DOM.
   */
  hydratePerExerciseCap: ms("LEARN_HYDRATE_PER_EXERCISE_CAP_MS", 400),
  /** Задержка ввода символов в поля темпа. */
  tempoFieldDelay: ms("LEARN_TEMPO_DELAY_MS", 15),
  /** Короткое окно, за которое локальная модель должна принять новый fragment. */
  localMutationTimeout: ms("LEARN_LOCAL_MUTATION_TIMEOUT_MS", 2_500),
  /** Сколько локальных Predict-изменений объединять в один сетевой Save. */
  predictCheckpointEvery: positiveInteger("LEARN_PREDICT_CHECKPOINT_EVERY", 8),
  /** Аварийный предел восстановлений Predict; сами повторы запускаются DOM/data-событиями. */
  predictRecoveryLimit: positiveInteger("LEARN_PREDICT_RECOVERY_LIMIT", 4),
  /** Аварийный предел числа создаваемых Chopped-фраз. */
  predictExerciseLimit: positiveInteger("LEARN_PREDICT_EXERCISE_LIMIT", 100),
  /** Ожидание HTTP-ответа сохранения (server-method-162). */
  saveTimeout: ms("LEARN_SAVE_TIMEOUT_MS", 30_000),
  /** Ожидание роста числа упражнений после действия. */
  growthTimeout: ms("LEARN_GROWTH_TIMEOUT_MS", 30_000),
} as const;

/**
 * CHANGED: порядок учебного маршрута Adaptive внутри вкладки Chopped.
 *
 * `stage` (по умолчанию) — сперва все отрезки, затем все мостики, затем обзоры и
 * трети. `score` — исторический порядок по позиции в партитуре; это единственный
 * порядок с монотонно неубывающим `endMeasure`, поэтому он остаётся аварийным
 * откатом, если Piano Marvel перестанет показывать строки, идущие «назад» по нотам
 * (симптом: ошибка «сохранил, но не показывает Chopped exercises»).
 */
export const ADAPTIVE_CHUNK_ORDER: AdaptiveChunkOrder =
  process.env.ADAPTIVE_CHUNK_ORDER === "score" ? "score" : "stage";

/** Полное число независимых Learn-lanes: persistent lane плюс worker-контексты. */
export const LEARN_CONCURRENCY = positiveInteger("LEARN_CONCURRENCY", 3);

/** Куда складывать скриншоты/дампы при падении. */
export const LEARN_DEBUG_DIR = process.env.LEARN_DEBUG_DIR ?? ".data/learn-debug";

/** Снимать диагностику (скриншот + состояние) при падении. Включено по умолчанию. */
export const LEARN_CAPTURE_DIAGNOSTICS =
  process.env.LEARN_CAPTURE_DIAGNOSTICS !== "0" &&
  process.env.LEARN_CAPTURE_DIAGNOSTICS !== "false";
