<script setup lang="ts">
// CHANGED: единый слайдер выбора режима. Одна механика каретки и одна типографика
// для дока в шапке и для переключателя в hero — вместо двух разных контролов.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import UiIcon from "./UiIcon.vue";

type IconName = InstanceType<typeof UiIcon>["$props"]["name"];

interface ModeOption {
  value: string;
  label: string;
  caption?: string;
  icon: IconName;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: ModeOption[];
    variant?: "dock" | "hero";
    label?: string;
    controls?: string;
    captions?: boolean;
    iconSize?: number;
  }>(),
  { variant: "dock", label: undefined, controls: undefined, captions: false, iconSize: 15 },
);

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const activeIndex = computed(() => {
  const index = props.options.findIndex((option) => option.value === props.modelValue);
  return index < 0 ? 0 : index;
});

// CHANGED: короткий флаг «каретка в пути» — на нём висят squash, блик и поп иконки.
const shifting = ref(false);
let shiftTimer: ReturnType<typeof setTimeout> | undefined;

watch(activeIndex, () => {
  shifting.value = true;
  if (shiftTimer) clearTimeout(shiftTimer);
  shiftTimer = setTimeout(() => (shifting.value = false), 460);
});

onBeforeUnmount(() => {
  if (shiftTimer) clearTimeout(shiftTimer);
});

const tabs = ref<HTMLButtonElement[]>([]);

function select(value: string) {
  if (value !== props.modelValue) emit("update:modelValue", value);
}

// CHANGED: клавиатура как у настоящего tablist — стрелки/Home/End с активацией.
function onKeydown(event: KeyboardEvent, index: number) {
  const last = props.options.length - 1;
  let next = -1;

  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;

  if (next < 0) return;
  event.preventDefault();
  select(props.options[next].value);
  tabs.value[next]?.focus();
}
</script>

<template>
  <div
    class="mode-switch"
    :class="[`mode-switch--${variant}`, { 'is-shifting': shifting, 'has-captions': captions }]"
    :style="{ '--ms-count': options.length, '--ms-index': activeIndex }"
    role="tablist"
    :aria-label="label"
  >
    <!-- CHANGED: каретка + её зеркальный слой с активной типографикой (маска идеально
         синхронна, потому что едет внутри самой каретки). -->
    <span class="ms-thumb" aria-hidden="true">
      <span class="ms-thumb-face" />
      <span class="ms-clip">
        <span class="ms-ghost">
          <span v-for="option in options" :key="`ghost-${option.value}`" class="ms-item ms-item--ghost">
            <UiIcon :name="option.icon" :size="iconSize" />
            <span class="ms-item-text">
              <small v-if="captions && option.caption">{{ option.caption }}</small>
              <b>{{ option.label }}</b>
            </span>
          </span>
        </span>
      </span>
    </span>

    <button
      v-for="(option, index) in options"
      :key="option.value"
      :ref="(el) => (tabs[index] = el as HTMLButtonElement)"
      type="button"
      class="ms-item"
      role="tab"
      :tabindex="option.value === modelValue ? 0 : -1"
      :aria-selected="option.value === modelValue"
      :aria-controls="controls"
      @click="select(option.value)"
      @keydown="onKeydown($event, index)"
    >
      <UiIcon :name="option.icon" :size="iconSize" />
      <span class="ms-item-text">
        <small v-if="captions && option.caption">{{ option.caption }}</small>
        <b>{{ option.label }}</b>
      </span>
    </button>
  </div>
</template>

<style scoped>
.mode-switch {
  --ms-pad: 6px;
  --ms-radius: 16px;
  --ms-item-h: 44px;
  --ms-motion: 0.62s;
  position: relative;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  padding: var(--ms-pad);
  border-radius: var(--ms-radius);
  isolation: isolate;
}

/* Каретка — единственный движущийся объект контрола. */
.ms-thumb {
  position: absolute;
  top: var(--ms-pad);
  bottom: var(--ms-pad);
  left: var(--ms-pad);
  z-index: 1;
  width: calc((100% - var(--ms-pad) * 2) / var(--ms-count));
  border-radius: calc(var(--ms-radius) - var(--ms-pad));
  pointer-events: none;
  transform: translate3d(calc(var(--ms-index) * 100%), 0, 0);
  transition: transform var(--ms-motion) var(--spring);
}

.ms-thumb-face {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  transition: transform var(--ms-motion) var(--spring);
}

/* Лёгкий squash на ходу — контрол «живой», а не просто перекрашивается. */
.mode-switch.is-shifting .ms-thumb-face {
  transform: scaleX(1.055) scaleY(0.94);
}

.ms-thumb-face::after {
  content: "";
  position: absolute;
  inset: -20% -40%;
  background: linear-gradient(102deg, transparent 24%, rgba(255, 255, 255, 0.6) 50%, transparent 76%);
  opacity: 0;
}

.mode-switch.is-shifting .ms-thumb-face::after {
  animation: ms-sheen 0.72s var(--ease);
}

.ms-clip {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  border-radius: inherit;
}

.ms-ghost {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  width: calc(100% * var(--ms-count));
  color: var(--ms-on);
  transform: translate3d(calc(var(--ms-index) * -100% / var(--ms-count)), 0, 0);
  transition: transform var(--ms-motion) var(--spring);
}

.mode-switch.is-shifting .ms-ghost .ui-icon {
  animation: ms-pop 0.6s var(--spring);
}

.ms-item {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 0 16px;
  border: 0;
  border-radius: calc(var(--ms-radius) - var(--ms-pad));
  color: var(--ms-idle);
  background: transparent;
  font-family: var(--ui);
  font-size: var(--text-caption);
  font-weight: 800;
  letter-spacing: -0.015em;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--t-fast);
}

.ms-item--ghost {
  color: inherit;
  pointer-events: none;
}

.ms-item-text {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.ms-item-text b {
  font-weight: 800;
}

.ms-item small {
  color: inherit;
  font-family: var(--mono);
  font-size: var(--text-caption);
  font-weight: 400;
  letter-spacing: 0.07em;
  opacity: 0.7;
  text-transform: uppercase;
}

.ms-item .ui-icon {
  flex: none;
  transition: transform 0.45s var(--spring);
}

.ms-item:hover .ui-icon {
  transform: rotate(-9deg) scale(1.12);
}

.ms-item[aria-selected="true"]:active {
  transform: scale(0.985);
}

.mode-switch:has(.ms-item:focus-visible) {
  outline: 3px solid var(--brass);
  outline-offset: 3px;
}

.ms-item:focus-visible {
  outline: none;
}

/* Вариант «док в шапке» — светлое стекло, синяя каретка. */
.mode-switch--dock {
  --ms-idle: var(--muted);
  --ms-on: #ffffff;
  background: var(--panel-2);
  box-shadow: inset 0 0 0 1px rgba(7, 29, 80, 0.07);
}

.mode-switch--dock .ms-item {
  min-height: var(--ms-item-h);
}

.mode-switch--dock .ms-item:hover {
  color: var(--ivory);
}

.mode-switch--dock .ms-thumb {
  box-shadow:
    0 8px 20px rgba(21, 87, 255, 0.26),
    inset 0 1px 0 rgba(255, 255, 255, 0.32);
}

.mode-switch--dock .ms-thumb-face {
  background: linear-gradient(140deg, var(--brass-400), var(--brass-600));
}

/* Вариант «hero» — то же движение, но на цветной плоскости. */
.mode-switch--hero {
  --ms-idle: rgba(255, 255, 255, 0.7);
  --ms-on: var(--brass);
  background: rgba(4, 31, 95, 0.18);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.28);
  backdrop-filter: blur(12px);
}

.mode-switch--hero {
  --ms-item-h: 48px;
}

.mode-switch--hero .ms-item {
  min-height: var(--ms-item-h);
}

.mode-switch--hero .ms-item:hover {
  color: #ffffff;
}

.mode-switch--hero .ms-thumb {
  box-shadow: 0 10px 24px rgba(4, 31, 95, 0.22);
}

.mode-switch--hero .ms-thumb-face {
  background: #ffffff;
}

.hero--local .mode-switch--hero {
  --ms-on: var(--ivory);
}

.mode-switch--hero:has(.ms-item:focus-visible) {
  outline-color: #ffffff;
}

@keyframes ms-sheen {
  0% {
    opacity: 0;
    transform: translate3d(-55%, 0, 0);
  }
  35% {
    opacity: 0.7;
  }
  100% {
    opacity: 0;
    transform: translate3d(55%, 0, 0);
  }
}

@keyframes ms-pop {
  0% {
    transform: rotate(-18deg) scale(0.84);
  }
  100% {
    transform: none;
  }
}

@media (max-width: 640px) {
  .mode-switch {
    --ms-pad: 5px;
  }

  .ms-item {
    justify-content: center;
    padding-inline: 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ms-thumb,
  .ms-thumb-face,
  .ms-ghost,
  .ms-item .ui-icon {
    transition-duration: 0.01ms;
  }

  .mode-switch.is-shifting .ms-thumb-face,
  .ms-item:hover .ui-icon {
    transform: none;
  }

  .mode-switch.is-shifting .ms-thumb-face::after,
  .mode-switch.is-shifting .ms-ghost .ui-icon {
    animation: none;
  }
}
</style>
