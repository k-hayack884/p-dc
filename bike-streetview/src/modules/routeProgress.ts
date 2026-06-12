const STORAGE_PREFIX = "bike-streetview:route-progress:";

export function loadRouteProgress(routeId: string): number {
  const storedValue = window.localStorage.getItem(`${STORAGE_PREFIX}${routeId}`);
  if (storedValue === null) return 0;

  const distance = Number(storedValue);
  return Number.isFinite(distance) && distance > 0 ? distance : 0;
}

export function saveRouteProgress(routeId: string, distance: number): void {
  if (!Number.isFinite(distance) || distance < 0) return;
  const currentDistance = loadRouteProgress(routeId);
  if (distance < currentDistance) return;

  window.localStorage.setItem(
    `${STORAGE_PREFIX}${routeId}`,
    String(Math.round(distance))
  );
}

export function clearRouteProgress(routeId: string): void {
  window.localStorage.removeItem(`${STORAGE_PREFIX}${routeId}`);
}
