/**
 * Замер стадий музыкального анализа. Синтетические партитуры нужны потому, что в
 * корпусе сотни тактов, а сверхлинейные участки проявляются на тысячах.
 *
 *   bun run server/adaptive-bench.ts
 *   bun run server/adaptive-bench.ts path/to/score.mxl
 */
import { performance } from "node:perf_hooks";
import { clearScoreCache, readScoreXml } from "./scoreAnalyzer";
import {
  extractCombinedMeasures,
  extractMeasureNotes,
  quarterBeatsPerMeasure,
} from "./adaptive-notes";
import { analyzeMelody } from "./adaptive-melody";
import { analyzeHarmony } from "./adaptive-harmony";
import {
  analyzeStructure,
  fuzzyRepeatStarts,
  maximalRepeats,
  measureFeature,
  noveltyCurve,
} from "./adaptive-structure";
import { analyzeAdaptiveMusicXml } from "./adaptive-learning";

interface BenchRow {
  input: string;
  measures: number;
  samples: number;
  readXml: number;
  extractMeasures: number;
  quarterBeats: number;
  extractNotes: number;
  melody: number;
  harmony: number;
  features: number;
  novelty: number;
  exactRepeats: number;
  fuzzyRepeats: number;
  structure: number;
  full: number;
}

const BENCH_SAMPLES = 3;

/** Один прогрев плюс медиана повторов уменьшают шум JIT и фоновой нагрузки. */
function timed<T>(run: () => T, samples: number): { value: T; ms: number } {
  let value = run();
  const times: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    value = run();
    times.push(performance.now() - started);
  }
  return { value, ms: median(times) };
}

async function timedAsync<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function benchmarkXml(
  xml: string,
  input: string,
  readXmlMs = 0,
  samples = BENCH_SAMPLES,
): BenchRow {
  const bodies = timed(() => extractCombinedMeasures(xml), samples);
  const beats = timed(() => quarterBeatsPerMeasure(bodies.value), samples);
  const notes = timed(
    () => extractMeasureNotes(bodies.value, beats.value),
    samples,
  );
  const window = Math.max(2, Math.min(8, Math.floor(notes.value.length / 4)));
  const melody = timed(() => analyzeMelody(notes.value), samples);
  const harmony = timed(
    () => analyzeHarmony(notes.value, melody.value.stream),
    samples,
  );
  const features = timed(() => notes.value.map(measureFeature), samples);
  const novelty = timed(() => noveltyCurve(features.value, window), samples);
  const exactRepeats = timed(
    () => maximalRepeats(features.value, window),
    samples,
  );
  const fuzzyRepeats = timed(
    () => fuzzyRepeatStarts(features.value, window),
    samples,
  );
  const structure = timed(() =>
    analyzeStructure(
      notes.value,
      Array<number>(notes.value.length).fill(0),
      Array<boolean>(notes.value.length).fill(false),
    ),
    samples,
  );
  const full = timed(() =>
    analyzeAdaptiveMusicXml(xml, 1, notes.value.length, 60),
    samples,
  );
  return {
    input,
    measures: notes.value.length,
    samples,
    readXml: round(readXmlMs),
    extractMeasures: round(bodies.ms),
    quarterBeats: round(beats.ms),
    extractNotes: round(notes.ms),
    melody: round(melody.ms),
    harmony: round(harmony.ms),
    features: round(features.ms),
    novelty: round(novelty.ms),
    exactRepeats: round(exactRepeats.ms),
    fuzzyRepeats: round(fuzzyRepeats.ms),
    structure: round(structure.ms),
    full: round(full.ms),
  };
}

export function syntheticScore(measures: number, identical: boolean): string {
  const steps = ["C", "D", "E", "F", "G", "A", "B"];
  const body = Array.from({ length: measures }, (_, index) => {
    const step = identical ? "C" : steps[index % steps.length];
    const attributes = index === 0
      ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
      : "";
    return `<measure number="${index + 1}">${attributes}<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><staff>1</staff></note></measure>`;
  }).join("");
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path) {
    clearScoreCache();
    const read = await timedAsync(() => readScoreXml(path));
    console.table([benchmarkXml(read.value, path, read.ms)]);
  } else {
    const rows: BenchRow[] = [];
    for (const measures of [200, 400, 800, 1600]) {
      rows.push(benchmarkXml(syntheticScore(measures, false), `разный/${measures}`));
      rows.push(benchmarkXml(syntheticScore(measures, true), `одинаковый/${measures}`));
    }
    console.table(rows);
  }
}

if (import.meta.main) await main();
