import { describe, expect, it } from "vitest";
import {
  formatCoordinateText,
  parseRouteWaypointInput,
  parseRouteWaypointLines,
} from "./routeWaypointInput";

describe("routeWaypointInput", () => {
  it("地名は文字列のまま扱う", () => {
    expect(parseRouteWaypointInput(" 大阪駅 ")).toBe("大阪駅");
  });

  it("緯度経度はRoutes API向けの座標に変換する", () => {
    expect(parseRouteWaypointInput("34.70038,135.54624")).toEqual({
      latitude: 34.70038,
      longitude: 135.54624,
      label: "34.700380,135.546240",
    });
  });

  it("表示名付き緯度経度はlabel付き座標に変換する", () => {
    expect(parseRouteWaypointInput("蒲生四丁目駅 | 34.70038,135.54624")).toEqual({
      latitude: 34.70038,
      longitude: 135.54624,
      label: "蒲生四丁目駅",
    });
  });

  it("改行区切りの経由地で地名と座標を混在できる", () => {
    expect(parseRouteWaypointLines("蒲生四丁目駅\n34.7 135.5\n")).toEqual([
      "蒲生四丁目駅",
      {
        latitude: 34.7,
        longitude: 135.5,
        label: "34.700000,135.500000",
      },
    ]);
  });

  it("緯度経度の範囲外は拒否する", () => {
    expect(() => parseRouteWaypointInput("999,135.5")).toThrow(
      "緯度経度は 緯度 -90〜90、経度 -180〜180 で入力してください"
    );
  });

  it("地図クリック用の座標文字列を固定小数で作る", () => {
    expect(
      formatCoordinateText({ latitude: 34.7, longitude: 135.5 })
    ).toBe("34.700000,135.500000");
  });
});
