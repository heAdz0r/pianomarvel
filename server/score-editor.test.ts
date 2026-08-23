import { describe, expect, test } from "bun:test";
import { pickScoreEditor } from "./score-editor";

describe("выбор нотатора", () => {
  test("старшая версия MuseScore выигрывает", () => {
    expect(pickScoreEditor(["MuseScore 3.app", "MuseScore 4.app", "Safari.app"])).toBe(
      "MuseScore 4",
    );
  });

  test("MuseScore важнее прочих нотаторов", () => {
    expect(pickScoreEditor(["Dorico 5.app", "MuseScore 4.app", "Sibelius.app"])).toBe("MuseScore 4");
  });

  test("похожие по имени приложения не считаются нотатором", () => {
    expect(pickScoreEditor(["Muse Hub.app", "Music.app", "Chrome Apps.localized"])).toBeUndefined();
  });

  test("без нотатора возвращается undefined", () => {
    expect(pickScoreEditor([])).toBeUndefined();
    expect(pickScoreEditor(["Safari.app", "Notes.app"])).toBeUndefined();
  });

  test("нотатор без номера версии тоже находится", () => {
    expect(pickScoreEditor(["Sibelius.app"])).toBe("Sibelius");
  });
});
