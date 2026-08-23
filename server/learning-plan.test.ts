import { describe, expect, test } from "bun:test";
import {
  buildLearningPlan,
  buildReviewChunks,
  calculateTempoProfile,
  inferLearningStrategy,
  isCleanLearningBase,
  matchesTargetLearningMode,
  type SlicingSnapshot,
} from "./learning-plan";

const emptySnapshot: SlicingSnapshot = {
  tabs: {
    W: {
      tempos: [0, 0, 160],
      exercises: [
        { startMeasure: 1, endMeasure: 113, staffs: [true, true], title: "Лесник" },
      ],
    },
    C: { tempos: [0, 0, 100], exercises: [] },
    MIN: { tempos: [0, 0, 100], exercises: [] },
  },
};

describe("план Learn Mode", () => {
  test("рассчитывает профиль 60/80/100", () => {
    expect(calculateTempoProfile(160)).toEqual([96, 128, 160]);
  });

  describe("сброс перед пересозданием", () => {
    test("свежая пьеса уже является чистой базой — сбрасывать нечего", () => {
      expect(isCleanLearningBase(emptySnapshot)).toBe(true);
    });

    test("нулевой диапазон Whole не мешает: Piano Marvel ещё не посчитал такты", () => {
      // Так приходит свежая загрузка. Прежде reset падал на ней с «не найден
      // исходный двуручный Whole exercise», хотя удалять было нечего.
      expect(
        isCleanLearningBase({
          tabs: {
            W: {
              tempos: [100],
              exercises: [
                { startMeasure: 0, endMeasure: 0, staffs: [true, true], title: "Cornfield Chase" },
              ],
            },
            C: { tempos: [], exercises: [] },
            MIN: { tempos: [], exercises: [] },
          },
        }),
      ).toBe(true);
    });

    test("заполненный Chopped требует сброса", () => {
      expect(
        isCleanLearningBase({
          ...emptySnapshot,
          tabs: {
            ...emptySnapshot.tabs,
            C: {
              tempos: [60, 80, 100],
              exercises: [
                { startMeasure: 1, endMeasure: 4, staffs: [true, true], title: "A1 (m. 1-4)" },
              ],
            },
          },
        }),
      ).toBe(false);
    });

    test("несколько Whole или разделённые руки требуют сброса", () => {
      const split: SlicingSnapshot = {
        ...emptySnapshot,
        tabs: {
          ...emptySnapshot.tabs,
          W: {
            tempos: [0, 0, 160],
            exercises: [
              { startMeasure: 1, endMeasure: 113, staffs: [true, true], title: "Лесник" },
              { startMeasure: 1, endMeasure: 113, staffs: [true, false], title: "Лесник - RH" },
            ],
          },
        },
      };
      expect(isCleanLearningBase(split)).toBe(false);
    });

    test("пустой Whole — это не чистая база, а нечего копировать", () => {
      expect(
        isCleanLearningBase({
          tabs: {
            W: { tempos: [], exercises: [] },
            C: { tempos: [], exercises: [] },
            MIN: { tempos: [], exercises: [] },
          },
        }),
      ).toBe(false);
    });
  });

  test("строит полный недеструктивный план для новой схемы", () => {
    const plan = buildLearningPlan(emptySnapshot, 160);

    expect(plan.map((step) => step.type)).toEqual([
      "split-hands",
      "set-tempos",
      "predict-chopped",
      "set-tempos",
      "duplicate-chopped",
      "split-hands",
      "set-tempos",
      "add-chopped-reviews",
    ]);
    expect(plan.map((step) => step.type)).not.toContain("delete");
  });

  test("пересобирает Minced, когда границы Chopped изменились", () => {
    // Такое состояние возникает после смены музыкального алгоритма: Chopped уже
    // заменён новыми границами, а Minced остался копией прежних.
    const stale: SlicingSnapshot = {
      tabs: {
        W: {
          tempos: [96, 128, 160],
          exercises: [
            { startMeasure: 1, endMeasure: 16, staffs: [true, true], title: "Whole" },
            { startMeasure: 1, endMeasure: 16, staffs: [true, false], title: "Whole - RH" },
            { startMeasure: 1, endMeasure: 16, staffs: [false, true], title: "Whole - LH" },
          ],
        },
        C: {
          tempos: [96, 128, 160],
          exercises: [
            { startMeasure: 1, endMeasure: 5, staffs: [true, true], title: "A1 (m. 1-5)" },
            { startMeasure: 6, endMeasure: 16, staffs: [true, true], title: "A2 (m. 6-16)" },
          ],
        },
        MIN: {
          tempos: [96, 128, 160],
          exercises: [
            { startMeasure: 1, endMeasure: 8, staffs: [true, true], title: "A1 (m. 1-8)" },
            { startMeasure: 1, endMeasure: 8, staffs: [true, false], title: "A1 (m. 1-8) - RH" },
            { startMeasure: 1, endMeasure: 8, staffs: [false, true], title: "A1 (m. 1-8) - LH" },
            { startMeasure: 9, endMeasure: 16, staffs: [true, true], title: "A2 (m. 9-16)" },
            { startMeasure: 9, endMeasure: 16, staffs: [true, false], title: "A2 (m. 9-16) - RH" },
            { startMeasure: 9, endMeasure: 16, staffs: [false, true], title: "A2 (m. 9-16) - LH" },
          ],
        },
      },
    };
    const chunks = stale.tabs.C.exercises;

    const plan = buildLearningPlan(stale, 160, { strategy: "adaptive", adaptiveChunks: chunks });

    expect(plan.map((step) => step.type)).toContain("duplicate-chopped");
    expect(
      matchesTargetLearningMode(stale, 160, {
        strategy: "adaptive",
        adaptiveChunks: chunks,
      }),
    ).toBe(false);
  });

  test("ничего не меняет в полностью готовой схеме", () => {
    const hands = [
      { startMeasure: 1, endMeasure: 8, staffs: [true, true], title: "1" },
      { startMeasure: 1, endMeasure: 8, staffs: [true, false], title: "1 - RH" },
      { startMeasure: 1, endMeasure: 8, staffs: [false, true], title: "1 - LH" },
    ];
    const complete: SlicingSnapshot = {
      tabs: {
        W: { tempos: [96, 128, 160], exercises: hands },
        C: { tempos: [96, 128, 160], exercises: [hands[0]] },
        MIN: { tempos: [96, 128, 160], exercises: hands },
      },
    };

    expect(buildLearningPlan(complete, 160)).toEqual([]);
  });

  test("удаляет из Chopped только ошибочные варианты RH/LH", () => {
    const snapshot: SlicingSnapshot = {
      tabs: {
        ...emptySnapshot.tabs,
        C: {
          tempos: [96, 128, 160],
          exercises: [
            { startMeasure: 1, endMeasure: 4, staffs: [true, true], title: "1. (m. 1-4)" },
            { startMeasure: 1, endMeasure: 4, staffs: [true, false], title: "1. (m. 1-4) - RH" },
          ],
        },
      },
    };

    expect(buildLearningPlan(snapshot, 160)).toContainEqual({
      type: "remove-chopped-hands",
      tab: "C",
    });
  });

  test("объединяет каждые четыре полные фразы в обзорный chunk", () => {
    const phrases = Array.from({ length: 8 }, (_, index) => ({
      startMeasure: index * 4 + 1,
      endMeasure: index * 4 + 4,
      staffs: [true, true],
      title: `${index + 1}.`,
    }));

    expect(buildReviewChunks(phrases)).toEqual([
      { startMeasure: 1, endMeasure: 16, title: "Review 1–4 (m. 1-16)" },
      { startMeasure: 17, endMeasure: 32, title: "Review 5–8 (m. 17-32)" },
    ]);
  });

  test("Adaptive заменяет Chopped отдельным MusicXML-планом и не запускает Predict", () => {
    const chunks = [
      { startMeasure: 1, endMeasure: 4, staffs: [true, true], title: "Adaptive 1 (m. 1-4)" },
      { startMeasure: 5, endMeasure: 8, staffs: [true, true], title: "Adaptive 2 (m. 5-8)" },
      { startMeasure: 4, endMeasure: 6, staffs: [true, true], title: "Adaptive Bridge 1→2 (m. 4-6)" },
    ];
    const snapshot: SlicingSnapshot = {
      tabs: {
        W: {
          tempos: [0, 0, 100],
          exercises: [{ startMeasure: 1, endMeasure: 8, staffs: [true, true], title: "Whole" }],
        },
        C: { tempos: [], exercises: [] },
        MIN: { tempos: [], exercises: [] },
      },
    };

    const plan = buildLearningPlan(snapshot, 100, {
      strategy: "adaptive",
      adaptiveChunks: chunks,
    });

    expect(plan.map((step) => step.type)).toContain("replace-chopped-adaptive");
    expect(plan.map((step) => step.type)).not.toContain("predict-chopped");
    expect(plan.map((step) => step.type)).not.toContain("add-chopped-reviews");
  });

  test("Adaptive считается готовым только в своём режиме, Minced является копией с RH/LH", () => {
    const chunks = [
      { startMeasure: 1, endMeasure: 4, staffs: [true, true], title: "Adaptive 1 (m. 1-4)" },
      { startMeasure: 5, endMeasure: 8, staffs: [true, true], title: "Adaptive 2 (m. 5-8)" },
    ];
    const withHands = chunks.flatMap((chunk) => [
      chunk,
      { ...chunk, title: `${chunk.title} - RH`, staffs: [true, false] },
      { ...chunk, title: `${chunk.title} - LH`, staffs: [false, true] },
    ]);
    const whole = { startMeasure: 1, endMeasure: 8, staffs: [true, true], title: "Whole" };
    const snapshot: SlicingSnapshot = {
      tabs: {
        W: {
          tempos: [60, 80, 100],
          exercises: [
            whole,
            { ...whole, title: "Whole - RH", staffs: [true, false] },
            { ...whole, title: "Whole - LH", staffs: [false, true] },
          ],
        },
        C: { tempos: [60, 80, 100], exercises: chunks },
        MIN: { tempos: [60, 80, 100], exercises: withHands },
      },
    };

    expect(matchesTargetLearningMode(snapshot, 100, {
      strategy: "adaptive",
      adaptiveChunks: chunks,
    })).toBe(true);
    expect(matchesTargetLearningMode(snapshot, 100, { strategy: "predict" })).toBe(false);
  });

  test("принимает порядковые префиксы, которые Piano Marvel добавляет после Save и Duplicate", () => {
    const chunks = [
      { startMeasure: 1, endMeasure: 4, staffs: [true, true], title: "A1 (m. 1-4)" },
      { startMeasure: 4, endMeasure: 6, staffs: [true, true], title: "A.Bridge 1-2 (m. 4-6)" },
      { startMeasure: 5, endMeasure: 8, staffs: [true, true], title: "A2 (m. 5-8)" },
      { startMeasure: 1, endMeasure: 8, staffs: [true, true], title: "A.Review 1 (m. 1-8)" },
      { startMeasure: 1, endMeasure: 3, staffs: [true, true], title: "A.Summarize 1/3 (m. 1-3)" },
      { startMeasure: 4, endMeasure: 6, staffs: [true, true], title: "A.Summarize 2/3 (m. 4-6)" },
      { startMeasure: 7, endMeasure: 8, staffs: [true, true], title: "A.Summarize 3/3 (m. 7-8)" },
    ];
    const numberedChopped = chunks.map((chunk, index) => ({
      ...chunk,
      title: `${index + 1}. ${chunk.title}`,
    }));
    const numberedMinced = chunks.flatMap((chunk, index) => {
      const ordinal = index * 3;
      return [
        { ...chunk, title: `${ordinal + 1}. ${chunk.title} - RH`, staffs: [true, false] },
        { ...chunk, title: `${ordinal + 2}. ${chunk.title} - LH`, staffs: [false, true] },
        { ...chunk, title: `${ordinal + 3}. ${chunk.title}` },
      ];
    });
    const whole = { startMeasure: 1, endMeasure: 8, staffs: [true, true], title: "Whole" };
    const snapshot: SlicingSnapshot = {
      tabs: {
        W: {
          tempos: [60, 80, 100],
          exercises: [
            whole,
            { ...whole, title: "Whole - RH", staffs: [true, false] },
            { ...whole, title: "Whole - LH", staffs: [false, true] },
          ],
        },
        C: { tempos: [60, 80, 100], exercises: numberedChopped },
        MIN: { tempos: [60, 80, 100], exercises: numberedMinced },
      },
    };
    const options = { strategy: "adaptive" as const, adaptiveChunks: chunks };

    expect(inferLearningStrategy(snapshot)).toBe("adaptive");
    expect(buildLearningPlan(snapshot, 100, options)).toEqual([]);
    expect(matchesTargetLearningMode(snapshot, 100, options)).toBe(true);
  });

  test("пересобирает Adaptive, если состав совпал, но порядок скрывает поздние chunks", () => {
    const chunks = [
      { startMeasure: 1, endMeasure: 4, staffs: [true, true], title: "A1 (m. 1-4)" },
      { startMeasure: 1, endMeasure: 8, staffs: [true, true], title: "A.Review 1 (m. 1-8)" },
      { startMeasure: 1, endMeasure: 3, staffs: [true, true], title: "A.Summarize 1/3 (m. 1-3)" },
    ];
    const whole = { startMeasure: 1, endMeasure: 8, staffs: [true, true], title: "Whole" };
    const snapshot: SlicingSnapshot = {
      tabs: {
        W: {
          tempos: [60, 80, 100],
          exercises: [
            whole,
            { ...whole, title: "Whole - RH", staffs: [true, false] },
            { ...whole, title: "Whole - LH", staffs: [false, true] },
          ],
        },
        C: {
          tempos: [60, 80, 100],
          exercises: [chunks[0], chunks[2], chunks[1]],
        },
        MIN: { tempos: [60, 80, 100], exercises: [] },
      },
    };

    const plan = buildLearningPlan(snapshot, 100, {
      strategy: "adaptive",
      adaptiveChunks: chunks,
    });

    expect(plan.map((step) => step.type)).toContain("replace-chopped-adaptive");
    expect(matchesTargetLearningMode(snapshot, 100, {
      strategy: "adaptive",
      adaptiveChunks: chunks,
    })).toBe(false);
  });
});
