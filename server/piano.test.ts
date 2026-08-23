import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import {
  attachMusicXmlFile,
  attachSongFiles,
  disableBlankShareFields,
  extractFormError,
  extractPieceId,
  isBlankShareValue,
  scoreEditUrl,
  submitUploadForm,
  uploadResponseAccepted,
  uploadResponseTimeoutMs,
} from "./piano";
import type { MatchedFiles } from "./fileMatcher";

let browser: Browser;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  dir = await mkdtemp(join(tmpdir(), "pianomarvel-upload-"));
});

afterAll(async () => {
  await browser?.close();
  await rm(dir, { recursive: true });
});

describe("назначение файлов форме Piano Marvel", () => {
  test("прикрепляет и проверяет все поддерживаемые категории", async () => {
    const paths = {
      midi: join(dir, "song.mid"),
      xml: join(dir, "song.mxl"),
      audio: join(dir, "song.mp3"),
      pdf: join(dir, "song.pdf"),
      image: join(dir, "cover.jpg"),
    };
    await Promise.all(Object.values(paths).map((path) => writeFile(path, "fixture")));
    const files: MatchedFiles = {
      baseName: "song",
      dir,
      midi: paths.midi,
      xml: paths.xml,
      audio: [paths.audio],
      pdf: paths.pdf,
      image: paths.image,
      extras: [],
      warnings: [],
    };
    const page = await browser.newPage();
    await page.setContent(`
      <input type="file" name="data[Piece][midi_file]">
      <input type="file" name="data[Piece][xml_file]">
      <input type="file" name="data[Piece][audio_file][]" multiple>
      <input type="file" name="data[Piece][pdf_file]">
      <input type="file" name="data[Piece][image_file]">
    `);

    await attachSongFiles(page, files);

    const names = await page.locator('input[type="file"]').evaluateAll((inputs) =>
      inputs.flatMap((input) =>
        Array.from((input as HTMLInputElement).files ?? []).map((file) => file.name),
      ),
    );
    expect(names).toEqual(["song.mid", "song.mxl", "song.mp3", "song.pdf", "cover.jpg"]);
    await page.close();
  });
});

describe("результат сохранения", () => {
  test("распознаёт созданную композицию после канонической навигации", () => {
    expect(extractPieceId("https://pianomarvel.com/uploads/editSong/157783")).toBe("157783");
  });

  test("отправляет форму без зависимости от button[type=submit]", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <input name="data[Piece][title]" value="Clocks">
        <a class="legacy-save">Save</a>
      </form>
      <script>
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          document.body.dataset.submitted = 'yes';
        });
      </script>
    `);

    await submitUploadForm(page, { requirePost: false });

    expect(await page.locator("body").getAttribute("data-submitted")).toBe("yes");
    await page.close();
  });

  test("пустое поле «поделиться» не уходит в POST", async () => {
    // Piano Marvel добавил в форму виджет share. При пустом значении сервер всё равно
    // разбирает его в список из одной пустой записи и отклоняет отправку с
    // «The following users could not be found:».
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <input name="data[Piece][title]" value="Clocks">
        <input type="text" id="share-user-text" value="">
        <textarea name="data[Piece][users-message]"></textarea>
        <input type="text" name="data[Piece][users]" id="share-user-hidden" value=" , ">
      </form>
      <script>
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          document.body.dataset.submitted = [...new FormData(event.target).keys()].join('|');
        });
      </script>
    `);

    await submitUploadForm(page, { requirePost: false });

    expect(await page.locator("body").getAttribute("data-submitted")).toBe(
      "data[Piece][title]",
    );
    await page.close();
  });

  test("скрытые share-поля с пустым value не уходят в POST", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <input name="data[Piece][title]" value="Clocks">
        <input type="hidden" name="data[Piece][users][]" value="">
        <input type="hidden" name="data[Piece][users-token]" value=" ">
      </form>
      <script>
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          document.body.dataset.submitted = [...new FormData(event.target).keys()].join('|');
        });
      </script>
    `);

    await submitUploadForm(page, { requirePost: false });

    expect(await page.locator("body").getAttribute("data-submitted")).toBe(
      "data[Piece][title]",
    );
    await page.close();
  });

  test("disableBlankShareFields очищает value и снимает name", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <input type="text" name="data[Piece][users]" id="share-user-text" value=" , ">
      <input type="hidden" name="data[Piece][users-token]" value="">
    `);

    await disableBlankShareFields(page);

    expect(isBlankShareValue(" , ")).toBe(true);
    expect(
      await page.locator("#share-user-text").evaluate((node) => ({
        value: (node as HTMLInputElement).value,
        name: node.getAttribute("name"),
        disabled: (node as HTMLInputElement).disabled,
      })),
    ).toEqual({ value: "", name: null, disabled: true });
    expect(
      await page.locator('[name="data[Piece][users-token]"]').count(),
    ).toBe(0);
    await page.close();
  });

  test("заполненное поле «поделиться» сохраняется", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <input name="data[Piece][title]" value="Clocks">
        <input type="text" name="data[Piece][users]" id="share-user-hidden" value="teacher1">
      </form>
      <script>
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          document.body.dataset.submitted = [...new FormData(event.target).keys()].join('|');
        });
      </script>
    `);

    await submitUploadForm(page, { requirePost: false });

    expect(await page.locator("body").getAttribute("data-submitted")).toBe(
      "data[Piece][title]|data[Piece][users]",
    );
    await page.close();
  });

  test("строит edit URL только для валидного id существующей композиции", () => {
    expect(scoreEditUrl(157783)).toBe(
      "https://pianomarvel.com/uploads/editSong/157783",
    );
    expect(() => scoreEditUrl(0)).toThrow("Некорректный id");
    expect(() => scoreEditUrl(1.5)).toThrow("Некорректный id");
  });

  test("при обновлении назначает только выбранный MXL и не трогает соседние inputs", async () => {
    const original = join(dir, "original.mxl");
    const fingered = join(dir, "fingered.mxl");
    const midi = join(dir, "song.mid");
    await Promise.all([
      writeFile(original, "original"),
      writeFile(fingered, "fingered"),
      writeFile(midi, "midi"),
    ]);

    const page = await browser.newPage();
    await page.setContent(`
      <input type="file" name="data[Piece][midi_file]">
      <input type="file" name="data[Piece][xml_file]">
    `);
    await page.locator('input[name="data[Piece][midi_file]"]').setInputFiles(midi);

    await attachMusicXmlFile(page, fingered);

    expect(
      await page
        .locator('input[name="data[Piece][xml_file]"]')
        .evaluate((input) => (input as HTMLInputElement).files?.[0]?.name),
    ).toBe("fingered.mxl");
    expect(
      await page
        .locator('input[name="data[Piece][midi_file]"]')
        .evaluate((input) => (input as HTMLInputElement).files?.[0]?.name),
    ).toBe("song.mid");
    await page.close();
  });
});

describe("ответ legacy-формы", () => {
  test("скрытый шаблон share-ошибки не считается ошибкой сохранения", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="alert alert-danger" style="display: none">
        The following users could not be found:
      </div>
    `);

    expect(await extractFormError(page)).toBeUndefined();
    await page.close();
  });

  test("видимая ошибка legacy-формы по-прежнему возвращается", async () => {
    const page = await browser.newPage();
    await page.setContent('<div class="alert alert-danger">At least one genre is required.</div>');

    expect(await extractFormError(page)).toBe("At least one genre is required.");
    await page.close();
  });

  test("редирект после сохранения — это успех, а не отказ", () => {
    // CakePHP отвечает на успешный POST редиректом на страницу композиции. Прежний
    // предикат waitForResponse исключал 3xx, поэтому ответ не перехватывался никогда
    // и каждая загрузка сжигала полный таймаут ожидания.
    expect(uploadResponseAccepted(302)).toBe(true);
    expect(uploadResponseAccepted(303)).toBe(true);
    expect(uploadResponseAccepted(200)).toBe(true);
  });

  test("ошибка валидации и сбой сервера успехом не считаются", () => {
    expect(uploadResponseAccepted(422)).toBe(false);
    expect(uploadResponseAccepted(500)).toBe(false);
  });

  test("таймаут ответа масштабируется от размера вложений", async () => {
    const root = await mkdtemp(join(tmpdir(), "piano-upload-timeout-"));
    const midi = join(root, "song.mid");
    const mp3 = join(root, "song.mp3");
    await writeFile(midi, "x");
    await writeFile(mp3, "x".repeat(10_000_000));
    const small: MatchedFiles = {
      baseName: "song",
      dir: root,
      midi,
      audio: [],
      extras: [],
      warnings: [],
    };
    const large: MatchedFiles = { ...small, audio: [mp3] };
    expect(uploadResponseTimeoutMs(large)).toBeGreaterThan(uploadResponseTimeoutMs(small));
    await rm(root, { recursive: true, force: true });
  });
});
