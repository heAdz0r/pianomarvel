import { describe, expect, test } from "bun:test";
import { ConcurrentLaneQueue } from "./concurrent-lane-queue";

describe("ConcurrentLaneQueue", () => {
  test("не запускает больше одной задачи на lane и сохраняет очередь", async () => {
    const queue = new ConcurrentLaneQueue(3);
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const gates = Array.from({ length: 5 }, deferred);
    const began = Array.from({ length: 5 }, deferred);
    const started: Array<{ task: number; lane: number }> = [];
    const tasks = Array.from({ length: 5 }, (_, task) =>
      queue.run(async (lane) => {
        started.push({ task, lane });
        began[task].resolve();
        await gates[task].promise;
        return task;
      }),
    );

    await Promise.all(began.slice(0, 3).map((item) => item.promise));
    expect(started).toEqual([
      { task: 0, lane: 0 },
      { task: 1, lane: 1 },
      { task: 2, lane: 2 },
    ]);
    expect(queue.running).toBe(3);
    expect(queue.queued).toBe(2);

    gates[1].resolve();
    await began[3].promise;
    expect(started[3]).toEqual({ task: 3, lane: 1 });

    gates.forEach((gate) => gate.resolve());
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4]);
  });
});
