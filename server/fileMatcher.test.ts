import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSiblingFiles } from "./fileMatcher";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("поиск файлов композиции", () => {
  test("находит файлы независимо от порядка слов и служебного суффикса", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pianomarvel-"));
    directories.push(dir);
    const names = [
      "nothing-else-matters-metallica.mxl",
      "nothing-else-matters-metallica.mid",
      "nothing-else-matters.mp3",
      "Metallica_-_Nothing_Else_Matters_cover.jpg",
      "unrelated-song.pdf",
    ];
    await Promise.all(names.map((name) => writeFile(join(dir, name), "")));

    const result = await findSiblingFiles(join(dir, names[0]));

    expect(result.xml).toBe(join(dir, names[0]));
    expect(result.midi).toBe(join(dir, names[1]));
    expect(result.audio).toEqual([join(dir, names[2])]);
    expect(result.image).toBe(join(dir, names[3]));
    expect(result.pdf).toBeUndefined();
  });

  test("exact stem не смешивается с соседней редакцией той же песни", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pianomarvel-editions-"));
    directories.push(dir);
    const names = [
      "nothing-else-matters.mxl",
      "nothing-else-matters.mid",
      "nothing-else-matters.mp3",
      "nothing-else-matters-metallica.mxl",
      "nothing-else-matters-metallica.mid",
      "nothing-else-matters-metallica.mp3",
    ];
    await Promise.all(names.map((name) => writeFile(join(dir, name), name)));

    const result = await findSiblingFiles(join(dir, "nothing-else-matters.mxl"));

    expect(result.xml).toBe(join(dir, "nothing-else-matters.mxl"));
    expect(result.midi).toBe(join(dir, "nothing-else-matters.mid"));
    expect(result.audio).toEqual([join(dir, "nothing-else-matters.mp3")]);
    expect(result.xml).not.toContain("metallica.mxl");
    expect(result.midi).not.toContain("metallica.mid");
  });
});
