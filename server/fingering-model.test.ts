import { describe, expect, test } from "bun:test";
import {
  FOUR_FINGER_PENALTY,
  blackKeyCosts,
  isBlackKey,
  maxComf,
  maxPrac,
  maxRel,
  minComf,
  minPrac,
  minRel,
  positionChangeCosts,
  spanCosts,
  spanTables,
  stretchCost,
  threeFourFiveCost,
  thumbPassingCost,
  transitionParts,
  weigh,
  type Finger,
  type Key,
} from "./fingering-model";

const tables = spanTables();

function key(midi: number): Key {
  return { midi, black: isBlackKey(midi) };
}

const C4 = key(60);
const D4 = key(62);
const E4 = key(64);
const G4 = key(67);
const B4 = key(71);
const C5 = key(72);

describe("таблицы растяжений (Parncutt 1997, Table 1)", () => {
  test("значения таблицы 1 для пар с большим пальцем", () => {
    expect([minPrac(tables, 1, 2), minComf(tables, 1, 2), minRel(tables, 1, 2)]).toEqual([-5, -3, 1]);
    expect([maxRel(tables, 1, 2), maxComf(tables, 1, 2), maxPrac(tables, 1, 2)]).toEqual([5, 8, 10]);
    expect([minPrac(tables, 1, 5), minComf(tables, 1, 5), minRel(tables, 1, 5)]).toEqual([-1, 1, 7]);
    expect([maxRel(tables, 1, 5), maxComf(tables, 1, 5), maxPrac(tables, 1, 5)]).toEqual([10, 13, 15]);
  });

  test("значения таблицы 1 для пар без большого пальца", () => {
    expect([minPrac(tables, 3, 4), maxRel(tables, 3, 4), maxComf(tables, 3, 4), maxPrac(tables, 3, 4)])
      .toEqual([1, 2, 2, 4]);
    expect([minPrac(tables, 2, 5), maxRel(tables, 2, 5), maxComf(tables, 2, 5), maxPrac(tables, 2, 5)])
      .toEqual([2, 6, 8, 10]);
  });

  test("тождество MinX(f,g) = −MaxX(g,f) из Приложения", () => {
    for (let f = 1; f <= 5; f += 1) {
      for (let g = 1; g <= 5; g += 1) {
        expect(minPrac(tables, f as Finger, g as Finger)).toBe(-maxPrac(tables, g as Finger, f as Finger));
        expect(minComf(tables, f as Finger, g as Finger)).toBe(-maxComf(tables, g as Finger, f as Finger));
        expect(minRel(tables, f as Finger, g as Finger)).toBe(-maxRel(tables, g as Finger, f as Finger));
      }
    }
    expect(maxPrac(tables, 2, 1)).toBe(5);
    expect(maxRel(tables, 5, 1)).toBe(-7);
  });

  test("размер руки масштабирует таблицу", () => {
    const small = spanTables(0.9);
    expect(maxPrac(small, 1, 5)).toBe(14);
    expect(maxComf(small, 2, 5)).toBe(7);
  });
});

describe("правила 1–3 на примерах статьи", () => {
  test("D4–C5 пальцами 2-5: Stretch = 4", () => {
    expect(stretchCost(tables, 2, 5, 10)).toBe(4);
  });

  test("C4–B4 пальцами 1-3: Large-Span 4 + Stretch 2", () => {
    const spans = spanCosts(tables, 1, 3, 11);
    expect(spans.largeSpan).toBe(4);
    expect(stretchCost(tables, 1, 3, 11)).toBe(2);
  });

  test("C4–E4 пальцами 2-3: Stretch 2 + Large-Span 4", () => {
    expect(stretchCost(tables, 2, 3, 4)).toBe(2);
    expect(spanCosts(tables, 2, 3, 4).largeSpan).toBe(4);
  });

  test("C4–G4 пальцами 2-4: Large-Span 6", () => {
    expect(spanCosts(tables, 2, 4, 7).largeSpan).toBe(6);
  });

  test("C4–E4 пальцами 2-1: Stretch 2 и Small-Span 5", () => {
    expect(stretchCost(tables, 2, 1, 4)).toBe(2);
    expect(spanCosts(tables, 2, 1, 4).smallSpan).toBe(5);
  });

  test("C4–E4 пальцами 3-1: Stretch 4 и Small-Span 7", () => {
    expect(stretchCost(tables, 3, 1, 4)).toBe(4);
    expect(spanCosts(tables, 3, 1, 4).smallSpan).toBe(7);
  });
});

describe("правила 4–5 на примерах статьи", () => {
  test("C4-E4-G4 пальцами 2-1-2: полная смена, размер 7", () => {
    expect(positionChangeCosts(tables, "R", [2, 1, 2], [C4, E4, G4])).toEqual({
      positionChangeCount: 2,
      positionChangeSize: 7,
    });
  });

  test("C4-E4-G4 пальцами 2-1-3: размер 4", () => {
    expect(positionChangeCosts(tables, "R", [2, 1, 3], [C4, E4, G4])).toEqual({
      positionChangeCount: 2,
      positionChangeSize: 4,
    });
  });

  test("C4-E4-G4 пальцами 3-1-2: размер 8", () => {
    expect(positionChangeCosts(tables, "R", [3, 1, 2], [C4, E4, G4])).toEqual({
      positionChangeCount: 2,
      positionChangeSize: 8,
    });
  });

  test("повтор ноты через одну (C-F-C пальцами 2-5-1): половинная смена нулевого размера", () => {
    expect(positionChangeCosts(tables, "R", [2, 5, 1], [C4, key(65), C4])).toEqual({
      positionChangeCount: 1,
      positionChangeSize: 0,
    });
  });

  test("внутри позиции смены нет", () => {
    expect(positionChangeCosts(tables, "R", [1, 2, 3], [C4, D4, E4])).toEqual({
      positionChangeCount: 0,
      positionChangeSize: 0,
    });
  });
});

describe("правила 6–12", () => {
  test("Three-Four-Five: 3-5-4 даёт очко, 1-2-3 — нет", () => {
    expect(threeFourFiveCost(3, 5, 4)).toBe(1);
    expect(threeFourFiveCost(1, 2, 3)).toBe(0);
  });

  test("Thumb-on-Black зависит от соседей", () => {
    const dSharp = key(63);
    expect(blackKeyCosts(1, dSharp, key(62), key(64))).toEqual({ thumbOnBlack: 5, fiveOnBlack: 0 });
    expect(blackKeyCosts(1, dSharp, key(61), key(66))).toEqual({ thumbOnBlack: 1, fiveOnBlack: 0 });
  });

  test("Five-on-Black: между чёрными очков нет", () => {
    expect(blackKeyCosts(5, key(66), key(63), key(68))).toEqual({ thumbOnBlack: 0, fiveOnBlack: 0 });
    expect(blackKeyCosts(5, key(66), key(65), key(67))).toEqual({ thumbOnBlack: 0, fiveOnBlack: 4 });
  });

  test("Thumb-Passing: чёрная под пальцем → белая под большим бесплатна", () => {
    expect(thumbPassingCost(3, key(61), 1, key(62), 1)).toBe(0);
    expect(thumbPassingCost(3, C4, 1, D4, 2)).toBe(1);
    expect(thumbPassingCost(3, C4, 1, key(61), 1)).toBe(3);
    expect(thumbPassingCost(1, C4, 2, D4, 2)).toBe(0);
  });

  test("Weak-Finger начисляется на каждое использование 4 и 5", () => {
    expect(transitionParts(tables, "R", 1, C4, 4, E4).weakFinger).toBe(1);
    expect(transitionParts(tables, "R", 4, C4, 2, E4).weakFinger).toBe(0);
  });
});

describe("левая рука — зеркало правой", () => {
  test("восходящая секунда 5-4 в левой руке лежит в расслабленном диапазоне", () => {
    const parts = transitionParts(tables, "L", 5, C4, 4, D4);
    // Только правило 6: ни растяжения, ни переноса кисти.
    expect(parts.weakFinger).toBe(1);
    expect(parts.fourFinger).toBe(FOUR_FINGER_PENALTY);
    expect(parts.smallSpan + parts.largeSpan + parts.stretch).toBe(0);
    expect(parts.handShift).toBe(0);
    expect(weigh(parts)).toBe(1);
  });

  test("та же секунда 5-4 в правой руке — перекрещивание и дорога", () => {
    expect(weigh(transitionParts(tables, "R", 5, C4, 4, D4))).toBeGreaterThan(5);
  });

  test("подкладывание большого в левой руке идёт вниз", () => {
    expect(thumbPassingCost(1, key(72), 3, key(71), 1)).toBe(0);
    expect(transitionParts(tables, "L", 3, C5, 1, B4).thumbPassing).toBe(1);
  });
});
