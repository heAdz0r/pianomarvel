/**
 * Аудит подобранной аппликатуры: поиск физически подозрительных мест.
 *
 * Чем отличается от `fingering-bench.ts`. Бенчмарк меряет согласие с авторской
 * разметкой — это косвенная метрика: размеченных файлов мало, а печатная
 * аппликатура упражнений (Hanon) вообще является тренировочной условностью,
 * а не оптимумом. Аудит смотрит на результат напрямую и считает места, которые
 * нельзя сыграть, — по всему корпусу, включая пьесы без разметки.
 *
 * Обе метрики нужны вместе: аудит поймал повтор большого пальца в арпеджио,
 * который бенчмарк не видел вовсе, а бенчмарк удерживает школьный канон,
 * который аудит проверить не умеет.
 *
 * Пример:
 *   bun run audit:fingering -- ~/Downloads/musescore_sheets
 *
 * Скрипт ничего не пишет: только читает партитуры и печатает отчёт.
 */

import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

import { planFingering } from "./fingering";
import { readScoreContainer, stripAlternativeFingering, stripFingering } from "./fingering-xml";
import { isPlayable, parseScore, type ParsedNote } from "./fingering-score";
import { isBlackKey, type Finger, type Hand } from "./fingering-model";

const SCORE_EXTENSIONS = new Set([".mxl", ".musicxml", ".xml"]);

/** Пороги детекторов. Каждый — физический, а не подогнанный под корпус. */
export const AUDIT = {
  /**
   * Медленнее этого рука успевает переставиться, и повтор пальца перестаёт
   * быть дефектом. 0.5 с — два звука в секунду.
   */
  mustStayIpi: 0.5,
  /** Шире квинты рука переносится целиком, повтор пальца там норма. */
  leapSemitones: 7,
  /** Пауза, после которой рука свободна. */
  freeGap: 0.9,
  /** Быстрее этого чередование слабой пары 3-4/4-5 физически ненадёжно. */
  weakPairIpi: 0.11,
  /** Быстрее этого большой палец на чёрной клавише становится тормозом. */
  thumbBlackIpi: 0.13,
  /** Короче этого отрезок не считается самостоятельным повторяющимся тактом. */
  minSegment: 3,
} as const;

export interface AuditHit {
  kind: string;
  where: string;
  detail: string;
}

export interface AuditRow {
  path: string;
  tempo?: number;
  notes: number;
  hits: AuditHit[];
}

const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const noteName = (midi: number): string =>
  `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

async function scoreFiles(inputs: string[]): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) {
        // Каталог `fingered/` — производные того же исходника: аудит по ним
        // удвоил бы каждую находку.
        if (entry === "fingered" || entry.startsWith(".")) continue;
        await visit(join(path, entry));
      }
      return;
    }
    if (SCORE_EXTENSIONS.has(extname(path).toLowerCase())) found.push(path);
  };
  for (const input of inputs) await visit(input);
  return found.sort();
}

/** Секунды между атаками по расстоянию в четвертях и темпу. */
function seconds(quarters: number, tempo?: number): number | undefined {
  return tempo && tempo > 0 ? (quarters * 60) / tempo : undefined;
}

export async function auditFingering(inputs: string[]): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];

  for (const path of await scoreFiles(inputs)) {
    const container = await readScoreContainer(path);
    const xml = stripFingering(stripAlternativeFingering(container.xml));
    const plan = planFingering(xml, { mode: "rebuild" });
    const score = parseScore(xml);
    const hits: AuditHit[] = [];

    // Форшлаги и продолжения лиги не являются атаками: палец у них
    // унаследованный, сравнивать его с соседями бессмысленно.
    const playable = score.notes.filter(
      (note) => isPlayable(note) && !note.grace && !(note.tieStop && !note.tieStart),
    );

    const byHand = new Map<Hand, ParsedNote[]>([
      ["R", []],
      ["L", []],
    ]);
    for (const note of playable) {
      const hand = plan.hands.get(note.index);
      if (hand) (byHand.get(hand) as ParsedNote[]).push(note);
    }

    for (const [hand, notes] of byHand) {
      if (notes.length === 0) continue;

      const buckets = new Map<string, ParsedNote[]>();
      for (const note of notes) {
        const key = note.onset.toFixed(4);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(note);
        else buckets.set(key, [note]);
      }
      const events = [...buckets.keys()]
        .sort((left, right) => Number(left) - Number(right))
        .map((key) =>
          (buckets.get(key) as ParsedNote[])
            .slice()
            .sort((left, right) => (left.midi as number) - (right.midi as number)),
        );

      for (let index = 1; index < events.length; index += 1) {
        const previous = events[index - 1];
        const current = events[index];
        const ipi = seconds(current[0].onset - previous[0].onset, current[0].tempo);
        const gap =
          current[0].onset - (previous[0].onset + Math.max(...previous.map((n) => n.duration)));
        if (gap > AUDIT.freeGap) continue;

        // Перекрещивание пальцев внутри одной вертикали. Раздельные голоса
        // с общим onset передаются под педаль и могут делить палец.
        for (let i = 0; i + 1 < current.length; i += 1) {
          const low = plan.assignments.get(current[i].index);
          const high = plan.assignments.get(current[i + 1].index);
          if (low === undefined || high === undefined) continue;
          if (current[i].voice !== current[i + 1].voice) continue;
          if (current[i].midi === current[i + 1].midi) continue;
          if (hand === "R" ? low < high : low > high) continue;
          hits.push({
            kind: "перекрещивание в аккорде",
            where: `т.${current[i].measureNumber} ${hand}`,
            detail: `${noteName(current[i].midi as number)}:${low} / ${noteName(current[i + 1].midi as number)}:${high}`,
          });
        }

        // Повтор пальца в МЕЛОДИЧЕСКОЙ линии. Смена одного аккорда другим —
        // законный перенос формы руки, там повтор нормален. Дефект только
        // когда рука обязана стоять: обе вертикали одноголосны, либо движется
        // ровно один голос, а остальные держатся на месте.
        const held = new Set<number>();
        for (const a of previous) {
          for (const b of current) if (a.midi === b.midi) held.add(a.midi as number);
        }
        const moving = current.filter((n) => !held.has(n.midi as number)).length;
        const melodic =
          (previous.length === 1 && current.length === 1) ||
          (held.size > 0 && moving <= 1 && previous.length - held.size <= 1);
        const mustStay = ipi === undefined || ipi <= AUDIT.mustStayIpi;

        if (melodic && mustStay) {
          for (const a of previous) {
            for (const b of current) {
              const finger = plan.assignments.get(a.index);
              if (finger === undefined || finger !== plan.assignments.get(b.index)) continue;
              if (a.midi === b.midi || a.voice !== b.voice) continue;
              if (held.has(a.midi as number) || held.has(b.midi as number)) continue;
              const from = a.midi as number;
              const to = b.midi as number;
              // Скольжение с чёрной на белую тем же пальцем — приём, не дефект.
              if (Math.abs(to - from) <= 2 && isBlackKey(from) && !isBlackKey(to)) continue;
              if (Math.abs(to - from) > AUDIT.leapSemitones) continue;
              hits.push({
                kind: "повтор пальца в линии",
                where: `т.${b.measureNumber} ${hand}`,
                detail:
                  `${noteName(from)}→${noteName(to)} палец ${finger}` +
                  (ipi ? `, ${Math.round(ipi * 1000)} мс` : ""),
              });
            }
          }
        }

        if (ipi !== undefined && previous.length === 1 && current.length === 1) {
          const before = plan.assignments.get(previous[0].index) as Finger;
          const after = plan.assignments.get(current[0].index) as Finger;
          const weakPair =
            (before === 4 && after === 5) ||
            (before === 5 && after === 4) ||
            (before === 3 && after === 4) ||
            (before === 4 && after === 3);
          const step = Math.abs((current[0].midi as number) - (previous[0].midi as number));
          if (ipi < AUDIT.weakPairIpi && weakPair && step <= 2) {
            hits.push({
              kind: "слабая пара в быстром чередовании",
              where: `т.${current[0].measureNumber} ${hand}`,
              detail: `${before}-${after}, ${Math.round(ipi * 1000)} мс`,
            });
          }
        }

        if (ipi !== undefined && ipi < AUDIT.thumbBlackIpi) {
          for (const note of current) {
            if (plan.assignments.get(note.index) !== 1) continue;
            if (!isBlackKey(note.midi as number)) continue;
            hits.push({
              kind: "большой на чёрной в быстром месте",
              where: `т.${note.measureNumber} ${hand}`,
              detail: `${noteName(note.midi as number)}, ${Math.round(ipi * 1000)} мс`,
            });
          }
        }
      }

      // Одинаковый материал с разной аппликатурой: такт группируется по
      // относительным долям и высотам, а сравниваются проставленные пальцы.
      const perMeasure = new Map<number, ParsedNote[]>();
      for (const note of notes) {
        const bucket = perMeasure.get(note.measureIndex);
        if (bucket) bucket.push(note);
        else perMeasure.set(note.measureIndex, [note]);
      }
      const shapes = new Map<string, Array<{ fingers: string; number: string }>>();
      for (const bucket of perMeasure.values()) {
        if (bucket.length < AUDIT.minSegment) continue;
        const ordered = bucket
          .slice()
          .sort((a, b) => a.onset - b.onset || (a.midi as number) - (b.midi as number));
        const base = ordered[0].onset;
        const shape = ordered
          .map((note) => `${(note.onset - base).toFixed(3)}:${note.midi}`)
          .join(",");
        const fingers = ordered.map((note) => plan.assignments.get(note.index) ?? "-").join(",");
        const list = shapes.get(shape);
        const entry = { fingers, number: ordered[0].measureNumber };
        if (list) list.push(entry);
        else shapes.set(shape, [entry]);
      }
      for (const list of shapes.values()) {
        if (list.length < 2) continue;
        const variants = new Set(list.map((item) => item.fingers));
        if (variants.size < 2) continue;
        hits.push({
          kind: "одинаковые такты — разная аппликатура",
          where: `${hand} т.${list.map((item) => item.number).join("/")}`,
          detail: `${variants.size} варианта: ${[...variants].slice(0, 2).join("  |  ")}`,
        });
      }
    }

    if (plan.suppressed.size > 0) {
      hits.push({ kind: "не напечатано", where: "—", detail: `${plan.suppressed.size} нот` });
    }
    for (const warning of plan.report.warnings) {
      hits.push({ kind: "предупреждение", where: "—", detail: warning });
    }

    rows.push({ path, tempo: score.defaultTempo, notes: playable.length, hits });
  }

  return rows;
}

if (import.meta.main) {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error("Укажите файл или каталог с партитурами.");
    process.exit(1);
  }
  const rows = await auditFingering(inputs);

  const totals = new Map<string, number>();
  for (const row of rows) {
    for (const hit of row.hits) totals.set(hit.kind, (totals.get(hit.kind) ?? 0) + 1);
  }

  console.log("=== СВОДКА ПО ТИПАМ ===");
  for (const [kind, count] of [...totals].sort((left, right) => right[1] - left[1])) {
    console.log(String(count).padStart(6), kind);
  }

  console.log("\n=== ПО ПЬЕСАМ ===");
  for (const row of rows.slice().sort((left, right) => right.hits.length - left.hits.length)) {
    if (row.hits.length === 0) continue;
    console.log(
      `\n${String(row.hits.length).padStart(4)}  ${row.path}  (${row.notes} нот, ♩=${row.tempo ?? "?"})`,
    );
    const byKind = new Map<string, AuditHit[]>();
    for (const hit of row.hits) {
      const list = byKind.get(hit.kind);
      if (list) list.push(hit);
      else byKind.set(hit.kind, [hit]);
    }
    for (const [kind, list] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`      ${String(list.length).padStart(4)} ${kind}`);
      for (const hit of list.slice(0, 3)) console.log(`           ${hit.where}  ${hit.detail}`);
    }
  }
}
