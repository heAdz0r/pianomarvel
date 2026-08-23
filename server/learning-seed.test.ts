import { expect, test } from "bun:test";
import { isSlicingToolUrl, pickSeedMeasures } from "./learning-page";

test("seed берёт два первых отрисованных такта", () => {
  expect(pickSeedMeasures([1, 2, 3, 4])).toEqual([1, 2]);
});

test("нумерация отрисованных тактов может не начинаться с первого", () => {
  // DOM отдаёт только видимое окно партитуры, и после прокрутки первым может быть
  // любой такт. Диапазон seed'а не важен — план всё равно перезапишет список.
  expect(pickSeedMeasures([17, 18, 19])).toEqual([17, 18]);
});

test("единственный отрисованный такт даёт выделение внутри него", () => {
  expect(pickSeedMeasures([5])).toEqual([5, 5]);
});

test("порядок в DOM не влияет на выбор", () => {
  expect(pickSeedMeasures([9, 3, 7])).toEqual([3, 7]);
});

test("без отрисованных тактов выделять нечего", () => {
  expect(() => pickSeedMeasures([])).toThrow("не отрисован ни один такт");
});

test("страница slicing tool узнаётся по пьесе, а не по подстроке", () => {
  expect(isSlicingToolUrl("https://pianomarvel.com/en/nextgen/slicing_tool/160263", 160263)).toBe(
    true,
  );
  expect(
    isSlicingToolUrl("https://pianomarvel.com/en/nextgen/slicing_tool/160263?x=1#a", 160263),
  ).toBe(true);
});

test("уход на dashboard и чужая пьеса — это не наша страница", () => {
  expect(isSlicingToolUrl("https://pianomarvel.com/en/nextgen/dashboard", 160263)).toBe(false);
  expect(isSlicingToolUrl("https://pianomarvel.com/en/nextgen/slicing_tool/1602", 160263)).toBe(
    false,
  );
  expect(isSlicingToolUrl("about:blank", 160263)).toBe(false);
});
