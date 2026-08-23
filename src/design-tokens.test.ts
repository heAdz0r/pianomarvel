import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Детерминированные гарантии дизайн-системы (docs/design-system-prd.md).
 *
 * Тест читает палитру из CSS и считает контраст сам, без браузера: пары токенов
 * известны заранее, поэтому проверка воспроизводима в CI и падает раньше, чем
 * нечитаемый текст доедет до экрана.
 */

const FOUNDATION = readFileSync(
  join(import.meta.dir, "styles", "foundation.css"),
  "utf8",
);

/** Значения одного селектора: `:root` — светлая тема, `:root[data-theme="dark"]` — тёмная. */
function tokensOf(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = FOUNDATION.match(new RegExp(`^${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"));
  if (!block) throw new Error(`Не найден блок ${selector} в foundation.css`);
  const tokens = new Map<string, string>();
  for (const line of block[1].split("\n")) {
    const declaration = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (declaration) tokens.set(declaration[1], declaration[2].trim());
  }
  return tokens;
}

/** Разворачивает `var(--x)` по цепочке псевдонимов; тема задаёт переопределения. */
function resolve(name: string, theme: Map<string, string>, base: Map<string, string>): string {
  let value = theme.get(name) ?? base.get(name);
  for (let depth = 0; depth < 8 && value?.startsWith("var("); depth += 1) {
    const referenced = value.slice(4, -1).trim();
    value = theme.get(referenced) ?? base.get(referenced);
  }
  if (!value) throw new Error(`Токен ${name} не разрешается в цвет`);
  return value;
}

type Rgb = [number, number, number];

/**
 * Цвет в каналы. Полупрозрачный `rgba()` СМЕШИВАЕТСЯ с подложкой: фоны чипов в
 * тёмной теме заданы прозрачностью поверх поверхности, и мерить контраст к самой
 * прозрачности бессмысленно — пользователь видит результат наложения.
 */
function channels(color: string, under: Rgb = [255, 255, 255]): Rgb {
  const rgba = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(/[,/]/).map((part) => Number.parseFloat(part.trim()));
    const alpha = parts.length > 3 ? parts[3] : 1;
    return [0, 1, 2].map((index) =>
      Math.round(parts[index] * alpha + under[index] * (1 - alpha)),
    ) as Rgb;
  }
  const clean = color.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)) as Rgb;
}

function luminance(color: string, under?: Rgb): number {
  const [r, g, b] = channels(color, under).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string, under?: Rgb): number {
  const [light, dark] = [
    luminance(foreground, under),
    luminance(background, under),
  ].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

const BASE = tokensOf(":root");
const DARK = tokensOf(':root[data-theme="dark"]');
const EMPTY = new Map<string, string>();

const SURFACES = ["--bg-base", "--bg-surface", "--bg-raised"];
/** Уровни текста, которые обязаны читаться как обычный текст: AA = 4.5:1. */
const BODY_TEXT = ["--fg-strong", "--fg", "--fg-muted"];

describe("Палитра: контраст WCAG AA", () => {
  for (const [themeName, theme] of [
    ["светлая", EMPTY],
    ["тёмная", DARK],
  ] as const) {
    for (const surface of SURFACES) {
      for (const text of BODY_TEXT) {
        test(`${themeName}: ${text} на ${surface} >= 4.5:1`, () => {
          const ratio = contrast(resolve(text, theme, BASE), resolve(surface, theme, BASE));
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    test(`${themeName}: семантические цвета читаются на своём фоне`, () => {
      // Прозрачные фоны чипов смешиваются с поверхностью, на которой чип лежит.
      const under = channels(resolve("--bg-surface", theme, BASE));
      for (const state of ["success", "error", "warning"]) {
        const ratio = contrast(
          resolve(`--color-${state}`, theme, BASE),
          resolve(`--color-${state}-bg`, theme, BASE),
          under,
        );
        expect({ state, ratio: Math.round(ratio * 100) / 100 }).toMatchObject({
          state,
          ratio: expect.any(Number),
        });
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test("--fg-subtle годится только для крупного текста: AA Large = 3:1", () => {
    // Осознанно более слабый уровень: он применяется к подписям >= 18.66px/700
    // и к нетекстовым элементам, поэтому обычный порог к нему не предъявляется.
    const ratio = contrast(resolve("--fg-subtle", EMPTY, BASE), resolve("--bg-base", EMPTY, BASE));
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
});

describe("Типографика: пол кегля", () => {
  const STYLE_FILES = [
    ...readdirSync(join(import.meta.dir, "styles"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => join("styles", name)),
    ...readdirSync(join(import.meta.dir, "components"))
      .filter((name) => name.endsWith(".vue"))
      .map((name) => join("components", name)),
    "App.vue",
  ];

  /**
   * Ищет кегли и в `font-size:`, и в шорткате `font:`. Второй важнее: в нём
   * пряталось 81 из 141 объявления мельче 11px, и первичный ценз по `font-size:`
   * их не видел вовсе.
   */
  function tinySizes(source: string): string[] {
    const found: string[] = [];
    for (const match of source.matchAll(/font(?:-size)?:\s*([^;{}]+)[;}]/g)) {
      for (const size of match[1].matchAll(/(?<![\d.])(\d+(?:\.\d+)?)px/g)) {
        // В шорткате `font:` число до `px` — это кегль; в line-height единиц нет.
        if (Number.parseFloat(size[1]) < 11) found.push(match[0].trim());
      }
    }
    return found;
  }

  test("ни одно объявление не задаёт кегль мельче 11px", () => {
    const offenders: Record<string, string[]> = {};
    for (const file of STYLE_FILES) {
      const tiny = tinySizes(readFileSync(join(import.meta.dir, file), "utf8"));
      if (tiny.length > 0) offenders[file] = tiny;
    }
    expect(offenders).toEqual({});
  });

  test("--text-caption и есть этот пол", () => {
    expect(BASE.get("--text-caption")).toBe("11px");
  });

  /**
   * Шкала UI-яруса: 11 / 13 / 15 / 18 / 22, шаг около 1.18. Выбрана «только вверх» —
   * при переезде ни один элемент не уменьшился. Ступени мельче шага не заводить:
   * разница в 1px не читается как уровень иерархии, её место — вес и цвет (M2.1).
   */
  const UI_SCALE = ["--text-caption", "--text-label", "--text-body", "--text-section", "--text-page"];

  test("UI-шкала — ровно пять ступеней, все не ниже пола и не выше 24px", () => {
    const steps = UI_SCALE.map((token) => {
      const value = BASE.get(token);
      expect({ token, value }).toEqual({ token, value: expect.stringMatching(/^\d+px$/) });
      return Number.parseInt(value as string, 10);
    });
    expect(steps).toEqual([11, 13, 15, 18, 22]);
    // Плотный интерфейс: потолок UI-яруса 24px, крупнее — только display (M4.4).
    expect(Math.max(...steps)).toBeLessThanOrEqual(24);
  });

  test("соседние ступени различимы: шаг не меньше 15%", () => {
    const steps = UI_SCALE.map((token) => Number.parseInt(BASE.get(token) as string, 10));
    for (let index = 1; index < steps.length; index += 1) {
      const ratio = steps[index] / steps[index - 1];
      expect({ from: steps[index - 1], to: steps[index], ok: ratio >= 1.15 }).toEqual({
        from: steps[index - 1],
        to: steps[index],
        ok: true,
      });
    }
  });

  test("display-ярус — не больше трёх ступеней", () => {
    const display = [...BASE.keys()].filter((token) => token.startsWith("--display-"));
    expect(display.length).toBeLessThanOrEqual(3);
    for (const token of display) {
      expect({ token, value: BASE.get(token) }).toEqual({
        token,
        value: expect.stringContaining("clamp("),
      });
    }
  });
});

describe("Палитра: единственный источник", () => {
  test("гарнитуры объявлены ровно один раз и только загружаемые", () => {
    const html = readFileSync(join(import.meta.dir, "..", "index.html"), "utf8");
    const loaded = [...html.matchAll(/family=([A-Za-z+]+)/g)].map((m) =>
      m[1].replaceAll("+", " "),
    );
    for (const token of ["--display", "--ui", "--mono"] as const) {
      const declarations = FOUNDATION.split("\n").filter((line) =>
        line.trimStart().startsWith(`${token}:`),
      );
      expect(declarations).toHaveLength(1);
      // Первая гарнитура в стеке обязана реально грузиться, иначе всё уедет в fallback.
      const primary = declarations[0].match(/"([^"]+)"/)?.[1] ?? "(без кавычек)";
      expect(loaded).toContain(primary);
    }
  });

  test("вторая палитра не заводится: :root объявлен только в foundation.css", () => {
    const styles = ["awwwards", "table", "library", "controls", "hero", "motion"];
    for (const name of styles) {
      const css = readFileSync(join(import.meta.dir, "styles", `${name}.css`), "utf8");
      expect({ name, roots: (css.match(/^:root\s*\{/gm) ?? []).length }).toEqual({
        name,
        roots: 0,
      });
    }
  });

  test("тёмная тема переопределяет каждую поверхность и каждый уровень текста", () => {
    for (const token of [...SURFACES, ...BODY_TEXT, "--fg-subtle"]) {
      expect({ token, overridden: DARK.has(token) }).toEqual({ token, overridden: true });
    }
  });
});
