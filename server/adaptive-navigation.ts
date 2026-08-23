/**
 * Слой навигации (L7): порядок исполнения, а не порядок печати.
 *
 * Зачем: репризы, вольты, `D.S.`, `D.C.` и `To Coda` означают, что после такта
 * звучит вовсе не следующий печатный такт. Упражнение, содержащее конец первой
 * вольты и начало второй подряд, тренирует последовательность, которой в исполнении
 * не существует (в Radioactive это такты 17–24). Настоящие уязвимые стыки — «выход»
 * перед прыжком и «вход» после посадки; каждый из них становится отдельным Bridge,
 * потому что диапазон упражнения Piano Marvel непрерывен и склеить прыжок одним
 * куском нельзя.
 */

import {
  attributeValue,
  matchElements,
  type CombinedMeasureBody,
} from "./adaptive-notes";

export type JumpKind =
  | "repeat-back"
  | "volta"
  | "dal-segno"
  | "da-capo"
  | "to-coda";

export interface NavigationJump {
  kind: JumpKind;
  /** Индекс такта, после которого исполнение уходит в другое место. */
  from: number;
  /** Индекс такта, с которого исполнение продолжается, если он выводится. */
  to?: number;
}

export interface NavigationGraph {
  jumps: NavigationJump[];
  /** После такта i печатный порядок прерывается: следующий такт звучит не сразу. */
  discontinuityAfter: boolean[];
  /** Такт является целью прыжка: реприза, segno, coda, следующая вольта. */
  landing: boolean[];
}

export function analyzeNavigation(
  bodies: CombinedMeasureBody[],
): NavigationGraph {
  const count = bodies.length;
  const jumps: NavigationJump[] = [];
  const discontinuityAfter = Array<boolean>(count).fill(false);
  const landing = Array<boolean>(count).fill(false);

  const forwardRepeats: number[] = [];
  let segno: number | undefined;
  let coda: number | undefined;
  const endingStarts: number[] = [];

  for (const [index, measure] of bodies.entries()) {
    const words = matchElements(measure.body, "words")
      .map((item) => item.body.replace(/<[^>]+>/g, " "))
      .join(" ");
    const soundAttributes = Array.from(
      measure.body.matchAll(/<sound(?=[\s/>])([^>]*)>/gi),
      (match) => match[1] ?? "",
    );
    const hasSoundFlag = (name: string) =>
      soundAttributes.some((attributes) => attributeValue(attributes, name));
    if (/<segno(?=\s|\/|>)/i.test(measure.body) || hasSoundFlag("segno")) {
      segno ??= index;
      landing[index] = true;
    }
    if (/<coda(?=\s|\/|>)/i.test(measure.body) || hasSoundFlag("coda")) {
      coda ??= index;
      landing[index] = true;
    }
    for (const barline of matchElements(measure.body, "barline")) {
      const beforeMeasure = /location=["']left["']/i.test(barline.attributes);
      if (/<repeat\b[^>]*direction=["']forward["']/i.test(barline.body)) {
        forwardRepeats.push(index);
        landing[index] = true;
      }
      if (/<ending\b[^>]*\btype=["']start["']/i.test(barline.body)) {
        endingStarts.push(index);
        if (endingStarts.length > 1) landing[index] = true;
      }
      if (/<repeat\b[^>]*direction=["']backward["']/i.test(barline.body)) {
        const target = forwardRepeats.at(-1) ?? 0;
        const from = beforeMeasure ? index - 1 : index;
        if (from >= 0) {
          jumps.push({ kind: "repeat-back", from, to: target });
          discontinuityAfter[from] = true;
        }
      }
      // Конец вольты, за которым начинается следующая вольта: печатное соседство
      // здесь не является исполнительским.
      if (
        /<ending\b[^>]*\btype=["'](?:stop|discontinue)["']/i.test(barline.body) &&
        !beforeMeasure
      ) {
        const next = bodies[index + 1];
        if (
          next &&
          matchElements(next.body, "barline").some((item) =>
            /<ending\b[^>]*\btype=["']start["']/i.test(item.body),
          )
        ) {
          jumps.push({ kind: "volta", from: index, to: index + 1 });
          discontinuityAfter[index] = true;
          landing[index + 1] = true;
        }
      }
    }
    if (/\bD\.?\s*S\.?\b|\bdal\s+segno\b/i.test(words) || hasSoundFlag("dalsegno")) {
      jumps.push({ kind: "dal-segno", from: index, to: segno });
      discontinuityAfter[index] = true;
    }
    if (/\bD\.?\s*C\.?\b|\bda\s+capo\b/i.test(words) || hasSoundFlag("dacapo")) {
      jumps.push({ kind: "da-capo", from: index, to: 0 });
      discontinuityAfter[index] = true;
    }
    if (/\bto\s+coda\b|\bal\s+coda\b/i.test(words) || hasSoundFlag("tocoda")) {
      jumps.push({ kind: "to-coda", from: index, to: coda });
      discontinuityAfter[index] = true;
    }
  }

  // Ссылки на segno/coda часто стоят раньше самих меток: дозаполняем цели после
  // полного прохода, иначе `D.S.` в середине пьесы остался бы без адреса.
  for (const jump of jumps) {
    if (jump.to !== undefined) continue;
    if (jump.kind === "dal-segno" && segno !== undefined) jump.to = segno;
    if (jump.kind === "to-coda" && coda !== undefined) jump.to = coda;
  }
  for (const jump of jumps) {
    if (jump.to !== undefined) landing[jump.to] = true;
  }

  return { jumps, discontinuityAfter, landing };
}
