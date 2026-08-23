import { analyzeAdaptiveMusicXml } from "./server/adaptive-learning";
const xml = await Bun.file("/tmp/badhabits/score.xml").text();
const plan = analyzeAdaptiveMusicXml(xml, 1, 48, 75);
console.log("confidence:", plan.confidence, "| warnings:", plan.warnings.length ? plan.warnings : "нет");
console.log("\nфразы:");
for (const p of plan.phraseChunks) {
  console.log(`  m.${String(p.startMeasure).padStart(2)}-${String(p.endMeasure).padEnd(2)} (${p.endMeasure-p.startMeasure+1} т., end_tick=${p.endTick})  ${p.title}`);
}
console.log("\nbridges:", plan.bridgeChunks.map(b => `m.${b.startMeasure}-${b.endMeasure}`).join(", "));
console.log("\nструктурные границы:");
for (const m of plan.measures) {
  if (m.hardBoundaryAfter || m.boundaryScoreAfter >= 6) {
    console.log(`  после m.${m.measure}: score=${m.boundaryScoreAfter} hard=${m.hardBoundaryAfter} [${m.boundaryReasonsAfter.join(", ")}]`);
  }
}
const ticks = plan.measures.filter(m => [1,2,3,4,5,6,7,8,9,13].includes(m.measure)).map(m => `m${m.measure}=${m.tickCount}`);
console.log("\nticks (ожидалось m1-m8=8, m9=7, m13=7):", ticks.join(" "));
