<script setup lang="ts">
import UiIcon from "./UiIcon.vue";
import type { LoginState } from "../ui-types";

withDefaults(
  defineProps<{
    state: LoginState;
    label: string;
    checking?: boolean; // CHANGED: живая проверка сессии в процессе
    index?: string; // CHANGED: порядковый бейдж (шаг во flow)
    kicker?: string; // CHANGED: подпись над статусом
  }>(),
  { index: "00", kicker: "Сессия Piano Marvel" },
);

defineEmits<{
  login: [];
  check: [];
  complete: [];
}>();
</script>

<template>
  <section class="session-movement" :class="state" aria-live="polite">
    <div class="session-index">{{ index }}</div>
    <div class="session-copy">
      <span class="session-kicker">{{ kicker }}</span>
      <span class="session-status">
        <span class="status-dot" />
        {{ label }}
      </span>
    </div>

    <div v-if="state === 'waiting'" class="session-actions">
      <button class="btn ghost session-action" @click="$emit('login')">
        <UiIcon name="external" :size="16" />
        <span>Открыть окно</span>
      </button>
      <button class="btn session-action" @click="$emit('complete')">
        <UiIcon name="check" :size="16" />
        <span>Я вошёл — проверить</span>
      </button>
    </div>
    <!-- CHANGED: state 'unknown' (после рестарта сервера) — куки в профиле скорее всего
         ещё валидны, поэтому сначала предлагаем дешёвую проверку сессии, а не новый вход -->
    <div v-else-if="state === 'unknown'" class="session-actions">
      <button class="btn session-action" :disabled="checking" @click="$emit('check')">
        <span v-if="checking" class="spin" aria-hidden="true" />
        <UiIcon v-else name="check" :size="16" />
        <span>{{ checking ? "Проверяю сессию…" : "Проверить вход" }}</span>
      </button>
      <button class="btn ghost session-action" :disabled="checking" @click="$emit('login')">
        <UiIcon name="external" :size="16" />
        <span>Войти</span>
      </button>
    </div>
    <button v-else-if="state !== 'loggedIn'" class="btn ghost session-action" @click="$emit('login')">
      <UiIcon name="external" :size="16" />
      <span>Войти</span>
    </button>
    <button v-else class="btn ghost session-action" :disabled="checking" @click="$emit('check')">
      <UiIcon name="check" :size="16" />
      <span>Проверить</span>
    </button>
  </section>
</template>
