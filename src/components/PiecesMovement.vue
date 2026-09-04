<script setup lang="ts">
import "../styles/library.css";
import "../styles/table.css";
import { computed, defineAsyncComponent, onUnmounted, reactive, ref, watch } from "vue";
import {
  FlexRender,
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useVueTable,
  type ColumnFiltersState,
  type PaginationState,
  type SortingState,
  type Updater,
} from "@tanstack/vue-table";
import UiIcon from "./UiIcon.vue";
import ModeSwitch from "./ModeSwitch.vue";
import { chooseNativeFile, requestJson } from "../api";
import { LatestRequest } from "../latest-request";
import {
  ADAPTIVE_PREVIEW_STRATEGY,
  adaptivePreviewUnavailable,
} from "../learning-actions";
import {
  queueFailureResult,
  sortBulkLearningResults,
  type BulkLearningResult,
} from "../learning-report";
import { shouldApplyLearningStatus } from "../learning-status";
import type {
  CachedPiecesResponse,
  AdaptivePlanSummary,
  FingeringReport,
  FingeringTrace,
  LearningJob,
  LearningStrategy,
  LearningStatus,
  UploadedPiece,
} from "../ui-types";

type LearningState =
  | "unknown"
  | "checking"
  | "running"
  | "ok"
  | "warning"
  | "missing"
  | "failed";
type PieceRow = UploadedPiece & { learningState: LearningState };
type ToastTone = "progress" | "success" | "error";

interface StatusToast {
  pieceId: number;
  title: string;
  message: string;
  tone: ToastTone;
  progress: number;
}

const props = defineProps<{ loggedIn: boolean }>();
const FingeringScore = defineAsyncComponent(() => import("./FingeringScore.vue"));
const pieces = ref<UploadedPiece[]>([]);
const loading = ref(false);
const refreshingCatalog = ref(false);
const checkingAll = ref(false);
const bulkQueuing = ref(false);
const checkedCount = ref(0);
const inspectionTotal = ref(0);
const error = ref("");
const statusError = ref("");
const queryInput = ref("");
const query = ref("");
const searchPending = ref(false);
const genreFilter = ref("");
const statusFilter = ref("");
const learningStrategy = ref<LearningStrategy>("adaptive");
// CHANGED: детали способа обучения свёрнуты по умолчанию
const learnDetailsOpen = ref(false);
const sorting = ref<SortingState>([]);
const columnFilters = ref<ColumnFiltersState>([]);
const pagination = ref<PaginationState>({ pageIndex: 0, pageSize: 32 });
const catalogUpdatedAt = ref("");
const statusToast = ref<StatusToast | null>(null);
const jobs = reactive<Record<number, LearningJob>>({});
const statuses = reactive<Record<number, LearningStatus>>({});
const checking = reactive<Record<number, boolean>>({});
const attachingSource = reactive<Record<number, boolean>>({});
const confirmed = reactive<Record<number, boolean>>({});
const inspectionErrors = reactive<Record<number, string>>({});
const checkedAt = reactive<Record<number, string>>({});
// CHANGED: раскрытие полного лога ошибки построчно (per-piece) для удобного дебага
const expandedLogs = reactive<Record<number, boolean>>({});
const expandedPlan = reactive<Record<number, boolean>>({});
const planPreviews = reactive<Record<number, AdaptivePlanSummary>>({});
const previewingPlan = reactive<Record<number, boolean>>({});
const planErrors = reactive<Record<number, string>>({});

/* CHANGED: вкладка «Аппликатура» в панели композиции (docs/fingering-prd.md §9.2).
   Анализ ничего не пишет на диск, сборка создаёт отдельный .mxl. */
type PanelTab = "plan" | "fingering";
type FingeringMode = "fill" | "rebuild";
type PianoMarvelScoreSource = "original" | "fingered";
const panelTab = reactive<Record<number, PanelTab>>({});
const fingeringReports = reactive<Record<number, FingeringReport>>({});
const fingeringTraces = reactive<Record<number, FingeringTrace[]>>({});
const fingeringPreviews = reactive<Record<number, string>>({});
const fingeringBusy = reactive<Record<number, string>>({});
const fingeringErrors = reactive<Record<number, string>>({});
const fingeringBuilds = reactive<Record<
  number,
  { path: string; uploadPath: string; mode: FingeringMode; editor?: string }
>>({});
const fingeringOpening = reactive<Record<number, boolean>>({});
const scoreUpdateChoice = reactive<Record<number, boolean>>({});
const scoreUpdating = reactive<Record<number, PianoMarvelScoreSource>>({});
const selectedMeasure = reactive<Record<number, number>>({});
const selectedNote = reactive<Record<number, number>>({});
/** Сколько тактов показывать в партитуре: одному ученику удобнее видеть фразу. */
const MEASURE_SPANS = [1, 3, 5] as const;
const selectedSpan = reactive<Record<number, number>>({});
/**
 * Размер кисти. Таблицы растяжений Parncutt рассчитаны на среднюю руку, а
 * статья прямо разрешает масштабировать их для меньшей; ученику это важнее
 * любой средней статистики, поэтому выбор живёт в UI, а не в конфиге.
 */
const HAND_SPANS = [
  { value: "small", label: "Небольшая", hint: "октава даётся с трудом" },
  { value: "medium", label: "Средняя", hint: "октава берётся спокойно" },
  { value: "large", label: "Крупная", hint: "нона и децима доступны" },
] as const;
type HandSpanValue = (typeof HAND_SPANS)[number]["value"];
const selectedHandSpan = reactive<Record<number, HandSpanValue>>({});
const handRulesOpen = reactive<Record<number, boolean>>({});
const focusScores = reactive<Record<number, boolean>>({});

const bulkReport = ref<BulkLearningResult[]>([]);
const bulkReportExpanded = ref(false);
let searchTimer: number | undefined;
let inspectionRun = 0;
let toastCloseTimer: number | undefined;
const toastStageTimers = new Set<number>();
const confirmationTimers = new Map<number, number>();
const watchedJobs = new Set<string>();
const catalogRequest = new LatestRequest();
let disposed = false;

// CHANGED: описания режимов вынесены в данные — разметка перестала дублироваться
interface LearnModeSignal {
  tag: string;
  title: string;
  text: string;
  help: string;
}
interface LearnModeInfo {
  label: string;
  eyebrow: string;
  title: string;
  titleAccent: string;
  lead: string;
  chips: string[];
  signals: LearnModeSignal[];
}

const LEARNING_MODE_OPTIONS: Array<{
  value: LearningStrategy;
  label: string;
  icon: "spark" | "eye";
}> = [
  { value: "adaptive", label: "Adaptive", icon: "spark" },
  { value: "predict", label: "Predict", icon: "eye" },
];

const learningModes: Record<LearningStrategy, LearnModeInfo> = {
  adaptive: {
    label: "Adaptive",
    eyebrow: "Adaptive MusicXML + Fingering Compiler",
    title: "Партитура становится",
    titleAccent: "маршрутом и моторным планом.",
    lead:
      "Форма, метр и фразовые окончания выводятся из самой музыки — высот, ритма, " +
      "гармонии и повторности. Отдельный Fingering Compiler проверяет физику рук, " +
      "педаль и педагогические паттерны, а затем добавляет недостающие цифры в новый MXL.",
    chips: ["8 слоёв маршрута", "Fingering Compiler", "корпус 21 партитура"],
    // CHANGED: восемь слоёв вместо четырёх — L0…L7 из docs/adaptive-learning.md
    signals: [
      {
        tag: "L0 / FORM",
        title: "Разметка автора",
        text: "репризы, вольты, rehearsal, двойные черты, segno и coda",
        help:
          "Читает явные знаки, оставленные автором: повторы, окончания-вольты, названия разделов и переходы. Они помогают не разрезать упражнение посреди задуманной формы.",
      },
      {
        tag: "L1 / MELODY",
        title: "Мелодический рельеф",
        text: "ведущий голос, интервалы, длительности и паузы мелодии",
        help:
          "Ищет места, где мелодия естественно заканчивает мысль: делает паузу, длинную ноту или заметный поворот. Внутри используется LBDM — оценка силы границы по изменениям высоты и времени между нотами.",
      },
      {
        tag: "L2 / HARMONY",
        title: "Каденции",
        text: "тональность, аккорды и устойчивость гармонического окончания",
        help:
          "Каденция — гармоническая «точка» или «запятая». Устойчивое окончание подходит для конца упражнения, промежуточное — для короткой остановки, а незавершённое просит продолжения.",
      },
      {
        tag: "L3 / REPETITION",
        title: "Повторность и форма",
        text: "самоподобие тактов, новизна Foote, точные и нечёткие возвраты",
        help:
          "Сравнивает такты между собой и находит куплеты, припевы, вариации и возвращения знакомого материала. Это помогает строить упражнения по частям формы, а не по случайному числу тактов.",
      },
      {
        tag: "L4 / HYPERMETER",
        title: "Период и фаза",
        text: "сетка самой пьесы вместо правила «каждые четыре такта»",
        help:
          "Определяет крупный ритмический цикл пьесы — например, опору каждые 4 или 8 тактов — и где этот цикл начинается. Границы на таких опорах обычно легче запоминать и соединять.",
      },
      {
        tag: "L5 / MOTOR",
        title: "Пианистическая цена",
        text: "растяжка, полиритм, чёрные клавиши, перенос рук, знакомый материал",
        help:
          "Оценивает практическую сложность для рук: скачки, растяжку, плотные аккорды, полиритм и смену позиции. Сложный жест старается оставить целиком и дать ему достаточно времени.",
      },
      {
        tag: "L6 / EXPRESSION",
        title: "Исполнительский жест",
        text: "rall. и a tempo, metronome с порогом, педаль, штрих, динамика",
        help:
          "Следит за цельными выразительными жестами: замедлением, возвращением темпа, crescendo, педалью и штрихом. Упражнение не должно обрываться внутри такого движения.",
      },
      {
        tag: "L7 / NAVIGATION",
        title: "Порядок исполнения",
        text: "развёртывание реприз, вольт, D.S., D.C. и To Coda",
        help:
          "Восстанавливает реальный маршрут исполнения с повторами и переходами. Так фраза не перескакивает через D.S., D.C., Fine, Coda или альтернативное окончание.",
      },
    ],
  },
  predict: {
    label: "Predict",
    eyebrow: "Classic baseline · Piano Marvel",
    title: "Штатная модель",
    titleAccent: "последовательных проходов.",
    lead:
      "Сайт сам предлагает следующий фрагмент. MusicXML не нужен, но границы остаются " +
      "чёрным ящиком, а полная сборка требует серии Predict-проходов.",
    chips: ["MusicXML не нужен", "границы скрыты", "серия проходов"],
    signals: [
      {
        tag: "01 / SOURCE",
        title: "Работает без партитуры",
        text: "достаточно данных Piano Marvel, локальный MusicXML не требуется",
        help:
          "Predict получает следующий фрагмент от Piano Marvel и не анализирует локальный нотный файл. Это удобно, когда MusicXML отсутствует.",
      },
      {
        tag: "02 / BOUNDARIES",
        title: "Границы — чёрный ящик",
        text: "неизвестно, где алгоритм считает фразу законченной",
        help:
          "Piano Marvel возвращает готовый результат, но не объясняет, почему упражнение начинается и заканчивается именно в этих тактах.",
      },
      {
        tag: "03 / COST",
        title: "Несколько проходов",
        text: "Chopped собирается серией запросов, а не одним расчётом",
        help:
          "Для полной схемы требуется несколько последовательных запросов Predict. Adaptive рассчитывает весь план локально до отправки.",
      },
    ],
  },
};

const fingeringCompilerSignals: LearnModeSignal[] = [
  {
    tag: "F1 / HANDS",
    title: "Руки и голоса",
    text: "staff, voice, cross-staff и только доказуемый перенос крайней ноты",
    help:
      "Сначала определяется реальная исполнительская рука. Голос, перенесённый на другой нотоносец, не меняет руку; короткое неиграбельное двухзвучие передаёт крайнюю ноту другой руке только при единственном строгом решении.",
  },
  {
    tag: "F2 / PHYSICS",
    title: "Физическая форма",
    text: "таблицы растяжений Parncutt, 12 правил и строгие вертикали",
    help:
      "Каждый аккорд и связный переход проходит таблицы допустимых растяжений. Невозможная форма не получает красивую, но ложную цифру; педаль и роль голоса учитываются отдельно.",
  },
  {
    tag: "F3 / SCHOOL",
    title: "Педагогический рисунок",
    text: "гаммы, арпеджио, Hanon, Альберти и повторяющиеся фигуры",
    help:
      "После физической проверки школьные паттерны удерживают канонические группы пальцев. Это не хардкод произведений: фигура распознаётся по высотам, ритму, тональности и повторности.",
  },
  {
    tag: "F4 / DELIVERY",
    title: "Проверка и доставка",
    text: "реальный нотный стан → один fingered MXL → Piano Marvel",
    help:
      "OSMD показывает исходную MusicXML-нотацию с цифрами. Одна CTA пересобирает актуальный fingered MXL и заменяет им нотный файл композиции; канонический исходник остаётся нетронутым.",
  },
];
const adaptiveSteps = [
  {
    index: "01",
    name: "Phrase",
    desc: "мысль, закрытая каденцией или паузой",
    help:
      "Phrase — короткий самостоятельный музыкальный фрагмент. С него удобно начинать: начало и конец ощущаются естественно, поэтому материал легче запомнить.",
  },
  {
    index: "02",
    name: "Bridge",
    desc: "стык и переход как отдельный навык",
    help:
      "Bridge отдельно тренирует переход между двумя соседними фразами. Он нужен, чтобы руки не останавливались на уже знакомой границе.",
  },
  {
    index: "03",
    name: "Review",
    desc: "целые фразы в пределах раздела",
    help:
      "Review объединяет несколько освоенных фраз внутри одного раздела. Это проверка памяти и устойчивости без нагрузки всей пьесы сразу.",
  },
  {
    index: "04",
    name: "Summarize",
    desc: "крупные части по швам формы",
    help:
      "Summarize собирает материал в несколько крупных частей — например, куплет, припев и финал. Здесь отрабатывается длинная музыкальная логика.",
  },
  {
    index: "05",
    name: "Whole",
    desc: "исполнение полной формы",
    help:
      "Whole — полный прогон произведения после освоения фраз, связок и крупных частей.",
  },
];
// CHANGED: таксономия переходов Bridge — ASCII-коды совпадают с заголовками упражнений
const adaptiveTransitions = [
  {
    code: "meter",
    label: "смена размера",
    required: true,
    help: "Тренирует переход, где меняется счёт долей — например, с 4/4 на 3/4.",
  },
  {
    code: "nav",
    label: "вольта, D.S., To Coda",
    required: true,
    help: "Отрабатывает прыжок по нотному маршруту: повтор, другую вольту, D.S., D.C. или переход к Coda.",
  },
  {
    code: "stop",
    label: "возврат после остановки",
    required: true,
    help: "Учит уверенно продолжать после ферматы, цезуры, Fine или полной паузы.",
  },
  {
    code: "tempo",
    label: "rall., a tempo, новый темп",
    required: true,
    help: "Сохраняет контроль при замедлении, ускорении или возвращении к исходному темпу.",
  },
  {
    code: "key",
    label: "модуляция",
    required: false,
    help: "Тренирует переход в другую тональность, где меняются привычные ноты и аппликатура.",
  },
  {
    code: "hands",
    label: "перенос рук и ключа",
    required: false,
    help: "Выделяет место со скачком, сменой позиции руки или нотного ключа.",
  },
  {
    code: "poly",
    label: "смена ритмического деления",
    required: false,
    help: "Помогает переключиться между ровным делением, триолями и полиритмом.",
  },
  {
    code: "artic",
    label: "смена штриха",
    required: false,
    help: "Отрабатывает переход между legato, staccato и другими способами звукоизвлечения.",
  },
  {
    code: "pedal",
    label: "смена педализации",
    required: false,
    help: "Тренирует точное снятие и новое нажатие педали без грязного смешивания гармоний.",
  },
  {
    code: "voices",
    label: "плотность голосов",
    required: false,
    help: "Готовит руки к месту, где появляется больше одновременных голосов или аккордов.",
  },
  {
    code: "orn",
    label: "вход в орнамент",
    required: false,
    help: "Отдельно отрабатывает вход в трель, форшлаг или другое украшение.",
  },
  {
    code: "tech",
    label: "арпеджио и глиссандо",
    required: false,
    help: "Выделяет технический жест, который лучше освоить целиком, не разрезая посередине.",
  },
  {
    code: "dyn",
    label: "динамический контраст",
    required: false,
    help: "Тренирует заметную смену громкости и характер атаки между соседними фрагментами.",
  },
  {
    code: "texture",
    label: "смена фактуры",
    required: false,
    help: "Помогает переключиться, например, с аккордов на мелодию с аккомпанементом.",
  },
];
// Технический код остаётся доступен, но главным становится понятное пользователю
// название и объяснение влияния на практику.
const ADAPTIVE_METRIC_HELP = {
  closure: {
    code: "closure",
    title: "Завершённость фраз",
    target: "≥ 0.80",
    label: "границ в естественных окончаниях",
    help:
      "Показывает, как часто упражнения заканчиваются там, где музыка сама «ставит точку»: на каденции, паузе, окончании лиги или разделе. Ближе к 1 — лучше; ниже 0,80 означает риск неестественно оборванных фраз.",
  },
  hypermeter: {
    code: "hypermeter",
    title: "Ритмическая опора",
    target: "≥ 0.85",
    label: "границ на сильной опоре периода",
    help:
      "Показывает, сколько границ совпало с крупным ритмическим циклом пьесы — например, с началом каждой четвёрки тактов. Высокое значение делает фрагменты предсказуемее и легче для памяти.",
  },
  sections: {
    code: "sections",
    title: "Охват формы",
    target: "1.00",
    label: "крупных разделов учтено",
    help:
      "Показывает, учёл ли план границы куплетов, припевов и других крупных частей. 1,00 означает, что каждый найденный шов формы стал границей упражнения.",
  },
  durCV: {
    code: "durCV",
    title: "Ровность длины",
    target: "≤ 0.35",
    label: "разброс длительности фрагментов",
    help:
      "Показывает, насколько сильно различается длина фраз. 0 — все примерно одинаковые; до 0,35 обычно удобно. Высокое значение означает, что рядом стоят слишком короткие и слишком длинные упражнения, поэтому нагрузка ощущается рваной.",
  },
  forced: {
    code: "forced",
    title: "Чистота разрезов",
    target: "≤ 0.02",
    label: "разрезов внутри цельного жеста",
    help:
      "Доля границ, поставленных внутри связанной ноты, фразы, педального или выразительного жеста. Чем ближе к 0, тем реже упражнение обрывает движение рук или музыкальную линию.",
  },
  navigation: {
    code: "navigation",
    title: "Порядок исполнения",
    target: "0",
    label: "фраз поверх нотного перехода",
    help:
      "Считает фразы, которые случайно пересекают повтор, вольту, D.S., D.C., Fine или Coda. Хорошее значение — 0: каждый переход тренируется отдельно и в правильном порядке.",
  },
} as const;
const adaptiveMetrics = Object.values(ADAPTIVE_METRIC_HELP);
const adaptiveSources = [
  {
    label: "MusicXML 4.0",
    href: "https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/direction/",
  },
  {
    label: "Cambouropoulos · LBDM",
    href: "https://www.ofai.at/papers/oefai-tr-2001-11.pdf",
  },
  {
    label: "Foote · self-similarity",
    href: "https://www.researchgate.net/publication/200806134_Visualizing_Musical_Structure_and_Rhythm_via_Self-Similarity",
  },
  {
    label: "Caplin · период и каденция",
    href: "https://en.wikipedia.org/wiki/Period_%28music%29",
  },
  {
    label: "Cadence detection · ISMIR",
    href: "https://arxiv.org/abs/2208.14819",
  },
  {
    label: "Chuan & Chew",
    href: "https://kclpure.kcl.ac.uk/portal/en/publications/a-dynamic-programming-approach-to-the-extraction-of-phrase-bounda/",
  },
  {
    label: "Chaffin & Imreh",
    href: "https://musiclab.uconn.edu/wp-content/uploads/sites/290/2013/10/Practicing-Perfection-Chaffin-2002.pdf",
  },
  { label: "Shih et al.", href: "https://pmc.ncbi.nlm.nih.gov/articles/PMC12816802/" },
  {
    label: "Interleaved practice",
    href: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4989027/",
  },
];
const activeLearningMode = computed(() => learningModes[learningStrategy.value]);

function goToFingeringWorkbench(): void {
  const target = document.querySelector<HTMLElement>(".piece-fingering-link");
  if (!target) return;
  target.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
    block: "center",
  });
  target.focus({ preventScroll: true });
}

function learningState(pieceId: number): LearningState {
  const job = jobs[pieceId];
  if (job?.state === "queued" || job?.state === "running") return "running";
  if (job?.state === "failed") return "failed";
  if (inspectionErrors[pieceId]) return "failed";
  return statuses[pieceId]?.classification ?? "unknown";
}

const tableData = computed<PieceRow[]>(() =>
  pieces.value
    .map((piece) => ({ ...piece, learningState: learningState(piece.id) }))
    .sort((left, right) => right.id - left.id),
);

const genres = computed(() =>
  Array.from(new Set(pieces.value.flatMap((piece) => piece.genres))).sort((a, b) =>
    a.localeCompare(b),
  ),
);

const columnHelper = createColumnHelper<PieceRow>();
const columns = [
  columnHelper.accessor("title", { header: "Композиция" }),
  columnHelper.accessor("genres", {
    header: "Жанр",
    enableSorting: false,
    filterFn: (row, _columnId, value: string) => !value || row.original.genres.includes(value),
  }),
  columnHelper.accessor("difficulty", { header: "Сложность" }),
  columnHelper.accessor("learningState", {
    header: "Обучение",
    filterFn: (row, _columnId, value: LearningState | "") =>
      !value || row.original.learningState === value,
  }),
  columnHelper.display({ id: "actions", header: "Действия" }),
];

function updateRef<T>(target: { value: T }, updater: Updater<T>) {
  target.value =
    typeof updater === "function" ? (updater as (current: T) => T)(target.value) : updater;
}

const table = useVueTable({
  data: tableData,
  columns,
  getCoreRowModel: getCoreRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
  getSortedRowModel: getSortedRowModel(),
  getPaginationRowModel: getPaginationRowModel(),
  // Статус строки — это обновление данных, а не новый набор результатов.
  // TanStack иначе молча возвращает пользователя на первую страницу.
  autoResetPageIndex: false,
  globalFilterFn: (row, _columnId, value) => {
    const needle = String(value ?? "").trim().toLocaleLowerCase();
    if (!needle) return true;
    return [
      row.original.id,
      row.original.title,
      row.original.artist,
      row.original.composer,
      ...row.original.genres,
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle);
  },
  state: {
    get sorting() {
      return sorting.value;
    },
    get globalFilter() {
      return query.value;
    },
    get columnFilters() {
      return columnFilters.value;
    },
    get pagination() {
      return pagination.value;
    },
  },
  onSortingChange: (updater) => updateRef(sorting, updater),
  onColumnFiltersChange: (updater) => updateRef(columnFilters, updater),
  onPaginationChange: (updater) => updateRef(pagination, updater),
});

const pageSummary = computed(() => {
  query.value;
  columnFilters.value;
  pagination.value;
  tableData.value;
  const total = table.getFilteredRowModel().rows.length;
  const shown = table.getRowModel().rows.length;
  const start = total === 0 ? 0 : pagination.value.pageIndex * pagination.value.pageSize + 1;
  return { total, shown, start, end: start + Math.max(0, shown - 1) };
});

watch([query, genreFilter, statusFilter], () => table.setPageIndex(0));
watch(queryInput, (value) => {
  searchPending.value = true;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    query.value = value;
    searchPending.value = false;
  }, 120);
});
watch(genreFilter, (value) => table.getColumn("genres")?.setFilterValue(value || undefined));
watch(statusFilter, (value) =>
  table.getColumn("learningState")?.setFilterValue(value || undefined),
);

watch(
  () => props.loggedIn,
  () => {
    if (pieces.value.length === 0) void loadPieces();
  },
  { immediate: true },
);

onUnmounted(() => {
  disposed = true;
  inspectionRun += 1;
  catalogRequest.cancel();
  if (searchTimer) clearTimeout(searchTimer);
  if (toastCloseTimer) clearTimeout(toastCloseTimer);
  toastStageTimers.forEach((timer) => clearTimeout(timer));
  confirmationTimers.forEach((timer) => clearTimeout(timer));
});

function clearToastTimers() {
  if (toastCloseTimer) {
    clearTimeout(toastCloseTimer);
    toastCloseTimer = undefined;
  }
  toastStageTimers.forEach((timer) => clearTimeout(timer));
  toastStageTimers.clear();
}

function updateToastStage(pieceId: number, delay: number, message: string, progress: number) {
  const timer = window.setTimeout(() => {
    toastStageTimers.delete(timer);
    if (statusToast.value?.pieceId !== pieceId || statusToast.value.tone !== "progress") return;
    statusToast.value = { ...statusToast.value, message, progress };
  }, delay);
  toastStageTimers.add(timer);
}

function beginStatusToast(piece: UploadedPiece) {
  clearToastTimers();
  statusToast.value = {
    pieceId: piece.id,
    title: piece.title,
    message: "Подключаюсь к Piano Marvel…",
    tone: "progress",
    progress: 16,
  };
  updateToastStage(piece.id, 450, "Читаю Whole, Chopped и Minced…", 48);
  updateToastStage(piece.id, 1100, "Сверяю обучение с целевым алгоритмом…", 74);
  updateToastStage(piece.id, 1900, "Сохраняю актуальный статус в SQLite…", 90);
}

function finishStatusToast(piece: UploadedPiece, state: LearningState, checkedAtValue: string) {
  clearToastTimers();
  statusToast.value = {
    pieceId: piece.id,
    title: piece.title,
    message: `${statusLabel(state)} · ${formatCacheTime(checkedAtValue)}`,
    tone: "success",
    progress: 100,
  };
  toastCloseTimer = window.setTimeout(() => {
    statusToast.value = null;
    toastCloseTimer = undefined;
  }, 3200);
}

function failStatusToast(piece: UploadedPiece, caught: unknown) {
  clearToastTimers();
  statusToast.value = {
    pieceId: piece.id,
    title: piece.title,
    message: String(caught).replace(/^Error:\s*/, ""),
    tone: "error",
    progress: 100,
  };
  toastCloseTimer = window.setTimeout(() => {
    statusToast.value = null;
    toastCloseTimer = undefined;
  }, 6000);
}

function closeStatusToast() {
  clearToastTimers();
  statusToast.value = null;
}

function confirmStatus(pieceId: number) {
  const activeTimer = confirmationTimers.get(pieceId);
  if (activeTimer) clearTimeout(activeTimer);
  confirmed[pieceId] = false;
  requestAnimationFrame(() => {
    confirmed[pieceId] = true;
    confirmationTimers.set(
      pieceId,
      window.setTimeout(() => {
        confirmed[pieceId] = false;
        confirmationTimers.delete(pieceId);
      }, 900),
    );
  });
}

function resetFilters() {
  queryInput.value = "";
  query.value = "";
  genreFilter.value = "";
  statusFilter.value = "";
  columnFilters.value = [];
  table.setPageIndex(0);
}

function statusLabel(state: LearningState): string {
  return {
    unknown: "Не проверено",
    checking: "Проверяем",
    running: "Создаём",
    ok: "Готово",
    warning: "Нужно обновить",
    missing: "Нет обучения",
    failed: "Ошибка",
  }[state];
}

function strategyLabel(pieceId: number): string {
  const strategy = statuses[pieceId]?.strategy;
  return strategy === "adaptive" ? "Adaptive" : strategy === "predict" ? "Predict" : "режим не определён";
}

function actionLabel(piece: PieceRow): string {
  if (adaptiveUnavailable(piece)) return attachingSource[piece.id] ? "Проверяю XML" : "Привязать XML";
  if (
    statuses[piece.id]?.complete &&
    statuses[piece.id]?.strategy !== learningStrategy.value
  ) return "Перестроить";
  if (piece.learningState === "ok") return "Обновить";
  if (piece.learningState === "warning") return "Исправить";
  if (piece.learningState === "running") return "Создаётся";
  if (piece.learningState === "checking") return "Проверка";
  if (piece.learningState === "failed") return "Повторить";
  return "Создать";
}

function beginLearningToast(piece: UploadedPiece, job: LearningJob) {
  clearToastTimers();
  statusToast.value = {
    pieceId: piece.id,
    title: piece.title,
    message: job.message,
    tone: "progress",
    progress: job.progress,
  };
}

function updateLearningToast(job: LearningJob) {
  if (statusToast.value?.pieceId !== job.pieceId) return;
  if (job.state === "queued" || job.state === "running") {
    statusToast.value = {
      ...statusToast.value,
      message: job.message,
      tone: "progress",
      progress: job.progress,
    };
    return;
  }

  clearToastTimers();
  const success = job.state === "completed";
  const duration = job.durationMs ? ` · ${formatDuration(job.durationMs)}` : "";
  statusToast.value = {
    ...statusToast.value,
    message: success
      ? `Обучающий режим готов${duration}`
      : `${job.error || job.message}${duration}`,
    tone: success ? "success" : "error",
    progress: success ? 100 : Math.max(4, job.progress),
  };
  toastCloseTimer = window.setTimeout(() => {
    statusToast.value = null;
    toastCloseTimer = undefined;
  }, success ? 4200 : 9000);
}

async function loadPieces() {
  const run = catalogRequest.begin();
  refreshingCatalog.value = false;
  loading.value = true;
  error.value = "";
  try {
    const data = await request<CachedPiecesResponse>("/api/pieces", { signal: run.signal });
    if (run.isCurrent()) applyCatalog(data);
  } catch (caught) {
    if (run.isCurrent()) error.value = String(caught);
  } finally {
    if (run.isCurrent()) loading.value = false;
  }
}

async function refreshCatalog() {
  const run = catalogRequest.begin();
  loading.value = false;
  refreshingCatalog.value = true;
  error.value = "";
  try {
    const data = await request<CachedPiecesResponse>("/api/pieces/refresh", {
      method: "POST",
      signal: run.signal,
    });
    if (!run.isCurrent()) return;
    applyCatalog(data);
    const cachedIds = new Set(data.statuses.map((item) => item.status.pieceId));
    const unchecked = data.pieces.filter((piece) => !cachedIds.has(piece.id));
    if (unchecked.length > 0) await checkAllStatuses(unchecked);
  } catch (caught) {
    if (run.isCurrent()) error.value = String(caught);
  } finally {
    if (run.isCurrent()) refreshingCatalog.value = false;
  }
}

function applyCatalog(data: CachedPiecesResponse) {
  pieces.value = data.pieces;
  catalogUpdatedAt.value = data.updatedAt ?? "";
  for (const key of Object.keys(statuses)) delete statuses[Number(key)];
  for (const key of Object.keys(checkedAt)) delete checkedAt[Number(key)];
  for (const cached of data.statuses) {
    applyStatus(cached.status.pieceId, cached.status, cached.checkedAt);
  }
}

// Статус пишут watcher задачи, массовый отчёт и ручная проверка. Более старый ответ,
// пришедший позже, не должен затирать свежий.
function applyStatus(pieceId: number, status: LearningStatus, stamp: string) {
  const previous = checkedAt[pieceId];
  if (!shouldApplyLearningStatus(previous, stamp)) return;
  statuses[pieceId] = status;
  checkedAt[pieceId] = stamp;
}

async function checkAllStatuses(items: UploadedPiece[]) {
  if (items.length === 0) return;
  const run = ++inspectionRun;
  checkingAll.value = true;
  checkedCount.value = 0;
  inspectionTotal.value = items.length;
  statusError.value = "";
  for (const piece of items) {
    checking[piece.id] = true;
    delete inspectionErrors[piece.id];
  }
  let failures = 0;
  for (const piece of items) {
    if (run !== inspectionRun) return;
    try {
      const data = await request<{ status: LearningStatus; checkedAt: string }>(
        `/api/pieces/${piece.id}/learning-status`,
        { method: "POST" },
      );
      if (run === inspectionRun) {
        applyStatus(piece.id, data.status, data.checkedAt);
      }
    } catch (caught) {
      failures += 1;
      if (run === inspectionRun) inspectionErrors[piece.id] = String(caught);
    } finally {
      if (run === inspectionRun) {
        checking[piece.id] = false;
        checkedCount.value += 1;
      }
    }
  }
  if (run === inspectionRun) {
    checkingAll.value = false;
    if (failures > 0) statusError.value = `Не удалось проверить: ${failures}`;
  }
}

async function startLearning(
  piece: UploadedPiece,
  strategy: LearningStrategy = learningStrategy.value,
) {
  await queueLearning(piece, { showToast: true, strategy }).catch(() => undefined);
}

async function primaryLearningAction(piece: UploadedPiece) {
  if (adaptiveUnavailable(piece)) {
    await attachMusicXml(piece);
    return;
  }
  await startLearning(piece);
}

async function attachMusicXml(piece: UploadedPiece) {
  attachingSource[piece.id] = true;
  clearToastTimers();
  statusToast.value = {
    pieceId: piece.id,
    title: piece.title,
    message: "Выберите MusicXML или MXL для Adaptive…",
    tone: "progress",
    progress: 20,
  };
  try {
    const selected = await chooseNativeFile();
    if (!selected.path) {
      if (selected.error) throw new Error(selected.error);
      statusToast.value = null;
      return;
    }
    statusToast.value = {
      ...statusToast.value,
      message: "Проверяю структуру MusicXML…",
      progress: 65,
    };
    await request(`/api/pieces/${piece.id}/score-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: selected.path }),
    });
    pieces.value = pieces.value.map((item) =>
      item.id === piece.id ? { ...item, hasMusicXml: true } : item,
    );
    delete planPreviews[piece.id];
    statusToast.value = {
      ...statusToast.value,
      message: "MusicXML привязан · Adaptive доступен",
      tone: "success",
      progress: 100,
    };
  } catch (caught) {
    failStatusToast(piece, caught);
  } finally {
    attachingSource[piece.id] = false;
  }
}

async function queueLearning(
  piece: UploadedPiece,
  options: {
    showToast: boolean;
    strategy?: LearningStrategy;
    watch?: boolean;
  },
) {
  const strategy = options.strategy ?? learningStrategy.value;
  error.value = "";
  delete inspectionErrors[piece.id];
  try {
    const data = await request<{ job: LearningJob }>(`/api/pieces/${piece.id}/learning`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy }),
    });
    jobs[piece.id] = data.job;
    if (options.showToast) beginLearningToast(piece, data.job);
    if (options.watch !== false) ensureJobWatchers();
    return data.job;
  } catch (caught) {
    error.value = String(caught);
    if (options.showToast) failStatusToast(piece, caught);
    throw caught;
  }
}

const repairablePieces = computed(() =>
  pieces.value.filter((piece) => {
    if (learningStrategy.value === "adaptive" && !piece.hasMusicXml) return false;
    const state = learningState(piece.id);
    // CHANGED: в массовое обновление входят и уже готовые пьесы. Музыкальный алгоритм
    // мог измениться, а формально «полная» схема осталась собранной по прежней логике —
    // тогда её нужно пересобрать, а не считать исправной.
    return ["ok", "warning", "missing", "failed"].includes(state);
  }),
);

function adaptiveUnavailable(piece: UploadedPiece): boolean {
  return learningStrategy.value === "adaptive" && !piece.hasMusicXml;
}

const activeLearningCount = computed(
  () =>
    Object.values(jobs).filter((job) => job.state === "queued" || job.state === "running")
      .length,
);

async function updateAllLearning() {
  const candidates = [...repairablePieces.value];
  if (candidates.length === 0) return;
  error.value = "";
  bulkQueuing.value = true;
  bulkReport.value = [];
  try {
    const results = await Promise.allSettled(
      candidates.map((piece) =>
        queueLearning(piece, { showToast: false, watch: false }),
      ),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) error.value = `Не удалось поставить в очередь: ${failed}`;
    const queueFailures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [queueFailureResult(candidates[index], result.reason)]
        : [],
    );
    const queued = results.flatMap((result, index) =>
      result.status === "fulfilled" && result.value
        ? [{ piece: candidates[index], job: result.value }]
        : [],
    );
    const completed = await Promise.all(
      queued.map(async ({ piece, job }) => ({
        piece,
        job: await waitForFinalLearningJob(job),
      })),
    );
    bulkReport.value = [
      ...queueFailures,
      ...completed
      .map(({ piece, job }) => {
        const status = job.status ?? statuses[piece.id];
        return {
          pieceId: piece.id,
          title: piece.title,
          state: job.state,
          error: job.error,
          warnings: status?.adaptive?.warnings.length ?? 0,
          navigationBreaks: status?.adaptive?.quality.navigationBreaks ?? 0,
        };
      }),
    ].sort(sortBulkLearningResults);
  } finally {
    bulkQueuing.value = false;
  }
}

async function checkStatus(piece: UploadedPiece) {
  beginStatusToast(piece);
  checking[piece.id] = true;
  delete inspectionErrors[piece.id];
  try {
    const data = await request<{ status: LearningStatus; checkedAt: string }>(
      `/api/pieces/${piece.id}/learning-status`,
      { method: "POST" },
    );
    applyStatus(piece.id, data.status, data.checkedAt);
    if (jobs[piece.id]?.state === "failed") delete jobs[piece.id];
    delete inspectionErrors[piece.id];
    confirmStatus(piece.id);
    finishStatusToast(piece, data.status.classification, data.checkedAt);
  } catch (caught) {
    inspectionErrors[piece.id] = String(caught);
    failStatusToast(piece, caught);
  } finally {
    checking[piece.id] = false;
  }
}

function ensureJobWatchers() {
  for (const job of Object.values(jobs)) {
    if (job.state === "queued" || job.state === "running") watchLearningJob(job);
  }
}

/** Сервер держит запрос до реального update(job), поэтому здесь нет polling-таймера. */
function watchLearningJob(initial: LearningJob) {
  if (watchedJobs.has(initial.id)) return;
  watchedJobs.add(initial.id);
  void (async () => {
    let current = initial;
    try {
      while (!disposed && (current.state === "queued" || current.state === "running")) {
        const data = await request<{ job: LearningJob }>(
          `/api/learning-jobs/${current.id}?after=${current.version}`,
        );
        current = data.job;
        jobs[current.pieceId] = current;
        updateLearningToast(current);
        if (current.status) {
          applyStatus(
            current.pieceId,
            current.status,
            current.checkedAt ?? new Date().toISOString(),
          );
        }
        if (current.state === "completed") {
          delete inspectionErrors[current.pieceId];
          confirmStatus(current.pieceId);
        } else if (current.state === "failed") {
          inspectionErrors[current.pieceId] = current.error || current.message;
        }
      }
    } catch (caught) {
      if (disposed) return;
      current = {
        ...current,
        state: "failed",
        error: String(caught),
        message: "Не удалось получить статус",
      };
      jobs[current.pieceId] = current;
      inspectionErrors[current.pieceId] = String(caught);
      updateLearningToast(current);
    } finally {
      watchedJobs.delete(initial.id);
    }
  })();
}

async function waitForFinalLearningJob(initial: LearningJob): Promise<LearningJob> {
  let current = initial;
  while (current.state === "queued" || current.state === "running") {
    const data = await request<{ job: LearningJob }>(
      `/api/learning-jobs/${current.id}?after=${current.version}`,
    );
    current = data.job;
    jobs[current.pieceId] = current;
    if (current.status) {
      applyStatus(
        current.pieceId,
        current.status,
        current.checkedAt ?? new Date().toISOString(),
      );
    }
  }
  return current;
}

async function cancelLearningQueue() {
  const data = await request<{ cancelled: number }>("/api/learning-jobs/cancel-queued", {
    method: "POST",
  });
  statusError.value = `Снято задач: ${data.cancelled}`;
}

function planFor(pieceId: number): AdaptivePlanSummary | undefined {
  return planPreviews[pieceId] ?? statuses[pieceId]?.adaptive;
}

async function togglePlan(piece: UploadedPiece) {
  if (expandedPlan[piece.id] && planFor(piece.id)) {
    expandedPlan[piece.id] = false;
    return;
  }
  expandedPlan[piece.id] = true;
  if (planFor(piece.id)) return;
  previewingPlan[piece.id] = true;
  delete planErrors[piece.id];
  try {
    const data = await request<{ preview: AdaptivePlanSummary }>(
      `/api/pieces/${piece.id}/learning-preview`,
      { method: "POST" },
    );
    planPreviews[piece.id] = data.preview;
  } catch (caught) {
    planErrors[piece.id] = String(caught);
  } finally {
    previewingPlan[piece.id] = false;
  }
}

/* ---------------------------------------------------------------- *
 * Аппликатура: анализ, сборка и учебный разбор
 * ---------------------------------------------------------------- */

/** Человеческие имена правил модели Parncutt для учебной карточки. */
const RULE_LABELS: Record<string, string> = {
  stretch: "растяжение сверх удобного",
  smallSpan: "пальцы слишком близко",
  largeSpan: "пальцы слишком далеко",
  positionChangeCount: "смена позиции руки",
  voiceRelease: "снятие удержанного голоса",
  positionChangeSize: "размер смены позиции",
  weakFinger: "слабый палец (4 или 5)",
  threeFourFive: "подряд 3, 4 и 5",
  threeToFour: "переход 3 → 4",
  fourOnBlack: "4-й палец на чёрной при 3-м на белой",
  thumbOnBlack: "большой палец на чёрной",
  fiveOnBlack: "5-й палец на чёрной",
  thumbPassing: "подкладывание большого пальца",
};

const PATTERN_LABELS: Record<string, string> = {
  scale: "гамма",
  fiveFinger: "устойчивая позиция руки",
  positionContinuity: "сохранение позиции",
  unreachableRepeat: "перенос пальца",
  repeatAlternation: "чередование на повторе",
  repeatSame: "повтор тем же пальцем",
  arpeggio: "арпеджио",
  alberti: "альбертиев бас",
  ostinato: "повторяющаяся фигура",
  accompaniment: "бас и аккорд",
};

/** Конспект «как подобрать аппликатуру руками» — учебный слой панели. */
const HAND_RULES: Array<{ title: string; text: string }> = [
  {
    title: "Сначала опорные точки",
    text: "Найдите места, где рука обязана сменить позицию: скачки шире квинты, смены направления, начала фраз. Аппликатура строится между ними, а не нота за нотой.",
  },
  {
    title: "Большой палец — на белую",
    text: "В гаммах и пассажах первый палец не встаёт на чёрную клавишу (Clementi, Czerny). Правило нарушают реже всех остальных.",
  },
  {
    title: "Группы по 3 и 4",
    text: "Между двумя большими пальцами лежит 3 или 4 ноты. В октаве гаммы четвёртый палец встречается ровно один раз.",
  },
  {
    title: "Следующая нота — следующий палец",
    text: "Соседние ступени играются соседними пальцами, пока это не требует растяжения (принцип Türk; в модели — правила малого и большого интервала).",
  },
  {
    title: "4 и 5 — слабые",
    text: "На сильную долю, длинную ноту и трель их стараются не ставить, а последовательность 3-4-5 подряд неудобна.",
  },
  {
    title: "Легато нельзя сыграть одним пальцем",
    text: "Под лигой два разных звука требуют двух разных пальцев. На выдержанной ноте палец можно тихо подменить.",
  },
  {
    title: "Аккорд берут «как есть»",
    text: "Пальцы в аккорде не перекрещиваются, а крайние ноты должны укладываться в вашу растяжку — проверьте её на квинте и октаве.",
  },
  {
    title: "Повторяющаяся фигура — одна аппликатура",
    text: "Альбертиев бас, ломаное трезвучие, секвенция: постоянство важнее локального удобства (C. P. E. Bach).",
  },
  {
    title: "Проверяйте медленно и не глядя",
    text: "Если рука сама не находит следующую клавишу, аппликатура неудобна независимо от теории.",
  },
];

const NOTE_NAMES = ["до", "до♯", "ре", "ми♭", "ми", "фа", "фа♯", "соль", "ля♭", "ля", "си♭", "си"];

function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function toggleScoreFocus(id: number): void {
  focusScores[id] = !focusScores[id];
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`#piece-${id}-fingering-panel .fg-score-workspace`)
      ?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
}

function activeTab(id: number): PanelTab {
  return panelTab[id] ?? "plan";
}

function selectTab(piece: UploadedPiece, tab: PanelTab): void {
  panelTab[piece.id] = tab;
  if (tab === "fingering" && !fingeringReports[piece.id] && !fingeringBusy[piece.id]) {
    void analyzeFingering(piece);
  }
}

/** Прямой вход из строки таблицы: открыть именно нотный разбор, а не соседний план. */
function openFingeringPanel(piece: UploadedPiece): void {
  if (expandedPlan[piece.id] && activeTab(piece.id) === "fingering") {
    expandedPlan[piece.id] = false;
    return;
  }
  expandedPlan[piece.id] = true;
  selectTab(piece, "fingering");
  requestAnimationFrame(() => {
    document.getElementById(`piece-${piece.id}-fingering-panel`)?.focus({ preventScroll: true });
  });
}

function onTabKey(piece: UploadedPiece, event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const next = activeTab(piece.id) === "plan" ? "fingering" : "plan";
  selectTab(piece, next);
  requestAnimationFrame(() => {
    const tabs = (event.currentTarget as HTMLElement | null)?.parentElement;
    tabs?.querySelector<HTMLElement>(`#piece-${piece.id}-${next}-tab`)?.focus();
  });
}

async function analyzeFingering(piece: UploadedPiece, mode: FingeringMode = "fill"): Promise<void> {
  fingeringBusy[piece.id] = "analyze";
  delete fingeringErrors[piece.id];
  try {
    const data = await request<{
      report: FingeringReport;
      trace: FingeringTrace[];
      previewXml: string;
    }>(
      "/api/fingering/analyze?trace=1",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pieceId: piece.id, mode, handSpan: handSpanOf(piece.id) }),
      },
    );
    fingeringReports[piece.id] = data.report;
    fingeringTraces[piece.id] = data.trace ?? [];
    fingeringPreviews[piece.id] = data.previewXml;
    selectedMeasure[piece.id] = data.report.measures[0]?.index ?? 0;
    delete selectedNote[piece.id];
  } catch (caught) {
    fingeringErrors[piece.id] = String(caught).replace(/^Error:\s*/, "");
  } finally {
    delete fingeringBusy[piece.id];
  }
}

/**
 * Заменяет нотный файл существующей композиции в Piano Marvel.
 *
 * Сервер сам разрешает `original` в канонический score_source, а `fingered`
 * сначала собирает из него в отдельный MXL. Возвращённые source/path проверяем:
 * одной смены подписи в UI недостаточно, пользователь должен получить именно
 * выбранный файл. Канонический score_source при этом не меняется.
 */
async function updatePianoMarvelScore(
  piece: UploadedPiece,
  source: PianoMarvelScoreSource,
  rebuildLearning: boolean,
): Promise<void> {
  scoreUpdating[piece.id] = source;
  delete fingeringErrors[piece.id];
  clearToastTimers();
  statusToast.value = {
    pieceId: piece.id,
    title: piece.title,
    message:
      source === "fingered"
        ? "Собираю MXL с аппликатурой и отправляю в Piano Marvel…"
        : "Отправляю исходную партитуру в Piano Marvel…",
    tone: "progress",
    progress: 28,
  };

  try {
    const data = await request<{
      success: boolean;
      source: PianoMarvelScoreSource;
      path: string;
      uploadPath: string;
      message: string;
      report?: FingeringReport;
      trace?: FingeringTrace[];
      previewXml?: string;
      editor?: string;
    }>(`/api/pieces/${piece.id}/piano-marvel-score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source,
        ...(source === "fingered" ? { fingeringMode: "fill" as const } : {}),
      }),
    });

    if (
      !data.success
      || data.source !== source
      || !data.path?.trim()
      || !data.uploadPath?.trim()
    ) {
      throw new Error(
        "Piano Marvel не подтвердил, что получил выбранную версию партитуры.",
      );
    }

    if (source === "fingered") {
      fingeringBuilds[piece.id] = {
        path: data.path,
        uploadPath: data.uploadPath,
        mode: "fill",
        editor: data.editor,
      };
      if (data.report) fingeringReports[piece.id] = data.report;
      if (data.trace) fingeringTraces[piece.id] = data.trace;
      if (data.previewXml) fingeringPreviews[piece.id] = data.previewXml;
      if (data.report) {
        selectedMeasure[piece.id] = data.report.measures[0]?.index ?? 0;
        delete selectedNote[piece.id];
      }
    }

    if (rebuildLearning) {
      let job: LearningJob | undefined;
      try {
        job = await queueLearning(piece, { showToast: false });
      } catch (caught) {
        throw new Error(
          `Партитура обновлена (${data.uploadPath}), но учебный режим не поставлен в очередь: ${String(
            caught,
          ).replace(/^Error:\s*/, "")}`,
        );
      }
      if (!job) {
        throw new Error(
          `Партитура обновлена (${data.uploadPath}), но учебный режим не поставлен в очередь.`,
        );
      }
      beginLearningToast(piece, job);
      if (statusToast.value?.pieceId === piece.id) {
        statusToast.value = {
          ...statusToast.value,
          message: `Партитура обновлена: ${data.uploadPath} · ${job.message}`,
        };
      }
    } else {
      statusToast.value = {
        pieceId: piece.id,
        title: piece.title,
        message: `${data.message} · ${data.uploadPath}`,
        tone: "success",
        progress: 100,
      };
      toastCloseTimer = window.setTimeout(() => {
        statusToast.value = null;
        toastCloseTimer = undefined;
      }, 5200);
    }
  } catch (caught) {
    fingeringErrors[piece.id] = String(caught).replace(/^Error:\s*/, "");
    failStatusToast(piece, caught);
  } finally {
    scoreUpdateChoice[piece.id] = false;
    delete scoreUpdating[piece.id];
  }
}

/** Проверка результата глазами: открыть новый файл в нотаторе или в Finder. */
async function openBuilt(piece: UploadedPiece, reveal: boolean): Promise<void> {
  const built = fingeringBuilds[piece.id];
  if (!built) return;
  fingeringOpening[piece.id] = true;
  delete fingeringErrors[piece.id];
  try {
    await request("/api/fingering/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: built.path, reveal }),
    });
  } catch (caught) {
    fingeringErrors[piece.id] = String(caught).replace(/^Error:\s*/, "");
  } finally {
    delete fingeringOpening[piece.id];
  }
}

function openLabel(id: number): string {
  return `Открыть в ${fingeringBuilds[id]?.editor ?? "нотаторе"}`;
}

function coverageLabel(report: FingeringReport): string {
  const percent = Math.round(report.coverage.coverage * 100);
  if (report.coverage.hasFingering) return `в партитуре уже есть аппликатура · ${percent} % нот`;
  if (report.coverage.partial) return `частичная аппликатура · ${percent} % нот`;
  return "в партитуре нет аппликатуры";
}

function peakLoad(report: FingeringReport): number {
  return Math.max(
    1,
    ...report.measures.map((measure) =>
      Math.max(measure.right.positionChanges, measure.left.positionChanges),
    ),
  );
}

function barHeight(value: number, peak: number): string {
  if (value <= 0) return "0%";
  return `${Math.max(6, Math.round((value / peak) * 100))}%`;
}

function peakCost(report: FingeringReport): number {
  return Math.max(
    1,
    ...report.measures.map((measure) => Math.max(measure.right.cost, measure.left.cost)),
  );
}

function loadTone(cost: number, peak: number): string {
  const ratio = cost / peak;
  if (ratio >= 0.67) return "is-load-high";
  if (ratio >= 0.34) return "is-load-medium";
  return "is-load-low";
}

function existingLabel(report: FingeringReport): string {
  if (report.existing.total === 0) return "нет авторского эталона";
  const percent = Math.round((report.existing.matched / report.existing.total) * 100);
  return `совпадение с автором ${percent} % · ${report.existing.matched}/${report.existing.total}`;
}

function fingeringBusyLabel(id: number): string {
  if (fingeringBusy[id] === "analyze") {
    return "Разбираю аппликатуру без записи…";
  }
  return "Разбираю аппликатуру без записи…";
}

function warningCountLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} предупреждений`;
  if (mod10 === 1) return `${count} предупреждение`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} предупреждения`;
  return `${count} предупреждений`;
}

function tracesForMeasure(id: number): FingeringTrace[] {
  const measures = fingeringReports[id]?.measures ?? [];
  const target = measures.find((measure) => measure.index === selectedMeasure[id]);
  if (!target) return [];
  return (fingeringTraces[id] ?? [])
    .filter((item) => item.measure === target.number)
    .sort((left, right) => left.noteIndex - right.noteIndex);
}

function selectedMeasurePosition(id: number, report: FingeringReport): number {
  const position = report.measures.findIndex(
    (measure) => measure.index === selectedMeasure[id],
  );
  return Math.max(0, position);
}

function selectMeasureAt(id: number, report: FingeringReport, position: number): void {
  if (!report.measures.length) return;
  const bounded = Math.min(report.measures.length - 1, Math.max(0, Math.round(position)));
  selectedMeasure[id] = report.measures[bounded]!.index;
  delete selectedNote[id];
}

function stepMeasure(id: number, report: FingeringReport, direction: -1 | 1): void {
  selectMeasureAt(id, report, selectedMeasurePosition(id, report) + direction);
}

function selectMeasureByNumber(
  id: number,
  report: FingeringReport,
  rawValue: string,
): void {
  const normalized = rawValue.trim().toLocaleLowerCase("ru-RU");
  if (!normalized) return;
  const exact = report.measures.findIndex(
    (measure) => measure.number.trim().toLocaleLowerCase("ru-RU") === normalized,
  );
  if (exact >= 0) {
    selectMeasureAt(id, report, exact);
    return;
  }
  const numeric = Number.parseInt(normalized, 10);
  if (Number.isFinite(numeric)) {
    const nearest = report.measures.findIndex(
      (measure) => Number.parseInt(measure.number, 10) === numeric,
    );
    if (nearest >= 0) selectMeasureAt(id, report, nearest);
  }
}

function selectMeasureFromInput(
  id: number,
  report: FingeringReport,
  event: Event,
): void {
  const input = event.target as HTMLInputElement;
  selectMeasureByNumber(id, report, input.value);
  input.value =
    report.measures[selectedMeasurePosition(id, report)]?.number ?? "";
}

function onScoreNavigationKey(
  id: number,
  report: FingeringReport,
  event: KeyboardEvent,
): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    stepMeasure(id, report, -1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    stepMeasure(id, report, 1);
  } else if (event.key === "Home") {
    event.preventDefault();
    selectMeasureAt(id, report, 0);
  } else if (event.key === "End") {
    event.preventDefault();
    selectMeasureAt(id, report, report.measures.length - 1);
  }
}

interface FingeringPatternSummary {
  key: string;
  kind: string;
  label: string;
  hand: "L" | "R";
  count: number;
  ranges: string[];
}

function patternSummaries(report: FingeringReport): FingeringPatternSummary[] {
  const grouped = new Map<string, FingeringPatternSummary & { spans: Array<[number, number]> }>();

  for (const pattern of report.patterns) {
    const key = `${pattern.kind}|${pattern.hand}|${pattern.label}`;
    const entry = grouped.get(key) ?? {
      key,
      kind: pattern.kind,
      label: pattern.label,
      hand: pattern.hand,
      count: 0,
      ranges: [],
      spans: [],
    };
    entry.count += 1;
    const previous = entry.spans.at(-1);
    if (previous && pattern.fromMeasure <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], pattern.toMeasure);
    } else {
      entry.spans.push([pattern.fromMeasure, pattern.toMeasure]);
    }
    grouped.set(key, entry);
  }

  return [...grouped.values()].map(({ spans, ...entry }) => ({
    ...entry,
    ranges: spans.map(([from, to]) => {
      const fromLabel =
        report.measures.find((measure) => measure.index === from)?.number ?? `${from + 1}`;
      const toLabel =
        report.measures.find((measure) => measure.index === to)?.number ?? `${to + 1}`;
      return from === to ? fromLabel : `${fromLabel}–${toLabel}`;
    }),
  }));
}

function traceFor(id: number): FingeringTrace | undefined {
  const notes = tracesForMeasure(id);
  const chosen = notes.find((item) => item.noteIndex === selectedNote[id]);
  return chosen ?? notes[0];
}

/**
 * Подпись под заголовком строки. Если автор совпадает с названием (а в выгрузке
 * Piano Marvel это сплошь slug вида `nothing-else-matters-metallica`), подпись
 * не печатается: дубль заголовка не несёт информации и удваивает высоту строки.
 */
function pieceByline(piece: UploadedPiece): string | undefined {
  const byline = (piece.artist || piece.composer || "").trim();
  if (!byline) return "Автор не указан";
  const normalise = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return normalise(byline) === normalise(piece.title) ? undefined : byline;
}

function handSpanOf(id: number): HandSpanValue {
  return selectedHandSpan[id] ?? "medium";
}

/** Смена размера руки — это другой физический расчёт, поэтому пересчитываем. */
function selectHandSpan(piece: UploadedPiece, value: HandSpanValue): void {
  if (handSpanOf(piece.id) === value) return;
  selectedHandSpan[piece.id] = value;
  void analyzeFingering(piece);
}

function measureSpan(id: number): number {
  return selectedSpan[id] ?? 1;
}

function spanLabel(id: number): string {
  const span = measureSpan(id);
  return span === 1 ? "такт" : span === 3 ? "такта" : "тактов";
}

function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? rule;
}

function metricValue(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function pedagogyAdjustmentLabel(value: number): string {
  const points = `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}`;
  if (value < 0) return `пед. скидка ${points}`;
  if (value > 0) return `пед. надбавка ${points}`;
  return `пед. поправка ${points}`;
}

/* CHANGED: метрики качества плана отдаются как данные (лейбл + тон + заполнение),
   чтобы панель рисовала мини-шкалы, а не сухой список «closure 1.00». */
type PlanMetric = {
  key: string;
  code: string;
  label: string;
  help: string;
  target: string;
  text: string;
  fill: number;
  tone: "good" | "warn" | "bad" | "none";
};

function metricTone(value: number | null, good: number, warn: number, higherIsBetter: boolean) {
  if (value === null) return "none" as const;
  const ok = higherIsBetter ? value >= good : value <= good;
  if (ok) return "good" as const;
  const soft = higherIsBetter ? value >= warn : value <= warn;
  return soft ? ("warn" as const) : ("bad" as const);
}

function qualityMetrics(plan: AdaptivePlanSummary): PlanMetric[] {
  const quality = plan.quality;
  return [
    {
      key: "closure",
      code: ADAPTIVE_METRIC_HELP.closure.code,
      label: ADAPTIVE_METRIC_HELP.closure.title,
      help: ADAPTIVE_METRIC_HELP.closure.help,
      target: ADAPTIVE_METRIC_HELP.closure.target,
      text: metricValue(quality.closureRate),
      fill: Math.min(1, Math.max(0, quality.closureRate)),
      tone: metricTone(quality.closureRate, 0.8, 0.5, true),
    },
    {
      key: "sections",
      code: ADAPTIVE_METRIC_HELP.sections.code,
      label: ADAPTIVE_METRIC_HELP.sections.title,
      help: ADAPTIVE_METRIC_HELP.sections.help,
      target: ADAPTIVE_METRIC_HELP.sections.target,
      text: metricValue(quality.sectionRecall),
      fill: Math.min(1, Math.max(0, quality.sectionRecall ?? 0)),
      tone: metricTone(quality.sectionRecall, 0.8, 0.5, true),
    },
    {
      key: "durCV",
      code: ADAPTIVE_METRIC_HELP.durCV.code,
      label: ADAPTIVE_METRIC_HELP.durCV.title,
      help: ADAPTIVE_METRIC_HELP.durCV.help,
      target: ADAPTIVE_METRIC_HELP.durCV.target,
      text: metricValue(quality.durationCv),
      fill: Math.min(1, Math.max(0, quality.durationCv)),
      tone: metricTone(quality.durationCv, 0.35, 0.6, false),
    },
    {
      key: "forced",
      code: ADAPTIVE_METRIC_HELP.forced.code,
      label: ADAPTIVE_METRIC_HELP.forced.title,
      help: ADAPTIVE_METRIC_HELP.forced.help,
      target: ADAPTIVE_METRIC_HELP.forced.target,
      text: metricValue(quality.forcedCutRate),
      fill: Math.min(1, Math.max(0, quality.forcedCutRate)),
      tone: metricTone(quality.forcedCutRate, 0.05, 0.2, false),
    },
  ];
}

const HYPERMETER_HELP =
  "Ритмическая сетка показывает, через сколько тактов музыка возвращается к крупной опоре и с какого такта начинается этот цикл. Например, «по 4 такта, старт +0» означает опору на 1-м, 5-м, 9-м тактах. Это помогает ставить границы там, где их ожидает слух.";
const FORM_MAP_HELP =
  "Карта формы показывает относительную длину каждой найденной фразы. Широкий блок — длинный фрагмент, узкий — короткий; число внутри — первый такт.";
const BOUNDARY_LIST_HELP =
  "Здесь объяснено, почему алгоритм завершил каждую фразу именно в этом такте. Наведите на отдельную причину, чтобы увидеть её смысл и влияние на упражнение.";
const ADAPTIVE_SUMMARY_HELP =
  "Завершённость показывает естественность окончаний фраз; охват формы — учтены ли крупные разделы; ровность длины — насколько одинаковы упражнения по размеру. Наведите на метрики в открытом плане для подробностей и ориентиров.";

function adaptiveStepHelp(name: string): string {
  return adaptiveSteps.find((step) => step.name === name)?.help ?? "";
}

const BOUNDARY_REASON_HELP: Array<{ pattern: RegExp; help: string }> = [
  {
    pattern: /каденци/i,
    help:
      "Каденция — гармоническое окончание музыкальной мысли. Граница здесь обычно звучит естественно и помогает запомнить фразу как целое.",
  },
  {
    pattern: /полная пауза/i,
    help:
      "В этом такте музыка полностью замолкает. Это сильная и понятная слуху точка для окончания упражнения.",
  },
  {
    pattern: /пауз/i,
    help:
      "Мелодия делает заметную паузу. Алгоритм использует её как естественное место для остановки и нового начала.",
  },
  {
    pattern: /лиг/i,
    help:
      "Лига объединяет ноты в один жест. Граница поставлена после её окончания, чтобы не разрывать связанную музыкальную линию.",
  },
  {
    pattern: /повтор|вольт/i,
    help:
      "Нотная запись отмечает начало или конец повторяемой части либо альтернативного окончания. Такой переход важно тренировать отдельно.",
  },
  {
    pattern: /двойная тактовая черта|обозначение раздела|шов формы/i,
    help:
      "Здесь начинается или заканчивается крупная часть формы — например, куплет, припев или новый эпизод. Граница сохраняет структуру произведения.",
  },
  {
    pattern: /гиперметр/i,
    help:
      "Такт совпал с крупной ритмической опорой — началом повторяющегося цикла из нескольких тактов. На таком месте легче начинать и заканчивать фрагмент.",
  },
  {
    pattern: /педал/i,
    help:
      "Здесь снимается или меняется педаль и завершается гармонический жест. Разрез после смены помогает избежать грязного соединения гармоний.",
  },
  {
    pattern: /мелодический рельеф/i,
    help:
      "Контур мелодии заметно меняется: появляется скачок, длинная нота или новый рисунок. Это мягкий признак начала новой мысли.",
  },
  {
    pattern: /фермат/i,
    help:
      "Фермата просит задержать звук или паузу. После неё естественно остановиться либо начать следующий фрагмент.",
  },
  {
    pattern: /цезур|дыхани/i,
    help:
      "В нотах отмечено короткое музыкальное «дыхание». Оно работает как пунктуация и подходит для границы упражнения.",
  },
  {
    pattern: /темп|tempo|rall|ritard|acceler|allarg|a tempo/i,
    help:
      "Здесь начинается, заканчивается или меняется движение темпа. Граница позволяет отдельно освоить переход и не потерять пульс.",
  },
  {
    pattern: /динамик|crescendo|diminuendo/i,
    help:
      "Заканчивается или начинается заметное изменение громкости. Алгоритм старается сохранить выразительный жест целиком.",
  },
  {
    pattern: /мотив/i,
    help:
      "Возвращается узнаваемый короткий рисунок. Его начало становится удобной точкой ориентации и повторения.",
  },
  {
    pattern: /навигац|D\\.S\\.|D\\.C\\.|Fine|Coda/i,
    help:
      "Здесь меняется реальный порядок исполнения: повтор, переход, Fine или Coda. Такой прыжок нельзя прятать внутри обычной фразы.",
  },
  {
    pattern: /конец строки/i,
    help:
      "Это конец нотной строки. Сам по себе признак слабый, но вместе с музыкальными сигналами помогает выбрать удобную визуальную границу.",
  },
];

function boundaryReasonHelp(reason: string): string {
  return (
    BOUNDARY_REASON_HELP.find((item) => item.pattern.test(reason))?.help ??
    "Алгоритм обнаружил здесь изменение музыкального материала. Этот признак поддержал решение закончить текущую фразу в данном такте."
  );
}

/* CHANGED: единый источник для карты формы и списка границ — фразы по порядку
   с шириной в процентах от общего диапазона тактов и причинами разреза. */
type PlanSegment = {
  key: string;
  start: number;
  end: number;
  length: number;
  width: number;
  reasons: string[];
};

function planSegments(plan: AdaptivePlanSummary): PlanSegment[] {
  const phrases = [...plan.phrases].sort((left, right) => left.end - right.end);
  const first = phrases[0]?.start ?? 1;
  const last = phrases[phrases.length - 1]?.end ?? first;
  const span = Math.max(1, last - first + 1);
  return phrases.map((phrase) => {
    const length = Math.max(1, phrase.end - phrase.start + 1);
    return {
      key: `${phrase.start}-${phrase.end}`,
      start: phrase.start,
      end: phrase.end,
      length,
      width: (length / span) * 100,
      reasons: plan.boundaryReasons[phrase.end]?.length
        ? plan.boundaryReasons[phrase.end]
        : ["конец партитуры"],
    };
  });
}

function planSpan(plan: AdaptivePlanSummary): { first: number; last: number; total: number } {
  const segments = planSegments(plan);
  const first = segments[0]?.start ?? 1;
  const last = segments[segments.length - 1]?.end ?? first;
  return { first, last, total: Math.max(1, last - first + 1) };
}

const bulkReportSummary = computed(() => ({
  rebuilt: bulkReport.value.filter((item) => item.state === "completed").length,
  warnings: bulkReport.value.filter(
    (item) => item.warnings > 0 || item.navigationBreaks > 0,
  ).length,
  errors: bulkReport.value.filter((item) => item.state === "failed").length,
}));

function formatDuration(value: number): string {
  const seconds = Math.max(1, Math.round(value / 1000));
  if (seconds < 60) return `${seconds} сек`;
  return `${Math.floor(seconds / 60)} мин ${seconds % 60} сек`;
}

function formatCacheTime(value: string): string {
  if (!value) return "кэш ещё не создан";
  const date = new Date(value);
  const now = new Date();
  const time = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `сегодня, ${time}`;

  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(url, init);
}
</script>

<template>
  <section class="movement library-movement">
    <header class="movement-head">
      <span class="movement-num">IV</span>
      <div>
        <p class="movement-kicker">Четвёртый акт</p>
        <h2>Создайте обучение</h2>
      </div>
      <span class="movement-meta">{{ pieces.length }} пьес</span>
    </header>

    <p class="movement-lead">
      Каталог и статусы читаются из локального кэша. Piano Marvel запрашивается только по вашей команде.
    </p>

    <div class="library-toolbar">
      <label class="library-search" :class="{ 'is-pending': searchPending }">
        <UiIcon name="search" :size="16" />
        <span class="sr-only">Поиск композиций</span>
        <input v-model="queryInput" type="search" placeholder="Название, автор, жанр или ID" />
        <span v-if="searchPending" class="search-progress" aria-hidden="true" />
        <button v-if="queryInput" type="button" aria-label="Очистить поиск" @click="queryInput = ''">
          <UiIcon name="close" :size="14" />
        </button>
      </label>

      <label class="library-filter" :class="{ active: genreFilter }">
        <span>Жанр</span>
        <select v-model="genreFilter">
          <option value="">Все жанры</option>
          <option v-for="genre in genres" :key="genre" :value="genre">{{ genre }}</option>
        </select>
      </label>

      <label class="library-filter" :class="{ active: statusFilter }">
        <span>Статус</span>
        <select v-model="statusFilter">
          <option value="">Все статусы</option>
          <option value="unknown">Не проверено</option>
          <option value="checking">Проверяется</option>
          <option value="running">Создаётся</option>
          <option value="ok">Готово</option>
          <option value="warning">Нужно обновить</option>
          <option value="missing">Нет обучения</option>
          <option value="failed">Ошибка проверки</option>
        </select>
      </label>

      <button
        class="library-refresh"
        :class="{ 'is-loading': refreshingCatalog }"
        :disabled="refreshingCatalog || checkingAll"
        title="Обновить список композиций в Piano Marvel (статусы не проверяются)"
        aria-label="Обновить список композиций"
        @click="refreshCatalog"
      >
        <UiIcon name="refresh" :size="17" />
      </button>
    </div>

    <!-- CHANGED: способ обучения — компактный дайджест активного режима, детали по кнопке -->
    <section class="learn-mode" :class="{ 'is-open': learnDetailsOpen }" aria-labelledby="learn-mode-title">
      <div class="learn-mode-bar">
        <div class="learn-mode-head">
          <span id="learn-mode-title" class="learn-mode-kicker">Способ обучения</span>
          <span class="learn-mode-hint">Score-to-practice engine</span>
        </div>
        <div
          class="learn-mode-choice-cue"
          aria-label="Выберите способ: он определит перестройку учебных схем партитур ниже"
        >
          <span>
            <strong>Выберите способ</strong>
            <small>Он определит перестройку схем ниже</small>
          </span>
          <span class="learn-mode-choice-arrow" aria-hidden="true">
            <i />
            <UiIcon name="chevron-right" :size="13" />
          </span>
        </div>
        <!-- CHANGED: тот же компонент, что у MuseScore/«С диска»: каретка,
             типографика и клавиатурная навигация всегда движутся одинаково. -->
        <ModeSwitch
          class="learn-mode-switch"
          variant="dock"
          label="Способ сборки Chopped"
          controls="learn-mode-digest"
          :options="LEARNING_MODE_OPTIONS"
          :model-value="learningStrategy"
          @update:model-value="learningStrategy = $event as LearningStrategy"
        />
      </div>

      <div id="learn-mode-digest" class="learn-mode-digest">
        <p
          class="learn-mode-eyebrow adaptive-help"
          tabindex="0"
          :data-tooltip="activeLearningMode.lead"
          :aria-label="`${activeLearningMode.eyebrow}. ${activeLearningMode.lead}`"
        >
          <span aria-hidden="true" />
          <span class="adaptive-help-term">{{ activeLearningMode.eyebrow }}</span>
        </p>
        <h3 class="learn-mode-panel-title">
          {{ activeLearningMode.title }}
          <em>{{ activeLearningMode.titleAccent }}</em>
        </h3>
        <p class="learn-mode-lead">{{ activeLearningMode.lead }}</p>
        <ul class="learn-mode-proof" :aria-label="`Свойства ${activeLearningMode.label}`">
          <li v-for="chip in activeLearningMode.chips" :key="chip">{{ chip }}</li>
        </ul>
        <p class="learn-mode-fingering-brief">
          <UiIcon name="music" :size="14" />
          <span>
            <strong>Аппликатура считается отдельно от способа Chopped.</strong>
            Откройте реальный нотный стан в строке пьесы и одной CTA отправьте
            <span class="mono">fingered MXL</span> в Piano Marvel.
          </span>
        </p>
      </div>

      <div class="learn-mode-actions">
        <button
          type="button"
          class="learn-mode-disclosure"
          :aria-expanded="learnDetailsOpen"
          aria-controls="learn-mode-details"
          @click="learnDetailsOpen = !learnDetailsOpen"
        >
          <UiIcon name="chevron-right" :size="12" />
          {{
            learnDetailsOpen
              ? "Скрыть детали"
              : "Как работают маршрут и аппликатура"
          }}
        </button>
        <button
          type="button"
          class="learn-mode-fingering-cta"
          @click="goToFingeringWorkbench"
        >
          <UiIcon name="music" :size="13" />
          К нотам и аппликатуре
          <UiIcon name="chevron-right" :size="12" />
        </button>
      </div>

      <div
        id="learn-mode-details"
        class="learn-mode-details"
        :inert="!learnDetailsOpen"
        :aria-hidden="!learnDetailsOpen"
      >
        <div class="learn-mode-details-inner">
          <section class="learn-mode-score-section is-signals">
            <div class="learn-mode-path-head">
              <div>
                <span>Score intelligence</span>
                <strong>Что учитывает анализ</strong>
              </div>
              <p>Восемь слоёв читают форму, движение и исполнительскую задачу.</p>
            </div>
            <div class="learn-mode-signals" aria-label="Что учитывает режим">
              <div
                v-for="signal in activeLearningMode.signals"
                :key="signal.tag"
                class="adaptive-help"
                tabindex="0"
                :data-tooltip="signal.help"
                :aria-label="`${signal.title}. ${signal.help}`"
              >
                <span>{{ signal.tag }}</span>
                <strong class="adaptive-help-term">{{ signal.title }}</strong>
                <small>{{ signal.text }}</small>
              </div>
            </div>
          </section>

          <section class="learn-mode-score-section is-fingering-compiler">
            <div class="learn-mode-path-head">
              <div>
                <span>Fingering Compiler</span>
                <strong>Как появляется моторный план</strong>
              </div>
              <p>
                Независимый от Adaptive/Predict слой: физика является hard-gate,
                педагогика ранжирует только выполнимые варианты.
              </p>
            </div>
            <div
              class="learn-mode-signals is-fingering"
              aria-label="Этапы подбора аппликатуры"
            >
              <div
                v-for="signal in fingeringCompilerSignals"
                :key="signal.tag"
                class="adaptive-help"
                tabindex="0"
                :data-tooltip="signal.help"
                :aria-label="`${signal.title}. ${signal.help}`"
              >
                <span>{{ signal.tag }}</span>
                <strong class="adaptive-help-term">{{ signal.title }}</strong>
                <small>{{ signal.text }}</small>
              </div>
            </div>
          </section>

          <template v-if="learningStrategy === 'adaptive'">
            <section class="learn-mode-score-section is-arc">
              <div class="learn-mode-path-head">
                <div>
                  <span>Learning arc</span>
                  <strong>От музыкальной мысли — к целой форме</strong>
                </div>
                <p>Каждый следующий уровень склеивает уже освоенный материал.</p>
              </div>
              <ol class="learn-mode-steps" aria-label="Ступени Adaptive">
                <li
                  v-for="step in adaptiveSteps"
                  :key="step.name"
                  class="learn-mode-step adaptive-help"
                  :class="`is-${step.name.toLowerCase()}`"
                  tabindex="0"
                  :data-tooltip="step.help"
                  :aria-label="`${step.name}. ${step.help}`"
                >
                  <span class="learn-mode-step-index">{{ step.index }}</span>
                  <span class="learn-mode-step-name adaptive-help-term">{{ step.name }}</span>
                  <span class="learn-mode-step-desc">{{ step.desc }}</span>
                </li>
              </ol>
            </section>

            <section class="learn-mode-score-section is-transitions">
              <div class="learn-mode-path-head">
                <div>
                  <span>Transitions</span>
                  <strong>Что тренирует Bridge</strong>
                </div>
                <p>Сплошные — обязательные; пунктирные — только для уязвимых стыков.</p>
              </div>
              <ul class="learn-mode-transitions" aria-label="Таксономия переходов Adaptive">
                <li
                  v-for="transition in adaptiveTransitions"
                  :key="transition.code"
                  class="adaptive-help"
                  :class="{ 'is-required': transition.required }"
                  tabindex="0"
                  :data-tooltip="transition.help"
                  :aria-label="`${transition.label}. ${transition.help}`"
                >
                  <code>{{ transition.code }}</code>
                  <span class="adaptive-help-term">{{ transition.label }}</span>
                </li>
              </ul>
            </section>

            <section class="learn-mode-score-section is-quality">
              <div class="learn-mode-path-head">
                <div>
                  <span>Quality gate</span>
                  <strong>Чем измеряется результат</strong>
                </div>
                <p>Понятное название — главное; технический код оставлен вторичным.</p>
              </div>
              <ul class="learn-mode-metrics" aria-label="Метрики качества Adaptive">
                <li
                  v-for="metric in adaptiveMetrics"
                  :key="metric.code"
                  class="adaptive-help"
                  tabindex="0"
                  :data-tooltip="`${metric.help} Ориентир: ${metric.target}.`"
                  :aria-label="`${metric.title}: ориентир ${metric.target}. ${metric.help}`"
                >
                  <span class="learn-mode-metric-name">
                    <span class="adaptive-help-term">{{ metric.title }}</span>
                    <code>{{ metric.code }}</code>
                  </span>
                  <strong>{{ metric.target }}</strong>
                  <small>{{ metric.label }}</small>
                </li>
              </ul>
            </section>

            <div class="learn-mode-evidence">
              <span>Method / sources</span>
              <div class="learn-mode-sources" aria-label="Методическая база Adaptive">
                <a
                  v-for="source in adaptiveSources"
                  :key="source.href"
                  :href="source.href"
                  target="_blank"
                  rel="noreferrer"
                >
                  {{ source.label }} <UiIcon name="external" :size="11" />
                </a>
              </div>
            </div>
          </template>
        </div>
      </div>
    </section>

    <div class="library-summary" aria-live="polite">
      <span>
        <strong>{{ pageSummary.total }}</strong> композиций · каталог обновлён {{ formatCacheTime(catalogUpdatedAt) }}
      </span>
      <div class="library-summary-actions">
        <span v-if="checkingAll" class="status-scan">
          <i /> Проверено {{ checkedCount }} / {{ inspectionTotal }}
        </span>
        <span v-else-if="activeLearningCount" class="status-scan">
          <i /> В работе и очереди: {{ activeLearningCount }}
        </span>
        <span v-else-if="statusError" class="status-scan error">{{ statusError }}</span>
        <button
          v-if="activeLearningCount > 0"
          type="button"
          title="Снять задачи, которые ещё не начали менять Piano Marvel"
          @click="cancelLearningQueue"
        >
          Отменить очередь <UiIcon name="close" :size="13" />
        </button>
        <button
          v-if="repairablePieces.length"
          type="button"
          :disabled="checkingAll || bulkQueuing"
          :title="`Пересобрать ${repairablePieces.length} композиций текущим алгоритмом: каждая схема удаляется и создаётся заново`"
          @click="updateAllLearning"
        >
          {{ bulkQueuing ? "Ставлю в очередь…" : `Обновить всё (${repairablePieces.length})` }}
          <UiIcon name="refresh" :size="13" />
        </button>
        <button
          v-if="pieces.length"
          type="button"
          title="Явно перепроверить обучение всей библиотеки"
          @click="checkAllStatuses(pieces)"
        >
          Обновить сведения <UiIcon name="refresh" :size="13" />
        </button>
        <button v-if="queryInput || genreFilter || statusFilter" type="button" @click="resetFilters">
          Сбросить фильтры <UiIcon name="close" :size="13" />
        </button>
      </div>
    </div>
    <div v-if="bulkReport.length" class="bulk-learning-report" aria-live="polite">
      <button
        type="button"
        :aria-expanded="bulkReportExpanded"
        @click="bulkReportExpanded = !bulkReportExpanded"
      >
        Пересобрано {{ bulkReportSummary.rebuilt }} · с замечаниями
        {{ bulkReportSummary.warnings }} · с ошибками {{ bulkReportSummary.errors }}
        <UiIcon :name="bulkReportExpanded ? 'arrow-up' : 'arrow-down'" :size="12" />
      </button>
      <ul v-if="bulkReportExpanded">
        <li v-for="item in bulkReport" :key="item.pieceId">
          <strong>{{ item.title }}</strong>
          <span v-if="item.state === 'failed'">{{ item.error || "Ошибка сборки" }}</span>
          <span v-else-if="item.navigationBreaks">
            Фраз пересекают переход исполнения: {{ item.navigationBreaks }}
          </span>
          <span v-else-if="item.warnings">Замечаний: {{ item.warnings }}</span>
          <span v-else>Готово</span>
        </li>
      </ul>
    </div>

    <p v-if="error" class="library-error" role="alert">{{ error }}</p>
    <p v-else-if="!loggedIn && pieces.length === 0" class="library-empty">
      Локальный кэш пуст. Войдите и обновите список композиций один раз.
    </p>

    <div v-else-if="loading && pieces.length === 0" class="library-table-skeleton" aria-label="Читаю локальный кэш">
      <i class="skeleton-head" />
      <i v-for="item in 5" :key="item" />
    </div>

    <div v-else-if="pageSummary.total === 0" class="library-empty-state">
      <span class="empty-mark">∅</span>
      <strong>{{ pieces.length ? "Ничего не найдено" : "Кэш каталога пуст" }}</strong>
      <p>
        {{ pieces.length ? "Попробуйте изменить запрос или очистить фильтры." : "Обновите список один раз — дальше он будет открываться локально." }}
      </p>
      <button v-if="!pieces.length" class="btn ghost" @click="refreshCatalog">
        Обновить каталог
      </button>
      <button v-if="queryInput || genreFilter || statusFilter" class="btn ghost" @click="resetFilters">
        Сбросить фильтры
      </button>
    </div>

    <template v-else>
      <div class="piece-table-frame">
        <table class="piece-table">
          <thead>
            <tr v-for="headerGroup in table.getHeaderGroups()" :key="headerGroup.id">
              <th
                v-for="header in headerGroup.headers"
                :key="header.id"
                :data-column="header.column.id"
                :aria-sort="
                  header.column.getIsSorted() === 'asc'
                    ? 'ascending'
                    : header.column.getIsSorted() === 'desc'
                      ? 'descending'
                      : undefined
                "
              >
                <button
                  v-if="header.column.getCanSort()"
                  type="button"
                  @click="header.column.getToggleSortingHandler()?.($event)"
                >
                  <FlexRender :render="header.column.columnDef.header" :props="header.getContext()" />
                  <UiIcon
                    :name="
                      header.column.getIsSorted() === 'asc'
                        ? 'arrow-up'
                        : header.column.getIsSorted() === 'desc'
                          ? 'arrow-down'
                          : 'sort'
                    "
                    :size="13"
                  />
                </button>
                <FlexRender v-else :render="header.column.columnDef.header" :props="header.getContext()" />
              </th>
            </tr>
          </thead>

          <tbody :class="{ 'is-searching': searchPending }">
            <template v-for="row in table.getRowModel().rows" :key="row.original.id">
              <tr
                :class="{
                  'is-status-checking': checking[row.original.id],
                  'is-status-confirmed': confirmed[row.original.id],
                }"
              >
              <td data-column="title">
                <div class="piece-title-cell">
                  <a
                    class="piece-title-link"
                    :href="`https://pianomarvel.com/uploads/pieceRedirect/${row.original.id}`"
                    target="_blank"
                    rel="noopener"
                    :aria-label="`Открыть ${row.original.title} в Piano Marvel`"
                    :data-tooltip="row.original.title"
                  >
                    {{ row.original.title }}
                  </a>
                  <span
                    v-if="pieceByline(row.original)"
                    class="piece-artist"
                    :data-tooltip="pieceByline(row.original)"
                  >
                    {{ pieceByline(row.original) }}
                  </span>
                  <button
                    v-if="row.original.hasMusicXml"
                    type="button"
                    class="piece-fingering-link"
                    :class="{
                      'is-active':
                        expandedPlan[row.original.id] &&
                        activeTab(row.original.id) === 'fingering',
                    }"
                    :aria-expanded="
                      Boolean(
                        expandedPlan[row.original.id] &&
                          activeTab(row.original.id) === 'fingering',
                      )
                    "
                    :aria-controls="`piece-${row.original.id}-fingering-panel`"
                    @click="openFingeringPanel(row.original)"
                  >
                    <UiIcon name="music" :size="13" />
                    <span>Ноты и аппликатура</span>
                  </button>
                </div>
              </td>

              <td data-column="genres" data-label="Жанр">
                <div v-if="row.original.genres.length" class="table-tags">
                  <span
                    v-for="genre in row.original.genres.slice(0, 2)"
                    :key="genre"
                    :data-tooltip="genre"
                  >
                    {{ genre }}
                  </span>
                  <span
                    v-if="row.original.genres.length > 2"
                    :aria-label="`Ещё жанры: ${row.original.genres.slice(2).join(', ')}`"
                    :data-tooltip="row.original.genres.slice(2).join(', ')"
                  >
                    +{{ row.original.genres.length - 2 }}
                  </span>
                </div>
                <span v-else class="table-muted">Не указан</span>
              </td>

              <td data-column="difficulty" data-label="Сложность">
                <div
                  class="difficulty-cell"
                  :aria-label="`Сложность ${row.original.difficulty} из 18`"
                  :data-tooltip="`Сложность ${row.original.difficulty} из 18`"
                >
                  <span class="mono">{{ row.original.difficulty }}</span>
                  <span class="difficulty-track" aria-hidden="true">
                    <i :style="{ width: `${Math.min(100, (row.original.difficulty / 18) * 100)}%` }" />
                  </span>
                </div>
              </td>

              <td data-column="learningState" data-label="Обучение">
                <div v-if="jobs[row.original.id]?.state === 'queued' || jobs[row.original.id]?.state === 'running'" class="table-progress">
                  <div>
                    <span>{{ jobs[row.original.id].message }}</span>
                    <span class="mono">{{ jobs[row.original.id].progress }}%</span>
                  </div>
                  <progress :value="jobs[row.original.id].progress" max="100" />
                </div>
                <div v-else class="learning-cell" aria-live="polite">
                  <span
                    class="status-pill"
                    :class="[
                      checking[row.original.id] ? 'checking' : row.original.learningState,
                      { 'is-confirmed': confirmed[row.original.id] },
                    ]"
                    :aria-label="
                      inspectionErrors[row.original.id] ||
                      (checking[row.original.id]
                        ? `Проверяется: ${row.original.title}`
                        : `${statusLabel(row.original.learningState)} · ${formatCacheTime(checkedAt[row.original.id] ?? '')}`)
                    "
                    :data-tooltip="
                      inspectionErrors[row.original.id] ||
                      (checking[row.original.id]
                        ? `Проверяется: ${row.original.title}`
                        : `${statusLabel(row.original.learningState)} · ${formatCacheTime(checkedAt[row.original.id] ?? '')}`)
                    "
                  >
                    <i />
                    {{ checking[row.original.id] ? "Проверяем" : statusLabel(row.original.learningState) }}
                  </span>
                  <span v-if="checkedAt[row.original.id]" class="learning-cache-time">
                    Проверено {{ formatCacheTime(checkedAt[row.original.id]) }} ·
                    {{ strategyLabel(row.original.id) }}
                  </span>
                  <button
                    v-if="statuses[row.original.id]?.adaptive?.warnings.length"
                    type="button"
                    class="learning-warning-count"
                    @click="expandedPlan[row.original.id] = !expandedPlan[row.original.id]"
                  >
                    ⚠ {{ statuses[row.original.id].adaptive!.warnings.length }} замечания
                  </button>
                  <span
                    v-if="statuses[row.original.id]?.adaptive"
                    class="learning-plan-metrics adaptive-help"
                    tabindex="0"
                    :data-tooltip="ADAPTIVE_SUMMARY_HELP"
                    :aria-label="ADAPTIVE_SUMMARY_HELP"
                  >
                    <span class="learning-inline-metric">
                      <span class="adaptive-help-term">завершённость</span>
                      <b>{{ metricValue(statuses[row.original.id].adaptive!.quality.closureRate) }}</b>
                    </span>
                    <span class="learning-inline-metric">
                      <span class="adaptive-help-term">форма</span>
                      <b>{{ metricValue(statuses[row.original.id].adaptive!.quality.sectionRecall) }}</b>
                    </span>
                    <span class="learning-inline-metric">
                      <span class="adaptive-help-term">разброс</span>
                      <b>{{ metricValue(statuses[row.original.id].adaptive!.quality.durationCv) }}</b>
                    </span>
                  </span>
                  <strong
                    v-if="statuses[row.original.id]?.adaptive?.quality.navigationBreaks"
                    class="learning-navigation-warning adaptive-help"
                    tabindex="0"
                    :data-tooltip="ADAPTIVE_METRIC_HELP.navigation.help"
                    :aria-label="`${statuses[row.original.id].adaptive!.quality.navigationBreaks} фраз пересекают переход исполнения. ${ADAPTIVE_METRIC_HELP.navigation.help}`"
                  >
                    <span class="adaptive-help-term">Фразы пересекают переход исполнения</span>:
                    {{ statuses[row.original.id].adaptive!.quality.navigationBreaks }}
                  </strong>
                  <div
                    v-if="row.original.learningState === 'failed' && (jobs[row.original.id]?.error || inspectionErrors[row.original.id])"
                    class="learning-log-box"
                  >
                    <button
                      type="button"
                      class="learning-log-toggle"
                      :aria-expanded="!!expandedLogs[row.original.id]"
                      @click="expandedLogs[row.original.id] = !expandedLogs[row.original.id]"
                    >
                      <UiIcon name="warning" :size="12" />
                      <span>{{ expandedLogs[row.original.id] ? "Скрыть лог" : "Показать лог" }}</span>
                      <UiIcon :name="expandedLogs[row.original.id] ? 'arrow-up' : 'arrow-down'" :size="11" />
                    </button>
                    <pre v-if="expandedLogs[row.original.id]" class="learning-log">{{ jobs[row.original.id]?.error || inspectionErrors[row.original.id] }}</pre>
                    <span
                      v-else
                      class="learning-error-detail"
                      :title="jobs[row.original.id]?.error || inspectionErrors[row.original.id]"
                    >{{ jobs[row.original.id]?.error || inspectionErrors[row.original.id] }}</span>
                  </div>
                </div>
              </td>

              <td data-column="actions">
                <div class="table-actions">
                  <div
                    v-if="!scoreUpdateChoice[row.original.id]"
                    class="table-secondary-group"
                    role="group"
                    :aria-label="`План и статус ${row.original.title}`"
                  >
                    <button
                      class="table-secondary-action is-icon"
                      :class="{
                        'is-loading': previewingPlan[row.original.id],
                        'is-selected': !!expandedPlan[row.original.id],
                      }"
                      :disabled="
                        previewingPlan[row.original.id] ||
                        row.original.learningState === 'running' ||
                        adaptivePreviewUnavailable(row.original)
                      "
                      data-tooltip="План Adaptive — показать структуру фраз и метрики до сборки"
                      :aria-expanded="!!expandedPlan[row.original.id]"
                      :aria-label="`Показать план ${row.original.title}`"
                      @click="togglePlan(row.original)"
                    >
                      <span class="secondary-icon-rest" aria-hidden="true">
                        <UiIcon name="eye" :size="16" />
                      </span>
                      <span class="secondary-icon-capsule" aria-hidden="true">
                        <i><UiIcon name="eye" :size="16" /></i>
                      </span>
                    </button>
                    <!-- CHANGED: «Проверить» — это ручной запрос свежего статуса из PM
                         (по дизайну PM дёргаем только по команде). -->
                    <button
                      class="table-secondary-action is-icon"
                      :class="{ 'is-loading': checking[row.original.id] }"
                      :disabled="
                        checking[row.original.id] ||
                        checkingAll ||
                        row.original.learningState === 'running' ||
                        row.original.learningState === 'checking'
                      "
                      :data-tooltip="
                        row.original.learningState === 'running'
                          ? 'Статус — сборка уже идёт и обновится автоматически'
                          : 'Статус — запросить свежие данные из Piano Marvel'
                      "
                      :aria-label="`Проверить статус ${row.original.title}`"
                      :aria-busy="checking[row.original.id]"
                      @click="checkStatus(row.original)"
                    >
                      <span class="secondary-icon-rest" aria-hidden="true">
                        <UiIcon name="refresh" :size="16" />
                      </span>
                      <span class="secondary-icon-capsule" aria-hidden="true">
                        <i><UiIcon name="refresh" :size="16" /></i>
                      </span>
                    </button>
                  </div>
                  <!-- CHANGED: убрано отключение primary для статуса 'unknown'.
                       После привязки MXL (adaptiveUnavailable→false) статус остаётся
                       'unknown', и кнопка «Создать» ошибочно гасла. Теперь: adaptive без
                       MXL → активная «Привязать XML»; иначе → активная «Создать»/«Обновить».
                       Проверка статуса остаётся отдельной иконкой-refresh. -->
                  <div
                    v-if="
                      actionLabel(row.original) === 'Обновить' &&
                      row.original.hasMusicXml &&
                      scoreUpdateChoice[row.original.id]
                    "
                    class="table-score-choice"
                    role="group"
                    :aria-label="`Какую партитуру отправить для ${row.original.title}`"
                    aria-live="polite"
                  >
                    <button
                      type="button"
                      class="table-score-option is-original"
                      :class="{
                        'is-loading': scoreUpdating[row.original.id] === 'original',
                      }"
                      :disabled="Boolean(scoreUpdating[row.original.id])"
                      title="Отправить канонический исходный MusicXML без автоматически добавленных цифр"
                      @click="updatePianoMarvelScore(row.original, 'original', true)"
                    >
                      <strong>
                        {{
                          scoreUpdating[row.original.id] === "original"
                            ? "Отправляю…"
                            : "Исходный"
                        }}
                      </strong>
                      <small>без автоцифр</small>
                    </button>
                    <button
                      type="button"
                      class="table-score-option is-fingered"
                      :class="{
                        'is-loading': scoreUpdating[row.original.id] === 'fingered',
                      }"
                      :disabled="Boolean(scoreUpdating[row.original.id])"
                      title="Собрать и отправить MXL с автоматически добавленной аппликатурой"
                      @click="updatePianoMarvelScore(row.original, 'fingered', true)"
                    >
                      <strong>
                        {{
                          scoreUpdating[row.original.id] === "fingered"
                            ? "Отправляю…"
                            : "С аппликатурой"
                        }}
                      </strong>
                      <small>fingered MXL</small>
                    </button>
                    <button
                      type="button"
                      class="table-score-cancel"
                      :disabled="Boolean(scoreUpdating[row.original.id])"
                      title="Отменить выбор партитуры"
                      :aria-label="`Отменить выбор партитуры для ${row.original.title}`"
                      @click="scoreUpdateChoice[row.original.id] = false"
                    >
                      <UiIcon name="close" :size="14" />
                    </button>
                  </div>
                  <button
                    v-else
                    class="table-primary-action"
                    :class="{
                      'is-loading': row.original.learningState === 'running',
                      'is-create': actionLabel(row.original) === 'Создать',
                      'is-rebuild': actionLabel(row.original) === 'Перестроить',
                      'is-update': actionLabel(row.original) === 'Обновить',
                      'is-attach': adaptiveUnavailable(row.original),
                      'is-fix': actionLabel(row.original) === 'Исправить',
                      'is-retry': actionLabel(row.original) === 'Повторить',
                    }"
                    :disabled="
                      row.original.learningState === 'running' ||
                      checking[row.original.id] ||
                      attachingSource[row.original.id]
                    "
                    :aria-busy="row.original.learningState === 'running'"
                    :aria-label="actionLabel(row.original)"
                    @click="
                      actionLabel(row.original) === 'Обновить' && row.original.hasMusicXml
                        ? (scoreUpdateChoice[row.original.id] = true)
                        : primaryLearningAction(row.original)
                    "
                  >
                    <span class="action-label">{{ actionLabel(row.original) }}</span>
                    <span class="action-arrow" aria-hidden="true">
                      <i><UiIcon name="chevron-right" :size="14" /></i>
                    </span>
                  </button>
                </div>
              </td>
              </tr>
              <tr v-if="expandedPlan[row.original.id]" class="learning-plan-row">
                <td colspan="5">
                  <div class="learning-plan-panel">
                    <!-- CHANGED: панель стала двухвкладочным документом:
                         план разучивания и аппликатура (docs/fingering-prd.md §9.2) -->
                    <div class="panel-tabs" role="tablist" aria-label="Разделы партитуры">
                      <button
                        :id="`piece-${row.original.id}-plan-tab`"
                        type="button"
                        role="tab"
                        class="panel-tab"
                        :class="{ 'is-active': activeTab(row.original.id) === 'plan' }"
                        :aria-selected="activeTab(row.original.id) === 'plan'"
                        :aria-controls="`piece-${row.original.id}-plan-panel`"
                        :tabindex="activeTab(row.original.id) === 'plan' ? 0 : -1"
                        @click="selectTab(row.original, 'plan')"
                        @keydown="onTabKey(row.original, $event)"
                      >
                        План разучивания
                      </button>
                      <button
                        :id="`piece-${row.original.id}-fingering-tab`"
                        type="button"
                        role="tab"
                        class="panel-tab"
                        :class="{ 'is-active': activeTab(row.original.id) === 'fingering' }"
                        :aria-selected="activeTab(row.original.id) === 'fingering'"
                        :aria-controls="`piece-${row.original.id}-fingering-panel`"
                        :tabindex="activeTab(row.original.id) === 'fingering' ? 0 : -1"
                        @click="selectTab(row.original, 'fingering')"
                        @keydown="onTabKey(row.original, $event)"
                      >
                        Аппликатура
                      </button>
                    </div>

                    <div
                      :id="`piece-${row.original.id}-plan-panel`"
                      v-show="activeTab(row.original.id) === 'plan'"
                      role="tabpanel"
                      :aria-labelledby="`piece-${row.original.id}-plan-tab`"
                      class="panel-page"
                    >
                    <!-- CHANGED: панель плана переверстана как «партитурный лист»:
                         крупные цифры состава, шкала уверенности гиперметра, карта
                         формы, метрики с мини-шкалами и индексный список границ. -->
                    <p v-if="previewingPlan[row.original.id]" class="plan-pending">
                      Считаю план без записи…
                    </p>
                    <p v-else-if="planErrors[row.original.id]" class="learning-plan-error">
                      {{ planErrors[row.original.id] }}
                    </p>
                    <!-- CHANGED: v-for по одноэлементному массиву как локальный алиас
                         плана — иначе в разметке 15 раз повторяется planFor(id)!. -->
                    <template
                      v-for="plan in planFor(row.original.id) ? [planFor(row.original.id)!] : []"
                      :key="`plan-${row.original.id}`"
                    >
                      <header>
                        <ul class="plan-counts">
                          <li
                            class="adaptive-help"
                            tabindex="0"
                            :data-tooltip="adaptiveStepHelp('Phrase')"
                            :aria-label="`Фразы: ${plan.phrases.length}. ${adaptiveStepHelp('Phrase')}`"
                          >
                            <b>{{ plan.phrases.length }}</b>
                            <span class="adaptive-help-term">Фразы</span>
                          </li>
                          <li
                            class="adaptive-help"
                            tabindex="0"
                            :data-tooltip="adaptiveStepHelp('Bridge')"
                            :aria-label="`Связки: ${plan.bridges}. ${adaptiveStepHelp('Bridge')}`"
                          >
                            <b>{{ plan.bridges }}</b>
                            <span class="adaptive-help-term">Связки</span>
                          </li>
                          <li
                            class="adaptive-help"
                            tabindex="0"
                            :data-tooltip="adaptiveStepHelp('Review')"
                            :aria-label="`Повторы: ${plan.reviews}. ${adaptiveStepHelp('Review')}`"
                          >
                            <b>{{ plan.reviews }}</b>
                            <span class="adaptive-help-term">Повторы</span>
                          </li>
                          <li
                            class="adaptive-help"
                            tabindex="0"
                            :data-tooltip="adaptiveStepHelp('Summarize')"
                            :aria-label="`Итоги: ${plan.summaries}. ${adaptiveStepHelp('Summarize')}`"
                          >
                            <b>{{ plan.summaries }}</b>
                            <span class="adaptive-help-term">Итоги</span>
                          </li>
                        </ul>
                        <div
                          class="plan-hyper adaptive-help"
                          tabindex="0"
                          :data-tooltip="HYPERMETER_HELP"
                          :aria-label="`Ритмическая сетка: цикл ${plan.hypermeter.period} такта, сдвиг ${plan.hypermeter.phase}, уверенность ${Math.round(plan.hypermeter.confidence * 100)} процентов. ${HYPERMETER_HELP}`"
                        >
                          <span class="plan-hyper-label adaptive-help-term">Ритмическая сетка</span>
                          <b class="plan-hyper-value">
                            {{ plan.hypermeter.period }}<i> т.</i>
                          </b>
                          <span class="plan-hyper-track" aria-hidden="true">
                            <em :style="{ width: `${Math.round(plan.hypermeter.confidence * 100)}%` }" />
                          </span>
                          <span class="plan-hyper-hint">
                            старт +{{ plan.hypermeter.phase }} · уверенность
                            {{ Math.round(plan.hypermeter.confidence * 100) }}%
                          </span>
                        </div>
                      </header>

                      <section class="plan-block">
                        <p class="plan-caption">
                          <span
                            class="adaptive-help adaptive-help-term"
                            tabindex="0"
                            :data-tooltip="FORM_MAP_HELP"
                            :aria-label="FORM_MAP_HELP"
                          >
                            Карта формы
                          </span>
                          <b>{{ planSpan(plan).total }} тактов</b>
                        </p>
                        <div
                          class="plan-map"
                          role="group"
                          :aria-label="`Карта формы: ${plan.phrases.length} фраз на ${planSpan(plan).total} тактах`"
                        >
                          <span
                            v-for="(segment, index) in planSegments(plan)"
                            :key="segment.key"
                            class="plan-map-seg"
                            :class="{ 'is-alt': index % 2 === 1, 'is-tight': segment.width < 5 }"
                            :style="{ width: `${segment.width}%` }"
                            tabindex="0"
                            :data-tooltip="`Фраза ${index + 1}: такты ${segment.start}–${segment.end}, длина ${segment.length} тактов. Ширина блока показывает её долю в произведении.`"
                            :aria-label="`Фраза ${index + 1}: такты ${segment.start}–${segment.end}, длина ${segment.length} тактов`"
                          >
                            <i>{{ segment.start }}</i>
                          </span>
                        </div>
                        <p class="plan-ruler" aria-hidden="true">
                          <span>т. {{ planSpan(plan).first }}</span>
                          <span>т. {{ planSpan(plan).last }}</span>
                        </p>
                      </section>

                      <ul class="learning-plan-quality">
                        <li
                          v-for="metric in qualityMetrics(plan)"
                          :key="metric.key"
                          class="adaptive-help"
                          :class="`is-${metric.tone}`"
                          tabindex="0"
                          :data-tooltip="`${metric.help} Ориентир: ${metric.target}.`"
                          :aria-label="`${metric.label}: ${metric.text}. Ориентир ${metric.target}. ${metric.help}`"
                        >
                          <span class="plan-metric-label">
                            <span class="adaptive-help-term">{{ metric.label }}</span>
                            <code>{{ metric.code }}</code>
                          </span>
                          <b>{{ metric.text }}</b>
                          <i aria-hidden="true"><em :style="{ width: `${Math.round(metric.fill * 100)}%` }" /></i>
                        </li>
                      </ul>

                      <section class="plan-block">
                        <p class="plan-caption">
                          <span
                            class="adaptive-help adaptive-help-term"
                            tabindex="0"
                            :data-tooltip="BOUNDARY_LIST_HELP"
                            :aria-label="BOUNDARY_LIST_HELP"
                          >
                            Почему здесь граница
                          </span>
                          <b>{{ plan.phrases.length }} разрезов</b>
                        </p>
                        <ol class="learning-plan-boundaries">
                          <li
                            v-for="(segment, index) in planSegments(plan)"
                            :key="segment.key"
                          >
                            <span class="plan-phrase-no">{{ String(index + 1).padStart(2, "0") }}</span>
                            <span class="plan-phrase-range">
                              <code>{{ segment.start }}–{{ segment.end }}</code>
                              <i>{{ segment.length }} т.</i>
                            </span>
                            <span class="plan-phrase-reasons">
                              <em
                                v-for="reason in segment.reasons"
                                :key="reason"
                                class="adaptive-help"
                                tabindex="0"
                                :data-tooltip="boundaryReasonHelp(reason)"
                                :aria-label="`${reason}. ${boundaryReasonHelp(reason)}`"
                              >
                                <span class="adaptive-help-term">{{ reason }}</span>
                              </em>
                            </span>
                          </li>
                        </ol>
                      </section>

                      <div v-if="plan.warnings.length" class="learning-plan-warnings">
                        <p v-for="warning in plan.warnings" :key="warning">{{ warning }}</p>
                      </div>

                      <footer class="plan-foot">
                        <p>Сборка удалит текущую схему и создаст её заново по этим границам.</p>
                        <!-- CHANGED: основное действие панели получило собственный
                             стиль (.plan-build) — pill с mono-капслоком и круглым
                             «шевроном»; общий .table-primary-action тут выглядел
                             как случайная кнопка из строки таблицы. -->
                        <button
                          type="button"
                          class="plan-build"
                          :disabled="row.original.learningState === 'running'"
                          aria-label="Собрать по этому плану"
                          @click="startLearning(row.original, ADAPTIVE_PREVIEW_STRATEGY)"
                        >
                          <span class="action-label">Собрать по этому плану</span>
                          <span class="action-arrow" aria-hidden="true">
                            <i><UiIcon name="chevron-right" :size="15" /></i>
                          </span>
                        </button>
                      </footer>
                    </template>
                    </div>

                    <!-- CHANGED: вкладка аппликатуры — анализ, карта рук, разбор
                         фрагмента и учебный конспект -->
                    <div
                      :id="`piece-${row.original.id}-fingering-panel`"
                      v-show="activeTab(row.original.id) === 'fingering'"
                      role="tabpanel"
                      :aria-labelledby="`piece-${row.original.id}-fingering-tab`"
                      class="panel-page fingering-page"
                      :class="{ 'is-score-focused': focusScores[row.original.id] }"
                      tabindex="-1"
                    >
                      <p
                        v-if="fingeringBusy[row.original.id]"
                        class="plan-pending"
                        role="status"
                        aria-live="polite"
                      >
                        {{ fingeringBusyLabel(row.original.id) }}
                      </p>
                      <p
                        v-else-if="fingeringErrors[row.original.id]"
                        class="learning-plan-error"
                        role="alert"
                      >
                        {{ fingeringErrors[row.original.id] }}
                      </p>

                      <section
                        class="fg-workbench"
                        :aria-labelledby="`piece-${row.original.id}-fingering-actions-title`"
                      >
                        <div class="fg-workbench-copy">
                          <span class="fg-state">Мастерская аппликатуры</span>
                          <h3 :id="`piece-${row.original.id}-fingering-actions-title`">
                            Найдите удобное движение
                          </h3>
                          <p>
                            Проверьте предложенные пальцы в контексте фразы и подберите размер кисти.
                            Авторские цифры сохраняются. Кнопка справа заменит ноты этой композиции
                            в Piano Marvel проверенной вами версией.
                          </p>
                        </div>
                        <div class="fg-actions" role="group" aria-label="Действия с аппликатурой">
                          <button
                            type="button"
                            class="plan-build fg-action-fill"
                            :class="{
                              'is-loading': scoreUpdating[row.original.id] === 'fingered',
                            }"
                            :disabled="
                              Boolean(fingeringBusy[row.original.id]) ||
                              Boolean(scoreUpdating[row.original.id])
                            "
                            @click="updatePianoMarvelScore(row.original, 'fingered', false)"
                          >
                            <span class="action-label">
                              {{
                                scoreUpdating[row.original.id] === "fingered"
                                  ? "Отправляю MXL…"
                                  : "Обновить на Piano Marvel"
                              }}
                            </span>
                            <span class="action-arrow" aria-hidden="true">
                              <i><UiIcon name="chevron-right" :size="15" /></i>
                            </span>
                          </button>
                        </div>
                        <div
                          v-if="fingeringBuilds[row.original.id]"
                          class="fg-built"
                          role="status"
                          aria-live="polite"
                        >
                          <span class="fg-built-label">
                            <UiIcon name="check" :size="14" />
                            Две версии MXL сохранены
                          </span>
                          <small>Ресурс · классическая привязка к нотам</small>
                          <p class="mono fg-path">{{ fingeringBuilds[row.original.id]!.path }}</p>
                          <small>Piano Marvel · цифры совместимы с загрузчиком</small>
                          <p class="mono fg-path">
                            {{ fingeringBuilds[row.original.id]!.uploadPath }}
                          </p>
                          <div class="fg-open">
                            <button
                              type="button"
                              class="fg-open-btn"
                              :disabled="fingeringOpening[row.original.id]"
                              @click="openBuilt(row.original, false)"
                            >
                              <UiIcon name="music" :size="14" />
                              <span>{{ openLabel(row.original.id) }}</span>
                            </button>
                            <button
                              type="button"
                              class="fg-open-btn"
                              :disabled="fingeringOpening[row.original.id]"
                              @click="openBuilt(row.original, true)"
                            >
                              <UiIcon name="folder" :size="14" />
                              <span>Показать в Finder</span>
                            </button>
                          </div>
                        </div>
                      </section>

                      <template
                        v-for="report in fingeringReports[row.original.id]
                          ? [fingeringReports[row.original.id]!]
                          : []"
                        :key="`fingering-${row.original.id}`"
                      >
                        <section class="fg-hand" aria-label="Размер кисти">
                          <div class="fg-hand-copy">
                            <span class="fg-state">Ваша рука</span>
                            <p>
                              Аппликатура считается под размер кисти: растяжения
                              масштабируются, и удобный вариант меняется.
                            </p>
                          </div>
                          <div class="fg-hand-options" role="group" aria-label="Размер кисти">
                            <button
                              v-for="span in HAND_SPANS"
                              :key="span.value"
                              type="button"
                              :class="{ 'is-on': handSpanOf(row.original.id) === span.value }"
                              :aria-pressed="handSpanOf(row.original.id) === span.value"
                              :disabled="Boolean(fingeringBusy[row.original.id])"
                              @click="selectHandSpan(row.original, span.value)"
                            >
                              <b>{{ span.label }}</b>
                              <small>{{ span.hint }}</small>
                            </button>
                          </div>
                        </section>

                        <header class="fg-head fg-head-compact">
                          <div>
                            <span class="fg-state">{{ coverageLabel(report) }}</span>
                            <strong class="mono">
                              {{ report.stats.notes }} нот · {{ report.stats.rightNotes }} правая ·
                              {{ report.stats.leftNotes }} левая
                            </strong>
                          </div>
                          <span class="fg-existing">{{ existingLabel(report) }}</span>
                        </header>

                        <section
                          class="fg-score-workspace"
                          tabindex="0"
                          :aria-label="`Нотная партитура. Выбран такт ${
                            report.measures[selectedMeasurePosition(row.original.id, report)]?.number ?? '—'
                          }. Стрелки влево и вправо переключают такты.`"
                          @keydown="onScoreNavigationKey(row.original.id, report, $event)"
                        >
                          <header class="fg-score-toolbar">
                            <button type="button" class="fg-focus-toggle"
                              :aria-pressed="Boolean(focusScores[row.original.id])"
                              @click="toggleScoreFocus(row.original.id)">
                              {{ focusScores[row.original.id] ? "Все инструменты" : "Сосредоточиться на нотах" }}
                            </button>
                            <div class="fg-score-title">
                              <span class="fg-state">Партитура с аппликатурой</span>
                              <strong aria-live="polite" aria-atomic="true">
                                Такт
                                {{
                                  report.measures[
                                    selectedMeasurePosition(row.original.id, report)
                                  ]?.number ?? "—"
                                }}
                              </strong>
                            </div>
                            <label class="fg-measure-jump">
                              <span>Перейти к такту</span>
                              <input
                                type="text"
                                inputmode="numeric"
                                autocomplete="off"
                                :value="
                                  report.measures[
                                    selectedMeasurePosition(row.original.id, report)
                                  ]?.number ?? ''
                                "
                                :aria-label="`Номер такта, от ${report.measures[0]?.number ?? 1} до ${
                                  report.measures[report.measures.length - 1]?.number ?? 1
                                }`"
                                @change="
                                  selectMeasureFromInput(row.original.id, report, $event)
                                "
                                @keydown.enter="
                                  selectMeasureFromInput(row.original.id, report, $event);
                                  ($event.target as HTMLInputElement).blur()
                                "
                                @focus="($event.target as HTMLInputElement).select()"
                              />
                            </label>
                            <div
                              class="fg-span-switch"
                              role="group"
                              aria-label="Сколько тактов показывать"
                            >
                              <button
                                v-for="span in MEASURE_SPANS"
                                :key="span"
                                type="button"
                                :class="{ 'is-on': measureSpan(row.original.id) === span }"
                                :aria-pressed="measureSpan(row.original.id) === span"
                                @click="selectedSpan[row.original.id] = span"
                              >
                                {{ span }}
                              </button>
                              <span>{{ spanLabel(row.original.id) }}</span>
                            </div>
                          </header>

                          <FingeringScore
                            v-if="fingeringPreviews[row.original.id]"
                            :xml="fingeringPreviews[row.original.id]!"
                            :measure-number="
                              selectedMeasurePosition(row.original.id, report) + 1
                            "
                            :measure-span="measureSpan(row.original.id)"
                          />
                          <div
                            v-else
                            class="fg-score-skeleton"
                            role="status"
                            aria-live="polite"
                          >
                            <span>Готовлю нотный лист…</span>
                          </div>

                          <nav class="fg-measure-nav" aria-label="Переключение тактов">
                            <button
                              type="button"
                              class="fg-measure-step"
                              :disabled="
                                selectedMeasurePosition(row.original.id, report) === 0
                              "
                              aria-label="Предыдущий такт"
                              title="Предыдущий такт (←)"
                              @click="stepMeasure(row.original.id, report, -1)"
                            >
                              <UiIcon name="chevron-left" :size="18" />
                              <span>Назад</span>
                            </button>

                            <label class="fg-measure-range">
                              <span class="sr-only">Выбрать такт</span>
                              <input
                                type="range"
                                min="0"
                                :max="Math.max(0, report.measures.length - 1)"
                                step="1"
                                :disabled="report.measures.length <= 1"
                                :value="selectedMeasurePosition(row.original.id, report)"
                                :aria-valuetext="`Такт ${
                                  report.measures[
                                    selectedMeasurePosition(row.original.id, report)
                                  ]?.number ?? '—'
                                } из ${report.measures.length}`"
                                @input="
                                  selectMeasureAt(
                                    row.original.id,
                                    report,
                                    Number(($event.target as HTMLInputElement).value),
                                  )
                                "
                              />
                              <span class="fg-measure-range-labels" aria-hidden="true">
                                <span>{{ report.measures[0]?.number ?? "1" }}</span>
                                <b>
                                  {{
                                    selectedMeasurePosition(row.original.id, report) + 1
                                  }}
                                  / {{ report.measures.length }}
                                </b>
                                <span>
                                  {{
                                    report.measures[report.measures.length - 1]?.number ?? "1"
                                  }}
                                </span>
                              </span>
                            </label>

                            <button
                              type="button"
                              class="fg-measure-step is-next"
                              :disabled="
                                !report.measures.length ||
                                selectedMeasurePosition(row.original.id, report) ===
                                  report.measures.length - 1
                              "
                              aria-label="Следующий такт"
                              title="Следующий такт (→)"
                              @click="stepMeasure(row.original.id, report, 1)"
                            >
                              <span>Дальше</span>
                              <UiIcon name="chevron-right" :size="18" />
                            </button>
                          </nav>
                          <p class="fg-keyboard-hint">
                            <kbd>←</kbd><kbd>→</kbd> переключают такты ·
                            <kbd>Home</kbd><kbd>End</kbd> — начало и конец
                          </p>
                        </section>

                        <details
                          v-for="item in traceFor(row.original.id) ? [traceFor(row.original.id)!] : []"
                          :key="`trace-${item.noteIndex}`"
                          class="fg-trace-details"
                        >
                          <summary>
                            <span>
                              Логика первой ноты · палец {{ item.finger }}
                              <small>
                                {{ item.hand === "R" ? "правая" : "левая" }} рука ·
                                {{ noteName(item.midi) }}
                              </small>
                            </span>
                            <span class="fg-details-action">Показать расчёт</span>
                          </summary>
                          <article class="fg-trace">
                            <ul>
                              <li v-if="item.pattern">
                                <span>{{ PATTERN_LABELS[item.pattern] }} — аппликатура школы</span>
                                <em class="mono">приор</em>
                              </li>
                              <li v-for="reason in item.reasons" :key="reason.rule">
                                <span>{{ ruleLabel(reason.rule) }}</span>
                                <em class="mono">+{{ reason.points }}</em>
                              </li>
                              <li
                                v-for="adjustment in item.adjustments"
                                :key="`adjustment-${adjustment.kind}`"
                              >
                                <span>
                                  педагогический приор:
                                  {{ PATTERN_LABELS[adjustment.kind] ?? adjustment.kind }}
                                </span>
                                <em class="mono">{{ adjustment.points }}</em>
                              </li>
                              <li v-if="!item.reasons.length && !item.pattern">
                                <span>
                                  ни одно правило не начислило штрафа — позиция руки не
                                  меняется
                                </span>
                                <em class="mono">0</em>
                              </li>
                            </ul>
                          </article>
                        </details>

                        <details v-if="report.warnings.length" class="fg-warnings">
                          <summary>
                            <span>
                              <UiIcon name="warning" :size="15" />
                              {{ warningCountLabel(report.warnings.length) }}
                            </span>
                            <span class="fg-warnings-hint">Показать детали</span>
                          </summary>
                          <ul>
                            <li v-for="warning in report.warnings" :key="warning">
                              {{ warning }}
                            </li>
                          </ul>
                        </details>

                        <details class="fg-diagnostics">
                          <summary>
                            <span>
                              <strong>Диагностика анализа</strong>
                              <small>
                                {{ report.patterns.length }} фигур ·
                                {{ report.stats.positionChanges }} смен позиции
                              </small>
                            </span>
                            <span class="fg-details-action">Подробнее</span>
                          </summary>
                          <div class="fg-diagnostics-body">
                            <ul class="fg-metrics-compact">
                              <li>
                                <b>{{ report.stats.positionChanges }}</b>
                                <span>смен позиции</span>
                              </li>
                              <li>
                                <b>{{ report.stats.thumbOnBlack }}</b>
                                <span>1-й на чёрной</span>
                              </li>
                              <li class="is-cost-metric">
                                <b>{{ metricValue(report.stats.ergonomicCostPerNote) }}</b>
                                <span
                                  title="Положительная физическая нагрузка модели Parncutt без педагогических приоров"
                                >
                                  эргономика / нота
                                </span>
                                <small
                                  class="fg-metric-adjustment"
                                  :class="{
                                    'is-discount':
                                      report.stats.pedagogyAdjustmentPerNote < 0,
                                    'is-surcharge':
                                      report.stats.pedagogyAdjustmentPerNote > 0,
                                  }"
                                  :title="`Педагогическая поправка к внутренней целевой функции; objective / нота = ${report.stats.costPerNote}`"
                                >
                                  {{
                                    pedagogyAdjustmentLabel(
                                      report.stats.pedagogyAdjustmentPerNote,
                                    )
                                  }}
                                </small>
                              </li>
                              <li>
                                <b>{{ report.stats.patternNotes }}</b>
                                <span>нот по фигурам</span>
                              </li>
                            </ul>

                            <section class="fg-diagnostic-section">
                              <p class="plan-caption">Карта нагрузки</p>
                              <div class="fg-map" role="group" aria-label="Нагрузка по тактам">
                                <button
                                  v-for="measure in report.measures"
                                  :key="measure.index"
                                  type="button"
                                  class="fg-col"
                                  :class="{
                                    'is-active':
                                      selectedMeasure[row.original.id] === measure.index,
                                  }"
                                  :aria-label="`Такт ${measure.number}: правая — ${
                                    measure.right.positionChanges
                                  } смен позиции, штраф ${measure.right.cost.toFixed(
                                    1,
                                  )}; левая — ${
                                    measure.left.positionChanges
                                  } смен позиции, штраф ${measure.left.cost.toFixed(1)}`"
                                  @click="
                                    selectedMeasure[row.original.id] = measure.index;
                                    delete selectedNote[row.original.id]
                                  "
                                >
                                  <i
                                    class="fg-bar is-right"
                                    :class="loadTone(measure.right.cost, peakCost(report))"
                                    :style="{
                                      height: barHeight(
                                        measure.right.positionChanges,
                                        peakLoad(report),
                                      ),
                                    }"
                                  />
                                  <span class="fg-axis" />
                                  <i
                                    class="fg-bar is-left"
                                    :class="loadTone(measure.left.cost, peakCost(report))"
                                    :style="{
                                      height: barHeight(
                                        measure.left.positionChanges,
                                        peakLoad(report),
                                      ),
                                    }"
                                  />
                                </button>
                              </div>
                            </section>

                            <section
                              v-if="report.patterns.length"
                              class="fg-diagnostic-section"
                            >
                              <p class="plan-caption">Распознанные фигуры</p>
                              <ul class="fg-patterns">
                                <li
                                  v-for="pattern in patternSummaries(report)"
                                  :key="pattern.key"
                                >
                                  <span class="fg-chip">
                                    {{ PATTERN_LABELS[pattern.kind] ?? pattern.kind }}
                                  </span>
                                  <span>{{ pattern.label }}</span>
                                  <em class="mono">
                                    {{ pattern.hand === "R" ? "правая" : "левая" }} ·
                                    {{ pattern.count }} фрагм. · такты
                                    {{ pattern.ranges.join(", ") }}
                                  </em>
                                </li>
                              </ul>
                            </section>

                            <details
                              class="fg-manual"
                              :open="handRulesOpen[row.original.id]"
                              @toggle="
                                handRulesOpen[row.original.id] = (
                                  $event.target as HTMLDetailsElement
                                ).open
                              "
                            >
                              <summary>Как подобрать аппликатуру самому</summary>
                              <ol>
                                <li v-for="rule in HAND_RULES" :key="rule.title">
                                  <strong>{{ rule.title }}</strong>
                                  <span>{{ rule.text }}</span>
                                </li>
                              </ol>
                            </details>
                          </div>
                        </details>
                      </template>

                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <footer class="table-pagination">
        <span>
          Показано <strong>{{ pageSummary.start }}–{{ pageSummary.end }}</strong> из {{ pageSummary.total }}
        </span>
        <div class="pagination-actions">
          <label>
            <span class="sr-only">Строк на странице</span>
            <select
              :value="pagination.pageSize"
              @change="table.setPageSize(Number(($event.target as HTMLSelectElement).value))"
            >
              <option :value="8">8 строк</option>
              <option :value="16">16 строк</option>
              <option :value="32">32 строки</option>
            </select>
          </label>
          <button
            type="button"
            :disabled="!table.getCanPreviousPage()"
            aria-label="Предыдущая страница"
            @click="table.previousPage()"
          >
            <UiIcon name="chevron-left" :size="16" />
          </button>
          <span class="page-number mono">{{ pagination.pageIndex + 1 }} / {{ table.getPageCount() }}</span>
          <button
            type="button"
            :disabled="!table.getCanNextPage()"
            aria-label="Следующая страница"
            @click="table.nextPage()"
          >
            <UiIcon name="chevron-right" :size="16" />
          </button>
        </div>
      </footer>
    </template>

    <!-- Teleport логически вложен в основной element-root; уведомление всё так же
         монтируется в body, а id/прочие fallthrough-атрибуты наследует section. -->
    <Teleport to="body">
      <Transition name="status-toast">
        <aside
          v-if="statusToast"
          class="status-toast"
          :class="statusToast.tone"
          :role="statusToast.tone === 'error' ? 'alert' : 'status'"
          aria-live="polite"
          aria-atomic="true"
        >
          <span class="status-toast-icon" aria-hidden="true">
            <UiIcon
              :name="
                statusToast.tone === 'success'
                  ? 'check'
                  : statusToast.tone === 'error'
                    ? 'warning'
                    : 'refresh'
              "
              :size="18"
            />
          </span>
          <div class="status-toast-content">
            <strong>{{ statusToast.title }}</strong>
            <span>{{ statusToast.message }}</span>
            <span class="status-toast-progress" aria-hidden="true">
              <i :style="{ width: `${statusToast.progress}%` }" />
            </span>
          </div>
          <button type="button" aria-label="Закрыть уведомление" @click="closeStatusToast">
            <UiIcon name="close" :size="15" />
          </button>
        </aside>
      </Transition>
    </Teleport>
  </section>
</template>
