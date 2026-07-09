import { describe, expect, it } from "vitest";
import type { Route } from "../types";
import { hasCrossedSharpTurn } from "./routeTurnDetector";

const route: Route = {
  name: "turn",
  intervalMeters: 50,
  points: [
    {
      lat: 34,
      lng: 135,
      distance: 0,
      elevation: 0,
      grade: 0,
      heading: 90,
    },
    {
      lat: 34,
      lng: 135.001,
      distance: 50,
      elevation: 0,
      grade: 0,
      heading: 90,
    },
    {
      lat: 34.001,
      lng: 135.001,
      distance: 100,
      elevation: 0,
      grade: 0,
      heading: 45,
    },
    {
      lat: 34.002,
      lng: 135.0012,
      distance: 150,
      elevation: 0,
      grade: 0,
      heading: 20,
    },
  ],
};

describe("hasCrossedSharpTurn", () => {
  it("45度以上の曲がり角を跨いだ時だけtrueにする", () => {
    expect(hasCrossedSharpTurn(route, 99, 100)).toBe(true);
  });

  it("45度未満の曲がり角は無視する", () => {
    expect(hasCrossedSharpTurn(route, 149, 150)).toBe(false);
  });

  it("曲がり角の手前では更新しない", () => {
    expect(hasCrossedSharpTurn(route, 80, 99)).toBe(false);
  });

  it("停止または逆方向では更新しない", () => {
    expect(hasCrossedSharpTurn(route, 100, 100)).toBe(false);
    expect(hasCrossedSharpTurn(route, 101, 100)).toBe(false);
  });
});
