import { useEffect, useRef, useState } from "react";
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
import { loadGoogleRoutesRoute } from "./modules/googleRoutesLoader";
import {
  clearRouteProgress,
  loadRouteProgress,
  saveRouteProgress,
} from "./modules/routeProgress";
import routeKmzUrl from "../routes/sources/osaka-kyoto-yodogawa.kmz?url";

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

type Hud = {
  speedKmh: number;
  rpm: number;
  distanceM: number;
  elevation: number;
  grade: number;
  panoCount: number;
};

type SensorMode = "keyboard" | "virtual" | "serial";

type RouteId =
  | "osaka-kyoto"
  | "shin-osaka-nara"
  | "esaka-minoh-kayano";

const ROUTE_OPTIONS: Array<{
  id: RouteId;
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

export default function App() {
  const svRef = useRef<HTMLDivElement>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<RouteId | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
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
  const [sensorMode, setSensorMode] = useState<SensorMode>("keyboard");
  const [virtualTargetRpm, setVirtualTargetRpm] = useState(0);
  const [virtualConnected, setVirtualConnected] = useState(true);

  const distanceRef = useRef(0);
  const controllerRef = useRef<StreetViewController | null>(null);
  const sensorRef = useRef<SensorAdapter | null>(null);
  const serialRef = useRef<SerialSensor | null>(null);
  const virtualRef = useRef<VirtualEsp32Sensor | null>(null);
  const keyboardRef = useRef<KeyboardSensor | null>(null);

  useEffect(() => {
    if (!selectedRouteId) return;

    let cancelled = false;

    const routeRequest =
      selectedRouteId === "osaka-kyoto"
        ? loadRouteFromKmzUrl(routeKmzUrl).then((loadedRoute) => ({
            route: loadedRoute,
            routeType: "KMZルート",
          }))
        : loadGoogleRoutesRoute(selectedRouteId);

    routeRequest
      .then((result) => {
        if (!cancelled) {
          const savedDistance = Math.min(
            loadRouteProgress(selectedRouteId),
            totalDistance(result.route)
          );
          distanceRef.current = savedDistance;
          setRoute(result.route);
          setRouteType(result.routeType);
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
  }, [selectedRouteId]);

  // Street View 初期化（APIキーがある場合のみ）
  useEffect(() => {
    if (!API_KEY || !route || !selectedRouteId) return;
    let cancelled = false;
    loadMapsApi(API_KEY)
      .then(() => {
        if (cancelled || !svRef.current) return;
        const startDistance = distanceRef.current;
        const startPoint = getPointAtDistance(route, startDistance);
        controllerRef.current = new StreetViewController(
          svRef.current,
          startPoint,
          startDistance,
          (savedDistance) => {
            saveRouteProgress(selectedRouteId, savedDistance);
          }
        );
        setMapsReady(true);
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
      distanceRef.current = 0;
      if (selectedRouteId) clearRouteProgress(selectedRouteId);
      controllerRef.current?.reset(route.points[0]);
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

  const selectRoute = (routeId: RouteId) => {
    setRoute(null);
    setRouteError(null);
    setRouteLoading(true);
    setMapsReady(false);
    setMapsError(null);
    setRouteType("");
    distanceRef.current = 0;
    setSelectedRouteId(routeId);
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
    setRouteLoading(false);
    setRouteError(null);
    setRouteType("");
    setSelectedRouteId(null);
    setSensorMode("keyboard");
    setVirtualTargetRpm(0);
    setVirtualConnected(true);
  };

  if (!selectedRouteId) {
    return (
      <div className="route-selection">
        <div className="route-selection-panel">
          <p className="route-selection-kicker">BIKE STREET VIEW</p>
          <h1>走行するルートを選択</h1>
          <div className="route-options">
            {ROUTE_OPTIONS.map((option) => (
              <button
                className="route-option"
                key={option.id}
                onClick={() => selectRoute(option.id)}
              >
                <span className="route-option-source">{option.source}</span>
                <strong>{option.title}</strong>
                <span>{option.description}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!route || routeLoading) {
    return (
      <div className="app">
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

  return (
    <div className="app">
      {API_KEY ? (
        <div ref={svRef} className="streetview" />
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
        <div className="hud-row hud-speed">
          {hud.speedKmh.toFixed(1)} <span>km/h</span>
        </div>
        <div className="hud-row">
          距離 {(hud.distanceM / 1000).toFixed(2)} km /{" "}
          {(totalDistance(route) / 1000).toFixed(1)} km
        </div>
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
        <span>↑/↓: 速度 ｜ Space: 停止 ｜ R: リセット</span>
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
    </div>
  );
}
