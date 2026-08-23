/**
 * Лёгкий структурированный логгер для серверного пайплайна.
 * Формат строки: `12:34:56.789 INFO  [learn #157783] сообщение { extra }`.
 *
 * Управление через env:
 *   LEARN_DEBUG=1            — включает уровень debug (подробные шаги/тайминги)
 *   LEARN_LOG_LEVEL=warn     — явный минимальный уровень (debug|info|warn|error)
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveThreshold(): number {
  const explicit = process.env.LEARN_LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  if (explicit && explicit in LEVEL_ORDER) return LEVEL_ORDER[explicit];
  const debug = process.env.LEARN_DEBUG === "1" || process.env.LEARN_DEBUG === "true";
  return debug ? LEVEL_ORDER.debug : LEVEL_ORDER.info;
}

const threshold = resolveThreshold();

function stamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function format(extra: unknown): string {
  if (extra === undefined) return "";
  if (extra instanceof Error) return ` ${extra.stack ?? extra.message}`;
  if (typeof extra === "string") return ` ${extra}`;
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
  /** Новый логгер с дополнительным префиксом области. */
  child(scope: string): Logger;
  /**
   * Замеряет длительность асинхронного шага и логирует начало/конец (или ошибку).
   * Если шаг «зависнет», в логе останется только строка `▶ name` — сразу видно где.
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

function createLogger(scope: string): Logger {
  const prefix = scope ? ` [${scope}]` : "";

  function emit(level: LogLevel, message: string, extra?: unknown): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = `${stamp()} ${level.toUpperCase().padEnd(5)}${prefix} ${message}${format(extra)}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  return {
    debug: (message, extra) => emit("debug", message, extra),
    info: (message, extra) => emit("info", message, extra),
    warn: (message, extra) => emit("warn", message, extra),
    error: (message, extra) => emit("error", message, extra),
    child: (childScope) => createLogger(scope ? `${scope} ${childScope}` : childScope),
    async step(name, fn) {
      const started = Date.now();
      emit("debug", `▶ ${name}`);
      try {
        const result = await fn();
        emit("debug", `✔ ${name} (${Date.now() - started}ms)`);
        return result;
      } catch (error) {
        emit("error", `✘ ${name} упал через ${Date.now() - started}ms`, error);
        throw error;
      }
    },
  };
}

/** Базовый логгер приложения. Используйте `.child()` для областей. */
export const log = createLogger("");

/**
 * Контекстный логгер задачи. AsyncLocalStorage сохраняет правильный scope при
 * параллельном выполнении нескольких Learn-lanes.
 */
const taskLogger = new AsyncLocalStorage<Logger>();

export function withTaskLogger<T>(
  scope: string,
  task: (logger: Logger) => Promise<T>,
): Promise<T> {
  const logger = createLogger(scope);
  return taskLogger.run(logger, () => task(logger));
}

/** Логгер активной задачи (или базовый, если задачи нет). */
export function tlog(): Logger {
  return taskLogger.getStore() ?? log;
}
import { AsyncLocalStorage } from "node:async_hooks";
