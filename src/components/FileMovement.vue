<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "./UiIcon.vue";
import type { Category, FileRow, MatchedFiles, UploadResult } from "../ui-types";

const path = defineModel<string>("path", { required: true });
const props = defineProps<{
  scanning: boolean;
  files: MatchedFiles | null;
  rows: FileRow[];
  warnings: string[];
  scanResult: UploadResult | null;
}>();

defineEmits<{
  browse: [];
  scan: [];
  pick: [category: Category];
  clear: [category: Category, index?: number];
}>();

const singleRows = computed(() => props.rows.filter((row) => row.key !== "audio"));
const audioLabel = computed(() => props.rows.find((row) => row.key === "audio")?.label ?? "Аудио");

function shortPath(value: string): string {
  const parts = value.split("/");
  return parts[parts.length - 1] || value;
}

function singleFile(category: Exclude<Category, "audio">): string | undefined {
  return props.files?.[category];
}

function isCritical(category: Category): boolean {
  return (category === "midi" || category === "xml") && !props.files?.midi && !props.files?.xml;
}
</script>

<template>
  <section class="movement file-movement">
    <header class="movement-head">
      <span class="movement-num">I</span>
      <div>
        <p class="movement-kicker">Первый акт</p>
        <h2>Соберите партитуру</h2>
      </div>
      <span class="movement-meta">с диска</span>
    </header>

    <p class="movement-lead">
      Укажите один файл. MIDI, MusicXML, PDF, аудио и обложка с тем же именем найдутся рядом
      автоматически.
    </p>

    <div class="picker">
      <label class="path-input">
        <span class="sr-only">Путь к файлу композиции</span>
        <input
          v-model="path"
          type="text"
          class="mono"
          placeholder="~/Downloads/gymnopedie-no-1-satie.pdf"
          @keyup.enter="$emit('scan')"
        />
      </label>
      <button class="btn ghost browse-btn" @click="$emit('browse')">
        <UiIcon name="folder" :size="17" />
        <span>Обзор</span>
      </button>
      <button class="btn scan-btn" :disabled="!path.trim() || scanning" @click="$emit('scan')">
        <span v-if="scanning" class="spin" aria-hidden="true" />
        <template v-else>
          <UiIcon name="search" :size="17" />
          <span>Найти</span>
        </template>
        <span v-if="scanning" class="sr-only">Идёт поиск файлов</span>
      </button>
    </div>

    <div v-if="scanResult && !files" class="result err scan-error" aria-live="assertive">
      <UiIcon name="warning" />
      <span>{{ scanResult.message }}</span>
    </div>

    <Transition name="movement-reveal">
      <div v-if="files" class="score-dossier">
        <div class="dossier-head">
          <div>
            <span class="dossier-label">Найденный комплект</span>
            <strong>{{ files.baseName }}</strong>
          </div>
          <span class="dossier-count">
            {{ singleRows.filter((row) => singleFile(row.key as Exclude<Category, 'audio'>)).length + files.audio.length }}
            файлов
          </span>
        </div>

        <TransitionGroup name="file-row" tag="ul" class="file-list">
          <li v-for="row in singleRows" :key="row.key" class="file-row">
            <span class="file-type">{{ row.label }}</span>
            <div class="file-copy">
              <span
                class="path mono"
                :class="[
                  singleFile(row.key as Exclude<Category, 'audio'>) ? 'found' : 'missing',
                  { critical: isCritical(row.key) },
                ]"
                :title="singleFile(row.key as Exclude<Category, 'audio'>) ?? ''"
              >
                {{
                  singleFile(row.key as Exclude<Category, "audio">)
                    ? shortPath(singleFile(row.key as Exclude<Category, "audio">)!)
                    : "Файл не найден"
                }}
              </span>
              <span class="file-status">
                {{ singleFile(row.key as Exclude<Category, "audio">) ? "готово" : isCritical(row.key) ? "обязательно" : "необязательно" }}
              </span>
            </div>
            <button
              v-if="singleFile(row.key as Exclude<Category, 'audio'>)"
              class="icon-btn"
              title="Убрать файл"
              :aria-label="`Убрать ${row.label}`"
              @click="$emit('clear', row.key)"
            >
              <UiIcon name="close" />
            </button>
            <button
              v-else
              class="icon-btn add"
              title="Указать файл"
              :aria-label="`Указать ${row.label}`"
              @click="$emit('pick', row.key)"
            >
              <UiIcon name="add" />
            </button>
          </li>

          <li
            v-for="(audio, index) in files.audio"
            :key="audio"
            class="file-row"
          >
            <span class="file-type">{{ index === 0 ? audioLabel : "—" }}</span>
            <div class="file-copy">
              <span class="path found mono" :title="audio">{{ shortPath(audio) }}</span>
              <span class="file-status">готово</span>
            </div>
            <button
              class="icon-btn"
              title="Убрать аудио"
              aria-label="Убрать аудиофайл"
              @click="$emit('clear', 'audio', index)"
            >
              <UiIcon name="close" />
            </button>
          </li>

          <li v-if="!files.audio.length" key="audio-empty" class="file-row">
            <span class="file-type">{{ audioLabel }}</span>
            <div class="file-copy">
              <span class="path missing">Файл не найден</span>
              <span class="file-status">необязательно</span>
            </div>
            <button
              class="icon-btn add"
              title="Указать аудио"
              aria-label="Указать аудиофайл"
              @click="$emit('pick', 'audio')"
            >
              <UiIcon name="add" />
            </button>
          </li>
        </TransitionGroup>

        <button v-if="files.audio.length" class="text-action" @click="$emit('pick', 'audio')">
          <UiIcon name="add" :size="16" />
          <span>Добавить ещё аудио</span>
        </button>

        <div v-if="warnings.length" class="warnings" aria-live="polite">
          <div v-for="(warning, index) in warnings" :key="warning" :class="{ critical: index === 0 && !files.midi && !files.xml }">
            <UiIcon name="warning" :size="16" />
            <span>{{ warning }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>
