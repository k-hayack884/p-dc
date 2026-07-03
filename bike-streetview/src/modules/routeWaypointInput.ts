import type { RouteWaypointInput } from "./googleRoutesLoader";

export type LatLngInput = {
  latitude: number;
  longitude: number;
};

const COORDINATE_INPUT_PATTERN =
  /^\s*(-?\d+(?:\.\d+)?)\s*(?:,|，|、|\s)\s*(-?\d+(?:\.\d+)?)\s*$/;
const LABELED_COORDINATE_INPUT_PATTERN =
  /^\s*(.+?)\s*(?:\||@)\s*(-?\d+(?:\.\d+)?\s*(?:,|，|、|\s)\s*-?\d+(?:\.\d+)?)\s*$/;

function isValidLatitude(latitude: number): boolean {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90;
}

function isValidLongitude(longitude: number): boolean {
  return Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function assertValidCoordinate(latitude: number, longitude: number): void {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    throw new Error("緯度経度は 緯度 -90〜90、経度 -180〜180 で入力してください");
  }
}

export function parseCoordinateText(value: string): LatLngInput | null {
  const match = value.match(COORDINATE_INPUT_PATTERN);
  if (!match) return null;

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  assertValidCoordinate(latitude, longitude);

  return { latitude, longitude };
}

export function formatCoordinateText({
  latitude,
  longitude,
}: LatLngInput): string {
  return `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

export function parseRouteWaypointInput(value: string): RouteWaypointInput {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new Error("地点を入力してください");
  }

  const labeledCoordinateMatch = trimmedValue.match(
    LABELED_COORDINATE_INPUT_PATTERN
  );
  if (labeledCoordinateMatch) {
    const coordinate = parseCoordinateText(labeledCoordinateMatch[2]);
    if (coordinate) {
      return {
        ...coordinate,
        label: labeledCoordinateMatch[1].trim(),
      };
    }
  }

  const coordinate = parseCoordinateText(trimmedValue);
  if (coordinate) {
    return {
      ...coordinate,
      label: formatCoordinateText(coordinate),
    };
  }

  return trimmedValue;
}

export function parseRouteWaypointLines(value: string): RouteWaypointInput[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseRouteWaypointInput);
}
