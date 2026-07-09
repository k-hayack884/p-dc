import type { Route } from "../types";

const STREET_VIEW_TURN_HEADING_THRESHOLD_DEGREES = 45;

function normalizedHeading(heading: number): number {
  return ((heading % 360) + 360) % 360;
}

function headingDifferenceDegrees(a: number, b: number): number {
  const delta = Math.abs(normalizedHeading(a) - normalizedHeading(b));
  return Math.min(delta, 360 - delta);
}

export function hasCrossedSharpTurn(
  route: Route,
  previousDistanceM: number,
  currentDistanceM: number
): boolean {
  if (currentDistanceM <= previousDistanceM) return false;

  for (let index = 1; index < route.points.length; index += 1) {
    const previousPoint = route.points[index - 1];
    const currentPoint = route.points[index];

    if (
      currentPoint.distance <= previousDistanceM ||
      currentPoint.distance > currentDistanceM
    ) {
      continue;
    }

    if (
      headingDifferenceDegrees(previousPoint.heading, currentPoint.heading) >=
      STREET_VIEW_TURN_HEADING_THRESHOLD_DEGREES
    ) {
      return true;
    }
  }

  return false;
}
