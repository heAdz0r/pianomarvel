import type { Page } from "playwright";
import type { SlicingExercise } from "./learning-plan";
import { LEARN_TIMING } from "./learning-config";

interface RawAdaptiveExercise {
  id: null;
  title: string;
  start_measure: number;
  end_measure: number;
  start_tick: number;
  end_tick: number;
  staffs: boolean[];
  index: number;
  omit_title: false;
}

/**
 * Заменяет содержимое активной Chopped-вкладки рассчитанными MusicXML chunks.
 * Сохранение подтверждается реальным POST server-method-162; таймаут — только
 * аварийный потолок, штатное продолжение запускает сетевое событие.
 */
export async function replaceChoppedWithAdaptivePlan(
  page: Page,
  chunks: SlicingExercise[],
  tempos: [number, number, number],
): Promise<void> {
  if (chunks.length === 0) throw new Error("Adaptive не создал ни одного Chopped-фрагмента.");
  await makeSaveDirty(page, tempos[2]);

  // CHANGED (дебаг-фикс timeout): ошибку внедрения плана НЕ бросаем внутри route —
  // иначе запрос повисает и наружу летит опаковый «waitForResponse: Timeout 30000ms».
  // Копим её и всё равно продолжаем запрос, чтобы поймать ответ/состояние.
  // Холдер-объект (а не let): TS не сужает его свойство к never, т.к. присваивание
  // происходит внутри асинхронного колбэка route, невидимого для CFA снаружи.
  let routed = false;
  const capture: { error: Error | null } = { error: null };
  await page.route(/server-method-162/, async (route) => {
    if (routed) return route.continue();
    routed = true;
    try {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (!body.data) throw new Error("POST сохранения не содержит data");
      // Длину staffs берём из фактического запроса страницы: в живом Save их 8, а не 2,
      // и это свойство пьесы, а не наша константа.
      const existing = Array.isArray(body.data.exercises) ? body.data.exercises : [];
      const staffTemplate = existing
        .map((item: { staffs?: unknown }) => item?.staffs)
        .find((staffs: unknown): staffs is boolean[] => Array.isArray(staffs) && staffs.length > 0);
      body.data.piece_slicing_tempos = tempos;
      body.data.exercises = chunks.map((chunk, index) =>
        toRawExercise(chunk, index, staffTemplate),
      );
      await route.continue({ postData: JSON.stringify(body) });
    } catch (error) {
      capture.error = error instanceof Error ? error : new Error(String(error));
      await route.continue().catch(() => undefined);
    }
  });

  try {
    // Ответ ждём как аварийный потолок; при непопадании — подтверждаем сохранение
    // фактическим состоянием кнопки (событие/состояние, а не magic-пауза).
    const responsePromise = page
      .waitForResponse(
        (response) =>
          /api\.pianomarvel\.com.*server-method-162/i.test(response.url()) &&
          response.request().method() === "POST",
        { timeout: LEARN_TIMING.saveTimeout },
      )
      .catch(() => null);
    await page.locator(".save-button").evaluate((node) => {
      const button = node as HTMLButtonElement;
      button.disabled = false;
      button.click();
    });
    const response = await responsePromise;

    if (capture.error) {
      throw new Error(`Adaptive: не удалось внедрить Chopped-план в сохранение — ${capture.error.message}.`);
    }
    if (response) {
      if (!response.ok()) throw new Error(`Save Adaptive Chopped: HTTP ${response.status()}.`);
      return;
    }
    // Ответ не пойман (URL/метод мог отличаться) — сохранение считаем успешным,
    // только если форма реально стала чистой (save-button снова disabled).
    const saved = await page
      .waitForFunction(
        () =>
          (document.querySelector(".save-button") as HTMLButtonElement | null)?.disabled === true,
        undefined,
        { timeout: LEARN_TIMING.saveTimeout },
      )
      .then(() => true)
      .catch(() => false);
    if (!saved) {
      throw new Error(
        "Adaptive: сохранение Chopped не подтвердилось — POST server-method-162 не отправлен за отведённое время. " +
          "Вероятные причины: слетела сессия Piano Marvel, кнопка Save не активировалась, либо изменился слайсинг-редактор PM.",
      );
    }
  } finally {
    await page.unroute(/server-method-162/);
  }
}

function toRawExercise(
  exercise: SlicingExercise,
  index: number,
  staffTemplate?: boolean[],
): RawAdaptiveExercise {
  const staffs = exercise.staffs.length
    ? exercise.staffs
    : staffTemplate ?? [true, true];
  return {
    id: null,
    title: exercise.title,
    start_measure: exercise.startMeasure,
    end_measure: exercise.endMeasure,
    // tick — индекс нотной позиции ВНУТРИ такта: 1 = начало такта, end_tick =
    // последняя позиция конечного такта (посчитана из MusicXML в adaptive-learning).
    // Прежние жёсткие 1/1 обрезали фрагмент по первой же позиции конечного такта.
    start_tick: exercise.startTick ?? 1,
    end_tick: exercise.endTick ?? 1,
    staffs,
    index,
    omit_title: false,
  };
}

async function makeSaveDirty(page: Page, fastTempo: number): Promise<void> {
  const input = page.locator(".edit-tempo-number").last();
  if (!(await input.count())) throw new Error("Adaptive: не найдено поле темпа Chopped.");
  const current = Number(await input.inputValue());
  const base = Number.isFinite(current) && current > 10 ? current : Math.max(11, fastTempo);
  const dirty = base > 10 ? base - 1 : base + 1;
  await input.click({ force: true });
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await input.type(String(dirty));
  await input.press("Tab");
  await page.waitForFunction(
    (expected) => {
      const inputs = document.querySelectorAll<HTMLInputElement>(".edit-tempo-number");
      return Number(inputs[inputs.length - 1]?.value) === expected;
    },
    dirty,
    { timeout: LEARN_TIMING.navTimeout },
  );
}
