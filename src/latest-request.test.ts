import { describe, expect, test } from "bun:test";
import { LatestRequest } from "./latest-request";

describe("LatestRequest", () => {
  test("новый запуск отменяет предыдущий и делает его stale", () => {
    const guard = new LatestRequest();
    const first = guard.begin();
    const second = guard.begin();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  test("cancel инвалидирует текущий запуск", () => {
    const guard = new LatestRequest();
    const run = guard.begin();

    guard.cancel();

    expect(run.signal.aborted).toBe(true);
    expect(run.isCurrent()).toBe(false);
  });
});
