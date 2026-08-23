import { analyzeAdaptiveMusicXml } from "./adaptive-learning";
import { analyzeScoreFile, readScoreXml } from "./scoreAnalyzer";
import {
  measurePlanQuality,
  type GroundTruth,
  type QualityMetrics,
} from "./adaptive-quality";
import groundTruthFile from "./fixtures/phrase-ground-truth.json";

interface AuditRow {
  path: string;
  title: string;
  hash: string;
  measures: number;
  tempo: number;
  slowTempo: number;
  confidence: string;
  phrases: number;
  bridges: number;
  reviews: number;
  summaries: number;
  chunks: number;
  phraseMeasures: [number, number];
  phraseSeconds: [number, number];
  reviewSeconds: [number, number];
  reviewRanges: string[];
  summaryRanges: string[];
  summaryShares: number[];
  warnings: string[];
  issues: string[];
  quality: QualityMetrics;
  groundTruthTitle?: string;
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Использование: bun run server/adaptive-corpus-audit.ts <score1.mxl> [...]");
  process.exit(1);
}

const rows: AuditRow[] = [];
for (const path of paths) {
  try {
    rows.push(await audit(path));
  } catch (error) {
    rows.push({
      path,
      title: "",
      hash: "",
      measures: 0,
      tempo: 0,
      slowTempo: 0,
      confidence: "error",
      phrases: 0,
      bridges: 0,
      reviews: 0,
      summaries: 0,
      chunks: 0,
      phraseMeasures: [0, 0],
      phraseSeconds: [0, 0],
      reviewSeconds: [0, 0],
      reviewRanges: [],
      summaryRanges: [],
      summaryShares: [],
      warnings: [],
      issues: [error instanceof Error ? error.message : String(error)],
      quality: {
        phrases: 0,
        hypermeter: "—",
        closureRate: 0,
        hypermeterAlignment: null,
        sectionRecall: null,
        durationCv: 0,
        forcedCutRate: 0,
        navigationBreaks: 0,
        navigationBridges: 0,
        boundaryPrecision: null,
        mandatoryRecall: null,
      },
    });
  }
}

for (const row of rows) {
  const status = row.issues.length ? `FAIL: ${row.issues.join("; ")}` : "OK";
  console.log(
    [
      row.title || row.path,
      `${row.measures}m`,
      `tempo ${row.tempo}→${row.slowTempo}`,
      `P/B/R/S ${row.phrases}/${row.bridges}/${row.reviews}/${row.summaries}`,
      `chunks ${row.chunks}`,
      `span ${row.phraseMeasures[0]}-${row.phraseMeasures[1]}m`,
      `time ${row.phraseSeconds[0]}-${row.phraseSeconds[1]}s`,
      `review ${row.reviewSeconds[0]}-${row.reviewSeconds[1]}s`,
      row.confidence,
      status,
    ].join(" | "),
  );
  console.log(`  reviews: ${row.reviewRanges.join(", ") || "—"}`);
  console.log(
    `  summarize: ${row.summaryRanges.join(", ") || "—"} (${row.summaryShares.join("/") || "—"}%)`,
  );
  if (row.warnings.length) console.log(`  warnings: ${row.warnings.join(" | ")}`);
  const share = (value: number | null) =>
    value === null ? "n/a" : value.toFixed(2);
  console.log(
    `  quality: closure ${share(row.quality.closureRate)} | hyper ${row.quality.hypermeter} align ${share(row.quality.hypermeterAlignment)}` +
      ` | sections ${share(row.quality.sectionRecall)} | durCV ${row.quality.durationCv.toFixed(2)}` +
      ` | forced ${share(row.quality.forcedCutRate)} | navBreaks ${row.quality.navigationBreaks} (bridges ${row.quality.navigationBridges})` +
      (row.groundTruthTitle
        ? ` | GT[${row.groundTruthTitle}] precision ${share(row.quality.boundaryPrecision)} mandatory ${share(row.quality.mandatoryRecall)}`
        : ""),
  );
  console.log(`  file: ${row.path} [${row.hash}]`);
}

if (rows.some((row) => row.issues.length > 0)) process.exitCode = 1;

async function audit(path: string): Promise<AuditRow> {
  const xml = await readScoreXml(path);
  const metadata = await analyzeScoreFile(path);
  const measures = measureCount(xml);
  const tempo = metadata.defaultTempo ?? 100;
  const slowTempo = Math.max(30, Math.round(tempo * 0.6));
  const plan = analyzeAdaptiveMusicXml(xml, 1, measures, slowTempo);
  const phraseSpans = plan.phraseChunks.map(
    (chunk) => chunk.endMeasure - chunk.startMeasure + 1,
  );
  const phraseSeconds = plan.phraseChunks.map((chunk) =>
    plan.measures
      .filter(
        (measure) =>
          measure.measure >= chunk.startMeasure &&
          measure.measure <= chunk.endMeasure,
      )
      .reduce((sum, measure) => sum + measure.estSeconds, 0),
  );
  const reviewSeconds = plan.reviewChunks.map((chunk) =>
    plan.measures
      .filter(
        (measure) =>
          measure.measure >= chunk.startMeasure &&
          measure.measure <= chunk.endMeasure,
      )
      .reduce((sum, measure) => sum + measure.estSeconds, 0),
  );
  const issues = validate(plan, measures, slowTempo);
  const totalSeconds = plan.measures.reduce(
    (sum, measure) => sum + measure.estSeconds,
    0,
  );
  const summaryShares = plan.summaryChunks.map((chunk) =>
    round(
      (plan.measures
        .slice(chunk.startMeasure - 1, chunk.endMeasure)
        .reduce((sum, measure) => sum + measure.estSeconds, 0) /
        totalSeconds) *
        100,
      1,
    ),
  );
  const hash = new Bun.CryptoHasher("sha256").update(xml).digest("hex").slice(0, 12);
  const annotation = (
    groundTruthFile as Record<string, (GroundTruth & { title?: string }) | string>
  )[hash];
  const groundTruth =
    annotation && typeof annotation !== "string" ? annotation : undefined;
  const quality = measurePlanQuality(plan, groundTruth);

  return {
    quality,
    groundTruthTitle: groundTruth?.title,
    path,
    title: metadata.title,
    hash,
    measures,
    tempo,
    slowTempo,
    confidence: plan.confidence,
    phrases: plan.phraseChunks.length,
    bridges: plan.bridgeChunks.length,
    reviews: plan.reviewChunks.length,
    summaries: plan.summaryChunks.length,
    chunks: plan.chunks.length,
    phraseMeasures: extent(phraseSpans),
    phraseSeconds: extent(phraseSeconds.map((value) => round(value, 1))),
    reviewSeconds: extent(reviewSeconds.map((value) => round(value, 1))),
    reviewRanges: plan.reviewChunks.map(
      (chunk) => `${chunk.startMeasure}-${chunk.endMeasure}`,
    ),
    summaryRanges: plan.summaryChunks.map(
      (chunk) => `${chunk.startMeasure}-${chunk.endMeasure}`,
    ),
    summaryShares,
    warnings: plan.warnings,
    issues,
  };
}

function validate(
  plan: ReturnType<typeof analyzeAdaptiveMusicXml>,
  measureCount: number,
  slowTempo: number,
): string[] {
  const issues: string[] = [];
  const phrases = [...plan.phraseChunks].sort(
    (left, right) => left.startMeasure - right.startMeasure,
  );
  if (
    phrases[0]?.startMeasure !== 1 ||
    phrases.at(-1)?.endMeasure !== measureCount
  ) {
    issues.push("Phrase не покрывают всю партитуру");
  }
  for (const [index, phrase] of phrases.entries()) {
    if (index > 0 && phrase.startMeasure !== phrases[index - 1].endMeasure + 1) {
      issues.push(`разрыв/перекрытие Phrase перед ${phrase.startMeasure}`);
    }
    if (measureCount > 1 && phrase.endMeasure - phrase.startMeasure + 1 < 2) {
      issues.push(`однотактовый Phrase ${phrase.startMeasure}-${phrase.endMeasure}`);
    }
    if (phrase.endMeasure - phrase.startMeasure + 1 > 16) {
      issues.push(`слишком много тактов в Phrase ${phrase.startMeasure}-${phrase.endMeasure}`);
    }
    if (
      phrase.endMeasure < measureCount &&
      plan.measures[phrase.endMeasure - 1]?.forbiddenAfter &&
      !plan.bridgeChunks.some(
        (bridge) =>
          bridge.startMeasure <= phrase.endMeasure &&
          bridge.endMeasure >= phrase.endMeasure + 1,
      )
    ) {
      issues.push(`cut tie после ${phrase.endMeasure} не покрыт Bridge`);
    }
    const seconds = plan.measures
      .slice(phrase.startMeasure - 1, phrase.endMeasure)
      .reduce((sum, measure) => sum + measure.estSeconds, 0);
    if (slowTempo && phrases.length > 1 && seconds + 0.01 < 8) {
      issues.push(`слишком короткий Phrase ${phrase.startMeasure}-${phrase.endMeasure}`);
    }
    if (slowTempo && phrases.length > 1 && seconds > 60) {
      issues.push(`слишком длинный Phrase ${phrase.startMeasure}-${phrase.endMeasure}`);
    }
  }
  for (const [index, phrase] of phrases.slice(0, -1).entries()) {
    const next = phrases[index + 1];
    if (
      !plan.bridgeChunks.some(
        (bridge) =>
          bridge.startMeasure <= phrase.endMeasure &&
          bridge.endMeasure >= next.startMeasure,
      )
    ) {
      issues.push(`нет Bridge на стыке ${phrase.endMeasure}-${next.startMeasure}`);
    }
  }
  for (const measure of plan.measures) {
    if (
      measure.expressiveTempoContinuesAfter &&
      phrases.some((phrase) => phrase.endMeasure === measure.measure)
    ) {
      issues.push(`Phrase режет tempo-span после ${measure.measure}`);
    }
    if (measure.expressiveTempoStarts.length === 0) continue;
    if (
      measure.measure > 1 &&
      !plan.bridgeChunks.some(
        (bridge) =>
          bridge.startMeasure <= measure.measure - 1 &&
          bridge.endMeasure >= measure.measure + 1,
      )
    ) {
      issues.push(`нет Bridge на входе в tempo-span ${measure.measure}`);
    }
  }
  for (const measure of plan.measures) {
    if (
      measure.measure === 1 ||
      measure.tempoTransitionLabels.length === 0
    ) {
      continue;
    }
    if (
      !plan.bridgeChunks.some(
        (bridge) =>
          bridge.startMeasure < measure.measure &&
          bridge.endMeasure >= measure.measure,
      )
    ) {
      issues.push(`нет Bridge на tempo transition ${measure.measure}`);
    }
  }

  const reviews = [...plan.reviewChunks].sort(
    (left, right) => left.startMeasure - right.startMeasure,
  );
  if (phrases.length > 1) {
    if (reviews.length === 0) {
      issues.push("нет итоговых Review");
    } else {
      if (
        reviews[0].startMeasure !== 1 ||
        reviews.at(-1)?.endMeasure !== measureCount
      ) {
        issues.push("Review не покрывают всю партитуру");
      }
      for (const [index, review] of reviews.entries()) {
        if (
          measureCount >= 8 &&
          review.endMeasure - review.startMeasure + 1 < 8
        ) {
          issues.push(`слишком короткий Review ${review.startMeasure}-${review.endMeasure}`);
        }
        if (
          index > 0 &&
          review.startMeasure !== reviews[index - 1].endMeasure + 1
        ) {
          issues.push(`разрыв/перекрытие Review перед ${review.startMeasure}`);
        }
        const startsOnPhrase = phrases.some(
          (phrase) => phrase.startMeasure === review.startMeasure,
        );
        const endsOnPhrase = phrases.some(
          (phrase) => phrase.endMeasure === review.endMeasure,
        );
        if (!startsOnPhrase || !endsOnPhrase) {
          issues.push(`Review режет Phrase ${review.startMeasure}-${review.endMeasure}`);
        }
      }
    }
  }

  const summaries = [...plan.summaryChunks].sort(
    (left, right) => left.startMeasure - right.startMeasure,
  );
  if (phrases.length >= 3) {
    if (summaries.length !== 3) {
      issues.push(`ожидалось 3 Summarize, получено ${summaries.length}`);
    } else {
      if (
        summaries[0].startMeasure !== 1 ||
        summaries.at(-1)?.endMeasure !== measureCount
      ) {
        issues.push("Summarize не покрывают всю партитуру");
      }
      for (const [index, summary] of summaries.entries()) {
        if (
          index > 0 &&
          summary.startMeasure !== summaries[index - 1].endMeasure + 1
        ) {
          issues.push(`разрыв/перекрытие Summarize перед ${summary.startMeasure}`);
        }
        const startsOnPhrase = phrases.some(
          (phrase) => phrase.startMeasure === summary.startMeasure,
        );
        const endsOnPhrase = phrases.some(
          (phrase) => phrase.endMeasure === summary.endMeasure,
        );
        if (!startsOnPhrase || !endsOnPhrase) {
          issues.push(`Summarize режет Phrase ${summary.startMeasure}-${summary.endMeasure}`);
        }
        const totalSeconds = plan.measures.reduce(
          (sum, measure) => sum + measure.estSeconds,
          0,
        );
        const summarySeconds = plan.measures
          .slice(summary.startMeasure - 1, summary.endMeasure)
          .reduce((sum, measure) => sum + measure.estSeconds, 0);
        const share = totalSeconds > 0 ? summarySeconds / totalSeconds : 0;
        if (share < 0.18 || share > 0.48) {
          issues.push(
            `неудобная доля Summarize ${summary.startMeasure}-${summary.endMeasure}: ${round(share * 100, 1)}%`,
          );
        }
      }
    }
  }
  return Array.from(new Set(issues));
}

function measureCount(xml: string): number {
  if (/<score-timewise\b/i.test(xml)) {
    return extractElements(xml, "measure").length;
  }
  const parts = extractElements(xml, "part");
  return Math.max(0, ...parts.map((part) => extractElements(part, "measure").length));
}

function extractElements(xml: string, tag: string): string[] {
  const pattern = new RegExp(
    `<${tag}(?=\\s|>)[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "gi",
  );
  return Array.from(xml.matchAll(pattern), (match) => match[1] ?? "");
}

function extent(values: number[]): [number, number] {
  return values.length
    ? [Math.min(...values), Math.max(...values)]
    : [0, 0];
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
