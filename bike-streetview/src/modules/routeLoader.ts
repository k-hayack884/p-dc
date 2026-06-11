import type { Route, RoutePoint } from "../types";

/** ルートJSONの最低限のバリデーションを行って読み込む */
export function parseRoute(raw: unknown): Route {
  const obj = raw as Partial<Route>;
  const points = (Array.isArray(obj?.points) ? obj.points : raw) as RoutePoint[];
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("ルートJSONに2点以上のpointsが必要です");
  }
  for (const p of points) {
    if (
      typeof p.lat !== "number" ||
      typeof p.lng !== "number" ||
      typeof p.distance !== "number"
    ) {
      throw new Error("RoutePointには lat / lng / distance が必要です");
    }
  }
  // distance昇順を保証
  const sorted = [...points].sort((a, b) => a.distance - b.distance);
  return {
    name: typeof obj?.name === "string" ? obj.name : "unnamed route",
    intervalMeters:
      typeof obj?.intervalMeters === "number" ? obj.intervalMeters : 50,
    points: sorted,
  };
}

export async function loadRouteFromUrl(url: string): Promise<Route> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ルート取得失敗: ${res.status} ${url}`);
  return parseRoute(await res.json());
}

export function totalDistance(route: Route): number {
  return route.points[route.points.length - 1].distance;
}
