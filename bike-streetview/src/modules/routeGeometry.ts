import type { Route, RoutePoint } from "../types";

export type RouteCoordinate = {
  lat: number;
  lng: number;
  elevation?: number;
};

const EARTH_RADIUS_METERS = 6_371_000;
const ELEVATION_SMOOTHING_RADIUS = 2;
const MAX_ABSOLUTE_GRADE = 12;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function elevationOf(coordinate: RouteCoordinate): number {
  return coordinate.elevation ?? 0;
}

function distanceBetween(a: RouteCoordinate, b: RouteCoordinate): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = lat2 - lat1;
  const deltaLng = toRadians(b.lng - a.lng);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

function headingBetween(a: RouteCoordinate, b: RouteCoordinate): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLng = toRadians(b.lng - a.lng);
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function interpolate(
  a: RouteCoordinate,
  b: RouteCoordinate,
  ratio: number
): Required<RouteCoordinate> {
  return {
    lat: a.lat + (b.lat - a.lat) * ratio,
    lng: a.lng + (b.lng - a.lng) * ratio,
    elevation:
      elevationOf(a) + (elevationOf(b) - elevationOf(a)) * ratio,
  };
}

function smoothElevations(points: RoutePoint[]): RoutePoint[] {
  return points.map((point, index) => {
    let weightedElevation = 0;
    let totalWeight = 0;

    for (
      let offset = -ELEVATION_SMOOTHING_RADIUS;
      offset <= ELEVATION_SMOOTHING_RADIUS;
      offset++
    ) {
      const candidate = points[index + offset];
      if (!candidate) continue;
      const weight = ELEVATION_SMOOTHING_RADIUS + 1 - Math.abs(offset);
      weightedElevation += candidate.elevation * weight;
      totalWeight += weight;
    }

    return {
      ...point,
      elevation: weightedElevation / totalWeight,
    };
  });
}

function applySmoothedGrades(points: RoutePoint[]): RoutePoint[] {
  return points.map((point, index) => {
    const start = points[Math.max(0, index - ELEVATION_SMOOTHING_RADIUS)];
    const end =
      points[
        Math.min(points.length - 1, index + ELEVATION_SMOOTHING_RADIUS)
      ];
    const distance = end.distance - start.distance;
    const rawGrade =
      distance > 0 ? ((end.elevation - start.elevation) / distance) * 100 : 0;

    return {
      ...point,
      grade: Math.max(
        -MAX_ABSOLUTE_GRADE,
        Math.min(MAX_ABSOLUTE_GRADE, rawGrade)
      ),
    };
  });
}

function sampleRoute(
  coordinates: RouteCoordinate[],
  intervalMeters: number
): RoutePoint[] {
  const cumulativeDistances = [0];
  for (let index = 1; index < coordinates.length; index++) {
    cumulativeDistances.push(
      cumulativeDistances[index - 1] +
        distanceBetween(coordinates[index - 1], coordinates[index])
    );
  }

  const totalDistance = cumulativeDistances[cumulativeDistances.length - 1];
  const targetDistances: number[] = [];
  for (let distance = 0; distance < totalDistance; distance += intervalMeters) {
    targetDistances.push(distance);
  }
  targetDistances.push(totalDistance);

  let segmentIndex = 0;
  const sampledPoints = targetDistances.map((distance) => {
    while (
      segmentIndex < coordinates.length - 2 &&
      cumulativeDistances[segmentIndex + 1] < distance
    ) {
      segmentIndex++;
    }

    const start = coordinates[segmentIndex];
    const end = coordinates[segmentIndex + 1];
    const segmentStart = cumulativeDistances[segmentIndex];
    const segmentLength =
      cumulativeDistances[segmentIndex + 1] - segmentStart;
    const ratio =
      segmentLength > 0 ? (distance - segmentStart) / segmentLength : 0;
    const point = interpolate(start, end, ratio);
    return {
      ...point,
      distance,
      grade: 0,
      heading: headingBetween(start, end),
    };
  });

  return applySmoothedGrades(smoothElevations(sampledPoints));
}

export function buildRouteFromCoordinates(
  name: string,
  coordinates: RouteCoordinate[],
  intervalMeters = 50
): Route {
  if (coordinates.length < 2) {
    throw new Error("ルート座標が2点未満です");
  }

  return {
    name,
    intervalMeters,
    points: sampleRoute(coordinates, intervalMeters),
  };
}
