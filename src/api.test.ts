import { describe, expect, test } from "bun:test";
import { chooseNativeFile, requestJson } from "./api";

describe("общий JSON-контракт API", () => {
  test("plain-text 404 объясняет stale backend вместо SyntaxError JSON.parse", async () => {
    const fetcher = async () =>
      new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });

    expect(requestJson("/api/new-route", undefined, fetcher)).rejects.toThrow(
      "Backend не знает этот маршрут; перезапустите локальный сервер (HTTP 404): Not found",
    );
  });

  test("JSON-ошибка backend сохраняет исходное сообщение", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ error: "Точный серверный диагноз." }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });

    expect(requestJson("/api/fail", undefined, fetcher)).rejects.toThrow(
      "Точный серверный диагноз.",
    );
  });
});

describe("нативный выбор файла", () => {
  test("возвращает понятную ошибку для пустого ответа 500", async () => {
    const fetcher = async () => new Response("", { status: 500 });

    const result = await chooseNativeFile(fetcher);

    expect(result).toEqual({
      path: null,
      error: "Сервер не вернул описание ошибки (HTTP 500).",
    });
  });

  test("возвращает выбранный путь из JSON", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ path: "/tmp/song.mid" }), {
        headers: { "content-type": "application/json" },
      });

    expect(await chooseNativeFile(fetcher)).toEqual({
      path: "/tmp/song.mid",
    });
  });
});
