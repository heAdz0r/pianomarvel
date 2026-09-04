<script setup lang="ts">
const whiteKeys = Array.from({ length: 28 }, (_, index) => index);
const blackKeys = whiteKeys.filter(index => [0, 1, 3, 4, 5].includes(index % 7));
</script>

<template>
  <div class="music-atmosphere" aria-hidden="true">
    <svg class="atmosphere-staff" viewBox="0 0 1600 1100" fill="none" preserveAspectRatio="xMidYMin slice">
      <g class="atmosphere-strings">
        <path v-for="offset in [0, 16, 32, 48, 64]" :key="offset"
          :transform="`translate(0 ${offset})`"
          d="M-180 430 C220 60 530 690 990 245 S1610 150 1780 370" />
      </g>
      <g class="atmosphere-echo">
        <path v-for="offset in [0, 18, 36, 54, 72]" :key="offset"
          :transform="`translate(0 ${offset})`"
          d="M-180 820 C320 390 630 1190 1200 760 S1560 560 1780 830" />
      </g>
    </svg>
    <svg class="atmosphere-keyboard" viewBox="-24 -28 1060 224" fill="none">
      <defs>
        <linearGradient id="atmosphere-ivory" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#fffdf9" />
          <stop offset="1" stop-color="#d9cdbf" />
        </linearGradient>
        <linearGradient id="atmosphere-ebony" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#443749" />
          <stop offset="1" stop-color="#211b28" />
        </linearGradient>
      </defs>
      <rect x="-14" y="-16" width="1036" height="198" rx="16" class="keyboard-case" />
      <rect v-for="key in whiteKeys" :key="`white-${key}`"
        :x="key * 36" y="0" width="35" height="156" rx="4"
        fill="url(#atmosphere-ivory)" stroke="#b7a999" stroke-width="0.8" />
      <g v-for="key in blackKeys" :key="`black-${key}`">
        <rect :x="key * 36 + 26" y="3" width="22" height="100" rx="3" fill="#271f2d" opacity=".18" />
        <rect :x="key * 36 + 24" y="0" width="22" height="94" rx="3" fill="url(#atmosphere-ebony)" />
        <path :d="`M${key * 36 + 28} 7 V78`" stroke="#948092" stroke-opacity=".45" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.music-atmosphere {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background:
    radial-gradient(ellipse at 88% 10%, var(--decor-glow), transparent 58%),
    radial-gradient(ellipse at 4% 44%, rgba(207, 173, 127, .25), transparent 48%),
    linear-gradient(135deg, transparent 25%, rgba(255, 252, 248, .42) 60%, transparent);
}
.atmosphere-staff { position: absolute; inset: 0; width: 100%; height: 100%; }
.atmosphere-strings { stroke: var(--accent-500); stroke-width: 1.1; opacity: .15; }
.atmosphere-echo { stroke: var(--decor-gold); stroke-width: 1; opacity: .25; }
.atmosphere-keyboard {
  position: absolute;
  width: min(1040px, 90vw);
  right: -22vw;
  top: 60%;
  transform: rotate(-27deg);
  opacity: .23;
}
.keyboard-case { fill: var(--decor-gold); opacity: .24; }
@media (max-width: 760px) {
  .atmosphere-keyboard { width: 780px; right: -560px; top: 50%; opacity: .16; }
  .atmosphere-strings { opacity: .10; }
}
@media (prefers-contrast: more) {
  .music-atmosphere { display: none; }
}
@media print {
  .music-atmosphere { display: none; }
}
</style>
