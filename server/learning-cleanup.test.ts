import { describe, expect, test } from "bun:test";
import { selectWholeTemplate } from "./learning-cleanup";

describe("чистое пересоздание Learn Mode", () => {
  test("берёт самый длинный двуручный Whole и создаёт новую запись", () => {
    const template = selectWholeTemplate([
      { id: 11, title: "Whole - RH", startMeasure: 1, endMeasure: 64, staffs: [true, false] },
      { id: 12, title: "Short", startMeasure: 1, endMeasure: 8, staffs: [true, true] },
      { id: 13, title: "Whole", startMeasure: 1, endMeasure: 64, staffs: [true, true] },
    ]);

    expect(template).toEqual({
      id: null,
      title: "Whole",
      start_measure: 1,
      end_measure: 64,
      start_tick: 1,
      end_tick: 1,
      staffs: [true, true],
      index: 0,
      omit_title: false,
    });
  });

  test("не начинает удаление без исходного Whole", () => {
    expect(selectWholeTemplate([])).toBeUndefined();
  });

  test("починит диапазон Whole по MusicXML, если Piano Marvel его не посчитал", () => {
    // Наблюдалось на живой пьесе: после загрузки все Whole приходят как 0-0, хотя
    // партитура на странице рисуется. Число тактов известно из привязанного MusicXML,
    // поэтому диапазон восстанавливается, а не выдумывается.
    const template = selectWholeTemplate(
      [
        { title: "Cornfield Chase", startMeasure: 0, endMeasure: 0, staffs: [true, true] },
        { title: "Cornfield Chase - RH", startMeasure: 0, endMeasure: 0, staffs: [true, false] },
        { title: "Cornfield Chase - LH", startMeasure: 0, endMeasure: 0, staffs: [false, true] },
      ],
      64,
    );

    expect(template).toMatchObject({
      title: "Cornfield Chase",
      start_measure: 1,
      end_measure: 64,
      staffs: [true, true],
    });
  });

  test("без числа тактов нулевой диапазон не восстанавливается", () => {
    expect(
      selectWholeTemplate([
        { title: "Cornfield Chase", startMeasure: 0, endMeasure: 0, staffs: [true, true] },
      ]),
    ).toBeUndefined();
  });

  test("настоящий диапазон важнее подсказки из MusicXML", () => {
    expect(
      selectWholeTemplate(
        [{ title: "Whole", startMeasure: 1, endMeasure: 109, staffs: [true, true] }],
        64,
      ),
    ).toMatchObject({ start_measure: 1, end_measure: 109 });
  });

  test("нормализует старые Whole без полного массива staffs", () => {
    expect(
      selectWholeTemplate([
        { title: "Whole", startMeasure: 1, endMeasure: 64, staffs: [true] },
      ])?.staffs,
    ).toEqual([true, true]);
  });
});
