import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadStreetViewMonthlyUsage,
  recordStreetViewUsage,
} from "./streetViewUsage";

describe("streetViewUsage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00+09:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("今月のStreet View使用回数を記録する", () => {
    expect(loadStreetViewMonthlyUsage()).toEqual({
      month: "2026-07",
      count: 0,
    });

    expect(recordStreetViewUsage()).toEqual({
      month: "2026-07",
      count: 1,
    });
    expect(recordStreetViewUsage(2)).toEqual({
      month: "2026-07",
      count: 3,
    });
  });

  it("月が変わったら使用回数をリセットする", () => {
    recordStreetViewUsage(10);
    vi.setSystemTime(new Date("2026-08-01T00:00:00+09:00"));

    expect(loadStreetViewMonthlyUsage()).toEqual({
      month: "2026-08",
      count: 0,
    });
  });
});
