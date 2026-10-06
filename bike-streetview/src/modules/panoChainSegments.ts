import type { Route } from "../types";

/**
 * 地点（出発地・経由地・目的地）の間ごとに「パノラマ列を使うか」を選べるようにするための計算。
 * 長距離ルートでは、都心など局所的な区間だけパノラマ列を作り、
 * それ以外は従来の走行中探索で走る。
 */

/** パノラマ列を使う距離範囲 [m] */
export type PanoChainRange = {
  startM: number;
  endM: number;
};

/**
 * 地点を順にルート上へ投影し、各地点の累積距離を返す。
 * 往復などで同じ場所を2回通るルートでも順序が崩れないよう、直前の地点より先だけを探す。
 * 座標のない地点（地名入力）は null。
 */
export function locatePointsOnRoute(
  route: Route,
  points: Array<google.maps.LatLngLiteral | null>
): Array<number | null> {
  const total = route.points[route.points.length - 1]?.distance ?? 0;
  let searchFrom = 0;

  return points.map((point, index) => {
    if (index === 0) return 0;
    if (index === points.length - 1) return total;
    if (!point) return null;

    const latScale = Math.cos((point.lat * Math.PI) / 180);
    let best = { distanceM: searchFrom, offsetSq: Number.POSITIVE_INFINITY };
    for (let i = 1; i < route.points.length; i += 1) {
      const a = route.points[i - 1];
      const b = route.points[i];
      if (b.distance < searchFrom) continue;
      const ax = (a.lng - point.lng) * latScale;
      const ay = a.lat - point.lat;
      const bx = (b.lng - point.lng) * latScale;
      const by = b.lat - point.lat;
      const abx = bx - ax;
      const aby = by - ay;
      const lengthSq = abx * abx + aby * aby;
      const t =
        lengthSq > 0 ? Math.min(Math.max(-(ax * abx + ay * aby) / lengthSq, 0), 1) : 0;
      const px = ax + abx * t;
      const py = ay + aby * t;
      const offsetSq = px * px + py * py;
      if (offsetSq < best.offsetSq) {
        best = {
          distanceM: Math.max(a.distance + (b.distance - a.distance) * t, searchFrom),
          offsetSq,
        };
      }
    }
    searchFrom = best.distanceM;
    return best.distanceM;
  });
}

/**
 * 区間ごとの選択（地点 i → i+1 を使うか）から、パノラマ列を作る距離範囲を作る。
 * 隣り合う選択区間はつなげる。すべて選択なら undefined（ルート全体）を返す。
 * 位置の分からない地点がある場合は、その前後の区間の選択をつなげて扱う。
 */
export function rangesFromSegments(
  pointDistances: Array<number | null>,
  enabled: boolean[]
): PanoChainRange[] | undefined {
  if (enabled.length === 0 || enabled.every(Boolean)) return undefined;

  const ranges: PanoChainRange[] = [];
  let lastKnown = 0;
  for (let i = 0; i < enabled.length; i += 1) {
    const start = pointDistances[i] ?? lastKnown;
    const end = pointDistances[i + 1] ?? start;
    lastKnown = end;
    if (!enabled[i] || end <= start) continue;

    const previous = ranges[ranges.length - 1];
    if (previous && Math.abs(previous.endM - start) < 1) {
      previous.endM = end;
    } else {
      ranges.push({ startM: start, endM: end });
    }
  }
  return ranges;
}

/** 範囲の合計距離 [m] */
export function totalRangeDistance(ranges: PanoChainRange[]): number {
  return ranges.reduce((sum, range) => sum + (range.endM - range.startM), 0);
}

/** 重なる・接する範囲をつなげ、開始順に並べる */
export function mergeRanges(ranges: PanoChainRange[]): PanoChainRange[] {
  const sorted = ranges
    .filter((range) => range.endM > range.startM)
    .map((range) => ({ ...range }))
    .sort((a, b) => a.startM - b.startM);
  const merged: PanoChainRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startM <= last.endM + 1) {
      last.endM = Math.max(last.endM, range.endM);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** ルートごとの「パノラマ列を使う区間」の設定 */
export type PanoChainSettings = {
  /** 地点の間ごと（出発地→経由地1, …, →目的地）に使うか */
  segments: boolean[];
  /** 距離で指定した追加の範囲 */
  extraRanges: PanoChainRange[];
};

/**
 * 区間の設定から、パノラマ列を作る距離範囲を作る。
 * 地点の間がすべてオンならルート全体（undefined）。
 */
export function rangesFromSettings(
  pointDistances: Array<number | null>,
  settings: PanoChainSettings
): PanoChainRange[] | undefined {
  const segmentRanges = rangesFromSegments(pointDistances, settings.segments);
  if (segmentRanges === undefined) return undefined;
  return mergeRanges([...segmentRanges, ...settings.extraRanges]);
}

/** 地点をルート上へ投影した累積距離 [m]（ルート全体から最も近い位置） */
export function distanceAlongRoute(
  route: Route,
  point: google.maps.LatLngLiteral
): number {
  const total = route.points[route.points.length - 1]?.distance ?? 0;
  return locatePointsOnRoute(route, [null, point, null]).map((distance, index) =>
    index === 1 ? distance : null
  )[1] ?? total;
}
