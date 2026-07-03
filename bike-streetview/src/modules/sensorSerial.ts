import type { SensorAdapter } from "../types";
import { rpmToSpeedMps } from "./grade";

export type Esp32SerialSample = {
  rpm: number;
  pulses?: number;
  timestampMs?: number;
};

const MAX_RPM = 240;
const RPM_CHANGE_PER_SECOND = 45;

function clampRpm(rpm: number): number {
  return Math.min(MAX_RPM, Math.max(0, rpm));
}

export function smoothRpmTowardTarget(
  currentRpm: number,
  targetRpm: number,
  elapsedSeconds: number,
  rpmChangePerSecond = RPM_CHANGE_PER_SECOND
): number {
  const safeElapsedSeconds = Math.max(0, Math.min(elapsedSeconds, 0.5));
  const difference = targetRpm - currentRpm;
  const maxChange = rpmChangePerSecond * safeElapsedSeconds;
  if (Math.abs(difference) <= maxChange) {
    return targetRpm;
  }
  return currentRpm + Math.sign(difference) * maxChange;
}

export function parseEsp32SerialLine(
  line: string
): Esp32SerialSample | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const legacyMatch = trimmed.match(/^RPM:([0-9]+(?:\.[0-9]+)?)$/);
  if (legacyMatch) {
    return { rpm: clampRpm(Number(legacyMatch[1])) };
  }

  if (!trimmed.startsWith("{")) return null;

  try {
    const data = JSON.parse(trimmed) as {
      rpm?: unknown;
      pulses?: unknown;
      timestamp_ms?: unknown;
    };
    if (typeof data.rpm !== "number" || !Number.isFinite(data.rpm)) {
      return null;
    }
    return {
      rpm: clampRpm(data.rpm),
      pulses:
        typeof data.pulses === "number" && Number.isFinite(data.pulses)
          ? data.pulses
          : undefined,
      timestampMs:
        typeof data.timestamp_ms === "number" &&
        Number.isFinite(data.timestamp_ms)
          ? data.timestamp_ms
          : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * ESP32 + Web Serial 入力（Phase 2）。
 * ESP32側は `{"pulses":1,"rpm":60.0,"timestamp_ms":123456}` 形式の
 * NDJSONを1秒ごとにSerial.printlnする想定。
 * 移行期間のため、旧形式 `RPM:72.5` も受け付ける。
 * Chrome系デスクトップブラウザのみ対応。
 */
export class SerialSensor implements SensorAdapter {
  private targetRpm = 0;
  private currentRpm = 0;
  private pulses = 0;
  private esp32TimestampMs = 0;
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private running = false;
  /** RPMが一定時間更新されない場合に0とみなす [ms] */
  private staleTimeoutMs = 3000;
  private lastUpdate = 0;
  private lastSmoothUpdate = performance.now();

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  async start(): Promise<void> {
    if (!SerialSensor.isSupported()) {
      throw new Error("このブラウザはWeb Serial非対応です（Chrome系を使用してください）");
    }
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    this.running = true;
    this.lastSmoothUpdate = performance.now();
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    if (!this.port?.readable) return;
    const decoder = new TextDecoder();
    let buffer = "";
    this.reader = this.port.readable.getReader();
    try {
      while (this.running) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const sample = parseEsp32SerialLine(line);
          if (sample) {
            this.targetRpm = sample.rpm;
            this.pulses = sample.pulses ?? this.pulses;
            this.esp32TimestampMs =
              sample.timestampMs ?? this.esp32TimestampMs;
            this.lastUpdate = performance.now();
          }
        }
      }
    } finally {
      this.reader.releaseLock();
    }
  }

  stop(): void {
    this.running = false;
    void this.reader?.cancel();
    void this.port?.close();
    this.port = null;
    this.targetRpm = 0;
    this.currentRpm = 0;
  }

  getRpm(): number {
    const now = performance.now();
    const targetRpm =
      now - this.lastUpdate > this.staleTimeoutMs ? 0 : this.targetRpm;
    this.currentRpm = smoothRpmTowardTarget(
      this.currentRpm,
      targetRpm,
      (now - this.lastSmoothUpdate) / 1000
    );
    this.lastSmoothUpdate = now;
    return this.running ? this.currentRpm : 0;
  }

  getSpeedMps(): number {
    return rpmToSpeedMps(this.getRpm());
  }

  getPulses(): number {
    return this.pulses;
  }

  getEsp32TimestampMs(): number {
    return this.esp32TimestampMs;
  }
}
