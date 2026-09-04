import { describe, expect, test } from "bun:test";
import { futureCosts, positionContext, PHRASE_CONTEXT, type PositionTouch } from "./fingering-context";
import { spanTables, isBlackKey, type Finger, type Hand } from "./fingering-model";
import { planFingering } from "./fingering";
import { parseScore } from "./fingering-score";
import type { HandEvent } from "./fingering-types";
const pitch = (midi: number) => {
    const names = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
    return `<pitch><step>${names[midi % 12]}</step><alter>${isBlackKey(midi) ? 1 : 0}</alter><octave>${Math.floor(midi / 12) - 1}</octave></pitch>`;
};
function score(notes: number[], hand: Hand = "R", fixed: Record<number, Finger> = {}, perBar = 4): string {
    const bars: string[] = [];
    for (let i = 0; i < notes.length; i += perBar) {
        bars.push(`<measure number="${bars.length + 1}">${i === 0 ? `<attributes><divisions>2</divisions><clef><sign>${hand === "R" ? "G" : "F"}</sign></clef></attributes><direction><sound tempo="100"/></direction>` : ""}
      ${notes.slice(i, i + perBar).map((midi, j) => `<note>${pitch(midi)}<duration>1</duration><voice>1</voice><staff>1</staff>${fixed[i + j] ? `<notations><technical><fingering>${fixed[i + j]}</fingering></technical></notations>` : ""}</note>`).join("")}</measure>`);
    }
    return `<score-partwise><part id="P1">${bars.join("")}</part></score-partwise>`;
}
function event(midi: number, onset = 2, overrides: Partial<HandEvent> = {}): HandEvent {
    const note = parseScore(score([midi])).notes[0];
    return { index: 4, onset, measureIndex: 1, measureNumber: "2", notes: [{ ...note, onset }],
        keys: [{ midi, black: isBlackKey(midi) }], spilled: [], gapBefore: 0,
        slurredBefore: false, beamBegin: false, beamEnd: false, hardBreakBefore: false,
        fixed: [undefined], ...overrides };
}
const touch = (midi: number, finger: Finger, onset: number): PositionTouch => ({ key: { midi, black: isBlackKey(midi) }, finger, onset, voice: "P1:1" });
describe("phrase context", () => {
    test("same-pitch return remembers the finger across a barline", () => {
        const history = [touch(72, 4, 0), touch(67, 2, 1)];
        expect(positionContext(history, event(72), [4], "R", spanTables()).cost).toBe(0);
        expect(positionContext(history, event(72), [3], "R", spanTables()).cost).toBeGreaterThan(0);
        expect(positionContext(history, event(72, 2, { measureIndex: 99 }), [3], "R", spanTables()).cost)
            .toBe(positionContext(history, event(72), [3], "R", spanTables()).cost);
    });
    test("actual break releases position memory; ordinary barline does not", () => {
        const history = [touch(72, 4, 0), touch(67, 2, 1)];
        expect(positionContext(history, event(72, 2, { hardBreakBefore: true }), [3], "R", spanTables()).cost).toBe(0);
        expect(positionContext(history, event(72, 2, { gapBefore: 1 }), [3], "R", spanTables()).touches).toHaveLength(1);
    });
    test("legal thumb crossing and distant history allow a new position", () => {
        expect(positionContext([touch(64, 3, 1)], event(65), [1], "R", spanTables()).touches).toHaveLength(1);
        expect(positionContext([touch(72, 4, 0)], event(72, 20), [3], "R", spanTables()).cost).toBe(0);
    });
    test("repeated-note alternation is not mistaken for a return within a motif", () => {
        expect(positionContext([touch(72, 4, 1)], event(72), [3], "R", spanTables()).cost).toBe(0);
    });
    test("history stays bounded on a long uninterrupted sequence", () => {
        let touches: PositionTouch[] = [];
        for (let i = 0; i < 100; i++)
            touches = positionContext(touches, event(72, i / 20), [4], "R", spanTables()).touches;
        expect(touches.length).toBeLessThanOrEqual(PHRASE_CONTEXT.maxTouches);
    });
    test("backward potential includes an expensive exit many events later", () => {
        const potential = futureCosts(Array(20).fill(2), (k, from, to) => from !== to ? 100 : k === 19 && to === 0 ? 50 : 0);
        expect(potential[0]).toEqual([50, 0]);
        expect(futureCosts([], () => 0)).toEqual([]);
        expect(futureCosts([2], () => 0)).toEqual([[0, 0]]);
    });
    test("backward costs match exhaustive enumeration, including negative priors", () => {
        const edge = (k: number, a: number, b: number) => [[3, -2, 4], [1, 5, -1], [2, 0, 3]][a][b] + k;
        const costs = futureCosts([3, 3, 3, 3], edge);
        for (let a = 0; a < 3; a++) {
            let exact = Infinity;
            for (let b = 0; b < 3; b++)
                for (let c = 0; c < 3; c++)
                    for (let d = 0; d < 3; d++)
                        exact = Math.min(exact, edge(1, a, b) + edge(2, b, c) + edge(3, c, d));
            expect(costs[0][a]).toBe(exact);
        }
    });
});
describe("general score integration", () => {
    test("octave figure reserves the fifth finger for its future summit", () => {
        const notes = [75, 70, 67, 75, 70, 79, 75, 70];
        const plan = planFingering(score(notes), { mode: "rebuild" });
        expect([...plan.assignments.values()]).toEqual([4, 2, 1, 4, 2, 5, 4, 2]);
    });
    test("moving bass preserves the upper frame in the left hand", () => {
        const notes = [57, 61, 64, 61, 55, 61, 64, 61];
        const plan = planFingering(score(notes, "L"), { mode: "rebuild" });
        expect([...plan.assignments.values()]).toEqual([4, 2, 1, 2, 5, 2, 1, 2]);
    });
    for (const hand of ["R", "L"] as const)
        for (let transpose = 0; transpose < 12; transpose++) {
            test(`continuous broken chord is not an isolated fragment: ${hand}, +${transpose}`, () => {
                const base = hand === "R" ? 60 : 48;
                const notes = [0, 4, 7, 4, -2, 4, 7, 4].map(x => base + x + transpose);
                const xml = score(notes, hand);
                const plan = planFingering(xml, { mode: "rebuild", trace: true });
                expect(plan.assignments.size).toBe(notes.length);
                expect(plan.suppressed.size).toBe(0);
                expect(plan.report.patterns.some(p => p.label === "короткое арпеджио")).toBe(false);
                expect(Number.isFinite(plan.report.stats.costPerNote)).toBe(true);
                // The shared upper pitches keep their finger as the bass changes.
                const fingers = Array.from(plan.assignments.values());
                expect(fingers[1]).toBe(fingers[5]);
                expect(fingers[2]).toBe(fingers[6]);
            });
        }
    test("author anchors survive every pass and full-score lookahead", () => {
        const notes = [60, 64, 67, 64, 58, 64, 67, 64, 57, 60, 64, 60];
        const xml = score(notes, "R", { 1: 2, 6: 5, 10: 4 });
        const plan = planFingering(xml, { mode: "fill" });
        expect(plan.assignments.get(1)).toBe(2);
        expect(plan.assignments.get(6)).toBe(5);
        expect(plan.assignments.get(10)).toBe(4);
    });
    test("isolated three-note arpeggio retains its pedagogical prior", () => {
        const plan = planFingering(score([60, 64, 67]), { mode: "rebuild" });
        expect(plan.report.patterns.some(p => p.label === "короткое арпеджио")).toBe(true);
    });
    test("ordinary re-barring does not change a continuous figure", () => {
        const notes = [60, 64, 67, 64, 58, 64, 67, 64];
        const a = planFingering(score(notes, "R", {}, 4));
        const b = planFingering(score(notes, "R", {}, 8));
        expect([...a.assignments.values()]).toEqual([...b.assignments.values()]);
    });
});
