import type { Route } from "../types";
import type {
  CreateGoogleRouteRequest,
  GoogleRoutesResult,
} from "./googleRoutesLoader";

const API_PATH = "/api/custom-routes";
/** ファイル永続化に移行する前、ポートごとに分離されていた保存先 */
const LEGACY_STORAGE_KEY = "bike-streetview:custom-routes";

export type CustomRoute = {
  id: string;
  createdAt: string;
  request: CreateGoogleRouteRequest;
  route: Route;
  routeType: GoogleRoutesResult["routeType"];
  /**
   * 地点の間ごと（出発地→経由地1, 経由地1→経由地2, …, →目的地）に
   * パノラマ列を使うか。省略時はすべての区間で使う
   */
  panoSegments?: boolean[];
};

function isCustomRoute(value: unknown): value is CustomRoute {
  if (!value || typeof value !== "object") return false;
  const route = value as Partial<CustomRoute>;
  return (
    typeof route.id === "string" &&
    typeof route.createdAt === "string" &&
    typeof route.routeType === "string" &&
    Boolean(route.request) &&
    Boolean(route.route) &&
    Array.isArray(route.route?.points)
  );
}

async function fetchCustomRoutes(): Promise<CustomRoute[]> {
  const response = await fetch(API_PATH);
  if (!response.ok) return [];

  try {
    const routes = (await response.json()) as unknown;
    return Array.isArray(routes) ? routes.filter(isCustomRoute) : [];
  } catch {
    return [];
  }
}

async function persistCustomRoutes(routes: CustomRoute[]): Promise<void> {
  await fetch(API_PATH, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(routes),
  });
}

function loadLegacyLocalStorageRoutes(): CustomRoute[] {
  const storedValue = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!storedValue) return [];

  try {
    const routes = JSON.parse(storedValue) as unknown;
    return Array.isArray(routes) ? routes.filter(isCustomRoute) : [];
  } catch {
    return [];
  }
}

/**
 * 開発サーバー（.data/custom-routes.json）に永続化されたルート作成データを
 * 取得する。localStorageと違いオリジン（ポート）に依存しないため、
 * 起動ポートが変わっても同じデータを参照できる。
 *
 * サーバー側が空の場合、そのオリジンのlocalStorageに旧方式（ポートごとに
 * 分離）で保存されたルートが残っていないか確認し、あれば一度だけサーバー
 * 側へ移行する。移行後はlocalStorageの旧データを削除する。
 */
export async function loadCustomRoutes(): Promise<CustomRoute[]> {
  const serverRoutes = await fetchCustomRoutes();
  if (serverRoutes.length > 0) return serverRoutes;

  const legacyRoutes = loadLegacyLocalStorageRoutes();
  if (legacyRoutes.length === 0) return serverRoutes;

  await persistCustomRoutes(legacyRoutes);
  window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  return legacyRoutes;
}

export async function saveCustomRoute(
  request: CreateGoogleRouteRequest,
  result: GoogleRoutesResult,
  panoSegments?: boolean[]
): Promise<CustomRoute> {
  const customRoute: CustomRoute = {
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    request,
    route: result.route,
    routeType: result.routeType,
    ...(panoSegments ? { panoSegments } : {}),
  };
  const routes = [customRoute, ...(await fetchCustomRoutes())];
  await persistCustomRoutes(routes);
  return customRoute;
}

export async function deleteCustomRoute(routeId: string): Promise<void> {
  const routes = (await fetchCustomRoutes()).filter(
    (route) => route.id !== routeId
  );
  await persistCustomRoutes(routes);
}
