import type { Page } from "playwright";
import {
  parseSlicingSnapshot,
  type LearningStep,
  type SlicingExercise,
  type SlicingSnapshot,
  type SlicingTab,
} from "./learning-plan";
import { removeChoppedHandExercises } from "./learning-cleanup";
import { addChoppedReviews } from "./learning-reviews";
import { replaceChoppedWithAdaptivePlan } from "./learning-adaptive-page";
import { ADAPTIVE_CHUNK_ORDER, LEARN_TIMING } from "./learning-config";
import { installSlicingStore } from "./slicing-store"; // CHANGED: кеш slicing ищется по форме, а не по литеральному ключу
import { tlog } from "./log"; // CHANGED: видимый в логе возврат страницы на slicing tool
type ProgressReporter = (progress: number, message: string) => void;
const TAB_LABELS: Record<SlicingTab, string> = {
  W: "Whole",
  C: "Chopped",
  MIN: "Minced",
};
export async function executeLearningStep(
  page: Page,
  pieceId: number,
  step: LearningStep,
  report: ProgressReporter,
  progress: number,
  stepCount: number,
): Promise<void> {
  // CHANGED: Piano Marvel может сам увести страницу с slicing tool (наблюдался уход
  // на /nextgen/dashboard после сохранения Whole) — возвращаемся до любого действия,
  // иначе шаг ищет вкладки и партитуру на чужой странице.
  if (await ensureOnSlicingTool(page, pieceId)) {
    tlog().warn(`страница ушла с slicing tool — вернул её перед шагом ${step.type}`);
  }
  // Ошибка Piano Marvel может оставить блокирующую модалку с прошлого действия —
  // это состояние страницы, проверяем и снимаем его перед любым шагом.
  await dismissErrorModal(page);
  await selectTab(page, pieceId, step.tab, step.type === "set-tempos" ? "tempos" : "list");
  switch (step.type) {
    case "set-tempos":
      await setTempos(page, pieceId, step.tab, step.tempos ?? [60, 80, 100]);
      return;
    case "predict-chopped":
      await predictChopped(page, pieceId, report, progress, stepCount);
      return;
    case "replace-chopped-adaptive":
      await ensureChoppedSeed(page, pieceId);
      await replaceChoppedWithAdaptivePlan(
        page,
        step.chunks ?? [],
        step.tempos ?? [60, 80, 100],
      );
      await openSlicingTool(page, pieceId);
      return;
    case "duplicate-chopped":
      await duplicateChopped(page, pieceId);
      await saveCurrentTab(page);
      return;
    case "add-chopped-reviews":
      await addChoppedReviews(page, pieceId, step.tempos ?? [60, 80, 100]);
      return;
    case "remove-chopped-hands":
      await removeChoppedHandExercises(page, pieceId);
      return;
    case "split-hands":
      await splitMissingHands(page, pieceId, step.tab);
      await saveCurrentTab(page);
  }
}
/** Страницы, в которые уже поставлен page-side доступ к кешу slicing. */
const slicingStoreReady = new WeakSet<Page>();

/**
 * Ставит `window.__pmSlicing` и сбрасывает кеш прошлого документа.
 *
 * Строго один раз на страницу: скрипты инициализации Playwright накапливаются и снять
 * их нельзя, а openSlicingTool вызывается на каждом шаге прогона. Все page-side чтения
 * схемы идут через этот объект, поэтому вызывать его нужно ДО первой навигации.
 */
export async function ensureSlicingStore(page: Page): Promise<void> {
  if (slicingStoreReady.has(page)) return;
  slicingStoreReady.add(page);
  await page.addInitScript(installSlicingStore);
  // Прошлое разбиение пьесы обязано гидратироваться с сервера, а не остаться от
  // предыдущего прогона — сбрасываем кеш под любым именем, а не только slicingData.
  await page.addInitScript(() => __pmSlicing?.reset());
}

/** Открыт ли slicing tool именно этой пьесы. */
export function isSlicingToolUrl(url: string, pieceId: number): boolean {
  return new RegExp(`/slicing_tool/${pieceId}(?:[/?#]|$)`).test(url);
}

/**
 * Возвращает страницу на slicing tool, если Piano Marvel увёл её сам.
 *
 * Наблюдалось на живом прогоне: после сохранения вкладки Whole приложение
 * оказывалось на `/en/nextgen/dashboard` (в консоли перед этим — собственная ошибка
 * PM `Cannot set properties of undefined (setting 'staffs')` в resetPositionDefault),
 * и следующий шаг ждал ноты партитуры на другой странице, пока не выбирал потолок.
 * Триггер — фактический URL, а не пауза. Возвращает true, если пришлось вернуться.
 */
export async function ensureOnSlicingTool(page: Page, pieceId: number): Promise<boolean> {
  if (isSlicingToolUrl(page.url(), pieceId)) return false;
  await openSlicingTool(page, pieceId);
  return true;
}

export async function openSlicingTool(
  page: Page,
  pieceId: number,
  options: { interactive?: boolean } = {},
): Promise<void> {
  await ensureSlicingStore(page); // CHANGED: вместо removeItem("slicingData") — установка доступа к кешу
  await page.goto(`https://pianomarvel.com/en/nextgen/slicing_tool/${pieceId}`, {
    waitUntil: "domcontentloaded",
    timeout: LEARN_TIMING.navTimeout,
  });
  await page.waitForSelector(".list-slicing", { timeout: LEARN_TIMING.navTimeout });
  try {
    await page.waitForFunction(
      ({ id, interactive }) => {
        try {
          // CHANGED: кеш читается по фактическому ключу (__pmSlicing), а не по "slicingData"
          const piece = __pmSlicing?.read(id) as Array<{
            sortName?: string;
            data?: { exercises?: unknown[] };
          }> | null | undefined;
          if (!piece || !document.querySelector(".save-button")) return false;
          const labels = Array.from(document.querySelectorAll(".slicing")).map((node) =>
            node.textContent?.trim(),
          );
          if (!["Whole", "Chopped", "Minced"].every((label) => labels.some((text) => text?.includes(label)))) {
            return false;
          }
          if (!interactive) return true;
          const active = document.querySelector(".slicing.active")?.textContent ?? "";
          const sortName = active.includes("Chopped") ? "C" : active.includes("Minced") ? "MIN" : "W";
          const expected = piece.find((tab) => tab.sortName === sortName)?.data?.exercises?.length ?? 0;
          const rendered = document.querySelectorAll(".exercise").length;
          // Не равенство, а соответствие «пусто/непусто»: длинный список отрисовывается
          // окном видимых строк, и точное совпадение чисел недостижимо.
          return expected === 0 ? rendered === 0 : rendered > 0;
        } catch {
          return false;
        }
      },
      { id: String(pieceId), interactive: options.interactive !== false },
      { timeout: LEARN_TIMING.hydrateCap },
    );
  } catch (error) {
    const probe = await readSlicingHydrationProbe(page, pieceId).catch(() => undefined);
    throw new Error(
      `Piano Marvel не подготовил slicing tool для piece ${pieceId} за ` +
        `${LEARN_TIMING.hydrateCap}ms. Состояние: ${JSON.stringify(probe ?? { unavailable: true })}`,
      { cause: error },
    );
  }
}

export interface SlicingHydrationProbe {
  url: string;
  title: string;
  /** Установлен ли page-side доступ к кешу (ensureSlicingStore до навигации). */
  storeInstalled: boolean;
  /** РЕАЛЬНЫЕ имена ключей localStorage — по ним видно, куда делся кеш. */
  storageKeys: string[];
  /** РЕАЛЬНЫЕ имена ключей sessionStorage. */
  sessionKeys: string[];
  pieceFound: boolean;
  hasSaveButton: boolean;
  labels: string[];
  activeLabel: string;
  renderedExercises: number;
  tabExercises: Record<string, number>;
}

/** Компактное состояние гидратации для понятной ошибки и backend-диагностики. */
export async function readSlicingHydrationProbe(
  page: Page,
  pieceId: number,
): Promise<SlicingHydrationProbe> {
  return page.evaluate((id) => {
    // CHANGED: прежний probe печатал ключи ВНУТРИ slicingData, поэтому исчезновение
    // самого ключа выглядело как пустое storageKeys и не давало ни одной подсказки.
    const piece = (__pmSlicing?.read(id) ?? undefined) as Array<{
      sortName?: string;
      data?: { exercises?: unknown[] };
    }> | undefined;
    const keys = __pmSlicing?.keys() ?? { local: [], session: [] };
    return {
      url: location.href,
      title: document.title,
      storeInstalled: typeof __pmSlicing !== "undefined",
      storageKeys: keys.local.slice(0, 24),
      sessionKeys: keys.session.slice(0, 24),
      pieceFound: piece !== undefined,
      hasSaveButton: document.querySelector(".save-button") !== null,
      labels: Array.from(document.querySelectorAll(".slicing")).map(
        (node) => node.textContent?.trim() ?? "",
      ),
      activeLabel: document.querySelector(".slicing.active")?.textContent?.trim() ?? "",
      renderedExercises: document.querySelectorAll(".exercise").length,
      tabExercises: Object.fromEntries(
        (piece ?? []).map((tab) => [
          tab.sortName ?? "?",
          Array.isArray(tab.data?.exercises) ? tab.data.exercises.length : -1,
        ]),
      ),
    };
  }, String(pieceId));
}
/**
 * Ждёт, пока Piano Marvel наполнит кеш схемы по ВСЕМ трём вкладкам.
 *
 * После свежей загрузки страница гидратирует вкладки постепенно (в первую очередь
 * активную), поэтому финальная проверка успевала прочитать ещё пустой Chopped и
 * решала, что шаг не выполнен («Схема сохранена не полностью»), хотя через десятки
 * миллисекунд там уже были все упражнения. Использовать только там, где по смыслу
 * все вкладки обязаны быть непустыми — то есть после построения схемы.
 */
export async function waitForTabsHydrated(page: Page, pieceId: number): Promise<void> {
  await page.waitForFunction(
    (id) => {
      try {
        const tabs = __pmSlicing?.read(id) as Array<{
          sortName?: string;
          data?: { exercises?: unknown[] };
        }> | null | undefined;
        if (!tabs) return false;
        return ["W", "C", "MIN"].every((sortName) => {
          const exercises = tabs.find((tab) => tab.sortName === sortName)?.data?.exercises;
          return Array.isArray(exercises) && exercises.length > 0;
        });
      } catch {
        return false;
      }
    },
    String(pieceId),
    { timeout: LEARN_TIMING.hydrateCap },
  );
}

export async function readSlicingSnapshot(
  page: Page,
  pieceId: number,
): Promise<SlicingSnapshot> {
  const value = await page.evaluate(
    (id) => __pmSlicing?.read(id) ?? null, // CHANGED: фактический ключ кеша
    String(pieceId),
  );
  return parseSlicingSnapshot(value);
}

/**
 * Строгая UI-проверка Adaptive: localStorage может содержать упражнение, которое
 * Angular создал в DOM, но скрыл из списка из-за некорректного порядка диапазонов.
 * Подтверждаем реальную видимость каждого ожидаемого title, а не только число узлов.
 */
export async function verifyExercisesVisible(
  page: Page,
  pieceId: number,
  tab: SlicingTab,
  expected: SlicingExercise[],
): Promise<void> {
  await selectTab(page, pieceId, tab);
  const titles = expected.map((exercise) => exercise.title);
  const pending = new Set(titles);
  const cap =
    LEARN_TIMING.hydrateCap +
    titles.length * LEARN_TIMING.hydratePerExerciseCap;
  const deadline = Date.now() + cap;
  const missing = await resolvePendingTitles([...pending], async (expectedTitles) => {
    const remaining = Math.max(1, deadline - Date.now());
    return page
      .waitForFunction(
        (candidateTitles) => {
          const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
          const nodes = Array.from(
            document.querySelectorAll<HTMLElement>(".exercise"),
          );
          const matched: string[] = [];
          for (const title of candidateTitles) {
            const normalizedTitle = normalize(title);
            const visible = nodes.some((node) => {
              if (!normalize(node.textContent ?? "").includes(normalizedTitle)) return false;
              const style = getComputedStyle(node);
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity) !== 0 &&
                node.getClientRects().length > 0
              );
            });
            if (visible) matched.push(title);
          }
          return matched.length > 0 ? matched : false;
        },
        expectedTitles,
        { timeout: remaining },
      )
      .then((handle) => handle.jsonValue() as Promise<string[]>)
      .catch(() => []);
  });
  if (missing.length === 0) return;

  // CHANGED: подсказка про порядок маршрута. Порядок `stage` намеренно ставит
  // строку с меньшим концом такта после строки с большим (все мостики идут после
  // всех отрезков). Если Piano Marvel такие строки прячет, отличить это от любой
  // другой причины «сохранил, но не показывает» можно только по сообщению.
  const orderHint =
    ADAPTIVE_CHUNK_ORDER === "stage"
      ? " Маршрут собран порядком stage (сперва все отрезки, затем все мостики), " +
        "в котором конец такта не монотонен. Если скрыты именно строки, идущие назад " +
        "по партитуре, вернитесь к порядку партитуры: ADAPTIVE_CHUNK_ORDER=score."
      : "";
  throw new Error(
    `Adaptive: Piano Marvel сохранил, но не показывает ${TAB_LABELS[tab]} exercises: ${missing.join(", ")}.${orderHint}`,
  );
}

/**
 * Уже найденные заголовки больше не передаются следующей DOM-проверке. Чистая
 * оркестрация позволяет доказать монотонное уменьшение работы без живого браузера.
 */
export async function resolvePendingTitles(
  titles: string[],
  findVisible: (pending: string[]) => Promise<string[]>,
): Promise<string[]> {
  const pending = new Set(titles);
  while (pending.size > 0) {
    const found = await findVisible([...pending]);
    let removed = 0;
    for (const title of found) {
      if (pending.delete(title)) removed += 1;
    }
    if (removed === 0) break;
  }
  return [...pending];
}
export function learningStepMessage(step: LearningStep): string {
  const tab = TAB_LABELS[step.tab];
  if (step.type === "set-tempos") return `${tab}: задаю темпы`;
  if (step.type === "predict-chopped") return "Chopped: определяю фрагменты";
  if (step.type === "replace-chopped-adaptive") return "Chopped: применяю MusicXML-разбиение";
  if (step.type === "duplicate-chopped") return "Minced: копирую Chopped";
  if (step.type === "add-chopped-reviews") return "Chopped: добавляю обзорные chunks";
  if (step.type === "remove-chopped-hands") return "Chopped: убираю RH/LH";
  return `${tab}: разделяю правую и левую руки`;
}
/**
 * Что должно быть готово на вкладке, чтобы шаг мог работать.
 *   `list`   — список упражнений отрисован (нужно для действий над упражнениями);
 *   `tempos` — панель темпов с тремя полями (для set-tempos список не нужен вовсе).
 */
export type TabReadiness = "list" | "tempos";

export async function selectTab(
  page: Page,
  pieceId: number,
  tab: SlicingTab,
  readiness: TabReadiness = "list",
): Promise<void> {
  const target = page.locator(".slicing").filter({ hasText: TAB_LABELS[tab] }).first();
  if (!(await target.count())) throw new Error(`Не найдена вкладка ${TAB_LABELS[tab]}.`);
  if (!(await target.evaluate((node) => node.classList.contains("active")))) {
    await target.evaluate((node) => (node as HTMLElement).click());
  }
  await page.waitForFunction(
    ({ id, label, sortName, need }) => {
      const active = Array.from(document.querySelectorAll(".slicing.active")).some((node) =>
        node.textContent?.includes(label),
      );
      if (!active || !document.querySelector(".save-button")) return false;
      // Панели темпов список упражнений не нужен: она готова, когда есть три поля.
      if (need === "tempos") {
        return document.querySelectorAll(".edit-tempo-number").length === 3;
      }
      try {
        const tabs = __pmSlicing?.read(id) as Array<{ // CHANGED: фактический ключ кеша
          sortName: string;
          data?: { exercises?: unknown[] };
        }> | null | undefined;
        if (!tabs) return false;
        const expected =
          tabs?.find((item) => item.sortName === sortName)?.data?.exercises?.length ?? 0;
        const rendered = document.querySelectorAll(".exercise").length;
        // Равенство `rendered === expected` недостижимо, когда список длинный: Piano
        // Marvel отрисовывает окно видимых строк (в Minced на 156 упражнений в DOM
        // остаётся около десяти), и ожидание всегда доходило до аварийного потолка.
        // Готовность вкладки — это соответствие «пусто/непусто» между хранилищем и
        // списком, а полноту сохранённого проверяет verifyExercisesVisible.
        return expected === 0 ? rendered === 0 : rendered > 0;
      } catch {
        return false;
      }
    },
    { id: String(pieceId), label: TAB_LABELS[tab], sortName: tab, need: readiness },
    { timeout: LEARN_TIMING.hydrateCap },
  );
}
/**
 * Темпы вкладки. Шаг идемпотентен и опирается на состояние, а не на попытку «нажать
 * и подождать»: если хранилище уже содержит целевые значения, UI не трогается вовсе.
 * Так после копирования Chopped в Minced (темпы переносятся вместе с упражнениями)
 * не остаётся шага, который ничего не меняет, но ждёт активной кнопки Save.
 */
async function setTempos(
  page: Page,
  pieceId: number,
  tab: SlicingTab,
  tempos: [number, number, number],
): Promise<void> {
  const stored = await page.evaluate(
    ({ id, sortName }) => {
      try {
        const tabs = __pmSlicing?.read(id) as Array<{ // CHANGED: фактический ключ кеша
          sortName?: string;
          data?: { tempos?: unknown };
        }> | null | undefined;
        const values = tabs?.find((item) => item.sortName === sortName)?.data?.tempos;
        return Array.isArray(values) ? values.map(Number) : [];
      } catch {
        return [] as number[];
      }
    },
    { id: String(pieceId), sortName: tab },
  );
  if (tempos.every((tempo, index) => stored[index] === tempo)) return;

  const inputs = page.locator(".edit-tempo-number");
  if ((await inputs.count()) !== 3) throw new Error("Не найдены три поля темпа.");
  for (let index = 0; index < tempos.length; index += 1) {
    const input = inputs.nth(index);
    await input.click({ force: true });
    await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await input.type(String(tempos[index]), { delay: LEARN_TIMING.tempoFieldDelay });
    await input.press("Tab");
  }
  // Триггер завершения ввода — значения в полях, а не ожидание кнопки: Piano Marvel
  // оставляет Save выключенным, когда новое значение совпало с прежним.
  await page.waitForFunction(
    (expected) => {
      const values = Array.from(document.querySelectorAll<HTMLInputElement>(".edit-tempo-number"))
        .map((input) => Number(input.value));
      return expected.every((tempo, index) => values[index] === tempo);
    },
    tempos,
    { timeout: LEARN_TIMING.hydrateCap },
  );
  const dirty = await page
    .locator(".save-button")
    .first()
    .evaluate((node) => !(node as HTMLButtonElement).disabled)
    .catch(() => false);
  if (dirty) await saveCurrentTab(page);
}

/** Полные (не RH/LH) фразы Chopped — единица прогресса предикта. */
function combinedChoppedCount(snapshot: SlicingSnapshot): number {
  return snapshot.tabs.C.exercises.filter(
    (exercise) => !/\s-\s(?:RH|LH)$/i.test(exercise.title),
  ).length;
}

/**
 * Убирает незавершённый черновик «Drag to select measures» (остаётся от прерванных
 * прогонов и блокирует Predict — видели на скриншоте piece 157778). Undo снимает
 * последнее незакреплённое действие; триггер завершения — черновик исчез из DOM.
 */
async function resolvePendingExerciseRow(page: Page): Promise<void> {
  const hasPending = () =>
    page
      .locator(".exercise")
      .filter({ hasText: /drag to select/i })
      .count();
  if (!(await hasPending())) return;
  const undo = page.getByRole("button", { name: /undo/i }).first();
  for (
    let attempt = 0;
    attempt < LEARN_TIMING.predictRecoveryLimit && (await hasPending());
    attempt += 1
  ) {
    if (!(await undo.count())) break;
    await undo.evaluate((node) => (node as HTMLButtonElement).click());
    await page
      .waitForFunction(
        () =>
          !Array.from(document.querySelectorAll(".exercise")).some((row) =>
            /drag to select/i.test(row.textContent ?? ""),
          ),
        undefined,
        { timeout: LEARN_TIMING.hydrateCap },
      )
      .catch(() => undefined);
  }
  if (await hasPending()) {
    throw new Error("Незавершённый черновик «Drag to select measures» не удаляется через Undo.");
  }
}

/**
 * Ждёт СУЩЕСТВЕННЫЙ исход клика Predict по данным slicingData и состоянию редактора
 * (DOM-счётчики упражнений сами по себе ненадёжны — включают черновики):
 *   'grew'    — число полных фраз C выросло,
 *   'covered' — Chopped уже покрывает Whole,
 *   'pending' — редактор предлагает зафиксировать предсказанный фрагмент кнопкой Done,
 *   'modal'   — Piano Marvel показал блокирующую модалку ошибки.
 */
async function waitPredictOutcome(
  page: Page,
  pieceId: number,
  previousCombined: number,
  includePending: boolean,
): Promise<"grew" | "covered" | "pending" | "modal" | null> {
  return page
    .waitForFunction(
      ({ id, prev, withPending }) => {
        if (document.querySelector("modal-container.show, .modal.show")) return "modal";
        try {
          const tabs = __pmSlicing?.read(id) as Array<{ // CHANGED: фактический ключ кеша
            sortName: string;
            data?: { exercises?: Array<Record<string, unknown>> };
          }> | null | undefined;
          const get = (sortName: string) =>
            tabs?.find((tab) => tab.sortName === sortName)?.data?.exercises ?? [];
          const title = (e: Record<string, unknown>) => String(e.exerciseTitle ?? e.title ?? "");
          const end = (e: Record<string, unknown>) => Number(e.endMeasure ?? e.end_measure ?? 0);
          const whole = get("W");
          const combined = get("C").filter((e) => !/\s-\s(?:RH|LH)$/i.test(title(e)));
          const wholeEnd = Math.max(0, ...whole.map(end));
          const choppedEnd = Math.max(0, ...combined.map(end));
          if (combined.length > 0 && wholeEnd > 0 && choppedEnd >= wholeEnd) return "covered";
          if (combined.length > prev) return "grew";
        } catch {
        }
        if (withPending) {
          const predict = document.querySelector(".predict-exercise-button");
          if (/^done$/i.test(predict?.textContent?.trim() ?? "")) return "pending";
        }
        return false;
      },
      { id: String(pieceId), prev: previousCombined, withPending: includePending },
      { timeout: LEARN_TIMING.localMutationTimeout },
    )
    .then((handle) =>
      handle.jsonValue() as Promise<"grew" | "covered" | "pending" | "modal">,
    )
    .catch(() => null);
}

async function predictButtonIsDone(page: Page): Promise<boolean> {
  return page
    .locator(".predict-exercise-button")
    .first()
    .evaluate((node) => /^done$/i.test(node.textContent?.trim() ?? ""));
}

/**
 * Сохраняет Angular-модель и перечитывает её с сервера. Это важный recovery-path:
 * Piano Marvel иногда уже рисует числовой pending-row и активирует Save, но обновляет
 * localStorage только после сетевого Save (случаи #156053 и #155634).
 */
async function saveAndReloadChopped(
  page: Page,
  pieceId: number,
): Promise<SlicingSnapshot> {
  const save = page.locator(".save-button");
  if (await save.isDisabled()) {
    throw new Error("Predict завис без изменения slicingData и без доступного Save.");
  }
  await saveCurrentTab(page);
  await openSlicingTool(page, pieceId);
  await selectTab(page, pieceId, "C");
  return readSlicingSnapshot(page, pieceId);
}

/** После Done ждём, пока редактор вернётся в состояние следующего Predict. */
async function waitPredictReady(page: Page): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        if (document.querySelector("modal-container.show, .modal.show")) return true;
        const button = document.querySelector<HTMLButtonElement>(".predict-exercise-button");
        return Boolean(button && !button.disabled && !/^done$/i.test(button.textContent?.trim() ?? ""));
      },
      undefined,
      { timeout: LEARN_TIMING.localMutationTimeout },
    )
    .then(() => true)
    .catch(() => false);
}

async function predictChopped(
  page: Page,
  pieceId: number,
  report: ProgressReporter,
  baseProgress: number,
  stepCount: number,
): Promise<void> {
  const button = page.locator(".predict-exercise-button").first();
  await button.waitFor({ state: "visible", timeout: LEARN_TIMING.hydrateCap });
  let pendingChanges = 0;
  let recoveries = 0;
  let created = 0;
  while (created < LEARN_TIMING.predictExerciseLimit) {
    const before = await readSlicingSnapshot(page, pieceId);
    if (!needsMoreChopped(before)) {
      if (pendingChanges > 0) await saveCurrentTab(page);
      return;
    }
    // Состояния, блокирующие Predict: модалка ошибки и незавершённый черновик.
    await dismissErrorModal(page);
    await resolvePendingExerciseRow(page);
    await page.waitForFunction(
      () => {
        const predict = document.querySelector<HTMLButtonElement>(".predict-exercise-button");
        return Boolean(predict && !predict.disabled);
      },
      undefined,
      { timeout: LEARN_TIMING.hydrateCap },
    ).catch(() => {
      throw new Error("Predict New Exercise недоступен до завершения партитуры.");
    });
    const count = combinedChoppedCount(before);
    let outcome: Awaited<ReturnType<typeof waitPredictOutcome>>;

    if (await predictButtonIsDone(page)) {
      outcome = "pending";
    } else {
      await button.click({ force: true, timeout: LEARN_TIMING.hydrateCap });
      outcome = await waitPredictOutcome(page, pieceId, count, true);
    }

    if (outcome === "modal") {
      await dismissErrorModal(page);
      recoveries += 1;
      if (recoveries > LEARN_TIMING.predictRecoveryLimit) {
        throw new Error("Piano Marvel повторно показывает ошибку и не принимает Predict.");
      }
      continue;
    }

    if (outcome === "pending") {
      // Реальный user-like click надёжнее DOM click для Angular/Zone обработчика Done.
      await button.click({ force: true, timeout: LEARN_TIMING.hydrateCap });
      outcome = await waitPredictOutcome(page, pieceId, count, false);
      if (outcome === "modal") {
        await dismissErrorModal(page);
        outcome = null;
      }
    }

    let after = await readSlicingSnapshot(page, pieceId);
    if (combinedChoppedCount(after) <= count && needsMoreChopped(after)) {
      // Pending-row может жить только во внутренней Angular-модели. Save — событие,
      // которое материализует его на сервере; reload подтверждает фактический итог.
      after = await saveAndReloadChopped(page, pieceId);
      pendingChanges = 0;
    }
    if (combinedChoppedCount(after) <= count && needsMoreChopped(after)) {
      recoveries += 1;
      if (recoveries > LEARN_TIMING.predictRecoveryLimit) {
        throw new Error("Predict не материализовал новый фрагмент после Save и перечитывания.");
      }
      continue;
    }

    recoveries = 0;
    created += 1;
    pendingChanges += 1;
    if (pendingChanges >= LEARN_TIMING.predictCheckpointEvery) {
      await saveCurrentTab(page);
      pendingChanges = 0;
    }

    // Не начинаем новый цикл, пока Done не превратился обратно в Predict. Если UI
    // не синхронизировался, Save+reload восстанавливает состояние без sleep/retry.
    if (needsMoreChopped(after) && !(await waitPredictReady(page))) {
      await saveAndReloadChopped(page, pieceId);
      pendingChanges = 0;
    }
    report(
      Math.min(
        88,
        baseProgress +
          Math.round((created / LEARN_TIMING.predictExerciseLimit) * (80 / stepCount)),
      ),
      `Chopped: создано ${created} фрагментов`,
    );
  }
  throw new Error(
    `Predict New Exercise превысил безопасный лимит ${LEARN_TIMING.predictExerciseLimit} шагов.`,
  );
}

/**
 * Adaptive-план целиком заменяет Chopped через перехват Save (server-method-162,
 * см. replaceChoppedWithAdaptivePlan), но Piano Marvel не формирует этот POST на
 * пустой вкладке: tempo-only "dirty" армирует кнопку Save визуально (disabled=false),
 * однако без единого реального упражнения клик не порождает сетевой запрос вообще —
 * ни waitForResponse, ни fallback по disabled не срабатывают (прежний
 * `waitForResponse: Timeout 30000ms`).
 *
 * Сеем вкладку штатным ручным путём редактора, а НЕ Predict: «Add New Exercise»
 * открывает pending-строку «Drag to select measures», выделение мышью по нотам
 * задаёт диапазон, «Done» фиксирует упражнение. Проверено вживую на пьесе 157815:
 * так появляется реальное упражнение и настоящий Save. Диапазон seed'а не важен —
 * replaceChoppedWithAdaptivePlan перезапишет весь список вычисленным планом; берём
 * первый такт, он всегда отрендерен (DOM отдаёт только видимые такты).
 */
async function ensureChoppedSeed(page: Page, pieceId: number): Promise<void> {
  const before = await readSlicingSnapshot(page, pieceId);
  if (before.tabs.C.exercises.length > 0) return;

  await dismissErrorModal(page);

  // CHANGED: партитуру готовим ДО создания pending-строки. Перезагрузка внутри
  // подготовки сняла бы уже открытое приглашение «Drag to select measures».
  await prepareScoreForSeed(page, pieceId, "C");

  // На пустой вкладке приглашение «Drag to select measures» уже открыто, а кнопка
  // «Add New Exercise» появляется только когда упражнения уже есть. Важно: на пустой
  // вкладке это приглашение — отдельный `span.drag-measure-text`, а НЕ строка
  // `.exercise` (проверено в живом DOM пьесы 157815), поэтому ищем именно его.
  // resolvePendingExerciseRow здесь не вызываем: он снимает через Undo ровно ту
  // строку, в которую мы собираемся выделять такты.
  const pending = page.locator(".drag-measure-text");
  if (!(await pending.count())) {
    const add = page.getByText("Add New Exercise", { exact: true }).first();
    if (!(await add.count())) {
      throw new Error(
        "Adaptive: на вкладке Chopped нет ни приглашения «Drag to select measures», ни кнопки Add New Exercise.",
      );
    }
    await add.evaluate((node) => (node as HTMLElement).click());
    await pending.first().waitFor({ state: "attached", timeout: LEARN_TIMING.hydrateCap });
  }

  await dragFirstMeasures(page);

  // Кнопка Predict временно превращается в Done — она же фиксирует выделение.
  const done = page.locator(".predict-exercise-button").first();
  try {
    await page.waitForFunction(
      () =>
        /^done$/i.test(
          document.querySelector(".predict-exercise-button")?.textContent?.trim() ?? "",
        ),
      undefined,
      { timeout: LEARN_TIMING.hydrateCap },
    );
  } catch (error) {
    // CHANGED: вместо безымянного «waitForFunction: Timeout» — состояние страницы.
    // Именно этой подсказки не хватало, когда выделение не доходило до редактора.
    const state = await readSeedState(page).catch(() => undefined);
    throw new Error(
      `Adaptive: редактор не подтвердил выделение тактов кнопкой Done за ${LEARN_TIMING.hydrateCap}ms. ` +
        `Состояние: ${JSON.stringify(state ?? { unavailable: true })}`,
      { cause: error },
    );
  }
  await done.click({ force: true, timeout: LEARN_TIMING.hydrateCap });
  await waitForExerciseGrowth(page, pieceId, "C", 0);
}

/**
 * Что перекрывает точку выделения, либо null.
 *
 * Проверять «попали ли ровно в нотную головку» нельзя: Piano Marvel гасит указатель у
 * содержимого партитуры (`.disable-child-element-pointer`) и ловит события сам на
 * обёртке системы — это штатная цель, а не помеха. Помехой является только чужой
 * оверлей: модалка, её бэкдроп или оверлей загрузки.
 */
async function findPointerBlocker(
  page: Page,
  point: { x: number; y: number },
): Promise<string | null> {
  return page.evaluate(({ x, y }) => {
    const top = document.elementFromPoint(x, y);
    const blocker = top?.closest(
      "modal-container, .modal, .modal-backdrop, .loading-wrapper, .loading-content",
    );
    return blocker
      ? `${blocker.tagName.toLowerCase()}.${String(blocker.getAttribute("class") ?? "")}`
      : null;
  }, point);
}

/** Всё, что нужно знать о неудачном засеве, одним снимком состояния. */
async function readSeedState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => ({
    url: location.href,
    activeTab: document.querySelector(".slicing.active")?.textContent?.trim() ?? "нет",
    notes: document.querySelectorAll(".vf-stavenote").length,
    pendingRows: document.querySelectorAll(".drag-measure-text").length,
    exercises: Array.from(document.querySelectorAll(".exercise")).filter(
      (node) => !node.querySelector(".drag-measure-text"),
    ).length,
    predictButton:
      document.querySelector(".predict-exercise-button")?.textContent?.trim() ?? "нет",
    saveDisabled: (document.querySelector(".save-button") as HTMLButtonElement | null)?.disabled,
    loadingOverlays: document.querySelectorAll(".loading-wrapper").length,
  }));
}

/**
 * Два такта для seed-выделения из фактически отрисованных. Именно отрисованных:
 * DOM отдаёт только видимое окно партитуры, поэтому первым может оказаться не такт 1.
 * Диапазон seed'а не важен — replaceChoppedWithAdaptivePlan перезапишет весь список.
 */
export function pickSeedMeasures(rendered: number[]): [number, number] {
  const sorted = [...new Set(rendered)].sort((left, right) => left - right);
  if (sorted.length === 0) {
    throw new Error("Adaptive: в партитуре не отрисован ни один такт для выделения.");
  }
  return [sorted[0], sorted[1] ?? sorted[0]];
}

/** Состояние области партитуры — для понятной ошибки вместо «не найдены головки». */
async function readScoreRenderState(page: Page): Promise<{
  url: string;
  notes: number;
  loadingOverlays: number;
  canvas: string;
  tabs: number;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector("div.game-mode canvas");
    const rect = canvas?.getBoundingClientRect();
    return {
      // CHANGED: URL в состоянии обязателен — уход страницы на dashboard выглядел
      // как «партитура не отрисовалась», и понять это по ошибке было нельзя.
      url: location.href,
      notes: document.querySelectorAll(".vf-stavenote").length,
      loadingOverlays: document.querySelectorAll(".loading-wrapper").length,
      canvas: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "нет",
      tabs: document.querySelectorAll(".slicing").length,
    };
  });
}

/**
 * Закрывает оверлей загрузки штатным крестиком. Наблюдался залипший `.loading-wrapper`
 * (незавершённый POST server-method-246), при котором партитура не рендерится вовсе, а
 * шаг падал мгновенно и без объяснения. Возвращает true, если оверлей был и снят.
 */
async function dismissLoadingOverlay(page: Page): Promise<boolean> {
  const closer = page.locator(".closeLoading").first();
  if (!(await closer.count())) return false;
  if (!(await closer.isVisible().catch(() => false))) return false;
  await closer.evaluate((node) => (node as HTMLElement).click()).catch(() => undefined);
  await page
    .waitForFunction(() => document.querySelectorAll(".loading-wrapper").length === 0, undefined, {
      timeout: LEARN_TIMING.localMutationTimeout,
    })
    .catch(() => undefined);
  return true;
}

/**
 * Ждёт отрисованную партитуру. Piano Marvel рисует ноты асинхронно и до этого держит
 * оверлей загрузки, а прежний код читал DOM сразу и падал за 57 мс с «не найдены
 * нотные головки». Триггер завершения — появившиеся головки (состояние страницы),
 * потолок остаётся аварийным.
 */
async function waitForScoreNotes(page: Page): Promise<boolean> {
  const notesRendered = () =>
    page
      .waitForFunction(() => document.querySelectorAll(".vf-stavenote").length > 0, undefined, {
        timeout: LEARN_TIMING.hydrateCap,
      })
      .then(() => true)
      .catch(() => false);
  if (await notesRendered()) return true;
  // Ноты не появились: возможно, страница залипла в оверлее загрузки.
  if (await dismissLoadingOverlay(page)) return notesRendered();
  return false;
}

/**
 * Готовит партитуру к seed-выделению.
 *
 * Ждать ноты имеет смысл только на своей странице: Piano Marvel уводил её на
 * `/nextgen/dashboard` после сохранения Whole, и шаг выбирал весь потолок, глядя на
 * чужой DOM. Поэтому сначала проверяется URL (состояние, не пауза), а если партитура
 * не появилась и на своей странице — один раз перезагружаем slicing tool: рендерер
 * возвращается ровно так же, как при обычном открытии пьесы человеком.
 */
async function prepareScoreForSeed(page: Page, pieceId: number, tab: SlicingTab): Promise<void> {
  const returned = await ensureOnSlicingTool(page, pieceId);
  if (returned) {
    tlog().warn("страница ушла с slicing tool — вернул её перед выделением тактов");
    await selectTab(page, pieceId, tab);
  }
  if (await waitForScoreNotes(page)) return;

  tlog().warn("партитура не отрисовалась — перезагружаю slicing tool");
  await openSlicingTool(page, pieceId);
  await selectTab(page, pieceId, tab);
  if (await waitForScoreNotes(page)) return;

  const state = await readScoreRenderState(page).catch(() => undefined);
  throw new Error(
    `Adaptive: Piano Marvel не отрисовал партитуру за ${LEARN_TIMING.hydrateCap}ms даже после ` +
      `перезагрузки — выделять такты не по чему. Состояние: ${JSON.stringify(state ?? { unavailable: true })}`,
  );
}

/**
 * Выделяет мышью первые отрисованные такты партитуры. Координаты берём из фактических
 * нотных головок VexFlow (`.vf-stavenote.measure-N`), а не из фиксированных пикселей:
 * разметка масштабируется вместе с окном.
 */
async function dragFirstMeasures(page: Page): Promise<void> {
  // Партитура уже подготовлена prepareScoreForSeed — здесь только само выделение.
  // CHANGED: берём фактически отрисованные такты, а не жёстко 1 и 2.
  const rendered = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".vf-stavenote.staff-0")).flatMap((node) =>
      Array.from(node.classList).flatMap((name) => {
        const match = /^measure-(\d+)$/.exec(name);
        return match ? [Number(match[1])] : [];
      }),
    ),
  );
  const [fromMeasure, toMeasure] = pickSeedMeasures(rendered);
  const box = await page.evaluate(
    ({ from, to }) => {
      const noteOf = (measure: number) => {
        const nodes = Array.from(
          document.querySelectorAll<SVGGraphicsElement>(
            `.vf-stavenote.measure-${measure}.staff-0`,
          ),
        );
        const node = nodes[Math.floor(nodes.length / 2)] ?? nodes[0];
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      };
      const start = noteOf(from);
      const end = noteOf(to) ?? start;
      return start && end ? { from: start, to: end } : null;
    },
    { from: fromMeasure, to: toMeasure },
  );
  if (!box) {
    throw new Error(
      `Adaptive: нотные головки такта ${fromMeasure} исчезли между чтением и выделением.`,
    );
  }
  // CHANGED: события мыши идут в самый верхний элемент точки. Проверено вживую: при
  // переходе на пустой Chopped Piano Marvel показывает «An unexpected error has
  // occurred», и её закрытый контейнер продолжает перехватывать мышь над партитурой.
  const blocker = await findPointerBlocker(page, box.from);
  if (blocker) {
    tlog().warn(`точку выделения перекрывает ${blocker} — убираю оверлей`);
    await dismissErrorModal(page);
    await dismissLoadingOverlay(page);
    const stillBlocked = await findPointerBlocker(page, box.from);
    if (stillBlocked) {
      throw new Error(
        `Adaptive: точку выделения такта ${fromMeasure} перекрывает ${stillBlocked} — ` +
          "события мыши не доходят до партитуры.",
      );
    }
  }
  await page.mouse.move(box.from.x, box.from.y);
  await page.mouse.down();
  await page.mouse.move(box.to.x, box.to.y, { steps: 12 });
  await page.mouse.up();
}

async function duplicateChopped(page: Page, pieceId: number): Promise<void> {
  const before = await readSlicingSnapshot(page, pieceId);
  if (before.tabs.MIN.exercises.length > 0) return;
  const button = page.getByText("Duplicate Chopped", { exact: true }).first();
  if (!(await button.count())) {
    throw new Error("На пустой вкладке Minced не найдена кнопка Duplicate Chopped.");
  }
  await button.evaluate((node) => (node as HTMLElement).click());
  await waitForExerciseGrowth(page, pieceId, "MIN", 0);
}

async function splitMissingHands(
  page: Page,
  pieceId: number,
  tab: SlicingTab,
): Promise<void> {
  const before = await readSlicingSnapshot(page, pieceId);
  const selected = missingHandIndexes(before.tabs[tab].exercises);
  if (selected.length === 0) return;

  const multi = page.getByRole("button", { name: "Multi-select" });
  await multi.evaluate((node) => (node as HTMLButtonElement).click());
  const boxes = page.locator(".exercise-checkbox");
  await boxes.first().waitFor({ state: "attached", timeout: 10000 });
  if ((await boxes.count()) !== before.tabs[tab].exercises.length) {
    throw new Error("Количество упражнений и чекбоксов Multi-select не совпало.");
  }
  for (let index = 0; index < (await boxes.count()); index += 1) {
    const shouldSelect = selected.includes(index);
    if ((await boxes.nth(index).isChecked()) !== shouldSelect) {
      await boxes.nth(index).evaluate((node) => (node as HTMLInputElement).click());
    }
  }
  const split = page.locator(".is-bulk-action .dropdown-item").filter({
    hasText: "Split Hands",
  });
  await split.evaluate((node) => (node as HTMLElement).click());
  await waitForExerciseGrowth(page, pieceId, tab, before.tabs[tab].exercises.length);
}

export async function saveCurrentTab(page: Page): Promise<void> {
  const button = page.locator(".save-button");
  if (await button.isDisabled()) {
    await page.waitForFunction(
      () => (document.querySelector(".save-button") as HTMLButtonElement | null)?.disabled === false,
      undefined,
      { timeout: LEARN_TIMING.hydrateCap },
    ).catch(() => undefined);
    if (await button.isDisabled()) {
      throw new Error("Save Learn Mode не активировался после изменения схемы.");
    }
  }
  const responsePromise = page
    .waitForResponse(
      (response) =>
        /api\.pianomarvel\.com.*server-method-162/i.test(response.url()) &&
        response.request().method() === "POST",
      { timeout: LEARN_TIMING.saveTimeout },
    )
    .catch(() => null);
  await button.evaluate((node) => (node as HTMLButtonElement).click());
  const response = await responsePromise;
  if (response) {
    if (!response.ok()) throw new Error(`Save Learn Mode: HTTP ${response.status()}.`);
    return;
  }
  await page.waitForFunction(
    () => (document.querySelector(".save-button") as HTMLButtonElement | null)?.disabled,
    undefined,
    { timeout: LEARN_TIMING.saveTimeout },
  );
}

async function waitForExerciseGrowth(
  page: Page,
  pieceId: number,
  tab: SlicingTab,
  previousCount: number,
  timeout = LEARN_TIMING.growthTimeout,
): Promise<void> {
  await page.waitForFunction(
    ({ id, sortName, count }) => {
      try {
        const tabs = __pmSlicing?.read(id) as Array<{ // CHANGED: фактический ключ кеша
          sortName: string;
          data?: { exercises?: unknown[] };
        }> | null | undefined;
        return (tabs?.find((item) => item.sortName === sortName)?.data?.exercises?.length ?? 0) > count;
      } catch {
        return false;
      }
    },
    { id: String(pieceId), sortName: tab, count: previousCount },
    { timeout },
  );
}

/**
 * Закрывает блокирующую модалку Piano Marvel («An unexpected error has occurred» и т.п.),
 * если она показана. Возвращает true, если модалка была. Триггер завершения — модалка
 * реально исчезла из DOM (state), а не пауза.
 */
export async function dismissErrorModal(page: Page): Promise<boolean> {
  const modal = page.locator("modal-container.show, .modal.show").last();
  if (!(await modal.count())) return false;
  const okButton = modal.getByRole("button", { name: /^(ok|ок|close|закрыть)$/i }).last();
  if (await okButton.count()) {
    await okButton.evaluate((node) => (node as HTMLButtonElement).click());
  } else {
    // Фолбэк: крестик в правом верхнем углу
    const closeIcon = modal.locator("[class*='close'], .btn-close, button:has-text('×')").last();
    if (await closeIcon.count()) {
      await closeIcon.evaluate((node) => (node as HTMLElement).click());
    }
  }
  // CHANGED: завершение — модалка перестала ПЕРЕХВАТЫВАТЬ события, а не просто потеряла
  // класс show. Piano Marvel оставляет закрытый modal-container в DOM вместе с
  // body.modal-open, и он продолжает съедать мышь над партитурой: выделение тактов
  // тогда не доходит до редактора и шаг падал без внятной причины. Окно короткое —
  // это локальная анимация Bootstrap, а не сетевая операция.
  const cleared = await page
    .waitForFunction(
      () =>
        !document.querySelector("modal-container.show, .modal.show") &&
        !document.body.classList.contains("modal-open"),
      undefined,
      { timeout: LEARN_TIMING.localMutationTimeout },
    )
    .then(() => true)
    .catch(() => false);
  if (!cleared) await neutralizeClosedModals(page);
  return true;
}

/**
 * Обезвреживает остатки уже закрытой модалки: перехват мыши снимается, DOM остаётся
 * на месте. Удалять узлы нельзя — их держит Angular; достаточно `pointer-events: none`
 * и снятого `body.modal-open`. Показанные модалки (`.show`) не трогаются: работать
 * поверх живого диалога нельзя.
 */
async function neutralizeClosedModals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stale = Array.from(
      document.querySelectorAll<HTMLElement>(
        "modal-container:not(.show), .modal:not(.show), .modal-backdrop",
      ),
    );
    for (const node of stale) node.style.pointerEvents = "none";
    if (!document.querySelector("modal-container.show, .modal.show")) {
      document.body.classList.remove("modal-open");
    }
  });
}

function needsMoreChopped(snapshot: SlicingSnapshot): boolean {
  const wholeEnd = Math.max(0, ...snapshot.tabs.W.exercises.map((item) => item.endMeasure));
  const combined = snapshot.tabs.C.exercises.filter(
    (item) => !/\s-\s(?:RH|LH)$/i.test(item.title),
  );
  const choppedEnd = Math.max(0, ...combined.map((item) => item.endMeasure));
  return combined.length === 0 || choppedEnd < wholeEnd;
}

function missingHandIndexes(
  exercises: SlicingSnapshot["tabs"]["W"]["exercises"],
): number[] {
  return exercises.flatMap((exercise, index) => {
    if (/\s-\s(?:RH|LH)$/i.test(exercise.title)) return [];
    const sameRange = (candidate: typeof exercise) =>
      candidate.startMeasure === exercise.startMeasure &&
      candidate.endMeasure === exercise.endMeasure &&
      handBaseTitle(candidate.title) === handBaseTitle(exercise.title);
    const right = exercises.some(
      (candidate) => sameRange(candidate) && /\s-\sRH$/i.test(candidate.title),
    );
    const left = exercises.some(
      (candidate) => sameRange(candidate) && /\s-\sLH$/i.test(candidate.title),
    );
    return right && left ? [] : [index];
  });
}

/** Различает Review/Summarize с одинаковыми тактами при повторном Split Hands. */
function handBaseTitle(title: string): string {
  return title
    .trim()
    .replace(/^\d+\.\s*/, "")
    .replace(/\s-\s(?:RH|LH)$/i, "");
}
