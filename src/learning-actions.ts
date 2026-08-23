import type { LearningStrategy, UploadedPiece } from "./ui-types";

/** Предпросмотр и сборка из его панели всегда относятся к Adaptive. */
export const ADAPTIVE_PREVIEW_STRATEGY: LearningStrategy = "adaptive";

/** Для предпросмотра MusicXML обязателен независимо от глобального переключателя. */
export function adaptivePreviewUnavailable(
  piece: Pick<UploadedPiece, "hasMusicXml">,
): boolean {
  return !piece.hasMusicXml;
}
