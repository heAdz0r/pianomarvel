import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  firstUsable,
  isDownloadablePianoResult,
  MUSESCORE_SHEETS_ROOT,
  parseScoreHeading,
  pickAuthorCredit,
  reserveAvailableMuseScoreDownloadDir,
  resolveAvailableMuseScoreDownloadDir,
  resolveMuseScoreDownloadDir,
  sortMuseScoreResults,
  type MuseScoreSearchResult,
} from "./musescore";

function result(overrides: Partial<MuseScoreSearchResult> = {}): MuseScoreSearchResult {
  return {
    scoreId: "1",
    url: "https://musescore.com/user/1/scores/1",
    title: "Interstellar",
    arranger: "Hans Zimmer",
    instrument: "Piano",
    difficulty: "Intermediate",
    isOfficial: false,
    requiresPro: false,
    ...overrides,
  };
}

describe("фильтр выдачи MuseScore", () => {
  test("скрывает Official даже при инструменте Piano", () => {
    expect(isDownloadablePianoResult(result({ isOfficial: true }))).toBe(false);
  });

  test("скрывает результаты без признака фортепиано", () => {
    expect(isDownloadablePianoResult(result({ instrument: "Violin", title: "Interstellar" }))).toBe(false);
  });

  test("принимает Piano из инструмента или названия", () => {
    expect(isDownloadablePianoResult(result())).toBe(true);
    expect(
      isDownloadablePianoResult(result({ instrument: undefined, title: "Interstellar — Piano Solo" })),
    ).toBe(true);
  });
});

describe("сортировка выдачи MuseScore", () => {
  test("по умолчанию ставит самые просматриваемые партитуры первыми", () => {
    const ordered = sortMuseScoreResults([
      result({ scoreId: "small", views: 12_000, saves: 2_000 }),
      result({ scoreId: "large", views: 2_900_000, saves: 91_600 }),
      result({ scoreId: "unknown" }),
    ], "popular");
    expect(ordered.map((item) => item.scoreId)).toEqual(["large", "small", "unknown"]);
  });

  test("умеет отдельно ранжировать по сохранениям и числу оценок", () => {
    const candidates = [
      result({ scoreId: "saved", saves: 9_000, votes: 10 }),
      result({ scoreId: "rated", saves: 1_000, votes: 8_000 }),
    ];
    expect(sortMuseScoreResults(candidates, "saved")[0]?.scoreId).toBe("saved");
    expect(sortMuseScoreResults(candidates, "rated")[0]?.scoreId).toBe("rated");
  });
});

describe("раскладка «автор / название»", () => {
  test("поле композитора, совпавшее с названием, автором не становится", () => {
    // На MuseScore «композитора» заполняет загрузивший: в этом поле регулярно
    // оказывается имя песни, и папка получалась `radioactive` вместо папки автора.
    expect(pickAuthorCredit(["Radioactive"], "Radioactive")).toBeUndefined();
    expect(pickAuthorCredit(["Radioactive", "Imagine Dragons"], "Radioactive")).toBe(
      "Imagine Dragons",
    );
  });

  test("служебные заглушки автором не становятся", () => {
    expect(pickAuthorCredit(["unknown", "Muse Group", "musescore"], "Etudes")).toBeUndefined();
    expect(pickAuthorCredit([" ", "Traditional", "Erik Satie"], "Gymnopédie")).toBe("Erik Satie");
  });

  test("исполнитель отделяется от названия в заголовке страницы", () => {
    expect(parseScoreHeading("Radioactive - Imagine Dragons | Piano")).toEqual({
      title: "Radioactive",
      composer: "Imagine Dragons",
      artist: "Imagine Dragons",
    });
  });

  test("каждая композиция получает подпапку внутри slug автора", () => {
    expect(resolveMuseScoreDownloadDir("Lizz Southern", "Scales, Chords and Arpeggios")).toBe(
      join(MUSESCORE_SHEETS_ROOT, "lizz-southern", "scales-chords-and-arpeggios"),
    );
    expect(resolveMuseScoreDownloadDir("", "")).toBe(
      join(MUSESCORE_SHEETS_ROOT, "unknown", "untitled"),
    );
  });

  test("занятая композиция получает scoreId и не перезаписывается", () => {
    const root = mkdtempSync(join(tmpdir(), "pianomarvel-musescore-layout-"));
    const occupied = resolveMuseScoreDownloadDir("Radiohead", "Karma Police", root);
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "karma-police.mxl"), "edition-a");
    try {
      expect(
        resolveAvailableMuseScoreDownloadDir("Radiohead", "Karma Police", "99117", root),
      ).toEqual({
        dir: join(root, "radiohead", "karma-police-99117"),
        compositionSlug: "karma-police-99117",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("параллельные скачивания атомарно резервируют разные каталоги", () => {
    const root = mkdtempSync(join(tmpdir(), "pianomarvel-musescore-reservation-"));
    const first = reserveAvailableMuseScoreDownloadDir(
      "Radiohead",
      "Karma Police",
      "99117",
      root,
    );
    const second = reserveAvailableMuseScoreDownloadDir(
      "Radiohead",
      "Karma Police",
      "99117",
      root,
    );
    try {
      expect(first.dir).toBe(join(root, "radiohead", "karma-police"));
      expect(second.dir).toBe(join(root, "radiohead", "karma-police-99117"));
      expect(first.dir).not.toBe(second.dir);
    } finally {
      first.release();
      second.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("firstUsable берёт первое непустое значение", () => {
    expect(firstUsable(undefined, "  ", "Scales, Chords and Arpeggios")).toBe(
      "Scales, Chords and Arpeggios",
    );
    expect(firstUsable(undefined, "")).toBe("");
  });
});
