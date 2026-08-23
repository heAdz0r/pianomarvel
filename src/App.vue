<script setup lang="ts">
import {
  ref,
  reactive,
  computed,
  defineAsyncComponent,
  onMounted,
  onUnmounted,
  nextTick,
} from "vue";
import FurEliseStaff from "./components/FurEliseStaff.vue";
import AuthMovement from "./components/AuthMovement.vue";
import FileMovement from "./components/FileMovement.vue";
import MuseScoreMovement from "./components/MuseScoreMovement.vue"; // CHANGED: поиск на MuseScore
import MetadataMovement from "./components/MetadataMovement.vue";
import UiIcon from "./components/UiIcon.vue";
import ModeSwitch from "./components/ModeSwitch.vue"; // CHANGED: общий слайдер источника
import { chooseNativeFile } from "./api";
import { LatestRequest } from "./latest-request";
import type {
  AssessmentMode, Category, FileRow, FingeringCoverage, LearningJob, LoginState, MatchedFiles,
  UploadForm, UploadResult,
} from "./ui-types";
const DIFFICULTY = { min: 1, max: 18, default: 5 } as const;
const TEMPO = { min: 30, max: 240 } as const;
const PiecesMovement = defineAsyncComponent(() => import("./components/PiecesMovement.vue"));
const loginState = ref<LoginState>("unknown");
const loggedIn = ref(false);
const checkingSession = ref(false); // CHANGED: живая проверка сохранённой сессии
// CHANGED: toast о ходе/итоге проверки сессии — раньше клик не давал никакой обратной связи
const sessionToast = ref<{ message: string; tone: "progress" | "success" | "error" } | null>(null);
let statusTimer: number | undefined;
let sessionToastTimer: number | undefined;
let statusPollRun = 0;

function showSessionToast(
  message: string,
  tone: "progress" | "success" | "error",
  autoHideMs?: number,
) {
  if (sessionToastTimer) clearTimeout(sessionToastTimer);
  sessionToast.value = { message, tone };
  if (autoHideMs) {
    sessionToastTimer = window.setTimeout(() => {
      sessionToast.value = null;
      sessionToastTimer = undefined;
    }, autoHideMs);
  }
}

// CHANGED: явная проверка сессии — сервер сначала валидирует куки из SQLite (быстро,
// без браузера), при неудаче проверяет профиль браузера. Ошибки видны в toast.
async function checkSession() {
  checkingSession.value = true;
  showSessionToast("Проверяю сохранённую сессию…", "progress");
  try {
    const res = await fetch("/api/status?check=1");
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
    loggedIn.value = !!data.loggedIn;
    loginState.value = data.state ?? "unknown";
    if (data.loggedIn) {
      showSessionToast(
        data.method === "cookie"
          ? `Вход подтверждён по сохранённым куки — ${data.detail ?? "браузер не понадобился"}`
          : "Вход подтверждён через профиль браузера",
        "success",
        4500,
      );
    } else {
      showSessionToast(data.detail ?? "Сессия истекла — войдите заново.", "error", 7000);
    }
  } catch (err) {
    showSessionToast(`Проверка не удалась: ${String(err).replace(/^Error:\s*/, "")}`, "error", 8000);
  } finally {
    checkingSession.value = false;
  }
}
async function refreshStatus(check = false, expectedRun?: number) {
  try {
    const res = await fetch(`/api/status${check ? "?check=1" : ""}`);
    const data = await res.json();
    if (expectedRun !== undefined && expectedRun !== statusPollRun) return;
    loggedIn.value = !!data.loggedIn;
    loginState.value = data.state ?? "unknown";
  } catch {
    /* сервер ещё не поднялся — молча пробуем позже */
  }
}

function stopStatusPolling() {
  statusPollRun += 1;
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = undefined;
  }
}

async function pollLoginStatus(run: number): Promise<void> {
  if (run !== statusPollRun || loginState.value !== "waiting") return;
  await refreshStatus(true, run);
  if (run !== statusPollRun || loginState.value !== "waiting") return;
  statusTimer = window.setTimeout(() => {
    statusTimer = undefined;
    void pollLoginStatus(run);
  }, 2500);
}

async function login() {
  stopStatusPolling();
  loginState.value = "waiting";
  await fetch("/api/login", { method: "POST" });
  const run = statusPollRun;
  void pollLoginStatus(run);
}
async function completeLogin() {
  stopStatusPolling();
  const res = await fetch("/api/login/complete", { method: "POST" });
  const data = await res.json();
  loggedIn.value = !!data.loggedIn;
  loginState.value = data.state ?? "loggedOut";
}

const loginLabel = computed(() => {
  switch (loginState.value) {
    case "loggedIn":
      return "Вы вошли в Piano Marvel";
    case "waiting":
      return "Войдите через Google, затем подтвердите вход здесь";
    case "loggedOut":
      return "Не выполнен вход в Piano Marvel";
    default:
      return "Сессия не проверена — прошлый вход мог сохраниться";
  }
});

const allGenres = ref<string[]>([]);
async function loadGenres() {
  try {
    const res = await fetch("/api/genres");
    const data = await res.json();
    if (Array.isArray(data.genres)) allGenres.value = data.genres;
  } catch {
    /* оставим пустым — жанры необязательны */
  }
}

onMounted(async () => {
  loadGenres();
  await refreshStatus();
  // CHANGED: авто-восстановление сессии по куки из SQLite при открытии страницы —
  // один лёгкий HTTP-запрос без браузера. Если старый токен валиден, разделы UI
  // (библиотека, загрузка) разблокируются сразу, без ручного «Проверить вход».
  if (loginState.value === "unknown") {
    try {
      const res = await fetch("/api/status?check=cookie");
      const data = await res.json();
      if (data.loggedIn) {
        loggedIn.value = true;
        loginState.value = data.state ?? "loggedIn";
        showSessionToast("Вход восстановлен по сохранённым куки", "success", 4000);
      }
      // куки нет/истекли — молчим: остаются кнопки «Проверить вход» и «Войти»
    } catch {
    }
  }
});
onUnmounted(() => {
  stopStatusPolling();
  if (sessionToastTimer) clearTimeout(sessionToastTimer);
  uploadWatchers.forEach((controller) => controller.abort());
  scanRequest.cancel();
});

const path = ref("");
const sourceMode = ref<"local" | "musescore">("musescore");

// CHANGED: один источник описаний режимов для слайдера в шапке и в hero.
const SOURCE_MODES = [
  { value: "musescore", label: "MuseScore", caption: "Основной режим", icon: "search" as const },
  { value: "local", label: "С диска", caption: "Ручной режим", icon: "folder" as const },
];

function selectSourceMode(mode: string) {
  sourceMode.value = mode as "local" | "musescore";

  // Переключатель является постоянной точкой входа: после выбора источника
  // сразу возвращаем пользователя к первому шагу соответствующего сценария.
  void nextTick(() => {
    document.querySelector<HTMLElement>("#login")?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  });
}
const scanning = ref(false);
const scanRequest = new LatestRequest();
const uploading = ref(false);
const files = ref<MatchedFiles | null>(null);
const result = ref<UploadResult | null>(null);
const showDetail = ref(false);
type UploadToastTone = "progress" | "success" | "error";
interface UploadToast {
  id: string;
  title: string;
  message: string;
  tone: UploadToastTone;
  progress?: number;
}
const uploadToasts = reactive<Record<string, UploadToast>>({});
const uploadWatchers = new Set<AbortController>();
const CURRENT_UPLOAD_TOAST = "current-upload";

const form = reactive<UploadForm>({
  title: "",
  subTitle: "",
  composer: "",
  artist: "",
  copyright: "",
  difficulty: DIFFICULTY.default as number,
  defaultTempo: undefined,
  genres: [] as string[],
  assessmentMode: "Learn & Play" as AssessmentMode,
  createLearningMode: true,
  learningStrategy: "adaptive",
  autoFingering: true, // CHANGED: подбор аппликатуры включён по умолчанию
});

// CHANGED: состояние аппликатуры найденной партитуры — приходит из /api/scan
const fingering = ref<FingeringCoverage | null>(null);

const FILE_ROWS: FileRow[] = [
  { key: "midi", label: "MIDI" },
  { key: "xml", label: "MusicXML" },
  { key: "pdf", label: "PDF" },
  { key: "image", label: "Картинка" },
  { key: "audio", label: "Аудио" },
];

async function browse() {
  const selected = await chooseNativeFile();
  if (!selected.path) return showBrowseError(selected.error);
  path.value = selected.path;
  await scan();
}

async function pickFor(category: Category) {
  const selected = await chooseNativeFile();
  if (!selected.path || !files.value) return showBrowseError(selected.error);
  if (category === "audio") {
    if (!files.value.audio.includes(selected.path)) files.value.audio.push(selected.path);
  } else {
    files.value[category] = selected.path;
  }
}

function showBrowseError(error?: string) {
  if (error) result.value = { ok: false, message: error };
}

function clearFile(category: Category, index?: number) {
  if (!files.value) return;
  if (category === "audio" && typeof index === "number") {
    files.value.audio.splice(index, 1);
  } else if (category !== "audio") {
    files.value[category] = undefined;
  }
}

const liveWarnings = computed(() => {
  if (!files.value) return [] as string[];
  const w: string[] = [];
  if (!files.value.midi && !files.value.xml)
    w.push("Нет MIDI/MusicXML — Piano Marvel требует хотя бы один для нотной дорожки.");
  if (!files.value.pdf) w.push("Нет PDF с нотами (необязательно, но обычно нужен).");
  if (!files.value.image) w.push("Нет картинки для превью (необязательно).");
  if (files.value.audio.length === 0) w.push("Нет аудиофайла (необязательно).");
  return w;
});

const blockUploadReason = computed(() => {
  if (!loggedIn.value) return "Сначала войдите в Piano Marvel (кнопка вверху).";
  if (!form.title.trim()) return "Заполните название композиции.";
  if (
    form.defaultTempo !== undefined &&
    form.defaultTempo !== "" &&
    (form.defaultTempo < TEMPO.min || form.defaultTempo > TEMPO.max)
  )
    return `Темп должен быть от ${TEMPO.min} до ${TEMPO.max} BPM.`;
  if (!files.value?.midi && !files.value?.xml)
    return "Нужен MIDI или MusicXML файл нотной дорожки.";
  if (
    form.assessmentMode !== "Play Only" &&
    form.createLearningMode &&
    form.learningStrategy === "adaptive" &&
    !files.value?.xml
  )
    return "Для Adaptive-обучения нужен MusicXML; добавьте его или выберите обычный Predict.";
  return "";
});
const canUpload = computed(() => !uploading.value && !blockUploadReason.value);

async function scan() {
  if (!path.value.trim()) return;
  const run = scanRequest.begin();
  const requestedPath = path.value.trim();
  scanning.value = true;
  result.value = null;
  try {
    const res = await fetch(`/api/scan?path=${encodeURIComponent(requestedPath)}`, {
      signal: run.signal,
    });
    const data = await res.json();
    if (!run.isCurrent()) return;
    if (data.error) {
      result.value = { ok: false, message: data.error };
      files.value = null;
      return;
    }
    applyScanData(data);
  } catch (err) {
    if (!run.isCurrent()) return;
    result.value = { ok: false, message: String(err) };
  } finally {
    if (run.isCurrent()) scanning.value = false;
  }
}

// CHANGED: общая подстановка files+guess — используется и локальным сканом,
// и результатом скачивания с MuseScore (ответы /api/scan и /api/musescore/fetch
// имеют одинаковую форму {files, guess}).
function applyScanData(data: { files: MatchedFiles; guess: Record<string, any> }) {
  files.value = data.files;
  const guess = data.guess ?? {};
  form.title = guess.title || form.title;
  form.composer = guess.composer || form.composer;
  form.artist = guess.artist || form.artist;
  form.copyright = guess.copyright ?? "";
  form.defaultTempo = guess.defaultTempo;
  form.difficulty = guess.difficulty ?? DIFFICULTY.default;
  form.genres = Array.isArray(guess.genres) ? guess.genres : [];
  // CHANGED: полную авторскую аппликатуру не переписываем — снимаем галочку
  fingering.value = (guess.fingering as FingeringCoverage | undefined) ?? null;
  // Каждый новый scan заново получает безопасный default: состояние предыдущей
  // партитуры не должно «прилипать» к следующему файлу.
  form.autoFingering = !fingering.value?.hasFingering;
}

// CHANGED: MuseScore скачал полный комплект — подставляем в pipeline и открываем акт III.
function onMuseScoreFetched(payload: { files: MatchedFiles; guess: Record<string, any> }) {
  result.value = null;
  applyScanData(payload);
  void nextTick(() => {
    document.querySelector(".metadata-movement")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function upload() {
  if (!files.value || !canUpload.value) return;
  const uploadTitle = form.title.trim();
  uploading.value = true;
  result.value = null;
  showDetail.value = false;
  uploadToasts[CURRENT_UPLOAD_TOAST] = {
    id: CURRENT_UPLOAD_TOAST,
    title: uploadTitle,
    message: "Загружаю файлы в Piano Marvel…",
    tone: "progress",
  };
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: {
          midi: files.value.midi,
          xml: files.value.xml,
          audio: files.value.audio,
          pdf: files.value.pdf,
          image: files.value.image,
        },
        metadata: form,
      }),
    });
    const data = await res.json();
    result.value = { ok: data.success, message: data.message, url: data.url, detail: data.serverDetail };
    if (!data.success) {
      uploadToasts[CURRENT_UPLOAD_TOAST] = {
        id: CURRENT_UPLOAD_TOAST,
        title: uploadTitle,
        message: cleanError(data.message ?? `HTTP ${res.status}`),
        tone: "error",
        progress: 100,
      };
    } else if (data.learningJob) {
      const job = data.learningJob as LearningJob;
      delete uploadToasts[CURRENT_UPLOAD_TOAST];
      uploadToasts[job.id] = {
        id: job.id,
        title: uploadTitle,
        message: `Композиция загружена · ${job.message}`,
        tone: "progress",
        progress: job.progress,
      };
      watchUploadedLearning(job, uploadTitle);
    } else {
      uploadToasts[CURRENT_UPLOAD_TOAST] = {
        id: CURRENT_UPLOAD_TOAST,
        title: uploadTitle,
        message: "Композиция успешно загружена",
        tone: "success",
        progress: 100,
      };
    }
  } catch (err) {
    result.value = { ok: false, message: String(err) };
    uploadToasts[CURRENT_UPLOAD_TOAST] = {
      id: CURRENT_UPLOAD_TOAST,
      title: uploadTitle,
      message: cleanError(err),
      tone: "error",
      progress: 100,
    };
  } finally {
    uploading.value = false;
  }
}

function cleanError(error: unknown): string {
  return String(error).replace(/^(?:Error|TimeoutError):\s*/i, "");
}

/** Long-poll: следующий ответ приходит только после server-side update(job). */
function watchUploadedLearning(initial: LearningJob, title: string) {
  const controller = new AbortController();
  uploadWatchers.add(controller);
  void (async () => {
    let job = initial;
    try {
      while (job.state === "queued" || job.state === "running") {
        const response = await fetch(
          `/api/learning-jobs/${job.id}?after=${job.version}`,
          { signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        job = data.job as LearningJob;
        uploadToasts[job.id] = {
          id: job.id,
          title,
          message:
            job.state === "completed"
              ? "Композиция загружена · обучающий режим готов"
              : job.state === "failed"
                ? `Композиция загружена · обучение остановлено: ${cleanError(job.error ?? job.message)}`
                : job.message,
          tone:
            job.state === "completed"
              ? "success"
              : job.state === "failed"
                ? "error"
                : "progress",
          progress: job.state === "failed" ? Math.max(job.progress, 1) : job.progress,
        };
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      uploadToasts[job.id] = {
        id: job.id,
        title,
        message: `Не удалось получить статус обучения: ${cleanError(error)}`,
        tone: "error",
        progress: job.progress,
      };
    } finally {
      uploadWatchers.delete(controller);
    }
  })();
}

function closeUploadToast(id: string) {
  delete uploadToasts[id];
}

function reset() {
  path.value = "";
  files.value = null;
  result.value = null;
  showDetail.value = false;
  form.title = "";
  form.subTitle = "";
  form.composer = "";
  form.artist = "";
  form.copyright = "";
  form.difficulty = DIFFICULTY.default;
  form.defaultTempo = undefined;
  form.genres = [];
  form.assessmentMode = "Learn & Play";
  form.createLearningMode = true;
  form.learningStrategy = "adaptive";
}
</script>

<template>
  <div class="app">
    <!-- CHANGED: док источника и навигация живут в одном sticky-ряду —
         одна высота, один радиус, одно стекло, одна линия отсчёта. -->
    <div class="topbar-row">
      <div class="source-mode-dock">
        <span class="source-mode-dock-step" aria-hidden="true">01</span>
        <ModeSwitch
          class="source-mode-toggle"
          variant="dock"
          label="Источник композиции"
          controls="login"
          :options="SOURCE_MODES"
          :model-value="sourceMode"
          @update:model-value="selectSourceMode"
        />
      </div>

      <nav class="topbar" aria-label="Навигация по инструменту">
        <a class="topbar-brand" href="#top" aria-label="Piano Marvel Uploader — наверх">
          <span class="brand-mark"><UiIcon name="music" :size="18" /></span>
          <span>PIANO MARVEL <i>/ UPLOADER</i></span>
        </a>
        <div class="topbar-links">
          <a href="#upload-flow">Собрать</a>
          <a href="#login">Войти</a>
          <a href="#publish">Издать</a>
          <a href="#library">Обучать</a>
        </div>
        <a class="topbar-cta" href="#upload-flow">
          Начать <UiIcon name="arrow-down" :size="16" />
        </a>
      </nav>
    </div>

    <header id="top" class="hero" :class="`hero--${sourceMode}`">
      <div class="hero-copy">
        <div class="hero-index" aria-hidden="true">
          <span>01—03</span>
          <i />
          <span>Digital score desk</span>
        </div>
        <!-- CHANGED: тот же слайдер, что и в шапке — вариант для цветной плоскости. -->
        <ModeSwitch
          class="hero-mode-switch"
          variant="hero"
          label="Источник композиции"
          controls="hero-mode-copy"
          captions
          :options="SOURCE_MODES"
          :model-value="sourceMode"
          @update:model-value="sourceMode = $event as 'local' | 'musescore'"
        />
        <div id="hero-mode-copy" class="hero-mode-copy" role="tabpanel">
            <div class="eyebrow">
              <span class="dyn">{{ sourceMode === "musescore" ? "01" : "02" }}</span>
              {{ sourceMode === "musescore" ? "Всемирная библиотека партитур" : "Автоматическая сборка с диска" }}
            </div>
            <h1>
              <span>{{ sourceMode === "musescore" ? "Найти" : "Собрать" }}</span>
              <em class="hero-wordmark" :class="`is-${sourceMode}`">
                <i>{{ sourceMode === "musescore" ? "MUSE" : "С" }}</i>
                <b>{{ sourceMode === "musescore" ? "SCORE" : "ДИСКА" }}</b>
              </em>
            </h1>
            <p class="subtitle">
              {{
                sourceMode === "musescore"
                  ? "Введите название или ссылку — мы найдём партитуру, импортируем файлы и подготовим цифровое издание."
                  : "Выберите один локальный файл — MIDI, MusicXML, PDF, аудио и обложка с тем же именем найдутся автоматически."
              }}
            </p>
            <div class="hero-actions">
              <a class="hero-primary-action" href="#upload-flow">
                <span>Начать загрузку</span>
                <UiIcon name="arrow-down" :size="18" />
              </a>
              <a class="hero-secondary-action" href="#upload-flow">
                К маршруту <span aria-hidden="true">↘</span>
              </a>
            </div>
          </div>
      </div>
      <div class="hero-score">
        <div class="hero-score-meta">
          <span>{{ sourceMode === "musescore" ? "Score discovery" : "Local intake" }}</span>
          <span>Live preview</span>
        </div>
        <div class="hero-score-stage">
          <span class="hero-score-stage-label">
            {{ sourceMode === "musescore" ? "Каталог найден · готов к импорту" : "Комплект найден · готов к проверке" }}
          </span>
          <FurEliseStaff />
        </div>
        <div class="hero-score-route" aria-hidden="true">
          <span class="is-current">{{ sourceMode === "musescore" ? "Поиск" : "Файлы" }}</span>
          <i />
          <span>Проверка</span>
          <i />
          <span>Издание</span>
        </div>
        <div class="hero-score-footer">
          <p>
            {{ sourceMode === "musescore" ? "Партитура" : "Один файл." }}<br />
            <em>{{ sourceMode === "musescore" ? "без трения." : "Весь комплект." }}</em>
          </p>
          <span>
            {{ sourceMode === "musescore" ? "Поиск · импорт · публикация" : "MIDI · XML · PDF · AUDIO" }}<br />
            {{ sourceMode === "musescore" ? "без ручной рутины" : "совпадения найдём сами" }}
          </span>
        </div>
      </div>
    </header>

    <main id="upload-flow" class="movements">
      <!-- CHANGED: единый flow. Шаг 1 (опционально) — выбор источника нот
           (MuseScore или локальный файл). Шаг 2 (обязательно) — вход в Piano Marvel. -->
      <div id="login" class="flow-step">
        <p class="flow-step-tag">
          {{ sourceMode === "musescore" ? "Шаг 1 · основной · найдите композицию" : "Шаг 1 · вручную · выберите локальный файл" }}
        </p>

        <!-- CHANGED: плавный кросс-фейд между источниками. .source-panel держит
             grid-column и служит контекстом позиционирования; уходящий компонент
             становится absolute, поэтому высота сразу равна входящему — без
             схлопывания-и-роста (было причиной рывка). -->
        <div class="source-panel">
          <Transition name="src-swap">
            <FileMovement
              v-if="sourceMode === 'local'"
              key="local"
              v-model:path="path"
              :scanning="scanning"
              :files="files"
              :rows="FILE_ROWS"
              :warnings="liveWarnings"
              :scan-result="result"
              @browse="browse"
              @scan="scan"
              @pick="pickFor"
              @clear="clearFile"
            />
            <MuseScoreMovement v-else key="musescore" @fetched="onMuseScoreFetched" />
          </Transition>
        </div>
      </div>

      <div class="flow-step">
        <p class="flow-step-tag">Шаг 2 · обязательно · вход в Piano Marvel</p>
        <AuthMovement
          :state="loginState"
          :label="loginLabel"
          :checking="checkingSession"
          index="II"
          @login="login"
          @complete="completeLogin"
          @check="checkSession"
        />
      </div>

      <MetadataMovement
        id="publish"
        :form="form"
        :genres="allGenres"
        :difficulty="DIFFICULTY"
        :tempo="TEMPO"
        :can-upload="canUpload"
        :uploading="uploading"
        :block-reason="blockUploadReason"
        :result="result"
        :show-detail="showDetail"
        :locked="!files"
        :fingering="fingering"
        :has-xml="Boolean(files?.xml)"
        @upload="upload"
        @reset="reset"
        @toggle-detail="showDetail = !showDetail"
      />
    </main>

    <!-- CHANGED: раздел 03 (библиотека) показываем ТОЛЬКО после входа —
         иначе кэш выглядел бы как реальные данные без реальной сессии -->
    <PiecesMovement id="library" v-if="loggedIn" :logged-in="loggedIn" />
    <footer class="colophon">
      <UiIcon name="music" :size="16" />
      <span>Piano&nbsp;Marvel Uploader</span>
      <span class="sep">·</span>
      <span>локальный инструмент</span>
    </footer>
  </div>

  <!-- CHANGED: toast хода/итога проверки сессии (стили .status-toast уже есть) -->
  <Teleport to="body">
    <Transition name="status-toast">
      <aside
        v-if="sessionToast"
        class="status-toast"
        :class="sessionToast.tone"
        :role="sessionToast.tone === 'error' ? 'alert' : 'status'"
        aria-live="polite"
        aria-atomic="true"
      >
        <span class="status-toast-icon" aria-hidden="true">
          <UiIcon
            :name="
              sessionToast.tone === 'success'
                ? 'check'
                : sessionToast.tone === 'error'
                  ? 'warning'
                  : 'refresh'
            "
            :size="18"
          />
        </span>
        <div class="status-toast-content">
          <strong>Сессия Piano Marvel</strong>
          <span>{{ sessionToast.message }}</span>
        </div>
        <button type="button" aria-label="Закрыть уведомление" @click="sessionToast = null">
          <UiIcon name="close" :size="15" />
        </button>
      </aside>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <div v-if="Object.keys(uploadToasts).length" class="upload-toast-stack" aria-live="polite">
      <TransitionGroup name="status-toast">
        <aside
          v-for="toast in uploadToasts"
          :key="toast.id"
          class="status-toast upload-status-toast"
          :class="toast.tone"
          :role="toast.tone === 'error' ? 'alert' : 'status'"
          aria-atomic="true"
        >
          <span class="status-toast-icon" aria-hidden="true">
            <UiIcon
              :name="toast.tone === 'success' ? 'check' : toast.tone === 'error' ? 'warning' : 'refresh'"
              :size="18"
            />
          </span>
          <div class="status-toast-content">
            <strong>{{ toast.title }}</strong>
            <span>{{ toast.message }}</span>
            <span
              class="status-toast-progress"
              :class="{ indeterminate: toast.progress === undefined }"
              aria-hidden="true"
            >
              <i :style="toast.progress === undefined ? undefined : { width: `${toast.progress}%` }" />
            </span>
          </div>
          <button type="button" aria-label="Закрыть уведомление" @click="closeUploadToast(toast.id)">
            <UiIcon name="close" :size="15" />
          </button>
        </aside>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
