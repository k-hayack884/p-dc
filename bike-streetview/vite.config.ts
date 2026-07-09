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
    legs?: Array<{
      steps?: Array<{
        polyline?: {
          encodedPolyline?: string;
        };
      }>;
    }>;
  }>;
  error?: {
    message?: string;
  };
};

type RouteApiResult = {
  encodedPolyline: string;
  distanceMeters?: number;
  travelMode: "BICYCLE" | "DRIVE" | "WALK";
  routeType?: "自転車ルート" | "車ルート" | "徒歩ルート" | "幹線道路優先ルート";
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
  origin?: unknown;
  destination?: unknown;
  intermediates?: unknown;
  travelMode?: "AUTO" | "MAIN_ROAD" | RouteApiResult["travelMode"];
  includeElevation?: boolean;
};

class BadRouteRequestError extends Error {}

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

function sameCoordinate(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): boolean {
  return a.latitude === b.latitude && a.longitude === b.longitude;
}

function routeCoordinatesFromSteps(
  route: NonNullable<ComputeRoutesResponse["routes"]>[number]
): Array<{ latitude: number; longitude: number }> {
  const stepPolylines =
    route.legs?.flatMap((leg) =>
      leg.steps?.flatMap((step) =>
        step.polyline?.encodedPolyline ? [step.polyline.encodedPolyline] : []
      ) ?? []
    ) ?? [];

  const coordinates: Array<{ latitude: number; longitude: number }> = [];
  for (const encodedPolyline of stepPolylines) {
    const stepCoordinates = decodePolyline(encodedPolyline);
    for (const coordinate of stepCoordinates) {
      const previous = coordinates[coordinates.length - 1];
      if (!previous || !sameCoordinate(previous, coordinate)) {
        coordinates.push(coordinate);
      }
    }
  }

  if (coordinates.length >= 2) return coordinates;
  return route.polyline?.encodedPolyline
    ? decodePolyline(route.polyline.encodedPolyline)
    : [];
}

function routeHasGeometry(
  route: NonNullable<ComputeRoutesResponse["routes"]>[number] | undefined
): boolean {
  if (!route) return false;
  if (route.polyline?.encodedPolyline) return true;
  return routeCoordinatesFromSteps(route).length >= 2;
}

const TURN_SCORE_MIN_SEGMENT_METERS = 15;
const TURN_SCORE_SHARP_TURN_DEGREES = 45;
const METERS_PER_DEGREE_LATITUDE = 111_320;

function coordinateDistanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const latScale = Math.cos((a.latitude * Math.PI) / 180);
  const dx = (b.longitude - a.longitude) * METERS_PER_DEGREE_LATITUDE * latScale;
  const dy = (b.latitude - a.latitude) * METERS_PER_DEGREE_LATITUDE;
  return Math.hypot(dx, dy);
}

function coordinateHeadingDegrees(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const latScale = Math.cos((a.latitude * Math.PI) / 180);
  const dx = (b.longitude - a.longitude) * METERS_PER_DEGREE_LATITUDE * latScale;
  const dy = (b.latitude - a.latitude) * METERS_PER_DEGREE_LATITUDE;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

function headingDeltaDegrees(a: number, b: number): number {
  const delta = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(delta, 360 - delta);
}

/**
 * ルートの「急な曲がり（45度以上）の数 / km」を返す。
 * 値が小さいほど幹線道路的な（曲がりの少ない）ルート。
 */
function sharpTurnsPerKm(
  route: NonNullable<ComputeRoutesResponse["routes"]>[number]
): number {
  const coordinates = routeCoordinatesFromSteps(route);
  if (coordinates.length < 3) return Number.POSITIVE_INFINITY;

  let sharpTurns = 0;
  let previousHeading: number | null = null;
  let anchor = coordinates[0];

  for (let index = 1; index < coordinates.length; index += 1) {
    const point = coordinates[index];
    // 短すぎる区間はノイズになるためまとめて評価する
    if (
      coordinateDistanceMeters(anchor, point) < TURN_SCORE_MIN_SEGMENT_METERS &&
      index < coordinates.length - 1
    ) {
      continue;
    }
    const heading = coordinateHeadingDegrees(anchor, point);
    if (
      previousHeading !== null &&
      headingDeltaDegrees(heading, previousHeading) >=
        TURN_SCORE_SHARP_TURN_DEGREES
    ) {
      sharpTurns += 1;
    }
    previousHeading = heading;
    anchor = point;
  }

  const km = Math.max((route.distanceMeters ?? 0) / 1000, 0.1);
  return sharpTurns / km;
}

/**
 * 完全な道路ジオメトリへ標高値を距離比で補間して割り当てる。
 * elevations はルート全長に沿ってほぼ等間隔のサンプル値である前提。
 */
function attachElevationsToCoordinates(
  coordinates: Array<{ latitude: number; longitude: number }>,
  elevations: number[]
): Array<{ lat: number; lng: number; elevation: number }> {
  if (elevations.length === 0) {
    return coordinates.map(({ latitude, longitude }) => ({
      lat: latitude,
      lng: longitude,
      elevation: 0,
    }));
  }

  const cumulative: number[] = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] +
        coordinateDistanceMeters(coordinates[index - 1], coordinates[index])
    );
  }
  const total = cumulative[cumulative.length - 1] || 1;

  return coordinates.map(({ latitude, longitude }, index) => {
    const fraction = (cumulative[index] / total) * (elevations.length - 1);
    const lower = Math.floor(fraction);
    const upper = Math.min(lower + 1, elevations.length - 1);
    const t = fraction - lower;
    return {
      lat: latitude,
      lng: longitude,
      elevation: elevations[lower] * (1 - t) + elevations[upper] * t,
    };
  });
}

/** 代替ルート群から曲がりが最少のものを選ぶ（同点なら距離が短い方） */
function selectFewestTurnRoute(
  routes: Array<NonNullable<ComputeRoutesResponse["routes"]>[number]>
): NonNullable<ComputeRoutesResponse["routes"]>[number] {
  return routes.reduce((best, candidate) => {
    const bestScore = sharpTurnsPerKm(best);
    const candidateScore = sharpTurnsPerKm(candidate);
    if (candidateScore < bestScore) return candidate;
    if (
      candidateScore === bestScore &&
      (candidate.distanceMeters ?? Infinity) < (best.distanceMeters ?? Infinity)
    ) {
      return candidate;
    }
    return best;
  });
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
  if (typeof waypoint === "string") {
    return { address: waypoint };
  }

  return {
    location: {
      latLng: {
        latitude: waypoint.latitude,
        longitude: waypoint.longitude,
      },
    },
  };
}

function parseRouteWaypoint(
  value: unknown,
  fieldName: string
): RouteWaypoint {
  if (typeof value === "string") {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      throw new BadRouteRequestError(`${fieldName}を入力してください`);
    }
    return trimmedValue;
  }

  if (value && typeof value === "object") {
    const waypoint = value as Partial<{
      latitude: unknown;
      longitude: unknown;
    }>;
    if (
      typeof waypoint.latitude === "number" &&
      typeof waypoint.longitude === "number" &&
      Number.isFinite(waypoint.latitude) &&
      Number.isFinite(waypoint.longitude) &&
      waypoint.latitude >= -90 &&
      waypoint.latitude <= 90 &&
      waypoint.longitude >= -180 &&
      waypoint.longitude <= 180
    ) {
      return {
        latitude: waypoint.latitude,
        longitude: waypoint.longitude,
      };
    }
  }

  throw new BadRouteRequestError(
    `${fieldName}は地名文字列または緯度経度で入力してください`
  );
}

function parseRouteWaypointList(value: unknown): RouteWaypoint[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new BadRouteRequestError("経由地は配列で入力してください");
  }

  return value.map((waypoint, index) =>
    parseRouteWaypoint(waypoint, `経由地${index + 1}`)
  );
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
              const origin = parseRouteWaypoint(body.origin, "出発地");
              const destination = parseRouteWaypoint(body.destination, "目的地");
              const intermediates = parseRouteWaypointList(
                body.intermediates
              );

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
                !["AUTO", "MAIN_ROAD", "BICYCLE", "DRIVE", "WALK"].includes(
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
            } catch (error) {
              sendJson(response, 400, {
                error:
                  error instanceof BadRouteRequestError
                    ? error.message
                    : "リクエストJSONが不正です",
              });
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
                "routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.polyline.encodedPolyline",
            };
            if (forwardReferrer && request.headers.referer) {
              headers.Referer = request.headers.referer;
            }

            const computeRoute = async (
              travelMode: RouteApiResult["travelMode"],
              options: {
                preferFreeRoads?: boolean;
                preferMainRoads?: boolean;
                alternatives?: boolean;
              } = {}
            ): Promise<{
              response: Response;
              result: ComputeRoutesResponse;
            }> => {
              const requestBody: Record<string, unknown> = {
                origin: waypointBody(definition.origin),
                destination: waypointBody(definition.destination),
                intermediates: definition.intermediates?.map(waypointBody),
                travelMode,
                computeAlternativeRoutes: options.alternatives ?? false,
                polylineQuality: "HIGH_QUALITY",
                polylineEncoding: "ENCODED_POLYLINE",
                languageCode: "ja",
                units: "METRIC",
              };

              if (travelMode === "DRIVE" && options.preferMainRoads) {
                // TRAFFIC_AWAREは指定しない: 作成時点の渋滞を避ける
                // 抜け道（細い生活道路）がルートに焼き付くため。
                // avoidHighwaysはソフト回避: 高速でしか行けない区間
                // （淡路島への橋など）では代替がないため高速を使う
                requestBody.routeModifiers = {
                  avoidTolls: true,
                  avoidHighways: true,
                };
              } else if (travelMode === "DRIVE" && options.preferFreeRoads) {
                requestBody.routeModifiers = {
                  avoidTolls: true,
                  avoidHighways: true,
                };
              }

              const routesResponse = await fetch(
                "https://routes.googleapis.com/directions/v2:computeRoutes",
                {
                  method: "POST",
                  headers,
                  body: JSON.stringify(requestBody),
                }
              );
              return {
                response: routesResponse,
                result:
                  (await routesResponse.json()) as ComputeRoutesResponse,
              };
            };

            const computeMainRoadRoute = async (): Promise<{
              response: Response;
              result: ComputeRoutesResponse;
              usedMainRoadPreference: boolean;
              usedFreeRoadsPreference: boolean;
            }> => {
              // 経由地なしの場合のみ代替ルートを取得できる（Routes API仕様）
              const canUseAlternatives =
                (definition.intermediates?.length ?? 0) === 0;
              const mainRoads = await computeRoute("DRIVE", {
                preferMainRoads: true,
                alternatives: canUseAlternatives,
              });
              const mainRoadCandidates =
                mainRoads.result.routes?.filter((candidate) =>
                  routeHasGeometry(candidate)
                ) ?? [];
              if (mainRoadCandidates.length > 0) {
                // 45度以上の曲がりが最少のルート＝幹線道路的なルートを選ぶ
                mainRoads.result.routes = [
                  selectFewestTurnRoute(mainRoadCandidates),
                ];
                return {
                  ...mainRoads,
                  usedMainRoadPreference: true,
                  // 幹線道路優先は高速・有料回避込みで取得成功している
                  usedFreeRoadsPreference: true,
                };
              }

              const fallback = await computeDriveRoute();
              return {
                response: fallback.response,
                result: fallback.result,
                usedMainRoadPreference: false,
                usedFreeRoadsPreference: fallback.usedFreeRoadsPreference,
              };
            };

            const computeDriveRoute = async (): Promise<{
              response: Response;
              result: ComputeRoutesResponse;
              usedFreeRoadsPreference: boolean;
            }> => {
              const freeRoads = await computeRoute("DRIVE", {
                preferFreeRoads: true,
              });
              if (routeHasGeometry(freeRoads.result.routes?.[0])) {
                return {
                  ...freeRoads,
                  usedFreeRoadsPreference: true,
                };
              }

              const fallback = await computeRoute("DRIVE");
              return {
                ...fallback,
                usedFreeRoadsPreference: false,
              };
            };

            const primaryMode =
              requestedTravelMode === "AUTO"
                ? "BICYCLE"
                : requestedTravelMode === "MAIN_ROAD"
                  ? "DRIVE"
                : requestedTravelMode;
            const primary =
              requestedTravelMode === "MAIN_ROAD"
                ? await computeMainRoadRoute()
                : primaryMode === "DRIVE"
                ? await computeDriveRoute()
                : await computeRoute(primaryMode);
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
            let routeType: RouteApiResult["routeType"] | undefined;
            let usedFreeRoadsPreference =
              "usedFreeRoadsPreference" in primary
                ? primary.usedFreeRoadsPreference
                : false;

            if (requestedTravelMode === "MAIN_ROAD") {
              routeType = "幹線道路優先ルート";
              if (
                "usedMainRoadPreference" in primary &&
                !primary.usedMainRoadPreference
              ) {
                warning = usedFreeRoadsPreference
                  ? "幹線道路優先では取得できなかったため、無料道路優先の車ルートを代用しています。細い道路を含む可能性があります。"
                  : "幹線道路優先・無料道路優先では取得できなかったため、通常の車ルートを代用しています。細い道路・高速道路・有料道路を含む可能性があります。";
              }
            }

            if (
              requestedTravelMode === "AUTO" &&
              !routeHasGeometry(route)
            ) {
              const drive = await computeDriveRoute();
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
              usedFreeRoadsPreference = drive.usedFreeRoadsPreference;
              warning =
                usedFreeRoadsPreference
                  ? "Google Routes APIで自転車経路が返らないため、無料道路優先の車経路を代用しています。自転車が通行できない道路を含む可能性があります。"
                  : "Google Routes APIで自転車経路が返らないため、車経路を代用しています。無料道路優先では取得できなかったため、高速道路や有料道路を含む可能性があります。";
            } else if (
              requestedTravelMode !== "MAIN_ROAD" &&
              travelMode === "DRIVE" &&
              !usedFreeRoadsPreference
            ) {
              // MAIN_ROADの警告は上のブロックで扱う（成功時に誤警告を出さない）
              warning =
                "無料道路優先では車ルートを取得できなかったため、高速道路や有料道路を含む可能性があります。";
            }

            if (!route || !routeHasGeometry(route)) {
              sendJson(response, 502, {
                error: "Routes APIからルートが返りませんでした",
              });
              return;
            }

            const routeCoordinates = routeCoordinatesFromSteps(route);
            const encodedPolyline = route.polyline?.encodedPolyline ?? "";

            const routeResult: RouteApiResult = {
              encodedPolyline,
              distanceMeters: route.distanceMeters,
              travelMode,
              routeType,
              coordinates: routeCoordinates.map(({ latitude, longitude }) => ({
                lat: latitude,
                lng: longitude,
                elevation: 0,
              })),
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
                routeCoordinates,
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

              // 重要: 座標をElevation APIのサンプル位置で置き換えない。
              // サンプル位置は100点に間引いた線に沿うため、角がショート
              // カットされ実際の道路から外れる（プレビューと走行ルートが
              // ずれる原因になっていた）。道路ジオメトリは完全なまま維持し、
              // 標高値だけを距離比で補間して各座標へ割り当てる。
              routeResult.coordinates = attachElevationsToCoordinates(
                routeCoordinates,
                elevationResult.results.map((result) => result.elevation)
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
