<script setup lang="ts">
// CHANGED (переработка) — поиск/автозагрузка нот с MuseScore.com
// (prd-musescore-integration.md, схема B). Теперь:
//  • прямой ввод URL стилизован и подписан (был невзрачный белый инпут из-за type=url);
//  • статус входа в MuseScore проверяется сразу и виден отдельной панелью (как у
//    Piano Marvel), с кнопками «Войти» / «Я вошёл — проверить»;
//  • скачивание идёт фоновым job'ом с живым тостом прогресса (long-poll), а не
//    «мёртвым» спиннером; каждый шаг логируется на сервере.
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import UiIcon from "./UiIcon.vue";
import type { MatchedFiles, MuseScoreSearchResult } from "../ui-types";

const emit = defineEmits<{
  fetched: [payload: { files: MatchedFiles; guess: Record<string, unknown> }];
}>();

// ── Поиск / прямой URL ───────────────────────────────────────────────────────
const query = ref("");
const searching = ref(false);
const results = ref<MuseScoreSearchResult[]>([]);
const searched = ref(false);
const error = ref("");
const selectedId = ref<string | null>(null);
const currentPage = ref(1);
type SortMode = "popular" | "saved" | "rated" | "relevance";
const sortMode = ref<SortMode>("popular");
const PAGE_SIZE = 6;

// CHANGED: фильтры для более точного поиска подходящей партитуры.
type LevelFilter = "" | "Beginner" | "Intermediate" | "Advanced";
const levelFilter = ref<LevelFilter>("");
const hidePro = ref(false); // скрыть партитуры, требующие MuseScore PRO
const officialOnly = ref(false); // только официальные издания
// Пороги по метрикам — ПРОПОРЦИОНАЛЬНЫЕ (доля от максимума в текущей выборке),
// не абсолютные: для редких композиций «топ» может быть ~600 лайков, и порог
// «100 тыс.+» отсёк бы всё. Значение 0..1 = доля от максимума метрики.
const minVotesPct = ref(0); // ★ (голоса)
const minSavesPct = ref(0); // 🔖 (сохранения)
const minViewsPct = ref(0); // 👁 (просмотры)

const LEVELS: { value: LevelFilter; label: string }[] = [
  { value: "", label: "Все" },
  { value: "Beginner", label: "Beg" },
  { value: "Intermediate", label: "Interm" },
  { value: "Advanced", label: "Adv" },
];
// Ступени качества как доля от максимума метрики в наборе.
const QUALITY_STEPS: { value: number; label: string }[] = [
  { value: 0, label: "любые" },
  { value: 0.25, label: "≥ 25%" },
  { value: 0.5, label: "≥ 50%" },
  { value: 0.75, label: "≥ 75%" },
  { value: 0.9, label: "топ 10%" },
];

// Максимумы метрик по ПОЛНОМУ набору results — стабильная база: не зависит от
// других активных фильтров, поэтому пропорция всегда «в рамках этой выборки».
const metricMax = computed(() => {
  let votes = 0;
  let saves = 0;
  let views = 0;
  for (const r of results.value) {
    if ((r.votes ?? 0) > votes) votes = r.votes ?? 0;
    if ((r.saves ?? 0) > saves) saves = r.saves ?? 0;
    if ((r.views ?? 0) > views) views = r.views ?? 0;
  }
  return { votes, saves, views };
});

const filteredResults = computed(() => {
  const max = metricMax.value;
  return results.value.filter((r) => {
    if (levelFilter.value && r.difficulty !== levelFilter.value) return false;
    if (hidePro.value && r.requiresPro) return false;
    if (officialOnly.value && !r.isOfficial) return false;
    if (minVotesPct.value && max.votes && (r.votes ?? 0) < minVotesPct.value * max.votes) return false;
    if (minSavesPct.value && max.saves && (r.saves ?? 0) < minSavesPct.value * max.saves) return false;
    if (minViewsPct.value && max.views && (r.views ?? 0) < minViewsPct.value * max.views) return false;
    return true;
  });
});

const activeFilterCount = computed(
  () =>
    (levelFilter.value ? 1 : 0) +
    (hidePro.value ? 1 : 0) +
    (officialOnly.value ? 1 : 0) +
    (minVotesPct.value ? 1 : 0) +
    (minSavesPct.value ? 1 : 0) +
    (minViewsPct.value ? 1 : 0),
);

function resetFilters() {
  levelFilter.value = "";
  hidePro.value = false;
  officialOnly.value = false;
  minVotesPct.value = 0;
  minSavesPct.value = 0;
  minViewsPct.value = 0;
}

const sortedResults = computed(() => {
  if (sortMode.value === "relevance") return filteredResults.value;
  const metrics = (result: MuseScoreSearchResult): number[] => {
    if (sortMode.value === "saved") return [result.saves ?? -1, result.views ?? -1, result.votes ?? -1];
    if (sortMode.value === "rated") return [result.votes ?? -1, result.rating ?? -1, result.views ?? -1];
    return [result.views ?? -1, result.saves ?? -1, result.votes ?? -1, result.rating ?? -1];
  };
  return filteredResults.value
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
});
const pageCount = computed(() => Math.max(1, Math.ceil(sortedResults.value.length / PAGE_SIZE)));
const pageResults = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE;
  return sortedResults.value.slice(start, start + PAGE_SIZE);
});
const pageNumbers = computed(() => Array.from({ length: pageCount.value }, (_, index) => index + 1));
const selectedResult = computed(
  () => results.value.find((result) => result.scoreId === selectedId.value) ?? null,
);
watch([sortMode, levelFilter, hidePro, officialOnly, minVotesPct, minSavesPct, minViewsPct], () => {
  currentPage.value = 1;
});

const directUrl = ref("");
const DIRECT_ID = "__direct__";
const fetchingId = ref<string | null>(null);

// ── Вход в MuseScore ──────────────────────────────────────────────────────────
// unknown = вход ни разу не проверялся (стартовое состояние, БЕЗ запуска браузера);
// checking = идёт явная проверка через браузер (по кнопке).
type MsState = "unknown" | "checking" | "loggedOut" | "waiting" | "loggedIn";
const msState = ref<MsState>("unknown");
const msBusy = ref(false);

const msLabel = computed(() => {
  switch (msState.value) {
    case "loggedIn":
      return "Вход в MuseScore подтверждён";
    case "checking":
      return "Проверяю вход в MuseScore…";
    case "waiting":
      return "Войдите в открывшемся окне Chrome, затем подтвердите здесь";
    case "loggedOut":
      return "Вход в MuseScore не выполнен — скачивание упрётся в paywall";
    default:
      return "Вход в MuseScore не проверялся (нужен только для скачивания)";
  }
});

/** Ответ /status: {loggedIn, checked, state}. checked=false → ещё не проверяли. */
function applyStatus(data: { loggedIn?: boolean; state?: string; checked?: boolean }) {
  if (data.loggedIn === true) {
    msState.value = "loggedIn";
    return;
  }
  if (data.state === "waiting") {
    msState.value = "waiting";
    return;
  }
  if (data.checked === false) {
    msState.value = "unknown";
    return;
  }
  msState.value = data.loggedIn ? "loggedIn" : "loggedOut";
}

async function readJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(res.ok ? "Пустой ответ сервера" : `HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Некорректный JSON от сервера");
  }
}

/** Дёшево, БЕЗ браузера — только сохранённый флаг последней проверки. */
async function refreshCheap() {
  try {
    const res = await fetch("/api/musescore/status");
    applyStatus(await readJson(res));
  } catch {
    msState.value = "unknown";
  }
}

/** Явная проверка — мгновенно по кукам на диске, без очереди браузера. */
async function verifyLogin() {
  if (msBusy.value) return;
  msBusy.value = true;
  msState.value = "checking";
  try {
    const res = await fetch("/api/musescore/status?check=cookie");
    applyStatus(await readJson(res));
  } catch {
    msState.value = "loggedOut";
  } finally {
    msBusy.value = false;
  }
}

async function loginMuseScore() {
  msState.value = "waiting";
  try {
    await fetch("/api/musescore/login", { method: "POST" });
  } catch {
    /* окно всё равно откроется; статус подтвердит completeLogin */
  }
}

async function completeLogin() {
  msBusy.value = true;
  msState.value = "checking";
  try {
    const res = await fetch("/api/musescore/login/complete", { method: "POST" });
    applyStatus(await readJson(res));
  } catch {
    msState.value = "loggedOut";
  } finally {
    msBusy.value = false;
  }
}

onMounted(refreshCheap); // старт: дёшево, без браузера

// ── Прогресс-тост (job long-poll) ─────────────────────────────────────────────
interface JobToast {
  tone: "progress" | "success" | "error";
  message: string;
  progress?: number;
}
interface MuseScoreFetchJobPayload {
  id: string;
  state: string;
  progress: number;
  message: string;
  version: number;
  loggedIn?: boolean;
  error?: string;
  result?: {
    files: MatchedFiles;
    guess: Record<string, unknown>;
    readyForPipeline?: boolean;
    fetched?: { dir?: string };
  };
}
interface MuseScoreSearchResponse {
  error?: string;
  results?: MuseScoreSearchResult[];
}
interface MuseScoreJobResponse {
  error?: string;
  job?: MuseScoreFetchJobPayload;
}
const jobToast = ref<JobToast | null>(null);
const pollController = ref<AbortController | null>(null);

onUnmounted(() => pollController.value?.abort());

async function search() {
  const q = query.value.trim();
  if (!q || searching.value) return;
  searching.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams({ q });
    const res = await fetch(`/api/musescore/search?${params}`);
    const data = await readJson<MuseScoreSearchResponse>(res);
    if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
    results.value = Array.isArray(data.results)
      ? data.results.filter(
          (result) =>
            !result.isOfficial &&
            /piano|фортеп|пиано|keyboard/i.test(`${result.instrument ?? ""} ${result.title}`),
        )
      : [];
    selectedId.value = null;
    currentPage.value = 1;
    searched.value = true;
  } catch (err) {
    error.value = clean(err);
    results.value = [];
    selectedId.value = null;
    currentPage.value = 1;
  } finally {
    searching.value = false;
  }
}

function selectResult(result: MuseScoreSearchResult) {
  selectedId.value = result.scoreId;
}

function setPage(page: number) {
  currentPage.value = Math.min(pageCount.value, Math.max(1, page));
}

function fetchSelected() {
  if (!selectedResult.value) return;
  return pick(selectedResult.value);
}

/** Общий запуск скачивания: POST → job → long-poll с обновлением тоста. */
async function startFetch(
  body: { url?: string; scoreId?: string; baseName?: string; author?: string },
  spinnerId: string,
) {
  if (fetchingId.value) return;
  fetchingId.value = spinnerId;
  error.value = "";
  jobToast.value = { tone: "progress", message: "Ставлю задачу в очередь…", progress: 0 };
  pollController.value?.abort();
  const controller = new AbortController();
  pollController.value = controller;

  try {
    const res = await fetch("/api/musescore/fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson<MuseScoreJobResponse>(res);
    if (!res.ok || data.error || !data.job) throw new Error(data.error ?? `HTTP ${res.status}`);

    let job = data.job;
    jobToast.value = { tone: "progress", message: job.message, progress: job.progress };

    while (job.state === "queued" || job.state === "running") {
      const poll = await fetch(`/api/musescore/fetch-jobs/${job.id}?after=${job.version}`, {
        signal: controller.signal,
      });
      const pd = await readJson<MuseScoreJobResponse>(poll);
      if (!poll.ok || pd.error || !pd.job) throw new Error(pd.error ?? `HTTP ${poll.status}`);
      job = pd.job;
      jobToast.value = { tone: "progress", message: job.message, progress: job.progress };
    }

    if (job.state === "completed" && job.result) {
      const files = job.result.files;
      const got = [
        files.midi && "MIDI",
        files.xml && "MusicXML",
        files.pdf && "PDF",
        files.audio.length && "Audio",
      ]
        .filter(Boolean)
        .join(", ");

      if (job.result.readyForPipeline) {
        emit("fetched", { files, guess: job.result.guess ?? {} });
      }

      if (typeof job.loggedIn === "boolean" && msState.value !== "waiting") {
        msState.value = job.loggedIn ? "loggedIn" : "loggedOut";
      }

      const savedDir = job.result.fetched?.dir;
      jobToast.value =
        job.result.readyForPipeline && got
          ? {
              tone: "success",
              message: `Скачано: ${got}. Акт III открыт ниже${savedDir ? ` · ${savedDir}` : ""}.`,
              progress: 100,
            }
          : got
            ? {
                tone: "error",
                progress: 100,
                message:
                  `Скачано частично (${got}), но не хватает обязательных форматов для акта III. ` +
                  (savedDir ? `Файлы: ${savedDir}` : ""),
              }
            : {
                tone: "error",
                progress: 100,
                message:
                  (job.loggedIn === false
                    ? "Не вошли в MuseScore — нажмите «Войти в MuseScore» выше и повторите. "
                    : "") + "Не удалось скачать ни одного формата (см. предупреждения ниже).",
              };
    } else {
      jobToast.value = {
        tone: "error",
        progress: 100,
        message:
          (job.loggedIn === false
            ? "Похоже, вы не вошли в MuseScore. Войдите выше и повторите. "
            : "") + (job.error ? clean(job.error) : "Скачивание не удалось."),
      };
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    jobToast.value = { tone: "error", message: clean(err), progress: 100 };
  } finally {
    if (pollController.value === controller) pollController.value = null;
    fetchingId.value = null;
  }
}

function pick(result: MuseScoreSearchResult) {
  return startFetch(
    { url: result.url, scoreId: result.scoreId, baseName: result.title },
    result.scoreId,
  );
}

/** Достаёт scoreId и нормализует ссылку на ноту MuseScore. */
function parseScoreUrl(raw: string): { url: string; scoreId: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProto);
  } catch {
    return null;
  }
  if (!/(^|\.)musescore\.com$/i.test(parsed.hostname)) return null;
  const id = parsed.pathname.match(/\/scores\/(\d+)/)?.[1];
  if (!id) return null;
  return { url: `${parsed.origin}${parsed.pathname}`, scoreId: id };
}

async function fetchDirect() {
  if (fetchingId.value) return;
  const parsed = parseScoreUrl(directUrl.value);
  if (!parsed) {
    error.value = "Это не похоже на ссылку на ноту MuseScore (нужен адрес вида …/scores/9901456).";
    return;
  }
  await startFetch({ url: parsed.url, scoreId: parsed.scoreId }, DIRECT_ID);
}

function clean(err: unknown): string {
  const message = String(err).replace(/^(?:Error|TimeoutError):\s*/i, "");
  if (/failed to fetch|connection refused|networkerror/i.test(message)) {
    return "Локальный API недоступен. Запустите приложение через `bun run dev` и повторите поиск.";
  }
  return message;
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatMetric(value?: number): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}
</script>

<template>
  <section class="movement musescore-movement">
    <header class="movement-head">
      <span class="movement-num">I</span>
      <div>
        <p class="movement-kicker">Первый акт · вариант</p>
        <h2>Возьмите с MuseScore</h2>
      </div>
      <span class="movement-meta">musescore.com</span>
    </header>

    <p class="movement-lead">
      Вставьте ссылку на ноту — инструмент сам скачает MusicXML, MIDI и аудио под
      одним именем и передаст дальше. Или найдите ноту по названию и автору.
    </p>

    <!-- Статус входа: тонкая строка-«регистр», а не карточка -->
    <div class="ms-auth" :class="msState" aria-live="polite">
      <span class="ms-auth-dot" aria-hidden="true" />
      <div class="ms-auth-text">
        <span class="ms-auth-kicker">аккаунт musescore</span>
        <span class="ms-auth-label">{{ msLabel }}</span>
      </div>
      <div class="ms-auth-actions">
        <template v-if="msState === 'waiting'">
          <button class="ms-btn ghost" @click="loginMuseScore">
            <UiIcon name="external" :size="15" /><span>Открыть окно</span>
          </button>
          <button class="ms-btn" :disabled="msBusy" @click="completeLogin">
            <span v-if="msBusy" class="spin" aria-hidden="true" />
            <UiIcon v-else name="check" :size="15" /><span>Я вошёл</span>
          </button>
        </template>
        <template v-else-if="msState === 'loggedIn'">
          <button class="ms-btn ghost" :disabled="msBusy" @click="verifyLogin">
            <span v-if="msBusy" class="spin" aria-hidden="true" />
            <UiIcon v-else name="refresh" :size="15" /><span>Проверить</span>
          </button>
        </template>
        <template v-else>
          <button class="ms-btn ghost" :disabled="msBusy" @click="verifyLogin">
            <span v-if="msBusy" class="spin" aria-hidden="true" />
            <span v-else>{{ msState === "loggedOut" ? "Проверить снова" : "Проверить" }}</span>
          </button>
          <button class="ms-btn" :disabled="msBusy" @click="loginMuseScore">
            <UiIcon name="external" :size="15" /><span>Войти</span>
          </button>
        </template>
      </div>
    </div>

    <!-- CHANGED: раздел перерисован. Два способа ввода — это два «слота»-карточки
         в одной композиции (оба видны сразу, без вертикального стека и «или»).
         Способ 01 «по ссылке» — первичный (акцентная планка + синий глиф),
         способ 02 «по названию» — поиск с постоянными фильтрами. -->
    <div class="ms-intake">
      <div class="ms-lane ms-lane--primary" :class="{ 'is-busy': fetchingId === DIRECT_ID }">
        <div class="ms-lane-head">
          <span class="ms-lane-glyph" aria-hidden="true"><UiIcon name="external" :size="18" /></span>
          <div class="ms-lane-head-text">
            <span class="ms-lane-kicker">Способ 01 · по ссылке</span>
            <strong class="ms-lane-title">Вставьте адрес ноты</strong>
          </div>
          <span class="ms-chip">быстрый путь</span>
        </div>
        <div class="ms-field">
          <span class="ms-field-glyph" aria-hidden="true"><UiIcon name="external" :size="18" /></span>
          <input
            id="ms-url"
            v-model="directUrl"
            type="text"
            class="ms-field-input"
            placeholder="musescore.com/user/…/scores/…"
            aria-label="Ссылка на ноту MuseScore"
            @keyup.enter="fetchDirect"
          />
        </div>
        <button
          class="ms-field-action ms-lane-action"
          :disabled="!directUrl.trim() || fetchingId !== null"
          @click="fetchDirect"
        >
          <span v-if="fetchingId === DIRECT_ID" class="spin" aria-hidden="true" />
          <template v-else>
            <span>Загрузить</span>
            <UiIcon name="arrow-down" :size="16" />
          </template>
        </button>
        <p class="ms-hint">Скопируйте адрес страницы ноты из браузера — заберём MusicXML, MIDI и аудио под одним именем.</p>
      </div>

      <div class="ms-lane">
        <div class="ms-lane-head">
          <span class="ms-lane-glyph" aria-hidden="true"><UiIcon name="search" :size="18" /></span>
          <div class="ms-lane-head-text">
            <span class="ms-lane-kicker">Способ 02 · по названию</span>
            <strong class="ms-lane-title">Найдите ноту в каталоге</strong>
          </div>
        </div>
        <div class="ms-field ms-field--soft">
          <span class="ms-field-glyph" aria-hidden="true"><UiIcon name="search" :size="18" /></span>
          <input
            v-model="query"
            type="text"
            class="ms-field-input"
            placeholder="Interstellar · Hans Zimmer · piano"
            aria-label="Поисковый запрос MuseScore"
            @keyup.enter="search"
          />
        </div>
        <button class="ms-field-action ghost ms-lane-action" :disabled="!query.trim() || searching" @click="search">
          <span v-if="searching" class="spin" aria-hidden="true" />
          <template v-else><UiIcon name="search" :size="16" /><span>Искать</span></template>
        </button>
        <div class="ms-search-rules" aria-label="Постоянные фильтры поиска">
          <span><UiIcon name="check" :size="13" /> Только Piano</span>
          <span><UiIcon name="check" :size="13" /> Official скрыты</span>
          <small>Только партитуры, которые можно передать в загрузчик.</small>
        </div>
      </div>
    </div>

    <div v-if="error" class="ms-alert" role="alert">
      <UiIcon name="warning" :size="16" />
      <span>{{ error }}</span>
    </div>

    <p v-if="searched && !results.length && !searching && !error" class="ms-empty">
      Подходящих фортепианных партитур не нашлось. Official-издания и результаты без Piano исключены.
    </p>

    <section v-if="results.length" class="ms-picker" aria-label="Результаты поиска MuseScore">
      <header class="ms-picker-head">
        <div>
          <span class="ms-picker-kicker">Shortlist</span>
          <strong>{{ filteredResults.length }} подходящих партитур</strong>
          <!-- CHANGED: если фильтры сузили выборку — показываем из скольких -->
          <span v-if="activeFilterCount" class="ms-picker-subcount">
            отфильтровано из {{ results.length }}
          </span>
        </div>
        <div class="ms-picker-tools">
          <label class="ms-sort">
            <UiIcon name="sort" :size="14" />
            <span class="sr-only">Сортировка результатов</span>
            <select v-model="sortMode" aria-label="Сортировка результатов">
              <option value="popular">Сначала популярные</option>
              <option value="saved">По сохранениям</option>
              <option value="rated">По числу оценок</option>
              <option value="relevance">По релевантности</option>
            </select>
          </label>
          <span class="ms-picker-page">Страница {{ currentPage }} / {{ pageCount }}</span>
        </div>
      </header>

      <!-- CHANGED: компактная панель фильтров в одну строку (на мобильном —
           горизонтальный скролл). Пороги по ★/🔖/👁 — ПРОПОРЦИОНАЛЬНЫЕ,
           доля от максимума метрики в текущей выборке. -->
      <div class="ms-filters" role="group" aria-label="Фильтры результатов">
        <div class="ms-seg" role="tablist" aria-label="Уровень сложности">
          <button
            v-for="lvl in LEVELS"
            :key="lvl.value || 'all'"
            type="button"
            role="tab"
            class="ms-seg-btn"
            :class="{ on: levelFilter === lvl.value }"
            :aria-selected="levelFilter === lvl.value"
            @click="levelFilter = lvl.value"
          >
            {{ lvl.label }}
          </button>
        </div>

        <span class="ms-fdiv" aria-hidden="true" />

        <label class="ms-metric" :class="{ on: minVotesPct > 0 }" title="Звёзды — доля от максимума в выборке">
          <UiIcon name="star" :size="13" />
          <select v-model.number="minVotesPct" aria-label="Звёзды: доля от максимума">
            <option v-for="q in QUALITY_STEPS" :key="`v${q.value}`" :value="q.value">{{ q.label }}</option>
          </select>
        </label>
        <label class="ms-metric" :class="{ on: minSavesPct > 0 }" title="Сохранения — доля от максимума в выборке">
          <UiIcon name="bookmark" :size="13" />
          <select v-model.number="minSavesPct" aria-label="Сохранения: доля от максимума">
            <option v-for="q in QUALITY_STEPS" :key="`s${q.value}`" :value="q.value">{{ q.label }}</option>
          </select>
        </label>
        <label class="ms-metric" :class="{ on: minViewsPct > 0 }" title="Просмотры — доля от максимума в выборке">
          <UiIcon name="eye" :size="13" />
          <select v-model.number="minViewsPct" aria-label="Просмотры: доля от максимума">
            <option v-for="q in QUALITY_STEPS" :key="`w${q.value}`" :value="q.value">{{ q.label }}</option>
          </select>
        </label>

        <span class="ms-fdiv" aria-hidden="true" />

        <button
          type="button"
          class="ms-toggle"
          :class="{ on: hidePro }"
          :aria-pressed="hidePro"
          @click="hidePro = !hidePro"
        >
          Без PRO
        </button>
        <button
          type="button"
          class="ms-toggle"
          :class="{ on: officialOnly }"
          :aria-pressed="officialOnly"
          @click="officialOnly = !officialOnly"
        >
          Официальные
        </button>

        <button
          v-if="activeFilterCount"
          type="button"
          class="ms-freset"
          :aria-label="`Сбросить фильтры (${activeFilterCount})`"
          @click="resetFilters"
        >
          <UiIcon name="close" :size="12" />
          <span>Сброс · {{ activeFilterCount }}</span>
        </button>
      </div>

      <p v-if="!filteredResults.length" class="ms-filter-empty">
        Ничего не подошло под фильтры.
        <button type="button" class="text-action" @click="resetFilters">Сбросить фильтры</button>
      </p>

      <ul v-else class="ms-results" role="listbox" aria-label="Выберите одну партитуру">
        <li
          v-for="r in pageResults"
          :key="r.scoreId"
          class="ms-card"
          :class="{ selected: selectedId === r.scoreId }"
          role="option"
          :aria-selected="selectedId === r.scoreId"
          tabindex="0"
          @click="selectResult(r)"
          @keydown.enter.prevent="selectResult(r)"
          @keydown.space.prevent="selectResult(r)"
        >
          <span class="ms-select-mark" aria-hidden="true">
            <UiIcon v-if="selectedId === r.scoreId" name="check" :size="14" />
          </span>
          <div class="ms-thumb">
            <img v-if="r.thumbnailUrl" :src="r.thumbnailUrl" :alt="r.title" loading="lazy" />
            <UiIcon v-else name="music" :size="22" />
          </div>
          <div class="ms-info">
            <a class="ms-title" :href="r.url" target="_blank" rel="noopener" @click.stop>{{ r.title }}</a>
            <span class="ms-arranger">
              <span>Автор публикации</span>
              <strong>{{ r.arranger || "Не указан" }}</strong>
            </span>
            <div class="ms-metrics" aria-label="Метрики MuseScore">
              <span title="Просмотры"><UiIcon name="eye" :size="13" /> {{ formatMetric(r.views) }}</span>
              <span title="Сохранения"><UiIcon name="bookmark" :size="13" /> {{ formatMetric(r.saves) }}</span>
              <span title="Оценки"><UiIcon name="star" :size="13" /> {{ formatMetric(r.votes) }}</span>
              <span v-if="r.publishedAt" class="date">{{ r.publishedAt }}</span>
            </div>
            <div class="ms-badges">
              <span class="ms-badge piano">Piano</span>
              <span v-if="r.requiresPro" class="ms-badge pro">PRO</span>
              <span v-if="r.difficulty" class="ms-badge">{{ r.difficulty }}</span>
              <span v-if="r.parts" class="ms-badge muted">{{ r.parts }} ч.</span>
              <span v-if="r.pages" class="ms-badge muted">{{ r.pages }} стр.</span>
              <span v-if="formatDuration(r.durationSeconds)" class="ms-badge muted">
                {{ formatDuration(r.durationSeconds) }}
              </span>
            </div>
          </div>
        </li>
      </ul>

      <footer class="ms-picker-footer">
        <nav v-if="pageCount > 1" class="ms-pagination" aria-label="Страницы результатов">
          <button type="button" :disabled="currentPage === 1" aria-label="Предыдущая страница" @click="setPage(currentPage - 1)">
            <UiIcon name="chevron-left" :size="15" />
          </button>
          <button
            v-for="page in pageNumbers"
            :key="page"
            type="button"
            :class="{ active: currentPage === page }"
            :aria-current="currentPage === page ? 'page' : undefined"
            @click="setPage(page)"
          >
            {{ page }}
          </button>
          <button type="button" :disabled="currentPage === pageCount" aria-label="Следующая страница" @click="setPage(currentPage + 1)">
            <UiIcon name="chevron-right" :size="15" />
          </button>
        </nav>

        <div class="ms-selection">
          <span v-if="selectedResult">
            Выбрано: <strong>{{ selectedResult.title }}</strong>
          </span>
          <span v-else>Выберите одну партитуру для проверки и загрузки</span>
          <button
            class="ms-field-action ms-take"
            :disabled="!selectedResult || fetchingId !== null"
            @click="fetchSelected"
          >
            <span v-if="selectedResult && fetchingId === selectedResult.scoreId" class="spin" aria-hidden="true" />
            <template v-else>
              <span>Загрузить выбранную</span>
              <UiIcon name="arrow-down" :size="15" />
            </template>
          </button>
        </div>
      </footer>
    </section>

    <!-- Живой тост прогресса скачивания. Teleport остаётся внутри единственного
         element-root компонента, но его содержимое по-прежнему рендерится в body. -->
    <Teleport to="body">
      <Transition name="status-toast">
        <aside
          v-if="jobToast"
          class="status-toast"
          :class="jobToast.tone"
          :role="jobToast.tone === 'error' ? 'alert' : 'status'"
          aria-live="polite"
          aria-atomic="true"
        >
          <span class="status-toast-icon" aria-hidden="true">
            <UiIcon
              :name="jobToast.tone === 'success' ? 'check' : jobToast.tone === 'error' ? 'warning' : 'refresh'"
              :size="18"
            />
          </span>
          <div class="status-toast-content">
            <strong>MuseScore</strong>
            <span>{{ jobToast.message }}</span>
            <span
              class="status-toast-progress"
              :class="{ indeterminate: jobToast.progress === undefined }"
              aria-hidden="true"
            >
              <i :style="jobToast.progress === undefined ? undefined : { width: `${jobToast.progress}%` }" />
            </span>
          </div>
          <button type="button" aria-label="Закрыть уведомление" @click="jobToast = null">
            <UiIcon name="close" :size="15" />
          </button>
        </aside>
      </Transition>
    </Teleport>
  </section>
</template>

<style scoped>
/* ── Статус входа: тонкий «регистр» с левым акцентом по состоянию ───────────── */
.ms-auth {
  display: flex;
  align-items: center;
  gap: var(--s16);
  margin: var(--s20) 0 var(--s24);
  padding: var(--s12) var(--s12) var(--s12) var(--s20);
  border: 1px solid var(--line-soft);
  border-left: 3px solid var(--muted-2);
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 8px 22px rgba(7, 29, 80, 0.05);
  transition: border-color var(--t), box-shadow var(--t);
}
.ms-auth-dot {
  position: relative;
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 50%;
  background: var(--muted-2);
}
.ms-auth-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.ms-auth-kicker {
  color: var(--muted-2);
  font-family: var(--mono);
  font-size: var(--text-caption);
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.ms-auth-label {
  color: var(--ivory-dim);
  font-size: var(--fs-sm);
}
.ms-auth-actions {
  display: flex;
  gap: var(--s8);
  flex: none;
}
.ms-auth.unknown {
  border-left-color: var(--brass-700);
}
.ms-auth.unknown .ms-auth-dot {
  background: var(--brass);
  opacity: 0.5;
}
.ms-auth.checking,
.ms-auth.waiting {
  border-left-color: var(--brass);
}
.ms-auth.checking .ms-auth-dot,
.ms-auth.waiting .ms-auth-dot {
  background: var(--brass);
}
.ms-auth.checking .ms-auth-dot::after,
.ms-auth.waiting .ms-auth-dot::after {
  content: "";
  position: absolute;
  inset: -5px;
  border: 1px solid var(--brass);
  border-radius: 50%;
  animation: ms-ping 1.5s var(--ease) infinite;
}
.ms-auth.loggedOut {
  border-left-color: var(--rose);
}
.ms-auth.loggedOut .ms-auth-dot {
  background: var(--rose);
  box-shadow: 0 0 12px rgba(217, 138, 138, 0.4);
}
.ms-auth.loggedIn {
  border-left-color: var(--sage);
  background: linear-gradient(90deg, rgba(24, 121, 87, 0.07), #fff 55%);
}
.ms-auth.loggedIn .ms-auth-dot {
  background: var(--sage);
  box-shadow: 0 0 12px rgba(142, 199, 156, 0.45);
}
@keyframes ms-ping {
  from {
    opacity: 0.8;
    transform: scale(0.5);
  }
  to {
    opacity: 0;
    transform: scale(1.9);
  }
}

/* Компактная кнопка внутри строки статуса */
.ms-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--s8);
  min-height: 38px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--brass);
  color: #fff;
  font-family: var(--ui);
  font-size: var(--fs-sm);
  font-weight: 800;
  letter-spacing: 0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast),
    transform var(--t-fast), box-shadow var(--t-fast);
}
.ms-btn:hover:not(:disabled) {
  background: var(--brass-2);
  box-shadow: 0 8px 18px rgba(21, 87, 255, 0.26);
  transform: translateY(-1px);
}
.ms-btn.ghost {
  background: #fff;
  border-color: var(--line);
  color: var(--ivory);
}
.ms-btn.ghost:hover:not(:disabled) {
  border-color: var(--brass);
  color: var(--brass);
  background: var(--panel-2);
  box-shadow: none;
}
.ms-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── Быстрый путь: подпись + метка ─────────────────────────────────────────── */
.ms-lead-in {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--s12);
}
.ms-eyebrow {
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--fs-label);
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.ms-chip {
  padding: 3px 10px;
  border: 1px solid rgba(21, 87, 255, 0.28);
  border-radius: var(--r-pill);
  color: var(--brass-2);
  background: rgba(21, 87, 255, 0.06);
  font-family: var(--mono);
  font-size: var(--text-caption);
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

/* ── Приём ноты: два «слота» в одной композиции ────────────────────────────── */
.ms-intake {
  display: grid;
  grid-template-columns: 1.05fr 0.95fr;
  gap: var(--s16);
  margin-top: var(--s8);
}
.ms-lane {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--s16);
  padding: var(--s24) var(--s20) var(--s20);
  border: 1px solid var(--line);
  border-radius: 22px;
  background: #fff;
  box-shadow: 0 16px 38px rgba(7, 29, 80, 0.06);
  overflow: hidden;
  transition: border-color var(--t-fast), box-shadow var(--t-fast), transform var(--t-fast);
}
.ms-lane:hover {
  box-shadow: 0 22px 48px rgba(7, 29, 80, 0.09);
  transform: translateY(-2px);
}
/* Регистрационная планка сверху: у первичного слота — акцентный градиент */
.ms-lane::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: var(--line);
}
.ms-lane--primary::before {
  background: linear-gradient(90deg, var(--brass), var(--brass-400));
}
.ms-lane.is-busy {
  border-color: var(--brass);
}
.ms-lane-head {
  display: flex;
  align-items: center;
  gap: var(--s12);
}
.ms-lane-glyph {
  display: grid;
  flex: none;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 13px;
  color: var(--brass);
  background: rgba(21, 87, 255, 0.09);
}
.ms-lane--primary .ms-lane-glyph {
  color: #fff;
  background: var(--brass);
  box-shadow: 0 8px 18px rgba(21, 87, 255, 0.3);
}
.ms-lane-head-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ms-lane-kicker {
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--text-caption);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.ms-lane-title {
  color: var(--ivory);
  font-family: var(--ui);
  font-size: var(--text-section);
  font-weight: 800;
  letter-spacing: -0.015em;
}
.ms-lane .ms-chip {
  flex: none;
  align-self: flex-start;
}
/* Полноширинное действие слота — отдельной строкой под полем (текст в поле
   больше не режется кнопкой, а сам CTA читается однозначно) */
.ms-lane-action {
  width: 100%;
  justify-content: center;
  min-height: 46px;
}
/* Заметки идут обычным потоком: карточки тянутся по высоте, слак — ровно снизу,
   без «дыры» в середине */
.ms-lane .ms-hint,
.ms-lane .ms-search-rules {
  margin-top: 2px;
  margin-bottom: 0;
}
/* В узкой колонке правила переносятся, пояснение — на отдельную строку */
.ms-lane .ms-search-rules {
  flex-wrap: wrap;
}
.ms-lane .ms-search-rules small {
  flex-basis: 100%;
  margin-left: 0;
}

@media (max-width: 760px) {
  .ms-intake {
    grid-template-columns: 1fr;
  }
}

/* ── Компактная панель фильтров (одна строка) ─────────────────────────────── */
.ms-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 14px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: var(--panel-2);
}
.ms-fdiv {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--line);
}

/* Сегментированный контрол уровня */
.ms-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--panel-3);
}
.ms-seg-btn {
  padding: 6px 13px;
  border: 0;
  border-radius: var(--r-pill);
  color: var(--muted);
  background: transparent;
  font-family: var(--ui);
  font-size: var(--text-label);
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--t-fast), background var(--t-fast);
}
.ms-seg-btn:hover {
  color: var(--brass);
}
.ms-seg-btn.on {
  color: #fff;
  background: var(--brass);
  box-shadow: 0 1px 3px rgba(7, 29, 80, 0.18);
}

/* Метрика: иконка + select (доля от максимума) */
.ms-metric {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 22px 0 10px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  color: var(--muted);
  background: var(--panel);
  cursor: pointer;
  transition: border-color var(--t-fast), color var(--t-fast), background var(--t-fast);
}
.ms-metric::after {
  content: "";
  position: absolute;
  right: 11px;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: translateY(-2px) rotate(45deg);
  opacity: 0.6;
  pointer-events: none;
}
.ms-metric:hover {
  border-color: var(--brass);
  color: var(--brass);
}
.ms-metric.on {
  border-color: var(--brass);
  color: var(--brass);
  background: color-mix(in srgb, var(--brass) 8%, var(--panel));
}
.ms-metric select {
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  padding: 0;
  color: var(--ivory, inherit);
  background: transparent;
  font-family: var(--ui);
  font-size: var(--text-label);
  font-weight: 700;
  cursor: pointer;
}
.ms-metric.on select {
  color: var(--brass);
}
/* Фокус рисуем на самой пилюле (совпадает с её формой 999px), а не на
   внутреннем <select> — иначе кольцо съезжало из-за outline-offset. */
.ms-metric select:focus,
.ms-metric select:focus-visible {
  outline: none;
}
.ms-metric:focus-within {
  border-color: var(--brass);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--brass) 22%, transparent);
}

/* Тумблеры */
.ms-toggle {
  padding: 0 13px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  color: var(--muted);
  background: var(--panel);
  font-family: var(--ui);
  font-size: var(--text-label);
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color var(--t-fast), color var(--t-fast), background var(--t-fast);
}
.ms-toggle:hover {
  border-color: var(--brass);
  color: var(--brass);
}
.ms-toggle.on {
  border-color: var(--brass);
  color: #fff;
  background: var(--brass);
}

/* Сброс — уходит вправо */
.ms-freset {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  padding: 0 12px;
  height: 32px;
  border: 0;
  border-radius: var(--r-pill);
  color: var(--brass);
  background: transparent;
  font-family: var(--ui);
  font-size: var(--text-label);
  font-weight: 800;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--t-fast);
}
.ms-freset:hover {
  background: color-mix(in srgb, var(--brass) 10%, transparent);
}
/* Единый тесный фокус-ринг по форме контрола (без offset-разъезда) */
.ms-seg-btn:focus-visible,
.ms-toggle:focus-visible,
.ms-freset:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--brass) 22%, transparent);
}

.ms-picker-subcount {
  margin-left: 10px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--text-caption);
}
.ms-filter-empty {
  padding: 48px 16px;
  color: var(--muted);
  font-size: var(--text-body);
  text-align: center;
}

/* Мобильно: единая горизонтально-прокручиваемая полоса — минимум высоты */
@media (max-width: 720px) {
  .ms-filters {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .ms-filters::-webkit-scrollbar {
    display: none;
  }
  .ms-filters > * {
    flex: 0 0 auto;
  }
  .ms-fdiv {
    display: none;
  }
  .ms-freset {
    margin-left: 4px;
  }
}

/* ── Составное поле: иконка + ввод + встроенное действие ───────────────────── */
.ms-field {
  display: flex;
  align-items: center;
  gap: var(--s12);
  /* CHANGED: первичный «слот» для ссылки — белый и приподнятый, читается как
     главный жест экрана (в отличие от мягкого поля поиска ниже) */
  padding: 8px 8px 8px 18px;
  border: 1.5px solid var(--line);
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 10px 26px rgba(7, 29, 80, 0.05);
  transition: border-color var(--t-fast), box-shadow var(--t-fast), background var(--t-fast);
}
.ms-field:hover {
  border-color: var(--brass-400);
}
.ms-field:focus-within {
  border-color: var(--brass);
  background: #fff;
  box-shadow: 0 0 0 4px rgba(21, 87, 255, 0.1), 0 12px 28px rgba(7, 29, 80, 0.07);
}
.ms-field.is-busy {
  border-color: var(--brass);
}
/* Вторичный путь (поиск) — намеренно тише: мягкая заливка, без тени */
.ms-field--soft {
  border-color: var(--line-soft);
  background: var(--panel-2);
  box-shadow: none;
}
.ms-field--soft:focus-within {
  box-shadow: 0 0 0 4px rgba(21, 87, 255, 0.08);
}
.ms-field-glyph {
  display: flex;
  flex: none;
  color: var(--muted);
  transition: color var(--t-fast);
}
.ms-field:focus-within .ms-field-glyph {
  color: var(--brass);
}
/* Ввод «раздевается» — фон/рамку/фокус берёт на себя контейнер .ms-field */
.ms-field .ms-field-input {
  flex: 1;
  min-width: 0;
  min-height: 44px !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  color: var(--ivory);
  font-family: var(--mono);
  font-size: var(--fs-sm);
}
.ms-field .ms-field-input::placeholder {
  color: var(--muted-2);
}
.ms-field-input:focus {
  outline: none;
}

/* CHANGED: единый язык кнопок с таблицей — синяя пилюля, uppercase, подъём +
   тень на hover, стрелка «вниз» слегка кивает. Убраны янтарные rgba-остатки. */
.ms-field-action {
  display: inline-flex;
  align-items: center;
  gap: var(--s8);
  flex: none;
  min-height: 44px;
  padding: 0 20px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--brass);
  color: #fff;
  font-family: var(--ui);
  font-size: var(--fs-sm);
  font-weight: 800;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 6px 16px rgba(21, 87, 255, 0.22);
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast),
    box-shadow var(--t-fast), transform var(--t-fast);
}
.ms-field-action .ui-icon {
  transition: transform var(--t-fast);
}
.ms-field-action:hover:not(:disabled) {
  background: var(--brass);
  box-shadow: 0 10px 24px rgba(21, 87, 255, 0.32);
  transform: translateY(-2px);
}
.ms-field-action:not(.ghost):hover:not(:disabled) .ui-icon {
  transform: translateY(2px);
}
.ms-field-action:active:not(:disabled) {
  transform: translateY(0) scale(0.97);
}
.ms-field-action:disabled {
  background: #e8ecf3;
  border-color: transparent;
  color: #8d9ab2;
  box-shadow: none;
  cursor: not-allowed;
}
.ms-field-action.ghost {
  background: #fff;
  border-color: var(--line);
  color: var(--ivory);
  box-shadow: none;
}
.ms-field-action.ghost:hover:not(:disabled) {
  border-color: var(--brass);
  color: var(--brass);
  background: var(--panel-2);
  box-shadow: none;
  transform: translateY(-1px);
}

.ms-hint {
  margin: var(--s8) 0 0;
  color: var(--muted-2);
  font-size: var(--fs-sm);
}

.ms-search-rules {
  display: flex;
  align-items: center;
  gap: var(--s8);
  margin-top: var(--s12);
}
.ms-search-rules > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid rgba(21, 87, 255, 0.16);
  border-radius: var(--r-pill);
  color: var(--brass-2);
  background: rgba(21, 87, 255, 0.07);
  font-family: var(--mono);
  font-size: var(--text-caption);
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.ms-search-rules small {
  margin-left: auto;
  color: var(--muted-2);
  font-size: var(--text-caption);
}

/* ── Разделитель ───────────────────────────────────────────────────────────── */
.ms-or {
  display: flex;
  align-items: center;
  gap: var(--s16);
  margin: var(--s32) 0 var(--s24);
  color: var(--muted-2);
  font-family: var(--mono);
  font-size: var(--fs-label);
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.ms-or::before,
.ms-or::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--line-soft);
}

/* ── Поиск ─────────────────────────────────────────────────────────────────── */
.ms-search {
  display: flex;
  align-items: stretch;
  gap: var(--s12);
}
.ms-search .ms-field {
  flex: 1;
}

/* ── Уведомления/пусто ─────────────────────────────────────────────────────── */
.ms-alert {
  display: flex;
  align-items: center;
  gap: var(--s8);
  margin-top: var(--s16);
  padding: var(--s12) var(--s16);
  border: 1px solid rgba(217, 138, 138, 0.3);
  border-radius: var(--r-sm);
  background: rgba(217, 138, 138, 0.08);
  color: #e79a9a;
  font-size: var(--fs-sm);
}
.ms-empty {
  margin-top: var(--s24);
  color: var(--muted);
  font-size: var(--fs-sm);
}

/* ── Результаты: shortlist + выбор + конечная пагинация ───────────────────── */
.ms-picker {
  margin-top: var(--s24);
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: white;
  box-shadow: 0 20px 48px rgba(7, 29, 80, 0.07);
}
.ms-picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s16);
  padding: var(--s20) var(--s24);
  border-bottom: 1px solid var(--line-soft);
  background: var(--panel-2);
}
.ms-picker-head > div {
  display: grid;
  gap: 2px;
}
.ms-picker-tools {
  display: flex !important;
  align-items: center;
  grid-auto-flow: column;
  gap: var(--s12) !important;
}
.ms-sort {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  color: var(--brass);
  background: white;
}
.ms-sort select {
  border: 0;
  outline: 0;
  color: var(--ivory);
  background: transparent;
  font: 700 var(--text-caption)/1 var(--mono);
  cursor: pointer;
}
.ms-picker-head strong {
  color: var(--ivory);
  font-size: var(--text-section);
  font-weight: 800;
}
.ms-picker-kicker,
.ms-picker-page {
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--text-caption);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.ms-results {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  padding: 1px;
  list-style: none;
  background: var(--line-soft);
}
.ms-card {
  position: relative;
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  align-items: center;
  gap: var(--s16);
  min-height: 120px;
  padding: var(--s16) var(--s20);
  outline: none;
  background: white;
  cursor: pointer;
  transition: background var(--t-fast), box-shadow var(--t-fast), transform var(--t-fast);
}
.ms-card:hover,
.ms-card:focus-visible {
  z-index: 1;
  background: #f7f9ff;
  box-shadow: inset 0 0 0 2px rgba(21, 87, 255, 0.3);
}
.ms-card.selected {
  z-index: 2;
  background: var(--panel-2);
  box-shadow: inset 0 0 0 2px var(--brass);
}
.ms-select-mark {
  position: absolute;
  top: 12px;
  right: 12px;
  display: grid;
  width: 22px;
  height: 22px;
  border: 1px solid var(--line);
  border-radius: 50%;
  place-items: center;
  color: white;
  background: white;
}
.ms-card.selected .ms-select-mark {
  border-color: var(--brass);
  background: var(--brass);
}
.ms-thumb {
  display: grid;
  width: 62px;
  height: 80px;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  place-items: center;
  color: var(--muted-2);
  background: var(--panel-2);
}
.ms-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ms-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  padding-right: var(--s16);
}
.ms-title {
  overflow: hidden;
  color: var(--ivory);
  font-size: var(--text-body);
  font-weight: 800;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ms-title:hover {
  color: var(--brass);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.ms-arranger {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  color: var(--muted-2);
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: .06em;
  white-space: nowrap;
}
.ms-arranger strong {
  overflow: hidden;
  color: var(--muted);
  font-size: var(--text-caption);
  font-weight: 650;
  letter-spacing: 0;
  text-overflow: ellipsis;
  text-transform: none;
}
.ms-metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
}
.ms-metrics > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 48px;
  color: #35537f;
  font-family: var(--mono);
  font-size: var(--text-caption);
  font-weight: 700;
}
.ms-metrics .date {
  min-width: auto;
  color: var(--muted-2);
  font-weight: 500;
}
.ms-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: var(--s8);
}
.ms-badge {
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  color: var(--ivory-dim);
  font-family: var(--mono);
  font-size: var(--text-caption);
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.ms-badge.piano {
  border-color: transparent;
  color: white;
  background: var(--brass);
  font-weight: 700;
}
.ms-badge.pro {
  color: #8a5a00;
  background: #fff4ce;
}
.ms-badge.muted {
  color: var(--muted-2);
}
.ms-picker-footer {
  display: grid;
  gap: var(--s16);
  padding: var(--s16) var(--s20) var(--s20);
  border-top: 1px solid var(--line-soft);
}
.ms-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.ms-pagination button {
  display: grid;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 50%;
  place-items: center;
  color: var(--muted);
  background: white;
  font-family: var(--mono);
  font-size: var(--text-caption);
  cursor: pointer;
  transition: color var(--t-fast), border-color var(--t-fast), background var(--t-fast);
}
.ms-pagination button:hover:not(:disabled),
.ms-pagination button.active {
  border-color: var(--brass);
  color: white;
  background: var(--brass);
}
.ms-pagination button:disabled {
  color: var(--muted-2);
  background: var(--panel-2);
  cursor: not-allowed;
}
.ms-selection {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s16);
  min-height: 64px;
  padding: var(--s12) var(--s12) var(--s12) var(--s20);
  border-radius: var(--r-md);
  color: var(--muted);
  background: var(--panel-2);
  font-size: var(--text-label);
}
.ms-selection > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ms-selection strong {
  color: var(--ivory);
}
.ms-take {
  min-height: 44px;
  padding: 0 var(--s20);
}

@media (max-width: 620px) {
  .ms-auth {
    flex-wrap: wrap;
  }
  .ms-auth-actions {
    width: 100%;
  }
  .ms-auth-actions .ms-btn {
    flex: 1;
    justify-content: center;
  }
  .ms-search {
    flex-direction: column;
  }
  .ms-search-rules {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .ms-search-rules small {
    width: 100%;
    margin-left: 0;
  }
  .ms-results {
    grid-template-columns: 1fr;
  }
  .ms-field .ms-field-input {
    font-size: var(--text-label);
  }
}
@media (max-width: 560px) {
  .ms-card {
    grid-template-columns: 54px minmax(0, 1fr);
    min-height: 104px;
    padding: var(--s12);
  }
  .ms-thumb {
    width: 54px;
    height: 72px;
  }
  .ms-picker-head {
    padding: var(--s16);
  }
  .ms-selection {
    align-items: stretch;
    flex-direction: column;
    padding: var(--s16);
  }
  .ms-selection > span {
    white-space: normal;
  }
  .ms-take {
    justify-content: center;
  }
}
</style>
