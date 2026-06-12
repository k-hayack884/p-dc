import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualEsp32Sensor } from "./sensorVirtualEsp32";

describe("VirtualEsp32Sensor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("目標RPMへ徐々に追従する", () => {
    const sensor = new VirtualEsp32Sensor();
    sensor.start();
    sensor.setTargetRpm(60);

    vi.advanceTimersByTime(500);
    expect(sensor.getRpm()).toBeCloseTo(12, 0);

    for (let updateCount = 0; updateCount < 4; updateCount += 1) {
      vi.advanceTimersByTime(500);
      sensor.getRpm();
    }

    expect(sensor.getRpm()).toBeCloseTo(60, 0);
  });

  it("RPMを0から140に制限する", () => {
    const sensor = new VirtualEsp32Sensor();
    sensor.setTargetRpm(-10);
    expect(sensor.getTargetRpm()).toBe(0);
    sensor.setTargetRpm(200);
    expect(sensor.getTargetRpm()).toBe(140);
  });

  it("通信途絶中はRPMと速度を0にする", () => {
    const sensor = new VirtualEsp32Sensor();
    sensor.start();
    sensor.setTargetRpm(60);
    vi.advanceTimersByTime(3_000);
    sensor.setConnected(false);

    expect(sensor.getRpm()).toBe(0);
    expect(sensor.getSpeedMps()).toBe(0);
  });
});
