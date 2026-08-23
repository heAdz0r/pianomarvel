import { describe, expect, test } from "bun:test";
import { parseUploadedPieces } from "./pieces";

describe("каталог загруженных композиций", () => {
  test("преобразует getItems и сохраняет кириллицу", () => {
    const pieces = parseUploadedPieces({
      pieces: {
        "157783": {
          title: "Лесник",
          difficulty: 11,
          composer: "Король и Шут",
          artist: "Король и Шут",
          genres: [8],
        },
      },
    });

    expect(pieces).toEqual([
      {
        id: 157783,
        title: "Лесник",
        difficulty: 11,
        composer: "Король и Шут",
        artist: "Король и Шут",
        genres: ["Rock & Country"],
      },
    ]);
  });
});
