import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import type { Route, RoutePoint, SensorAdapter } from "./types";
import { totalDistance } from "./modules/routeLoader";
import { getPointAtDistance } from "./modules/routeSampler";
import { gradeFactor } from "./modules/grade";
import { KeyboardSensor } from "./modules/sensorKeyboard";
import { SerialSensor } from "./modules/sensorSerial";
import { VirtualEsp32Sensor } from "./modules/sensorVirtualEsp32";
import {
  loadMapsApi,
  StreetViewController,
  STREET_VIEW_INTERVAL,
} from "./modules/streetViewController";
import { loadRouteFromKmzUrl } from "./modules/kmzRouteLoader";
import {
  loadGoogleRoutesRoute,
  type GoogleRouteId,
  type RouteWaypointInput,
} from "./modules/googleRoutesLoader";
import {
  deleteCustomRoute,
  loadCustomRoutes,
  type CustomRoute,
} from "./modules/customRoutes";
import { RouteCreator } from "./RouteCreator";
import {
  clearRouteProgress,
  loadRouteProgress,
  saveRouteProgress,
} from "./modules/routeProgress";
import { reverseGeocodeArea } from "./modules/locationAddress";
import routeKmzUrl from "../routes/sources/osaka-kyoto-yodogawa.kmz?url";

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
const GOAL_THRESHOLD_METERS = 1;
const STREET_VIEW_INITIAL_SEARCH_OFFSETS_METERS = [
  100,
  -100,
  200,
  -200,
  300,
  -300,
  500,
  -500,
  800,
  -800,
  1000,
  -1000,
  1500,
  -1500,
  2000,
  -2000,
];
const DELETED_BUILT_IN_ROUTES_KEY = "bike-streetview:deleted-built-in-routes";
const ROUTE_TITLES_KEY = "bike-streetview:route-titles";
const ROUTE_DESCRIPTIONS_KEY = "bike-streetview:route-descriptions";
const ROUTE_POINT_LABELS_KEY = "bike-streetview:route-point-labels";
const MINI_MAP_WIDTH = 220;
const MINI_MAP_HEIGHT = 140;
const MINI_MAP_PADDING = 14;

type Hud = {
  speedKmh: number;
  rpm: number;
  distanceM: number;
  elevation: number;
  grade: number;
  panoCount: number;
};

type SensorMode = "keyboard" | "virtual" | "serial";

type BuiltInRouteId =
  | "osaka-kyoto"
  | "shin-osaka-nara"
  | "esaka-minoh-kayano";

type RouteLoadResult = {
  route: Route;
  routeType: string;
  startLabel?: string;
  goalLabel?: string;
  waypoints: RouteMapMarker[];
};

type RouteMapMarker = {
  lat: number;
  lng: number;
  label?: string;
};

type RoutePointLabelOverrides = {
  startLabel?: string;
  goalLabel?: string;
  waypointLabels?: string[];
};

type RoutePointLabelValues = {
  startLabel: string;
  goalLabel: string;
  waypointLabels: string[];
};

type PointLabelEditorState = {
  routeId: string;
  title: string;
  startLabel: string;
  goalLabel: string;
  waypointLabels: string[];
  defaults: RoutePointLabelValues;
};

const BUILT_IN_ROUTE_WAYPOINTS: Partial<
  Record<BuiltInRouteId, RouteMapMarker[]>
> = {
  "shin-osaka-nara": [
    { lat: 34.70038, lng: 135.54624, label: "蒲生四丁目駅" },
  ],
};

const ROUTE_OPTIONS: Array<{
  id: BuiltInRouteId;
  title: string;
  description: string;
  source: string;
}> = [
  {
    id: "osaka-kyoto",
    title: "大阪・淀川 → 京都御所",
    description: "淀川沿いを北上する約48kmのルート",
    source: "KMZルート",
  },
  {
    id: "shin-osaka-nara",
    title: "新大阪 → 蒲生四丁目 → 奈良",
    description: "蒲生四丁目を経由して奈良へ向かう約39kmのルート",
    source: "Google Routes API",
  },
  {
    id: "esaka-minoh-kayano",
    title: "江坂 → 箕面萱野",
    description: "標高・勾配を確認する北摂のテストルート",
    source: "Routes + Elevation API",
  },
];

function isBuiltInRouteId(routeId: string): routeId is BuiltInRouteId {
  return ROUTE_OPTIONS.some((option) => option.id === routeId);
}

function loadDeletedBuiltInRouteIds(): BuiltInRouteId[] {
  try {
    const storedValue = window.localStorage.getItem(DELETED_BUILT_IN_ROUTES_KEY);
    if (!storedValue) return [];
    const routeIds = JSON.parse(storedValue) as unknown;
    return Array.isArray(routeIds)
      ? routeIds.filter(
          (routeId): routeId is BuiltInRouteId =>
            typeof routeId === "string" && isBuiltInRouteId(routeId)
        )
      : [];
  } catch {
    return [];
  }
}

function saveDeletedBuiltInRouteIds(routeIds: BuiltInRouteId[]): void {
  window.localStorage.setItem(
    DELETED_BUILT_IN_ROUTES_KEY,
    JSON.stringify([...new Set(routeIds)])
  );
}

function loadStringRecord(storageKey: string): Record<string, string> {
  try {
    const storedValue = window.localStorage.getItem(storageKey);
    if (!storedValue) return {};
    const values = JSON.parse(storedValue) as unknown;
    if (!values || typeof values !== "object") return {};

    return Object.fromEntries(
      Object.entries(values).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}

function loadRouteTitles(): Record<string, string> {
  return loadStringRecord(ROUTE_TITLES_KEY);
}

function loadRouteDescriptions(): Record<string, string> {
  return loadStringRecord(ROUTE_DESCRIPTIONS_KEY);
}

function saveRouteTitles(titles: Record<string, string>): void {
  window.localStorage.setItem(ROUTE_TITLES_KEY, JSON.stringify(titles));
}

function saveRouteDescriptions(descriptions: Record<string, string>): void {
  window.localStorage.setItem(
    ROUTE_DESCRIPTIONS_KEY,
    JSON.stringify(descriptions)
  );
}

function loadRoutePointLabelOverrides(): Record<
  string,
  RoutePointLabelOverrides
> {
  try {
    const storedValue = window.localStorage.getItem(ROUTE_POINT_LABELS_KEY);
    if (!storedValue) return {};
    const values = JSON.parse(storedValue) as unknown;
    if (!values || typeof values !== "object") return {};

    return Object.fromEntries(
      Object.entries(values).flatMap(([routeId, value]) => {
        if (!value || typeof value !== "object") return [];
        const candidate = value as Partial<RoutePointLabelOverrides>;
        return [
          [
            routeId,
            {
              startLabel:
                typeof candidate.startLabel === "string"
                  ? candidate.startLabel
                  : undefined,
              goalLabel:
                typeof candidate.goalLabel === "string"
                  ? candidate.goalLabel
                  : undefined,
              waypointLabels: Array.isArray(candidate.waypointLabels)
                ? candidate.waypointLabels.filter(
                    (label): label is string => typeof label === "string"
                  )
                : undefined,
            },
          ],
        ];
      })
    ) as Record<string, RoutePointLabelOverrides>;
  } catch {
    return {};
  }
}

function saveRoutePointLabelOverrides(
  labels: Record<string, RoutePointLabelOverrides>
): void {
  window.localStorage.setItem(ROUTE_POINT_LABELS_KEY, JSON.stringify(labels));
}

function routeWaypointLabel(waypoint: RouteWaypointInput): string {
  return typeof waypoint === "string"
    ? waypoint
    : waypoint.label ??
        `${waypoint.latitude.toFixed(6)},${waypoint.longitude.toFixed(6)}`;
}

function defaultCustomRouteDescription(customRoute: CustomRoute): string {
  return `${routeWaypointLabel(customRoute.request.origin)} → ${routeWaypointLabel(
    customRoute.request.destination
  )}`;
}

function findCustomRoute(
  routeId: string,
  customRoutes: CustomRoute[]
): CustomRoute | undefined {
  return customRoutes.find((candidate) => candidate.id === routeId);
}

function defaultRouteTitle(
  routeId: string,
  customRoutes: CustomRoute[]
): string | undefined {
  return (
    findCustomRoute(routeId, customRoutes)?.route.name ??
    ROUTE_OPTIONS.find((option) => option.id === routeId)?.title
  );
}

function routeTitleParts(title: string | undefined): {
  startLabel: string;
  goalLabel: string;
} {
  const parts = title?.split("→").map((part) => part.trim()) ?? [];
  return {
    startLabel: parts[0] ?? "",
    goalLabel: parts.at(-1) ?? "",
  };
}

function routeDisplayTitle(
  routeId: string,
  customRoutes: CustomRoute[],
  routeTitles: Record<string, string>,
  fallback: string
): string {
  return (
    routeTitles[routeId] ??
    defaultRouteTitle(routeId, customRoutes) ??
    fallback
  );
}

function loadSelectableRoute(
  routeId: string,
  customRoutes: CustomRoute[]
): Promise<RouteLoadResult> {
  const customRoute = findCustomRoute(routeId, customRoutes);
  if (customRoute) {
    return Promise.resolve({
      route: customRoute.route,
      routeType: customRoute.routeType,
      startLabel: routeWaypointLabel(customRoute.request.origin),
      goalLabel: routeWaypointLabel(customRoute.request.destination),
      waypoints: routeWaypointsFromInputs(customRoute.request.intermediates),
    });
  }

  if (routeId === "osaka-kyoto") {
    return loadRouteFromKmzUrl(routeKmzUrl).then((loadedRoute) => ({
      route: loadedRoute,
      routeType: "KMZルート",
      waypoints: BUILT_IN_ROUTE_WAYPOINTS[routeId] ?? [],
    }));
  }

  return loadGoogleRoutesRoute(routeId as GoogleRouteId).then((result) => ({
    ...result,
    startLabel: ROUTE_OPTIONS.find((option) => option.id === routeId)?.title
      .split("→")[0]
      ?.trim(),
    goalLabel: ROUTE_OPTIONS.find((option) => option.id === routeId)?.title
      .split("→")
      .at(-1)
      ?.trim(),
    waypoints: BUILT_IN_ROUTE_WAYPOINTS[routeId as BuiltInRouteId] ?? [],
  }));
}

function routeWaypointsFromInputs(
  waypoints: RouteWaypointInput[]
): RouteMapMarker[] {
  const markers: RouteMapMarker[] = [];

  waypoints.forEach((waypoint) => {
    if (typeof waypoint === "string") return;
    markers.push({
      lat: waypoint.latitude,
      lng: waypoint.longitude,
      label: waypoint.label,
    });
  });

  return markers;
}

function defaultRoutePointLabels(
  routeId: string,
  customRoutes: CustomRoute[]
): RoutePointLabelValues {
  const customRoute = findCustomRoute(routeId, customRoutes);
  if (customRoute) {
    return {
      startLabel: routeWaypointLabel(customRoute.request.origin),
      goalLabel: routeWaypointLabel(customRoute.request.destination),
      waypointLabels: routeWaypointsFromInputs(
        customRoute.request.intermediates
      ).map((waypoint) => waypoint.label ?? ""),
    };
  }

  const builtInTitle = ROUTE_OPTIONS.find((option) => option.id === routeId)
    ?.title;
  const titleParts = routeTitleParts(builtInTitle);

  return {
    startLabel: titleParts.startLabel,
    goalLabel: titleParts.goalLabel,
    waypointLabels: (
      BUILT_IN_ROUTE_WAYPOINTS[routeId as BuiltInRouteId] ?? []
    ).map((waypoint) => waypoint.label ?? ""),
  };
}

function applyPointLabelOverridesToValues(
  defaults: RoutePointLabelValues,
  overrides?: RoutePointLabelOverrides
): RoutePointLabelValues {
  if (!overrides) return defaults;

  return {
    startLabel: overrides.startLabel?.trim() || defaults.startLabel,
    goalLabel: overrides.goalLabel?.trim() || defaults.goalLabel,
    waypointLabels: defaults.waypointLabels.map(
      (label, index) => overrides.waypointLabels?.[index]?.trim() || label
    ),
  };
}

function applyPointLabelOverrides(
  routeData: RouteLoadResult,
  overrides?: RoutePointLabelOverrides
): RouteLoadResult {
  if (!overrides) return routeData;

  return {
    ...routeData,
    startLabel: overrides.startLabel?.trim() || routeData.startLabel,
    goalLabel: overrides.goalLabel?.trim() || routeData.goalLabel,
    waypoints: routeData.waypoints.map((waypoint, index) => ({
      ...waypoint,
      label: overrides.waypointLabels?.[index]?.trim() || waypoint.label,
    })),
  };
}

function streetViewInitialSearchCandidates(route: Route, distanceM: number) {
  const routeDistanceM = totalDistance(route);

  return STREET_VIEW_INITIAL_SEARCH_OFFSETS_METERS.map(
    (offset) => distanceM + offset
  )
    .filter(
      (candidateDistance) =>
        candidateDistance >= 0 && candidateDistance <= routeDistanceM
    )
    .map((candidateDistance) => ({
      distance: candidateDistance,
      point: getPointAtDistance(route, candidateDistance),
    }));
}

export default function App() {
  const svRef = useRef<HTMLDivElement>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [customRoutes, setCustomRoutes] =
    useState<CustomRoute[]>(loadCustomRoutes);
  const [deletedBuiltInRouteIds, setDeletedBuiltInRouteIds] = useState<
    BuiltInRouteId[]
  >(loadDeletedBuiltInRouteIds);
  const [routeTitles, setRouteTitles] =
    useState<Record<string, string>>(loadRouteTitles);
  const [routeDescriptions, setRouteDescriptions] = useState<
    Record<string, string>
  >(loadRouteDescriptions);
  const [routePointLabels, setRoutePointLabels] = useState<
    Record<string, RoutePointLabelOverrides>
  >(loadRoutePointLabelOverrides);
  const [routeEditor, setRouteEditor] = useState<{
    routeId: string;
    title: string;
    description: string;
  } | null>(null);
  const [pointLabelEditor, setPointLabelEditor] =
    useState<PointLabelEditorState | null>(null);
  const [creatingRoute, setCreatingRoute] = useState(false);
  const [route, setRoute] = useState<Route | null>(null);
  const [routeStartLabel, setRouteStartLabel] = useState<string | undefined>();
  const [routeGoalLabel, setRouteGoalLabel] = useState<string | undefined>();
  const [routeWaypoints, setRouteWaypoints] = useState<RouteMapMarker[]>([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeType, setRouteType] = useState("");
  const [hud, setHud] = useState<Hud>({
    speedKmh: 0,
    rpm: 0,
    distanceM: 0,
    elevation: 0,
    grade: 0,
    panoCount: 0,
  });
  const [mapsReady, setMapsReady] = useState(false);
  const [mapsError, setMapsError] = useState<string | null>(null);
  const [currentArea, setCurrentArea] = useState("住所取得中…");
  const [sensorMode, setSensorMode] = useState<SensorMode>("keyboard");
  const [virtualTargetRpm, setVirtualTargetRpm] = useState(0);
  const [virtualConnected, setVirtualConnected] = useState(true);
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false);
  const [previewRouteId, setPreviewRouteId] = useState<string | null>(null);
  const [previewRoute, setPreviewRoute] = useState<Route | null>(null);
  const [previewRouteType, setPreviewRouteType] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const distanceRef = useRef(0);
  const controllerRef = useRef<StreetViewController | null>(null);
  const sensorRef = useRef<SensorAdapter | null>(null);
  const serialRef = useRef<SerialSensor | null>(null);
  const virtualRef = useRef<VirtualEsp32Sensor | null>(null);
  const keyboardRef = useRef<KeyboardSensor | null>(null);

  useEffect(() => {
    if (!selectedRouteId) return;

    let cancelled = false;

    loadSelectableRoute(selectedRouteId, customRoutes)
      .then((result) => {
        if (!cancelled) {
          const labeledResult = applyPointLabelOverrides(
            result,
            routePointLabels[selectedRouteId]
          );
          const savedDistance = Math.min(
            loadRouteProgress(selectedRouteId),
            totalDistance(labeledResult.route)
          );
          const savedPoint = getPointAtDistance(
            labeledResult.route,
            savedDistance
          );
          const displayName = routeDisplayTitle(
            selectedRouteId,
            customRoutes,
            routeTitles,
            labeledResult.route.name
          );
          distanceRef.current = savedDistance;
          setRoute({ ...labeledResult.route, name: displayName });
          setRouteStartLabel(labeledResult.startLabel);
          setRouteGoalLabel(labeledResult.goalLabel);
          setRouteWaypoints(labeledResult.waypoints);
          setRouteType(labeledResult.routeType);
          setHud({
            speedKmh: 0,
            rpm: 0,
            distanceM: savedDistance,
            elevation: savedPoint.elevation,
            grade: savedPoint.grade,
            panoCount: 0,
          });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setRouteError(error.message);
      })
      .finally(() => {
        if (!cancelled) setRouteLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [customRoutes, routePointLabels, routeTitles, selectedRouteId]);

  useEffect(() => {
    if (!previewRouteId) return;

    let cancelled = false;
    setPreviewRoute(null);
    setPreviewRouteType("");
    setPreviewError(null);
    setPreviewLoading(true);

    loadSelectableRoute(previewRouteId, customRoutes)
      .then((result) => {
        if (cancelled) return;
        const labeledResult = applyPointLabelOverrides(
          result,
          routePointLabels[previewRouteId]
        );
        const displayName = routeDisplayTitle(
          previewRouteId,
          customRoutes,
          routeTitles,
          labeledResult.route.name
        );
        setPreviewRoute({ ...labeledResult.route, name: displayName });
        setPreviewRouteType(labeledResult.routeType);
      })
      .catch((error: Error) => {
        if (!cancelled) setPreviewError(error.message);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [customRoutes, previewRouteId, routePointLabels, routeTitles]);

  // Street View 初期化（APIキーがある場合のみ）
  useEffect(() => {
    if (!API_KEY || !route || !selectedRouteId) return;
    let cancelled = false;
    let addressRequestId = 0;

    const updateCurrentArea = async (
      position: google.maps.LatLngLiteral
    ) => {
      const requestId = ++addressRequestId;
      try {
        const area = await reverseGeocodeArea(position);
        if (!cancelled && requestId === addressRequestId) {
          setCurrentArea(area);
        }
      } catch {
        if (!cancelled && requestId === addressRequestId) {
          setCurrentArea("住所取得失敗");
        }
      }
    };

    loadMapsApi(API_KEY)
      .then(() => {
        if (cancelled || !svRef.current) return;
        const startDistance = distanceRef.current;
        const startPoint = getPointAtDistance(route, startDistance);
        const controller = new StreetViewController(
          svRef.current,
          startPoint,
          startDistance,
          (savedDistance, position, options) => {
            if (options?.syncDistance) {
              const syncedPoint = getPointAtDistance(route, savedDistance);
              distanceRef.current = savedDistance;
              setHud((currentHud) => ({
                ...currentHud,
                distanceM: savedDistance,
                elevation: syncedPoint.elevation,
                grade: syncedPoint.grade,
                panoCount:
                  controllerRef.current?.panoUpdateCount ??
                  currentHud.panoCount,
              }));
            }
            saveRouteProgress(selectedRouteId, savedDistance);
            void updateCurrentArea(position);
          },
          streetViewInitialSearchCandidates(route, startDistance)
        );
        controllerRef.current = controller;
        controller.ready.then((found) => {
          if (cancelled || controllerRef.current !== controller) return;
          if (found) {
            setMapsReady(true);
            return;
          }
          setMapsError(
            "ルート周辺のStreet Viewが見つかりませんでした。少し進めるか、別ルートを選んでください。"
          );
        });
      })
      .catch((e: Error) => setMapsError(e.message));
    return () => {
      cancelled = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [route, selectedRouteId]);

  // センサー＋走行ループ
  useEffect(() => {
    if (!route) return;
    const keyboard = new KeyboardSensor();
    keyboard.onReset = () => {
      setResetConfirmationOpen(true);
    };
    keyboard.start();
    keyboardRef.current = keyboard;
    sensorRef.current = keyboard;

    let rafId = 0;
    let lastT = performance.now();
    const loop = (t: number) => {
      const dt = Math.min((t - lastT) / 1000, 0.5);
      lastT = t;

      const sensor = sensorRef.current ?? keyboard;
      const currentPoint = getPointAtDistance(route, distanceRef.current);
      const speed = sensor.getSpeedMps() * gradeFactor(currentPoint.grade);
      distanceRef.current = Math.min(
        distanceRef.current + speed * dt,
        totalDistance(route)
      );
      const p: RoutePoint = getPointAtDistance(route, distanceRef.current);

      const ctrl = controllerRef.current;
      ctrl?.maybeUpdate(distanceRef.current, p);

      setHud({
        speedKmh: speed * 3.6,
        rpm: sensor.getRpm(),
        distanceM: distanceRef.current,
        elevation: p.elevation,
        grade: p.grade,
        panoCount: ctrl?.panoUpdateCount ?? 0,
      });
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafId);
      keyboard.stop();
      keyboardRef.current = null;
      virtualRef.current?.stop();
      serialRef.current?.stop();
    };
  }, [route, selectedRouteId]);

  const connectSerial = async () => {
    try {
      const serial = new SerialSensor();
      await serial.start();
      virtualRef.current?.stop();
      serialRef.current = serial;
      sensorRef.current = serial;
      setSensorMode("serial");
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const useKeyboardSensor = () => {
    virtualRef.current?.stop();
    serialRef.current?.stop();
    serialRef.current = null;
    sensorRef.current = keyboardRef.current;
    setSensorMode("keyboard");
  };

  const useVirtualEsp32 = () => {
    serialRef.current?.stop();
    serialRef.current = null;
    const virtual = new VirtualEsp32Sensor();
    virtual.start();
    virtual.setTargetRpm(60);
    virtualRef.current = virtual;
    sensorRef.current = virtual;
    setVirtualTargetRpm(60);
    setVirtualConnected(true);
    setSensorMode("virtual");
  };

  const adjustVirtualRpm = (delta: number) => {
    const virtual = virtualRef.current;
    if (!virtual) return;
    virtual.adjustTargetRpm(delta);
    setVirtualTargetRpm(virtual.getTargetRpm());
  };

  const stopVirtualPedaling = () => {
    virtualRef.current?.setTargetRpm(0);
    setVirtualTargetRpm(0);
  };

  const toggleVirtualConnection = () => {
    const virtual = virtualRef.current;
    if (!virtual) return;
    const connected = !virtual.isConnected();
    virtual.setConnected(connected);
    setVirtualConnected(connected);
  };

  const selectRoute = (routeId: string) => {
    setRoute(null);
    setRouteStartLabel(undefined);
    setRouteGoalLabel(undefined);
    setRouteWaypoints([]);
    setRouteError(null);
    setRouteLoading(true);
    setMapsReady(false);
    setMapsError(null);
    setRouteType("");
    setCurrentArea("住所取得中…");
    distanceRef.current = 0;
    setSelectedRouteId(routeId);
  };

  const openRoutePreview = (routeId: string) => {
    setPreviewRouteId(routeId);
  };

  const closeRoutePreview = () => {
    setPreviewRouteId(null);
    setPreviewRoute(null);
    setPreviewRouteType("");
    setPreviewError(null);
    setPreviewLoading(false);
  };

  const openPointLabelEdit = (routeId: string, title: string) => {
    const defaults = defaultRoutePointLabels(routeId, customRoutes);
    const values = applyPointLabelOverridesToValues(
      defaults,
      routePointLabels[routeId]
    );

    setPointLabelEditor({
      routeId,
      title,
      startLabel: values.startLabel,
      goalLabel: values.goalLabel,
      waypointLabels: values.waypointLabels,
      defaults,
    });
  };

  const savePointLabelEdit = (values: RoutePointLabelValues) => {
    if (!pointLabelEditor) return;

    const nextLabels = { ...routePointLabels };
    const startLabel = values.startLabel.trim();
    const goalLabel = values.goalLabel.trim();
    const waypointLabels = values.waypointLabels.map((label) => label.trim());
    const nextOverride: RoutePointLabelOverrides = {};

    if (startLabel && startLabel !== pointLabelEditor.defaults.startLabel) {
      nextOverride.startLabel = startLabel;
    }

    if (goalLabel && goalLabel !== pointLabelEditor.defaults.goalLabel) {
      nextOverride.goalLabel = goalLabel;
    }

    const waypointOverrides = waypointLabels.map((label, index) =>
      label && label !== pointLabelEditor.defaults.waypointLabels[index]
        ? label
        : ""
    );
    if (waypointOverrides.some(Boolean)) {
      nextOverride.waypointLabels = waypointOverrides;
    }

    if (
      nextOverride.startLabel ||
      nextOverride.goalLabel ||
      nextOverride.waypointLabels
    ) {
      nextLabels[pointLabelEditor.routeId] = nextOverride;
    } else {
      delete nextLabels[pointLabelEditor.routeId];
    }

    saveRoutePointLabelOverrides(nextLabels);
    setRoutePointLabels(nextLabels);
    setPointLabelEditor(null);
  };

  const cancelPointLabelEdit = () => {
    setPointLabelEditor(null);
  };

  const handleCreatedRoute = (customRoute: CustomRoute) => {
    setCustomRoutes((routes) => [customRoute, ...routes]);
    setCreatingRoute(false);
    selectRoute(customRoute.id);
  };

  const removeCustomRoute = (routeId: string) => {
    deleteCustomRoute(routeId);
    clearRouteProgress(routeId);
    const { [routeId]: _deletedTitle, ...nextTitles } = routeTitles;
    const { [routeId]: _deletedDescription, ...nextDescriptions } =
      routeDescriptions;
    const { [routeId]: _deletedPointLabels, ...nextPointLabels } =
      routePointLabels;
    saveRouteTitles(nextTitles);
    saveRouteDescriptions(nextDescriptions);
    saveRoutePointLabelOverrides(nextPointLabels);
    setRouteTitles(nextTitles);
    setRouteDescriptions(nextDescriptions);
    setRoutePointLabels(nextPointLabels);
    setCustomRoutes((routes) =>
      routes.filter((customRoute) => customRoute.id !== routeId)
    );
  };

  const removeRouteFromList = (routeId: string) => {
    if (isBuiltInRouteId(routeId)) {
      const nextRouteIds = [...deletedBuiltInRouteIds, routeId];
      saveDeletedBuiltInRouteIds(nextRouteIds);
      setDeletedBuiltInRouteIds(nextRouteIds);
      clearRouteProgress(routeId);
      return;
    }

    removeCustomRoute(routeId);
  };

  const restoreBuiltInRoutes = () => {
    saveDeletedBuiltInRouteIds([]);
    setDeletedBuiltInRouteIds([]);
  };

  const startRouteEdit = (
    routeId: string,
    currentTitle: string,
    currentDescription: string
  ) => {
    setRouteEditor({
      routeId,
      title: currentTitle,
      description: currentDescription,
    });
  };

  const saveRouteEdit = (
    routeId: string,
    defaultTitle: string,
    defaultDescription: string
  ) => {
    if (!routeEditor || routeEditor.routeId !== routeId) return;

    const nextTitles = { ...routeTitles };
    const nextDescriptions = { ...routeDescriptions };
    const nextTitle = routeEditor.title.trim();
    const nextDescription = routeEditor.description.trim();

    if (!nextTitle || nextTitle === defaultTitle) {
      delete nextTitles[routeId];
    } else {
      nextTitles[routeId] = nextTitle;
    }

    if (!nextDescription || nextDescription === defaultDescription) {
      delete nextDescriptions[routeId];
    } else {
      nextDescriptions[routeId] = nextDescription;
    }

    saveRouteTitles(nextTitles);
    saveRouteDescriptions(nextDescriptions);
    setRouteTitles(nextTitles);
    setRouteDescriptions(nextDescriptions);
    setRouteEditor(null);
  };

  const cancelRouteEdit = () => {
    setRouteEditor(null);
  };

  const returnToRouteSelection = () => {
    controllerRef.current?.destroy();
    controllerRef.current = null;
    serialRef.current?.stop();
    serialRef.current = null;
    virtualRef.current?.stop();
    virtualRef.current = null;
    sensorRef.current = null;
    distanceRef.current = 0;
    setRoute(null);
    setRouteStartLabel(undefined);
    setRouteGoalLabel(undefined);
    setRouteWaypoints([]);
    setRouteLoading(false);
    setRouteError(null);
    setRouteType("");
    setSelectedRouteId(null);
    setSensorMode("keyboard");
    setVirtualTargetRpm(0);
    setVirtualConnected(true);
    setResetConfirmationOpen(false);
  };

  const confirmReset = () => {
    if (!route) return;
    distanceRef.current = 0;
    if (selectedRouteId) clearRouteProgress(selectedRouteId);
    keyboardRef.current?.stopPedaling();
    virtualRef.current?.setTargetRpm(0);
    setVirtualTargetRpm(0);
    controllerRef.current?.reset(route.points[0]);
    setResetConfirmationOpen(false);
  };

  if (!selectedRouteId && creatingRoute) {
    return (
      <RouteCreator
        onCancel={() => setCreatingRoute(false)}
        onCreated={handleCreatedRoute}
      />
    );
  }

  if (!selectedRouteId) {
    const visibleRouteOptions = ROUTE_OPTIONS.filter(
      (option) => !deletedBuiltInRouteIds.includes(option.id)
    );
    return (
      <div className="route-selection" key="route-selection">
        <div className="route-selection-panel">
          <p className="route-selection-kicker">BIKE STREET VIEW</p>
          <h1>走行するルートを選択</h1>
          <button
            className="create-route-button"
            onClick={() => setCreatingRoute(true)}
          >
            ＋ 新しいルートを作成
          </button>
          {deletedBuiltInRouteIds.length > 0 && (
            <button
              className="restore-route-button"
              onClick={restoreBuiltInRoutes}
            >
              標準ルートを復元
            </button>
          )}
          <div className="route-options">
            {visibleRouteOptions.map((option) => (
              <RouteCard
                key={option.id}
                routeId={option.id}
                defaultTitle={option.title}
                title={routeTitles[option.id] ?? option.title}
                source={option.source}
                defaultDescription={option.description}
                description={
                  routeDescriptions[option.id] ?? option.description
                }
                editorValue={
                  routeEditor?.routeId === option.id
                    ? routeEditor
                    : null
                }
                onSelect={selectRoute}
                onPreview={openRoutePreview}
                onEditPoints={openPointLabelEdit}
                onDelete={removeRouteFromList}
                onStartEdit={startRouteEdit}
                onChangeEdit={(editor) =>
                  setRouteEditor({ routeId: option.id, ...editor })
                }
                onSaveEdit={saveRouteEdit}
                onCancelEdit={cancelRouteEdit}
              />
            ))}
            {customRoutes.map((customRoute) => (
              <RouteCard
                key={customRoute.id}
                routeId={customRoute.id}
                defaultTitle={customRoute.route.name}
                title={routeTitles[customRoute.id] ?? customRoute.route.name}
                source={`保存済み・${customRoute.routeType}`}
                defaultDescription={defaultCustomRouteDescription(customRoute)}
                description={
                  routeDescriptions[customRoute.id] ??
                  defaultCustomRouteDescription(customRoute)
                }
                editorValue={
                  routeEditor?.routeId === customRoute.id
                    ? routeEditor
                    : null
                }
                onSelect={selectRoute}
                onPreview={openRoutePreview}
                onEditPoints={openPointLabelEdit}
                onDelete={removeRouteFromList}
                onStartEdit={startRouteEdit}
                onChangeEdit={(editor) =>
                  setRouteEditor({ routeId: customRoute.id, ...editor })
                }
                onSaveEdit={saveRouteEdit}
                onCancelEdit={cancelRouteEdit}
              />
            ))}
          </div>
        </div>
        {previewRouteId && (
          <RoutePreviewDialog
            route={previewRoute}
            routeType={previewRouteType}
            loading={previewLoading}
            error={previewError}
            onClose={closeRoutePreview}
          />
        )}
        {pointLabelEditor && (
          <PointLabelEditorDialog
            editor={pointLabelEditor}
            onSave={savePointLabelEdit}
            onCancel={cancelPointLabelEdit}
          />
        )}
      </div>
    );
  }

  if (!route || routeLoading) {
    return (
      <div className="app" key="route-loading">
        <div className="placeholder">
          <h2>{routeError ? "ルート読み込み失敗" : "ルート準備中…"}</h2>
          {routeError && <p>{routeError}</p>}
          {routeError && (
            <button
              className="route-selection-back"
              onClick={returnToRouteSelection}
            >
              ルート選択へ戻る
            </button>
          )}
        </div>
      </div>
    );
  }

  const routeDistanceM = totalDistance(route);
  const remainingDistanceM = Math.max(0, routeDistanceM - hud.distanceM);
  const isGoalReached = remainingDistanceM <= GOAL_THRESHOLD_METERS;
  const displaySpeedKmh = isGoalReached ? 0 : hud.speedKmh;

  return (
    <div className="app" key="route-running">
      {API_KEY ? (
        <div key={selectedRouteId} ref={svRef} className="streetview" />
      ) : (
        <div className="placeholder">
          <h2>Street View 未接続</h2>
          <p>
            <code>.env.local</code> に <code>VITE_GOOGLE_MAPS_API_KEY</code>{" "}
            を設定すると表示されます。
            <br />
            キーボード走行とHUDはAPIキーなしで動作確認できます。
          </p>
        </div>
      )}

      <div className="hud">
        <div className="hud-row hud-location">{currentArea}</div>
        <div className="hud-row hud-speed">
          {displaySpeedKmh.toFixed(1)} <span>km/h</span>
        </div>
        <div className="hud-row">
          距離 {(hud.distanceM / 1000).toFixed(2)} km /{" "}
          {(routeDistanceM / 1000).toFixed(2)} km
        </div>
        {isGoalReached && (
          <div className="hud-row hud-goal">ゴール到着</div>
        )}
        <div className="hud-row">
          標高 {hud.elevation.toFixed(1)} m ｜ 勾配 {hud.grade.toFixed(1)} %
        </div>
        <div className="hud-row">
          RPM {hud.rpm.toFixed(0)} ｜ {routeType}
        </div>
        <div className="hud-row hud-sub">
          SV {hud.panoCount}回 / {STREET_VIEW_INTERVAL}m ｜{" "}
          {sensorMode === "keyboard"
            ? "キーボード"
            : sensorMode === "virtual"
              ? `仮想ESP32 ${virtualConnected ? "接続中" : "通信途絶"}`
              : "ESP32"}
        </div>
        {mapsError && <div className="hud-row hud-error">{mapsError}</div>}
        {API_KEY && !mapsReady && !mapsError && (
          <div className="hud-row hud-sub">Street View 読み込み中…</div>
        )}
      </div>

      <MiniRouteMap
        route={route}
        currentDistanceM={hud.distanceM}
        startLabel={routeStartLabel}
        goalLabel={routeGoalLabel}
        waypoints={routeWaypoints}
      />

      {isGoalReached && (
        <div className="goal-banner" role="status" aria-live="polite">
          <span>FINISH</span>
          <strong>ゴール！</strong>
          <small>{route.name}を完走しました</small>
          <div>
            <button onClick={returnToRouteSelection}>ルート選択へ戻る</button>
            <button
              className="secondary-button"
              onClick={() => setResetConfirmationOpen(true)}
            >
              もう一度走る
            </button>
          </div>
        </div>
      )}

      {sensorMode === "virtual" && (
        <div className="virtual-esp32-panel">
          <div>
            <strong>仮想ESP32</strong>
            <span>目標 {virtualTargetRpm.toFixed(0)} RPM</span>
          </div>
          <div className="virtual-esp32-actions">
            <button onClick={() => adjustVirtualRpm(-10)}>-10</button>
            <button onClick={() => adjustVirtualRpm(10)}>+10</button>
            <button onClick={stopVirtualPedaling}>停止</button>
            <button
              className={virtualConnected ? "danger-button" : ""}
              onClick={toggleVirtualConnection}
            >
              {virtualConnected ? "通信途絶" : "再接続"}
            </button>
          </div>
        </div>
      )}

      <div className="controls">
        <span>↑/↓: 速度 ｜ Space: 停止</span>
        <button
          className="danger-button"
          onClick={() => setResetConfirmationOpen(true)}
        >
          リセット
        </button>
        {sensorMode !== "keyboard" && (
          <button className="secondary-button" onClick={useKeyboardSensor}>
            キーボード
          </button>
        )}
        {sensorMode !== "virtual" && (
          <button onClick={useVirtualEsp32}>仮想ESP32</button>
        )}
        {SerialSensor.isSupported() && sensorMode !== "serial" && (
          <button onClick={connectSerial}>ESP32接続</button>
        )}
        <button className="secondary-button" onClick={returnToRouteSelection}>
          ルート変更
        </button>
      </div>

      <div className="route-name">{route.name}</div>

      {resetConfirmationOpen && (
        <div
          className="reset-dialog-backdrop"
          role="presentation"
          onClick={() => setResetConfirmationOpen(false)}
        >
          <div
            className="reset-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="reset-dialog-title">走行をリセットしますか？</h2>
            <p>
              現在位置をルートの最初に戻し、保存済みの走行進捗を削除します。
            </p>
            <div className="reset-dialog-actions">
              <button
                className="secondary-button"
                onClick={() => setResetConfirmationOpen(false)}
              >
                キャンセル
              </button>
              <button className="danger-button" onClick={confirmReset}>
                リセットする
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniRouteMap({
  route,
  currentDistanceM,
  startLabel,
  goalLabel,
  waypoints,
}: {
  route: Route;
  currentDistanceM: number;
  startLabel?: string;
  goalLabel?: string;
  waypoints: RouteMapMarker[];
}) {
  const projection = useMemo(
    () =>
      projectRouteForMiniMap(
        route,
        currentDistanceM,
        waypoints,
        startLabel,
        goalLabel
      ),
    [currentDistanceM, goalLabel, route, startLabel, waypoints]
  );

  return (
    <aside className="mini-route-map" aria-label="現在位置ミニマップ">
      <div className="mini-route-map-header">
        <span>ルート位置</span>
        <strong>{(currentDistanceM / 1000).toFixed(2)} km</strong>
      </div>
      <svg
        viewBox={`0 0 ${MINI_MAP_WIDTH} ${MINI_MAP_HEIGHT}`}
        role="img"
        aria-label={`${route.name}の現在位置`}
      >
        <rect
          x="0"
          y="0"
          width={MINI_MAP_WIDTH}
          height={MINI_MAP_HEIGHT}
          rx="12"
        />
        <polyline points={projection.polyline} />
        {projection.waypoints.map((waypoint, index) => (
          <circle
            className="mini-route-map-waypoint"
            cx={waypoint.x}
            cy={waypoint.y}
            r="4"
            key={`${waypoint.x}-${waypoint.y}-${index}`}
          />
        ))}
        <circle
          className="mini-route-map-start"
          cx={projection.start.x}
          cy={projection.start.y}
          r="3"
        />
        <circle
          className="mini-route-map-goal"
          cx={projection.goal.x}
          cy={projection.goal.y}
          r="3"
        />
        <circle
          className="mini-route-map-current"
          cx={projection.current.x}
          cy={projection.current.y}
          r="5"
        />
        {projection.labels.map((label, index) => (
          <text
            className="mini-route-map-label"
            x={label.x}
            y={label.y}
            dx="6"
            dy="-5"
            key={`${label.text}-${index}`}
          >
            {label.text}
          </text>
        ))}
      </svg>
    </aside>
  );
}

function projectRouteForMiniMap(
  route: Route,
  currentDistanceM: number,
  waypoints: RouteMapMarker[],
  startLabel?: string,
  goalLabel?: string
): {
  polyline: string;
  start: { x: number; y: number };
  goal: { x: number; y: number };
  current: { x: number; y: number };
  waypoints: Array<{ x: number; y: number }>;
  labels: Array<{ x: number; y: number; text: string }>;
} {
  const points = route.points.length > 0 ? route.points : [{ lat: 0, lng: 0 }];
  const centerLatitude =
    points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const longitudeScale = Math.cos((centerLatitude * Math.PI) / 180);
  const rawPoints = points.map((point) => ({
    x: point.lng * longitudeScale,
    y: -point.lat,
  }));
  const minX = Math.min(...rawPoints.map((point) => point.x));
  const maxX = Math.max(...rawPoints.map((point) => point.x));
  const minY = Math.min(...rawPoints.map((point) => point.y));
  const maxY = Math.max(...rawPoints.map((point) => point.y));
  const spanX = Math.max(maxX - minX, 0.000001);
  const spanY = Math.max(maxY - minY, 0.000001);
  const drawableWidth = MINI_MAP_WIDTH - MINI_MAP_PADDING * 2;
  const drawableHeight = MINI_MAP_HEIGHT - MINI_MAP_PADDING * 2;
  const scale = Math.min(drawableWidth / spanX, drawableHeight / spanY);
  const offsetX = (MINI_MAP_WIDTH - spanX * scale) / 2;
  const offsetY = (MINI_MAP_HEIGHT - spanY * scale) / 2;

  const project = (point: { lat: number; lng: number }) => ({
    x: (point.lng * longitudeScale - minX) * scale + offsetX,
    y: (-point.lat - minY) * scale + offsetY,
  });

  const projectedPoints = points.map(project);
  const start = projectedPoints[0];
  const goal = projectedPoints[projectedPoints.length - 1];
  const currentPoint = getPointAtDistance(route, currentDistanceM);
  const projectedWaypoints = waypoints.map((waypoint) => ({
    ...project(waypoint),
    label: waypoint.label,
  }));
  const labels = [
    startLabel ? { ...start, text: startLabel } : null,
    ...projectedWaypoints.map((waypoint) =>
      waypoint.label
        ? {
            x: waypoint.x,
            y: waypoint.y,
            text: waypoint.label,
          }
        : null
    ),
    goalLabel ? { ...goal, text: goalLabel } : null,
  ].filter((label): label is { x: number; y: number; text: string } =>
    Boolean(label)
  );

  return {
    polyline: projectedPoints
      .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
      .join(" "),
    start,
    goal,
    current: project(currentPoint),
    waypoints: projectedWaypoints,
    labels,
  };
}

type RouteCardProps = {
  routeId: string;
  defaultTitle: string;
  title: string;
  source: string;
  defaultDescription: string;
  description: string;
  editorValue: {
    routeId: string;
    title: string;
    description: string;
  } | null;
  onSelect: (routeId: string) => void;
  onPreview: (routeId: string) => void;
  onEditPoints: (routeId: string, title: string) => void;
  onDelete: (routeId: string) => void;
  onStartEdit: (
    routeId: string,
    currentTitle: string,
    currentDescription: string
  ) => void;
  onChangeEdit: (editor: { title: string; description: string }) => void;
  onSaveEdit: (
    routeId: string,
    defaultTitle: string,
    defaultDescription: string
  ) => void;
  onCancelEdit: () => void;
};

function RouteCard({
  routeId,
  defaultTitle,
  title,
  source,
  defaultDescription,
  description,
  editorValue,
  onSelect,
  onPreview,
  onEditPoints,
  onDelete,
  onStartEdit,
  onChangeEdit,
  onSaveEdit,
  onCancelEdit,
}: RouteCardProps) {
  const isEditing = editorValue !== null;

  return (
    <div className="route-option route-card">
      {isEditing ? (
        <div className="route-description-editor">
          <span className="route-option-source">{source}</span>
          <label>
            ルート名
            <input
              aria-label={`${title}のルート名`}
              value={editorValue.title}
              onChange={(event) =>
                onChangeEdit({
                  title: event.target.value,
                  description: editorValue.description,
                })
              }
            />
          </label>
          <label>
            説明
            <textarea
              aria-label={`${title}の説明`}
              value={editorValue.description}
              onChange={(event) =>
                onChangeEdit({
                  title: editorValue.title,
                  description: event.target.value,
                })
              }
              rows={4}
            />
          </label>
          <div className="route-description-editor-actions">
            <button
              type="button"
              onClick={() =>
                onSaveEdit(routeId, defaultTitle, defaultDescription)
              }
            >
              保存
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={onCancelEdit}
            >
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        <>
          <button className="route-card-main" onClick={() => onSelect(routeId)}>
            <span className="route-option-source">{source}</span>
            <strong>{title}</strong>
            <span>{description}</span>
          </button>
          <div className="route-card-actions">
            <button
              className="preview-route-button"
              aria-label={`${title}の地図を確認`}
              onClick={() => onPreview(routeId)}
            >
              地図
            </button>
            <button
              className="point-label-route-button"
              aria-label={`${title}の地点ラベルを編集`}
              onClick={() => onEditPoints(routeId, title)}
            >
              ルート編集
            </button>
            <button
              className="edit-route-button"
              aria-label={`${title}を編集`}
              onClick={() => onStartEdit(routeId, title, description)}
            >
              編集
            </button>
            <button
              className="delete-route-button"
              aria-label={`${title}を削除`}
              onClick={() => onDelete(routeId)}
            >
              削除
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type PointLabelEditorDialogProps = {
  editor: PointLabelEditorState;
  onSave: (values: RoutePointLabelValues) => void;
  onCancel: () => void;
};

function PointLabelEditorDialog({
  editor,
  onSave,
  onCancel,
}: PointLabelEditorDialogProps) {
  const submitPointLabels = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    onSave({
      startLabel: String(formData.get("startLabel") ?? ""),
      goalLabel: String(formData.get("goalLabel") ?? ""),
      waypointLabels: editor.waypointLabels.map((_, index) =>
        String(formData.get(`waypointLabel-${index}`) ?? "")
      ),
    });
  };

  return (
    <div
      className="point-label-editor-backdrop"
      role="presentation"
      onClick={onCancel}
    >
      <section
        className="point-label-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="point-label-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="point-label-editor-header">
          <div>
            <p className="route-selection-kicker">ROUTE POINT LABELS</p>
            <h2 id="point-label-editor-title">{editor.title}</h2>
          </div>
          <button type="button" onClick={onCancel}>
            閉じる
          </button>
        </div>

        <form className="point-label-editor-fields" onSubmit={submitPointLabels}>
          <label>
            出発地ラベル
            <input
              name="startLabel"
              aria-label={`${editor.title}の出発地ラベル`}
              defaultValue={editor.startLabel}
              placeholder="例: 大阪駅"
            />
          </label>
          <label>
            目的地ラベル
            <input
              name="goalLabel"
              aria-label={`${editor.title}の目的地ラベル`}
              defaultValue={editor.goalLabel}
              placeholder="例: 奈良駅"
            />
          </label>
          {editor.waypointLabels.length > 0 ? (
            editor.waypointLabels.map((label, index) => (
              <label key={index}>
                経由地{index + 1}ラベル
                <input
                  name={`waypointLabel-${index}`}
                  aria-label={`${editor.title}の経由地${index + 1}ラベル`}
                  defaultValue={label}
                  placeholder={`例: 経由地${index + 1}`}
                />
              </label>
            ))
          ) : (
            <p className="point-label-editor-note">
              このルートにはミニマップへ表示できる経由地座標がありません。
            </p>
          )}

          <div className="point-label-editor-actions">
            <button type="button" className="secondary-button" onClick={onCancel}>
              キャンセル
            </button>
            <button type="submit">保存</button>
          </div>
        </form>
      </section>
    </div>
  );
}

type RoutePreviewDialogProps = {
  route: Route | null;
  routeType: string;
  loading: boolean;
  error: string | null;
  onClose: () => void;
};

function RoutePreviewDialog({
  route,
  routeType,
  loading,
  error,
  onClose,
}: RoutePreviewDialogProps) {
  return (
    <div
      className="route-preview-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="route-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="route-preview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="route-preview-header">
          <div>
            <p className="route-selection-kicker">ROUTE PREVIEW</p>
            <h2 id="route-preview-title">
              {route ? route.name : "ルート地図確認"}
            </h2>
            {route && (
              <small>
                {routeType} ｜ {(totalDistance(route) / 1000).toFixed(2)} km
              </small>
            )}
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            閉じる
          </button>
        </div>

        {loading && <p className="route-preview-message">ルート読み込み中…</p>}
        {error && <p className="route-preview-error">{error}</p>}
        {route && !loading && !error && <RoutePreviewMap route={route} />}
      </section>
    </div>
  );
}

function RoutePreviewMap({ route }: { route: Route }) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    if (!API_KEY || !mapElementRef.current) return;

    let cancelled = false;
    let polyline: google.maps.Polyline | null = null;

    loadMapsApi(API_KEY)
      .then(async (googleApi) => {
        const { Map } = (await googleApi.maps.importLibrary(
          "maps"
        )) as google.maps.MapsLibrary;

        if (cancelled || !mapElementRef.current) return;

        const path = route.points.map((point) => ({
          lat: point.lat,
          lng: point.lng,
        }));
        const map = new Map(mapElementRef.current, {
          center: path[0] ?? { lat: 34.6937, lng: 135.5023 },
          zoom: 12,
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false,
        });

        polyline = new googleApi.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: "#2563eb",
          strokeOpacity: 0.95,
          strokeWeight: 5,
          map,
        });

        if (path.length > 1) {
          const bounds = new googleApi.maps.LatLngBounds();
          path.forEach((point) => bounds.extend(point));
          map.fitBounds(bounds);
        }
      })
      .catch((loadError) => {
        if (!cancelled) setMapError((loadError as Error).message);
      });

    return () => {
      cancelled = true;
      polyline?.setMap(null);
    };
  }, [route]);

  if (!API_KEY) {
    return (
      <p className="route-preview-message">
        地図確認には <code>VITE_GOOGLE_MAPS_API_KEY</code> が必要です。
      </p>
    );
  }

  return (
    <>
      <div ref={mapElementRef} className="route-preview-map" />
      {mapError && <p className="route-preview-error">{mapError}</p>}
    </>
  );
}
