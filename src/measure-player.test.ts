import { describe, expect, test } from "bun:test";

import {
  audioPlaybackSupported,
  buildWindowPlaybackPlan,
  cellAtPosition,
  GRAND_PIANO_SAMPLES,
  grandPianoSampleForMidi,
  midiToFrequency,
  pulseOnsets,
  secondsPerQuarter,
  stringDecaySeconds,
} from "./measure-player";

describe("measure-player: музыкальное время", () => {
  test("строй A4 = 440 и октава ровно вдвое", () => {
    expect(midiToFrequency(69)).toBeCloseTo(440, 6);
    expect(midiToFrequency(81)).toBeCloseTo(880, 6);
    expect(midiToFrequency(60)).toBeCloseTo(261.6255653, 5);
  });

  test("Grand Piano покрывает все 88 клавиш без грубого транспонирования", () => {
    expect(GRAND_PIANO_SAMPLES).toHaveLength(16);
    for (let midi = 21; midi <= 108; midi += 1) {
      expect(Math.abs(grandPianoSampleForMidi(midi).midi - midi)).toBeLessThanOrEqual(3);
    }
    expect(grandPianoSampleForMidi(69).file).toBe("A4.mp3");
  });

  test("четверть при 120 BPM длится полсекунды", () => {
    expect(secondsPerQuarter(120)).toBeCloseTo(0.5, 6);
    expect(secondsPerQuarter(60)).toBeCloseTo(1, 6);
  });

  test("нулевой и отрицательный темп не делят на ноль", () => {
    expect(Number.isFinite(secondsPerQuarter(0))).toBe(true);
    expect(Number.isFinite(secondsPerQuarter(-30))).toBe(true);
  });

  test("клик метронома встаёт на доли, а не на четверти", () => {
    expect(pulseOnsets(4, 1)).toEqual([0, 1, 2, 3]);
    // 6/8: две пунктирные четверти, а не шесть восьмых.
    expect(pulseOnsets(3, 1.5)).toEqual([0, 1.5]);
    expect(pulseOnsets(1, 1)).toEqual([0]);
  });

  test("клики окна из нескольких тактов идут насквозь", () => {
    const window = [0, 4].flatMap((start) =>
      pulseOnsets(4, 1).map((onset) => start + onset),
    );
    expect(window).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("план окна объединяет такты, но оставляет отсчёт длиной в один такт", () => {
    const plan = buildWindowPlaybackPlan([
      {
        offsetQuarters: 0,
        quarters: 4,
        pulseLength: 1,
        notes: [{ onsetQuarters: 0, durationQuarters: 1, midi: 60, hand: "right" }],
      },
      {
        offsetQuarters: 4,
        quarters: 3,
        pulseLength: 1.5,
        notes: [{ onsetQuarters: 1.5, durationQuarters: 1, midi: 48, hand: "left" }],
      },
    ], ["right", "left"]);

    expect(plan?.quarters).toBe(7);
    expect(plan?.notes.map((note) => note.onsetQuarters)).toEqual([0, 5.5]);
    expect(plan?.pulses.map((pulse) => pulse.onset)).toEqual([0, 1, 2, 3, 4, 5.5]);
    expect(plan?.pulses.map((pulse) => pulse.accent)).toEqual([true, false, false, false, true, false]);
    expect(plan?.countIn.quarters).toBe(4);
    expect(plan?.countIn.pulses.map((pulse) => pulse.onset)).toEqual([0, 1, 2, 3]);
  });

  test("фильтр рук не меняет длину окна и позволяет оставить только метроном", () => {
    const segments = [{
      offsetQuarters: 0,
      quarters: 4,
      pulseLength: 1,
      notes: [
        { onsetQuarters: 0, durationQuarters: 1, midi: 72, hand: "right" as const },
        { onsetQuarters: 0, durationQuarters: 1, midi: 48, hand: "left" as const },
      ],
    }];

    expect(buildWindowPlaybackPlan(segments, ["left"])?.notes.map((note) => note.midi)).toEqual([48]);
    const metronomeOnly = buildWindowPlaybackPlan(segments, []);
    expect(metronomeOnly?.notes).toEqual([]);
    expect(metronomeOnly?.quarters).toBe(4);
    expect(metronomeOnly?.pulses).toHaveLength(4);
  });

  test("пустой или неопределённый такт не даёт кликов", () => {
    expect(pulseOnsets(0, 1)).toEqual([]);
    expect(pulseOnsets(4, 0)).toEqual([]);
  });

  test("позиция попадает в клетку, а до начала такта клетки нет", () => {
    const offsets = [0, 0.5, 1, 1.5];
    expect(cellAtPosition(offsets, -0.2)).toBe(-1);
    expect(cellAtPosition(offsets, 0)).toBe(0);
    expect(cellAtPosition(offsets, 0.49)).toBe(0);
    expect(cellAtPosition(offsets, 0.5)).toBe(1);
    expect(cellAtPosition(offsets, 1.9)).toBe(3);
    expect(cellAtPosition([], 1)).toBe(-1);
  });

  test("затакт со сдвинутыми клетками начинается со своей первой позиции", () => {
    const offsets = [0, 0.5];
    expect(cellAtPosition(offsets, 0.1)).toBe(0);
    expect(cellAtPosition(offsets, 0.75)).toBe(1);
  });

  test("басовая струна звучит дольше дискантовой", () => {
    // Физика рояля: чем короче и тоньше струна, тем быстрее гаснет звук.
    const bass = stringDecaySeconds(36);
    const middle = stringDecaySeconds(60);
    const treble = stringDecaySeconds(96);
    expect(bass).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(treble);
    // Границы не дают ни бесконечного гула, ни щелчка вместо звука.
    expect(bass).toBeLessThanOrEqual(6);
    expect(treble).toBeGreaterThanOrEqual(0.42);
  });

  test("в среде без Web Audio проигрывание честно объявляется недоступным", () => {
    expect(audioPlaybackSupported()).toBe(typeof AudioContext !== "undefined");
  });
});
