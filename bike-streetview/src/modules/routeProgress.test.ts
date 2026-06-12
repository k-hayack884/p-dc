import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRouteProgress,
  loadRouteProgress,
  saveRouteProgress,
} from "./routeProgress";

describe("routeProgress", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("ルート別に進捗を保存する", () => {
    saveRouteProgress("route-a", 123.6);
    saveRouteProgress("route-b", 456.2);

    expect(loadRouteProgress("route-a")).toBe(124);
    expect(loadRouteProgress("route-b")).toBe(456);
  });

  it("古い距離で巻き戻さない", () => {
    saveRouteProgress("route", 500);
    saveRouteProgress("route", 300);
    expect(loadRouteProgress("route")).toBe(500);
  });

  it("進捗を削除する", () => {
    saveRouteProgress("route", 100);
    clearRouteProgress("route");
    expect(loadRouteProgress("route")).toBe(0);
  });
});
