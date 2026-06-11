import type { SensorAdapter } from "../types";
import { speedMpsToRpm } from "./grade";

/**
 * キーボード疑似入力（仕様書 8章 段階1）
 *  ↑: 速度アップ / ↓: 速度ダウン / Space: 停止 / R: リセット
 */
export class KeyboardSensor implements SensorAdapter {
  private speedKmh = 0;
  private readonly stepKmh: number;
  private readonly maxKmh: number;
  private handler = (e: KeyboardEvent) => this.onKey(e);
  /** Rキー押下時に呼ばれる（走行リセット用） */
  onReset?: () => void;

  constructor(stepKmh = 1, maxKmh = 45) {
    this.stepKmh = stepKmh;
    this.maxKmh = maxKmh;
  }

  start(): void {
    window.addEventListener("keydown", this.handler);
  }

  stop(): void {
    window.removeEventListener("keydown", this.handler);
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        this.speedKmh = Math.min(this.maxKmh, this.speedKmh + this.stepKmh);
        break;
      case "ArrowDown":
        e.preventDefault();
        this.speedKmh = Math.max(0, this.speedKmh - this.stepKmh);
        break;
      case " ":
        e.preventDefault();
        this.speedKmh = 0;
        break;
      case "r":
      case "R":
        this.speedKmh = 0;
        this.onReset?.();
        break;
    }
  }

  getSpeedMps(): number {
    return (this.speedKmh * 1000) / 3600;
  }

  getRpm(): number {
    return speedMpsToRpm(this.getSpeedMps());
  }
}
