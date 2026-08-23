import type { LearningJob, UploadedPiece } from "./ui-types";

export interface BulkLearningResult {
  pieceId: number;
  title: string;
  state: LearningJob["state"];
  error?: string;
  warnings: number;
  navigationBreaks: number;
}

/** Ошибка HTTP-постановки — полноценный итог массового запуска, а не временный toast. */
export function queueFailureResult(
  piece: Pick<UploadedPiece, "id" | "title">,
  reason: unknown,
): BulkLearningResult {
  return {
    pieceId: piece.id,
    title: piece.title,
    state: "failed",
    error: reason instanceof Error ? reason.message : String(reason),
    warnings: 0,
    navigationBreaks: 0,
  };
}

/** Сначала ошибки, затем замечания, затем успешные композиции. */
export function sortBulkLearningResults(
  left: BulkLearningResult,
  right: BulkLearningResult,
): number {
  return (
    Number(right.state === "failed") - Number(left.state === "failed") ||
    Number(right.warnings > 0 || right.navigationBreaks > 0) -
      Number(left.warnings > 0 || left.navigationBreaks > 0) ||
    left.title.localeCompare(right.title, "ru")
  );
}
