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
  warning?: string;
};

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
  forwardReferrer: boolean
): Plugin {
  let cachedRoute: RouteApiResult | undefined;

  return {
    name: "local-routes-api",
    configureServer(server) {
      server.middlewares.use(
        "/api/routes/shin-osaka-nara",
        async (request: IncomingMessage, response: ServerResponse) => {
          if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
          }
          if (!apiKey) {
            sendJson(response, 500, {
              error: "GOOGLE_ROUTES_API_KEYが設定されていません",
            });
            return;
          }
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
                      latLng: {
                        latitude: 34.73348,
                        longitude: 135.5001,
                      },
                    },
                  },
                  destination: {
                    location: {
                      latLng: {
                        latitude: 34.68085,
                        longitude: 135.81895,
                      },
                    },
                  },
                  intermediates: [
                    {
                      location: {
                        latLng: {
                          latitude: 34.70038,
                          longitude: 135.54624,
                        },
                      },
                    },
                  ],
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

            cachedRoute = {
              encodedPolyline: route.polyline.encodedPolyline,
              distanceMeters: route.distanceMeters,
              travelMode,
              warning,
            };
            sendJson(response, 200, cachedRoute);
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
  const fallbackMapsApiKey = env.VITE_GOOGLE_MAPS_API_KEY;

  return {
    plugins: [
      react(),
      routesApiPlugin(
        routesApiKey || fallbackMapsApiKey,
        !routesApiKey && Boolean(fallbackMapsApiKey)
      ),
    ],
  };
});
