import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getCache } from "./cache";
import { log } from "./log";
import { parseProfileHolder, reclaimBrowserProfile } from "./browser-profile";

export { parseProfileHolder };

// Отдельный профиль хранит cookies/localStorage между запусками.
export const PROFILE_DIR = join(import.meta.dir, "..", ".browser-profile");

const LOGIN_URL = "https://pianomarvel.com/login";
const UPLOADS_URL = "https://pianomarvel.com/uploads";
// CHANGED: MuseScore-логин переиспользует тот же persistent-профиль (§2.4 PRD).
export const MUSESCORE_LOGIN_URL = "https://musescore.com/user/login";
const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const PLAYWRIGHT_IGNORED_ARGS = ["--use-mock-keychain", "--password-store=basic"];

/**
 * Кеширует единственный запуск, но забывает отклонённый промис. Класс вынесен
 * отдельно, чтобы инвариант повторного запуска проверялся без настоящего Chrome.
 */
export class RetryableLaunch<T> {
  private launching: Promise<T> | null = null;

  get(start: () => Promise<T>): Promise<T> {
    if (!this.launching) {
      this.launching = start().catch((error) => {
        this.launching = null;
        throw error;
      });
    }
    return this.launching;
  }

  clear(): void {
    this.launching = null;
  }

  get active(): boolean {
    return this.launching !== null;
  }
}

let ctx: BrowserContext | null = null;
const contextLaunch = new RetryableLaunch<BrowserContext>();
let externalChrome: ReturnType<typeof Bun.spawn> | null = null;
let externalLoginStarting = false;

export type LoginState = "unknown" | "loggedOut" | "waiting" | "loggedIn";
let loginState: LoginState = "unknown";

export function getLoginState(): LoginState {
  return loginState;
}

/** Аргументы обычного Chrome для Google OAuth — без признаков автоматизации. */
export function buildExternalChromeArgs(profileDir: string, loginUrl: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    loginUrl,
  ];
}

/** Поднимает уже открытое окно Chrome на передний план. */
export async function focusChrome(): Promise<void> {
  const process = Bun.spawn(
    ["osascript", "-e", 'tell application "Google Chrome" to activate'],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  await process.exited;
}

/** Лениво запускает единый невидимый управляемый контекст в установленном Chrome. */
export async function getContext(): Promise<BrowserContext> {
  if (ctx) return ctx;
  if (externalChrome) {
    throw new Error("Сначала завершите вход и закройте отдельное окно Google Chrome.");
  }
  return contextLaunch.get(() => {
    if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });
    reclaimBrowserProfile(PROFILE_DIR, {
      protectedPids: externalChrome?.pid ? [externalChrome.pid] : [],
    });
    return chromium
      .launchPersistentContext(PROFILE_DIR, {
        channel: "chrome",
        // MuseScore не отрисовывает sidebar с Download в headless — нужен обычный Chrome.
        headless: false,
        acceptDownloads: true,
        // Используем тот же macOS Keychain, которым обычный Chrome шифрует cookies.
        ignoreDefaultArgs: PLAYWRIGHT_IGNORED_ARGS,
        viewport: { width: 1440, height: 900 },
        // CHANGED: убрана подмена user-agent. Playwright переписывает только строку UA,
        // но не client hints (`Sec-CH-UA`), поэтому заголовки заявляли Chrome 131, а
        // хинты — реальную версию установленного Chrome. Проверка Cloudflare сверяет их
        // между собой и не принимала подтверждение даже при ручном клике по галочке.
        // Настоящий Chrome должен представляться собой.
        args: ["--disable-blink-features=AutomationControlled"],
      })
      .then(async (c) => {
        // CHANGED: снят патч navigator.webdriver. У настоящего Chrome это свойство
        // равно false, а патч выставлял undefined — ещё одно несогласованное значение
        // в том же наборе признаков, по которым проверка решает, доверять ли странице.
        // Пустая вкладка about:blank мешает при ручном входе — закрываем сразу.
        for (const page of c.pages()) {
          const url = page.url();
          if (url === "about:blank" || url.startsWith("chrome://new-tab")) {
            await page.close().catch(() => undefined);
          }
        }
        ctx = c;
        c.on("close", () => {
          ctx = null;
          contextLaunch.clear();
          if (loginState !== "waiting") loginState = "unknown";
        });
        return c;
      })
      .catch((error) => {
        // Неудачный launchPersistentContext часто оставляет осиротевший Chrome.
        reclaimBrowserProfile(PROFILE_DIR);
        throw error;
      });
  });
}

/** Завершает сценарий внешнего входа — UI больше не висит в waiting. */
export function finishExternalLogin(loggedIn: boolean): void {
  loginState = loggedIn ? "loggedIn" : "loggedOut";
}

/**
 * Headless-доступ к профилю: проверки без лишнего окна about:blank.
 * Если управляемый контекст уже открыт (скачивание) — переиспользуем его.
 */
export async function withQuietProfile<T>(
  fn: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  if (ctx) return fn(ctx);
  if (externalChrome || externalLoginStarting) {
    throw new Error(
      "Профиль Chrome занят окном входа. Нажмите «Я вошёл — проверить» или закройте окно.",
    );
  }
  if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });
  reclaimBrowserProfile(PROFILE_DIR, {
    protectedPids: externalChrome?.pid ? [externalChrome.pid] : [],
  });
  const quiet = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: true,
    ignoreDefaultArgs: PLAYWRIGHT_IGNORED_ARGS,
  });
  try {
    return await fn(quiet);
  } finally {
    await quiet.close().catch(() => undefined);
    reclaimBrowserProfile(PROFILE_DIR);
  }
}

/** Профиль занят другим процессом Chrome (окно входа или скачивание). */
export function isProfileLocked(): boolean {
  try {
    return lstatSync(join(PROFILE_DIR, "SingletonLock")).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Показывает, открыт ли обычный или управляемый браузер. */
export function isBrowserOpen(): boolean {
  return (
    ctx !== null ||
    contextLaunch.active ||
    externalChrome !== null ||
    externalLoginStarting
  );
}

/**
 * Проверяет сохранённую сессию. Без открытого контекста — headless, без окна about:blank.
 */
export async function isLoggedIn(): Promise<boolean> {
  if (externalChrome || externalLoginStarting) return false;

  const probe = async (context: BrowserContext): Promise<boolean> => {
    const page = await context.newPage();
    try {
      await page
        .goto(UPLOADS_URL, { waitUntil: "commit", timeout: 20_000 })
        .catch(() => undefined);
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
      const onLoginPage = /\/login/i.test(page.url());
      const hasPasswordField = await page.locator('input[type="password"]').count().catch(() => 0);
      return !onLoginPage && hasPasswordField === 0;
    } finally {
      await page.close().catch(() => undefined);
    }
  };

  try {
    const ok = ctx ? await probe(ctx) : await withQuietProfile(probe);
    if (ok) {
      loginState = "loggedIn";
      if (ctx) await persistSessionCookies(ctx);
      else await withQuietProfile(persistSessionCookies);
    } else if (loginState !== "waiting") loginState = "loggedOut";
    return ok;
  } catch {
    return false;
  }
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  expires: number;
}

/** Сохраняет свежие куки pianomarvel в SQLite после подтверждённого входа. */
async function persistSessionCookies(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies([
      "https://pianomarvel.com",
      "https://api.pianomarvel.com",
    ]);
    if (cookies.length) {
      getCache().putSessionCookies(JSON.stringify(cookies));
      log.debug(`session: сохранено ${cookies.length} куки в SQLite`);
    }
  } catch (error) {
    log.warn("session: не удалось сохранить куки", error);
  }
}

/**
 * Быстрая проверка сессии по сохранённым в SQLite куки — обычный HTTP-запрос,
 * браузер не поднимается. null = сохранённых куки нет (проверка невозможна).
 */
export async function quickCookieCheck(): Promise<{ loggedIn: boolean; detail: string } | null> {
  const stored = getCache().getSessionCookies();
  if (!stored) return null;
  let cookies: StoredCookie[];
  try {
    cookies = JSON.parse(stored.cookiesJson) as StoredCookie[];
  } catch {
    return null;
  }
  const nowSeconds = Date.now() / 1000;
  const usable = cookies.filter(
    (cookie) =>
      /(^|\.)pianomarvel\.com$/i.test(cookie.domain.replace(/^\./, ".")) &&
      (cookie.expires === -1 || cookie.expires > nowSeconds),
  );
  if (usable.length === 0) return { loggedIn: false, detail: "сохранённые куки истекли" };

  const header = usable.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const response = await fetch(UPLOADS_URL, {
    headers: { cookie: header },
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    return {
      loggedIn: false,
      detail: /login/i.test(location)
        ? "куки отклонены — редирект на страницу входа"
        : `неожиданный редирект: ${location || response.status}`,
    };
  }
  if (response.ok) {
    const html = await response.text();
    const looksLikeLogin = /<input[^>]+type="password"/i.test(html);
    return looksLikeLogin
      ? { loggedIn: false, detail: "получена страница входа" }
      : { loggedIn: true, detail: `куки действительны (сохранены ${stored.savedAt ?? "ранее"})` };
  }
  return { loggedIn: false, detail: `HTTP ${response.status}` };
}

export interface SessionCheckResult {
  loggedIn: boolean;
  method: "cookie" | "browser";
  detail?: string;
  error?: string;
}

/**
 * Тихая проверка ТОЛЬКО по куки из SQLite — браузер не поднимается ни при каком
 * исходе. null = сохранённых куки нет. При успехе переводит состояние в loggedIn,
 * при неудаче оставляет как есть (профиль браузера может быть жив — решает
 * полная проверка по кнопке).
 */
export async function probeSessionCookies(): Promise<SessionCheckResult | null> {
  if (externalChrome || externalLoginStarting) return null;
  try {
    const quick = await quickCookieCheck();
    if (!quick) return null;
    if (quick.loggedIn) {
      loginState = "loggedIn";
      log.info(`session: восстановлена по куки из SQLite — ${quick.detail}`);
    }
    return { loggedIn: quick.loggedIn, method: "cookie", detail: quick.detail };
  } catch (error) {
    return { loggedIn: false, method: "cookie", error: String(error) };
  }
}

/**
 * Проверка сессии: сначала дёшево по куки из SQLite (без браузера), при неудаче —
 * полная проверка через профиль браузера (она же обновляет сохранённые куки).
 */
export async function checkSession(): Promise<SessionCheckResult> {
  if (externalChrome || externalLoginStarting) {
    return { loggedIn: false, method: "cookie", detail: "идёт вход через отдельный Chrome" };
  }
  let quickDetail: string | undefined;
  try {
    const quick = await quickCookieCheck();
    if (quick?.loggedIn) {
      loginState = "loggedIn";
      log.info(`session: подтверждена по куки из SQLite — ${quick.detail}`);
      return { loggedIn: true, method: "cookie", detail: quick.detail };
    }
    quickDetail = quick?.detail ?? "сохранённых куки нет";
    log.info(`session: быстрая проверка не подтвердила вход (${quickDetail}) — проверяю через браузер`);
  } catch (error) {
    quickDetail = `быстрая проверка недоступна: ${error}`;
    log.warn("session: быстрая проверка упала, перехожу к браузеру", error);
  }
  try {
    const ok = await isLoggedIn();
    return {
      loggedIn: ok,
      method: "browser",
      detail: ok
        ? "вход подтверждён через профиль браузера"
        : `сессии нет (${quickDetail}) — требуется вход`,
    };
  } catch (error) {
    return { loggedIn: false, method: "browser", error: String(error) };
  }
}

/**
 * Открывает Google OAuth в обычном Chrome. Playwright подключается к профилю
 * только после закрытия окна, поэтому Google не видит автоматизированный вход.
 */
export async function startLogin(loginUrl: string = LOGIN_URL): Promise<void> {
  // CHANGED: loginUrl параметризован — тот же механизм открывает вход и в MuseScore.
  if (externalChrome || externalLoginStarting) {
    loginState = "waiting";
    await focusChrome();
    return;
  }
  if (!existsSync(CHROME_EXECUTABLE)) {
    throw new Error("Google Chrome не найден в папке /Applications.");
  }

  loginState = "waiting";
  externalLoginStarting = true;
  void (async () => {
    try {
      await closeManagedContext();
      if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });

      const process = Bun.spawn(
        [CHROME_EXECUTABLE, ...buildExternalChromeArgs(PROFILE_DIR, loginUrl)],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );
      externalChrome = process;
      externalLoginStarting = false;

      await process.exited;
      if (externalChrome === process) {
        externalChrome = null;
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (loginState === "waiting") {
          const ok = await isLoggedIn().catch(() => false);
          if (!ok) loginState = "loggedOut";
        }
      }
    } catch (error) {
      externalChrome = null;
      externalLoginStarting = false;
      loginState = "loggedOut";
      console.error("Не удалось открыть обычный Google Chrome:", error);
    }
  })();
}

/**
 * CHANGED: закрывает внешнее окно Chrome после ручного входа и ждёт освобождения
 * профиля. Вынесено из completeLogin, чтобы переиспользовать для MuseScore-логина
 * (тот же профиль/окно) без дублирования логики завершения процесса.
 */
export async function closeExternalLoginWindow(): Promise<void> {
  const process = externalChrome;
  externalChrome = null;
  if (!process) return;

  process.kill(15);
  await Promise.race([
    process.exited,
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (process.exitCode === null) {
    process.kill(9);
    await process.exited.catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
}

/** Завершает отдельный Chrome после ручного входа и проверяет его профиль. */
export async function completeLogin(): Promise<boolean> {
  await closeExternalLoginWindow();

  const quick = await quickCookieCheck();
  if (quick?.loggedIn) {
    loginState = "loggedIn";
    return true;
  }

  const ok = await isLoggedIn().catch(() => false);
  finishExternalLogin(ok);
  return ok;
}

/** Закрывает Playwright Chrome (все вкладки) после скачивания с MuseScore. */
export async function closePlaywrightContext(): Promise<void> {
  const c = ctx;
  ctx = null;
  contextLaunch.clear();
  if (!c) return;
  for (const page of c.pages()) {
    await page.close().catch(() => undefined);
  }
  await c.close().catch(() => undefined);
  reclaimBrowserProfile(PROFILE_DIR);
}

/** Закрывает только управляемый контекст, не меняя внешний Chrome. */
async function closeManagedContext(): Promise<void> {
  await closePlaywrightContext();
}

/** Закрывает все браузеры при остановке сервера. */
export async function closeContext(): Promise<void> {
  externalLoginStarting = false;
  const process = externalChrome;
  externalChrome = null;
  process?.kill();
  await process?.exited.catch(() => undefined);
  await closeManagedContext();
  reclaimBrowserProfile(PROFILE_DIR);
  loginState = "unknown";
}
