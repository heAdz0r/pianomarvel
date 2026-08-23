import { expect, test } from "bun:test";

import { runBrowserTask } from "./browser-task";

test("аварийный потолок освобождает очередь для следующей задачи", async () => {
  let rejectStuck: (error: Error) => void = () => {};
  let active = 0;
  const stuck = runBrowserTask(
    async () => {
      active += 1;
      try {
        return await new Promise<never>((_, reject) => {
          rejectStuck = reject;
        });
      } finally {
        active -= 1;
      }
    },
    {
      capMs: 20,
      abort: () => rejectStuck(new Error("контекст закрыт")),
    },
  );
  const next = runBrowserTask(async () => {
    expect(active).toBe(0);
    return "next";
  }, { capMs: 20, abort: () => {} });

  await expect(stuck).rejects.toThrow("не завершилась");
  await expect(next).resolves.toBe("next");
});
