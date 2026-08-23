export type LoginState = "unknown" | "loggedOut" | "waiting" | "loggedIn";

export type Category = "midi" | "xml" | "pdf" | "image" | "audio";

export type AssessmentMode = "Learn & Play" | "Play Only" | "Learn Only";
export type LearningStrategy = "predict" | "adaptive";

export interface MatchedFiles {
  baseName: string;
  dir: string;
  midi?: string;
  xml?: string;
  pdf?: string;
  image?: string;
  audio: string[];
  extras: string[];
  warnings: string[];
}

export interface FileRow {
  key: Category;
  label: string;
}

// CHANGED: интеграция с MuseScore (prd-musescore-integration.md §6)
export type ScoreSource = "local" | "musescore";

export interface MuseScoreSearchResult {
  scoreId: string;
  url: string;
  title: string;
  arranger: string;
  thumbnailUrl?: string;
  instrument?: string;
  difficulty?: "Beginner" | "Intermediate" | "Advanced" | "";
  isOfficial: boolean;
  requiresPro: boolean;
  rating?: number;
  votes?: number;
  views?: number;
  saves?: number;
  parts?: number;
  pages?: number;
  durationSeconds?: number;
  publishedAt?: string;
}

/** Состояние аппликатуры в исходной партитуре (server/fingering.ts). */
export interface FingeringCoverage {
  totalNotes: number;
  annotatedNotes: number;
  coverage: number;
  hasFingering: boolean;
  partial: boolean;
}

export interface FingeringPattern {
  kind: "scale" | "fiveFinger" | "arpeggio" | "alberti" | "ostinato";
  hand: "L" | "R";
  fromMeasure: number;
  toMeasure: number;
  label: string;
}

export interface FingeringMeasureLoad {
  index: number;
  number: string;
  right: { positionChanges: number; cost: number };
  left: { positionChanges: number; cost: number };
}

export interface FingeringStats {
  notes: number;
  rightNotes: number;
  leftNotes: number;
  positionChanges: number;
  thumbOnBlack: number;
  costPerNote: number;
  ergonomicCostPerNote: number;
  pedagogyAdjustmentPerNote: number;
  patternNotes: number;
}

export interface FingeringReport {
  coverage: FingeringCoverage;
  measures: FingeringMeasureLoad[];
  patterns: FingeringPattern[];
  stats: FingeringStats;
  existing: { matched: number; total: number };
  warnings: string[];
}

export interface FingeringTrace {
  noteIndex: number;
  measure: string;
  hand: "L" | "R";
  midi: number;
  finger: number;
  pattern?: FingeringPattern["kind"];
  reasons: Array<{ rule: string; points: number }>;
  adjustments: Array<{ kind: string; points: number }>;
}

export interface UploadForm {
  title: string;
  subTitle: string;
  composer: string;
  artist: string;
  copyright: string;
  difficulty: number;
  defaultTempo: number | "" | undefined;
  genres: string[];
  assessmentMode: AssessmentMode;
  createLearningMode: boolean;
  learningStrategy: LearningStrategy;
  autoFingering: boolean;
}

export interface UploadResult {
  ok: boolean;
  message: string;
  url?: string;
  detail?: string;
}

export interface NumberRange {
  min: number;
  max: number;
}

export interface UploadedPiece {
  id: number;
  title: string;
  difficulty: number;
  composer: string;
  artist: string;
  genres: string[];
  hasMusicXml?: boolean;
}

export type LearningJobState = "queued" | "running" | "completed" | "failed";

export interface LearningJob {
  id: string;
  pieceId: number;
  state: LearningJobState;
  progress: number;
  message: string;
  error?: string;
  status?: LearningStatus;
  checkedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  lane?: number;
  version: number;
  strategy: LearningStrategy;
}

export interface AdaptivePlanSummary {
  phrases: Array<{ start: number; end: number; title: string }>;
  bridges: number;
  reviews: number;
  summaries: number;
  hypermeter: { period: number; phase: number; confidence: number };
  sections: Array<{ start: number; end: number; label: string }>;
  quality: {
    closureRate: number;
    hypermeterAlignment: number | null;
    sectionRecall: number | null;
    durationCv: number;
    forcedCutRate: number;
    navigationBreaks: number;
  };
  warnings: string[];
  boundaryReasons: Record<number, string[]>;
}

export interface LearningStatus {
  pieceId: number;
  complete: boolean;
  classification: "ok" | "warning" | "missing";
  hasLearning: boolean;
  fastTempo: number;
  tempos: [number, number, number];
  tabs: Record<"W" | "C" | "MIN", {
    exercises: number;
    handsComplete: boolean;
  }>;
  strategy: LearningStrategy | "unknown";
  adaptive?: AdaptivePlanSummary;
}

export interface CachedLearningStatus {
  status: LearningStatus;
  checkedAt: string;
}

export interface CachedPiecesResponse {
  pieces: UploadedPiece[];
  statuses: CachedLearningStatus[];
  updatedAt?: string;
}
