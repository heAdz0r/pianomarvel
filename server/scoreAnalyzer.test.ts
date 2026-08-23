import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeMusicXml,
  analyzeScoreFile,
  clearScoreCache,
  extractMidiTempo,
  scoreCacheStats,
} from "./scoreAnalyzer";

const simpleScore = `<?xml version="1.0"?>
<score-partwise>
  <work><work-title>Nothing Else Matters</work-title></work>
  <identification>
    <creator type="composer">Metallica</creator>
    <rights>Copyright owner</rights>
  </identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><staves>2</staves></attributes>
      <direction><sound tempo="75"/></direction>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

describe("анализ MusicXML", () => {
  test("извлекает точные поля и локально определяет жанр", () => {
    const result = analyzeMusicXml(simpleScore);

    expect(result.title).toBe("Nothing Else Matters");
    expect(result.composer).toBe("Metallica");
    expect(result.copyright).toBe("Copyright owner");
    expect(result.defaultTempo).toBe(75);
    expect(result.genres).toEqual(["Rock & Country"]);
    expect(result.difficulty).toBeLessThanOrEqual(4);
  });

  test("повышает сложность для плотной полифонии и сложного ритма", () => {
    const advancedNotes = Array.from(
      { length: 48 },
      (_, index) => `<note>
        ${index % 3 === 0 ? "<chord/>" : ""}
        <pitch><step>${index % 2 ? "C" : "F"}</step><alter>1</alter><octave>${index % 2 ? 2 : 7}</octave></pitch>
        <duration>1</duration><voice>${(index % 3) + 1}</voice><type>32nd</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
      </note>`,
    ).join("");
    const advanced = simpleScore.replace(
      /<part id="P1">[\s\S]*<\/part>/,
      `<part id="P1">${Array.from(
        { length: 12 },
        (_, index) => `<measure number="${index + 1}">${advancedNotes}</measure>`,
      ).join("")}</part>`,
    );

    expect(analyzeMusicXml(advanced).difficulty).toBeGreaterThan(
      analyzeMusicXml(simpleScore).difficulty,
    );
  });

  test("сохраняет кириллицу и отбрасывает техническое имя экспортёра", () => {
    const cyrillic = simpleScore
      .replace("Nothing Else Matters", "Лесник")
      .replace(
        '<creator type="composer">Metallica</creator>',
        '<creator type="composer">_t0Xic26_</creator><creator type="lyricist">Король и Шут</creator>',
      )
      .replace("Copyright owner", "Король и Шут");

    const result = analyzeMusicXml(cyrillic);

    expect(result.title).toBe("Лесник");
    expect(result.artist).toBe("Король и Шут");
    expect(result.composer).toBe("Король и Шут");
    expect(result.genres).toEqual(["Rock & Country"]);
  });

  test("читает Set Tempo из MIDI как fallback для MusicXML без tempo", () => {
    const midi = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, // MThd
      0x00, 0x00, 0x00, 0x06,
      0x00, 0x01, 0x00, 0x01, 0x01, 0xe0,
      0x4d, 0x54, 0x72, 0x6b, // MTrk
      0x00, 0x00, 0x00, 0x0b,
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 500000 μs = 120 BPM
      0x00, 0xff, 0x2f, 0x00,
    ]);

    expect(extractMidiTempo(midi)).toBe(120);
  });

  test("подставляет 60 BPM, когда tempo нет ни в MusicXML, ни в MIDI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pianomarvel-tempo-"));
    const xmlPath = join(dir, "score.musicxml");
    try {
      await writeFile(xmlPath, simpleScore.replace('<direction><sound tempo="75"/></direction>', ""));

      const result = await analyzeScoreFile(xmlPath, join(dir, "missing.mid"));

      expect(result.defaultTempo).toBe(60);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("инвалидирует кеш после перезаписи файла", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pianomarvel-score-cache-"));
    const xmlPath = join(dir, "score.musicxml");
    try {
      clearScoreCache();
      await writeFile(xmlPath, simpleScore);
      expect((await analyzeScoreFile(xmlPath)).title).toBe("Nothing Else Matters");
      expect((await analyzeScoreFile(xmlPath)).title).toBe("Nothing Else Matters");
      expect(scoreCacheStats()).toEqual({ entries: 1, misses: 1 });
      await writeFile(xmlPath, simpleScore.replace("Nothing Else Matters", "Fresh title"));
      expect((await analyzeScoreFile(xmlPath)).title).toBe("Fresh title");
      expect(scoreCacheStats()).toEqual({ entries: 2, misses: 2 });
    } finally {
      clearScoreCache();
      await rm(dir, { recursive: true });
    }
  });
});
