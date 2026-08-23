import { chromium, type Browser, type BrowserContext } from "playwright";
import { getContext } from "./browser";
import { runBrowserTask } from "./browser-task";
import { ConcurrentLaneQueue } from "./concurrent-lane-queue";
import { LEARN_CONCURRENCY } from "./learning-config";
import { log } from "./log";
import { SLICING_KEY } from "./slicing-store";

const queue = new ConcurrentLaneQueue(LEARN_CONCURRENCY);
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
let workerBrowser: Browser | null = null;
let storageState: StorageState | null = null;
let storageStateAt: number | null = null;
let preparing: Promise<void> | null = null;

/**
 * Убирает из снимка состояние вкладки. Авторизация worker-контексту нужна, а старое
 * разбиение пьесы должно гидратироваться только с сервера.
 */
export function withoutSlicingData(state: StorageState): StorageState {
  return {
    ...state,
    origins: state.origins.map((origin) => ({
      ...origin,
      localStorage: origin.localStorage.filter((item) => item.name !== SLICING_KEY),
    })),
  };
}

interface WorkerSnapshotState {
  hasStorageState: boolean;
  storageStateAt: number | null;
  queueRunning: number;
  queueQueued: number;
  concurrency: number;
  workerConnected: boolean;
}

/** Новая волна и потерянный worker-браузер требуют свежего снимка авторизации. */
export function shouldRefreshStorageState(state: WorkerSnapshotState): boolean {
  if (!state.hasStorageState || state.storageStateAt === null) return true;
  if (state.queueRunning === 0 && state.queueQueued === 0) return true;
  return state.concurrency > 1 && !state.workerConnected;
}

/** Снимает свежую авторизацию перед каждой новой волной Learn-задач. */
async function prepareWorkers(): Promise<void> {
  if (!shouldRefreshStorageState({
    hasStorageState: storageState !== null,
    storageStateAt,
    queueRunning: queue.running,
    queueQueued: queue.queued,
    concurrency: LEARN_CONCURRENCY,
    workerConnected: workerBrowser?.isConnected() ?? false,
  })) return;
  if (!preparing) {
    preparing = runBrowserTask(async () => {
      const persistent = await getContext();
      storageState = withoutSlicingData(await persistent.storageState());
      storageStateAt = Date.now();
      log.info("learn queue: снимок сессии обновлён");
      if (LEARN_CONCURRENCY > 1 && !workerBrowser?.isConnected()) {
        workerBrowser = await chromium.launch({
          channel: "chrome",
          headless: true,
        });
        workerBrowser.on("disconnected", () => {
          workerBrowser = null;
          storageState = null;
          storageStateAt = null;
          preparing = null;
        });
      }
      log.info(
        `learn queue: готово ${LEARN_CONCURRENCY} lanes (1 persistent + ${Math.max(0, LEARN_CONCURRENCY - 1)} isolated)`,
      );
    }).finally(() => {
      preparing = null;
    });
  }
  await preparing;
}

export async function runLearningBrowserTask<T>(
  task: (context: BrowserContext, lane: number) => Promise<T>,
): Promise<T> {
  await prepareWorkers();
  return queue.run(async (lane) => {
    if (lane === 0) {
      return runBrowserTask(async () => task(await getContext(), lane));
    }
    if (!workerBrowser?.isConnected() || !storageState) {
      throw new Error("Изолированный Learn-браузер не готов.");
    }
    const context = await workerBrowser.newContext({
      storageState,
      viewport: { width: 1280, height: 900 },
    });
    try {
      return await task(context, lane);
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

export function learningQueueState() {
  return { concurrency: queue.concurrency, queued: queue.queued, running: queue.running };
}

/** Закрывает worker-браузер и заставляет следующий запуск заново снять auth state. */
export async function closeLearningWorkers(): Promise<void> {
  storageState = null;
  storageStateAt = null;
  preparing = null;
  const browser = workerBrowser;
  workerBrowser = null;
  await browser?.close().catch(() => undefined);
}
