import { expect, test } from "bun:test";
import { shouldApplyLearningStatus } from "./learning-status";

test("запоздавший UI-статус не затирает более свежий", () => {
  const fresh = "2026-07-20T12:02:00.000Z";
  expect(shouldApplyLearningStatus(undefined, fresh)).toBe(true);
  expect(shouldApplyLearningStatus(fresh, "2026-07-20T12:01:00.000Z")).toBe(false);
  expect(shouldApplyLearningStatus(fresh, fresh)).toBe(true);
  expect(shouldApplyLearningStatus(fresh, "2026-07-20T12:03:00.000Z")).toBe(true);
});
