import { expect, test } from "bun:test";
import { findActiveFetchJob, type MuseScoreFetchJob } from "./musescore-jobs";
import { installMuseScoreWindowOpenGuard } from "./musescore";

function job(scoreUrl: string, state: MuseScoreFetchJob["state"]): MuseScoreFetchJob {
  return {
    id: crypto.randomUUID(),
    scoreUrl,
    state,
    progress: 0,
    message: "",
    version: 0,
  };
}

test("активное скачивание дедуплицируется по score id", () => {
  const active = job("https://musescore.com/user/scores/12345?from=search", "running");
  const completed = job("https://musescore.com/user/scores/12345", "completed");

  expect(
    findActiveFetchJob(
      [completed, active],
      "https://musescore.com/other/scores/12345?share=1",
    )?.id,
  ).toBe(active.id);
});

test("window.open guard ставится на одну страницу, а не общий контекст", async () => {
  let installs = 0;
  const page = {
    addInitScript: async () => {
      installs += 1;
    },
  } as unknown as Parameters<typeof installMuseScoreWindowOpenGuard>[0];

  await installMuseScoreWindowOpenGuard(page);

  expect(installs).toBe(1);
});
