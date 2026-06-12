import type { RouteCoordinate } from "./routeGeometry";
import { buildRouteFromCoordinates } from "./routeGeometry";
import type { Route } from "../types";

type RoutesApiResponse = {
  encodedPolyline?: string;
  distanceMeters?: number;
  travelMode?: "BICYCLE" | "DRIVE";
  warning?: string;
};

const ROUTE_NAME = "新大阪駅 → 蒲生四丁目駅 → 奈良駅";

export type GoogleRoutesResult = {
  route: Route;
  routeType: "自転車ルート" | "車ルート";
};

let routePromise: Promise<GoogleRoutesResult> | null = null;

function decodeSignedValue(
  encoded: string,
  startIndex: number
): { value: number; nextIndex: number } {
  let result = 0;
  let shift = 0;
  let index = startIndex;

  while (index < encoded.length) {
    const value = encoded.charCodeAt(index++) - 63;
    result |= (value & 0x1f) << shift;
    shift += 5;
    if (value < 0x20) {
      return {
        value: result & 1 ? ~(result >> 1) : result >> 1,
        nextIndex: index,
      };
    }
  }

  throw new Error("Routes APIのpolylineが不正です");
}

export function decodeGooglePolyline(encoded: string): RouteCoordinate[] {
  const coordinates: RouteCoordinate[] = [];
  let latitude = 0;
  let longitude = 0;
  let index = 0;

  while (index < encoded.length) {
    const latResult = decodeSignedValue(encoded, index);
    latitude += latResult.value;
    index = latResult.nextIndex;

    const lngResult = decodeSignedValue(encoded, index);
    longitude += lngResult.value;
    index = lngResult.nextIndex;

    coordinates.push({
      lat: latitude / 1e5,
      lng: longitude / 1e5,
    });
  }

  return coordinates;
}

export function loadGoogleRoutesRoute(): Promise<GoogleRoutesResult> {
  if (routePromise) return routePromise;

  const request = fetch("/api/routes/shin-osaka-nara")
    .then<GoogleRoutesResult>(async (response) => {
      const result = (await response.json()) as RoutesApiResponse & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(
          result.error ?? `Routes API取得失敗: ${response.status}`
        );
      }
      if (!result.encodedPolyline) {
        throw new Error("Routes APIからpolylineが返りませんでした");
      }

      const travelMode = result.travelMode ?? "BICYCLE";
      return {
        route: buildRouteFromCoordinates(
          ROUTE_NAME,
          decodeGooglePolyline(result.encodedPolyline)
        ),
        routeType: travelMode === "DRIVE" ? "車ルート" : "自転車ルート",
      };
    })
    .catch((error) => {
      routePromise = null;
      throw error;
    });

  routePromise = request;
  return request;
}
