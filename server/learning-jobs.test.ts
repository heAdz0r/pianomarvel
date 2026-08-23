import { expect, test } from "bun:test";
import {
  cancelQueuedJobs,
  type LearningJob,
  type LearningJobState,
} from "./learning-jobs";

function job(id: string, state: LearningJobState): LearningJob {
  return {
    id,
    pieceId: Number(id),
    state,
    progress: 0,
    message: "",
    version: 0,
    strategy: "adaptive",
  };
}

test("отмена снимает только queued и не затрагивает running/completed", () => {
  const jobs = [
    job("1", "queued"),
    job("2", "running"),
    job("3", "queued"),
    job("4", "completed"),
  ];
  const cancelled: string[] = [];

  const count = cancelQueuedJobs(jobs, (item) => cancelled.push(item.id));

  expect(count).toBe(2);
  expect(cancelled).toEqual(["1", "3"]);
});
