/** Статус применяется только если он не старше уже показанного ответа. */
export function shouldApplyLearningStatus(
  previousStamp: string | undefined,
  incomingStamp: string,
): boolean {
  return previousStamp === undefined || incomingStamp >= previousStamp;
}
