export type LearningStrategy = "predict" | "adaptive";

export function parseLearningStrategy(value: unknown): LearningStrategy {
  return value === "adaptive" ? "adaptive" : "predict";
}

export function learningStrategyLabel(strategy: LearningStrategy): string {
  return strategy === "adaptive" ? "Adaptive MusicXML" : "Piano Marvel Predict";
}
