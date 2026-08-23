import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { dismissErrorModal } from "./learning-page";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

afterAll(async () => {
  await browser?.close();
});

/**
 * Живое поведение Piano Marvel: при переходе на пустой Chopped показывается модалка
 * «An unexpected error has occurred», а её закрытие снимает только класс `show` —
 * сам `modal-container` остаётся в DOM вместе с `body.modal-open` и продолжает
 * перехватывать события мыши над партитурой.
 */
const PM_MODAL = `
  <div id="score" style="position:fixed;inset:0;background:#eee">партитура</div>
  <modal-container class="modal fade show" style="position:fixed;inset:0">
    <button class="close modal-close">×</button>
    <div>An unexpected error has occurred.</div>
    <button class="btn-ok">OK</button>
  </modal-container>
  <script>
    document.body.classList.add('modal-open');
    for (const button of document.querySelectorAll('modal-container button')) {
      button.addEventListener('click', () => {
        document.querySelector('modal-container').classList.remove('show');
      });
    }
  </script>
`;

test("закрытая модалка Piano Marvel перестаёт перехватывать мышь", async () => {
  const page = await browser.newPage();
  await page.setContent(PM_MODAL);
  const topAt = () =>
    page.evaluate(() => {
      const node = document.elementFromPoint(200, 200);
      return node ? node.tagName.toLowerCase() : "нет";
    });
  expect(await topAt()).toBe("modal-container");

  expect(await dismissErrorModal(page)).toBe(true);

  expect(await topAt()).toBe("div");
  expect(await page.evaluate(() => document.body.classList.contains("modal-open"))).toBe(false);
  await page.close();
});

test("живую модалку не трогаем: она ещё показана", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div id="score" style="position:fixed;inset:0"></div>
    <modal-container class="modal fade show" style="position:fixed;inset:0">
      <div>Что-то важное без кнопок</div>
    </modal-container>
  `);

  await dismissErrorModal(page);

  // Кнопок нет, закрыть нечем — модалка остаётся, и это честный результат:
  // подавлять показанную модалку нельзя, иначе шаг работал бы поверх диалога.
  expect(
    await page.evaluate(() => document.querySelector("modal-container")?.classList.contains("show")),
  ).toBe(true);
  await page.close();
});

test("без модалки вызов ничего не делает", async () => {
  const page = await browser.newPage();
  await page.setContent(`<div id="score">партитура</div>`);

  expect(await dismissErrorModal(page)).toBe(false);

  await page.close();
});
