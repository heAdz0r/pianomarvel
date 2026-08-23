import { findSiblingFiles } from "./fileMatcher";
import { guessMetadata } from "./metadata";
import { analyzeScoreFile, readScoreXml } from "./scoreAnalyzer";
// CHANGED: подбор аппликатуры — анализ и сборка нового .mxl (docs/fingering-prd.md)
import { analyzeFingeringCoverage, type HandSpanPreset, type FingeringMode } from "./fingering";
import { analyzeScoreFingering, buildFingeredScore } from "./fingering-xml";
// CHANGED: проверка результата глазами — открыть новый .mxl в MuseScore
import { findScoreEditor, openScoreFile } from "./score-editor";
import {
  updateSongMusicXml,
  uploadSong,
  type UploadMetadata,
} from "./piano";
import { GENRE_NAMES } from "./genres";
import { getUploadedPieces } from "./pieces";
import {
  cancelQueuedLearningJobs,
  getLearningJob,
  startLearningJob,
  waitForLearningJob,
} from "./learning-jobs";
import { inspectLearningMode, previewAdaptivePlan } from "./learning-mode";
import { runBrowserTask } from "./browser-task";
import { getCache } from "./cache";
import { reclaimPort } from "./ports";
import { PROFILE_DIR } from "./browser";
import { reclaimBrowserProfile } from "./browser-profile";
// CHANGED: auth is now driven from the UI via the shared embedded browser
import {
  startLogin,
  completeLogin,
  isLoggedIn,
  checkSession,
  probeSessionCookies,
  getLoginState,
  isBrowserOpen,
  closeContext,
  getContext,
  MUSESCORE_LOGIN_URL, // CHANGED: логин MuseScore в тот же профиль (PRD §2.4)
  closeExternalLoginWindow, // CHANGED: завершение внешнего окна для MuseScore-логина
  finishExternalLogin,
  isProfileLocked,
} from "./browser";
// CHANGED: интеграция с MuseScore (prd-musescore-integration.md, схема B)
import {
  searchMuseScore,
  isMuseScoreLoggedIn,
  probeMuseScoreAuthOnDisk,
  probeMuseScoreSession,
  WANTED_FORMATS,
  type MuseScoreFormat,
} from "./musescore";
import { startFetchJob, getFetchJob, waitForFetchJob } from "./musescore-jobs";
import { parseLearningStrategy } from "./learning-strategy";
import { closeLearningWorkers, learningQueueState } from "./learning-workers";
import { log, withTaskLogger } from "./log";

const PORT = 3001;

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** Явное live-действие само восстанавливает сохранённую headless-сессию. */
async function hasPianoMarvelSession(): Promise<boolean> {
  if (getLoginState() === "loggedIn") return true;
  return isLoggedIn().catch(() => false);
}

/** macOS-only: pop a native Finder "choose file" dialog and return the path. */
async function pickFileNative(): Promise<string | null> {
  const script = `POSIX path of (choose file with prompt "Выберите файл композиции")`;
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, error] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    if (/-128|User canceled/i.test(error)) return null;
    throw new Error(error.trim() || `Finder завершился с кодом ${code}.`);
  }
  return out.trim();
}

// CHANGED: fail with a helpful message instead of a raw EADDRINUSE stack trace.
// CHANGED: graceful shutdown — раньше при Ctrl+C окно браузера оставалось висеть
// и держало профиль заблокированным (следующий запуск не мог его открыть).
// CHANGED: то же сообщение, что и у Adaptive, — состояние одно и то же.
const SCORE_SOURCE_MISSING =
  "Для композиции не сохранён локальный MusicXML — привяжите файл кнопкой «Привязать XML».";

/** CHANGED: путь к партитуре — из запроса или из кеша по id композиции. */
function resolveScorePath(body: { path?: string; pieceId?: number }): string | null {
  if (typeof body.path === "string" && body.path.trim()) return body.path.trim();
  if (typeof body.pieceId === "number" && Number.isFinite(body.pieceId)) {
    return getCache().getScoreSource(body.pieceId)?.xmlPath ?? null;
  }
  return null;
}

function fingeringMode(value: unknown): FingeringMode {
  if (value === undefined) return "fill";
  if (value === "fill" || value === "rebuild") return value;
  throw new Error("mode должен быть fill или rebuild.");
}

function handSpan(value: unknown): HandSpanPreset | undefined {
  if (value === undefined) return undefined;
  if (value === "small" || value === "medium" || value === "large") return value;
  throw new Error("handSpan должен быть small, medium или large.");
}

function cleanMessage(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — закрываю браузер и выхожу…`);
  await closeLearningWorkers().catch(() => undefined);
  await closeContext().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function isAddrInUse(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "EADDRINUSE");
}

// Сервер сам поднимает свежую сессию: освобождаем порт от прошлого процесса и биндимся.
// Триггер — фактический успешный listen, не таймер (см. reclaimPort). Вторая попытка на
// случай гонки, если порт заняли между reclaim и bind.
reclaimPort(PORT);
reclaimBrowserProfile(PROFILE_DIR);
try {
  startServer();
} catch (err) {
  if (!isAddrInUse(err)) throw err;
  reclaimPort(PORT);
  startServer();
}

function startServer() {
Bun.serve({
  port: PORT,
  // Finder может оставаться открытым дольше стандартных десяти секунд Bun.
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/genres") {
      return json({ genres: GENRE_NAMES });
    }

    if (url.pathname === "/api/pieces" && req.method === "GET") {
      const catalog = getCache().getCatalog();
      return json({
        ...catalog,
        statuses: getCache().getLearningStatuses(catalog.pieces.map((piece) => piece.id)),
      });
    }

    if (url.pathname === "/api/pieces/refresh" && req.method === "POST") {
      if (!(await hasPianoMarvelSession())) {
        return json({ error: "Сначала войдите в Piano Marvel." }, { status: 401 });
      }
      try {
        const pieces = await getUploadedPieces();
        getCache().replaceCatalog(pieces);
        const catalog = getCache().getCatalog();
        return json({
          ...catalog,
          statuses: getCache().getLearningStatuses(pieces.map((piece) => piece.id)),
        });
      } catch (error) {
        return json({ error: String(error) }, { status: 500 });
      }
    }

    const learningMatch = url.pathname.match(/^\/api\/pieces\/(\d+)\/learning$/);
    if (learningMatch && req.method === "POST") {
      if (!(await hasPianoMarvelSession())) {
        return json({ error: "Сначала войдите в Piano Marvel." }, { status: 401 });
      }
      const body = await req.json().catch(() => ({})) as { strategy?: unknown };
      const pieceId = Number(learningMatch[1]);
      const strategy = parseLearningStrategy(body.strategy);
      if (strategy === "adaptive" && !getCache().getScoreSource(pieceId)) {
        return json(
          { error: "Adaptive недоступен: для композиции не сохранён локальный MusicXML." },
          { status: 422 },
        );
      }
      return json({ job: startLearningJob(pieceId, strategy) }, { status: 202 });
    }

    const previewMatch = url.pathname.match(/^\/api\/pieces\/(\d+)\/learning-preview$/);
    if (previewMatch && req.method === "POST") {
      if (!(await hasPianoMarvelSession())) {
        return json({ error: "Сначала войдите в Piano Marvel." }, { status: 401 });
      }
      const pieceId = Number(previewMatch[1]);
      const source = getCache().getScoreSource(pieceId);
      if (!source) {
        return json(
          { error: "Adaptive недоступен: для композиции не сохранён локальный MusicXML." },
          { status: 422 },
        );
      }
      return withTaskLogger(`preview #${pieceId}`, async (logger) => {
        logger.info("запрос предпросмотра Adaptive", {
          source: source.xmlPath,
          sourceUpdatedAt: source.updatedAt,
        });
        try {
          const preview = await runBrowserTask(async () =>
            previewAdaptivePlan(await getContext(), pieceId, source.xmlPath),
          );
          logger.info("предпросмотр Adaptive готов", {
            phrases: preview.phrases.length,
            bridges: preview.bridges,
            reviews: preview.reviews,
            summaries: preview.summaries,
          });
          return json({ preview });
        } catch (error) {
          logger.error("предпросмотр Adaptive завершился ошибкой", error);
          return json({ error: String(error).replace(/^Error:\s*/, "") }, { status: 500 });
        }
      });
    }

    const scoreSourceMatch = url.pathname.match(/^\/api\/pieces\/(\d+)\/score-source$/);
    if (scoreSourceMatch && req.method === "POST") {
      try {
        const body = await req.json() as { path?: unknown };
        if (typeof body.path !== "string" || !body.path.trim()) {
          return json({ error: "Не указан путь к MusicXML." }, { status: 400 });
        }
        const analysis = await analyzeScoreFile(body.path.trim());
        getCache().putScoreSource(Number(scoreSourceMatch[1]), body.path.trim());
        return json({ ok: true, analysis });
      } catch (error) {
        return json({ error: String(error).replace(/^Error:\s*/, "") }, { status: 422 });
      }
    }

    const learningStatusMatch = url.pathname.match(
      /^\/api\/pieces\/(\d+)\/learning-status$/,
    );
    if (learningStatusMatch && req.method === "GET") {
      const cached = getCache().getLearningStatus(Number(learningStatusMatch[1]));
      return cached
        ? json(cached)
        : json({ status: null, checkedAt: null });
    }

    if (learningStatusMatch && req.method === "POST") {
      if (!(await hasPianoMarvelSession())) {
        return json({ error: "Сначала войдите в Piano Marvel." }, { status: 401 });
      }
      try {
        const pieceId = Number(learningStatusMatch[1]);
        const musicXmlPath = getCache().getScoreSource(pieceId)?.xmlPath;
        const status = await runBrowserTask(async () =>
          inspectLearningMode(await getContext(), pieceId, musicXmlPath),
        );
        const checkedAt = new Date().toISOString();
        getCache().putLearningStatus(status, checkedAt);
        return json({ status, checkedAt });
      } catch (error) {
        return json({ error: String(error) }, { status: 500 });
      }
    }

    const jobMatch = url.pathname.match(/^\/api\/learning-jobs\/([\w-]+)$/);
    if (jobMatch && req.method === "GET") {
      const after = url.searchParams.get("after");
      const parsedAfter = after === null ? null : Number(after);
      const job = parsedAfter === null || !Number.isFinite(parsedAfter)
        ? getLearningJob(jobMatch[1])
        : await waitForLearningJob(jobMatch[1], parsedAfter, req.signal);
      return job
        ? json({ job })
        : json({ error: "Задание не найдено." }, { status: 404 });
    }

    if (url.pathname === "/api/learning-jobs" && req.method === "GET") {
      return json({ queue: learningQueueState() });
    }

    if (url.pathname === "/api/learning-jobs/cancel-queued" && req.method === "POST") {
      return json({ cancelled: cancelQueuedLearningJobs() });
    }

    // CHANGED: report login status. `check=1` forces a live re-check against
    // pianomarvel.com; otherwise we return the cached state (cheap, no navigation).
    if (url.pathname === "/api/status" && req.method === "GET") {
      try {
        const checkMode = url.searchParams.get("check");
        // CHANGED: check=cookie — тихая проверка только по куки из SQLite (браузер не
        // поднимается ни при каком исходе). Используется UI при загрузке страницы.
        if (checkMode === "cookie") {
          const result = await probeSessionCookies();
          return json({
            loggedIn: result?.loggedIn ?? false,
            state: getLoginState(),
            browserOpen: isBrowserOpen(),
            method: "cookie",
            detail: result?.detail,
            error: result?.error,
          });
        }
        const doCheck = checkMode === "1";
        // CHANGED: check=1 — явная проверка сессии: сначала по куки из SQLite (без
        // браузера, быстро), при неудаче — через профиль браузера. Раньше проверка
        // выполнялась только при уже открытом браузере — после рестарта сервера
        // кнопка «Проверить вход» возвращала кэшированный unknown и «ничего не делала».
        if (doCheck) {
          const result = await checkSession();
          return json({
            loggedIn: result.loggedIn,
            state: getLoginState(),
            browserOpen: isBrowserOpen(),
            method: result.method,
            detail: result.detail,
            error: result.error,
          });
        }
        return json({
          loggedIn: getLoginState() === "loggedIn",
          state: getLoginState(),
          browserOpen: isBrowserOpen(),
        });
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    }

    // CHANGED: open the embedded browser on the login page. Returns immediately;
    // the UI polls /api/status to learn when the user has finished signing in.
    if (url.pathname === "/api/login" && req.method === "POST") {
      try {
        await closeLearningWorkers();
        await startLogin();
        return json({ started: true, state: getLoginState() });
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/login/complete" && req.method === "POST") {
      try {
        await closeLearningWorkers();
        const loggedIn = await completeLogin();
        return json({ loggedIn, state: getLoginState() });
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/browse" && req.method === "POST") {
      try {
        const path = await pickFileNative();
        if (!path) return json({ path: null });
        return json({ path });
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/scan" && req.method === "GET") {
      const path = url.searchParams.get("path");
      if (!path) return json({ error: "missing ?path=" }, { status: 400 });
      try {
        const files = await findSiblingFiles(path);
        const filenameGuess = guessMetadata(files.baseName);
        let scoreGuess = null;
        let fingering = undefined; // CHANGED: состояние аппликатуры для чекбокса акта III
        if (files.xml) {
          try {
            scoreGuess = await analyzeScoreFile(files.xml, files.midi);
          } catch (error) {
            files.warnings.push(`Не удалось проанализировать MusicXML: ${String(error)}`);
          }
          try {
            fingering = analyzeFingeringCoverage(await readScoreXml(files.xml));
          } catch (error) {
            files.warnings.push(`Не удалось проверить аппликатуру: ${String(error)}`);
          }
        }
        const guess = {
          ...filenameGuess,
          ...scoreGuess,
          ...(fingering ? { fingering } : {}), // CHANGED

          title: scoreGuess?.title || filenameGuess.title,
          composer: scoreGuess?.composer || filenameGuess.composer,
          artist: scoreGuess?.artist || filenameGuess.artist,
        };
        return json({ files, guess });
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    }

    // ── MuseScore (PRD prd-musescore-integration.md, схема B) ─────────────────
    if (url.pathname === "/api/musescore/status" && req.method === "GET") {
      const checkMode = url.searchParams.get("check");
      if (checkMode === "cookie") {
        const loggedIn = probeMuseScoreSession();
        if (loggedIn) finishExternalLogin(true);
        return json({
          loggedIn,
          state: loggedIn ? "loggedIn" : getLoginState(),
          method: "cookie",
          checked: true,
          browserOpen: isBrowserOpen(),
          profileLocked: isProfileLocked(),
        });
      }
      if (checkMode === "1") {
        const loggedIn = await isMuseScoreLoggedIn().catch(() => false);
        if (loggedIn) finishExternalLogin(true);
        return json({
          loggedIn,
          state: getLoginState(),
          method: "cookie",
          checked: true,
          browserOpen: isBrowserOpen(),
          profileLocked: isProfileLocked(),
        });
      }
      const flag = getCache().getMuseScoreLoginFlag();
      if (flag?.loggedIn) {
        return json({
          loggedIn: true,
          state: "loggedIn",
          method: "flag",
          checked: true,
          checkedAt: flag.at,
          browserOpen: isBrowserOpen(),
        });
      }
      // Chrome открыт с dashboard — куки в профиле, Playwright не может перечитать.
      if (probeMuseScoreAuthOnDisk()) {
        getCache().setMuseScoreLoginFlag(true);
        finishExternalLogin(true);
        return json({
          loggedIn: true,
          state: "loggedIn",
          method: "profile",
          checked: true,
          browserOpen: isBrowserOpen(),
          profileLocked: isProfileLocked(),
        });
      }
      if (getLoginState() === "waiting") {
        return json({ loggedIn: false, state: "waiting", browserOpen: true, checked: true });
      }
      return json({
        loggedIn: false,
        method: "flag",
        checked: Boolean(flag),
        checkedAt: flag?.at,
        browserOpen: isBrowserOpen(),
      });
    }

    if (url.pathname === "/api/musescore/login" && req.method === "POST") {
      try {
        await closeLearningWorkers();
        await startLogin(MUSESCORE_LOGIN_URL); // тот же профиль, вход только вручную
        return json({ started: true, state: getLoginState() });
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/musescore/login/complete" && req.method === "POST") {
      await closeLearningWorkers().catch(() => undefined);
      await closeExternalLoginWindow().catch(() => undefined);
      const loggedIn = await isMuseScoreLoggedIn().catch(() => false);
      finishExternalLogin(loggedIn);
      return json({
        loggedIn,
        state: getLoginState(),
        checked: true,
        browserOpen: isBrowserOpen(),
      });
    }

    if (url.pathname === "/api/musescore/search" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) return json({ error: "missing ?q=" }, { status: 400 });
      try {
        const results = await runBrowserTask(() =>
          searchMuseScore(q, { limit: 30 }),
        );
        return json({ results });
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    }

    // Скачивание — фоновый job с прогрессом (long-poll ниже), а не блокирующий POST.
    if (url.pathname === "/api/musescore/fetch" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          url?: string;
          scoreId?: string;
          formats?: MuseScoreFormat[];
          baseName?: string;
          author?: string;
        };
        const scoreUrl =
          body.url ?? (body.scoreId ? `https://musescore.com/scores/${body.scoreId}` : "");
        if (!scoreUrl) {
          return json({ error: "нужен url или scoreId" }, { status: 400 });
        }
        const formats =
          Array.isArray(body.formats) && body.formats.length ? body.formats : WANTED_FORMATS;
        const job = startFetchJob({
          scoreUrl,
          formats,
          baseName: body.baseName,
          author: body.author,
        });
        return json({ job }, { status: 202 });
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    }

    const fetchJobMatch = url.pathname.match(/^\/api\/musescore\/fetch-jobs\/([\w-]+)$/);
    if (fetchJobMatch && req.method === "GET") {
      const after = url.searchParams.get("after");
      const parsedAfter = after === null ? null : Number(after);
      const job =
        parsedAfter === null || !Number.isFinite(parsedAfter)
          ? getFetchJob(fetchJobMatch[1])
          : await waitForFetchJob(fetchJobMatch[1], parsedAfter, req.signal);
      return job ? json({ job }) : json({ error: "Задание не найдено." }, { status: 404 });
    }

    // CHANGED: анализ аппликатуры — чистая операция, файлов не создаёт.
    if (url.pathname === "/api/fingering/analyze" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          path?: string;
          pieceId?: number;
          mode?: unknown;
          handSpan?: unknown;
        };
        const path = resolveScorePath(body);
        if (!path) return json({ error: SCORE_SOURCE_MISSING }, { status: 422 });
        const { plan, previewXml } = await analyzeScoreFingering(path, {
          mode: fingeringMode(body.mode),
          handSpan: handSpan(body.handSpan),
          trace: url.searchParams.get("trace") === "1",
        });
        return json({ path, report: plan.report, trace: plan.trace, previewXml });
      } catch (error) {
        return json({ error: cleanMessage(error) }, { status: 422 });
      }
    }

    // CHANGED: сборка нового .mxl с аппликатурой; оригинал не трогается.
    if (url.pathname === "/api/fingering/build" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          path?: string;
          pieceId?: number;
          mode?: unknown;
          handSpan?: unknown;
        };
        const path = resolveScorePath(body);
        if (!path) return json({ error: SCORE_SOURCE_MISSING }, { status: 422 });
        const result = await buildFingeredScore(path, {
          mode: fingeringMode(body.mode),
          handSpan: handSpan(body.handSpan),
          trace: true,
        });
        return json({
          path: result.path,
          uploadPath: result.uploadPath,
          source: path,
          report: result.plan.report,
          trace: result.plan.trace,
          previewXml: result.previewXml,
          editor: findScoreEditor(), // CHANGED: чем предлагать открыть результат
        });
      } catch (error) {
        return json({ error: cleanMessage(error) }, { status: 422 });
      }
    }

    const pianoMarvelScoreMatch = url.pathname.match(
      /^\/api\/pieces\/(\d+)\/piano-marvel-score$/,
    );
    if (pianoMarvelScoreMatch && req.method === "POST") {
      const pieceId = Number(pianoMarvelScoreMatch[1]);
      return withTaskLogger(`score update #${pieceId}`, async (logger) => {
        logger.info("получен запрос на замену MusicXML", {
          method: req.method,
          pathname: url.pathname,
        });

        let body: { source?: unknown; fingeringMode?: unknown };
        try {
          try {
            body = (await req.json()) as typeof body;
          } catch (error) {
            logger.warn("не удалось разобрать JSON запроса", error);
            return json({ error: "Некорректный JSON запроса." }, { status: 400 });
          }
          if (body.source !== "original" && body.source !== "fingered") {
            logger.warn("отклонён неизвестный источник партитуры", {
              source: body.source,
            });
            return json(
              { error: "source должен быть original или fingered." },
              { status: 400 },
            );
          }
          if (!(await hasPianoMarvelSession())) {
            logger.warn("обновление остановлено: нет активной сессии Piano Marvel");
            return json({ error: "Сначала войдите в Piano Marvel." }, { status: 401 });
          }

          const canonical = getCache().getScoreSource(pieceId)?.xmlPath;
          if (!canonical) {
            logger.warn("канонический MusicXML не найден в кеше");
            return json({ error: SCORE_SOURCE_MISSING }, { status: 422 });
          }
          logger.info("источник запроса подтверждён", {
            source: body.source,
            fingeringMode: body.fingeringMode,
            canonical,
          });

          // Сборка и editSong идут в общей FIFO-очереди браузерных задач:
          // два двойных клика не смогут одновременно писать один fingered/MXL
          // и затем соревноваться за общий профиль Chrome.
          const payload = await runBrowserTask(async () => {
            let selectedPath = canonical;
            let built:
              | Awaited<ReturnType<typeof buildFingeredScore>>
              | undefined;
            if (body.source === "fingered") {
              built = await buildFingeredScore(canonical, {
                mode: fingeringMode(body.fingeringMode),
                trace: true,
              });
              selectedPath = built.uploadPath;
            } else if (body.fingeringMode !== undefined) {
              throw new Error("fingeringMode допустим только для source=fingered.");
            }

            logger.info("замена MusicXML в существующей композиции", {
              source: body.source,
              canonical,
              selectedPath,
            });
            const result = await updateSongMusicXml(pieceId, selectedPath);
            return {
              ...result,
              source: body.source,
              path: built?.path ?? selectedPath,
              uploadPath: selectedPath,
              report: built?.plan.report,
              trace: built?.plan.trace,
              previewXml: built?.previewXml,
              editor: built ? findScoreEditor() : undefined,
            };
          });
          if (!payload.success) {
            logger.error("Piano Marvel не подтвердил замену MusicXML", payload);
          } else {
            logger.info("MusicXML в Piano Marvel обновлён", {
              source: payload.source,
              path: payload.path,
            });
          }
          return json(
            payload.success ? payload : { ...payload, error: payload.message },
            { status: payload.success ? 200 : 502 },
          );
        } catch (error) {
          logger.error("замена MusicXML завершилась ошибкой", error);
          return json({ error: cleanMessage(error) }, { status: 422 });
        }
      });
    }

    // CHANGED: открыть сгенерированную партитуру в нотаторе или показать в Finder.
    if (url.pathname === "/api/fingering/open" && req.method === "POST") {
      try {
        const body = (await req.json()) as { path?: string; reveal?: boolean };
        if (typeof body.path !== "string" || !body.path.trim()) {
          return json({ error: "Не указан путь к файлу." }, { status: 400 });
        }
        const result = await openScoreFile(body.path.trim(), { reveal: body.reveal === true });
        return json(result);
      } catch (error) {
        return json({ error: cleanMessage(error) }, { status: 422 });
      }
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
      let body: {
        files: {
          midi?: string;
          xml?: string;
          audio: string[];
          pdf?: string;
          image?: string;
        };
        metadata: UploadMetadata;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch (error) {
        log.error("[upload] не удалось разобрать JSON запроса", error);
        return json({ success: false, message: "Некорректный JSON запроса." }, { status: 400 });
      }

      const scopeTitle = body.metadata?.title?.trim() || "без названия";
      return withTaskLogger(`upload ${scopeTitle}`, async (logger) => {
        // Канонический исходник нужен для последующего выбора
        // «оригинал / версия с аппликатурой». Ниже body.files.xml может быть
        // заменён производным fingered-файлом только на время отправки.
        const canonicalXmlPath = body.files?.xml;
        logger.info("получен запрос", {
          defaultTempo: body.metadata?.defaultTempo,
          midi: body.files?.midi,
          xml: body.files?.xml,
          audio: body.files?.audio ?? [],
          pdf: body.files?.pdf,
          image: body.files?.image,
        });
        // CHANGED: аппликатура подбирается до загрузки — в Piano Marvel уезжает
        // новый .mxl, оригинал остаётся на диске нетронутым (PRD аппликатуры §8.2).
        let fingeringNote = "";
        if (body.metadata?.autoFingering === true && body.files?.xml) {
          try {
            const coverage = analyzeFingeringCoverage(await readScoreXml(body.files.xml));
            if (coverage.hasFingering) {
              fingeringNote = ` В партитуре уже есть аппликатура (${Math.round(
                coverage.coverage * 100,
              )} % нот) — оставил авторскую.`;
            } else {
              const built = await buildFingeredScore(body.files.xml, { mode: "fill" });
              const stats = built.plan.report.stats;
              logger.info("аппликатура подобрана", {
                path: built.path,
                uploadPath: built.uploadPath,
                ...stats,
              });
              // PRD §8.2: в PM уезжает fingered/<имя>.mxl (resource layout).
              // piano-marvel/ — только для замены MusicXML у уже существующей пьесы.
              body.files.xml = built.path;
              fingeringNote =
                ` Аппликатура подобрана (${stats.notes} нот, ${stats.positionChanges} смен позиции):` +
                ` ${built.path}.`;
            }
          } catch (error) {
            logger.error("подбор аппликатуры не удался", error);
            fingeringNote = ` Аппликатуру подобрать не удалось (${cleanMessage(
              error,
            )}) — загружаю оригинал.`;
          }
        }

        try {
          const result = await runBrowserTask(() =>
            uploadSong(
              // audio может прийти undefined — иначе files.audio.length падал
              {
                baseName: "",
                dir: "",
                extras: [],
                warnings: [],
                ...body.files,
                audio: body.files?.audio ?? [],
              },
              body.metadata,
            ),
          );
          if (result.success) {
            logger.info(`legacy upload сохранён, pieceId=${result.pieceId ?? "не определён"}`);
          } else {
            logger.error("legacy upload отклонён", {
              message: result.message,
              serverDetail: result.serverDetail,
            });
          }
          const shouldCreateLearning =
            result.success &&
            result.pieceId &&
            body.metadata.createLearningMode !== false &&
            body.metadata.assessmentMode !== "Play Only";
          if (result.success && result.pieceId) {
            if (canonicalXmlPath ?? body.files.xml) {
              getCache().putScoreSource(
                Number(result.pieceId),
                canonicalXmlPath ?? (body.files.xml as string),
              );
            }
            getCache().upsertPiece({
              id: Number(result.pieceId),
              title: body.metadata.title,
              difficulty: body.metadata.difficulty ?? 1,
              composer: body.metadata.composer ?? "",
              artist: body.metadata.artist ?? "",
              genres: body.metadata.genres,
            });
          }
          if (shouldCreateLearning) {
            const strategy = parseLearningStrategy(body.metadata.learningStrategy);
            if (strategy === "adaptive" && !body.files.xml) {
              return json({
                ...result,
                message: `${result.message}${fingeringNote} Композиция загружена, но Adaptive не запущен: нужен MusicXML.`,
              });
            }
            const learningJob = startLearningJob(Number(result.pieceId), strategy);
            return json({
              ...result,
              message: `${result.message}${fingeringNote} Обучающий режим запущен.`,
              learningJob,
            });
          }
          return json(
            {
              ...result,
              message: result.success ? `${result.message}${fingeringNote}` : result.message,
            },
            { status: result.success ? 200 : 422 },
          );
        } catch (error) {
          logger.error("необработанная ошибка upload pipeline", error);
          return json({ success: false, message: String(error) }, { status: 500 });
        }
      });
    }

    log.warn("[http] неизвестный маршрут", {
      method: req.method,
      pathname: url.pathname,
    });
    return json(
      {
        error: `Маршрут ${req.method} ${url.pathname} не найден. Если UI только что обновился, перезапустите локальный backend.`,
      },
      { status: 404 },
    );
  },
});

console.log(`Piano Marvel uploader API listening on http://localhost:${PORT}`);
} // CHANGED: end startServer()
