import type { SensorAdapter } from "../types";
import { rpmToSpeedMps } from "./grade";

/**
 * ESP32 + Web Serial 入力（Phase 2）。
 * ESP32側は `RPM:72.5` 形式の行を 1秒ごとに Serial.println する想定。
 * Chrome系デスクトップブラウザのみ対応。
 */
export class SerialSensor implements SensorAdapter {
  private rpm = 0;
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private running = false;
  /** RPMが一定時間更新されない場合に0とみなす [ms] */
  private staleTimeoutMs = 3000;
  private lastUpdate = 0;

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
          const m = line.trim().match(/^RPM:([\d.]+)$/);
          if (m) {
            this.rpm = parseFloat(m[1]);
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
    this.rpm = 0;
  }

  getRpm(): number {
    if (performance.now() - this.lastUpdate > this.staleTimeoutMs) return 0;
    return this.rpm;
  }

  getSpeedMps(): number {
    return rpmToSpeedMps(this.getRpm());
  }
}
