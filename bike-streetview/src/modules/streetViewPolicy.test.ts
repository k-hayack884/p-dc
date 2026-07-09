import { describe, expect, it } from "vitest";
import {
  STREET_VIEW_FINE_INTERVAL_METERS,
  STREET_VIEW_STANDARD_INTERVAL_METERS,
  streetViewIntervalMeters,
} from "./streetViewPolicy";

describe("streetViewIntervalMeters", () => {
  it("10km未満のルートは50m更新にする", () => {
    expect(
      streetViewIntervalMeters({
        routeDistanceMeters: 9_999,
        speedKmh: 28,
      })
    ).toBe(STREET_VIEW_FINE_INTERVAL_METERS);
  });

  it("10km以上の長距離ルートは100m更新に固定する", () => {
    expect(
      streetViewIntervalMeters({
        routeDistanceMeters: 10_000,
        speedKmh: 8,
      })
    ).toBe(STREET_VIEW_STANDARD_INTERVAL_METERS);
  });
});
