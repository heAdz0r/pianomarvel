import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEARNING_ALGORITHM_VERSION, PianoCache } from "./cache";
import type { LearningStatus } from "./learning-mode";
import type { UploadedPiece } from "./pieces";

const piece: UploadedPiece = {
  id: 42,
  title: "Cached piece",
  difficulty: 7,
  composer: "Composer",
  artist: "Artist",
  genres: ["Classical"],
};

const status: LearningStatus = {
  pieceId: 42,
  complete: true,
  classification: "ok",
  hasLearning: true,
  fastTempo: 100,
  tempos: [60, 80, 100],
  tabs: {
    W: { exercises: 3, handsComplete: true },
    C: { exercises: 5, handsComplete: false },
    MIN: { exercises: 15, handsComplete: true },
  },
  strategy: "predict",
};

describe("SQLite cache", () => {
  test("сохраняет каталог и время обновления", () => {
    const cache = new PianoCache(":memory:");
    cache.replaceCatalog([piece], "2026-07-19T12:00:00.000Z");

    expect(cache.getCatalog()).toEqual({
      pieces: [piece],
      updatedAt: "2026-07-19T12:00:00.000Z",
    });
    cache.close();
  });

  test("сохраняет проверенный статус отдельно от каталога", () => {
    const cache = new PianoCache(":memory:");
    cache.putLearningStatus(status, "2026-07-19T12:01:00.000Z");

    expect(cache.getLearningStatus(42)).toEqual({
      status,
      checkedAt: "2026-07-19T12:01:00.000Z",
    });
    expect(cache.getLearningStatus(41)).toBeUndefined();
    cache.close();
  });

  test("сохраняет MusicXML отдельно от обновляемого каталога", () => {
    const cache = new PianoCache(":memory:");
    cache.replaceCatalog([piece]);
    cache.putScoreSource(piece.id, import.meta.path, "2026-07-21T20:00:00.000Z");

    expect(cache.getScoreSource(piece.id)).toEqual({
      xmlPath: import.meta.path,
      updatedAt: "2026-07-21T20:00:00.000Z",
    });
    expect(cache.getCatalog().pieces[0].hasMusicXml).toBe(true);
    cache.close();
  });

  test("точно перепривязывает MusicXML после добавления подпапки композиции", () => {
    const dir = mkdtempSync(join(tmpdir(), "pianomarvel-cache-relayout-"));
    const dbPath = join(dir, "cache.sqlite");
    const oldPath = join(dir, "radiohead", "karma-police.mxl");
    const newPath = join(dir, "radiohead", "karma-police", "karma-police.mxl");
    const unrelatedPath = join(dir, "radiohead", "no-surprises.mxl");
    mkdirSync(join(dir, "radiohead", "karma-police"), { recursive: true });
    writeFileSync(oldPath, "old");
    writeFileSync(newPath, "new");
    writeFileSync(unrelatedPath, "unrelated");
    try {
      const cache = new PianoCache(dbPath);
      cache.replaceCatalog([piece, { ...piece, id: 43, title: "Unrelated" }]);
      cache.putScoreSource(piece.id, oldPath, "2026-07-21T20:00:00.000Z");
      cache.putScoreSource(43, unrelatedPath, "2026-07-21T20:01:00.000Z");

      expect(cache.rebindScoreSourcePaths([{ from: oldPath, to: newPath }])).toBe(1);
      expect(cache.getScoreSource(piece.id)).toEqual({
        xmlPath: newPath,
        updatedAt: "2026-07-21T20:00:00.000Z",
      });
      expect(cache.getScoreSource(43)?.xmlPath).toBe(unrelatedPath);
      expect(cache.getCatalog().pieces.every((item) => item.hasMusicXml)).toBe(true);
      cache.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("не возвращается к версии прежнего Adaptive-алгоритма", () => {
    expect(LEARNING_ALGORITHM_VERSION).not.toBe("");
    expect(LEARNING_ALGORITHM_VERSION).not.toBe("learning-strategies-v2");
  });

  test("не затирает свежий статус запоздавшей старой инспекцией", () => {
    const cache = new PianoCache(":memory:");
    const fresh = { ...status, classification: "ok" as const };
    const stale = { ...status, classification: "warning" as const };
    cache.putLearningStatus(fresh, "2026-07-20T12:02:00.000Z");
    cache.putLearningStatus(stale, "2026-07-20T12:01:00.000Z");

    expect(cache.getLearningStatus(status.pieceId)).toEqual({
      status: fresh,
      checkedAt: "2026-07-20T12:02:00.000Z",
    });
    cache.close();
  });

  test("выбирает одну строку и заданный список из большого кеша", () => {
    const cache = new PianoCache(":memory:");
    for (let pieceId = 1; pieceId <= 200; pieceId += 1) {
      cache.putLearningStatus({ ...status, pieceId });
    }

    expect(cache.getLearningStatus(137)?.status.pieceId).toBe(137);
    expect(
      cache
        .getLearningStatuses([3, 77, 199])
        .map((item) => item.status.pieceId)
        .sort((left, right) => left - right),
    ).toEqual([3, 77, 199]);
    expect(cache.getLearningStatuses([])).toEqual([]);
    cache.close();
  });

  test("не возвращает запись другой версии алгоритма из одиночной и пакетной выборки", () => {
    const dir = mkdtempSync(join(tmpdir(), "pianomarvel-cache-version-"));
    const path = join(dir, "cache.sqlite");
    try {
      const cache = new PianoCache(path);
      for (const pieceId of [3, 77, 199]) {
        cache.putLearningStatus({ ...status, pieceId });
      }
      cache.close();

      const db = new Database(path);
      db.run(
        `INSERT INTO learning_status_cache
           (piece_id, payload, checked_at, algorithm_version)
         VALUES (?, ?, ?, ?)`,
        [
          201,
          JSON.stringify({ ...status, pieceId: 201 }),
          "2026-07-20T12:00:00.000Z",
          "learning-strategies-v2",
        ],
      );
      db.close();

      const reopened = new PianoCache(path);
      expect(reopened.getLearningStatus(201)).toBeUndefined();
      expect(
        reopened
          .getLearningStatuses([3, 77, 199, 201])
          .map((item) => item.status.pieceId)
          .sort((left, right) => left - right),
      ).toEqual([3, 77, 199]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
