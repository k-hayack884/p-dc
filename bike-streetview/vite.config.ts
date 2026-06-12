import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

type ComputeRoutesResponse = {
  routes?: Array<{
    distanceMeters?: number;
    polyline?: {
      encodedPolyline?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

type RouteApiResult = {
  encodedPolyline: string;
  distanceMeters?: number;
  travelMode: "BICYCLE" | "DRIVE";
  coordinates?: Array<{
    lat: number;
    lng: number;
    elevation: number;
  }>;
  warning?: string;
};

type ElevationResponse = {
  results?: Array<{
    elevation: number;
    location: {
      lat: number;
      lng: number;
    };
  }>;
  status?: string;
  error_message?: string;
};

type RouteDefinition = {
  origin: {
    latitude: number;
    longitude: number;
  };
  destination: {
    latitude: number;
    longitude: number;
  };
  intermediates?: Array<{
    latitude: number;
    longitude: number;
  }>;
  includeElevation?: boolean;
};

const ROUTE_DEFINITIONS: Record<string, RouteDefinition> = {
  "shin-osaka-nara": {
    origin: { latitude: 34.73348, longitude: 135.5001 },
    destination: { latitude: 34.68085, longitude: 135.81895 },
    intermediates: [{ latitude: 34.70038, longitude: 135.54624 }],
  },
  "esaka-minoh-kayano": {
    origin: { latitude: 34.75875, longitude: 135.49713 },
    destination: { latitude: 34.83167, longitude: 135.48955 },
    includeElevation: true,
  },
};

function decodePolyline(
  encoded: string
): Array<{ latitude: number; longitude: number }> {
  const coordinates: Array<{ latitude: number; longitude: number }> = [];
  let latitude = 0;
  let longitude = 0;
  let index = 0;

  const decodeValue = (): number => {
    let result = 0;
    let shift = 0;

    while (index < encoded.length) {
      const value = encoded.charCodeAt(index++) - 63;
      result |= (value & 0x1f) << shift;
      shift += 5;
      if (value < 0x20) {
        return result & 1 ? ~(result >> 1) : result >> 1;
      }
    }

    throw new Error("Routes APIのpolylineが不正です");
  };

  while (index < encoded.length) {
    latitude += decodeValue();
    longitude += decodeValue();
    coordinates.push({
      latitude: latitude / 1e5,
      longitude: longitude / 1e5,
    });
  }

  return coordinates;
}

function reducePath(
  coordinates: Array<{ latitude: number; longitude: number }>,
  maxPoints: number
): Array<{ latitude: number; longitude: number }> {
  if (coordinates.length <= maxPoints) return coordinates;

  const reduced = [];
  const lastIndex = coordinates.length - 1;
  for (let index = 0; index < maxPoints; index++) {
    reduced.push(
      coordinates[Math.round((index / (maxPoints - 1)) * lastIndex)]
    );
  }
  return reduced;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function routesApiPlugin(
  apiKey: string | undefined,
  elevationApiKey: string | undefined,
  forwardReferrer: boolean
): Plugin {
  const routeCache = new Map<string, RouteApiResult>();

  return {
    name: "local-routes-api",
    configureServer(server) {
      server.middlewares.use(
        "/api/routes",
        async (request: IncomingMessage, response: ServerResponse) => {
          if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
          }
          const routeId = request.url?.replace(/^\/+/, "").split("?")[0] ?? "";
          const definition = ROUTE_DEFINITIONS[routeId];
          if (!definition) {
            sendJson(response, 404, { error: "Unknown route" });
            return;
          }
          if (!apiKey) {
            sendJson(response, 500, {
              error: "GOOGLE_ROUTES_API_KEYが設定されていません",
            });
            return;
          }
          if (definition.includeElevation && !elevationApiKey) {
            sendJson(response, 500, {
              error:
                "Elevation APIにはサーバー用キーが必要です。.env.localにGOOGLE_ELEVATION_API_KEYを設定してください",
            });
            return;
          }
          const cachedRoute = routeCache.get(routeId);
          if (cachedRoute) {
            sendJson(response, 200, cachedRoute);
            return;
          }

          try {
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": apiKey,
              "X-Goog-FieldMask":
                "routes.distanceMeters,routes.polyline.encodedPolyline",
            };
            if (forwardReferrer && request.headers.referer) {
              headers.Referer = request.headers.referer;
            }

            const computeRoute = async (
              travelMode: "BICYCLE" | "DRIVE"
            ): Promise<{
              response: Response;
              result: ComputeRoutesResponse;
            }> => {
              const routesResponse = await fetch(
                "https://routes.googleapis.com/directions/v2:computeRoutes",
                {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                  origin: {
                    location: {
                      latLng: definition.origin,
                    },
                  },
                  destination: {
                    location: {
                      latLng: definition.destination,
                    },
                  },
                  intermediates: definition.intermediates?.map((latLng) => ({
                    location: { latLng },
                  })),
                  travelMode,
                  computeAlternativeRoutes: false,
                  polylineQuality: "HIGH_QUALITY",
                  polylineEncoding: "ENCODED_POLYLINE",
                  languageCode: "ja",
                  units: "METRIC",
                }),
                }
              );
              return {
                response: routesResponse,
                result:
                  (await routesResponse.json()) as ComputeRoutesResponse,
              };
            };

            const bicycle = await computeRoute("BICYCLE");
            if (!bicycle.response.ok) {
              sendJson(response, bicycle.response.status, {
                error:
                  bicycle.result.error?.message ??
                  "Routes APIの自転車ルート取得に失敗しました",
              });
              return;
            }

            let route = bicycle.result.routes?.[0];
            let travelMode: RouteApiResult["travelMode"] = "BICYCLE";
            let warning: string | undefined;

            if (!route?.polyline?.encodedPolyline) {
              const drive = await computeRoute("DRIVE");
              if (!drive.response.ok) {
                sendJson(response, drive.response.status, {
                  error:
                    drive.result.error?.message ??
                    "Routes APIの車代替ルート取得に失敗しました",
                });
                return;
              }
              route = drive.result.routes?.[0];
              travelMode = "DRIVE";
              warning =
                "Google Routes APIで自転車経路が返らないため、車経路を代用しています。自転車が通行できない道路を含む可能性があります。";
            }

            if (!route?.polyline?.encodedPolyline) {
              sendJson(response, 502, {
                error:
                  "Routes APIから自転車経路も車代替経路も返りませんでした",
              });
              return;
            }

            const routeResult: RouteApiResult = {
              encodedPolyline: route.polyline.encodedPolyline,
              distanceMeters: route.distanceMeters,
              travelMode,
              warning,
            };

            if (definition.includeElevation) {
              const samples = Math.min(
                512,
                Math.max(2, Math.ceil((route.distanceMeters ?? 0) / 50) + 1)
              );
              const elevationUrl = new URL(
                "https://maps.googleapis.com/maps/api/elevation/json"
              );
              const elevationPath = reducePath(
                decodePolyline(route.polyline.encodedPolyline),
                100
              )
                .map(
                  ({ latitude, longitude }) =>
                    `${latitude.toFixed(6)},${longitude.toFixed(6)}`
                )
                .join("|");
              elevationUrl.searchParams.set(
                "path",
                elevationPath
              );
              elevationUrl.searchParams.set("samples", String(samples));
              elevationUrl.searchParams.set("key", elevationApiKey as string);

              const elevationResponse = await fetch(elevationUrl);
              const elevationResult =
                (await elevationResponse.json()) as ElevationResponse;

              if (
                !elevationResponse.ok ||
                elevationResult.status !== "OK" ||
                !elevationResult.results?.length
              ) {
                sendJson(response, elevationResponse.ok ? 502 : elevationResponse.status, {
                  error:
                    elevationResult.error_message ??
                    `Elevation API取得失敗: ${elevationResult.status ?? "unknown"}`,
                });
                return;
              }

              routeResult.coordinates = elevationResult.results.map(
                (result) => ({
                  lat: result.location.lat,
                  lng: result.location.lng,
                  elevation: result.elevation,
                })
              );
            }

            routeCache.set(routeId, routeResult);
            sendJson(response, 200, routeResult);
          } catch (error) {
            sendJson(response, 502, {
              error: `Routes API通信失敗: ${(error as Error).message}`,
            });
          }
        }
      );
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const routesApiKey = env.GOOGLE_ROUTES_API_KEY;
  const elevationApiKey =
    env.GOOGLE_ELEVATION_API_KEY || env.GOOGLE_ROUTES_API_KEY;
  const fallbackMapsApiKey = env.VITE_GOOGLE_MAPS_API_KEY;

  return {
    plugins: [
      react(),
      routesApiPlugin(
        routesApiKey || fallbackMapsApiKey,
        elevationApiKey,
        !routesApiKey && Boolean(fallbackMapsApiKey)
      ),
    ],
  };
});
