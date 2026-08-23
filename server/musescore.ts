/**
 * CHANGED (new file) — реализация PRD «поиск и автозагрузка нот с MuseScore.com»
 * (prd-musescore-integration.md), схема B: Playwright ведёт настоящую страницу
 * musescore.com в уже залогиненном persistent-профиле (.browser-profile/, тот же,
 * что и для pianomarvel.com — §2.4 PRD), кликает реальные кнопки и забирает файлы
 * через `page.waitForEvent("download")`. Схема C (сырой HTTP с подписанным
 * `generate?...&sgn=...`) сознательно НЕ реализуется (§3–§4 PRD, §6.4 ToS).
 *
 * Синхронизация — ТОЛЬКО по событиям/состоянию (waitForSelector / waitForEvent /
 * waitForFunction), без magic-number пауз (предпочтение пользователя). Таймауты
 * здесь — только потолок безопасности на асинхронную серверную генерацию PDF/MP3
 * (§2.3 PRD), а не механизм ожидания.
 *
 * [GAP] Точная DOM-разметка карточек поиска и модалки Download в PRD снята вручную,
 * но не построчно (§6 «первая задача реализации»). Поэтому:
 *   - поиск парсится двухуровнево: сперва встроенный JSON-стор страницы, затем
 *     запасной разбор DOM по ссылкам на /scores/{id};
 *   - клики по форматам идут через устойчивые role/text-локаторы, а не по хрупким
 *     CSS-классам.
 * Проверить/зафиксировать селекторы на живой странице: `bun run scrape:musescore`.
 */
import { dirname, extname, join, sep } from "node:path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import type { BrowserContext, Download, Page, Response } from "playwright";
import {
  getContext,
  withQuietProfile,
  PROFILE_DIR,
  isProfileLocked,
  isBrowserOpen,
  focusChrome,
} from "./browser";
import { log } from "./log";
import { getCache } from "./cache";
import { guessMetadata } from "./metadata";
import { analyzeScoreFile } from "./scoreAnalyzer";

/**
 * Базовая папка библиотеки. Каждая композиция изолирована:
 * `~/Downloads/musescore_sheets/{author}/{composition}/`.
 */
export const MUSESCORE_SHEETS_ROOT = join(homedir(), "Downloads", "musescore_sheets");

/** @deprecated используйте resolveMuseScoreDownloadDir */
export const MUSESCORE_DOWNLOAD_DIR = MUSESCORE_SHEETS_ROOT;

const SEARCH_URL = "https://musescore.com/sheetmusic";

/** Форматы, которые нам нужны из модалки Download (Musescore/.mscz не берём). */
export type MuseScoreFormat = "pdf" | "mxl" | "midi" | "mp3";
/** PDF временно отключён — асинхронная generate-страница нестабильна. */
export const WANTED_FORMATS: MuseScoreFormat[] = ["mxl", "midi", "mp3"];
/** Обязательные артефакты для перехода в акт III и загрузки на Piano Marvel. */
export const REQUIRED_FORMATS: MuseScoreFormat[] = ["mxl", "midi", "mp3"];

/** Расширение файла на диске для каждого формата. */
const FORMAT_EXT: Record<MuseScoreFormat, string> = {
  pdf: "pdf",
  mxl: "mxl",
  midi: "mid",
  mp3: "mp3",
};

/**
 * Как называется пункт формата в модалке Download (§2.3 PRD: «Musescore, PDF,
 * MusicXML, MIDI, Audio»). Матчим по доступному имени (текст кнопки), т.к. это
 * устойчивее CSS-классов.
 */
const FORMAT_LABEL: Record<MuseScoreFormat, RegExp> = {
  pdf: /^pdf$/i,
  mxl: /^music\s*xml$/i,
  midi: /^midi$/i,
  mp3: /^audio$/i,
};

/**
 * Кнопка «Download» на странице ноты. UI MuseScore локализован — у пользователя,
 * например, ru-RU («Скачать»). Матчим несколько локалей + запасные признаки
 * (aria-label / класс со словом download), т.к. точная разметка — [GAP] PRD.
 */
const DOWNLOAD_TRIGGER_NAME = /download|скачать|下载|descargar|télécharger|herunterladen|ダウンロード/i;
/** Точное имя кнопки на странице ноты (без описаний модалки). */
const DOWNLOAD_TRIGGER_EXACT =
  /^(download|скачать|descargar|télécharger|herunterladen|ダウンロード)$/i;

/**
 * Потолок ожидания реального события download. PDF и Audio генерируются на
 * сервере асинхронно (§2.3/R8 PRD), поэтому потолок щедрый. Это НЕ фиксированная
 * пауза: ждём именно событие download, а число — лишь верхняя граница на отказ.
 */
const DOWNLOAD_CEILING_MS: Record<MuseScoreFormat, number> = {
  mxl: 30_000,
  midi: 30_000,
  pdf: 120_000,
  mp3: 120_000,
};

export interface MuseScoreSearchResult {
  scoreId: string;
  url: string;
  title: string;
  arranger: string;
  thumbnailUrl?: string;
  instrument?: string;
  difficulty?: "Beginner" | "Intermediate" | "Advanced" | "";
  isOfficial: boolean;
  requiresPro: boolean;
  rating?: number;
  votes?: number;
  views?: number;
  saves?: number;
  parts?: number;
  pages?: number;
  durationSeconds?: number;
  publishedAt?: string;
}

export interface MuseScoreFetchResult {
  scoreId: string;
  baseName: string;
  /** Папка автора внутри musescore_sheets (slug). */
  authorSlug: string;
  /** Подпапка композиции внутри папки автора (slug). */
  compositionSlug: string;
  dir: string;
  /** Метаданные со страницы MuseScore (приоритетнее угадывания из slug файла). */
  title?: string;
  composer?: string;
  artist?: string;
  files: Partial<Record<MuseScoreFormat, string>>;
  skipped: Array<{ format: MuseScoreFormat; reason: string }>;
  warnings: string[];
  /** true, когда скачаны все REQUIRED_FORMATS — можно открывать акт III. */
  readyForPipeline: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Login status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Логин на MuseScore проверяем независимо от pianomarvel (общий loginState в
 * browser.ts не трогаем). Признак входа — отсутствие ссылки «Log in» / наличие
 * пользовательского меню. Открываем главную «commit», чтобы не спотыкаться о
 * возможный редирект (тот же приём, что в isLoggedIn для pianomarvel).
 */
/**
 * Auth-куки MuseScore (Yii `_identity` + признак OAuth-провайдера). Их наличие в
 * persistent-профиле = пользователь вошёл. Проверка по кукам НАДЁЖНЕЕ и БЫСТРЕЕ
 * скрапинга DOM: страница musescore.com рендерится JS, и маркеры avatar/logout в
 * начальном HTML нестабильны — из-за этого прошлая эвристика давала ложный logout
 * при реально валидной сессии.
 */
// `_identity` — авторитетный auth-cookie MuseScore (Yii).
const MUSESCORE_AUTH_COOKIES = ["_identity", "_mu_session_id", "musescore_session"];

function hasMuseScoreAuthCookies(
  cookies: Array<{ name: string; value?: string }>,
): boolean {
  return cookies.some(
    (c) =>
      MUSESCORE_AUTH_COOKIES.includes(c.name) &&
      typeof c.value === "string" &&
      c.value.length > 0,
  );
}

/** Проверяет auth-куки в SQLite профиля, когда Chrome держит lock (без расшифровки). */
export function probeMuseScoreAuthOnDisk(): boolean {
  const dbPath = join(PROFILE_DIR, "Default", "Cookies");
  if (!existsSync(dbPath)) return false;
  try {
    const proc = Bun.spawnSync(
      [
        "sqlite3",
        dbPath,
        "SELECT COUNT(*) FROM cookies WHERE host_key LIKE '%musescore.com' AND name IN ('_identity','_mu_session_id') AND length(encrypted_value) > 20;",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) return false;
    return Number.parseInt(proc.stdout.toString().trim(), 10) > 0;
  } catch {
    return false;
  }
}

/** Мгновенная проверка по кукам на диске и кэшу — без браузера и без очереди. */
export function probeMuseScoreSession(): boolean {
  if (probeMuseScoreAuthOnDisk()) return true;
  return getCache().getMuseScoreLoginFlag()?.loggedIn ?? false;
}

export async function isMuseScoreLoggedIn(): Promise<boolean> {
  const finish = (loggedIn: boolean, method: string): boolean => {
    getCache().setMuseScoreLoginFlag(loggedIn);
    log.info(`musescore: проверка входа (${method}) → ${loggedIn ? "есть сессия" : "нет сессии"}`);
    return loggedIn;
  };

  // Сначала диск — sqlite3 за миллисекунды, не ждём очередь и не поднимаем Chrome.
  if (probeMuseScoreAuthOnDisk()) {
    return finish(true, "куки на диске");
  }

  // Профиль занят скачиванием/входом — повторный headless только усугубит блокировку.
  if (isProfileLocked() || isBrowserOpen()) {
    return finish(false, "профиль занят, auth-куки не найдены");
  }

  try {
    const loggedIn = await withQuietProfile(async (context) =>
      hasMuseScoreAuthCookies(await context.cookies("https://musescore.com")),
    );
    return finish(loggedIn, "куки профиля");
  } catch (error) {
    log.warn("musescore: headless-профиль недоступен при проверке входа", error);
    return finish(probeMuseScoreAuthOnDisk(), "fallback диск");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** @deprecated Поиск всегда ограничен фортепианными партитурами. */
  pianoOnly?: boolean;
  /** Максимум карточек в ответе. */
  limit?: number;
}

export async function searchMuseScore(
  query: string,
  options: SearchOptions = {},
): Promise<MuseScoreSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const context = await getContext();
  const page = await context.newPage();
  try {
    // Добавляем Piano к текстовому запросу: это повышает релевантность ещё на стороне
    // MuseScore. Финальная строгая проверка всё равно выполняется ниже по метаданным.
    const searchText = /piano|фортеп|пиано/i.test(trimmed) ? trimmed : `${trimmed} piano`;
    const params = new URLSearchParams({ text: searchText });
    await page.goto(`${SEARCH_URL}?${params.toString()}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Ждём, пока React отрисует карточки (ссылки на /scores/) ИЛИ явное «ничего
    // не найдено» — событие DOM, не пауза.
    await page
      .waitForFunction(
        () =>
          document.querySelectorAll('a[href*="/scores/"]').length > 0 ||
          /no results|ничего не найд|nothing found|результат/i.test(document.body?.innerText ?? ""),
        { timeout: 25_000 },
      )
      .catch(() => undefined);
    // Небольшой запас на дорисовку карточек после первой ссылки — по числу ссылок.
    await page
      .waitForFunction(
        (prev) => document.querySelectorAll('a[href*="/scores/"]').length >= prev,
        1,
        { timeout: 4_000 },
      )
      .catch(() => undefined);

    const raw = await page.evaluate(extractSearchResultsInPage);
    const results = raw
      .map(normalizeResult)
      .filter((r): r is MuseScoreSearchResult => r !== null)
      .filter(isDownloadablePianoResult);

    // Дедуп по scoreId, сохраняя порядок появления.
    const seen = new Set<string>();
    const deduped = results.filter((r) => {
      if (seen.has(r.scoreId)) return false;
      seen.add(r.scoreId);
      return true;
    });

    log.info(
      `musescore: поиск "${trimmed}" (piano, без Official) → ${deduped.length} результатов`,
    );
    const ranked = sortMuseScoreResults(deduped, "popular");
    return typeof options.limit === "number" ? ranked.slice(0, options.limit) : ranked;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Сырой кандидат из страницы (до нормализации в Node). */
interface RawResult {
  scoreId?: string | number;
  url?: string;
  title?: string;
  arranger?: string;
  thumbnailUrl?: string;
  instrument?: string;
  difficulty?: string;
  isOfficial?: boolean;
  requiresPro?: boolean;
  rating?: number;
  votes?: number;
  views?: number;
  saves?: number;
  parts?: number;
  pages?: number;
  durationSeconds?: number;
  publishedAt?: string;
}

/**
 * Выполняется В КОНТЕКСТЕ СТРАНИЦЫ. Двухуровневый разбор (см. шапку файла):
 * 1) встроенный JSON-стор (div.js-store / __NEXT_DATA__ / script[type=json]),
 * 2) запасной разбор DOM по ссылкам на /scores/{id}.
 */
function extractSearchResultsInPage(): RawResult[] {
  const byId = new Map<string, RawResult>();
  const titleQuality = (value: unknown): number => {
    if (typeof value !== "string") return -1;
    const title = value.replace(/\s+/g, " ").trim();
    if (!title) return -1;
    if (/^(official|pro|beginner|intermediate|advanced|easy|medium|hard)$/i.test(title)) {
      return 0;
    }
    return Math.min(title.length, 160);
  };
  const normalizeInstrumentValue = (value: unknown): string | undefined => {
    if (typeof value === "string") return value.trim() || undefined;
    if (Array.isArray(value)) {
      const labels = value
        .map((item) => {
          if (typeof item === "string") return item;
          if (!item || typeof item !== "object") return "";
          const record = item as Record<string, unknown>;
          return String(record.name ?? record.title ?? record.label ?? "");
        })
        .filter(Boolean);
      return labels.length ? labels.join(", ") : undefined;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const label = record.name ?? record.title ?? record.label;
      return typeof label === "string" ? label.trim() || undefined : undefined;
    }
    return undefined;
  };
  const numberValue = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return undefined;
    const match = value.trim().match(/^([\d.,]+)\s*([KMB])?$/i);
    if (!match) return undefined;
    const amount = Number.parseFloat(match[1].replace(/,/g, ""));
    if (!Number.isFinite(amount)) return undefined;
    const multiplier = match[2]?.toUpperCase() === "K" ? 1_000
      : match[2]?.toUpperCase() === "M" ? 1_000_000
        : match[2]?.toUpperCase() === "B" ? 1_000_000_000 : 1;
    return Math.round(amount * multiplier);
  };
  const matchNumber = (text: string, pattern: RegExp): number | undefined => {
    const value = text.match(pattern)?.[1];
    return value ? numberValue(value) : undefined;
  };
  const put = (r: RawResult) => {
    const id = r.scoreId != null ? String(r.scoreId) : "";
    if (!id) return;
    const prev = byId.get(id) ?? {};
    // Булевы ограничения накапливаем через OR: DOM-признак Official обязан победить
    // ранний false из неполного JSON. Для title выбираем самый содержательный текст,
    // чтобы ссылка-бейдж «Intermediate» не затирала реальное название произведения.
    for (const [k, v] of Object.entries(r)) {
      if (v == null || v === "") continue;
      if (k === "isOfficial" || k === "requiresPro") {
        (prev as Record<string, unknown>)[k] =
          Boolean((prev as Record<string, unknown>)[k]) || Boolean(v);
        continue;
      }
      if (k === "title") {
        const current = (prev as Record<string, unknown>)[k];
        if (titleQuality(v) > titleQuality(current)) {
          (prev as Record<string, unknown>)[k] = v;
        }
        continue;
      }
      if ((prev as Record<string, unknown>)[k] == null || (prev as Record<string, unknown>)[k] === "") {
        (prev as Record<string, unknown>)[k] = v;
      }
    }
    byId.set(id, prev);
  };

  // ── Tier 1: встроенный JSON ────────────────────────────────────────────────
  const blobs: string[] = [];
  document
    .querySelectorAll("div.js-store[data-content]")
    .forEach((el) => blobs.push(el.getAttribute("data-content") ?? ""));
  const nextData = document.getElementById("__NEXT_DATA__");
  if (nextData?.textContent) blobs.push(nextData.textContent);
  document
    .querySelectorAll('script[type="application/json"]')
    .forEach((el) => el.textContent && blobs.push(el.textContent));

  const looksLikeScore = (o: Record<string, unknown>): boolean => {
    const id = o.id ?? o.scoreId ?? o.nid;
    const title = o.title ?? o.name;
    return (
      id != null &&
      typeof title === "string" &&
      title.length > 0 &&
      (o.user != null || o.href != null || o.url != null || o.share != null || o.artist != null)
    );
  };

  const fromScoreObject = (o: Record<string, unknown>): RawResult => {
    const user = (o.user ?? {}) as Record<string, unknown>;
    const href = (o.href ?? o.url ?? o.share ?? "") as string;
    return {
      scoreId: (o.id ?? o.scoreId ?? o.nid) as string | number,
      url: typeof href === "string" ? href : undefined,
      title: (o.title ?? o.name) as string,
      arranger: (user.name ?? user.username ?? o.artist ?? "") as string,
      thumbnailUrl: (o.thumbnail_url ?? o.image ?? o.thumbnail) as string | undefined,
      instrument: normalizeInstrumentValue(o.instrumentation ?? o.instruments ?? o.instrument),
      difficulty: (o.complexity ?? o.difficulty) as string | undefined,
      isOfficial: Boolean(o.is_official ?? o.official),
      requiresPro: Boolean(o.is_pro ?? o.pro ?? o.is_download_pro),
      rating: typeof o.rating === "number" ? (o.rating as number) : undefined,
      votes: (o.rating_count ?? o.votes) as number | undefined,
      views: numberValue(o.views ?? o.view_count ?? o.hits),
      saves: numberValue(o.saves ?? o.saves_count ?? o.favorites ?? o.favorites_count),
      parts: numberValue(o.parts_count ?? o.parts),
      pages: (o.pages_count ?? o.pages) as number | undefined,
      durationSeconds: (o.duration ?? o.duration_seconds) as number | undefined,
      publishedAt: (o.date_created ?? o.created_at ?? o.published_at) as string | undefined,
    };
  };

  const visited = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || node == null || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth + 1));
      return;
    }
    const obj = node as Record<string, unknown>;
    if (looksLikeScore(obj)) put(fromScoreObject(obj));
    for (const key of Object.keys(obj)) walk(obj[key], depth + 1);
  };
  for (const blob of blobs) {
    if (!blob) continue;
    try {
      walk(JSON.parse(blob), 0);
    } catch {
      /* не JSON — пропускаем */
    }
  }

  // ── Tier 2: запасной разбор DOM ────────────────────────────────────────────
  const anchors = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/scores/"]'),
  );
  for (const a of anchors) {
    const href = a.getAttribute("href") ?? "";
    const m = href.match(/\/scores\/(\d+)/);
    if (!m) continue;
    const scoreId = m[1];

    // React оборачивает один результат в semantic <article>. Это устойчивее
    // случайных CSS-классов и не обрезает автора/метрики, лежащие после обложки.
    const card = a.closest<HTMLElement>("article") ?? a.parentElement ?? a;
    const cardText = (card.innerText ?? "").replace(/\s+/g, " ").trim();
    const scoreLinks = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href*="/scores/"]'));
    const titleLink = scoreLinks
      .map((link) => ({ link, text: (link.innerText ?? link.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim() }))
      .sort((left, right) => titleQuality(right.text) - titleQuality(left.text))[0];
    const title = titleLink?.text ?? (a.getAttribute("aria-label") ?? a.textContent ?? "").trim();
    const img = card.querySelector("img");
    const authorLink = Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .find((link) => {
        const linkHref = link.getAttribute("href") ?? "";
        const linkText = (link.innerText ?? "").trim();
        return Boolean(linkText) && !/\/scores\//.test(linkHref) && !/\/sheetmusic\//.test(linkHref);
      });
    const durationText = cardText.match(/\b(\d{1,2}):(\d{2})\b/);
    const publishedAt = cardText.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/)?.[0];

    put({
      scoreId,
      url: href.startsWith("http") ? href : `https://musescore.com${href}`,
      title: title || undefined,
      arranger: authorLink?.innerText.trim() || undefined,
      thumbnailUrl: img?.getAttribute("src") ?? img?.getAttribute("data-src") ?? undefined,
      difficulty: /beginner/i.test(cardText)
        ? "Beginner"
        : /intermediate/i.test(cardText)
          ? "Intermediate"
          : /advanced/i.test(cardText)
            ? "Advanced"
              : undefined,
      instrument: /piano|фортеп|пиано|keyboard/i.test(cardText) ? "Piano" : undefined,
      isOfficial: /official/i.test(cardText),
      requiresPro: /\bpro\b/i.test(cardText),
      views: matchNumber(cardText, /([\d.,]+\s*[KMB]?)\s+views\b/i),
      saves: matchNumber(cardText, /([\d.,]+\s*[KMB]?)\s+saves\b/i),
      votes: matchNumber(cardText, /([\d.,]+\s*[KMB]?)\s+votes\b/i),
      parts: matchNumber(cardText, /([\d.,]+)\s+parts?\b/i),
      pages: matchNumber(cardText, /([\d.,]+)\s+pages?\b/i),
      durationSeconds: durationText ? Number(durationText[1]) * 60 + Number(durationText[2]) : undefined,
      publishedAt,
    });
  }

  return Array.from(byId.values());
}

function normalizeResult(raw: RawResult): MuseScoreSearchResult | null {
  const scoreId = raw.scoreId != null ? String(raw.scoreId) : "";
  if (!scoreId) return null;

  let url = raw.url ?? `https://musescore.com/scores/${scoreId}`;
  if (url.startsWith("/")) url = `https://musescore.com${url}`;

  const difficulty = normalizeDifficulty(raw.difficulty);

  return {
    scoreId,
    url,
    title: (raw.title ?? "").trim() || `Score ${scoreId}`,
    arranger: (raw.arranger ?? "").trim(),
    thumbnailUrl: raw.thumbnailUrl,
    instrument: raw.instrument?.trim() || undefined,
    difficulty,
    isOfficial: Boolean(raw.isOfficial),
    requiresPro: Boolean(raw.requiresPro),
    rating: typeof raw.rating === "number" ? raw.rating : undefined,
    votes: typeof raw.votes === "number" ? raw.votes : undefined,
    views: typeof raw.views === "number" ? raw.views : undefined,
    saves: typeof raw.saves === "number" ? raw.saves : undefined,
    parts: typeof raw.parts === "number" ? raw.parts : undefined,
    pages: typeof raw.pages === "number" ? raw.pages : undefined,
    durationSeconds: typeof raw.durationSeconds === "number" ? raw.durationSeconds : undefined,
    publishedAt: raw.publishedAt?.trim() || undefined,
  };
}

export type MuseScoreSortMode = "popular" | "saved" | "rated" | "relevance";

/** Сортирует только по опубликованным MuseScore метрикам, без выдуманного download count. */
export function sortMuseScoreResults(
  results: MuseScoreSearchResult[],
  mode: MuseScoreSortMode,
): MuseScoreSearchResult[] {
  if (mode === "relevance") return [...results];
  const metrics = (result: MuseScoreSearchResult): number[] => {
    if (mode === "saved") return [result.saves ?? -1, result.views ?? -1, result.votes ?? -1];
    if (mode === "rated") return [result.votes ?? -1, result.rating ?? -1, result.views ?? -1];
    return [result.views ?? -1, result.saves ?? -1, result.votes ?? -1, result.rating ?? -1];
  };
  return results
    .map((result, index) => ({ result, index }))
    .sort((left, right) => {
      const a = metrics(left.result);
      const b = metrics(right.result);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] ?? -1) !== (b[i] ?? -1)) return (b[i] ?? -1) - (a[i] ?? -1);
      }
      return left.index - right.index;
    })
    .map(({ result }) => result);
}

/** Единственный класс результатов, который можно показать в picker UI. */
export function isDownloadablePianoResult(result: MuseScoreSearchResult): boolean {
  if (result.isOfficial) return false;
  const evidence = `${result.instrument ?? ""} ${result.title}`;
  return /piano|фортеп|пиано|keyboard/i.test(evidence);
}

function normalizeDifficulty(
  value: string | undefined,
): MuseScoreSearchResult["difficulty"] {
  if (!value) return "";
  if (/beginner|easy/i.test(value)) return "Beginner";
  if (/intermediate|medium/i.test(value)) return "Intermediate";
  if (/advanced|hard|expert/i.test(value)) return "Advanced";
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch (download) — схема B
// ─────────────────────────────────────────────────────────────────────────────

/** slug из URL скора («…/scores/9901456» либо «…/interstellar-…»). */
function slugFromUrl(url: string, fallback: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop() ?? "";
    // Если последний сегмент — чистое число (id), берём предыдущий осмысленный.
    if (/^\d+$/.test(last)) {
      const segs = path.split("/").filter(Boolean);
      const named = segs.reverse().find((s) => /[a-z]/i.test(s) && s !== "scores" && s !== "user");
      if (named) return sanitizeBase(named);
    }
    if (last) return sanitizeBase(last);
  } catch {
    /* игнор */
  }
  return sanitizeBase(fallback);
}

export function sanitizeBase(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "musescore-score"
  );
}

export interface FetchOptions {
  formats?: MuseScoreFormat[];
  /** Общий базовый filename; по умолчанию — slug из URL. */
  baseName?: string;
  /** Имя автора/композитора для папки (если известно из поиска). */
  author?: string;
}

/** Папка скачивания: `~/Downloads/musescore_sheets/{author}/{composition}/`. */
export function resolveMuseScoreDownloadDir(
  author: string,
  composition: string,
  root = MUSESCORE_SHEETS_ROOT,
): string {
  const authorSlug = sanitizeBase(author || "unknown");
  const compositionSlug = sanitizeBase(composition || "untitled");
  return join(root, authorSlug, compositionSlug);
}

/**
 * Не перезаписывает другую редакцию с тем же title. Чистый stem остаётся
 * человекочитаемым; scoreId добавляется только при занятой цели.
 */
export function resolveAvailableMuseScoreDownloadDir(
  author: string,
  composition: string,
  scoreId: string,
  root = MUSESCORE_SHEETS_ROOT,
): { dir: string; compositionSlug: string } {
  const authorSlug = sanitizeBase(author || "unknown");
  const baseSlug = sanitizeBase(composition || "untitled");
  const baseDir = resolveMuseScoreDownloadDir(authorSlug, baseSlug, root);
  if (!existsSync(baseDir) || readdirSync(baseDir).length === 0) {
    return { dir: baseDir, compositionSlug: baseSlug };
  }

  const identity = sanitizeBase(scoreId || "edition");
  for (let edition = 1; ; edition += 1) {
    const suffix = edition === 1 ? identity : `${identity}-${edition}`;
    const compositionSlug = `${baseSlug}-${suffix}`;
    const dir = resolveMuseScoreDownloadDir(authorSlug, compositionSlug, root);
    if (!existsSync(dir) || readdirSync(dir).length === 0) {
      return { dir, compositionSlug };
    }
  }
}

const DOWNLOAD_RESERVATION_FILE = ".pianomarvel-download.lock";

export interface MuseScoreDownloadReservation {
  dir: string;
  compositionSlug: string;
  release: () => void;
}

/**
 * Атомарно занимает каталог композиции. Одной проверки `existsSync` недостаточно:
 * два параллельных job могли одновременно выбрать один свободный путь и смешать
 * MXL/MID/MP3 разных редакций. Exclusive-create lock делает выбор взаимно
 * исключающим и между разными процессами.
 */
export function reserveAvailableMuseScoreDownloadDir(
  author: string,
  composition: string,
  scoreId: string,
  root = MUSESCORE_SHEETS_ROOT,
): MuseScoreDownloadReservation {
  const authorSlug = sanitizeBase(author || "unknown");
  const baseSlug = sanitizeBase(composition || "untitled");
  const identity = sanitizeBase(scoreId || "edition");

  for (let edition = 0; ; edition += 1) {
    const suffix = edition === 0
      ? ""
      : edition === 1
        ? `-${identity}`
        : `-${identity}-${edition}`;
    const compositionSlug = `${baseSlug}${suffix}`;
    const dir = resolveMuseScoreDownloadDir(authorSlug, compositionSlug, root);
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length > 0) continue;

    const lockPath = join(dir, DOWNLOAD_RESERVATION_FILE);
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }

    // Защита от старого писателя, который ещё не использовал reservation:
    // если файл появился между readdir и exclusive lock, этот путь не занимаем.
    const foreignEntries = readdirSync(dir).filter(
      (name) => name !== DOWNLOAD_RESERVATION_FILE,
    );
    if (foreignEntries.length > 0) {
      unlinkSync(lockPath);
      continue;
    }

    let released = false;
    return {
      dir,
      compositionSlug,
      release: () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
  }
}

interface ScorePageMeta {
  title?: string;
  composer?: string;
  artist?: string;
  arranger?: string;
}

/** Разбирает заголовок вида «Birds - Imagine Dragons | Piano». */
export function parseScoreHeading(raw: string): Pick<ScorePageMeta, "title" | "composer" | "artist"> {
  const head = raw.split("|")[0]?.trim() ?? raw.trim();
  if (!head) return {};

  const dashParts = head.split(/\s[-–—]\s/);
  if (dashParts.length >= 2) {
    const title = dashParts[0]?.trim();
    const performer = dashParts.slice(1).join(" - ").trim();
    return {
      title: title || head,
      composer: performer || undefined,
      artist: performer || undefined,
    };
  }

  const byMatch = head.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    const performer = byMatch[2].trim();
    return {
      title: byMatch[1].trim(),
      composer: performer,
      artist: performer,
    };
  }

  return { title: head };
}

function authorSlugFromMeta(meta: ScorePageMeta, fallback = "unknown"): string {
  // Только композитор/исполнитель — не uploader («muse group») и не arranger.
  const raw = meta.composer?.trim() || meta.artist?.trim() || fallback;
  return sanitizeBase(raw || "unknown");
}

/** Сливает метаданные: API приоритетнее JSON, DOM-заголовок — главный для title. */
function resolveScoreMeta(pageMeta: ScorePageMeta, apiMeta: ScorePageMeta): ScorePageMeta {
  const composer =
    apiMeta.composer || pageMeta.composer || apiMeta.artist || pageMeta.artist;
  const artist = apiMeta.artist || pageMeta.artist || composer;
  return {
    title: pageMeta.title || apiMeta.title,
    composer,
    artist,
    arranger: apiMeta.arranger || pageMeta.arranger,
  };
}

/** Первое непустое значение — сведения приходят из нескольких источников разом. */
export function firstUsable(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** Заведомо бесполезные «авторы»: заглушки MuseScore и служебные значения. */
const CREDIT_NOISE = /^(unknown|various|traditional|anonymous|misc|n\/?a|muse\s*group|musescore)$/i;

/**
 * Выбирает автора для папки. Отбрасывает служебные заглушки и — главное — значение,
 * совпадающее с названием: на MuseScore поле «композитор» заполняет загрузивший, и
 * там часто оказывается имя песни, из-за чего появлялись папки вроде `radioactive`
 * вместо папки автора.
 */
export function pickAuthorCredit(
  candidates: Array<string | undefined>,
  title: string,
): string | undefined {
  const titleSlug = sanitizeBase(title);
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value || CREDIT_NOISE.test(value)) continue;
    const slug = sanitizeBase(value);
    if (!slug || slug === "unknown") continue;
    if (titleSlug && slug === titleSlug) continue;
    return value;
  }
  return undefined;
}

/** Перенос файла с запасным путём для случая разных томов. */
export function moveFile(from: string, to: string): void {
  if (from === to) return;
  if (existsSync(to)) {
    throw new Error(`Целевой файл уже существует: ${to}`);
  }
  ensureDownloadDir(to);
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/**
 * Убирает опустевшую подпапку композиции и, если нужно, опустевшую папку автора.
 * Корень библиотеки никогда не удаляется.
 */
export function removeEmptyAuthorDir(
  dir: string,
  root = MUSESCORE_SHEETS_ROOT,
): void {
  let current = dir;
  const childPrefix = `${root}${sep}`;
  while (current.startsWith(childPrefix)) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

/**
 * Приводит раскладку к виду «автор / название» по сведениям из самой партитуры.
 *
 * Папка выбирается до скачивания, когда файла ещё нет, поэтому автор берётся со
 * страницы MuseScore — а его там заполняет загрузивший. `<work-title>` и
 * `<creator type="composer">` в MusicXML пишет тот, кто набирал ноты, и это самый
 * надёжный источник: именно из-за обратного приоритета «Piano Major Scales
 * Fingerings» Симоне Дальи Орти оказывались в `unknown/major-scales-chords-and-arpeggios`.
 */
async function reconcileFetchedLayout(
  result: MuseScoreFetchResult,
  onProgress: ProgressFn,
): Promise<void> {
  const xmlPath = result.files.mxl;
  if (!xmlPath || !existsSync(xmlPath)) return;
  const analysis = await analyzeScoreFile(xmlPath).catch((error) => {
    log.warn("musescore: не удалось прочитать сведения из партитуры", error);
    return undefined;
  });
  if (!analysis) return;

  const title = firstUsable(analysis.title, result.title, result.baseName);
  const author = pickAuthorCredit(
    [analysis.composer, analysis.artist, result.composer, result.artist],
    title,
  );
  result.title = title || result.title;
  if (author) result.composer = author;
  result.artist = firstUsable(analysis.artist, result.artist, author);

  const nextBase = sanitizeBase(title);
  const nextAuthorSlug = sanitizeBase(author ?? "unknown");
  if (!nextBase || (nextBase === result.baseName && nextAuthorSlug === result.authorSlug)) {
    return;
  }
  const previousDir = result.dir;
  const target = reserveAvailableMuseScoreDownloadDir(
    nextAuthorSlug,
    nextBase,
    result.scoreId,
  );
  const nextDir = target.dir;
  const moves = (Object.entries(result.files) as Array<[MuseScoreFormat, string]>)
    .filter((entry): entry is [MuseScoreFormat, string] => Boolean(entry[1]))
    .filter(([, from]) => existsSync(from))
    .map(([format, from]) => ({
      format,
      from,
      to: join(nextDir, `${nextBase}${extname(from)}`),
    }));
  const completed: typeof moves = [];
  try {
    for (const move of moves) {
      moveFile(move.from, move.to);
      completed.push(move);
    }
    for (const move of moves) {
      result.files[move.format] = move.to;
    }
  } catch (error) {
    log.warn(
      `musescore: комплект не перенесён в ${nextDir}; откатываю ${completed.length} файлов`,
      error,
    );
    for (const move of completed.reverse()) {
      try {
        moveFile(move.to, move.from);
      } catch (rollbackError) {
        log.error(`musescore: не удалось откатить ${move.to} → ${move.from}`, rollbackError);
      }
    }
    for (const move of moves) {
      if (existsSync(move.from)) result.files[move.format] = move.from;
      else if (existsSync(move.to)) result.files[move.format] = move.to;
    }
    result.warnings.push(
      `Не удалось атомарно перенести комплект в ${nextDir}; исходная раскладка сохранена.`,
    );
    return;
  } finally {
    target.release();
    removeEmptyAuthorDir(nextDir);
  }
  result.dir = nextDir;
  result.baseName = nextBase;
  result.authorSlug = nextAuthorSlug;
  result.compositionSlug = target.compositionSlug;
  removeEmptyAuthorDir(previousDir);
  log.info(
    `musescore: раскладка по сведениям партитуры → ${nextAuthorSlug}/${nextBase}` +
      `${author ? ` (автор: ${author})` : " (автор неизвестен)"}`,
  );
  onProgress(97, `Сведения из партитуры: ${title}${author ? ` · ${author}` : ""}`);
}

function ensureDownloadDir(destPath: string): void {
  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Колбэк прогресса: (0..100, человекочитаемое сообщение). */
export type ProgressFn = (progress: number, message: string) => void;

const FORMAT_TITLE: Record<MuseScoreFormat, string> = {
  pdf: "PDF",
  mxl: "MusicXML",
  midi: "MIDI",
  mp3: "аудио",
};

/** Ставит блокировку window.open только на страницу скачивания, не на общий контекст. */
export async function installMuseScoreWindowOpenGuard(
  page: Pick<Page, "addInitScript">,
): Promise<void> {
  await page.addInitScript(() => {
    const nativeOpen = window.open.bind(window);
    window.open = (url, target, features) => {
      const href = url == null ? "" : String(url);
      if (/musescore\.org/i.test(href)) return null;
      return nativeOpen(url, target, features);
    };
  });
}

/**
 * Заходит на страницу ноты и по одному скачивает нужные форматы, сохраняя все под
 * единым базовым именем в MUSESCORE_DOWNLOAD_DIR (§5 PRD, шаг 5). Недоступные
 * форматы (paywall/PRO/скачивание отключено автором) не роняют весь процесс —
 * попадают в `skipped` (§5 шаг 7, R7 PRD). onProgress отдаёт шаги в UI-тост и в лог.
 */
export async function fetchMuseScoreFiles(
  scoreUrl: string,
  options: FetchOptions = {},
  onProgress: ProgressFn = () => {},
): Promise<MuseScoreFetchResult> {
  const formats = options.formats ?? WANTED_FORMATS;
  const scoreId = scoreUrl.match(/\/scores\/(\d+)/)?.[1] ?? "";

  const context = await getContext();
  // Патч ограничен страницей скачивания и исчезает вместе с ней. Контекстный
  // init-script накапливался после каждого скачивания и затрагивал Piano Marvel.
  const page = await context.newPage();
  await installMuseScoreWindowOpenGuard(page);
  // Контекстный route оставлен намеренно: реклама открывается в новой popup-странице,
  // поэтому page.route не может перехватить её первый запрос.
  await context.route(/musescore\.org/i, (route) => route.abort().catch(() => undefined));
  await page.route(/musescore\.org/i, (route) => route.abort().catch(() => undefined));
  const detachOrgGuard = attachOrgPopupGuard(context, page);
  // «Radioactive - Imagine Dragons | Piano» — это название плюс исполнитель в одной
  // строке. Название идёт в имя файла, исполнитель — в кандидаты на автора папки.
  const heading = options.baseName?.trim() ? parseScoreHeading(options.baseName) : undefined;
  let baseName = heading?.title
    ? sanitizeBase(heading.title)
    : slugFromUrl(scoreUrl, scoreId || "musescore-score");
  let authorSlug = sanitizeBase(
    options.author?.trim() ||
      pickAuthorCredit([heading?.artist], heading?.title ?? "") ||
      "unknown",
  );
  let compositionSlug = baseName;
  let downloadDir = resolveMuseScoreDownloadDir(authorSlug, compositionSlug);
  let downloadReservation: MuseScoreDownloadReservation | undefined;

  const result: MuseScoreFetchResult = {
    scoreId,
    baseName,
    authorSlug,
    compositionSlug,
    dir: downloadDir,
    files: {},
    skipped: [],
    warnings: [],
    readyForPipeline: false,
  };

  try {
    onProgress(10, "Открываю страницу ноты…");
    await installMuseScoreResponseWorkaround(page);
    const collector = attachGenerateCollector(page);
    try {
      await page.goto(scoreUrl, { waitUntil: "load", timeout: 45_000 });
      await page.unroute("**/api/score/**").catch(() => undefined);
      // Проверку Cloudflare нужно распознать до ожидания элементов страницы: иначе
      // ожидание кнопки Download упирается в свой потолок и падает непонятной ошибкой.
      if (await awaitHumanVerification(page, onProgress, 12)) {
        await page.waitForLoadState("load").catch(() => undefined);
      }
      await waitForScorePageReady(page);
      await dismissBlockingOverlays(page);
      await waitForDownloadButton(page);
    } finally {
      collector.detach();
    }

    const pageMeta = await extractScoreMetaFromPage(page, scoreId);
    const apiMeta = await fetchScoreMetaFromApi(page, scoreId);
    const resolvedMeta = resolveScoreMeta(pageMeta, apiMeta);

    if (resolvedMeta.title && !options.baseName?.trim()) {
      baseName = sanitizeBase(resolvedMeta.title);
      result.baseName = baseName;
      compositionSlug = baseName;
      result.compositionSlug = compositionSlug;
    }
    if (!options.author?.trim()) {
      authorSlug = authorSlugFromMeta(resolvedMeta);
      result.authorSlug = authorSlug;
    }
    result.title = resolvedMeta.title;
    result.composer = resolvedMeta.composer;
    result.artist = resolvedMeta.artist;
    const target = reserveAvailableMuseScoreDownloadDir(
      authorSlug,
      compositionSlug,
      scoreId,
    );
    downloadReservation = target;
    downloadDir = target.dir;
    compositionSlug = target.compositionSlug;
    result.dir = downloadDir;
    result.compositionSlug = compositionSlug;

    onProgress(22, "Открываю окно Download и проверяю доступ…");
    const prefetchedUrls = {
      ...collector.urls,
      ...(await harvestGenerateUrls(page)),
      ...(await fetchScoreApiUrls(page, scoreId)),
    };

    const access = await checkDownloadAccess(page, collector.hasAccess);
    if (access === "denied") {
      for (const format of formats) {
        result.skipped.push({
          format,
          reason: "нет доступа к скачиванию (нужна активная подписка PRO)",
        });
      }
      result.warnings.push(
        "MuseScore сообщил has_access=0 — этот скор требует активной подписки PRO " +
          "или входа в аккаунт. Войдите в MuseScore и повторите либо выберите другой результат.",
      );
      onProgress(100, "Нет доступа к скачиванию (нужна подписка/вход).");
      return result;
    }

    const modalReady = await isDownloadModalOpen(page);
    if (!modalReady) {
      await openDownloadModal(page);
    }

    for (let i = 0; i < formats.length; i++) {
      const format = formats[i];
      const base = 30 + Math.round((i / formats.length) * 65);
      onProgress(base, `Скачиваю ${FORMAT_TITLE[format]}…`);
      const dest = join(downloadDir, `${baseName}.${FORMAT_EXT[format]}`);
      try {
        if (existsSync(dest)) {
          throw new Error(`Файл другой редакции уже существует: ${dest}`);
        }
        let saved: DownloadOutcome = "failed";
        const prefetched = prefetchedUrls[format];
        // PDF: generate-URL активируется только кликом в модалке, prefetch не используем.
        if (prefetched && format !== "pdf" && (await saveFromGenerateUrl(page, prefetched, dest, format))) {
          saved = "ok";
        } else {
          saved = await downloadOneFormat(page, format, dest, prefetchedUrls);
        }
        if (saved === "no-item") {
          result.skipped.push({ format, reason: "пункт формата не найден в окне Download" });
          continue;
        }
        if (saved === "failed") {
          result.skipped.push({ format, reason: "файл не получен после клика по формату" });
          continue;
        }
        ensureDownloadDir(dest);
        result.files[format] = dest;
        log.info(`musescore: ${format} → ${dest}`);
      } catch (error) {
        result.skipped.push({ format, reason: cleanReason(error) });
        log.warn(`musescore: формат ${format} не скачался`, error);
      }
    }

    // Сведения из партитуры сильнее сведений со страницы: раскладка «автор/название»
    // выравнивается уже по скачанному файлу.
    await reconcileFetchedLayout(result, onProgress);

    result.readyForPipeline = REQUIRED_FORMATS.every((f) => Boolean(result.files[f]));

    if (Object.keys(result.files).length === 0) {
      result.warnings.push(
        "Ни один формат не удалось скачать. Вероятные причины: не выполнен вход в " +
          "MuseScore, скор требует подписки PRO, автор отключил загрузку, или изменилась " +
          "разметка окна Download (проверьте `bun run scrape:musescore`).",
      );
    } else if (!result.readyForPipeline) {
      const missing = REQUIRED_FORMATS.filter((f) => !result.files[f]).map((f) => FORMAT_TITLE[f]);
      result.warnings.push(
        `Не хватает обязательных форматов (${missing.join(", ")}) — акт III не откроется автоматически.`,
      );
    }

    const gotCount = Object.keys(result.files).length;
    onProgress(
      100,
      result.readyForPipeline
        ? `Скачано ${gotCount} форм(а) — комплект готов для акта III`
        : gotCount
          ? `Скачано форматов: ${gotCount}`
          : "Не удалось скачать ни одного формата",
    );
    return result;
  } catch (error) {
    // Проверка Cloudflare может появиться и посреди скачивания. Тогда нужно прямо
    // сказать, что от человека требуется подтверждение, а не отдавать служебную
    // ошибку Playwright про закрытую страницу.
    const blocked = await page.evaluate(humanCheckProbe).catch(() => false);
    if (blocked) {
      throw new Error(
        "MuseScore показал проверку «Verify you are human». Подтвердите её в открытом окне " +
          "Chrome и повторите скачивание — пройденная проверка сохранится в профиле.",
      );
    }
    throw describePageLoss(error);
  } finally {
    const reservedDir = downloadReservation?.dir;
    downloadReservation?.release();
    if (reservedDir) removeEmptyAuthorDir(reservedDir);
    detachOrgGuard();
    await context.unroute(/musescore\.org/i).catch(() => undefined);
    await page.close().catch(() => undefined);
  }
}

/** Закрываем рекламные вкладки musescore.org — открываются при Download и мешают. */
function attachOrgPopupGuard(context: BrowserContext, mainPage: Page): () => void {
  const timers = new Set<ReturnType<typeof setInterval>>();

  const onPage = (popup: Page) => {
    if (popup === mainPage) return;

    const closeIfOrg = () => {
      if (popup.isClosed()) return true;
      if (!/musescore\.org/i.test(popup.url())) return false;
      log.debug(`musescore: закрываю лишнюю вкладку ${popup.url().slice(0, 100)}`);
      void popup.close().catch(() => undefined);
      return true;
    };

    if (closeIfOrg()) return;

    const timer = setInterval(() => {
      if (closeIfOrg()) {
        clearInterval(timer);
        timers.delete(timer);
      }
    }, 120);
    timers.add(timer);

    popup.on("close", () => {
      clearInterval(timer);
      timers.delete(timer);
    });
  };

  context.on("page", onPage);
  return () => {
    context.off("page", onPage);
    for (const timer of timers) clearInterval(timer);
    timers.clear();
  };
}

/** Читает трекинг-пинг score_download.trc (из коллектора или при открытии модалки). */
async function checkDownloadAccess(
  page: Page,
  knownAccess: boolean | null,
): Promise<"granted" | "denied" | "unknown"> {
  if (knownAccess === false) return "denied";
  if (knownAccess === true) return "granted";

  const pingPromise = page
    .waitForRequest((req) => /score_download\.trc/.test(req.url()), { timeout: 8_000 })
    .then((req) => {
      const hasAccess = new URL(req.url()).searchParams.get("has_access");
      return hasAccess === "0" ? ("denied" as const) : ("granted" as const);
    })
    .catch(() => "unknown" as const);

  await openDownloadModal(page).catch(() => false);
  return pingPromise;
}

interface GenerateCollector {
  urls: Partial<Record<MuseScoreFormat, string>>;
  hasAccess: boolean | null;
  detach: () => void;
}

/**
 * Playwright падает на Set-Cookie с relative URL (/api/score/link?...).
 * Подменяем API-ответы пустым JSON на время goto; реальные данные читаем через fetch в page.
 */
async function installMuseScoreResponseWorkaround(page: Page): Promise<void> {
  await page.route("**/api/score/**", async (route) => {
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      })
      .catch(() => route.abort().catch(() => undefined));
  });
}

/** Собирает signed generate-URL и has_access из сетевых ответов страницы. */
function attachGenerateCollector(page: Page): GenerateCollector {
  const urls: Partial<Record<MuseScoreFormat, string>> = {};
  let hasAccess: boolean | null = null;

  const handler = (resp: Response) => {
    const respUrl = resp.url();
    if (/score_download\.trc/.test(respUrl)) {
      hasAccess = new URL(respUrl).searchParams.get("has_access") !== "0";
    }
    if (respUrl.includes("/score/download/generate") && respUrl.includes("file_type=")) {
      absorbGenerateUrl(respUrl, urls);
    }
  };

  page.on("response", handler);
  return {
    urls,
    get hasAccess() {
      return hasAccess;
    },
    detach: () => page.off("response", handler),
  };
}

function formatFromFileType(fileType: string | null): MuseScoreFormat | null {
  if (fileType === "mxl" || fileType === "midi" || fileType === "mp3" || fileType === "pdf") {
    return fileType;
  }
  return null;
}

function absorbGenerateUrl(rawUrl: string, out: Partial<Record<MuseScoreFormat, string>>): void {
  try {
    const url = rawUrl.startsWith("http") ? rawUrl : `https://musescore.com${rawUrl}`;
    const format = formatFromFileType(new URL(url).searchParams.get("file_type"));
    if (format) out[format] = url;
  } catch {
    /* некорректный URL */
  }
}

function extractGenerateUrlsFromJson(
  node: unknown,
  out: Partial<Record<MuseScoreFormat, string>>,
  depth = 0,
): void {
  if (depth > 16 || node == null) return;
  if (typeof node === "string") {
    if (node.includes("/score/download/generate") && node.includes("file_type=")) {
      absorbGenerateUrl(node, out);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) extractGenerateUrlsFromJson(item, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) {
      extractGenerateUrlsFromJson(value, out, depth + 1);
    }
  }
}

/** Ищет signed generate-URL во встроенном JSON страницы. */
async function harvestGenerateUrls(page: Page): Promise<Partial<Record<MuseScoreFormat, string>>> {
  return page.evaluate(() => {
    const found: Record<string, string> = {};
    const absorb = (blob: string) => {
      const re = /https?:\/\/[^"'\\]*\/score\/download\/generate[^"'\\]*/g;
      for (const m of blob.matchAll(re)) {
        const url = m[0];
        const ft = url.match(/file_type=(mxl|midi|mp3|pdf)/)?.[1];
        if (ft) found[ft] = url;
      }
    };
    document.querySelectorAll("div.js-store[data-content]").forEach((el) => {
      absorb(el.getAttribute("data-content") ?? "");
    });
    const nextData = document.getElementById("__NEXT_DATA__");
    if (nextData?.textContent) absorb(nextData.textContent);
    document.querySelectorAll('script[type="application/json"]').forEach((el) => {
      if (el.textContent) absorb(el.textContent);
    });
    return found;
  });
}

/** Запрашивает score API в той же сессии и вытаскивает generate-URL из JSON. */
async function fetchScoreApiUrls(
  page: Page,
  scoreId: string,
): Promise<Partial<Record<MuseScoreFormat, string>>> {
  const out: Partial<Record<MuseScoreFormat, string>> = {};
  const endpoints = [
    `https://musescore.com/api/score/link?full_models=1&id=${scoreId}`,
    `https://musescore.com/api/score/view?id=${scoreId}`,
  ];
  for (const endpoint of endpoints) {
    try {
      const json = await page.evaluate(async (url) => {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) return null;
        const text = await resp.text();
        if (!text.trim()) return null;
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      }, endpoint);
      if (json) extractGenerateUrlsFromJson(json, out);
    } catch {
      /* API недоступен — пробуем следующий */
    }
  }
  return out;
}

async function saveFromGenerateUrl(
  page: Page,
  url: string,
  destPath: string,
  format?: MuseScoreFormat,
): Promise<boolean> {
  const fileType = format ?? (url.includes("file_type=pdf") ? "pdf" : undefined);
  if (fileType === "pdf") return savePdfFromGenerateUrl(page, url, destPath);
  try {
    const saved = await page.evaluate(async (downloadUrl) => {
      const resp = await fetch(downloadUrl, { credentials: "include" });
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      if (buf.byteLength < 32) return null;
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      return btoa(binary);
    }, url);
    if (!saved) {
      log.warn(`musescore: generate fetch failed для ${url.slice(0, 140)}`);
      return false;
    }
    ensureDownloadDir(destPath);
    writeFileSync(destPath, Buffer.from(saved, "base64"));
    return true;
  } catch (error) {
    log.warn(`musescore: generate download failed`, error);
    return false;
  }
}

/** PDF генерируется асинхронно: generate-URL сначала отдаёт HTML «Your score is ready». */
async function savePdfFromGenerateUrl(page: Page, url: string, destPath: string): Promise<boolean> {
  if (/\/score\/download\/generate/i.test(url)) {
    return downloadPdfViaReadyPage(page, url, destPath);
  }
  try {
    const saved = await page.evaluate(async (downloadUrl) => {
      const absolute = downloadUrl.startsWith("http")
        ? downloadUrl
        : `${location.origin}${downloadUrl}`;
      const resp = await fetch(absolute, { credentials: "include" });
      if (!resp.ok) return null;
      const ct = resp.headers.get("content-type") ?? "";
      if (ct.includes("text/html")) return null;
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (
        buf.length >= 4 &&
        buf[0] === 0x25 &&
        buf[1] === 0x50 &&
        buf[2] === 0x44 &&
        buf[3] === 0x46
      ) {
        let binary = "";
        for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
        return btoa(binary);
      }
      return null;
    }, url);
    if (!saved) return false;
    ensureDownloadDir(destPath);
    writeFileSync(destPath, Buffer.from(saved, "base64"));
    return true;
  } catch (error) {
    log.warn(`musescore: PDF download failed`, error);
    return false;
  }
}

/** Открывает generate-страницу PDF, ждёт «Ready to download» и сохраняет файл. */
async function downloadPdfViaReadyPage(page: Page, url: string, destPath: string): Promise<boolean> {
  const absolute = url.startsWith("http") ? url : `https://musescore.com${url}`;
  const popup = await page.context().newPage();
  try {
    await popup.goto(absolute, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return await clickPdfReadyAndSave(popup, destPath, DOWNLOAD_CEILING_MS.pdf);
  } catch (error) {
    log.warn(`musescore: PDF ready-page flow failed`, error);
    return false;
  } finally {
    await popup.close().catch(() => undefined);
  }
}

/** Ждёт «Your score is ready», кликает «Ready to download», сохраняет PDF. */
async function clickPdfReadyAndSave(popup: Page, destPath: string, ceiling: number): Promise<boolean> {
  const started = Date.now();
  const remaining = () => Math.max(5_000, ceiling - (Date.now() - started));

  await popup
    .waitForFunction(
      () => /your score is ready|ready to download/i.test(document.body?.innerText ?? ""),
      { timeout: remaining() },
    )
    .catch(() => undefined);

  const readyBtn = popup
    .getByRole("button", { name: /ready to download/i })
    .first()
    .or(popup.getByRole("link", { name: /ready to download/i }).first());
  await readyBtn.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);

  const saveBuffer = (body: Buffer): true => {
    ensureDownloadDir(destPath);
    writeFileSync(destPath, body);
    return true;
  };

  const waitForPdfResponse = (): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        popup.off("response", onResp);
        reject(new Error("pdf response timeout"));
      }, remaining());
      const onResp = async (resp: Response) => {
        try {
          if (!resp.ok()) return;
          const body = Buffer.from(await resp.body());
          if (!isValidGenerateBody("pdf", body)) return;
          clearTimeout(timer);
          popup.off("response", onResp);
          resolve(body);
        } catch {
          /* ждём следующий ответ */
        }
      };
      popup.on("response", onResp);
    });

  const waitForAnyDownload = (): Promise<true> =>
    popup
      .context()
      .waitForEvent("download", { timeout: remaining() })
      .then(async (download) => {
        ensureDownloadDir(destPath);
        await download.saveAs(destPath);
        return true as const;
      });

  const pollCurrentUrlForPdf = (): Promise<Buffer> =>
    popup.evaluate(async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const resp = await fetch(location.href, { credentials: "include" });
          if (resp.ok) {
            const buf = new Uint8Array(await resp.arrayBuffer());
            if (
              buf.length >= 4 &&
              buf[0] === 0x25 &&
              buf[1] === 0x50 &&
              buf[2] === 0x44 &&
              buf[3] === 0x46
            ) {
              let binary = "";
              for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
              return btoa(binary);
            }
          }
        } catch {
          /* сервер ещё отдаёт HTML вместо PDF */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      return null;
    }, remaining()).then((saved) => {
      if (!saved) throw new Error("pdf poll timeout");
      return Buffer.from(saved, "base64");
    });

  const clicked =
    (await readyBtn.click({ timeout: 10_000 }).then(() => true).catch(() => false)) ||
    (await popup.evaluate(() => {
      const fire = (el: HTMLElement) => {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        el.click();
      };
      for (const el of Array.from(document.querySelectorAll("button, a, [role='button']"))) {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!/ready to download/i.test(text)) continue;
        const html = el as HTMLElement;
        const r = html.getBoundingClientRect();
        if (r.width < 16 || r.height < 8) continue;
        fire(
          html.matches("button,a,[role='button']")
            ? html
            : ((html.closest("button,a,[role='button']") as HTMLElement) ?? html),
        );
        return true;
      }
      return false;
    }));

  if (!clicked) {
    log.warn("musescore: кнопка Ready to download не найдена на PDF-странице");
    return false;
  }

  log.info("musescore: кликнули Ready to download, ждём PDF…");

  try {
    const winner = await Promise.race([
      waitForPdfResponse().then(saveBuffer),
      waitForAnyDownload(),
      pollCurrentUrlForPdf().then(saveBuffer),
    ]);
    return Boolean(winner);
  } catch (error) {
    log.warn("musescore: PDF не скачался после клика Ready to download", error);
    return false;
  }
}

function isValidGenerateBody(fileType: string, body: Buffer): boolean {
  if (body.length < 32) return false;
  if (fileType === "pdf") return body.subarray(0, 4).toString() === "%PDF";
  if (fileType === "midi") return body.subarray(0, 4).toString() === "MThd";
  if (fileType === "mxl") {
    return body[0] === 0x50 && body[1] === 0x4b
      ? true
      : body.subarray(0, 5).toString().includes("<?xml");
  }
  return true;
}

async function logDownloadDiagnostics(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((patternSource) => {
    const re = new RegExp(patternSource, "i");
    const controls = Array.from(document.querySelectorAll("button, a, [role='button']"))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 50),
        aria: el.getAttribute("aria-label") ?? "",
        right: Math.round(el.getBoundingClientRect().right),
        visible: (() => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })(),
      }))
      .filter((c) => c.visible && (re.test(c.text) || re.test(c.aria)));
    return {
      title: document.title,
      url: location.href,
      bodySample: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 280),
      downloadCandidates: controls.slice(0, 8),
      hasModalTitle: /download this score|скачать/i.test(document.body?.innerText ?? ""),
    };
  }, DOWNLOAD_TRIGGER_NAME.source);
}

/** Ждём гидратацию страницы ноты (React + данные скора). */
async function waitForScorePageReady(page: Page): Promise<void> {
  await Promise.race([
    page.waitForResponse((r) => /\/api\/score\//.test(r.url()) && r.ok(), { timeout: 25_000 }),
    page.waitForResponse((r) => /score_download\.trc/.test(r.url()), { timeout: 25_000 }),
  ]).catch(() => undefined);
  await waitForDownloadButton(page);
}

/** Ждём появления кнопки Download в DOM (sidebar или aria-label). */
async function waitForDownloadButton(page: Page): Promise<boolean> {
  return page
    .waitForFunction(
      (patternSource) => {
        const re = new RegExp(patternSource, "i");
        const match = (el: Element) => {
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          const aria = el.getAttribute("aria-label") ?? "";
          const title = el.getAttribute("title") ?? "";
          return re.test(text) || re.test(aria) || re.test(title);
        };
        for (const el of Array.from(document.querySelectorAll("button, a, [role='button']"))) {
          if (!match(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 16 || r.height < 8) continue;
          return true;
        }
        return false;
      },
      DOWNLOAD_TRIGGER_NAME.source,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false);
}

/** Закрываем cookie/consent-баннеры, если они перекрывают кнопки. */
async function dismissBlockingOverlays(page: Page): Promise<void> {
  const consent = page
    .getByRole("button", { name: /accept|agree|allow all|принять|соглас/i })
    .first();
  if (await consent.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await consent.click({ timeout: 3_000 }).catch(() => undefined);
  }
}


/**
 * Аварийный потолок ожидания ручного подтверждения «я человек». Завершение
 * определяет состояние страницы — исчезновение виджета проверки, — а не время.
 */
const HUMAN_CHECK_CAP_MS = (() => {
  const value = Number(process.env.MUSESCORE_HUMAN_CHECK_CAP_MS);
  return Number.isFinite(value) && value > 0 ? value : 300_000;
})();

/**
 * Признаки страницы проверки Cloudflare. Только чтение состояния: ни виджет, ни
 * галочку автоматизация не трогает — подтверждает человек в открытом окне Chrome.
 */
function humanCheckProbe(): boolean {
  const widget = document.querySelector(
    '#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, [id^="cf-chl-widget"], iframe[src*="challenges.cloudflare.com"]',
  );
  const title = (document.title ?? "").toLowerCase();
  const text = (document.body?.innerText ?? "").slice(0, 4000).toLowerCase();
  const wording =
    /just a moment|verify you are human|needs to review the security of your connection|один момент|подтвердите, что вы человек|проверка безопасности/;
  return Boolean(widget) || wording.test(title) || wording.test(text);
}

/**
 * Если MuseScore показал проверку Cloudflare — отдаём управление человеку: окно
 * поднимается на передний план, задача сообщает, что ждёт подтверждения, и сама
 * продолжается, когда проверка пройдена. Решением служит состояние страницы, а
 * пройденная проверка остаётся в постоянном профиле Chrome, поэтому подтверждать
 * приходится один раз, а не на каждую ноту.
 */
async function awaitHumanVerification(
  page: Page,
  onProgress: (percent: number, message: string) => void,
  percent: number,
): Promise<boolean> {
  const present = await page.evaluate(humanCheckProbe).catch(() => false);
  if (!present) return false;
  log.warn("musescore: показана проверка Cloudflare — жду подтверждения человеком");
  onProgress(
    percent,
    "MuseScore просит подтвердить, что вы человек: подтвердите в открытом окне Chrome…",
  );
  await focusChrome().catch(() => undefined);
  await page.waitForFunction(
    () => {
      const widget = document.querySelector(
        '#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, [id^="cf-chl-widget"], iframe[src*="challenges.cloudflare.com"]',
      );
      const title = (document.title ?? "").toLowerCase();
      const text = (document.body?.innerText ?? "").slice(0, 4000).toLowerCase();
      const wording =
        /just a moment|verify you are human|needs to review the security of your connection|один момент|подтвердите, что вы человек|проверка безопасности/;
      return !widget && !wording.test(title) && !wording.test(text);
    },
    undefined,
    { timeout: HUMAN_CHECK_CAP_MS },
  );
  log.info("musescore: проверка пройдена — продолжаю скачивание");
  onProgress(percent, "Проверка пройдена, продолжаю…");
  return true;
}

/** Понятное сообщение вместо служебной ошибки Playwright о закрытой странице. */
function describePageLoss(error: unknown): Error {
  const text = String(error);
  if (/Target page, context or browser has been closed|Target closed/i.test(text)) {
    return new Error(
      "Окно управляемого Chrome закрылось во время скачивания. Если MuseScore показывал " +
        "проверку «Verify you are human», подтвердите её в этом окне и не закрывайте его — " +
        "пройденная проверка сохранится в профиле.",
    );
  }
  return error instanceof Error ? error : new Error(text);
}

/** Метаданные скора через API в контексте страницы (куки сессии). */
async function fetchScoreMetaFromApi(page: Page, scoreId: string): Promise<ScorePageMeta> {
  return page.evaluate(async (id) => {
    const meta: { title?: string; composer?: string; artist?: string; arranger?: string } = {};
    const endpoints = [
      `https://musescore.com/api/score/link?full_models=1&id=${id}`,
      `https://musescore.com/api/score/view?id=${id}`,
    ];
    const visited = new Set<unknown>();
    const walk = (node: unknown, depth: number): void => {
      if (depth > 14 || node == null || typeof node !== "object") return;
      if (visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        node.forEach((n) => walk(n, depth + 1));
        return;
      }
      const o = node as Record<string, unknown>;
      const nodeId = o.id ?? o.scoreId ?? o.nid;
      const matches = nodeId != null && String(nodeId) === id;
      if (matches) {
        if (typeof o.title === "string" && o.title.trim()) meta.title = o.title.trim();
        const composerRaw = (o.composer_name ?? o.composer ?? o.artist) as string | undefined;
        if (typeof composerRaw === "string" && composerRaw.trim()) {
          meta.composer = composerRaw.split("\n")[0]?.replace(/\s*arr\.:.*/i, "").trim();
        }
        if (typeof o.artist === "string" && o.artist.trim()) {
          meta.artist = o.artist.trim();
          if (!meta.composer) meta.composer = meta.artist;
        }
        const user = (o.user ?? {}) as Record<string, unknown>;
        if (typeof user.name === "string" && user.name.trim()) meta.arranger = user.name.trim();
      }
      for (const value of Object.values(o)) walk(value, depth + 1);
    };
    for (const url of endpoints) {
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) continue;
        const text = await resp.text();
        if (!text.trim()) continue;
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          continue;
        }
        walk(data, 0);
        if (meta.composer || meta.title) break;
      } catch {
        /* пробуем следующий endpoint */
      }
    }
    return meta;
  }, scoreId);
}

/** Метаданные скора из встроенного JSON/DOM страницы ноты. */
async function extractScoreMetaFromPage(page: Page, scoreId: string): Promise<ScorePageMeta> {
  const jsonMeta = await page.evaluate((expectedId) => {
    const meta: { title?: string; composer?: string; artist?: string; arranger?: string } = {};
    const blobs: string[] = [];
    document
      .querySelectorAll("div.js-store[data-content]")
      .forEach((el) => blobs.push(el.getAttribute("data-content") ?? ""));
    const nextData = document.getElementById("__NEXT_DATA__");
    if (nextData?.textContent) blobs.push(nextData.textContent);
    document
      .querySelectorAll('script[type="application/json"]')
      .forEach((el) => el.textContent && blobs.push(el.textContent));

    const visited = new Set<unknown>();
    const walk = (node: unknown, depth: number): void => {
      if (depth > 14 || node == null || typeof node !== "object") return;
      if (visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        node.forEach((n) => walk(n, depth + 1));
        return;
      }
      const o = node as Record<string, unknown>;
      const id = o.id ?? o.scoreId ?? o.nid;
      if (expectedId && id != null && String(id) === expectedId) {
        if (typeof o.title === "string" && o.title.trim()) meta.title = o.title.trim();
        const user = (o.user ?? {}) as Record<string, unknown>;
        if (typeof user.name === "string" && user.name.trim()) meta.arranger = user.name.trim();
        if (typeof o.composer === "string" && o.composer.trim()) meta.composer = o.composer.trim();
        if (typeof o.artist === "string" && o.artist.trim()) {
          meta.artist = o.artist.trim();
          if (!meta.composer) meta.composer = meta.artist;
        }
        const composerName = o.composer_name;
        if (typeof composerName === "string" && composerName.trim() && !meta.composer) {
          meta.composer = composerName.split("\n")[0]?.replace(/\s*arr\.:.*/i, "").trim();
        }
      }
      for (const key of Object.keys(o)) walk(o[key], depth + 1);
    };
    for (const blob of blobs) {
      if (!blob) continue;
      try {
        walk(JSON.parse(blob), 0);
      } catch {
        /* не JSON */
      }
    }
    return meta;
  }, scoreId);

  const h1Raw = await page.locator("h1").first().textContent().catch(() => null);
  const headingMeta = h1Raw ? parseScoreHeading(h1Raw.replace(/\s+/g, " ").trim()) : {};
  const ogTitle = await page
    .locator('meta[property="og:title"]')
    .getAttribute("content")
    .catch(() => null);
  const ogHeading = ogTitle ? parseScoreHeading(ogTitle.split("|")[0]?.trim() ?? ogTitle) : {};

  return {
    title: headingMeta.title || jsonMeta.title || ogHeading.title,
    composer: jsonMeta.composer || headingMeta.composer || ogHeading.composer,
    artist: jsonMeta.artist || headingMeta.artist || ogHeading.artist,
    arranger: jsonMeta.arranger,
  };
}

async function isDownloadModalOpen(page: Page): Promise<boolean> {
  const dialog = page.locator('[role="dialog"]').first();
  if (!(await dialog.isVisible().catch(() => false))) return false;
  const text = await dialog.innerText().catch(() => "");
  return /musicxml|midi|audio|pdf|musescore/i.test(text);
}

interface ClickTargetArgs {
  source: string;
  flags: string;
  scope: "page" | "modal";
  maxLen: number;
}

/** Помечает найденный кликабельный элемент атрибутом для Playwright-клика. */
async function markClickTarget(page: Page, args: ClickTargetArgs): Promise<boolean> {
  return page.evaluate((a) => {
    document.querySelectorAll("[data-ms-click-target]").forEach((el) => {
      el.removeAttribute("data-ms-click-target");
    });
    const pattern = new RegExp(a.source, a.flags.replace("g", ""));

    const findModalRoot = (): HTMLElement | null => {
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"], div, section'),
      )) {
        const t = el.innerText ?? "";
        if (!/download this score|скачать/i.test(t)) continue;
        if (!/musescore|musicxml|midi|audio|pdf/i.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 120 && r.height > 120) return el;
      }
      return null;
    };

    const root =
      a.scope === "modal" ? (findModalRoot() ?? document.body) : document.body;
    const candidates: HTMLElement[] = [];
    for (const el of Array.from(
      root.querySelectorAll<HTMLElement>("button, a, [role='button'], li, div, span"),
    )) {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const aria = (el.getAttribute("aria-label") ?? "").trim();
      const title = (el.getAttribute("title") ?? "").trim();
      if (!text && !aria && !title) continue;
      const primary = text.split(/\s{2,}/)[0]?.trim() ?? text;
      const haystack = `${primary} ${text} ${aria} ${title}`.trim();
      if (!pattern.test(primary) && !pattern.test(haystack)) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      if (a.scope === "page" && /download this score|скачать.*(?:not|нот)/i.test(text)) continue;
      candidates.push(el);
    }

    candidates.sort((x, y) => {
      const pref = (el: HTMLElement) => (el.matches("button,a,[role='button']") ? 0 : 1);
      const dp = pref(x) - pref(y);
      if (dp !== 0) return dp;
      if (a.scope === "page") {
        return y.getBoundingClientRect().right - x.getBoundingClientRect().right;
      }
      const ax = x.getBoundingClientRect().width * x.getBoundingClientRect().height;
      const ay = y.getBoundingClientRect().width * y.getBoundingClientRect().height;
      return ax - ay;
    });

    let target = candidates[0];
    if (!target) return false;
    if (!target.matches("button,a,[role='button'],li")) {
      const parent = target.closest("button,a,[role='button'],li");
      if (parent instanceof HTMLElement) target = parent;
    }
    target.setAttribute("data-ms-click-target", "1");
    return true;
  }, args);
}

async function clickMarkedTarget(page: Page): Promise<boolean> {
  const loc = page.locator('[data-ms-click-target="1"]').first();
  if (!(await loc.count().catch(() => 0))) return false;
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  await loc.click({ timeout: 10_000 }).catch(() => undefined);
  await page
    .evaluate(() => document.querySelector("[data-ms-click-target]")?.removeAttribute("data-ms-click-target"))
    .catch(() => undefined);
  return true;
}

async function clickFormatInModal(page: Page, format: MuseScoreFormat): Promise<boolean> {
  const pattern = FORMAT_LABEL[format].source;
  return page.evaluate((reSource) => {
    const re = new RegExp(reSource, "i");
    const fire = (el: HTMLElement) => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      el.click();
    };
    const roots = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="modal" i], [class*="Modal"]'),
    );
    const searchIn = roots.length ? roots : [document.body];
    for (const root of searchIn) {
      for (const el of Array.from(root.querySelectorAll("button, a, [role='button'], li, div"))) {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        const primary = text.split(/\s{2,}/)[0]?.trim() ?? text;
        if (!re.test(primary) && !re.test(text)) continue;
        const html = el as HTMLElement;
        const r = html.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        fire(html.matches("button,a,[role='button'],li") ? html : (html.closest("button,a,[role='button'],li") as HTMLElement) ?? html);
        return true;
      }
    }
    return false;
  }, pattern);
}

function formatItemLocator(page: Page, format: MuseScoreFormat) {
  const label = FORMAT_LABEL[format];
  const modal = page.locator('[role="dialog"], [class*="modal" i], [class*="Modal"]');
  return modal
    .locator("button, a, [role='button'], li, div")
    .filter({ hasText: label })
    .first()
    .or(page.locator("button, a, [role='button'], li").filter({ hasText: label }).first());
}

async function findFormatTarget(page: Page, format: MuseScoreFormat): Promise<boolean> {
  const item = formatItemLocator(page, format);
  if (await item.isVisible().catch(() => false)) {
    await item.evaluate((el) => el.setAttribute("data-ms-click-target", "1")).catch(() => undefined);
    return true;
  }
  return markClickTarget(page, {
    source: FORMAT_LABEL[format].source,
    flags: FORMAT_LABEL[format].flags,
    scope: "modal",
    maxLen: 80,
  });
}

async function openDownloadModal(page: Page): Promise<boolean> {
  if (await isDownloadModalOpen(page)) return true;
  await page.bringToFront().catch(() => undefined);

  const clicked = await page.evaluate(() => {
    const fire = (el: HTMLElement) => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      el.click();
    };
    const match = (el: Element) => /^download$/i.test((el.textContent ?? "").replace(/\s+/g, " ").trim());
    const candidates: HTMLElement[] = [];
    for (const el of Array.from(document.querySelectorAll("button, a, [role='button']"))) {
      if (!match(el)) continue;
      const html = el as HTMLElement;
      const r = html.getBoundingClientRect();
      if (r.width < 16 || r.height < 8) continue;
      candidates.push(html);
    }
    candidates.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    const target = candidates[0];
    if (!target) return false;
    fire(target);
    return true;
  });
  if (clicked) {
    await page
      .locator('[role="dialog"], [class*="modal" i]')
      .filter({ hasText: /musicxml|midi|audio|pdf/i })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => undefined);
    if (await isDownloadModalOpen(page)) return true;
  }

  const triggers = [
    page.getByRole("button", { name: /^download$/i }),
    page.getByRole("link", { name: /^download$/i }),
    page.locator("button").filter({ hasText: /^Download$/i }),
  ];

  for (const locator of triggers) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const btn = locator.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      await btn.scrollIntoViewIfNeeded().catch(() => undefined);
      await btn.click({ timeout: 10_000, force: true }).catch(() => undefined);
      await page
        .locator('[role="dialog"], [class*="modal" i]')
        .filter({ hasText: /musicxml|midi|audio|pdf/i })
        .first()
        .waitFor({ state: "visible", timeout: 8_000 })
        .catch(() => undefined);
      if (await isDownloadModalOpen(page)) return true;
    }
  }

  const clickedSidebar = await page.evaluate((patternSource) => {
    const re = new RegExp(patternSource, "i");
    const match = (el: Element) => {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const aria = el.getAttribute("aria-label") ?? "";
      return re.test(text) || re.test(aria);
    };
    const candidates: HTMLElement[] = [];
    for (const el of Array.from(document.querySelectorAll("button, a, [role='button']"))) {
      if (!match(el)) continue;
      const html = el as HTMLElement;
      const r = html.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      if (getComputedStyle(html).visibility === "hidden") continue;
      candidates.push(html);
    }
    candidates.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    const target = candidates[0];
    if (!target) return false;
    target.click();
    return true;
  }, DOWNLOAD_TRIGGER_NAME.source);
  if (clickedSidebar) {
    await page.waitForFunction(() => /download this score|скачать/i.test(document.body?.innerText ?? ""), {
      timeout: 12_000,
    }).catch(() => undefined);
    if (await isDownloadModalOpen(page)) return true;
  }

  const viaEvaluate = await markClickTarget(page, {
    source: DOWNLOAD_TRIGGER_EXACT.source,
    flags: DOWNLOAD_TRIGGER_EXACT.flags,
    scope: "page",
    maxLen: 40,
  });
  if (viaEvaluate && (await clickMarkedTarget(page))) {
    await page
      .waitForFunction(
        () => /download this score|musicxml|midi|audio|pdf|musescore/i.test(document.body?.innerText ?? ""),
        { timeout: 12_000 },
      )
      .catch(() => undefined);
    if (await isDownloadModalOpen(page)) return true;
  }

  const trigger = page
    .getByRole("button", { name: DOWNLOAD_TRIGGER_NAME })
    .or(page.getByRole("link", { name: DOWNLOAD_TRIGGER_NAME }))
    .or(page.locator('button[aria-label*="download" i], a[aria-label*="download" i]'))
    .or(page.locator('button[class*="download" i], a[class*="download" i], [data-target*="download" i]'))
    .first();
  const appeared = await trigger
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    log.warn("musescore: кнопка Download не найдена на странице ноты");
    return false;
  }
  await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
  await trigger.click({ timeout: 10_000 }).catch(() => undefined);
  await page
    .waitForFunction(
      () => /download this score|musicxml|midi|audio|pdf|musescore/i.test(document.body?.innerText ?? ""),
      { timeout: 12_000 },
    )
    .catch(() => undefined);
  return isDownloadModalOpen(page);
}

type DownloadOutcome = "ok" | "no-item" | "failed";

/** Первый «ok» побеждает; отдельные reject не обрывают гонку (критично для PDF). */
function raceFirstOk(racers: Promise<DownloadOutcome>[]): Promise<DownloadOutcome> {
  return new Promise((resolve) => {
    if (!racers.length) {
      resolve("failed");
      return;
    }
    let pending = racers.length;
    let settled = false;
    const finish = (result: DownloadOutcome) => {
      if (settled) return;
      if (result === "ok") {
        settled = true;
        resolve("ok");
        return;
      }
      pending--;
      if (pending <= 0) {
        settled = true;
        resolve("failed");
      }
    };
    for (const racer of racers) {
      racer.then(finish).catch(() => finish("failed"));
    }
  });
}

/** PDF: отдельный поток — generate-страница (popup или та же вкладка) → Ready to download. */
async function downloadPdfFormat(page: Page, destPath: string): Promise<DownloadOutcome> {
  if (!(await openDownloadModal(page))) {
    log.warn("musescore: модалка Download не открылась перед pdf");
    return "no-item";
  }

  const ceiling = DOWNLOAD_CEILING_MS.pdf;
  const delivery = waitForPdfDelivery(page.context(), page, ceiling, destPath);

  const clicked =
    (await clickFormatInModal(page, "pdf")) ||
    ((await findFormatTarget(page, "pdf")) && (await clickMarkedTarget(page)));
  if (!clicked) return "no-item";

  log.info("musescore: кликнули PDF в модалке, ждём generate-страницу…");
  return delivery;
}

/** Ждёт generate-страницу PDF на popup или на основной вкладке. */
function waitForPdfDelivery(
  context: BrowserContext,
  opener: Page,
  ceiling: number,
  destPath: string,
): Promise<DownloadOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const touched = new Set<Page>();

    const finish = (result: DownloadOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const timer = setTimeout(() => {
      log.warn("musescore: таймаут ожидания PDF generate-страницы");
      finish("failed");
    }, ceiling);

    const handlePage = (target: Page) => {
      if (touched.has(target)) return;
      touched.add(target);
      void (async () => {
        try {
          await target.waitForURL(/\/score\/download\/generate.*file_type=pdf/i, {
            timeout: Math.min(90_000, ceiling),
          });
        } catch {
          if (!/\/score\/download\/generate.*file_type=pdf/i.test(target.url())) return;
        }
        log.info(`musescore: PDF generate-страница открыта (${target === opener ? "та же вкладка" : "popup"})`);
        const ok = await clickPdfReadyAndSave(target, destPath, ceiling);
        finish(ok ? "ok" : "failed");
      })();
    };

    const onPage = (popup: Page) => handlePage(popup);
    const cleanup = () => {
      clearTimeout(timer);
      context.off("page", onPage);
    };

    context.on("page", onPage);
    handlePage(opener);
  });
}

/**
 * Кликает пункт формата и сохраняет файл. Ждёт download-событие или ответ generate.
 */
async function downloadOneFormat(
  page: Page,
  format: MuseScoreFormat,
  destPath: string,
  knownUrls: Partial<Record<MuseScoreFormat, string>> = {},
): Promise<DownloadOutcome> {
  if (format === "pdf") return downloadPdfFormat(page, destPath);

  const known = knownUrls[format];
  if (known && (await saveFromGenerateUrl(page, known, destPath, format))) return "ok";

  if (!(await openDownloadModal(page))) {
    log.warn(`musescore: модалка Download не открылась перед ${format}`);
    return "no-item";
  }

  const ceiling = DOWNLOAD_CEILING_MS[format];
  const context = page.context();
  const fileType =
    format === "mxl" ? "mxl" : format === "midi" ? "midi" : format === "mp3" ? "mp3" : "pdf";

  const fromPage = page.waitForEvent("download", { timeout: ceiling });
  const fromPopup = waitForPopupDownload(context, page, ceiling);
  const fromGenerate = waitForGenerateFile(context, page, fileType, ceiling, destPath);

  const clicked =
    (await clickFormatInModal(page, format)) ||
    ((await findFormatTarget(page, format)) && (await clickMarkedTarget(page)));
  if (!clicked) return "no-item";

  try {
    return await raceFirstOk([
      fromPage.then(async (download) => {
        ensureDownloadDir(destPath);
        await download.saveAs(destPath);
        return "ok" as const;
      }),
      fromPopup.then(async (download) => {
        ensureDownloadDir(destPath);
        await download.saveAs(destPath);
        return "ok" as const;
      }),
      fromGenerate,
    ]);
  } catch {
    return "failed";
  } finally {
    fromPage.catch(() => undefined);
    fromPopup.catch(() => undefined);
    fromGenerate.catch(() => undefined);
  }
}

/** Ждёт ответ /score/download/generate и пишет тело файла на диск. */
function waitForGenerateFile(
  context: BrowserContext,
  opener: Page,
  fileType: string,
  ceiling: number,
  destPath: string,
): Promise<DownloadOutcome> {
  return new Promise<DownloadOutcome>((resolve, reject) => {
    const handlers = new Map<Page, (resp: Response) => void>();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("generate timeout"));
    }, ceiling);

    const attach = (p: Page) => {
      if (handlers.has(p)) return;
      const handler = async (resp: Response) => {
        const url = resp.url();
        if (!/\/score\/download\/generate/.test(url)) return;
        if (!url.includes(`file_type=${fileType}`)) return;
        if (!resp.ok()) return;
        try {
          const body = Buffer.from(await resp.body());
          if (!isValidGenerateBody(fileType, body)) return;
          ensureDownloadDir(destPath);
          writeFileSync(destPath, body);
          cleanup();
          resolve("ok");
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      handlers.set(p, handler);
      p.on("response", handler);
    };

    const onPage = (popup: Page) => {
      if (popup !== opener) attach(popup);
    };

    const cleanup = () => {
      clearTimeout(timer);
      context.off("page", onPage);
      for (const [p, handler] of handlers) p.off("response", handler);
      handlers.clear();
    };

    attach(opener);
    context.on("page", onPage);
  });
}

/** Ждёт новую вкладку и событие download в ней (паттерн генерации PDF/MP3). */
function waitForPopupDownload(
  context: BrowserContext,
  opener: Page,
  ceiling: number,
): Promise<Download> {
  return new Promise<Download>((resolve, reject) => {
    const timer = setTimeout(() => {
      context.off("page", onPage);
      reject(new Error("popup download timeout"));
    }, ceiling);

    const onPage = (popup: Page) => {
      if (popup === opener) return;
      popup.on("download", (download) => {
        clearTimeout(timer);
        context.off("page", onPage);
        resolve(download);
      });
    };
    context.on("page", onPage);
  });
}

function cleanReason(error: unknown): string {
  return String(error).replace(/^(?:Error|TimeoutError):\s*/i, "").slice(0, 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// Превращение результата скачивания в объект pipeline (тот же, что /api/scan)
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchedFilesLike {
  baseName: string;
  dir: string;
  midi?: string;
  xml?: string;
  pdf?: string;
  image?: string;
  audio: string[];
  extras: string[];
  warnings: string[];
}

export interface ScanPayload {
  files: MatchedFilesLike;
  guess: Record<string, unknown>;
  fetched: MuseScoreFetchResult;
  readyForPipeline: boolean;
}

/**
 * CHANGED: перенесено из index.ts. Приводит результат MuseScore к форме ответа
 * /api/scan ({files, guess}), чтобы дальше работал существующий pipeline без
 * fuzzy-поиска fileMatcher (§5 шаг 6 PRD). mxl→xml, mp3→audio[].
 */
export async function toScanPayload(fetched: MuseScoreFetchResult): Promise<ScanPayload> {
  const warnings = [...fetched.warnings];
  for (const s of fetched.skipped) {
    warnings.push(`Формат ${s.format.toUpperCase()} не скачан: ${s.reason}`);
  }

  const files: MatchedFilesLike = {
    baseName: fetched.baseName,
    dir: fetched.dir,
    midi: fetched.files.midi,
    xml: fetched.files.mxl,
    pdf: fetched.files.pdf,
    image: undefined,
    audio: fetched.files.mp3 ? [fetched.files.mp3] : [],
    extras: [],
    warnings,
  };

  if (!files.midi && !files.xml) {
    warnings.push(
      "Не скачаны ни MIDI, ни MusicXML — Piano Marvel требует хотя бы один для нотной дорожки.",
    );
  }

  const filenameGuess = guessMetadata(files.baseName);
  let scoreGuess = null;
  if (files.xml) {
    try {
      scoreGuess = await analyzeScoreFile(files.xml, files.midi);
    } catch (error) {
      warnings.push(`Не удалось проанализировать MusicXML: ${String(error)}`);
    }
  }
  // Приоритет сведений: сама партитура → страница MuseScore → имя файла. Раньше
  // страница стояла первой, но её поля заполняет загрузивший: в «композиторе» там
  // регулярно оказывается название песни, а в заголовке — «Название - Исполнитель».
  const msTitle = fetched.title?.trim();
  const msComposer = fetched.composer?.trim();
  const msArtist = fetched.artist?.trim() || msComposer;
  const title = firstUsable(scoreGuess?.title, msTitle, filenameGuess.title);
  const composer = pickAuthorCredit(
    [scoreGuess?.composer, msComposer, scoreGuess?.artist, msArtist, filenameGuess.composer],
    title,
  );
  const guess = {
    ...filenameGuess,
    ...scoreGuess,
    title,
    composer: composer ?? filenameGuess.composer,
    artist: firstUsable(scoreGuess?.artist, msArtist, composer, filenameGuess.artist),
  };
  return { files, guess, fetched, readyForPipeline: fetched.readyForPipeline };
}
