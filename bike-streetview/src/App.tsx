import { useEffect, useRef, useState } from "react";
import "./App.css";
import type { Route, RoutePoint, SensorAdapter } from "./types";
import { totalDistance } from "./modules/routeLoader";
import { getPointAtDistance } from "./modules/routeSampler";
import { gradeFactor } from "./modules/grade";
import { KeyboardSensor } from "./modules/sensorKeyboard";
import { SerialSensor } from "./modules/sensorSerial";
import {
  loadMapsApi,
  StreetViewController,
  STREET_VIEW_INTERVAL,
} from "./modules/streetViewController";
import { loadRouteFromKmzUrl } from "./modules/kmzRouteLoader";
import { loadGoogleRoutesRoute } from "./modules/googleRoutesLoader";
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

export default function App() {
  const svRef = useRef<HTMLDivElement>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeType, setRouteType] = useState("ルート読込中");
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
  const [sensorMode, setSensorMode] = useState<"keyboard" | "serial">("keyboard");

  const distanceRef = useRef(0);
  const controllerRef = useRef<StreetViewController | null>(null);
  const sensorRef = useRef<SensorAdapter | null>(null);
  const serialRef = useRef<SerialSensor | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadGoogleRoutesRoute()
      .then((result) => {
        if (!cancelled) {
          setRoute(result.route);
          setRouteType(result.routeType);
        }
      })
      .catch(async (routesError: Error) => {
        try {
          const fallbackRoute = await loadRouteFromKmzUrl(routeKmzUrl);
          if (!cancelled) {
            setRoute(fallbackRoute);
            setRouteType("KMZルート");
          }
        } catch (kmzError) {
          if (!cancelled) {
            setRouteError(
              `${routesError.message} / ${(kmzError as Error).message}`
            );
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Street View 初期化（APIキーがある場合のみ）
  useEffect(() => {
    if (!API_KEY || !route) return;
    let cancelled = false;
    loadMapsApi(API_KEY)
      .then(() => {
        if (cancelled || !svRef.current) return;
        controllerRef.current = new StreetViewController(
          svRef.current,
          route.points[0]
        );
        setMapsReady(true);
      })
      .catch((e: Error) => setMapsError(e.message));
    return () => {
      cancelled = true;
      controllerRef.current = null;
    };
  }, [route]);

  // センサー＋走行ループ
  useEffect(() => {
    if (!route) return;
    const keyboard = new KeyboardSensor();
    keyboard.onReset = () => {
      distanceRef.current = 0;
      controllerRef.current?.reset(route.points[0]);
    };
    keyboard.start();
    sensorRef.current = keyboard;

    let rafId = 0;
    let lastT = performance.now();
    const loop = (t: number) => {
      const dt = Math.min((t - lastT) / 1000, 0.5);
      lastT = t;

      const sensor = sensorRef.current ?? keyboard;
      const p: RoutePoint = getPointAtDistance(route, distanceRef.current);
      const speed = sensor.getSpeedMps() * gradeFactor(p.grade);
      distanceRef.current = Math.min(
        distanceRef.current + speed * dt,
        totalDistance(route)
      );

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
      serialRef.current?.stop();
    };
  }, [route]);

  const connectSerial = async () => {
    try {
      const serial = new SerialSensor();
      await serial.start();
      serialRef.current = serial;
      sensorRef.current = serial;
      setSensorMode("serial");
    } catch (e) {
      alert((e as Error).message);
    }
  };

  if (!route) {
    return (
      <div className="app">
        <div className="placeholder">
          <h2>{routeError ? "ルート読み込み失敗" : "ルート生成中…"}</h2>
          {routeError && <p>{routeError}</p>}
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
          {sensorMode === "keyboard" ? "キーボード" : "ESP32"}
        </div>
        {mapsError && <div className="hud-row hud-error">{mapsError}</div>}
        {API_KEY && !mapsReady && !mapsError && (
          <div className="hud-row hud-sub">Street View 読み込み中…</div>
        )}
      </div>

      <div className="controls">
        <span>↑/↓: 速度 ｜ Space: 停止 ｜ R: リセット</span>
        {SerialSensor.isSupported() && sensorMode === "keyboard" && (
          <button onClick={connectSerial}>ESP32接続</button>
        )}
      </div>

      <div className="route-name">{route.name}</div>
    </div>
  );
}
