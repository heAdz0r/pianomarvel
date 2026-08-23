<script setup lang="ts">
import { computed, ref } from "vue";
import UiIcon from "./UiIcon.vue";
import type { FingeringCoverage, NumberRange, UploadForm, UploadResult } from "../ui-types";

const form = defineModel<UploadForm>("form", { required: true });
const props = defineProps<{
  genres: string[];
  difficulty: NumberRange;
  tempo: NumberRange;
  canUpload: boolean;
  uploading: boolean;
  blockReason: string;
  result: UploadResult | null;
  showDetail: boolean;
  locked: boolean;
  // CHANGED: состояние аппликатуры исходной партитуры (docs/fingering-prd.md §9.1)
  fingering: FingeringCoverage | null;
  hasXml: boolean;
}>();

defineEmits<{
  upload: [];
  reset: [];
  toggleDetail: [];
}>();

// CHANGED: подпись и доступность чекбокса аппликатуры зависят от партитуры
const fingeringPercent = computed(() =>
  props.fingering ? Math.round(props.fingering.coverage * 100) : 0,
);
const fingeringLocked = computed(
  () => !props.hasXml || Boolean(props.fingering?.hasFingering),
);
const fingeringNote = computed(() => {
  if (!props.hasXml) return "Нужен MusicXML — без него подбирать нечего.";
  if (!props.fingering) return "Партитура ещё не проверена.";
  if (props.fingering.hasFingering) {
    return `В партитуре уже есть аппликатура — ${fingeringPercent.value} % нот. Пересобрать можно во вкладке «Аппликатура» после загрузки.`;
  }
  if (props.fingering.partial) {
    return `В партитуре ${fingeringPercent.value} % нот с аппликатурой: авторские цифры сохранятся, остальное достроится.`;
  }
  return "Новый .mxl с цифрами ляжет рядом с оригиналом, в подпапку fingered. Оригинал не изменяется.";
});

const titleTouched = ref(false);
const tempoTouched = ref(false);
const titleInvalid = computed(() => titleTouched.value && !form.value.title.trim());
const tempoInvalid = computed(() => {
  const value = form.value.defaultTempo;
  return (
    tempoTouched.value &&
    value !== undefined &&
    value !== "" &&
    (value < props.tempo.min || value > props.tempo.max)
  );
});
</script>

<template>
  <section class="movement metadata-movement" :class="{ 'is-locked': locked }" :aria-disabled="locked">
    <header class="movement-head">
      <span class="movement-num">III</span>
      <div>
        <p class="movement-kicker">Третий акт</p>
        <h2>Подготовьте издание</h2>
      </div>
      <span class="movement-meta">издание</span>
    </header>

    <p class="movement-lead">
      Проверьте подпись произведения, режим обучения и параметры, которые увидят ученики.
    </p>

    <div v-if="locked" class="metadata-lock" role="status">
      <span class="metadata-lock-icon"><UiIcon name="lock" :size="18" /></span>
      <div>
        <span class="metadata-lock-kicker">Акт ожидает партитуру</span>
        <strong>Сначала найдите комплект файлов в акте I</strong>
        <p>После сканирования новой композиции редактор издания откроется автоматически.</p>
      </div>
    </div>

    <div class="metadata-content" :inert="locked || undefined">

    <div class="metadata-grid">
      <div class="field span-2" :class="{ 'field--error': titleInvalid }">
        <label class="field-label" for="piece-title">
          Название <span class="req">обязательно</span>
        </label>
        <input
          id="piece-title"
          v-model="form.title"
          type="text"
          placeholder="Gymnopédie No. 1"
          aria-describedby="title-error"
          :aria-invalid="titleInvalid"
          @blur="titleTouched = true"
        />
        <span v-if="titleInvalid" id="title-error" class="field-message">
          Укажите название композиции.
        </span>
      </div>

      <div class="field">
        <label class="field-label" for="piece-subtitle">Подзаголовок</label>
        <input id="piece-subtitle" v-model="form.subTitle" type="text" />
      </div>
      <div class="field">
        <label class="field-label" for="piece-composer">Композитор</label>
        <input id="piece-composer" v-model="form.composer" type="text" />
      </div>
      <div class="field">
        <label class="field-label" for="piece-artist">Исполнитель</label>
        <input id="piece-artist" v-model="form.artist" type="text" />
      </div>
      <div class="field">
        <label class="field-label" for="piece-mode">Режим</label>
        <select id="piece-mode" v-model="form.assessmentMode">
          <option value="Learn & Play">Обучение и исполнение</option>
          <option value="Play Only">Только исполнение</option>
          <option value="Learn Only">Только обучение</option>
        </select>
      </div>
      <label class="learning-option span-2">
        <input
          v-model="form.createLearningMode"
          type="checkbox"
          :disabled="form.assessmentMode === 'Play Only'"
        />
        <span>
          <strong>Создать обучающий режим после загрузки</strong>
          <small>Chopped строится выбранным алгоритмом; Minced копирует его и получает RH/LH.</small>
        </span>
      </label>
      <div
        v-if="form.createLearningMode && form.assessmentMode !== 'Play Only'"
        class="learning-mode-group span-2"
      >
        <div class="field">
          <label class="field-label" for="learning-strategy">Алгоритм Chopped</label>
          <select id="learning-strategy" v-model="form.learningStrategy">
            <option value="adaptive">Adaptive · анализ MusicXML</option>
            <option value="predict">Обычный · Piano Marvel Predict</option>
          </select>
          <span class="field-message">
            <!-- CHANGED: копия отражает восемь слоёв анализа, а не только форму и жесты -->
            Adaptive выводит форму, гиперметр и каденции из самой музыки, взвешивает
            признаки по их информативности в этой партитуре и собирает
            Phrase → Bridge → Review → Summarize → Whole.
          </span>
        </div>
        <!-- CHANGED: аппликатура рядом со способом Chopped, как во вкладке «Пьесы» -->
        <label class="learning-option" :class="{ 'is-muted': fingeringLocked }">
          <input v-model="form.autoFingering" type="checkbox" :disabled="fingeringLocked" />
          <span>
            <strong>Подобрать аппликатуру, если её нет в партитуре</strong>
            <small>{{ fingeringNote }}</small>
          </span>
          <em v-if="fingering && fingering.totalNotes > 0" class="option-badge mono">
            {{ fingering.annotatedNotes }}/{{ fingering.totalNotes }}
          </em>
        </label>
      </div>
      <label
        v-else-if="form.assessmentMode !== 'Play Only'"
        class="learning-option span-2"
        :class="{ 'is-muted': fingeringLocked }"
      >
        <input v-model="form.autoFingering" type="checkbox" :disabled="fingeringLocked" />
        <span>
          <strong>Подобрать аппликатуру, если её нет в партитуре</strong>
          <small>{{ fingeringNote }}</small>
        </span>
        <em v-if="fingering && fingering.totalNotes > 0" class="option-badge mono">
          {{ fingering.annotatedNotes }}/{{ fingering.totalNotes }}
        </em>
      </label>
      <div class="field difficulty-field">
        <label class="field-label" for="piece-difficulty">
          Сложность
          <span class="field-value mono">{{ form.difficulty }} / {{ difficulty.max }}</span>
        </label>
        <input
          id="piece-difficulty"
          v-model.number="form.difficulty"
          type="range"
          :min="difficulty.min"
          :max="difficulty.max"
          :style="{
            '--pct':
              ((form.difficulty - difficulty.min) / (difficulty.max - difficulty.min)) * 100 + '%',
          }"
        />
      </div>
      <div class="field" :class="{ 'field--error': tempoInvalid }">
        <label class="field-label" for="piece-tempo">
          Темп
          <span class="field-value mono">BPM</span>
        </label>
        <input
          id="piece-tempo"
          v-model.number="form.defaultTempo"
          type="number"
          class="mono"
          :min="tempo.min"
          :max="tempo.max"
          placeholder="—"
          :aria-invalid="tempoInvalid"
          aria-describedby="tempo-error"
          @input="tempoTouched = true"
          @blur="tempoTouched = true"
        />
        <span v-if="tempoInvalid" id="tempo-error" class="field-message">
          Допустимый диапазон: {{ tempo.min }}–{{ tempo.max }} BPM.
        </span>
      </div>
      <div class="field span-2">
        <label class="field-label" for="piece-copyright">Авторские права</label>
        <textarea id="piece-copyright" v-model="form.copyright" rows="2" />
      </div>
    </div>

    <div class="field genre-field">
      <label class="field-label">Жанры</label>
      <div v-if="genres.length" class="genres">
        <label
          v-for="genre in genres"
          :key="genre"
          class="chip"
          :class="{ on: form.genres.includes(genre) }"
        >
          <input v-model="form.genres" type="checkbox" :value="genre" />
          <span>{{ genre }}</span>
        </label>
      </div>
      <div v-else class="genre-skeleton" aria-label="Список жанров загружается">
        <i v-for="item in 6" :key="item" />
      </div>
    </div>

    <div class="publication">
      <div class="publication-copy">
        <span class="publication-kicker">Финал</span>
        <strong>Опубликовать в Piano Marvel</strong>
        <span>Файлы откроются в защищённой браузерной сессии.</span>
      </div>
      <button
        class="btn big"
        :class="{ 'is-loading': uploading }"
        :disabled="!canUpload"
        @click="$emit('upload')"
      >
        <span v-if="uploading" class="spin" aria-hidden="true" />
        <template v-else>
          <span>Загрузить композицию</span>
          <UiIcon name="external" />
        </template>
        <span v-if="uploading" class="sr-only">Композиция загружается</span>
      </button>
      <span v-if="blockReason" class="block-reason">{{ blockReason }}</span>
    </div>

    <Transition name="movement-reveal">
      <aside
        v-if="result"
        class="coda"
        :class="result.ok ? 'ok' : 'err'"
        :aria-live="result.ok ? 'polite' : 'assertive'"
      >
        <div class="coda-icon">
          <UiIcon :name="result.ok ? 'check' : 'warning'" />
        </div>
        <div class="coda-copy">
          <span class="coda-label">{{ result.ok ? "Готово" : "Нужна проверка" }}</span>
          <strong>{{ result.message }}</strong>
          <a v-if="result.url" :href="result.url" target="_blank" rel="noopener">
            Открыть на сайте
            <UiIcon name="external" :size="16" />
          </a>
          <button v-if="result.detail" class="text-action" @click="$emit('toggleDetail')">
            {{ showDetail ? "Скрыть ответ сервера" : "Показать ответ сервера" }}
          </button>
          <pre v-if="showDetail && result.detail" class="detail mono">{{ result.detail }}</pre>
        </div>
        <button v-if="result.ok" class="btn ghost" @click="$emit('reset')">Загрузить ещё</button>
      </aside>
    </Transition>
    </div>
  </section>
</template>
