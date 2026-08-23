import { expect, test } from "bun:test";
import {
  ADAPTIVE_PREVIEW_STRATEGY,
  adaptivePreviewUnavailable,
} from "./learning-actions";

test("предпросмотр всегда требует MusicXML и собирается через Adaptive", () => {
  expect(adaptivePreviewUnavailable({ hasMusicXml: false })).toBe(true);
  expect(adaptivePreviewUnavailable({ hasMusicXml: true })).toBe(false);
  expect(ADAPTIVE_PREVIEW_STRATEGY).toBe("adaptive");
});
