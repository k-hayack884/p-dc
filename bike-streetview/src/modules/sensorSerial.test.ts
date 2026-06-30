import { describe, expect, it } from "vitest";
import { parseEsp32SerialLine } from "./sensorSerial";

describe("parseEsp32SerialLine", () => {
  it("ESP32のNDJSONをRPMサンプルへ変換する", () => {
    expect(
      parseEsp32SerialLine(
        '{"pulses":2,"rpm":120.0,"timestamp_ms":123456}'
      )
    ).toEqual({
      pulses: 2,
      rpm: 120,
      timestampMs: 123456,
    });
  });

  it("旧RPM形式も読み取る", () => {
    expect(parseEsp32SerialLine("RPM:72.5")).toEqual({ rpm: 72.5 });
  });

  it("起動ログや壊れた行は無視する", () => {
    expect(
      parseEsp32SerialLine(
        '{"status":"boot","message":"esp32_hall_rpm_ready"}'
      )
    ).toBeNull();
    expect(parseEsp32SerialLine("{broken")).toBeNull();
    expect(parseEsp32SerialLine("")).toBeNull();
  });

  it("異常なRPMは安全範囲へ丸める", () => {
    expect(parseEsp32SerialLine('{"rpm":-10}')).toEqual({ rpm: 0 });
    expect(parseEsp32SerialLine('{"rpm":999}')).toEqual({ rpm: 240 });
  });
});
