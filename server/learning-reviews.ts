import type { Page } from "playwright";
import { LEARN_TIMING } from "./learning-config";

interface RawExercise {
  id?: number | null;
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

interface ReviewExercise {
  title: string;
  start_measure: number;
  end_measure: number;
  start_tick: number;
  end_tick: number;
  staffs: boolean[];
}

/** Добавляет в Chopped обзорные диапазоны после каждой четвёрки базовых фраз. */
export async function addChoppedReviews(
  page: Page,
  pieceId: number,
  tempos: [number, number, number],
): Promise<void> {
  const exercises = await readChoppedExercises(page, pieceId);
  const base = exercises
    .filter((exercise) => {
      const title = exercise.exerciseTitle ?? exercise.title ?? "";
      return !/\s-\s(?:RH|LH)$/i.test(title) && !/^Review\b/i.test(title);
    })
    .sort((a, b) => startMeasure(a) - startMeasure(b));
  const reviews: ReviewExercise[] = [];
  for (let index = 0; index + 3 < base.length; index += 4) {
    const first = base[index];
    const last = base[index + 3];
    const start = startMeasure(first);
    const end = endMeasure(last);
    if (
      exercises.some(
        (exercise) =>
          /^Review\b/i.test(exercise.exerciseTitle ?? exercise.title ?? "") &&
          startMeasure(exercise) === start &&
          endMeasure(exercise) === end,
      )
    ) continue;
    reviews.push({
      title: `Review ${index + 1}–${index + 4} (m. ${start}-${end})`,
      start_measure: start,
      end_measure: end,
      start_tick: startTick(first),
      end_tick: endTick(last),
      staffs: first.staffs ?? [true, true],
    });
  }
  if (reviews.length === 0) return;

  await makeSaveDirty(page, tempos[2]);
  let routed = false;
  await page.route(/server-method-162/, async (route) => {
    if (routed) return route.continue();
    routed = true;
    const body = JSON.parse(route.request().postData() ?? "{}");
    const current = body.data.exercises as Array<Record<string, unknown>>;
    body.data.piece_slicing_tempos = tempos;
    body.data.exercises = [
      ...current,
      ...reviews.map((review, offset) => ({
        id: null,
        ...review,
        index: current.length + offset,
        omit_title: false,
      })),
    ];
    await route.continue({ postData: JSON.stringify(body) });
  });
  try {
    const responsePromise = page.waitForResponse(
      (response) =>
        /api\.pianomarvel\.com.*server-method-162/i.test(response.url()) &&
        response.request().method() === "POST",
      { timeout: LEARN_TIMING.saveTimeout },
    );
    // force-click: снимаем disabled и кликаем, как в рабочем set-tempos. Модель уже dirty
    // от смены темпа, поэтому Angular отправит server-method-162 → перехват добавит reviews.
    await page.locator(".save-button").evaluate((node) => {
      const button = node as HTMLButtonElement;
      button.disabled = false;
      button.click();
    });
    const response = await responsePromise;
    if (!response.ok()) throw new Error(`Save Chopped Review: HTTP ${response.status()}.`);
  } finally {
    await page.unroute(/server-method-162/);
  }
}

async function readChoppedExercises(page: Page, pieceId: number): Promise<RawExercise[]> {
  return page.evaluate((id) => {
    // CHANGED: кеш читается по фактическому ключу (__pmSlicing), а не по "slicingData"
    const tabs = __pmSlicing?.read(id) as Array<{
      sortName: string;
      data?: { exercises?: RawExercise[] };
    }> | null | undefined;
    return tabs?.find((tab) => tab.sortName === "C")?.data?.exercises ?? [];
  }, String(pieceId));
}

async function makeSaveDirty(page: Page, fastTempo: number): Promise<void> {
  const input = page.locator(".edit-tempo-number").last();
  const current = Number(await input.inputValue());
  // Гарантированно ДРУГОЕ значение, чтобы модель формы стала dirty. На Chopped смена
  // темпа не всегда переключает disabled у Save, поэтому ждём только факт принятого
  // значения (state-триггер), а сам POST дальше вызываем force-кликом — как рабочий set-tempos.
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

function startMeasure(exercise: RawExercise): number {
  return Number(exercise.startMeasure ?? exercise.start_measure ?? 0);
}

function endMeasure(exercise: RawExercise): number {
  return Number(exercise.endMeasure ?? exercise.end_measure ?? 0);
}

function startTick(exercise: RawExercise): number {
  return Number(exercise.startTick ?? exercise.start_tick ?? 1);
}

function endTick(exercise: RawExercise): number {
  return Number(exercise.endTick ?? exercise.end_tick ?? 1);
}
