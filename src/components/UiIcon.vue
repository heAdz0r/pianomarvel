<script setup lang="ts">
type IconName =
  | "add"
  | "arrow-down"
  | "arrow-up"
  | "check"
  | "chevron-left"
  | "chevron-right"
  | "close"
  | "external"
  | "eye"
  | "folder"
  | "bookmark"
  | "lock"
  | "music"
  | "refresh"
  | "search"
  | "sort"
  | "spark"
  | "star"
  | "warning";

defineProps<{
  name: IconName;
  size?: number;
}>();
</script>

<template>
  <svg
    class="ui-icon"
    :width="size ?? 18"
    :height="size ?? 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'add'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'arrow-down'">
      <path d="M12 5v14M7 14l5 5 5-5" />
    </template>
    <template v-else-if="name === 'arrow-up'">
      <path d="M12 19V5M7 10l5-5 5 5" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="m5 12 4 4L19 6" />
    </template>
    <template v-else-if="name === 'chevron-left'">
      <path d="m15 18-6-6 6-6" />
    </template>
    <template v-else-if="name === 'chevron-right'">
      <path d="m9 18 6-6-6-6" />
    </template>
    <template v-else-if="name === 'close'">
      <path d="m6 6 12 12M18 6 6 18" />
    </template>
    <template v-else-if="name === 'external'">
      <path d="M14 5h5v5M19 5l-9 9" />
      <path d="M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" />
    </template>
    <template v-else-if="name === 'eye'">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </template>
    <template v-else-if="name === 'bookmark'">
      <path d="M7 4.5A1.5 1.5 0 0 1 8.5 3h7A1.5 1.5 0 0 1 17 4.5V21l-5-3-5 3V4.5Z" />
    </template>
    <template v-else-if="name === 'folder'">
      <path d="M3 7.5h6l2-2h4.5A2.5 2.5 0 0 1 18 8v1" />
      <path d="M3.5 9h16l-2 10h-16l2-10Z" />
    </template>
    <template v-else-if="name === 'lock'">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </template>
    <template v-else-if="name === 'music'">
      <path d="M9 18V5l10-2v13" />
      <ellipse cx="6.5" cy="18" rx="2.5" ry="2" />
      <ellipse cx="16.5" cy="16" rx="2.5" ry="2" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="m15 15 4 4" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M20 6v5h-5" />
      <path d="M19 11a7.5 7.5 0 1 0 .4 4" />
    </template>
    <template v-else-if="name === 'sort'">
      <path d="m8 7 4-4 4 4M12 3v18M16 17l-4 4-4-4" />
    </template>
    <template v-else-if="name === 'spark'">
      <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z" />
      <path d="m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" />
    </template>
    <template v-else-if="name === 'star'">
      <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />
    </template>
    <template v-else>
      <path d="M12 4 3.5 19h17L12 4Z" />
      <path d="M12 9v4M12 16.5h.01" />
    </template>
  </svg>
</template>
