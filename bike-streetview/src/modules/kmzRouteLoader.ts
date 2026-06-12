import JSZip from "jszip";
import type { RouteCoordinate } from "./routeGeometry";
import { buildRouteFromCoordinates } from "./routeGeometry";
import type { Route } from "../types";

const DEFAULT_INTERVAL_METERS = 50;

function parseCoordinates(text: string): RouteCoordinate[] {
  return text
    .trim()
    .split(/\s+/)
    .map((value) => {
      const values = value.split(",").map(Number);
      const [lng, lat] = values;
      const elevation = values[2] ?? 0;
      return { lat, lng, elevation };
    })
    .filter(
      ({ lat, lng, elevation }) =>
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        Number.isFinite(elevation)
    );
}

export function parseKmlRoute(
  kmlText: string,
  intervalMeters = DEFAULT_INTERVAL_METERS
): Route {
  const xml = new DOMParser().parseFromString(kmlText, "application/xml");
  const parserError = xml.querySelector("parsererror");
  if (parserError) {
    throw new Error("KMLのXML解析に失敗しました");
  }

  const lineStrings = Array.from(xml.getElementsByTagName("LineString"));
  const candidates = lineStrings
    .map((lineString) => {
      const coordinates = parseCoordinates(
        lineString.getElementsByTagName("coordinates")[0]?.textContent ?? ""
      );
      const placemark = lineString.closest("Placemark");
      const name =
        placemark?.getElementsByTagName("name")[0]?.textContent?.trim() ??
        "KMZ route";
      return { name, coordinates };
    })
    .filter(({ coordinates }) => coordinates.length >= 2)
    .sort((a, b) => b.coordinates.length - a.coordinates.length);

  const route = candidates[0];
  if (!route) {
    throw new Error("KMLに2点以上のLineStringがありません");
  }

  return buildRouteFromCoordinates(
    route.name,
    route.coordinates,
    intervalMeters
  );
}

export async function loadRouteFromKmzUrl(url: string): Promise<Route> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`KMZ取得失敗: ${response.status}`);
  }

  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const kmlFile = Object.values(zip.files).find(
    (file) => !file.dir && file.name.toLowerCase().endsWith(".kml")
  );
  if (!kmlFile) {
    throw new Error("KMZ内にKMLファイルがありません");
  }

  return parseKmlRoute(await kmlFile.async("text"));
}
