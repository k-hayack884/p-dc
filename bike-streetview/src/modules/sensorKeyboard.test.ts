import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyboardSensor } from "./sensorKeyboard";

describe("KeyboardSensorのリセット確認", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Rキーだけでは速度を変更しない", () => {
    const sensor = new KeyboardSensor();
    sensor.onReset = vi.fn();
    sensor.start();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "R" }));

    expect(sensor.onReset).toHaveBeenCalledOnce();
    expect(sensor.getSpeedMps()).toBeGreaterThan(0);
    sensor.stop();
  });

  it("明示的な停止操作で速度を0にする", () => {
    const sensor = new KeyboardSensor();
    sensor.start();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    sensor.stopPedaling();

    expect(sensor.getSpeedMps()).toBe(0);
    sensor.stop();
  });

  it("キー長押しでは確認を繰り返さない", () => {
    const sensor = new KeyboardSensor();
    sensor.onReset = vi.fn();
    sensor.start();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "R", repeat: true })
    );

    expect(sensor.onReset).not.toHaveBeenCalled();
    sensor.stop();
  });
});
