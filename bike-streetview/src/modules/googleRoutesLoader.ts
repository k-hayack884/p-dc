import type { RouteCoordinate } from "./routeGeometry";
import { buildRouteFromCoordinates } from "./routeGeometry";
import type { Route } from "../types";

type RoutesApiResponse = {
  encodedPolyline?: string;
  distanceMeters?: number;
  travelMode?: GoogleTravelMode;
  coordinates?: RouteCoordinate[];
  warning?: string;
};

export type GoogleRouteId = "shin-osaka-nara" | "esaka-minoh-kayano";

export type GoogleTravelMode = "BICYCLE" | "DRIVE" | "WALK";

export type CreateGoogleRouteRequest = {
  name: string;
  origin: string;
  destination: string;
  intermediates: string[];
  travelMode: GoogleTravelMode | "AUTO";
  includeElevation: boolean;
};

export type GoogleRoutesResult = {
  route: Route;
  routeType: "自転車ルート" | "車ルート" | "徒歩ルート";
};

const routePromises = new Map<GoogleRouteId, Promise<GoogleRoutesResult>>();

const ROUTE_NAMES: Record<GoogleRouteId, string> = {
  "shin-osaka-nara": "新大阪駅 → 蒲生四丁目駅 → 奈良駅",
  "esaka-minoh-kayano": "江坂駅 → 箕面萱野駅",
};

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

function routeTypeFromTravelMode(
  travelMode: GoogleTravelMode
): GoogleRoutesResult["routeType"] {
  if (travelMode === "DRIVE") return "車ルート";
  if (travelMode === "WALK") return "徒歩ルート";
  return "自転車ルート";
}

async function parseGoogleRoutesResponse(
  response: Response,
  routeName: string
): Promise<GoogleRoutesResult> {
  const result = (await response.json()) as RoutesApiResponse & {
    error?: string;
  };

  if (!response.ok) {
    throw new Error(result.error ?? `Routes API取得失敗: ${response.status}`);
  }
  if (!result.encodedPolyline) {
    throw new Error("Routes APIからpolylineが返りませんでした");
  }

  const travelMode = result.travelMode ?? "BICYCLE";
  const coordinates =
    result.coordinates ?? decodeGooglePolyline(result.encodedPolyline);

  return {
    route: buildRouteFromCoordinates(routeName, coordinates),
    routeType: routeTypeFromTravelMode(travelMode),
  };
}

export function loadGoogleRoutesRoute(
  routeId: GoogleRouteId
): Promise<GoogleRoutesResult> {
  const cachedPromise = routePromises.get(routeId);
  if (cachedPromise) return cachedPromise;

  const request = fetch(`/api/routes/${routeId}`)
    .then((response) => parseGoogleRoutesResponse(response, ROUTE_NAMES[routeId]))
    .catch((error) => {
      routePromises.delete(routeId);
      throw error;
    });

  routePromises.set(routeId, request);
  return request;
}

export function createGoogleRoutesRoute(
  request: CreateGoogleRouteRequest
): Promise<GoogleRoutesResult> {
  return fetch("/api/routes/compute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  }).then((response) => parseGoogleRoutesResponse(response, request.name));
}
