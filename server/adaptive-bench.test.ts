import { expect, test } from "bun:test";
import { benchmarkXml, syntheticScore } from "./adaptive-bench";

test("benchmark отдельно измеряет все стадии подготовки MusicXML", () => {
  const row = benchmarkXml(syntheticScore(16, false), "test/16", 1.25, 1);

  expect(row.measures).toBe(16);
  expect(row.samples).toBe(1);
  expect(row.readXml).toBe(1.25);
  expect(row.extractMeasures).toBeGreaterThanOrEqual(0);
  expect(row.quarterBeats).toBeGreaterThanOrEqual(0);
  expect(row.extractNotes).toBeGreaterThanOrEqual(0);
  expect(row.full).toBeGreaterThanOrEqual(0);
});
