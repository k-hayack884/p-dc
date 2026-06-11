import type { Route, RoutePoint } from "../types";

/** 角度の線形補間（360度ラップ対応） */
function lerpHeading(a: number, b: number, t: number): number {
  let diff = ((b - a + 540) % 360) - 180;
  return (a + diff * t + 360) % 360;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 累積距離 d [m] に対応するルート上の点を補間して返す。
 * d が終点を超えた場合は終点を返す。
 */
export function getPointAtDistance(route: Route, d: number): RoutePoint {
  const pts = route.points;
  const last = pts[pts.length - 1];
  if (d <= pts[0].distance) return pts[0];
  if (d >= last.distance) return last;

  // 二分探索: d を挟む区間 [lo, lo+1] を探す
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].distance <= d) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const span = b.distance - a.distance;
  const t = span > 0 ? (d - a.distance) / span : 0;

  return {
    lat: lerp(a.lat, b.lat, t),
    lng: lerp(a.lng, b.lng, t),
    distance: d,
    elevation: lerp(a.elevation, b.elevation, t),
    grade: a.grade, // 区間勾配は区間先頭の値を使う
    heading: lerpHeading(a.heading, b.heading, t),
  };
}
