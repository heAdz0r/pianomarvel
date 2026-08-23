/**
 * Проигрывание такта под метроном голосом рояля.
 *
 * Основной голос — локальные семплы Yamaha C5 из Salamander Grand Piano
 * (CC BY 3.0), прореженные по регистру и транспонируемые максимум на три
 * полутона. Это даёт настоящий акустический рояль без сетевой зависимости и
 * без загрузки многослойной библиотеки на сотни мегабайт.
 *
 * Синтезаторного fallback намеренно нет: если локальный семпл повреждён,
 * проигрывание не стартует и UI сообщает об ошибке. Пользователь всегда слышит
 * Grand Piano, а не неожиданную подмену инструмента.
 *
 * Музыкальное время берётся только из `AudioContext.currentTime`: таймеры
 * JS дрожат на десятки миллисекунд, и на них нельзя строить пульс
 * (Wilson C., «A Tale of Two Clocks»). Таймер здесь занимается лишь тем, что
 * заранее раскладывает следующий такт в расписание.
 */

export interface MeasurePlayerNote {
  onsetQuarters: number;
  durationQuarters: number;
  midi: number;
}

/** Клик метронома: доля такта. «Раз» звучит выше и громче. */
export interface MeasurePlayerPulse {
  onset: number;
  accent: boolean;
}

export interface MeasurePlayerPlan {
  notes: readonly MeasurePlayerNote[];
  /** Длина проигрываемого окна в четвертях: одного такта или нескольких. */
  quarters: number;
  /**
   * Клики метронома по всему окну. Задаются извне, а не выводятся из одной
   * длины доли: в окне из нескольких тактов размер может меняться.
   */
  pulses: readonly MeasurePlayerPulse[];
  /** Такт отсчёта перед началом: своя длина и свои клики. */
  countIn: { quarters: number; pulses: readonly MeasurePlayerPulse[] };
}

export type MeasurePlaybackHand = "right" | "left";

export interface MeasureWindowPlaybackNote extends MeasurePlayerNote {
  hand: MeasurePlaybackHand;
}

export interface MeasureWindowPlaybackSegment {
  /** Начало такта в четвертях от начала выбранного окна. */
  offsetQuarters: number;
  quarters: number;
  pulseLength: number;
  notes: readonly MeasureWindowPlaybackNote[];
}

export interface MeasurePlayerOptions {
  quarterBpm: number;
  loop: boolean;
  metronome: boolean;
  /** Такт клика перед началом, чтобы ученик успел вступить. */
  countIn: boolean;
}

export interface MeasurePlayerPosition {
  /** Позиция внутри такта в четвертях; во время отсчёта — отрицательная. */
  quarters: number;
  countIn: boolean;
  /** Номер доли отсчёта, 1-based; вне отсчёта — 0. */
  countInPulse: number;
}

/** Стандартный строй: A4 = 440 Гц. */
export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function secondsPerQuarter(quarterBpm: number): number {
  return 60 / Math.max(1, quarterBpm);
}

/** Доли такта в четвертях от его начала — позиции клика метронома. */
export function pulseOnsets(quarters: number, pulseLength: number): number[] {
  if (!(pulseLength > 0) || !(quarters > 0)) return [];
  const onsets: number[] = [];
  for (let onset = 0; onset < quarters - 1e-6; onset += pulseLength) {
    onsets.push(Number(onset.toFixed(6)));
  }
  return onsets;
}

/**
 * Склеивает показанные такты в один непрерывный план. Смещения остаются
 * глобальными для всего окна, поэтому звук, метроном, таблица и playhead идут
 * по одной временной оси. Предварительный отсчёт всегда занимает первый такт,
 * а не всё окно из трёх или пяти тактов.
 */
export function buildWindowPlaybackPlan(
  segments: readonly MeasureWindowPlaybackSegment[],
  enabledHands: readonly MeasurePlaybackHand[],
): MeasurePlayerPlan | undefined {
  const playable = segments.filter((segment) => segment.quarters > 0);
  if (!playable.length) return undefined;

  const enabled = new Set(enabledHands);
  const notes = playable.flatMap((segment) =>
    segment.notes
      .filter((note) => enabled.has(note.hand))
      .map((note) => ({
        onsetQuarters: Number((segment.offsetQuarters + note.onsetQuarters).toFixed(6)),
        durationQuarters: note.durationQuarters,
        midi: note.midi,
      })),
  ).sort((left, right) => left.onsetQuarters - right.onsetQuarters);
  const pulses = playable.flatMap((segment) =>
    pulseOnsets(segment.quarters, segment.pulseLength).map((onset) => ({
      onset: Number((segment.offsetQuarters + onset).toFixed(6)),
      accent: onset < 1e-6,
    })),
  );
  const first = playable[0];
  const countInPulses = pulseOnsets(first.quarters, first.pulseLength).map((onset) => ({
    onset,
    accent: onset < 1e-6,
  }));
  const quarters = Math.max(
    ...playable.map((segment) => segment.offsetQuarters + segment.quarters),
  );

  return {
    notes,
    quarters: Number(quarters.toFixed(6)),
    pulses,
    countIn: {
      quarters: first.quarters,
      pulses: countInPulses,
    },
  };
}

/**
 * Клетка сетки, внутри которой находится позиция проигрывания. Клетки заданы
 * своими началами в четвертях; последняя тянется до конца такта.
 */
export function cellAtPosition(
  cellOffsets: readonly number[],
  quarters: number,
): number {
  if (!cellOffsets.length || quarters < cellOffsets[0]) return -1;
  for (let index = cellOffsets.length - 1; index >= 0; index -= 1) {
    if (quarters >= cellOffsets[index] - 1e-6) return index;
  }
  return -1;
}

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

export function audioPlaybackSupported(): boolean {
  return audioContextConstructor() !== undefined;
}

export interface GrandPianoSample {
  midi: number;
  file: string;
}

/**
 * Один слой Salamander Grand Piano, ноты через малую терцию/тритон. Между
 * соседними корнями максимум три полутона — транспонирование остаётся
 * естественным, а локальный комплект занимает около 1.2 МБ.
 */
export const GRAND_PIANO_SAMPLES: readonly GrandPianoSample[] = [
  { midi: 21, file: "A0.mp3" },
  { midi: 27, file: "Ds1.mp3" },
  { midi: 33, file: "A1.mp3" },
  { midi: 39, file: "Ds2.mp3" },
  { midi: 45, file: "A2.mp3" },
  { midi: 51, file: "Ds3.mp3" },
  { midi: 57, file: "A3.mp3" },
  { midi: 63, file: "Ds4.mp3" },
  { midi: 69, file: "A4.mp3" },
  { midi: 75, file: "Ds5.mp3" },
  { midi: 81, file: "A5.mp3" },
  { midi: 87, file: "Ds6.mp3" },
  { midi: 93, file: "A6.mp3" },
  { midi: 99, file: "Ds7.mp3" },
  { midi: 105, file: "A7.mp3" },
  { midi: 108, file: "C8.mp3" },
] as const;

export function grandPianoSampleForMidi(midi: number): GrandPianoSample {
  return GRAND_PIANO_SAMPLES.reduce((nearest, sample) =>
    Math.abs(sample.midi - midi) < Math.abs(nearest.midi - midi) ? sample : nearest
  );
}

const LOOKAHEAD_SECONDS = 0.25;
const SCHEDULER_INTERVAL_MS = 60;
const START_DELAY_SECONDS = 0.08;

/** Время затухания струны: бас звучит секунды, дискант — доли секунды. */
export function stringDecaySeconds(midi: number): number {
  const scaled = 3.4 * 2 ** (-(midi - 60) / 26);
  return Math.min(6, Math.max(0.42, Number(scaled.toFixed(3))));
}

const SILENCE = 0.0001;

export class MeasurePlayer {
  private context?: AudioContext;
  private master?: GainNode;
  private sources: AudioScheduledSourceNode[] = [];
  /** Декодированные локальные семплы по MIDI-корню. */
  private pianoSamples = new Map<number, AudioBuffer>();
  private pianoSampleLoads = new Map<number, Promise<AudioBuffer | undefined>>();
  /** Один буфер белого шума на весь контекст: удар молоточка берётся из него. */
  private noise?: AudioBuffer;
  private scheduler?: ReturnType<typeof setInterval>;
  private plan?: MeasurePlayerPlan;
  private options?: MeasurePlayerOptions;
  private firstBarStart = 0;
  private nextBarStart = 0;
  private barSeconds = 0;
  private countInSeconds = 0;
  private scheduledBars = 0;
  private endsAt = 0;

  playing = false;

  /** Такт закончился сам (не по кнопке) — компонент снимет подсветку. */
  onFinished?: () => void;

  get quarterBpm(): number {
    return this.options?.quarterBpm ?? 0;
  }

  /**
   * Смена темпа на ходу применяется со следующего повтора: переписывать уже
   * запланированный такт означало бы слышимый рывок посередине.
   */
  setTempo(quarterBpm: number): void {
    if (this.options) this.options.quarterBpm = quarterBpm;
  }

  setLoop(loop: boolean): void {
    if (!this.options) return;
    this.options.loop = loop;
    if (loop) this.endsAt = 0;
  }

  setMetronome(metronome: boolean): void {
    if (this.options) this.options.metronome = metronome;
  }

  async start(plan: MeasurePlayerPlan, options: MeasurePlayerOptions): Promise<boolean> {
    const Constructor = audioContextConstructor();
    if (!Constructor || !(plan.quarters > 0)) return false;

    this.stop();
    if (!this.context) {
      this.context = new Constructor();
      this.noise = undefined;
    }
    const context = this.context;
    await context.resume();
    if (!await this.loadSamplesForPlan(plan)) return false;

    this.master = context.createGain();
    // Голос рояля богаче прежнего синуса, а аккорд складывает до пяти голосов:
    // мастер держим ниже, чтобы не клиппировать на forte.
    this.master.gain.value = 0.62;
    this.master.connect(context.destination);

    this.plan = plan;
    this.options = { ...options };
    this.barSeconds = plan.quarters * secondsPerQuarter(options.quarterBpm);
    this.countInSeconds = options.countIn
      ? plan.countIn.quarters * secondsPerQuarter(options.quarterBpm)
      : 0;
    this.firstBarStart = context.currentTime + START_DELAY_SECONDS + this.countInSeconds;
    this.nextBarStart = this.firstBarStart;
    this.scheduledBars = 0;
    this.endsAt = 0;
    this.playing = true;

    if (options.countIn) {
      this.scheduleCountIn(context.currentTime + START_DELAY_SECONDS);
    }
    this.pump();
    this.scheduler = setInterval(() => this.pump(), SCHEDULER_INTERVAL_MS);
    return true;
  }

  stop(): void {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = undefined;
    this.playing = false;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Узел мог уже отыграть и освободиться — это нормальное состояние.
      }
      source.disconnect();
    }
    this.sources = [];
    this.master?.disconnect();
    this.master = undefined;
    this.plan = undefined;
    this.options = undefined;
  }

  dispose(): void {
    this.stop();
    void this.context?.close();
    this.context = undefined;
  }

  position(): MeasurePlayerPosition | undefined {
    const context = this.context;
    if (!this.playing || !context || !(this.barSeconds > 0)) return undefined;
    const secondsPer = secondsPerQuarter(this.quarterBpm);
    const now = context.currentTime;
    if (now < this.firstBarStart) {
      const remaining = this.firstBarStart - now;
      const elapsedQuarters = (this.countInSeconds - remaining) / secondsPer;
      const pulses = this.plan?.countIn.pulses ?? [];
      const passed = pulses.filter((pulse) => pulse.onset <= elapsedQuarters + 1e-6).length;
      return {
        quarters: -remaining / secondsPer,
        countIn: true,
        countInPulse: Math.max(1, passed),
      };
    }
    const elapsed = (now - this.firstBarStart) % this.barSeconds;
    return { quarters: elapsed / secondsPer, countIn: false, countInPulse: 0 };
  }

  private pump(): void {
    const context = this.context;
    const plan = this.plan;
    const options = this.options;
    if (!context || !plan || !options || !this.playing) return;

    if (this.endsAt && context.currentTime >= this.endsAt) {
      const finished = this.onFinished;
      this.stop();
      finished?.();
      return;
    }

    while (
      !this.endsAt
      && this.nextBarStart < context.currentTime + LOOKAHEAD_SECONDS
    ) {
      if (this.scheduledBars >= 1 && !options.loop) {
        this.endsAt = this.nextBarStart;
        break;
      }
      // Темп мог измениться между повторами — считаем длину такта заново.
      this.barSeconds = plan.quarters * secondsPerQuarter(options.quarterBpm);
      this.scheduleBar(this.nextBarStart);
      this.scheduledBars += 1;
      this.nextBarStart += this.barSeconds;
    }
  }

  private scheduleCountIn(at: number): void {
    const plan = this.plan;
    if (!plan) return;
    const secondsPer = secondsPerQuarter(this.quarterBpm);
    for (const pulse of plan.countIn.pulses) {
      this.click(at + pulse.onset * secondsPer, pulse.accent);
    }
  }

  private scheduleBar(at: number): void {
    const plan = this.plan;
    const options = this.options;
    if (!plan || !options) return;
    const secondsPer = secondsPerQuarter(options.quarterBpm);

    if (options.metronome) {
      for (const pulse of plan.pulses) {
        this.click(at + pulse.onset * secondsPer, pulse.accent);
      }
    }
    for (const note of plan.notes) {
      this.note(
        note.midi,
        at + note.onsetQuarters * secondsPer,
        Math.max(0.1, note.durationQuarters * secondsPer),
      );
    }
  }

  private async loadSamplesForPlan(plan: MeasurePlayerPlan): Promise<boolean> {
    const roots = [...new Set(
      plan.notes.map((note) => grandPianoSampleForMidi(note.midi).midi),
    )];
    const loaded = await Promise.all(roots.map((root) => this.loadPianoSample(root)));
    return loaded.every(Boolean);
  }

  private loadPianoSample(root: number): Promise<AudioBuffer | undefined> {
    const cached = this.pianoSamples.get(root);
    if (cached) return Promise.resolve(cached);
    const pending = this.pianoSampleLoads.get(root);
    if (pending) return pending;
    const context = this.context;
    const sample = GRAND_PIANO_SAMPLES.find((candidate) => candidate.midi === root);
    if (!context || !sample) return Promise.resolve(undefined);
    const load = fetch(`/audio/grand-piano/${sample.file}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Grand Piano sample ${sample.file}: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => context.decodeAudioData(buffer))
      .then((decoded) => {
        this.pianoSamples.set(root, decoded);
        return decoded;
      })
      .catch(() => undefined);
    this.pianoSampleLoads.set(root, load);
    void load.finally(() => this.pianoSampleLoads.delete(root));
    return load;
  }

  private noiseBuffer(): AudioBuffer | undefined {
    const context = this.context;
    if (!context) return undefined;
    if (this.noise) return this.noise;
    const length = Math.max(1, Math.floor(context.sampleRate * 0.25));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      // Детерминированный шум: одинаковая атака у одинаковых нот.
      data[index] = Math.sin(index * 12.9898) * 43758.5453 % 2 - 1;
    }
    this.noise = buffer;
    return buffer;
  }

  /** Голос рояля — только локальный акустический семпл Salamander. */
  private note(midi: number, at: number, seconds: number): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const sample = grandPianoSampleForMidi(midi);
    const buffer = this.pianoSamples.get(sample.midi);
    if (!buffer) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(2 ** ((midi - sample.midi) / 12), at);
    const envelope = context.createGain();
    const held = Math.max(0.08, seconds);
    const release = 0.12;
    envelope.gain.setValueAtTime(SILENCE, at);
    envelope.gain.exponentialRampToValueAtTime(0.34, at + 0.004);
    envelope.gain.setValueAtTime(0.34, at + held);
    envelope.gain.exponentialRampToValueAtTime(SILENCE, at + held + release);
    source.connect(envelope);
    envelope.connect(master);
    source.start(at);
    source.stop(at + held + release + 0.03);
    this.sources.push(source);
  }

  /**
   * Клик метронома: деревянный, а не тональный. Узкий шумовой всплеск не спорит
   * с голосом рояля, поэтому доля слышна даже в густой фактуре.
   */
  private click(at: number, accent: boolean): void {
    const context = this.context;
    const master = this.master;
    const buffer = this.noiseBuffer();
    if (!context || !master) return;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(accent ? 0.3 : 0.17, at);
    envelope.gain.exponentialRampToValueAtTime(SILENCE, at + (accent ? 0.045 : 0.032));
    envelope.connect(master);

    if (buffer) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      const band = context.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = accent ? 2400 : 1750;
      band.Q.value = 6;
      source.connect(band);
      band.connect(envelope);
      source.start(at);
      source.stop(at + 0.08);
      this.sources.push(source);
    }

    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(accent ? 1900 : 1350, at);
    const bodyGain = context.createGain();
    bodyGain.gain.setValueAtTime(accent ? 0.12 : 0.07, at);
    bodyGain.gain.exponentialRampToValueAtTime(SILENCE, at + 0.025);
    body.connect(bodyGain);
    bodyGain.connect(envelope);
    body.start(at);
    body.stop(at + 0.05);
    this.sources.push(body);
  }
}
