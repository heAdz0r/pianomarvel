import { expect, test } from "bun:test";
import {
  DEFAULT_GENRE,
  GENRES,
  pickFallbackGenreValue,
  resolveGenreValues,
} from "./genres";

test("известные жанры превращаются в option value", () => {
  expect(resolveGenreValues(["Classical", "Pop"])).toEqual(["1", "12"]);
});

test("пустой список жанров даёт дефолтный — форма требует хотя бы один", () => {
  expect(resolveGenreValues([])).toEqual([String(GENRES[DEFAULT_GENRE])]);
});

test("нераспознанные названия не оставляют форму без жанра", () => {
  expect(resolveGenreValues(["Неизвестный жанр"])).toEqual([String(GENRES[DEFAULT_GENRE])]);
});

test("частично распознанный список отдаёт только известные значения", () => {
  expect(resolveGenreValues(["Неизвестный жанр", "Folk"])).toEqual(["20"]);
});

test("фолбэк по живой форме берёт первый настоящий вариант", () => {
  expect(
    pickFallbackGenreValue([
      { value: "", label: "-- Select --" },
      { value: "0", label: "None" },
      { value: "15", label: "Contemporary" },
    ]),
  ).toBe("15");
});

test("фолбэк по живой форме отдаёт null, когда выбирать нечего", () => {
  expect(pickFallbackGenreValue([{ value: "", label: "-- Select --" }])).toBeNull();
});
