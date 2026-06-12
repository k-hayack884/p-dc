import { describe, expect, it } from "vitest";
import {
  gradeFactor,
  rpmToSpeedMps,
  speedMpsToRpm,
} from "./grade";

describe("grade", () => {
  it("RPMと速度を相互変換する", () => {
    const speed = rpmToSpeedMps(90);
    expect(speed * 3.6).toBeCloseTo(19.8);
    expect(speedMpsToRpm(speed)).toBeCloseTo(90);
  });

  it("上り坂で減速し下限を守る", () => {
    expect(gradeFactor(5)).toBeCloseTo(0.85);
    expect(gradeFactor(100)).toBe(0.35);
  });

  it("下り坂で加速し上限を守る", () => {
    expect(gradeFactor(-5)).toBeCloseTo(1.075);
    expect(gradeFactor(-100)).toBe(1.35);
  });
});
