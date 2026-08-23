<template>
  <div class="score" aria-hidden="true" title="Людвиг ван Бетховен — К Элизе, начало">
    <svg class="score-svg" viewBox="0 0 640 108" xmlns="http://www.w3.org/2000/svg">
      <!-- Пять линий нотного стана -->
      <g class="staff-lines">
        <path v-for="y in [30, 40, 50, 60, 70]" :key="y" :d="`M 8 ${y} H 632`" />
      </g>

      <!-- Скрипичный ключ: полностью векторный, без зависимости от шрифтов -->
      <g class="notation clef">
        <path
          d="M48 76 C32 76 27 65 32 56 C37 47 55 47 59 58 C63 70 52 79 42 75
             C34 71 35 61 41 57 C48 52 56 57 55 64
             M48 76 C58 89 52 99 44 98 C38 97 38 91 42 89
             M48 76 L43 25 C42 14 47 6 54 4 C57 14 53 23 45 31
             C35 40 32 50 37 58"
        />
        <circle cx="43" cy="90" r="2.5" />
      </g>

      <!-- Размер 3/8 -->
      <g class="notation meter">
        <text x="96" y="47" text-anchor="middle">3</text>
        <text x="96" y="68" text-anchor="middle">8</text>
      </g>

      <!-- Первый такт: E D♯ E D♯ E B, шесть шестнадцатых -->
      <g class="notation phrase phrase-one">
        <!-- Диезы стоят непосредственно перед D♯ -->
        <g class="sharp" transform="translate(174 30)">
          <path d="M2 -8 V10 M9 -10 V8 M-1 -1 L12 -4 M-1 5 L12 2" />
        </g>
        <g class="sharp" transform="translate(274 30)">
          <path d="M2 -8 V10 M9 -10 V8 M-1 -1 L12 -4 M-1 5 L12 2" />
        </g>

        <!-- Головки: E5 D♯5 E5 D♯5 E5 B4 -->
        <ellipse cx="150" cy="35" rx="8" ry="5.4" transform="rotate(-18 150 35)" />
        <ellipse cx="192" cy="40" rx="8" ry="5.4" transform="rotate(-18 192 40)" />
        <ellipse cx="230" cy="35" rx="8" ry="5.4" transform="rotate(-18 230 35)" />
        <ellipse cx="292" cy="40" rx="8" ry="5.4" transform="rotate(-18 292 40)" />
        <ellipse cx="330" cy="35" rx="8" ry="5.4" transform="rotate(-18 330 35)" />
        <ellipse cx="368" cy="50" rx="8" ry="5.4" transform="rotate(-18 368 50)" />

        <!-- Штили вверх и две корректные вязки шестнадцатых -->
        <path d="M157 34 V11 M199 39 V11 M237 34 V11 M299 39 V11 M337 34 V11 M375 49 V11" />
        <path class="beam" d="M157 11 L375 11 L375 16 L157 16 Z" />
        <path class="beam" d="M157 19 L375 19 L375 23 L157 23 Z" />
      </g>

      <!-- Тактовая черта -->
      <path class="notation barline" d="M397 30 V70" />

      <!-- Следующий такт: D C A -->
      <g class="notation phrase phrase-two">
        <ellipse cx="438" cy="40" rx="8" ry="5.4" transform="rotate(-18 438 40)" />
        <ellipse cx="482" cy="45" rx="8" ry="5.4" transform="rotate(-18 482 45)" />
        <ellipse cx="548" cy="55" rx="8" ry="5.4" transform="rotate(-18 548 55)" />
        <path d="M445 39 V18 M489 44 V18 M555 54 V27" />
        <path class="beam" d="M445 18 H489 V23 H445 Z" />
        <path class="beam" d="M445 26 H489 V30 H445 Z" />
        <!-- Флажок восьмой A -->
        <path class="flag" d="M555 27 C571 30 574 38 565 44 C570 36 564 33 555 32 Z" />
      </g>

      <!-- Воздушная подпись делает фрагмент частью айдентики -->
      <text class="caption" x="632" y="96" text-anchor="end">BEETHOVEN · WOO 59 · 3/8</text>
    </svg>
  </div>
</template>

<style scoped>
.score {
  position: relative;
  display: block;
  width: min(100%, 620px);
  margin-top: var(--s24);
}
.score::before {
  content: "";
  position: absolute;
  inset: -18px 8% -14px;
  z-index: -1;
  border: 1px solid currentColor;
  border-radius: 50%;
  opacity: 0.08;
  transform: rotate(-4deg);
}
.score-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.staff-lines path {
  fill: none;
  stroke: var(--line);
  stroke-width: 1.15;
  stroke-dasharray: 624;
  stroke-dashoffset: 624;
  animation: staff-draw 1.1s var(--ease) forwards;
}
.staff-lines path:nth-child(1) { animation-delay: 0.45s; }
.staff-lines path:nth-child(2) { animation-delay: 0.5s; }
.staff-lines path:nth-child(3) { animation-delay: 0.55s; }
.staff-lines path:nth-child(4) { animation-delay: 0.6s; }
.staff-lines path:nth-child(5) { animation-delay: 0.65s; }
@keyframes staff-draw {
  to { stroke-dashoffset: 0; }
}

.notation {
  fill: var(--brass);
  stroke: var(--brass);
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
  animation: notation-in 0.65s var(--spring) forwards;
}
.clef {
  fill: none;
  stroke-width: 2.6;
  animation-delay: 0.78s;
}
.meter {
  fill: var(--brass);
  stroke: none;
  font-family: var(--display);
  font-size: 25px;
  font-weight: 400;
  line-height: 1;
  animation-delay: 0.88s;
}
.phrase {
  stroke-width: 1.9;
}
.phrase-one { animation-delay: 1s; }
.phrase-two { animation-delay: 1.16s; }
.phrase ellipse {
  stroke: none;
}
.phrase > path:not(.beam):not(.flag) {
  fill: none;
}
.beam {
  stroke: none;
}
.flag {
  stroke: none;
}
.sharp path {
  fill: none;
  stroke-width: 1.8;
}
.barline {
  fill: none;
  stroke-width: 1.2;
  opacity: 0;
  animation-delay: 1.08s;
}
.caption {
  fill: var(--muted-2);
  font-family: var(--mono);
  font-size: var(--text-caption);
  letter-spacing: 0.18em;
  opacity: 0;
  animation: caption-in 0.7s var(--ease) 1.35s forwards;
}

@keyframes notation-in {
  from { opacity: 0; transform: translateY(-5px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes caption-in {
  to { opacity: 0.72; }
}

@media (prefers-reduced-motion: reduce) {
  .staff-lines path,
  .notation,
  .caption {
    opacity: 1 !important;
    animation: none !important;
    stroke-dashoffset: 0 !important;
  }
}
</style>
