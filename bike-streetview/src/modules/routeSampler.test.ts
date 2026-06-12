import { describe, expect, it } from "vitest";
import type { Route } from "../types";
import { getPointAtDistance } from "./routeSampler";

const route: Route = {
  name: "test",
  intervalMeters: 100,
  points: [
    {
      lat: 34,
      lng: 135,
      distance: 0,
      elevation: 10,
      grade: 2,
      heading: 350,
    },
    {
      lat: 35,
      lng: 136,
      distance: 100,
      elevation: 20,
      grade: 4,
      heading: 10,
    },
  ],
};

describe("getPointAtDistance", () => {
  it("区間内を補間する", () => {
    const point = getPointAtDistance(route, 50);
    expect(point.lat).toBeCloseTo(34.5);
    expect(point.lng).toBeCloseTo(135.5);
    expect(point.elevation).toBeCloseTo(15);
    expect(point.grade).toBe(2);
    expect(point.heading).toBeCloseTo(0);
  });

  it("範囲外では端点を返す", () => {
    expect(getPointAtDistance(route, -1)).toBe(route.points[0]);
    expect(getPointAtDistance(route, 101)).toBe(route.points[1]);
  });
});
