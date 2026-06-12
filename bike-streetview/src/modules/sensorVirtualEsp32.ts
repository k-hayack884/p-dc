import type { SensorAdapter } from "../types";
import { rpmToSpeedMps } from "./grade";

const MAX_RPM = 140;
const RPM_CHANGE_PER_SECOND = 24;

export class VirtualEsp32Sensor implements SensorAdapter {
  private currentRpm = 0;
  private targetRpm = 0;
  private connected = true;
  private running = false;
  private lastUpdate = performance.now();

  start(): void {
    this.running = true;
    this.lastUpdate = performance.now();
  }

  stop(): void {
    this.running = false;
    this.currentRpm = 0;
    this.targetRpm = 0;
  }

  setTargetRpm(rpm: number): void {
    this.updateRpm();
    this.targetRpm = Math.min(MAX_RPM, Math.max(0, rpm));
  }

  adjustTargetRpm(delta: number): void {
    this.setTargetRpm(this.targetRpm + delta);
  }

  setConnected(connected: boolean): void {
    this.updateRpm();
    this.connected = connected;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getTargetRpm(): number {
    return this.targetRpm;
  }

  getRpm(): number {
    this.updateRpm();
    return this.running && this.connected ? this.currentRpm : 0;
  }

  getSpeedMps(): number {
    return rpmToSpeedMps(this.getRpm());
  }

  private updateRpm(): void {
    const now = performance.now();
    const elapsedSeconds = Math.min((now - this.lastUpdate) / 1000, 0.5);
    this.lastUpdate = now;
    if (!this.running) return;

    const difference = this.targetRpm - this.currentRpm;
    const maxChange = RPM_CHANGE_PER_SECOND * elapsedSeconds;
    if (Math.abs(difference) <= maxChange) {
      this.currentRpm = this.targetRpm;
    } else {
      this.currentRpm += Math.sign(difference) * maxChange;
    }
  }
}
