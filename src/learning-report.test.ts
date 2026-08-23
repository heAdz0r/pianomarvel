import { expect, test } from "bun:test";
import { queueFailureResult, sortBulkLearningResults } from "./learning-report";

test("ошибка постановки входит в итог и сортируется раньше замечаний и успехов", () => {
  const failure = queueFailureResult({ id: 7, title: "Не поставилась" }, new Error("HTTP 500"));
  const warning = {
    pieceId: 8,
    title: "С замечанием",
    state: "completed" as const,
    warnings: 1,
    navigationBreaks: 0,
  };
  const success = {
    pieceId: 9,
    title: "Готова",
    state: "completed" as const,
    warnings: 0,
    navigationBreaks: 0,
  };

  expect([success, warning, failure].sort(sortBulkLearningResults)).toEqual([
    failure,
    warning,
    success,
  ]);
  expect(failure.error).toBe("HTTP 500");
});
