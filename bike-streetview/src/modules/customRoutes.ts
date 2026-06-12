import type { Route } from "../types";
import type {
  CreateGoogleRouteRequest,
  GoogleRoutesResult,
} from "./googleRoutesLoader";

const STORAGE_KEY = "bike-streetview:custom-routes";

export type CustomRoute = {
  id: string;
  createdAt: string;
  request: CreateGoogleRouteRequest;
  route: Route;
  routeType: GoogleRoutesResult["routeType"];
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

export function loadCustomRoutes(): CustomRoute[] {
  const storedValue = window.localStorage.getItem(STORAGE_KEY);
  if (!storedValue) return [];

  try {
    const routes = JSON.parse(storedValue) as unknown;
    return Array.isArray(routes) ? routes.filter(isCustomRoute) : [];
  } catch {
    return [];
  }
}

export function saveCustomRoute(
  request: CreateGoogleRouteRequest,
  result: GoogleRoutesResult
): CustomRoute {
  const customRoute: CustomRoute = {
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    request,
    route: result.route,
    routeType: result.routeType,
  };
  const routes = [customRoute, ...loadCustomRoutes()];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(routes));
  return customRoute;
}

export function deleteCustomRoute(routeId: string): void {
  const routes = loadCustomRoutes().filter((route) => route.id !== routeId);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(routes));
}
