import { chordFeasible, transitionParts, blackKeyCosts, weigh, tempoWeights, type Finger, type Hand, type RuleWeights, type SpanTables, } from "./fingering-model";
import type { HandEvent, Hint } from "./fingering-types";
/**
 * Find a repeated, compact passage that can share one stationary hand frame.
 * Enumerate every ordered finger subset; geometry, rhythm and adjacent material
 * determine the frame, never the score title, key name or measure number.
 * A soft prior leaves the full-score solver free to choose an essential shift.
 */
export function applyPositionFrame(events: HandEvent[], start: number, hand: Hand, tables: SpanTables, weights: RuleWeights, hints: Map<number, Hint>, bonus: number): number {
    const first = events[start];
    if (!first || first.notes.length !== 1 || first.notes[0].duration > 0.5)
        return 0;
    const cell: HandEvent[] = [];
    const pitches = new Set<number>();
    for (let k = start; k < Math.min(events.length, start + 16); k++) {
        const event = events[k];
        if (event.notes.length !== 1 || event.notes[0].grace || event.notes[0].staccato ||
            event.notes[0].voice !== first.notes[0].voice ||
            event.notes[0].partId !== first.notes[0].partId ||
            Math.abs(event.notes[0].duration - first.notes[0].duration) > 1e-4 ||
            (k > start && (event.gapBefore > 1e-4 || event.hardBreakBefore ||
                event.notes[0].keyFifths !== first.notes[0].keyFifths)))
            break;
        // A fresh bass/register at the next bar can begin another frame; shared
        // pitches still carry through the full-score search, not a forced reset.
        const midi = event.keys[0].midi;
        if (cell.length >= 7 && event.measureIndex !== cell.at(-1)!.measureIndex &&
            (midi < Math.min(...pitches) || midi > Math.max(...pitches)))
            break;
        const next = new Set([...pitches, midi]);
        if (next.size > 5 || Math.max(...next) - Math.min(...next) > 12)
            break;
        pitches.add(event.keys[0].midi);
        cell.push(event);
    }
    if (cell.length < 7 || pitches.size < 3 || cell.length - pitches.size < 2)
        return 0;
    const ordered = [...pitches].sort((a, b) => a - b);
    const keys = ordered.map(midi => cell.find(e => e.keys[0].midi === midi)!.keys[0]);
    let best: Finger[] | undefined;
    let bestCost = Infinity;
    const enumerate = (prefix: Finger[], from: number): void => {
        if (prefix.length < ordered.length) {
            for (let f = from; f <= 5; f++)
                enumerate([...prefix, f as Finger], f + 1);
            return;
        }
        const fingers = hand === "R" ? prefix : [...prefix].reverse();
        for (let i = 0; i < keys.length; i++)
            for (let j = i + 1; j < keys.length; j++)
                if (!chordFeasible(tables, hand, fingers[i], keys[i], fingers[j], keys[j]))
                    return;
        const assignments = cell.map(event => fingers[ordered.indexOf(event.keys[0].midi)]);
        if (cell.some((event, i) => event.fixed[0] !== undefined && event.fixed[0] !== assignments[i]))
            return;
        let cost = 0;
        for (let i = 0; i < cell.length; i++) {
            const key = cell[i].keys[0];
            const parts = transitionParts(tables, hand, assignments[Math.max(0, i - 1)], cell[Math.max(0, i - 1)].keys[0], assignments[i], key);
            Object.assign(parts, blackKeyCosts(assignments[i], key, cell[i - 1]?.keys[0], cell[i + 1]?.keys[0], assignments[i - 1], assignments[i + 1]));
            cost += weigh(parts, tempoWeights(weights, cell[i].ipiBefore));
        }
        if (cost < bestCost) {
            bestCost = cost;
            best = fingers;
        }
    };
    enumerate([], 1);
    if (!best)
        return 0;
    for (const event of cell)
        hints.set(event.index, {
            finger: best[ordered.indexOf(event.keys[0].midi)], bonus,
            kind: "fiveFinger",
        });
    return cell.length;
}
