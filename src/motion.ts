/**
 * Short reveal transitions and navigation feedback.
 * Content stays visible without JavaScript; reduced-motion disables animation.
 * Styles are loaded by style.css so the studio layer has a predictable order.
 */


let started = false;

export function initMotion(): void {
  if (started) return;
  started = true;

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;


  // Функциональные части работают всегда (плавность уважает reduce внутри).
  setupNavSpy(reduce);
  setupCounters(reduce);

  if (reduce) return; // дальше — только анимация/декор

  document.documentElement.classList.add("motion");
  setupReveal();
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
  // Hero НЕ включаем: он на первом экране и должен появляться сразу
  // (иначе на медленной загрузке мелькнёт размытие до срабатывания IO).
  const SELECTOR =
    ".flow-step-tag, .source-switch, " +
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
  // Vue может добавить сотни строк: сканируем не чаще одного раза за frame.
  const pendingRoots = new Set<HTMLElement>();
  let scanFrame: number | undefined;
  const flush = () => {
    scanFrame = undefined;

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

/* ─────────────────────────── Navigation ─────────────────────────── */
function setupNavSpy(reduce: boolean): void {
  const nav = document.querySelector<HTMLElement>(".topbar-links");
  if (!nav) return;
  const links = () => Array.from(nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'));
  const targetOf = (link: HTMLAnchorElement) =>
    document.getElementById(link.hash.slice(1));

  // Delegation also handles the library link mounted after sign-in.
  nav.addEventListener("click", (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
    if (!link || !nav.contains(link)) return;
    const target = targetOf(link);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  });
  const observed = new Set<HTMLElement>();

  // Подсветка активной секции.
  const spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links().forEach((link) => link.classList.toggle("active", targetOf(link) === e.target));
      }
    },
    { rootMargin: "-45% 0px -45% 0px" },
  );
  const observeAll = () => {
    links().map(targetOf).forEach((section) => {
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
