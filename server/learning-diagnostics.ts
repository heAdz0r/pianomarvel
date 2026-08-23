import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { LEARN_CAPTURE_DIAGNOSTICS, LEARN_DEBUG_DIR } from "./learning-config";
import type { Logger } from "./log";

/**
 * При падении шага снимает контекст страницы: скриншот, URL, состояние Save,
 * счётчики упражнений по вкладкам. Всё пишется в LEARN_DEBUG_DIR и в лог —
 * чтобы понять, на чём именно повис прогон, без повторного воспроизведения.
 */
export async function captureDiagnostics(
  page: Page,
  pieceId: number,
  logger: Logger,
  label: string,
): Promise<void> {
  if (!LEARN_CAPTURE_DIAGNOSTICS) return;
  try {
    await mkdir(LEARN_DEBUG_DIR, { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);
    const base = path.join(LEARN_DEBUG_DIR, `piece-${pieceId}-${safeLabel}-${Date.now()}`);

    const url = page.url();
    const saveDisabled = await page
      .locator(".save-button")
      .isDisabled()
      .catch(() => null);
    const counts = await page
      .evaluate((id) => {
        try {
          // CHANGED: кеш читается по фактическому ключу (__pmSlicing), а не по "slicingData"
          const tabs = __pmSlicing?.read(id) as Array<{
            sortName: string;
            data?: { exercises?: unknown[] };
          }> | null | undefined;
          if (!tabs) return null;
          const result: Record<string, number> = {};
          for (const tab of tabs ?? []) {
            result[tab.sortName] = tab.data?.exercises?.length ?? 0;
          }
          return result;
        } catch {
          return null;
        }
      }, String(pieceId))
      .catch(() => null);

    await page
      .screenshot({ path: `${base}.png`, fullPage: true })
      .catch((error) => logger.warn("screenshot не снят", error));

    logger.error("diagnostics", { screenshot: `${base}.png`, url, saveDisabled, counts });
  } catch (error) {
    logger.warn("не удалось снять диагностику", error);
  }
}
