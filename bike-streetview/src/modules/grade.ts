/** 走行ロジック（仕様書 6章） */

/**
 * RPM → 仮想速度 [m/s]
 * 60rpm ≒ 13km/h, 90rpm ≒ 20km/h 程度。実際の漕ぎ心地に合わせて係数を調整する。
 */
export const RPM_TO_KMH = 0.22;

export function rpmToSpeedMps(rpm: number): number {
  const kmh = rpm * RPM_TO_KMH;
  return (kmh * 1000) / 3600;
}

export function speedMpsToRpm(speedMps: number): number {
  const kmh = (speedMps * 3600) / 1000;
  return kmh / RPM_TO_KMH;
}

/**
 * 勾配による進行距離の補正係数。
 * 上り坂: 1%ごとに3%遅く（下限35%）。下り坂: 1%ごとに1.5%速く（上限135%）。
 */
export function gradeFactor(grade: number): number {
  if (grade > 0) {
    return Math.max(0.35, 1 - grade * 0.03);
  }
  if (grade < 0) {
    return Math.min(1.35, 1 + Math.abs(grade) * 0.015);
  }
  return 1;
}
