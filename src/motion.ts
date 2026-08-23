/*
 * motion.ts — кинетический слой в духе Payard / awwwards.
 * Самодостаточный, без зависимостей. Всё поведение навешивается на уже
 * существующие классы разметки; декоративный DOM (grain, marquee,
 * индикатор прогресса) модуль создаёт сам. Идемпотентно (повторный вызов
 * не дублирует), уважает prefers-reduced-motion и pointer:fine.
 *
 * ВАЖНО: скрытое (opacity:0) состояние reveal живёт под селектором
 * `html.motion .reveal` — класс `motion` добавляется только когда анимации
 * реально включены. Если JS не выполнится, контент останется видимым.
 *
 * Стили импортируем ЗДЕСЬ, а не через @import в style.css: style.css
 * переписывается параллельным дизайн-процессом и затирает наш импорт.
 * Привязка CSS к модулю делает слой самодостаточным и устойчивым к этому.
 */
import "./styles/motion.css";

let started = false;

export function initMotion(): void {
  if (started) return;
  started = true;

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(pointer: fine)").matches;

  // Функциональные части работают всегда (плавность уважает reduce внутри).
  setupNavSpy(reduce);
  setupCounters(reduce);

  if (reduce) return; // дальше — только анимация/декор

  document.documentElement.classList.add("motion");
  injectDecor();
  setupReveal();
  setupParallax();
  if (finePointer) {
    setupMagnetic();
  }
}

/* ─────────────────────────── Декор ─────────────────────────── */
function injectDecor(): void {
  const body = document.body;

  // 1. Зерно (SVG feTurbulence) — премиальная фактура поверх всего.
  if (!document.querySelector(".fx-grain")) {
    const grain = document.createElement("div");
    grain.className = "fx-grain";
    grain.setAttribute("aria-hidden", "true");
    body.appendChild(grain);
  }

  // 2. Индикатор прогресса скролла — тонкая линия сверху.
  if (!document.querySelector(".fx-progress")) {
    const bar = document.createElement("div");
    bar.className = "fx-progress";
    bar.setAttribute("aria-hidden", "true");
    bar.innerHTML = "<i></i>";
    body.appendChild(bar);
    const fill = bar.querySelector("i") as HTMLElement;
    const onScroll = () => {
      const h = document.documentElement.scrollHeight - innerHeight;
      fill.style.transform = `scaleX(${h > 0 ? scrollY / h : 0})`;
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // 3. Бегущая строка форматов между hero и потоком — декор + подсказка.
  ensureMarquee();
}

/*
 * Маркиза живёт внутри .app (Vue-поддерево), поэтому асинхронный ре-рендер Vue
 * может её удалить. Держим её самовосстанавливающейся: инъекцию повторяет
 * MutationObserver из setupReveal, если узел пропал.
 */
function ensureMarquee(): void {
  const hero = document.querySelector(".hero");
  if (!hero || document.querySelector(".fx-marquee")) return;
  const items = ["MIDI", "MUSICXML", "PDF", "AUDIO", "COVER", "LEARN MODE", "ADAPTIVE"];
  const line = items.map((x) => `<span>${x}</span><em>✳</em>`).join("");
  const marquee = document.createElement("div");
  marquee.className = "fx-marquee"; // без reveal: узел может пере-инжектиться, не должен застрять скрытым
  marquee.setAttribute("aria-hidden", "true");
  // Дублируем ленту дважды — для бесшовной прокрутки в keyframes.
  marquee.innerHTML = `<div class="fx-marquee-track">${line}${line}</div>`;
  hero.insertAdjacentElement("afterend", marquee);
}

/* ─────────────────────── Reveal при скролле ─────────────────────── */
function setupReveal(): void {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          (e.target as HTMLElement).classList.add("in");
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  const marqueeIo = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      entry.target.classList.toggle("is-paused", !entry.isIntersecting);
    }
  });

  // Hero НЕ включаем: он на первом экране и должен появляться сразу
  // (иначе на медленной загрузке мелькнёт размытие до срабатывания IO).
  const SELECTOR =
    ".fx-marquee, .flow-step-tag, .source-switch, " +
    ".movement, .session-movement, .colophon, .piece-table tbody tr";

  const attach = (el: HTMLElement, i = 0) => {
    if (el.classList.contains("reveal")) return;
    // Блоки внутри .source-panel анимируются Vue-переходом src-swap —
    // reveal их только скрыл бы (opacity:0) без гарантии показа. Пропускаем.
    if (el.closest(".source-panel")) return;
    el.classList.add("reveal");
    // Небольшой стагер для строк таблицы и групповых элементов.
    if (i) el.style.setProperty("--reveal-delay", `${Math.min(i, 8) * 55}ms`);
    io.observe(el);
    if (el.classList.contains("fx-marquee")) marqueeIo.observe(el);
  };

  const scan = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
      const rows = el.closest("tbody");
      attach(el, rows ? Array.prototype.indexOf.call(rows.children, el) : 0);
    });
  };

  // Failsafe: если IntersectionObserver почему-то не сработал (throttling,
  // элемент вне вьюпорта, но пользователь к нему не проскроллит), через 1.6 с
  // принудительно показываем всё — контент НИКОГДА не остаётся скрытым.
  let failsafe: number | undefined;
  const armFailsafe = () => {
    if (failsafe) clearTimeout(failsafe);
    failsafe = window.setTimeout(() => {
      document.querySelectorAll<HTMLElement>(".reveal:not(.in)").forEach((el) => {
        // Показываем только то, что уже в зоне видимости или выше — низлежащие
        // блоки честно ждут прокрутки (в этом и смысл reveal).
        if (el.getBoundingClientRect().top < innerHeight * 0.95) el.classList.add("in");
      });
    }, 1600);
  };

  scan(document);
  armFailsafe();

  // Библиотека (PiecesMovement) монтируется по условию v-if — ловим её появление.
  // Заодно восстанавливаем маркизу, если Vue-патч удалил её из .app. Vue может
  // добавить сотни строк одной пачкой: сканируем их не чаще одного раза за frame.
  const pendingRoots = new Set<HTMLElement>();
  let scanFrame: number | undefined;
  const flush = () => {
    scanFrame = undefined;
    ensureMarquee();
    pendingRoots.forEach((root) => scan(root));
    pendingRoots.clear();
    armFailsafe();
  };
  const mo = new MutationObserver((muts) => {
    for (const m of muts)
      m.addedNodes.forEach((n) => {
        if (n instanceof HTMLElement) pendingRoots.add(n);
      });
    if (pendingRoots.size > 0 && scanFrame === undefined) {
      scanFrame = requestAnimationFrame(flush);
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

/* ─────────────────────────── Parallax ─────────────────────────── */
function setupParallax(): void {
  const hero = document.querySelector<HTMLElement>(".hero");
  const copy = document.querySelector<HTMLElement>(".hero-copy");
  const score = document.querySelector<HTMLElement>(".hero-score");
  if (!hero) return;

  let ticking = false;
  const update = () => {
    ticking = false;
    const y = scrollY;
    const p = Math.max(0, Math.min(1, y / (hero.offsetHeight || 1)));
    // ♭-глиф (hero-copy::after) и кольцо (hero-score::before) движутся с разной скоростью.
    copy?.style.setProperty("--par", `${p * 120}px`);
    score?.style.setProperty("--par", `${p * -70}px`);
  };
  const onScroll = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  };
  addEventListener("scroll", onScroll, { passive: true });
  update();
}

/* ─────────────────────── Магнитные кнопки ─────────────────────── */
function setupMagnetic(): void {
  const targets = document.querySelectorAll<HTMLElement>(
    ".topbar-cta, .brand-mark, .library-refresh",
  );
  targets.forEach((el) => {
    if (el.dataset.magnetic) return;
    el.dataset.magnetic = "1";
    const strength = el.classList.contains("btn") ? 0.35 : 0.5;
    const onMove = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = ev.clientX - (r.left + r.width / 2);
      const dy = ev.clientY - (r.top + r.height / 2);
      el.style.transform = `translate(${dx * strength}px, ${dy * strength}px)`;
    };
    const reset = () => (el.style.transform = "");
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", reset);
  });
}

/* ─────────────── Scrollspy + плавный переход по якорям ─────────────── */
function setupNavSpy(reduce: boolean): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".topbar-links a"));
  if (!links.length) return;

  // Порядок ссылок: Собрать · Войти · Издать · Обучать.
  const resolve = (): (HTMLElement | null)[] => {
    const flows = document.querySelectorAll<HTMLElement>(".movements .flow-step");
    return [
      flows[0] ?? document.querySelector(".movements"),
      flows[1] ?? null,
      document.querySelector(".metadata-movement"),
      document.querySelector(".library-movement"),
    ];
  };

  links.forEach((link, i) => {
    const go = () => {
      const target = resolve()[i];
      if (!target) return;
      target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    };
    link.addEventListener("click", (e) => {
      e.preventDefault();
      go();
    });
  });

  let sections = resolve();
  const observed = new Set<HTMLElement>();

  // Подсветка активной секции.
  const spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const idx = sections.findIndex((section) => section === e.target);
        if (idx >= 0) links.forEach((l, j) => l.classList.toggle("active", j === idx));
      }
    },
    { rootMargin: "-45% 0px -45% 0px" },
  );
  const observeAll = () => {
    sections = resolve();
    sections.forEach((section) => {
      if (!section || observed.has(section)) return;
      observed.add(section);
      spy.observe(section);
    });
  };
  observeAll();
  // Повторно — когда библиотека появится; серию Vue-мутаций сводим к одному frame.
  let observeFrame: number | undefined;
  new MutationObserver(() => {
    if (observeFrame !== undefined) return;
    observeFrame = requestAnimationFrame(() => {
      observeFrame = undefined;
      observeAll();
    });
  }).observe(document.body, { childList: true, subtree: true });
}

/* ─────────────────────────── Count-up ─────────────────────────── */
function setupCounters(reduce: boolean): void {
  // Анимируем только элементы с явным целевым числом (data-countup="N").
  // Читать textContent опасно: Vue может ещё показывать 0, а textContent
  // уничтожает реактивный текстовый узел — счётчик залипает на нуле.
  const run = (el: HTMLElement) => {
    if (el.dataset.counted) return;
    const raw = el.getAttribute("data-countup") || "";
    const target = parseInt(raw, 10);
    if (!Number.isFinite(target) || target <= 0) return;
    el.dataset.counted = "1";
    if (reduce) {
      el.textContent = String(target);
      return;
    }
    const dur = 900;
    let start = 0;
    const step = (ts: number) => {
      if (!start) start = ts;
      const t = Math.min(1, (ts - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      if (el.dataset.counted !== "1") return;
      el.textContent = String(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          run(e.target as HTMLElement);
          io.unobserve(e.target);
        }
    },
    { threshold: 0.6 },
  );

  const scan = (root: ParentNode) =>
    root.querySelectorAll<HTMLElement>("[data-countup]").forEach((el) => {
      const raw = el.getAttribute("data-countup") || "";
      // Пустой атрибут (data-countup без значения) — не трогаем: Vue сам рисует число.
      if (raw === "" || raw === "true") return;
      io.observe(el);
    });
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts)
      m.addedNodes.forEach((n) => n instanceof HTMLElement && scan(n));
  }).observe(document.body, { childList: true, subtree: true });
}
