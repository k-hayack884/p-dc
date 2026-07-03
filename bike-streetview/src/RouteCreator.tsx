import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  CreateGoogleRouteRequest,
  GoogleTravelMode,
} from "./modules/googleRoutesLoader";
import { createGoogleRoutesRoute } from "./modules/googleRoutesLoader";
import {
  saveCustomRoute,
  type CustomRoute,
} from "./modules/customRoutes";
import { loadMapsApi } from "./modules/streetViewController";
import {
  formatCoordinateText,
  parseCoordinateText,
  parseRouteWaypointInput,
  parseRouteWaypointLines,
  type LatLngInput,
} from "./modules/routeWaypointInput";

type RouteCreatorProps = {
  onCancel: () => void;
  onCreated: (route: CustomRoute) => void;
};

type MapPickTarget = "origin" | "destination" | "intermediate";
type RouteCreatorFields = {
  origin: string;
  destination: string;
  intermediates: string;
};

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
const DEFAULT_MAP_CENTER = { lat: 34.6937, lng: 135.5023 };

export function RouteCreator({ onCancel, onCreated }: RouteCreatorProps) {
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [intermediates, setIntermediates] = useState("");
  const [travelMode, setTravelMode] =
    useState<GoogleTravelMode | "AUTO">("AUTO");
  const [includeElevation, setIncludeElevation] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapPickTarget, setMapPickTarget] =
    useState<MapPickTarget>("origin");
  const [mapUndoStack, setMapUndoStack] = useState<RouteCreatorFields[]>([]);
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const mapPickTargetRef = useRef<MapPickTarget>(mapPickTarget);
  const routeFieldsRef = useRef<RouteCreatorFields>({
    origin,
    destination,
    intermediates,
  });

  useEffect(() => {
    mapPickTargetRef.current = mapPickTarget;
  }, [mapPickTarget]);

  useEffect(() => {
    routeFieldsRef.current = {
      origin,
      destination,
      intermediates,
    };
  }, [destination, intermediates, origin]);

  useEffect(() => {
    if (!API_KEY || !mapElementRef.current) return;

    let mounted = true;

    loadMapsApi(API_KEY)
      .then(async (googleApi) => {
        const { Map } = (await googleApi.maps.importLibrary(
          "maps"
        )) as google.maps.MapsLibrary;

        if (!mounted || !mapElementRef.current) return;

        const map = new Map(mapElementRef.current, {
          center: DEFAULT_MAP_CENTER,
          zoom: 11,
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false,
        });

        map.addListener("click", (event: google.maps.MapMouseEvent) => {
          if (!event.latLng) return;

          const coordinate = event.latLng.toJSON();
          const coordinateText = formatCoordinateText({
            latitude: coordinate.lat,
            longitude: coordinate.lng,
          });

          setMapError(null);
          setMapUndoStack((current) => [
            ...current,
            routeFieldsRef.current,
          ]);

          if (mapPickTargetRef.current === "origin") {
            setOrigin(coordinateText);
            return;
          }

          if (mapPickTargetRef.current === "destination") {
            setDestination(coordinateText);
            return;
          }

          setIntermediates((current) =>
            current.trim()
              ? `${current.trim()}\n${coordinateText}`
              : coordinateText
          );
        });

        mapRef.current = map;
        setMapReady(true);
      })
      .catch((loadError) => {
        if (mounted) setMapError((loadError as Error).message);
      });

    return () => {
      mounted = false;
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !window.google?.maps?.Marker) return;

    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = [];

    const points: Array<{
      label: string;
      coordinate: LatLngInput;
    }> = [];

    const originCoordinate = safeParseCoordinate(origin);
    if (originCoordinate) {
      points.push({ label: "S", coordinate: originCoordinate });
    }

    parseIntermediateCoordinates(intermediates).forEach(
      (coordinate, index) => {
        points.push({ label: String(index + 1), coordinate });
      }
    );

    const destinationCoordinate = safeParseCoordinate(destination);
    if (destinationCoordinate) {
      points.push({ label: "G", coordinate: destinationCoordinate });
    }

    markersRef.current = points.map(
      ({ label, coordinate }) =>
        new google.maps.Marker({
          map: mapRef.current,
          label,
          position: {
            lat: coordinate.latitude,
            lng: coordinate.longitude,
          },
        })
    );

    if (points.length === 1) {
      mapRef.current.setCenter({
        lat: points[0].coordinate.latitude,
        lng: points[0].coordinate.longitude,
      });
      mapRef.current.setZoom(14);
      return;
    }

    if (points.length > 1) {
      const bounds = new google.maps.LatLngBounds();
      points.forEach(({ coordinate }) => {
        bounds.extend({
          lat: coordinate.latitude,
          lng: coordinate.longitude,
        });
      });
      mapRef.current.fitBounds(bounds);
    }
  }, [destination, intermediates, mapReady, origin]);

  const clearMapUndoStack = () => {
    setMapUndoStack([]);
  };

  const undoLastMapPick = () => {
    setMapUndoStack((current) => {
      const previousFields = current.at(-1);
      if (!previousFields) return current;

      setOrigin(previousFields.origin);
      setDestination(previousFields.destination);
      setIntermediates(previousFields.intermediates);
      return current.slice(0, -1);
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const parsedOrigin = parseRouteWaypointInput(origin);
      const parsedDestination = parseRouteWaypointInput(destination);
      const parsedIntermediates = parseRouteWaypointLines(intermediates);

      if (parsedIntermediates.length > 25) {
        throw new Error("経由地は25件以内にしてください");
      }

      const request: CreateGoogleRouteRequest = {
        name: name.trim() || `${origin.trim()} → ${destination.trim()}`,
        origin: parsedOrigin,
        destination: parsedDestination,
        intermediates: parsedIntermediates,
        travelMode,
        includeElevation,
      };

      const result = await createGoogleRoutesRoute(request);
      onCreated(saveCustomRoute(request, result));
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="route-selection">
      <form className="route-creator" onSubmit={submit}>
        <div>
          <p className="route-selection-kicker">ROUTE CREATOR</p>
          <h1>新しいルートを作成</h1>
        </div>

        <label>
          ルート名
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例: 大阪駅 → 京都駅"
          />
        </label>

        <div className="route-creator-columns">
          <label>
            出発地
            <input
              required
              value={origin}
              onChange={(event) => {
                setOrigin(event.target.value);
                clearMapUndoStack();
              }}
              placeholder="例: 大阪駅"
            />
          </label>
          <label>
            目的地
            <input
              required
              value={destination}
              onChange={(event) => {
                setDestination(event.target.value);
                clearMapUndoStack();
              }}
              placeholder="例: 京都駅"
            />
          </label>
        </div>

        <label>
          経由地
          <textarea
            value={intermediates}
            onChange={(event) => {
              setIntermediates(event.target.value);
              clearMapUndoStack();
            }}
            placeholder={"1行に1地点を入力\n例: 蒲生四丁目駅\n例: 蒲生四丁目駅 | 34.700380,135.546240"}
            rows={4}
          />
          <small>
            地名、「緯度,経度」、または「表示名 | 緯度,経度」で入力できます。入力順に通過します。
            最大25地点です。
          </small>
        </label>

        <section className="route-map-picker">
          <div className="route-map-picker-header">
            <div>
              <p className="route-map-picker-title">地図から選択</p>
              <small>
                ボタンで入力先を選んでから地図をクリックします。手入力と併用できます。
              </small>
            </div>
            <div className="route-map-picker-actions">
              <button
                type="button"
                className={mapPickTarget === "origin" ? "active" : ""}
                onClick={() => setMapPickTarget("origin")}
              >
                出発地
              </button>
              <button
                type="button"
                className={mapPickTarget === "destination" ? "active" : ""}
                onClick={() => setMapPickTarget("destination")}
              >
                目的地
              </button>
              <button
                type="button"
                className={mapPickTarget === "intermediate" ? "active" : ""}
                onClick={() => setMapPickTarget("intermediate")}
              >
                経由地追加
              </button>
              <button
                type="button"
                disabled={mapUndoStack.length === 0}
                onClick={undoLastMapPick}
              >
                アンドゥ
              </button>
            </div>
          </div>
          {API_KEY ? (
            <>
              <div ref={mapElementRef} className="route-map-picker-canvas" />
              {mapError && <p className="route-creator-error">{mapError}</p>}
            </>
          ) : (
            <p className="route-map-picker-empty">
              地図選択には <code>VITE_GOOGLE_MAPS_API_KEY</code>{" "}
              が必要です。緯度経度の手入力はこのまま使えます。
            </p>
          )}
        </section>

        <div className="route-creator-columns">
          <label>
            移動モード
            <select
              value={travelMode}
              onChange={(event) =>
                setTravelMode(
                  event.target.value as GoogleTravelMode | "AUTO"
                )
              }
            >
              <option value="AUTO">自転車優先・なければ無料道路優先の車</option>
              <option value="BICYCLE">自転車</option>
              <option value="DRIVE">車（無料道路優先）</option>
              <option value="WALK">徒歩</option>
            </select>
          </label>
          <label className="route-creator-checkbox">
            <input
              type="checkbox"
              checked={includeElevation}
              onChange={(event) => setIncludeElevation(event.target.checked)}
            />
            標高・勾配データを取得
          </label>
        </div>

        {error && <p className="route-creator-error">{error}</p>}

        <div className="route-creator-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" disabled={submitting}>
            {submitting ? "ルート作成中…" : "作成して走行"}
          </button>
        </div>
      </form>
    </div>
  );
}

function safeParseCoordinate(value: string): LatLngInput | null {
  try {
    return parseCoordinateText(value.trim());
  } catch {
    return null;
  }
}

function parseIntermediateCoordinates(value: string): LatLngInput[] {
  return value
    .split("\n")
    .map((line) => safeParseCoordinate(line.trim()))
    .filter((coordinate): coordinate is LatLngInput => Boolean(coordinate));
}
