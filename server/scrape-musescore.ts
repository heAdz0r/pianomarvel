/**
 * CHANGED (new file) — закрывает R5 из PRD (prd-musescore-integration.md §7):
 * селекторы карточек поиска и модалки Download сняты в PRD вручную, но не
 * зафиксированы построчно. Этот инструмент открывает ЖИВЫЕ страницы в
 * залогиненном профиле и печатает, что реально нашлось, — чтобы подтвердить
 * (или поправить) эвристики в server/musescore.ts на настоящей разметке.
 *
 *   bun run scrape:musescore "Interstellar Hans Zimmer"     # разбор поиска
 *   bun run scrape:musescore --score https://musescore.com/user/54797562/scores/9901456
 *
 * Ничего не скачивает и не кликает необратимого: только читает DOM/структуру.
 * Требует один раз выполненного входа на MuseScore (кнопка в UI или bun run login,
 * затем ручной вход на musescore.com в том же окне Chrome).
 */
import { getContext, closeContext } from "./browser";
import { searchMuseScore, isMuseScoreLoggedIn } from "./musescore";

async function inspectSearch(query: string): Promise<void> {
  const context = await getContext();
  const page = await context.newPage();
  try {
    const params = new URLSearchParams({ text: query });
    await page.goto(`https://musescore.com/sheetmusic?${params}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .waitForFunction(() => document.querySelectorAll('a[href*="/scores/"]').length > 0, {
        timeout: 20_000,
      })
      .catch(() => undefined);

    const diag = await page.evaluate(() => ({
      scoreAnchors: document.querySelectorAll('a[href*="/scores/"]').length,
      jsStores: document.querySelectorAll("div.js-store[data-content]").length,
      nextData: !!document.getElementById("__NEXT_DATA__"),
      jsonScripts: document.querySelectorAll('script[type="application/json"]').length,
      sampleHref:
        document.querySelector('a[href*="/scores/"]')?.getAttribute("href") ?? null,
    }));
    console.log("\nДиагностика страницы поиска:");
    console.table(diag);

    // Структура первой карточки результата — по ней правим extractSearchResultsInPage.
    const cardDump = await page.evaluate(() => {
      const article = Array.from(document.querySelectorAll<HTMLElement>("article"))
        .find((candidate) => !/\bofficial\b/i.test(candidate.innerText ?? ""));
      const a = article?.querySelector<HTMLAnchorElement>('a[href*="/scores/"]') ??
        document.querySelector<HTMLAnchorElement>('a[href*="/scores/"]');
      if (!a) return null;
      let card: HTMLElement = a;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        card = card.parentElement;
        const text = (card.innerText ?? "").replace(/\s+/g, " ").trim();
        if (card.querySelector("img") && /views|saves|votes/i.test(text)) break;
      }
      return {
        text: (card.innerText ?? "").replace(/\s+/g, " ").trim(),
        links: Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .map((link) => ({
            text: (link.innerText ?? link.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim(),
            href: link.href,
          }))
          .filter((link, index, all) =>
            link.text && all.findIndex((candidate) => candidate.href === link.href && candidate.text === link.text) === index,
          ),
        html: card.outerHTML.replace(/\s+/g, " ").slice(0, 4000),
      };
    });
    console.log("\nПервая карточка:\n", cardDump ?? "— карточек нет —");
  } finally {
    await page.close().catch(() => undefined);
  }

  console.log(`\nЧто извлёк парсер searchMuseScore("${query}"):`);
  const results = await searchMuseScore(query, { limit: 15 });
  if (!results.length) {
    console.log("  ⚠ ноль результатов — вероятно, разметка изменилась (см. диагностику выше).");
    return;
  }
  for (const r of results) {
    const badges = [
      r.isOfficial ? "★Official" : "",
      r.requiresPro ? "PRO" : "",
      r.difficulty || "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`  [${r.scoreId}] ${r.title} — ${r.arranger || "?"} ${badges}`);
    console.log(`        ${r.url}`);
  }
}

async function inspectScore(scoreUrl: string): Promise<void> {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto(scoreUrl, { waitUntil: "domcontentloaded" });
    // Даём React отрисоваться (ждём любую кнопку).
    await page.waitForSelector("button, a", { timeout: 15_000 }).catch(() => undefined);

    // 1) Все интерактивные элементы с текстом/aria-label — чтобы найти НАСТОЯЩУЮ
    //    надпись кнопки скачивания (она локализована, напр. «Скачать»).
    const controls = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button, a, [role=button]"))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
          aria: el.getAttribute("aria-label") ?? "",
          cls: (el.getAttribute("class") ?? "").slice(0, 60),
        }))
        .filter((c) => c.text || c.aria)
        .filter((c) => /down|скач|pdf|midi|xml|audio|аудио|print|печат/i.test(`${c.text} ${c.aria} ${c.cls}`)),
    );
    console.log("\nКнопки-кандидаты (скачивание/форматы) на странице ноты:");
    for (const c of controls) console.log(`  <${c.tag}> "${c.text}" aria="${c.aria}" class="${c.cls}"`);

    // 2) Пробуем открыть модалку по локализованному имени и снять её содержимое.
    const trigger = page
      .getByRole("button", { name: /download|скачать|下载|télécharger|descargar/i })
      .or(page.locator('button[aria-label*="download" i], [class*="download" i]'))
      .first();
    const hasTrigger = (await trigger.count().catch(() => 0)) > 0;
    console.log(`\nКнопка Download найдена локатором = ${hasTrigger}`);
    if (hasTrigger) {
      await trigger.click({ timeout: 10_000 }).catch(() => undefined);
      await page
        .waitForFunction(() => /pdf|midi|musicxml|audio|аудио/i.test(document.body?.innerText ?? ""), {
          timeout: 10_000,
        })
        .catch(() => undefined);
      const items = await page.evaluate(() =>
        Array.from(document.querySelectorAll("button, a, [role=menuitem], li"))
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
            href: el.getAttribute("href") ?? "",
          }))
          .filter((i) => /pdf|midi|music\s*xml|xml|audio|аудио|mp3|musescore|mscz/i.test(i.text)),
      );
      console.log("Пункты в открытой модалке Download:");
      for (const i of items) console.log(`  <${i.tag}> "${i.text}" ${i.href ? "href=" + i.href : ""}`);
    } else {
      console.log("  → скопируйте блок «Кнопки-кандидаты» выше — по нему поправим DOWNLOAD_TRIGGER_NAME.");
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scoreFlag = args.indexOf("--score");

  if (!(await isMuseScoreLoggedIn())) {
    console.error(
      "Не залогинен на musescore.com. Войдите один раз через UI (кнопка «Войти в MuseScore») " +
        "или откройте musescore.com в окне Chrome из `bun run login` и войдите вручную.",
    );
    await closeContext();
    process.exit(1);
  }

  if (scoreFlag !== -1) {
    const scoreUrl = args[scoreFlag + 1];
    if (!scoreUrl) {
      console.error("Укажите URL: --score https://musescore.com/user/.../scores/...");
      await closeContext();
      process.exit(1);
    }
    await inspectScore(scoreUrl);
  } else {
    const query = args.filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!query) {
      console.error('Укажите запрос: bun run scrape:musescore "Interstellar Hans Zimmer"');
      await closeContext();
      process.exit(1);
    }
    await inspectSearch(query);
  }

  await closeContext();
}

main().catch(async (err) => {
  console.error(err);
  await closeContext().catch(() => undefined);
  process.exit(1);
});
