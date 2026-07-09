export const STREET_VIEW_STANDARD_INTERVAL_METERS = 100;
export const STREET_VIEW_FINE_INTERVAL_METERS = 50;
export const STREET_VIEW_FINE_ROUTE_MAX_DISTANCE_METERS = 10_000;
export const STREET_VIEW_LOW_SPEED_THRESHOLD_KMH = 15;
export const ADDRESS_UPDATE_INTERVAL_METERS = 250;

export function streetViewIntervalMeters({
  routeDistanceMeters,
  speedKmh,
}: {
  routeDistanceMeters: number;
  speedKmh: number;
}): number {
  if (routeDistanceMeters >= STREET_VIEW_FINE_ROUTE_MAX_DISTANCE_METERS) {
    return STREET_VIEW_STANDARD_INTERVAL_METERS;
  }

  if (speedKmh <= STREET_VIEW_LOW_SPEED_THRESHOLD_KMH) {
    return STREET_VIEW_FINE_INTERVAL_METERS;
  }

  return STREET_VIEW_FINE_INTERVAL_METERS;
}
