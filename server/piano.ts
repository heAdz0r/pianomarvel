import { existsSync, statSync } from "node:fs"; // CHANGED: проверяем файлы до setInputFiles
import { basename, extname } from "node:path";
import type { Page } from "playwright";
import { getContext, isLoggedIn } from "./browser"; // reuse shared context
import { pickFallbackGenreValue, resolveGenreValues } from "./genres"; // CHANGED: жанр обязателен
import {
  ASSESSMENT_MODE_VALUES,
  DIFFICULTY,
  TEMPO,
  clamp,
  type AssessmentMode,
} from "./constants"; // CHANGED: единые диапазоны/значения + clamp
import type { MatchedFiles } from "./fileMatcher";
import type { LearningStrategy } from "./learning-strategy";
import { tlog } from "./log";

export interface UploadMetadata {
  title: string;
  subTitle?: string;
  composer?: string;
  artist?: string;
  copyright?: string;
  difficulty?: number; // 1-18
  defaultTempo?: number; // 30-240
  genres: string[]; // genre names, see server/genres.ts
  assessmentMode?: AssessmentMode;
  createLearningMode?: boolean;
  learningStrategy?: LearningStrategy;
  /** CHANGED: подобрать аппликатуру, если её нет в MusicXML (PRD аппликатуры §8.2). */
  autoFingering?: boolean;
}

export interface UploadResult {
  success: boolean;
  pieceId?: string;
  url?: string;
  message: string;
  /** CHANGED: сырой ответ сервера/детали ошибки для отладки (gap #5). */
  serverDetail?: string;
}

export interface ScoreUpdateResult {
  success: boolean;
  pieceId: number;
  path: string;
  message: string;
  /** Сырой ответ Piano Marvel, обрезанный до безопасного диагностического размера. */
  serverDetail?: string;
}

const MUSIC_XML_EXTENSIONS = new Set([".mxl", ".musicxml", ".xml"]);
const UPLOAD_RESPONSE_TIMEOUT_MIN_MS = 20_000;
const UPLOAD_RESPONSE_TIMEOUT_MAX_MS = 120_000;
const SAVE_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  ".legacy-save",
  '[data-action="save"]',
];

export function uploadResponseTimeoutMs(files: MatchedFiles): number {
  const paths = [files.midi, files.xml, files.pdf, files.image, ...files.audio].filter(
    (path): path is string => Boolean(path),
  );
  let bytes = 0;
  for (const path of paths) {
    try {
      bytes += statSync(path).size;
    } catch {
    }
  }
  // Multipart с MIDI/MXL/MP3 на PM может идти минуту — масштабируем от размера вложений.
  return Math.min(
    UPLOAD_RESPONSE_TIMEOUT_MAX_MS,
    Math.max(UPLOAD_RESPONSE_TIMEOUT_MIN_MS, Math.ceil((bytes / 400_000) * 1000)),
  );
}

function isEditSongPost(url: string, method: string): boolean {
  return method === "POST" && /\/uploads\/editSong/i.test(url);
}

export function scoreEditUrl(pieceId: number): string {
  if (!Number.isSafeInteger(pieceId) || pieceId <= 0) {
    throw new Error("Некорректный id композиции Piano Marvel.");
  }
  return `https://pianomarvel.com/uploads/editSong/${pieceId}`;
}

/**
 * Заменяет только MusicXML у уже существующей композиции. Пустые file-input
 * остальных форматов не трогаются, поэтому MIDI/PDF/audio на Piano Marvel
 * сохраняются. Это отдельный edit-flow: uploadSong здесь использовать нельзя,
 * иначе вместо обновления появится дубликат композиции.
 */
export async function updateSongMusicXml(
  pieceId: number,
  xmlPath: string,
): Promise<ScoreUpdateResult> {
  const logger = tlog();
  const path = xmlPath.trim();
  const url = scoreEditUrl(pieceId);
  if (!path || !existsSync(path)) {
    logger.warn("MusicXML для отправки не найден", { pieceId, path });
    return {
      success: false,
      pieceId,
      path,
      message: `MusicXML не найден на диске: ${path || "путь не указан"}.`,
    };
  }
  if (!MUSIC_XML_EXTENSIONS.has(extname(path).toLowerCase())) {
    logger.warn("отклонено неподдерживаемое расширение нотного файла", {
      pieceId,
      path,
      extension: extname(path).toLowerCase(),
    });
    return {
      success: false,
      pieceId,
      path,
      message: "Для обновления нужен файл .mxl, .musicxml или .xml.",
    };
  }

  const context = await getContext();
  let page: Page | undefined;
  try {
    if (!(await isLoggedIn())) {
      logger.warn("editSong остановлен: браузерная сессия не авторизована", {
        pieceId,
      });
      return {
        success: false,
        pieceId,
        path,
        message: "Не залогинен на pianomarvel.com. Войдите и повторите обновление.",
      };
    }

    logger.info("открываю форму существующей композиции", { pieceId, url, path });
    page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[name="data[Piece][title]"]', { timeout: 20_000 });
    await attachMusicXmlFile(page, path);
    logger.info("MusicXML прикреплён к editSong", {
      pieceId,
      file: basename(path),
    });

    const responsePromise = page
      .waitForResponse(
        (response) =>
          /\/uploads\/editSong(?:\/\d+)?(?:[?#]|$)/i.test(response.url()) &&
          response.request().method() === "POST",
        { timeout: 20_000 },
      )
      .catch(() => null);

    await submitUploadForm(page);
    logger.info("форма editSong отправлена", { pieceId });
    const response = await responsePromise;
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);

    const [inlineError, visibleSuccess] = await Promise.all([
      extractFormError(page),
      extractFormSuccess(page),
    ]);
    let serverDetail = await response?.text().catch(() => undefined);
    if (serverDetail && serverDetail.length > 2_000) {
      serverDetail = `${serverDetail.slice(0, 2_000)}…`;
    }

    if (inlineError) {
      logger.error("Piano Marvel вернул ошибку формы", {
        pieceId,
        inlineError,
        status: response?.status(),
      });
      return {
        success: false,
        pieceId,
        path,
        message: inlineError,
        serverDetail,
      };
    }
    if (response && response.status() >= 400) {
      logger.error("Piano Marvel отклонил editSong", {
        pieceId,
        status: response.status(),
      });
      return {
        success: false,
        pieceId,
        path,
        message: `Piano Marvel отклонил обновление нотного файла (HTTP ${response.status()}).`,
        serverDetail,
      };
    }
    if (!response && !visibleSuccess) {
      logger.error("editSong не дал проверяемого подтверждения", { pieceId });
      return {
        success: false,
        pieceId,
        path,
        message:
          "Файл был выбран, но Piano Marvel не подтвердил сохранение. Исходная партитура в локальном каталоге не изменена.",
      };
    }

    logger.info("Piano Marvel подтвердил сохранение MusicXML", {
      pieceId,
      status: response?.status(),
      confirmation: visibleSuccess ?? "POST response",
    });
    return {
      success: true,
      pieceId,
      path,
      message: visibleSuccess || `MusicXML композиции #${pieceId} обновлён.`,
      serverDetail,
    };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/**
 * Drives a real (persisted-login) Chrome session to fill out and submit
 * Piano Marvel's "New Song" form at /uploads/editSong/. Field names below
 * were reverse-engineered from the live form on 2026-07-19 — see
 * server/genres.ts for how/when to refresh them if Piano Marvel changes
 * their markup.
 */
export async function uploadSong(
  files: MatchedFiles,
  meta: UploadMetadata,
): Promise<UploadResult> {
  const logger = tlog();
  // CHANGED: базовая валидация до открытия браузера — быстрый отказ, понятные ошибки.
  if (!meta.title?.trim()) {
    return { success: false, message: "Не задано название композиции." };
  }
  const missing = collectMissingFiles(files);
  if (missing.length) {
    return {
      success: false,
      message: `Файлы не найдены на диске: ${missing.map((p) => basename(p)).join(", ")}. Возможно, они были перемещены после сканирования.`,
    };
  }
  if (!files.midi && !files.xml) {
    return {
      success: false,
      message:
        "Нужен хотя бы MIDI (.mid) или MusicXML (.mxl/.musicxml) — Piano Marvel требует нотную дорожку.",
    };
  }

  const context = await getContext(); // shared headed context, never opened/closed here
  let page; // track our own page so finally closes the page, not the context
  try {
    if (!(await isLoggedIn())) {
      return {
        success: false,
        message:
          "Не залогинен на pianomarvel.com. Запустите `bun run login` (или кнопку «Войти» в UI), войдите один раз, и повторите загрузку.",
      };
    }

    page = await context.newPage();

    // CHANGED: было networkidle (медленно/флаки на аналитике). Ждём DOM, затем
    // ключевое поле формы — этого достаточно, чтобы форма была готова к заполнению.
    await page.goto("https://pianomarvel.com/uploads/editSong/", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector('input[name="data[Piece][title]"]', { timeout: 20000 });

    // Файлы назначаются первыми: заполненные поля больше не показывают промежуточное состояние.
    await attachSongFiles(page, files);

    await page.fill('input[name="data[Piece][title]"]', meta.title.trim());
    if (meta.subTitle) await page.fill('input[name="data[Piece][subTitle]"]', meta.subTitle);
    if (meta.composer) await page.fill('input[name="data[Piece][composer]"]', meta.composer);
    if (meta.artist) await page.fill('input[name="data[Piece][artist]"]', meta.artist);
    if (meta.copyright) await page.fill('textarea[name="data[Piece][copyright]"]', meta.copyright);
    if (!meta.composer?.trim() && meta.artist?.trim()) {
      await page.fill('input[name="data[Piece][composer]"]', meta.artist.trim());
    }

    // CHANGED: клампим в допустимый диапазон, а не доверяем клиенту вслепую.
    const difficulty = clamp(meta.difficulty, DIFFICULTY.min, DIFFICULTY.max);
    if (difficulty !== undefined) {
      await page.selectOption('select[name="data[Piece][difficulty]"]', String(difficulty));
    }
    const tempo = clamp(meta.defaultTempo, TEMPO.min, TEMPO.max);
    if (tempo !== undefined) {
      await page.fill('input[name="data[Piece][default_tempo]"]', String(tempo));
    }
    const submittedTempo = await page.inputValue('input[name="data[Piece][default_tempo]"]');
    logger.info("форма legacy заполнена", {
      title: meta.title.trim(),
      requestedTempo: meta.defaultTempo,
      submittedTempo,
      difficulty,
      attachments: {
        midi: files.midi,
        xml: files.xml,
        audio: files.audio,
        pdf: files.pdf,
        image: files.image,
      },
    });

    // CHANGED: жанр обязателен — форма отклоняет отправку с «At least one genre is
    // required.», а анализатор партитуры нередко не распознаёт ни одного жанра.
    await ensureGenreSelected(page, meta.genres, logger);
    if (meta.assessmentMode) {
      await page.selectOption(
        'select[name="data[Piece][assessment_mode]"]',
        ASSESSMENT_MODE_VALUES[meta.assessmentMode],
      );
    }

    // Пустые share-поля могут появиться после автозаполнения формы — убираем их до POST.
    await disableBlankShareFields(page);

    const uploadTimeoutMs = uploadResponseTimeoutMs(files);

    // CHANGED (gap #5): перехватываем сам AJAX-ответ формы, а не только DOM.
    const responsePromise = page
      .waitForResponse(
        (r) => isEditSongPost(r.url(), r.request().method()),
        { timeout: uploadTimeoutMs },
      )
      .catch(() => null);

    const postStarted = await submitUploadForm(page);
    if (!postStarted) {
      const inlineError = await extractFormError(page);
      logger.error("legacy upload: POST формы не ушёл", { inlineError, uploadTimeoutMs });
      return {
        success: false,
        message:
          inlineError ??
          "Форма Piano Marvel не отправилась — проверьте обязательные поля и прикреплённые файлы.",
      };
    }

    const response = await responsePromise;
    let serverDetail: string | undefined;
    let responseOk = true;
    if (response) {
      responseOk = uploadResponseAccepted(response.status());
      serverDetail = await response.text().catch(() => undefined);
      if (serverDetail && serverDetail.length > 2000) {
        serverDetail = serverDetail.slice(0, 2000) + "…"; // не тащим всю HTML-страницу
      }
      logger.info("финальный ответ legacy upload", {
        status: response.status(),
        url: response.url(),
        body: serverDetail,
      });
    } else {
      logger.warn("финальный POST-ответ legacy upload не перехвачен");
    }

    await page
      .waitForURL(/\/uploads\/editSong\/\d+/, { timeout: uploadTimeoutMs })
      .catch(() => undefined);

    const url = page.url();
    const pieceId = extractPieceId(url);

    if (pieceId) {
      return {
        success: true,
        pieceId,
        url: `https://pianomarvel.com/uploads/pieceRedirect/${pieceId}`,
        message: `Загружено: "${meta.title}" (id ${pieceId}).`,
        serverDetail,
      };
    }

    // CHANGED: пытаемся вытащить текст ошибки валидации со страницы (gap #5).
    const inlineError = await extractFormError(page);
    logger.error("legacy upload не подтверждён", {
      inlineError,
      responseOk: response ? uploadResponseAccepted(response.status()) : false,
      finalUrl: url,
      serverDetail,
      uploadTimeoutMs,
    });
    return {
      success: false,
      message:
        inlineError ??
        (responseOk
          ? "Форма отправлена, но подтверждения сохранения не видно. Проверьте вручную на pianomarvel.com/uploads."
          : "Сервер отклонил форму (HTTP-ошибка). Подробности — в serverDetail."),
      serverDetail,
    };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/**
 * Принят ли ответ формы. Успешное сохранение Piano Marvel отвечает редиректом на
 * страницу композиции, поэтому 3xx — это успех, а не сбой; отказ начинается с 4xx.
 */
export function uploadResponseAccepted(status: number): boolean {
  return status < 400;
}

export function extractPieceId(url: string): string | undefined {
  return url.match(/\/uploads\/editSong\/(\d+)/)?.[1];
}

/**
 * Гарантирует выбранный жанр. Legacy-форма отвечает «At least one genre is
 * required.», если в multiselect ничего не выбрано, а это происходило в двух
 * случаях: анализатор партитуры не распознал жанр (пустой список) и карта жанров
 * разошлась с живой формой (значения не нашлись). Поэтому проверяется фактический
 * выбор в DOM, а не факт вызова selectOption.
 */
async function ensureGenreSelected(
  page: Page,
  names: string[],
  logger: { info: (message: string, data?: unknown) => void },
): Promise<void> {
  const select = page.locator('select[name="data[Piece][genres][]"]');
  if (!(await select.count())) {
    logger.info("жанр не задан: в форме нет поля жанров");
    return;
  }
  const requested = resolveGenreValues(names);
  await select.selectOption(requested).catch(() => undefined);
  let selected = await select.evaluate((node) =>
    Array.from((node as HTMLSelectElement).selectedOptions).map((option) => option.value),
  );
  if (selected.length === 0) {
    // Карта жанров устарела: берём первый настоящий вариант самой формы.
    const options = await select.evaluate((node) =>
      Array.from((node as HTMLSelectElement).options).map((option) => ({
        value: option.value,
        label: option.label,
      })),
    );
    const fallback = pickFallbackGenreValue(options);
    if (fallback) {
      await select.selectOption(fallback).catch(() => undefined);
      selected = await select.evaluate((node) =>
        Array.from((node as HTMLSelectElement).selectedOptions).map((option) => option.value),
      );
    }
  }
  logger.info("жанры выбраны", { requestedNames: names, requested, selected });
}

/** Значение поля share, в котором нет ни одного имени: только пробелы и разделители. */
export function isBlankShareValue(value: string): boolean {
  return !/[^\s,;]/.test(value);
}

const SHARE_FIELD_SELECTOR = [
  '[name="data[Piece][users]"]',
  '[name="data[Piece][users-message]"]',
  '[name*="users"]',
  'input[type="hidden"][name*="users"]',
  "#share-user-text",
  '[id*="share-user"]',
].join(", ");

/**
 * Отключает пустые поля виджета «поделиться с пользователями», который Piano Marvel
 * добавил в форму. Пустое значение сервер всё равно разбирает в список из одной
 * пустой записи и отклоняет отправку: «The following users could not be found:».
 * Для пустых полей очищаем value, снимаем name и disabled — иначе скрытые input и
 * autocomplete всё равно попадают в POST. Заполненные поля не трогаются.
 * Одним evaluateAll — иначе nth() зависает после removeAttribute в цикле Playwright.
 */
export async function disableBlankShareFields(page: Page): Promise<void> {
  await page.locator(SHARE_FIELD_SELECTOR).evaluateAll((nodes) => {
    for (const node of nodes) {
      const element = node as HTMLInputElement | HTMLTextAreaElement;
      const value = element.value ?? "";
      if (/[^\s,;]/.test(value)) continue;
      element.value = "";
      element.removeAttribute("name");
      element.disabled = true;
    }
  });
}

export async function submitUploadForm(
  page: Page,
  options: { requirePost?: boolean } = {},
): Promise<boolean> {
  await disableBlankShareFields(page);

  const waitPost = () =>
    page
      .waitForRequest((request) => isEditSongPost(request.url(), request.method()), {
        timeout: 5000,
      })
      .then(() => true)
      .catch(() => false);

  let postStarted = waitPost();
  await page.locator('input[name="data[Piece][title]"]').evaluate((title) => {
    const form = title.closest("form");
    if (!form) throw new Error("Поле названия не находится внутри формы загрузки.");
    form.requestSubmit();
  });
  if (options.requirePost === false) return true;
  if (await postStarted) return true;

  for (const selector of SAVE_BUTTON_SELECTORS) {
    const button = page.locator(selector).first();
    if ((await button.count()) === 0) continue;
    postStarted = waitPost();
    await button.click({ timeout: 2000 }).catch(() => undefined);
    if (await postStarted) return true;
  }

  return false;
}

/** Назначает файлы и проверяет состояние input.files до отправки формы. */
export async function attachSongFiles(page: Page, files: MatchedFiles): Promise<void> {
  const attachments: Array<{ label: string; selector: string; paths: string[] }> = [
    {
      label: "MIDI",
      selector: 'input[name="data[Piece][midi_file]"]',
      paths: files.midi ? [files.midi] : [],
    },
    {
      label: "MusicXML",
      selector: 'input[name="data[Piece][xml_file]"]',
      paths: files.xml ? [files.xml] : [],
    },
    {
      label: "аудио",
      selector: 'input[name="data[Piece][audio_file][]"]',
      paths: files.audio,
    },
    {
      label: "PDF",
      selector: 'input[name="data[Piece][pdf_file]"]',
      paths: files.pdf ? [files.pdf] : [],
    },
    {
      label: "обложка",
      selector: 'input[name="data[Piece][image_file]"]',
      paths: files.image ? [files.image] : [],
    },
  ];

  for (const attachment of attachments.filter((item) => item.paths.length > 0)) {
    await attachFiles(page, attachment);
  }
}

/** Назначает ровно один MXL существующей композиции, не касаясь других файлов. */
export async function attachMusicXmlFile(page: Page, path: string): Promise<void> {
  await attachFiles(page, {
    label: "MusicXML",
    selector: 'input[name="data[Piece][xml_file]"]',
    paths: [path],
  });
}

async function attachFiles(
  page: Page,
  attachment: { label: string; selector: string; paths: string[] },
): Promise<void> {
  const input = page.locator(attachment.selector);
  if ((await input.count()) !== 1) {
    throw new Error(`Поле «${attachment.label}» не найдено в форме Piano Marvel.`);
  }
  await input.setInputFiles(attachment.paths);
  const attachedNames = await input.evaluate((node) =>
    Array.from((node as HTMLInputElement).files ?? []).map((file) => file.name),
  );
  const expectedNames = attachment.paths.map((path) => basename(path));
  if (
    attachedNames.length !== expectedNames.length ||
    attachedNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `Не удалось прикрепить ${attachment.label}: ожидалось ${expectedNames.join(", ")}, получено ${attachedNames.join(", ") || "ничего"}.`,
    );
  }
  tlog().debug(`прикреплено ${attachment.label}`, attachedNames);
}

/** CHANGED: какие из указанных файлов физически отсутствуют на диске. */
function collectMissingFiles(files: MatchedFiles): string[] {
  const paths = [files.midi, files.xml, files.pdf, files.image, ...files.audio].filter(
    (p): p is string => Boolean(p),
  );
  return paths.filter((p) => !existsSync(p));
}

/** CHANGED: собрать видимый текст ошибок валидации формы, если он есть. */
export async function extractFormError(
  page: import("playwright").Page,
): Promise<string | undefined> {
  const invalidField = page.locator(":invalid:visible").first();
  const invalid = (await invalidField.count())
    ? await invalidField
        .evaluate((node) => {
          const element = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          return element.validationMessage?.trim() || "";
        })
        .catch(() => "")
    : "";
  if (invalid) return invalid;

  const selectors = [
    ".error-message",
    ".alert-danger",
    ".alert-error",
    ".error",
    '[class*="error"]',
    '[role="alert"]',
  ];
  for (const sel of selectors) {
    const visibleMessage = page.locator(`${sel}:visible`).first();
    if ((await visibleMessage.count()) === 0) continue;
    const text = await visibleMessage.innerText().catch(() => "");
    const trimmed = text?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

async function extractFormSuccess(page: Page): Promise<string | undefined> {
  const selectors = [".alert-success", ".success-message", ".message.success"];
  for (const selector of selectors) {
    const visibleMessage = page.locator(`${selector}:visible`).first();
    if ((await visibleMessage.count()) === 0) continue;
    const text = await visibleMessage.innerText().catch(() => "");
    const trimmed = text?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
