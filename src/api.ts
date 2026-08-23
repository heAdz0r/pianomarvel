export interface NativeFileResult {
  path: string | null;
  error?: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Общий JSON-контракт UI → локальный API.
 *
 * В dev-режиме устаревший или ещё не поднявшийся backend может вернуть
 * text/plain/HTML (например, `Not found`). Не позволяем `JSON.parse` скрыть
 * реальную HTTP-ошибку собственным SyntaxError.
 */
export async function requestJson<T>(
  url: string,
  init?: RequestInit,
  fetcher: Fetcher = fetch,
): Promise<T> {
  const response = await fetcher(url, init);
  const text = await response.text();
  let data: Record<string, unknown> = {};

  if (text.trim()) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const excerpt = text.trim().replace(/\s+/g, " ").slice(0, 180);
      const routeHint =
        response.status === 404
          ? "Backend не знает этот маршрут; перезапустите локальный сервер"
          : "Backend вернул ответ не в формате JSON";
      throw new Error(
        `${routeHint} (HTTP ${response.status})${excerpt ? `: ${excerpt}` : "."}`,
      );
    }
  }

  if (!response.ok) {
    const detail =
      typeof data.error === "string"
        ? data.error
        : typeof data.message === "string"
          ? data.message
          : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    throw new Error(detail);
  }
  return data as T;
}

export async function chooseNativeFile(
  fetcher: Fetcher = fetch,
): Promise<NativeFileResult> {
  try {
    const response = await fetcher("/api/browse", { method: "POST" });
    const text = await response.text();
    let data: { path?: unknown; error?: unknown } = {};
    if (text) {
      try {
        data = JSON.parse(text) as typeof data;
      } catch {
        return {
          path: null,
          error: `Сервер вернул некорректный ответ (HTTP ${response.status}).`,
        };
      }
    }

    if (!response.ok) {
      return {
        path: null,
        error:
          typeof data.error === "string"
            ? data.error
            : `Сервер не вернул описание ошибки (HTTP ${response.status}).`,
      };
    }
    return { path: typeof data.path === "string" ? data.path : null };
  } catch (error) {
    return { path: null, error: `Не удалось открыть выбор файла: ${String(error)}` };
  }
}
