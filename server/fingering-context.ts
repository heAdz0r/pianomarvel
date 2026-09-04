import { chordFeasible, type Finger, type Hand, type Key, type SpanTables } from "./fingering-model";
import { FINGERING_SEARCH, type HandEvent } from "./fingering-types";
/** Released notes still describe a hand position, but never become held-note constraints. */
export interface PositionTouch {
    key: Key;
    finger: Finger;
    onset: number;
    voice: string;
}
export const PHRASE_CONTEXT = {
    maxTouches: 8,
    maxBeats: 8,
    remapping: 3,
} as const;
export function positionContext(previous: readonly PositionTouch[], event: HandEvent, assign: Finger[], hand: Hand, tables: SpanTables, freeBefore = false): {
    touches: PositionTouch[];
    cost: number;
} {
    const current = event.notes.map((note, i) => ({
        key: event.keys[i], finger: assign[i], onset: event.onset,
        voice: note.partId + ":" + note.voice,
    }));
    const last = previous.at(-1);
    const direction = hand === "R" ? 1 : -1;
    const crossing = last && current.length === 1 &&
        ((last.finger === 1 && assign[0] !== 1 && direction * (current[0].key.midi - last.key.midi) < 0) ||
            (last.finger !== 1 && assign[0] === 1 && direction * (current[0].key.midi - last.key.midi) > 0));
    // A genuine reposition starts a new frame. Ordinary barlines do not.
    const released = freeBefore || event.hardBreakBefore ||
        event.gapBefore >= FINGERING_SEARCH.resetGap ||
        event.notes.every(note => note.staccato) || crossing ||
        (last && current.length === 1 && last.finger === assign[0] && Math.abs(current[0].key.midi - last.key.midi) > 7);
    const recent = released ? [] : previous.filter(touch => event.onset - touch.onset <= PHRASE_CONTEXT.maxBeats);
    let cost = 0;
    for (const touch of current) {
        // A finger returning on another pitch also relocates the frame, even when
        // intervening notes made the pairwise transition look inexpensive.
        const reused = [...recent].reverse().find(old => old.voice === touch.voice && old.finger === touch.finger);
        if (reused && reused.onset !== last?.onset && reused.key.midi !== touch.key.midi) {
            cost += PHRASE_CONTEXT.remapping;
        }
        const samePitch = [...recent].reverse().find(old => old.voice === touch.voice && old.key.midi === touch.key.midi);
        // Rearticulating a repeated note can deliberately alternate fingers.
        if (!samePitch || samePitch.onset === last?.onset || samePitch.finger === touch.finger)
            continue;
        // Only prefer the old finger if the new chord can physically accommodate it.
        const fits = current.every(other => other === touch ||
            (touch.key.midi < other.key.midi
                ? chordFeasible(tables, hand, samePitch.finger, touch.key, other.finger, other.key)
                : chordFeasible(tables, hand, other.finger, other.key, samePitch.finger, touch.key)));
        if (fits)
            cost += PHRASE_CONTEXT.remapping;
    }
    return { touches: [...recent, ...current].slice(-PHRASE_CONTEXT.maxTouches), cost };
}
/**
 * Backward dynamic-programming potential over candidate transitions.
 * Used only to rank beam survivors, never added to the reported path cost.
 * The forward pass still validates held notes, articulation and full history.
 */
export function futureCosts(sizes: readonly number[], edge: (event: number, from: number, to: number) => number): number[][] {
    const costs = sizes.map(size => Array<number>(size).fill(0));
    for (let k = sizes.length - 2; k >= 0; k -= 1) {
        for (let from = 0; from < sizes[k]; from += 1) {
            let best = Infinity;
            for (let to = 0; to < sizes[k + 1]; to += 1) {
                best = Math.min(best, edge(k + 1, from, to) + costs[k + 1][to]);
            }
            costs[k][from] = best;
        }
    }
    return costs;
}
