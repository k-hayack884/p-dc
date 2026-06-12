import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";
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
  travelMode: "BICYCLE" | "DRIVE" | "WALK";
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
  origin: RouteWaypoint;
  destination: RouteWaypoint;
  intermediates?: RouteWaypoint[];
  includeElevation?: boolean;
};

type RouteWaypoint =
  | string
  | {
      latitude: number;
      longitude: number;
    };

type CreateRouteRequest = {
  name?: string;
  origin?: string;
  destination?: string;
  intermediates?: string[];
  travelMode?: "AUTO" | RouteApiResult["travelMode"];
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function waypointBody(waypoint: RouteWaypoint): unknown {
  return typeof waypoint === "string"
    ? { address: waypoint }
    : { location: { latLng: waypoint } };
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
          const routeId = request.url?.replace(/^\/+/, "").split("?")[0] ?? "";
          const isCustomRequest =
            request.method === "POST" && routeId === "compute";

          if (request.method !== "GET" && !isCustomRequest) {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
          }

          let definition: RouteDefinition | undefined;
          let requestedTravelMode: CreateRouteRequest["travelMode"] = "AUTO";

          if (isCustomRequest) {
            try {
              const body = (await readJsonBody(request)) as CreateRouteRequest;
              const origin = body.origin?.trim();
              const destination = body.destination?.trim();
              const intermediates = body.intermediates
                ?.map((value) => value.trim())
                .filter(Boolean);

              if (!origin || !destination) {
                sendJson(response, 400, {
                  error: "出発地と目的地を入力してください",
                });
                return;
              }
              if ((intermediates?.length ?? 0) > 25) {
                sendJson(response, 400, {
                  error: "経由地は25件以内にしてください",
                });
                return;
              }
              if (
                body.travelMode &&
                !["AUTO", "BICYCLE", "DRIVE", "WALK"].includes(
                  body.travelMode
                )
              ) {
                sendJson(response, 400, { error: "移動モードが不正です" });
                return;
              }

              definition = {
                origin,
                destination,
                intermediates,
                includeElevation: body.includeElevation !== false,
              };
              requestedTravelMode = body.travelMode ?? "AUTO";
            } catch {
              sendJson(response, 400, { error: "リクエストJSONが不正です" });
              return;
            }
          } else {
            definition = ROUTE_DEFINITIONS[routeId];
          }

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
          const cachedRoute = isCustomRequest
            ? undefined
            : routeCache.get(routeId);
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
              travelMode: RouteApiResult["travelMode"]
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
                    origin: waypointBody(definition.origin),
                    destination: waypointBody(definition.destination),
                    intermediates:
                      definition.intermediates?.map(waypointBody),
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

            const primaryMode =
              requestedTravelMode === "AUTO"
                ? "BICYCLE"
                : requestedTravelMode;
            const primary = await computeRoute(primaryMode);
            if (!primary.response.ok) {
              sendJson(response, primary.response.status, {
                error:
                  primary.result.error?.message ??
                  "Routes APIのルート取得に失敗しました",
              });
              return;
            }

            let route = primary.result.routes?.[0];
            let travelMode: RouteApiResult["travelMode"] = primaryMode;
            let warning: string | undefined;

            if (
              requestedTravelMode === "AUTO" &&
              !route?.polyline?.encodedPolyline
            ) {
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
                error: "Routes APIからルートが返りませんでした",
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

            if (!isCustomRequest) {
              routeCache.set(routeId, routeResult);
            }
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
    test: {
      environment: "jsdom",
      restoreMocks: true,
    },
  };
});
