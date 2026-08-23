import { expect, test } from "bun:test";
import { resolvePendingTitles } from "./learning-page";

test("DOM-проверка получает только ещё не найденные упражнения", async () => {
  const calls: string[][] = [];
  const missing = await resolvePendingTitles(["A1", "A2", "A3"], async (pending) => {
    calls.push(pending);
    if (pending.includes("A1")) return ["A1"];
    if (pending.includes("A2")) return ["A2"];
    return [];
  });

  expect(calls).toEqual([
    ["A1", "A2", "A3"],
    ["A2", "A3"],
    ["A3"],
  ]);
  expect(missing).toEqual(["A3"]);
});
