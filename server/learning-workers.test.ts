import { expect, test } from "bun:test";
import {
  shouldRefreshStorageState,
  withoutSlicingData,
} from "./learning-workers";

test("worker storageState не наследует slicingData", () => {
  const cleaned = withoutSlicingData({
    cookies: [],
    origins: [{
      origin: "https://pianomarvel.com",
      localStorage: [
        { name: "slicingData", value: "{\"42\":{}}" },
        { name: "session", value: "kept" },
      ],
    }],
  });

  expect(cleaned.origins[0].localStorage).toEqual([
    { name: "session", value: "kept" },
  ]);
});

test("storageState обновляется только перед новой волной или после потери worker", () => {
  const base = {
    hasStorageState: true,
    storageStateAt: Date.now(),
    concurrency: 3,
    workerConnected: true,
  };

  expect(shouldRefreshStorageState({ ...base, queueRunning: 0, queueQueued: 0 })).toBe(true);
  expect(shouldRefreshStorageState({ ...base, queueRunning: 1, queueQueued: 2 })).toBe(false);
  expect(
    shouldRefreshStorageState({
      ...base,
      queueRunning: 1,
      queueQueued: 0,
      workerConnected: false,
    }),
  ).toBe(true);
});
