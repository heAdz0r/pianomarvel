import { describe, expect, test } from "bun:test";
import { summarizeStatus, type AdaptivePlanSummary } from "./learning-mode";
import type { SlicingExercise, SlicingSnapshot } from "./learning-plan";

const tempos = [60, 80, 100];

function exercise(title: string, startMeasure = 1, endMeasure = 8): SlicingExercise {
  return { title, startMeasure, endMeasure, staffs: [true, true] };
}

function emptySnapshot(): SlicingSnapshot {
  return {
    tabs: {
      W: { tempos: [], exercises: [] },
      C: { tempos: [], exercises: [] },
      MIN: { tempos: [], exercises: [] },
    },
  };
}

describe("классификация обучающего режима", () => {
  test("missing — когда упражнений нет", () => {
    const status = summarizeStatus(1, emptySnapshot(), 100);

    expect(status.complete).toBe(false);
    expect(status.hasLearning).toBe(false);
    expect(status.classification).toBe("missing");
  });

  test("warning — когда обучение существует, но схема неполная", () => {
    const snapshot = emptySnapshot();
    snapshot.tabs.W.exercises = [exercise("Whole")];
    snapshot.tabs.C.exercises = [exercise("Phrase 1")];

    const status = summarizeStatus(2, snapshot, 100);

    expect(status.complete).toBe(false);
    expect(status.hasLearning).toBe(true);
    expect(status.classification).toBe("warning");
  });

  test("ok — когда схема полностью соответствует алгоритму", () => {
    const whole = exercise("Whole");
    const minced = exercise("Minced");
    const snapshot: SlicingSnapshot = {
      tabs: {
        W: {
          tempos,
          exercises: [whole, exercise("Whole - RH"), exercise("Whole - LH")],
        },
        C: { tempos, exercises: [exercise("Phrase 1")] },
        MIN: {
          tempos,
          exercises: [minced, exercise("Minced - RH"), exercise("Minced - LH")],
        },
      },
    };

    const status = summarizeStatus(3, snapshot, 100);

    expect(status.complete).toBe(true);
    expect(status.hasLearning).toBe(true);
    expect(status.classification).toBe("ok");
  });

  test("warning — когда базовые шаги есть, но остались лишние упражнения", () => {
    const whole = exercise("Whole");
    const minced = exercise("Minced");
    const snapshot: SlicingSnapshot = {
      tabs: {
        W: {
          tempos,
          exercises: [
            whole,
            exercise("Whole - RH"),
            exercise("Whole - LH"),
            exercise("Old duplicate"),
          ],
        },
        C: { tempos, exercises: [exercise("Phrase 1")] },
        MIN: {
          tempos,
          exercises: [minced, exercise("Minced - RH"), exercise("Minced - LH")],
        },
      },
    };

    const status = summarizeStatus(4, snapshot, 100);

    expect(status.complete).toBe(false);
    expect(status.classification).toBe("warning");
  });

  test("Adaptive-сводка без профилей тактов доходит до статуса", () => {
    const adaptive: AdaptivePlanSummary = {
      phrases: [{ start: 1, end: 4, title: "A1" }],
      bridges: 1,
      reviews: 1,
      summaries: 3,
      hypermeter: { period: 4, phase: 0, confidence: 0.8 },
      sections: [{ start: 1, end: 8, label: "A" }],
      quality: {
        closureRate: 1,
        hypermeterAlignment: 1,
        sectionRecall: 1,
        durationCv: 0,
        forcedCutRate: 0,
        navigationBreaks: 0,
      },
      warnings: [],
      boundaryReasons: { 4: ["каденция PAC"] },
    };

    const status = summarizeStatus(5, emptySnapshot(), 100, {
      strategy: "adaptive",
      adaptiveSummary: adaptive,
    });

    expect(status.adaptive?.phrases).toHaveLength(1);
    expect(status.adaptive?.quality.closureRate).toBe(1);
    expect(status.adaptive?.boundaryReasons[4]).toEqual(["каденция PAC"]);
  });
});
