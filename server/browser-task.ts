import { LEARN_TIMING } from "./learning-config";
import { closePlaywrightContext } from "./browser";

let tail: Promise<void> = Promise.resolve();

export interface BrowserTaskOptions {
  capMs?: number;
  /**
   * Останавливает ресурс, на котором исполняется задача. Очередь освобождается
   * только после фактического завершения task, поэтому фоновая операция не сможет
   * пересечься со следующей задачей общего профиля.
   */
  abort?: () => Promise<void> | void;
}

/** Последовательно выполняет задачи, использующие единый профиль Chrome. */
export async function runBrowserTask<T>(
  task: () => Promise<T>,
  options: BrowserTaskOptions | number = {},
): Promise<T> {
  const normalized = typeof options === "number" ? { capMs: options } : options;
  const capMs = normalized.capMs ?? LEARN_TIMING.browserTaskCap;
  const abort = normalized.abort ?? closePlaywrightContext;
  const previous = tail;
  let release: () => void = () => {};
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  let cap: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("browser-task-timeout");
  type Outcome =
    | { ok: true; value: T }
    | { ok: false; error: unknown };
  const operation: Promise<Outcome> = Promise.resolve()
    .then(task)
    .then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
  try {
    const outcome = await Promise.race([
      operation,
      new Promise<typeof timedOut>((resolve) => {
        cap = setTimeout(
          () => resolve(timedOut),
          capMs,
        );
        cap.unref?.();
      }),
    ]);
    if (outcome === timedOut) {
      // Закрытие persistent-контекста прерывает Playwright-вызов. Ждём подтверждения
      // завершения исходной задачи и только затем выпускаем следующую из FIFO.
      await abort();
      await operation;
      throw new Error(
        "Задача на общем профиле Chrome не завершилась за отведённое время и была снята, чтобы не блокировать очередь.",
      );
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    if (cap) clearTimeout(cap);
    release();
  }
}
