import type { Page } from "playwright";
import { calculateTempoProfile, type SlicingTab } from "./learning-plan";
import { LEARN_TIMING } from "./learning-config";
import { tlog } from "./log";

const TAB_LABELS: Record<SlicingTab, string> = {
  W: "Whole",
  C: "Chopped",
  MIN: "Minced",
};

interface RawExercise extends Record<string, unknown> {
  exerciseTitle?: string;
  title?: string;
  startMeasure?: number;
  endMeasure?: number;
  startTick?: number;
  endTick?: number;
  start_measure?: number;
  end_measure?: number;
  start_tick?: number;
  end_tick?: number;
  staffs?: boolean[];
}

/**
 * Полностью заменяет Learn Mode целевой базой: один исходный Whole, пустые
 * Chopped/Minced и единый профиль темпов. Дальше обычный planner создаёт схему заново.
 */
export async function resetLearningMode(
  page: Page,
  pieceId: number,
  fastTempo: number,
  report: (progress: number, message: string) => void,
  /** Число тактов из привязанного MusicXML — чинит Whole, у которого PM не посчитал такты. */
  wholeMeasures?: number,
): Promise<void> {
  const logger = tlog();
  const rawWhole = await page.evaluate((id) => {
    // CHANGED: кеш читается по фактическому ключу (__pmSlicing), а не по "slicingData"
    const tabs = __pmSlicing?.read(id) as Array<{
      sortName: string;
      data?: { exercises?: RawExercise[] };
    }> | null | undefined;
    return tabs?.find((tab) => tab.sortName === "W")?.data?.exercises ?? [];
  }, String(pieceId));
  const whole = selectWholeTemplate(rawWhole, wholeMeasures);
  if (!whole) {
    // CHANGED: различаем «Whole вообще нет» и «у Whole не посчитаны такты» — второе
    // Piano Marvel отдаёт как 0-0 и раньше это выглядело как отсутствие упражнения.
    throw new Error(
      rawWhole.length > 0
        ? "Нельзя безопасно пересоздать обучение: у Whole в Piano Marvel не посчитаны такты " +
          `(получено ${rawWhole.length} упр. без корректного диапазона), а число тактов взять негде — ` +
          "для Predict-стратегии MusicXML не привязан. Привяжите XML либо сохраните Whole вручную."
        : "Нельзя безопасно пересоздать обучение: не найден исходный двуручный Whole exercise.",
    );
  }
  if (rawWhole.length > 0 && wholeMeasures && startMeasure(rawWhole[0]) < 1) {
    logger.warn(
      `Whole пришёл без диапазона — восстановил 1-${wholeMeasures} по MusicXML`,
      { exercises: rawWhole.length },
    );
  }

  const tempos = calculateTempoProfile(fastTempo);
  const counts = await page.evaluate((id) => {
    const totals: Record<string, number> = { W: 0, C: 0, MIN: 0 };
    try {
      // CHANGED: кеш читается по фактическому ключу (__pmSlicing)
      const tabs = __pmSlicing?.read(id) as Array<{
        sortName: string;
        data?: { exercises?: unknown[] };
      }> | null | undefined;
      for (const tab of tabs ?? []) {
        if (tab.sortName in totals) totals[tab.sortName] = tab.data?.exercises?.length ?? 0;
      }
    } catch {
    }
    return totals;
  }, String(pieceId));

  const replacements: Array<[SlicingTab, RawExercise[]]> = [
    ["W", [whole]],
    ["C", []],
    ["MIN", []],
  ];
  for (let index = 0; index < replacements.length; index += 1) {
    const [tab, exercises] = replacements[index];
    report(4 + index, `${tab}: очищаю старую схему`);
    // Сохранять вкладку нужно, только если она реально отличается от цели.
    // Пустую C/MIN, которую и так надо сделать пустой, трогать нельзя: Angular не
    // активирует Save без изменений в упражнениях, и dirtyForSave повис бы (empty tab).
    if (exercises.length === 0 && counts[tab] === 0) {
      logger.debug(`${tab} уже пуст — сброс не нужен`);
      continue;
    }
    logger.debug(`сброс вкладки ${tab}: ${counts[tab]} → ${exercises.length}`);
    await selectTab(page, pieceId, tab);
    await replaceCurrentTab(page, exercises, tempos, tab);
  }
}

/**
 * Шаблон Whole для пересоздания схемы.
 *
 * `wholeMeasures` — число тактов из привязанного MusicXML. Оно нужно для пьес, у
 * которых Piano Marvel не посчитал такты и отдаёт все Whole как 0-0 (наблюдалось на
 * живой пьесе: партитура рисуется, а диапазон пустой, причём и после повторной
 * загрузки). Настоящий диапазон всегда важнее: подсказка применяется только когда
 * корректного нет ни у одного упражнения.
 */
export function selectWholeTemplate(
  exercises: RawExercise[],
  wholeMeasures?: number,
): RawExercise | undefined {
  const combined = exercises.filter(
    (exercise) => !/\s-\s(?:RH|LH)$/i.test(exerciseTitle(exercise)),
  );
  const byLength = (left: RawExercise, right: RawExercise) =>
    endMeasure(right) - startMeasure(right) - (endMeasure(left) - startMeasure(left));
  const withRange = combined
    .filter(
      (exercise) =>
        startMeasure(exercise) > 0 && endMeasure(exercise) >= startMeasure(exercise),
    )
    .sort(byLength)[0];
  // CHANGED: диапазон восстанавливается из MusicXML, когда его нет ни у одного Whole.
  const repaired =
    !withRange && wholeMeasures && wholeMeasures > 0 ? combined.sort(byLength)[0] : undefined;
  const source = withRange ?? repaired;
  if (!source) return undefined;
  const start = repaired ? 1 : startMeasure(source);
  const end = repaired ? wholeMeasures! : endMeasure(source);
  return {
    id: null,
    title: exerciseTitle(source) || "Whole",
    start_measure: start,
    end_measure: end,
    start_tick: Number(source.startTick ?? source.start_tick ?? 1),
    end_tick: Number(source.endTick ?? source.end_tick ?? 1),
    staffs:
      Array.isArray(source.staffs) && source.staffs.length >= 2
        ? source.staffs.map(() => true)
        : [true, true],
    index: 0,
    omit_title: false,
  };
}

async function replaceCurrentTab(
  page: Page,
  exercises: RawExercise[],
  tempos: [number, number, number],
  tab: SlicingTab,
): Promise<void> {
  let routed = false;
  await page.route(/server-method-162/, async (route) => {
    if (routed) return route.continue();
    routed = true;
    const body = JSON.parse(route.request().postData() ?? "{}");
    body.data.piece_slicing_tempos = tempos;
    body.data.exercises = exercises;
    await route.continue({ postData: JSON.stringify(body) });
  });
  try {
    // Реальный сброс работает только через сетевой POST, который Angular отправляет
    // ЛИШЬ если форма «грязная». Форс-клик по чистой кнопке POST не порождает —
    // именно поэтому сброс Chopped падал. Делаем форму dirty честным изменением поля.
    await dirtyForSave(page);
    await commitSave(page, `Сброс ${TAB_LABELS[tab]}`);
  } finally {
    await page.unroute(/server-method-162/);
  }
}

/**
 * Делает МОДЕЛЬ формы «грязной» честным изменением поля темпа, чтобы Angular отправил
 * server-method-162 при последующем force-клике Save (иначе перехватывать нечего).
 * Триггер готовности — поле фактически приняло новое значение. ВАЖНО: НЕ ждём
 * активации кнопки Save — на заполненных вкладках смена темпа не переключает
 * disabled, хотя модель уже dirty (проверено скриншотами piece 119318).
 * Реальное значение темпа неважно: перехват всё равно подменит piece_slicing_tempos.
 */
async function dirtyForSave(page: Page): Promise<void> {
  const tempo = page.locator(".edit-tempo-number").last();
  if (!(await tempo.count())) {
    throw new Error("Не найдено поле темпа — нечем активировать кнопку Save для сброса.");
  }
  const current = Number(await tempo.inputValue());
  const nudged = Number.isFinite(current) && current > 10 ? current - 1 : 60;
  await tempo.click({ force: true });
  await tempo.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await tempo.type(String(nudged));
  await tempo.press("Tab");
  await page.waitForFunction(
    (expected) => {
      const inputs = document.querySelectorAll<HTMLInputElement>(".edit-tempo-number");
      return Number(inputs[inputs.length - 1]?.value) === expected;
    },
    nudged,
    { timeout: LEARN_TIMING.navTimeout },
  );
}

async function selectTab(page: Page, pieceId: number, tab: SlicingTab): Promise<void> {
  const target = page.locator(".slicing").filter({ hasText: TAB_LABELS[tab] }).first();
  if (!(await target.count())) throw new Error(`Не найдена вкладка ${TAB_LABELS[tab]}.`);
  if (!(await target.evaluate((node) => node.classList.contains("active")))) {
    await target.evaluate((node) => (node as HTMLElement).click());
  }
  await page.waitForFunction(
    ({ id, label, sortName }) => {
      const active = Array.from(document.querySelectorAll(".slicing.active")).some((node) =>
        node.textContent?.includes(label),
      );
      if (!active || !document.querySelector(".save-button")) return false;
      try {
        // CHANGED: кеш читается по фактическому ключу (__pmSlicing)
        const piece = __pmSlicing?.read(id) as Array<{
          sortName: string;
          data?: { exercises?: unknown[] };
        }> | null | undefined;
        if (!piece) return false;
        const expected = piece.find((item) => item.sortName === sortName)?.data?.exercises?.length ?? 0;
        const rendered = document.querySelectorAll(".exercise").length;
        // Точное равенство недостижимо на длинном списке: Piano Marvel отрисовывает
        // его окном, а на 156 упражнений даже полная отрисовка не успевала в потолок.
        // Готовность вкладки — соответствие «пусто/непусто» между хранилищем и списком.
        return expected === 0 ? rendered === 0 : rendered > 0;
      } catch {
        return false;
      }
    },
    { id: String(pieceId), label: TAB_LABELS[tab], sortName: tab },
    { timeout: LEARN_TIMING.navTimeout },
  );
}

/**
 * Сохранение по сетевому событию: force-click Save → ждём ответ server-method-162.
 * dirtyForSave перед этим гарантирует dirty-модель, поэтому POST обязан уйти.
 * Force-click обязателен: на заполненных вкладках кнопка может оставаться disabled
 * даже при dirty-модели (проверено скриншотами piece 119318) — обычный клик = no-op.
 * По той же причине НЕЛЬЗЯ использовать «Save снова disabled» как триггер no-op:
 * кнопка disabled и до клика, такой триггер срабатывал бы ложно и мгновенно.
 * Тайм-аут — аварийный потолок, не механизм ожидания.
 */
async function commitSave(page: Page, label: string): Promise<void> {
  const logger = tlog();
  const responsePromise = page.waitForResponse(
    (response) =>
      /api\.pianomarvel\.com.*server-method-162/i.test(response.url()) &&
      response.request().method() === "POST",
    { timeout: LEARN_TIMING.saveTimeout },
  );
  await page.locator(".save-button").evaluate((node) => {
    const button = node as HTMLButtonElement;
    button.disabled = false;
    button.click();
  });
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`${label}: HTTP ${response.status()}.`);
  logger.debug(`${label}: подтверждено ответом сервера`);
}

function exerciseTitle(exercise: RawExercise): string {
  return String(exercise.exerciseTitle ?? exercise.title ?? "").trim();
}

function startMeasure(exercise: RawExercise): number {
  return Number(exercise.startMeasure ?? exercise.start_measure ?? 0);
}

function endMeasure(exercise: RawExercise): number {
  return Number(exercise.endMeasure ?? exercise.end_measure ?? 0);
}

/** Удаляет из Chopped только ошибочные варианты с суффиксами RH/LH. */
export async function removeChoppedHandExercises(
  page: Page,
  pieceId: number,
): Promise<void> {
  const logger = tlog();
  const titles = await page.evaluate((id) => {
    // CHANGED: кеш читается по фактическому ключу (__pmSlicing)
    const tabs = __pmSlicing?.read(id) as Array<{
      sortName: string;
      data?: { exercises?: Array<{ exerciseTitle?: string; title?: string }> };
    }> | null | undefined;
    return (tabs?.find((tab) => tab.sortName === "C")?.data?.exercises ?? []).map(
      (exercise) => exercise.exerciseTitle ?? exercise.title ?? "",
    );
  }, String(pieceId));
  const selected = titles.flatMap((title, index) =>
    /\s-\s(?:RH|LH)$/i.test(title) ? [index] : [],
  );
  if (selected.length === 0) return;
  logger.debug(`Chopped: удаляю ${selected.length} RH/LH из ${titles.length}`);

  await page
    .getByRole("button", { name: "Multi-select" })
    .evaluate((node) => (node as HTMLButtonElement).click());
  const boxes = page.locator(".exercise-checkbox");
  await boxes.first().waitFor({ state: "attached", timeout: LEARN_TIMING.navTimeout });
  if ((await boxes.count()) !== titles.length) {
    throw new Error("Количество Chopped-упражнений и чекбоксов не совпало.");
  }
  for (let index = 0; index < titles.length; index += 1) {
    const shouldSelect = selected.includes(index);
    if ((await boxes.nth(index).isChecked()) !== shouldSelect) {
      await boxes.nth(index).evaluate((node) => (node as HTMLInputElement).click());
    }
  }

  const remove = page.locator(".is-bulk-action .dropdown-item").filter({
    hasText: "Delete",
  });
  await remove.evaluate((node) => (node as HTMLElement).click());
  const modal = page.locator("modal-container.show, .modal.show").last();
  if (await modal.count()) {
    const confirm = modal.getByRole("button", { name: /delete|yes|ok/i }).last();
    if (!(await confirm.count())) {
      throw new Error("Не найдена кнопка подтверждения удаления Chopped RH/LH.");
    }
    await confirm.evaluate((node) => (node as HTMLButtonElement).click());
  }
  await page.waitForFunction(
    (count) => document.querySelectorAll(".exercise").length < count,
    titles.length,
    { timeout: LEARN_TIMING.growthTimeout },
  );
  await commitSave(page, "Chopped (удаление RH/LH)");
}
