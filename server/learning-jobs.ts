import { getCache } from "./cache";
import { inspectLearningMode, runLearningMode, type LearningStatus } from "./learning-mode";
import { runLearningBrowserTask } from "./learning-workers";
import { withTaskLogger } from "./log";
import type { LearningStrategy } from "./learning-strategy";
import { learningStrategyLabel } from "./learning-strategy";

export type LearningJobState = "queued" | "running" | "completed" | "failed";

export interface LearningJob {
  id: string;
  pieceId: number;
  state: LearningJobState;
  progress: number;
  message: string;
  error?: string;
  status?: LearningStatus;
  checkedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  lane?: number;
  version: number;
  strategy: LearningStrategy;
}

const jobs = new Map<string, LearningJob>();
const waiters = new Map<string, Set<(job: LearningJob) => void>>();

export function startLearningJob(
  pieceId: number,
  strategy: LearningStrategy = "predict",
): LearningJob {
  const active = [...jobs.values()].find(
    (job) =>
      job.pieceId === pieceId &&
      (job.state === "queued" || job.state === "running"),
  );
  if (active) return active;

  const job: LearningJob = {
    id: crypto.randomUUID(),
    pieceId,
    state: "queued",
    progress: 0,
    message: "Ожидает браузер",
    version: 0,
    strategy,
  };
  jobs.set(job.id, job);
  void runLearningBrowserTask(async (context, lane) => {
    // Отмена снимает запись job до старта lane; сама очередь уже содержит callback,
    // поэтому он обязан повторно проверить состояние перед любыми действиями.
    if (job.state !== "queued") return;
    return withTaskLogger(`learn #${pieceId}`, async (logger) => {
      const startedAt = Date.now();
      logger.info(`старт задачи ${job.id} на lane ${lane}, ${learningStrategyLabel(strategy)}`);
      update(job, {
        state: "running",
        progress: 1,
        message: `Поток ${lane + 1}: ${learningStrategyLabel(strategy)}`,
        startedAt: new Date(startedAt).toISOString(),
        error: undefined,
        lane,
      });
      try {
        const musicXmlPath = strategy === "adaptive"
          ? getCache().getScoreSource(pieceId)?.xmlPath
          : undefined;
        const status = await runLearningMode(
          context,
          pieceId,
          (progress, message) => {
            update(job, { progress, message });
            logger.debug(`прогресс ${progress}% — ${message}`);
          },
          { strategy, musicXmlPath },
        );
        const checkedAt = new Date().toISOString();
        getCache().putLearningStatus(status, checkedAt);
        update(job, {
          state: "completed",
          progress: 100,
          message: "Обучающий режим готов",
          status,
          checkedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        });
        logger.info(`готово за ${Date.now() - startedAt}ms — ${status.classification}`, {
          tabs: status.tabs,
          tempos: status.tempos,
        });
      } catch (error) {
        logger.error(`задача упала за ${Date.now() - startedAt}ms`, error);
        let actualStatus: LearningStatus | undefined;
        let checkedAt: string | undefined;
        try {
          actualStatus = await inspectLearningMode(
            context,
            pieceId,
            getCache().getScoreSource(pieceId)?.xmlPath,
          );
          checkedAt = new Date().toISOString();
          getCache().putLearningStatus(actualStatus, checkedAt);
          logger.info(`фактический статус после падения: ${actualStatus.classification}`, actualStatus.tabs);
        } catch (inspectError) {
          logger.warn("не удалось перечитать статус после падения", inspectError);
        }
        update(job, {
          state: "failed",
          message: "Создание обучения остановлено",
          error: error instanceof Error ? error.message : String(error),
          status: actualStatus,
          checkedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        });
      }
    });
  }).catch((error) => {
    update(job, {
      state: "failed",
      message: "Не удалось запустить браузерный поток",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString(),
    });
  });
  return job;
}

export function getLearningJob(id: string): LearningJob | undefined {
  return jobs.get(id);
}

/** Снимает только ожидающие задачи: активный Playwright-сценарий не прерывается. */
export function cancelQueuedLearningJobs(): number {
  const finishedAt = new Date().toISOString();
  return cancelQueuedJobs(jobs.values(), (job) => {
    update(job, {
      state: "failed",
      message: "Снято из очереди",
      error: "Снято из очереди",
      finishedAt,
    });
  });
}

/** Чистое ядро отмены позволяет доказать, что running/completed не затрагиваются. */
export function cancelQueuedJobs(
  candidates: Iterable<LearningJob>,
  cancel: (job: LearningJob) => void,
): number {
  let cancelled = 0;
  for (const job of candidates) {
    if (job.state !== "queued") continue;
    cancel(job);
    cancelled += 1;
  }
  return cancelled;
}

/** Long-poll без интервала: ответ приходит только при реальном изменении job. */
export function waitForLearningJob(
  id: string,
  afterVersion: number,
  signal?: AbortSignal,
): Promise<LearningJob | undefined> {
  const current = jobs.get(id);
  if (!current || current.version > afterVersion || isTerminal(current)) {
    return Promise.resolve(current);
  }
  return new Promise((resolve) => {
    const listeners = waiters.get(id) ?? new Set<(job: LearningJob) => void>();
    const finish = (job: LearningJob) => {
      listeners.delete(finish);
      if (listeners.size === 0) waiters.delete(id);
      signal?.removeEventListener("abort", onAbort);
      resolve(job);
    };
    const onAbort = () => finish(jobs.get(id) ?? current);
    listeners.add(finish);
    waiters.set(id, listeners);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function update(job: LearningJob, patch: Partial<LearningJob>): void {
  Object.assign(job, patch);
  job.version += 1;
  const listeners = waiters.get(job.id);
  if (!listeners) return;
  for (const notify of [...listeners]) notify(job);
}

function isTerminal(job: LearningJob): boolean {
  return job.state === "completed" || job.state === "failed";
}
