/**
 * CHANGED (new file) — инструмент для закрытия gap'ов #1 и #2 из architecture.md.
 *
 * Сырое HTTP-воспроизведение метода 162 не работает ("Json deserialize error:
 * trailing input…"), потому что точное тело/обёртка запроса не зафиксированы.
 * Архитектурная заметка прямо говорит, что нужно перехватить РОВНО ту строку
 * тела, которую шлёт клиент при клике Save — и заодно понять, какие кнопки
 * какой server-method-N дёргают.
 *
 * Этот скрипт открывает slicing tool в залогиненном профиле и через
 * addInitScript патчит fetch/XHR ДО загрузки бандла сайта. Каждый вызов к
 * api.pianomarvel.com логируется целиком (метод N, url, заголовки, СЫРОЕ тело
 * строкой, статус и тело ответа) в captures/rpc-<pieceId>.jsonl.
 *
 *   bun run capture <pieceId>
 *
 * Дальше кликай кнопки в открывшемся окне (Predict / Split Hands / Save …),
 * каждое действие пишется в файл и печатается в консоль. Ctrl+C — закрыть.
 * Требует активной сессии (bun run login один раз).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getContext, isLoggedIn, closeContext } from "./browser";

const CAPTURE_DIR = join(import.meta.dir, "..", "captures");

interface RpcEntry {
  at: string;
  transport: "fetch" | "xhr";
  method: string; // HTTP method
  serverMethod: string | null; // N из ?server-method-N
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null; // СЫРОЕ тело как строка — самое важное
  status: number;
  responseBody: string;
}

// Патч выполняется в контексте страницы (сериализуется в браузер через
// addInitScript). Типы здесь браузерные — работаем через `any`, чтобы не тащить
// DOM-lib в серверную проверку типов.
function installInterceptor() {
  const w = window as any;
  const API_HOST = "api.pianomarvel.com";
  const send = (entry: unknown) => w.__rpcCapture?.(entry);
  const serverMethodOf = (url: string): string | null =>
    url.match(/server-method-(\d+)/)?.[1] ?? null;

  const origFetch = w.fetch;
  w.fetch = async function (this: unknown, ...args: any[]) {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const isApi = url.includes(API_HOST);
    const res = await origFetch.apply(this, args);
    if (isApi) {
      try {
        const reqBody =
          typeof init?.body === "string" ? init.body : init?.body ? "[non-string body]" : null;
        const headers: Record<string, string> = {};
        new Headers(init?.headers as any).forEach((v, k) => (headers[k] = v));
        const clone = res.clone();
        send({
          at: new Date().toISOString(),
          transport: "fetch",
          method: (init?.method ?? "GET").toUpperCase(),
          serverMethod: serverMethodOf(url),
          url,
          requestHeaders: headers,
          requestBody: reqBody,
          status: res.status,
          responseBody: await clone.text().catch(() => "[unreadable]"),
        });
      } catch {
        /* не мешаем работе сайта */
      }
    }
    return res;
  };

  const XHR: any = (w.XMLHttpRequest || XMLHttpRequest).prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (this: any, method: string, url: string, ...rest: any[]) {
    this.__cap = { method, url };
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function (this: any, body?: any) {
    const cap = this.__cap;
    if (cap?.url?.includes(API_HOST)) {
      this.addEventListener("load", () => {
        send({
          at: new Date().toISOString(),
          transport: "xhr",
          method: (cap.method ?? "GET").toUpperCase(),
          serverMethod: serverMethodOf(cap.url),
          url: cap.url,
          requestHeaders: {},
          requestBody: typeof body === "string" ? body : body ? "[non-string body]" : null,
          status: this.status,
          responseBody: this.responseText ?? "",
        });
      });
    }
    return origSend.call(this, body);
  };
}

async function main() {
  const pieceId = process.argv[2];
  if (!pieceId || !/^\d+$/.test(pieceId)) {
    console.error("Использование: bun run capture <pieceId>   (например: bun run capture 157779)");
    process.exit(1);
  }

  if (!(await isLoggedIn())) {
    console.error("Не залогинен на pianomarvel.com. Сначала: bun run login");
    await closeContext();
    process.exit(1);
  }

  mkdirSync(CAPTURE_DIR, { recursive: true });
  const outFile = join(CAPTURE_DIR, `rpc-${pieceId}.jsonl`);

  const context = await getContext();
  const page = await context.newPage();

  await page.exposeFunction("__rpcCapture", (entry: RpcEntry) => {
    appendFileSync(outFile, JSON.stringify(entry) + "\n", "utf8");
    const tag = entry.serverMethod ? `method-${entry.serverMethod}` : entry.url.split("?")[0];
    const bodyLen = entry.requestBody?.length ?? 0;
    console.log(`↔ ${entry.status} ${entry.method} ${tag}  (body ${bodyLen}b) → ${outFile}`);
  });
  await page.addInitScript(installInterceptor);

  const url = `https://pianomarvel.com/en/nextgen/slicing_tool/${pieceId}`;
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);

  console.log(`\n🎧 Перехват включён. Открыт slicing tool для piece ${pieceId}.`);
  console.log(`   Кликай кнопки (Predict / Split Hands / Save …) — всё пишется в:`);
  console.log(`   ${outFile}`);
  console.log(`   Ctrl+C — завершить.\n`);

  // держим процесс живым; graceful shutdown в index.ts здесь не действует —
  // ловим сигналы сами.
  await new Promise<void>((resolve) => {
    const stop = async () => {
      console.log("\nЗавершаю…");
      await closeContext().catch(() => undefined);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

main().catch(async (err) => {
  console.error(err);
  await closeContext().catch(() => undefined);
  process.exit(1);
});
