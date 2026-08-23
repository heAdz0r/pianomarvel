import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRelayout, planRelayout } from "./musescore-relayout";

test("relayout планирует без записи и переносит два полных комплекта", () => {
  const root = mkdtempSync(join(tmpdir(), "pianomarvel-relayout-"));
  const firstDir = join(root, "unknown");
  const secondDir = join(root, "legacy");
  mkdirSync(firstDir);
  mkdirSync(secondDir);
  const firstMxl = join(firstDir, "old-name.mxl");
  const firstPdf = join(firstDir, "old-name.pdf");
  const firstFingered = join(firstDir, "fingered", "old-name.mxl");
  const secondMxl = join(secondDir, "second.mxl");
  const secondMidi = join(secondDir, "second.mid");
  mkdirSync(join(firstDir, "fingered"));
  for (const path of [firstMxl, firstPdf, secondMxl, secondMidi]) writeFileSync(path, path);
  writeFileSync(firstFingered, "fingered");
  try {
    const plan = planRelayout([
      {
        path: firstMxl,
        title: "New Name",
        composer: "Ada Lovelace",
        artist: "",
      },
      {
        path: secondMxl,
        title: "Second Work",
        composer: "",
        artist: "Grace Hopper",
      },
    ], root);
    expect(existsSync(firstMxl)).toBe(true);
    expect(existsSync(secondMxl)).toBe(true);
    expect(plan).toHaveLength(2);
    expect(plan[0].files).toHaveLength(3);
    expect(plan[1].files).toHaveLength(2);

    const result = applyRelayout(plan, root);
    expect(result).toEqual({ movedBundles: 2, movedFiles: 5, skipped: [] });
    expect(existsSync(join(root, "ada-lovelace", "old-name", "old-name.mxl"))).toBe(true);
    expect(existsSync(join(root, "ada-lovelace", "old-name", "old-name.pdf"))).toBe(true);
    expect(
      existsSync(join(root, "ada-lovelace", "old-name", "fingered", "old-name.mxl")),
    ).toBe(true);
    expect(existsSync(join(root, "legacy", "second", "second.mxl"))).toBe(true);
    expect(existsSync(join(root, "legacy", "second", "second.mid"))).toBe(true);
    expect(existsSync(firstDir)).toBe(false);
    expect(existsSync(secondDir)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relayout заранее отмечает конфликт и пустые метаданные, ничего не перезаписывая", () => {
  const root = mkdtempSync(join(tmpdir(), "pianomarvel-relayout-conflict-"));
  const oldDir = join(root, "unknown");
  const targetDir = join(root, "ada-lovelace", "old-name");
  mkdirSync(oldDir);
  mkdirSync(targetDir, { recursive: true });
  const conflictMxl = join(oldDir, "old-name.mxl");
  const metadataFree = join(oldDir, "metadata-free.mxl");
  const occupied = join(targetDir, "old-name.mxl");
  writeFileSync(conflictMxl, "source");
  writeFileSync(metadataFree, "metadata-free");
  writeFileSync(occupied, "occupied");
  try {
    const plan = planRelayout([
      {
        path: conflictMxl,
        title: "New Name",
        composer: "Ada Lovelace",
        artist: "",
      },
      {
        path: metadataFree,
        title: "",
        composer: "",
        artist: "",
      },
    ], root);

    expect(plan[0].skipped).toContain("цель занята");
    expect(plan[1].skipped).toBeUndefined();
    const result = applyRelayout(plan, root);
    expect(result.movedBundles).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(readFileSync(occupied, "utf8")).toBe("occupied");
    expect(existsSync(conflictMxl)).toBe(true);
    expect(
      existsSync(join(root, "unknown", "metadata-free", "metadata-free.mxl")),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("две редакции с одним названием сохраняют разные composition stem", () => {
  const root = mkdtempSync(join(tmpdir(), "pianomarvel-relayout-editions-"));
  const authorDir = join(root, "metallica");
  mkdirSync(authorDir);
  const short = join(authorDir, "nothing-else-matters.mxl");
  const arranged = join(authorDir, "nothing-else-matters-metallica.mxl");
  writeFileSync(short, "edition-a");
  writeFileSync(arranged, "edition-b");
  try {
    const plan = planRelayout(
      [short, arranged].map((path) => ({
        path,
        title: "Nothing Else Matters",
        composer: "Metallica",
        artist: "Metallica",
      })),
      root,
    );

    expect(plan[0]?.files[0]?.to).toBe(
      join(authorDir, "nothing-else-matters", "nothing-else-matters.mxl"),
    );
    expect(plan[1]?.files[0]?.to).toBe(
      join(
        authorDir,
        "nothing-else-matters-metallica",
        "nothing-else-matters-metallica.mxl",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy title-папка заменяется подтверждённым автором, а arranger игнорируется", () => {
  const root = mkdtempSync(join(tmpdir(), "pianomarvel-relayout-author-"));
  const legacyDir = join(root, "radioactive");
  mkdirSync(legacyDir);
  const source = join(legacyDir, "radioactive-imagine-dragons.mxl");
  writeFileSync(source, "score");
  try {
    const plan = planRelayout(
      [{
        path: source,
        title: "Radioactive",
        composer: "Arranged by Awesome5409",
        artist: "",
      }],
      root,
    );
    expect(plan[0]?.files[0]?.to).toBe(
      join(
        root,
        "imagine-dragons",
        "radioactive-imagine-dragons",
        "radioactive-imagine-dragons.mxl",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
