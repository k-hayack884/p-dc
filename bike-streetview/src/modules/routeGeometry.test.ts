import { describe, expect, it } from "vitest";
import { buildRouteFromCoordinates } from "./routeGeometry";

describe("buildRouteFromCoordinates", () => {
  it("指定間隔で再サンプリングする", () => {
    const route = buildRouteFromCoordinates(
      "test",
      [
        { lat: 34, lng: 135, elevation: 10 },
        { lat: 34.01, lng: 135, elevation: 20 },
      ],
      100
    );

    expect(route.points.length).toBeGreaterThan(10);
    expect(route.points[0].distance).toBe(0);
    expect(route.points.at(-1)?.distance).toBeGreaterThan(1_100);
  });

  it("標高ノイズを平滑化して勾配を制限する", () => {
    const route = buildRouteFromCoordinates(
      "test",
      [
        { lat: 34, lng: 135, elevation: 0 },
        { lat: 34.001, lng: 135, elevation: 100 },
        { lat: 34.002, lng: 135, elevation: 0 },
      ],
      25
    );

    expect(route.points.every((point) => Math.abs(point.grade) <= 12)).toBe(
      true
    );
    expect(Math.max(...route.points.map((point) => point.elevation))).toBeLessThan(
      100
    );
  });

  it("座標が2点未満なら失敗する", () => {
    expect(() =>
      buildRouteFromCoordinates("invalid", [{ lat: 34, lng: 135 }])
    ).toThrow("ルート座標が2点未満です");
  });
});
