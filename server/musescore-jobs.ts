/**
 * CHANGED (new file) — фоновое задание скачивания с MuseScore c прогрессом.
 *
 * Раньше /api/musescore/fetch был одним блокирующим POST: UI показывал «мёртвый»
 * спиннер на минуту без единого слова о том, что происходит. Теперь это job с
 * long-poll (тот же паттерн, что server/learning-jobs.ts): фронт мгновенно
 * получает job, затем подписывается на изменения и показывает живой тост с шагами
 * («Проверяю вход», «Открываю страницу», «Скачиваю PDF…»). Всё логируется на
 * сервере через withTaskLogger.
 */
import { runBrowserTask } from "./browser-task";
import { closePlaywrightContext } from "./browser";
import { isMuseScoreLoggedIn, fetchMuseScoreFiles, toScanPayload, probeMuseScoreSession } from "./musescore";
import type { MuseScoreFormat, ScanPayload } from "./musescore";
import { withTaskLogger } from "./log";

export type FetchJobState = "queued" | "running" | "completed" | "failed";

export interface MuseScoreFetchJob {
  id: string;
  scoreUrl: string;
  state: FetchJobState;
  progress: number;
  message: string;
  /** Был ли обнаружен вход в MuseScore на старте (для подсказки в UI). */
  loggedIn?: boolean;
  error?: string;
  result?: ScanPayload;
  version: number;
}

const jobs = new Map<string, MuseScoreFetchJob>();
const waiters = new Map<string, Set<(job: MuseScoreFetchJob) => void>>();

export interface StartFetchArgs {
  scoreUrl: string;
  formats?: MuseScoreFormat[];
  baseName?: string;
  author?: string;
}

function scoreIdentity(scoreUrl: string): string {
  const scoreId = scoreUrl.match(/\/scores\/(\d+)/)?.[1];
  return scoreId ? `score:${scoreId}` : scoreUrl.trim();
}

/** Находит активное скачивание: два job иначе пишут один комплект файлов. */
export function findActiveFetchJob(
  source: Iterable<MuseScoreFetchJob>,
  scoreUrl: string,
): MuseScoreFetchJob | undefined {
  const identity = scoreIdentity(scoreUrl);
  return [...source].find(
    (job) =>
      scoreIdentity(job.scoreUrl) === identity &&
      (job.state === "queued" || job.state === "running"),
  );
}

export function startFetchJob({ scoreUrl, formats, baseName, author }: StartFetchArgs): MuseScoreFetchJob {
  const active = findActiveFetchJob(jobs.values(), scoreUrl);
  if (active) return active;
  const job: MuseScoreFetchJob = {
    id: crypto.randomUUID(),
    scoreUrl,
    state: "queued",
    progress: 0,
    message: "Ожидаю браузер…",
    version: 0,
  };
  jobs.set(job.id, job);

  void (async () => {
    const loggedIn = probeMuseScoreSession();
    update(job, {
      state: "running",
      progress: 5,
      loggedIn,
      message: loggedIn
        ? "Вход есть — жду браузер для скачивания…"
        : "Вход не обнаружен — жду браузер…",
    });

    await runBrowserTask(() =>
      withTaskLogger(`musescore ${job.id.slice(0, 8)}`, async (logger) => {
        const startedAt = Date.now();
        logger.info(`старт скачивания ${scoreUrl}`);
        update(job, {
          progress: 8,
          message: loggedIn
            ? "Вход есть — открываю страницу ноты…"
            : "Вход не обнаружен, пробую скачать…",
        });

        try {
          const fetched = await fetchMuseScoreFiles(
            scoreUrl,
            { formats, baseName, author },
            (progress, message) => {
              update(job, { progress: Math.max(job.progress, Math.min(progress, 99)), message });
              logger.debug(`${progress}% — ${message}`);
            },
          );

          const payload = await toScanPayload(fetched);
          const gotCount = Object.values(fetched.files).filter(Boolean).length;
          logger.info(`готово за ${Date.now() - startedAt}ms — форматов: ${gotCount}`, {
            skipped: fetched.skipped,
          });

          update(job, {
            state: "completed",
            progress: 100,
            message: fetched.readyForPipeline
              ? `Комплект готов (${gotCount} файла) — акт III открыт ниже. Папка: ${fetched.dir}`
              : gotCount
                ? `Скачано форматов: ${gotCount}. Не хватает обязательных файлов для акта III.`
                : "Не удалось скачать ни одного формата.",
            result: payload,
          });
        } catch (error) {
          logger.error(`скачивание упало за ${Date.now() - startedAt}ms`, error);
          update(job, {
            state: "failed",
            progress: 100,
            message: "Скачивание не удалось",
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          await closePlaywrightContext().catch(() => undefined);
          logger.debug("браузер MuseScore закрыт");
        }
      }),
    ).catch((error) => {
      update(job, {
        state: "failed",
        progress: 100,
        message: "Не удалось запустить браузер",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  })();

  return job;
}

export function getFetchJob(id: string): MuseScoreFetchJob | undefined {
  return jobs.get(id);
}

/** Long-poll без интервала: ответ приходит только при реальном изменении job. */
export function waitForFetchJob(
  id: string,
  afterVersion: number,
  signal?: AbortSignal,
): Promise<MuseScoreFetchJob | undefined> {
  const current = jobs.get(id);
  if (!current || current.version > afterVersion || isTerminal(current)) {
    return Promise.resolve(current);
  }
  return new Promise((resolve) => {
    const listeners = waiters.get(id) ?? new Set<(job: MuseScoreFetchJob) => void>();
    const finish = (job: MuseScoreFetchJob) => {
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

function update(job: MuseScoreFetchJob, patch: Partial<MuseScoreFetchJob>): void {
  Object.assign(job, patch);
  job.version += 1;
  const listeners = waiters.get(job.id);
  if (!listeners) return;
  for (const notify of [...listeners]) notify(job);
}

function isTerminal(job: MuseScoreFetchJob): boolean {
  return job.state === "completed" || job.state === "failed";
}
