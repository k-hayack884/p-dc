import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CreateGoogleRouteRequest } from "./modules/googleRoutesLoader";
import { createGoogleRoutesRoute } from "./modules/googleRoutesLoader";
import {
  saveCustomRoute,
  type CustomRoute,
} from "./modules/customRoutes";
import { loadMapsApi } from "./modules/streetViewController";
import {
  formatCoordinateText,
  parseRouteWaypointInput,
  type LatLngInput,
} from "./modules/routeWaypointInput";

type RouteCreatorProps = {
  onCancel: () => void;
  onCreated: (route: CustomRoute) => void;
};

type MapPickTarget = "origin" | "destination" | "intermediate";

type WaypointRow = {
  id: string;
  text: string;
  /** 走行中ミニマップへ赤丸表示するか。ルート計算には常に使われる */
  showOnMap: boolean;
};

type RouteCreatorFields = {
  origin: string;
  destination: string;
  waypointRows: WaypointRow[];
};

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
const DEFAULT_MAP_CENTER = { lat: 34.6937, lng: 135.5023 };

function newWaypointRowId(): string {
  return `wp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function RouteCreator({ onCancel, onCreated }: RouteCreatorProps) {
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [waypointRows, setWaypointRows] = useState<WaypointRow[]>([]);
  const [travelMode, setTravelMode] =
    useState<CreateGoogleRouteRequest["travelMode"]>("MAIN_ROAD");
  const [includeElevation, setIncludeElevation] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewSummary, setPreviewSummary] = useState<string | null>(null);
  const [previewWarning, setPreviewWarning] = useState<string | null>(null);
  const [autoPreviewTick, setAutoPreviewTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapPickTarget, setMapPickTarget] =
    useState<MapPickTarget>("origin");
  const [mapUndoStack, setMapUndoStack] = useState<RouteCreatorFields[]>([]);
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const previewPolylineRef = useRef<google.maps.Polyline | null>(null);
  const previewActiveRef = useRef(false);
  const mapPickTargetRef = useRef<MapPickTarget>(mapPickTarget);
  const routeFieldsRef = useRef<RouteCreatorFields>({
    origin,
    destination,
    waypointRows,
  });

  useEffect(() => {
    mapPickTargetRef.current = mapPickTarget;
  }, [mapPickTarget]);

  useEffect(() => {
    routeFieldsRef.current = {
      origin,
      destination,
      waypointRows,
    };
  }, [destination, origin, waypointRows]);

  useEffect(() => {
    previewActiveRef.current = previewSummary !== null;
  }, [previewSummary]);

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

          setWaypointRows((current) => [
            ...current,
            {
              id: newWaypointRowId(),
              text: coordinateText,
              showOnMap: true,
            },
          ]);
          // プレビュー表示中にピンを置いたら自動で経路を引き直す
          if (previewActiveRef.current) {
            setAutoPreviewTick((tick) => tick + 1);
          }
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
      previewPolylineRef.current?.setMap(null);
      previewPolylineRef.current = null;
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

    const originCoordinate = safeParseWaypointCoordinate(origin);
    if (originCoordinate) {
      points.push({ label: "S", coordinate: originCoordinate });
    }

    waypointRows.forEach((row, index) => {
      const coordinate = safeParseWaypointCoordinate(row.text);
      if (coordinate) {
        points.push({ label: String(index + 1), coordinate });
      }
    });

    const destinationCoordinate = safeParseWaypointCoordinate(destination);
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

    if (points.length > 1 && !previewActiveRef.current) {
      const bounds = new google.maps.LatLngBounds();
      points.forEach(({ coordinate }) => {
        bounds.extend({
          lat: coordinate.latitude,
          lng: coordinate.longitude,
        });
      });
      mapRef.current.fitBounds(bounds);
    }
  }, [destination, mapReady, origin, waypointRows]);

  const clearMapUndoStack = () => {
    setMapUndoStack([]);
  };

  const undoLastMapPick = () => {
    setMapUndoStack((current) => {
      const previousFields = current.at(-1);
      if (!previousFields) return current;

      setOrigin(previousFields.origin);
      setDestination(previousFields.destination);
      setWaypointRows(previousFields.waypointRows);
      return current.slice(0, -1);
    });
  };

  const updateWaypointRow = (
    rowId: string,
    update: Partial<Pick<WaypointRow, "text" | "showOnMap">>
  ) => {
    setWaypointRows((current) =>
      current.map((row) => (row.id === rowId ? { ...row, ...update } : row))
    );
  };

  const removeWaypointRow = (rowId: string) => {
    setWaypointRows((current) => current.filter((row) => row.id !== rowId));
  };

  const moveWaypointRow = (rowId: string, direction: -1 | 1) => {
    setWaypointRows((current) => {
      const index = current.findIndex((row) => row.id === rowId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const addWaypointRow = () => {
    setWaypointRows((current) => [
      ...current,
      { id: newWaypointRowId(), text: "", showOnMap: true },
    ]);
  };

  const buildRequest = (): CreateGoogleRouteRequest => {
    const parsedOrigin = parseRouteWaypointInput(origin);
    const parsedDestination = parseRouteWaypointInput(destination);
    const parsedIntermediates = waypointRows
      .filter((row) => row.text.trim())
      .map((row) => {
        const parsed = parseRouteWaypointInput(row.text);
        return typeof parsed === "string"
          ? parsed
          : { ...parsed, showOnMap: row.showOnMap };
      });

    if (parsedIntermediates.length > 25) {
      throw new Error("経由地は25件以内にしてください");
    }

    return {
      name: name.trim() || `${origin.trim()} → ${destination.trim()}`,
      origin: parsedOrigin,
      destination: parsedDestination,
      intermediates: parsedIntermediates,
      travelMode,
      includeElevation,
    };
  };

  /** 保存せずにRoutes APIの経路を取得し、地図へ青線で描画する */
  const previewRoute = async () => {
    setPreviewing(true);
    setError(null);
    setPreviewWarning(null);

    try {
      // プレビューでは標高取得を省略する（Elevation API節約・高速化）
      const request = { ...buildRequest(), includeElevation: false };
      const result = await createGoogleRoutesRoute(request);
      const path = result.route.points.map((point) => ({
        lat: point.lat,
        lng: point.lng,
      }));

      if (mapRef.current && window.google?.maps?.Polyline) {
        previewPolylineRef.current?.setMap(null);
        previewPolylineRef.current = new google.maps.Polyline({
          map: mapRef.current,
          path,
          strokeColor: "#1a73e8",
          strokeOpacity: 0.9,
          strokeWeight: 5,
        });
        const bounds = new google.maps.LatLngBounds();
        path.forEach((position) => bounds.extend(position));
        mapRef.current.fitBounds(bounds);
      }

      const distanceKm =
        (result.route.points.at(-1)?.distance ?? 0) / 1000;
      setPreviewSummary(
        `${result.routeType}・約${distanceKm.toFixed(1)}km — 青線が走行ルートです。おかしい区間があれば「経由地追加」で地図にピンを置くと自動で引き直します`
      );
      if (result.warning) setPreviewWarning(result.warning);
    } catch (previewError) {
      setError((previewError as Error).message);
      setPreviewSummary(null);
    } finally {
      setPreviewing(false);
    }
  };

  useEffect(() => {
    if (autoPreviewTick === 0) return;
    // effect内の同期setStateを避けるため次のタスクで実行する
    const timerId = window.setTimeout(() => void previewRoute(), 0);
    return () => window.clearTimeout(timerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPreviewTick]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const request = buildRequest();
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

        <div className="route-waypoint-rows">
          <span className="route-waypoint-rows-title">
            経由地（通過順・最大25地点）
          </span>
          {waypointRows.length === 0 && (
            <small>
              「経由地追加」を選んで地図をクリックするか、「＋
              経由地を追加」で入力します。地名、「緯度,経度」、「表示名 |
              緯度,経度」が使えます。
            </small>
          )}
          {waypointRows.map((row, index) => (
            <div className="route-waypoint-row" key={row.id}>
              <span className="route-waypoint-index">{index + 1}</span>
              <input
                value={row.text}
                onChange={(event) => {
                  updateWaypointRow(row.id, { text: event.target.value });
                  clearMapUndoStack();
                }}
                placeholder="例: 蒲生四丁目駅 / 34.700380,135.546240"
              />
              <label
                className="route-waypoint-toggle"
                title="オンにすると走行中のミニマップへ赤丸で表示します。オフでもルート計算には使われます"
              >
                <input
                  type="checkbox"
                  checked={row.showOnMap}
                  onChange={(event) =>
                    updateWaypointRow(row.id, {
                      showOnMap: event.target.checked,
                    })
                  }
                />
                赤丸
              </label>
              <button
                type="button"
                aria-label={`経由地${index + 1}を上へ`}
                disabled={index === 0}
                onClick={() => moveWaypointRow(row.id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`経由地${index + 1}を下へ`}
                disabled={index === waypointRows.length - 1}
                onClick={() => moveWaypointRow(row.id, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`経由地${index + 1}を削除`}
                onClick={() => removeWaypointRow(row.id)}
              >
                削除
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="secondary-button"
              onClick={addWaypointRow}
            >
              ＋ 経由地を追加
            </button>
          </div>
          <small>
            「赤丸」をオフにした経由地はルート計算には使われますが、走行中のミニマップには表示されません。
          </small>
        </div>

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
              {previewSummary && (
                <p className="route-preview-info">{previewSummary}</p>
              )}
              {previewWarning && (
                <p className="route-creator-error">{previewWarning}</p>
              )}
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
                  event.target.value as CreateGoogleRouteRequest["travelMode"]
                )
              }
            >
              <option value="MAIN_ROAD">幹線道路優先（推奨・高速/有料道路回避）</option>
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
          <button
            type="button"
            className="secondary-button"
            onClick={previewRoute}
            disabled={previewing || submitting || !API_KEY}
            title={
              API_KEY
                ? "保存せずに走行ルートを地図の青線で確認します"
                : "プレビューにはVITE_GOOGLE_MAPS_API_KEYが必要です"
            }
          >
            {previewing ? "プレビュー取得中…" : "ルートをプレビュー"}
          </button>
          <button type="submit" disabled={submitting}>
            {submitting ? "ルート作成中…" : "作成して走行"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** 座標または「表示名 | 座標」形式なら座標を返す。地名などは null */
function safeParseWaypointCoordinate(value: string): LatLngInput | null {
  try {
    const parsed = parseRouteWaypointInput(value);
    if (typeof parsed === "string") return null;
    return { latitude: parsed.latitude, longitude: parsed.longitude };
  } catch {
    return null;
  }
}
