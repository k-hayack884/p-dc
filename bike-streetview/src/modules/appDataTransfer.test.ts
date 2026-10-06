import { beforeEach, describe, expect, it } from "vitest";
import {
  appDataExportFilename,
  exportAppData,
  importAppData,
  parseAppDataExport,
  serializeAppDataExport,
} from "./appDataTransfer";

describe("appDataTransfer", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("Bike Street ViewのlocalStorageだけを書き出す", () => {
    window.localStorage.setItem("bike-streetview:custom-routes", "[{}]");
    window.localStorage.setItem("other-app:key", "ignored");

    const exported = exportAppData(window.localStorage);

    expect(exported.schema).toBe("bike-streetview-local-data");
    expect(exported.version).toBe(1);
    expect(exported.items).toEqual({
      "bike-streetview:custom-routes": "[{}]",
    });
  });

  it("書き出したJSONを読み込める", () => {
    window.localStorage.setItem("bike-streetview:route-titles", "{}");
    const jsonText = serializeAppDataExport(exportAppData(window.localStorage));

    window.localStorage.clear();
    const parsed = parseAppDataExport(jsonText);
    const result = importAppData(window.localStorage, parsed);

    expect(result.importedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.backupKey).toBeNull();
    expect(window.localStorage.getItem("bike-streetview:route-titles")).toBe(
      "{}"
    );
  });

  it("読み込み時に既存のBike Street Viewデータを残してバックアップする", () => {
    const jsonText = JSON.stringify({
      schema: "bike-streetview-local-data",
      version: 1,
      exportedAt: "2026-07-09T00:00:00.000Z",
      items: {
        "bike-streetview:custom-routes": "[]",
      },
    });

    window.localStorage.setItem("bike-streetview:route-titles", "{}");
    window.localStorage.setItem("other-app:key", "keep");

    importAppData(window.localStorage, parseAppDataExport(jsonText));

    expect(window.localStorage.getItem("bike-streetview:route-titles")).toBe(
      "{}"
    );
    expect(window.localStorage.getItem("bike-streetview:custom-routes")).toBe(
      "[]"
    );
    expect(window.localStorage.getItem("other-app:key")).toBe("keep");

    const backupKey = Object.keys(window.localStorage).find((key) =>
      key.startsWith("bike-streetview-backup:")
    );
    expect(backupKey).toBeDefined();
    expect(window.localStorage.getItem(backupKey as string)).toContain(
      "bike-streetview:route-titles"
    );
  });

  it("不正な移行JSONはエラーにする", () => {
    expect(() => parseAppDataExport('{"items":{}}')).toThrow(
      "Bike Street Viewの移行データではありません"
    );
  });

  it("ファイル名にISO時刻を含める", () => {
    expect(appDataExportFilename(new Date("2026-07-09T01:02:03.456Z"))).toBe(
      "bike-streetview-data-2026-07-09T010203Z.json"
    );
  });
});
