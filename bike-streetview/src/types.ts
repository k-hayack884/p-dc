/** ルート上の1サンプル点（仕様書 5章） */
export type RoutePoint = {
  lat: number;
  lng: number;
  /** スタートからの累積距離 [m] */
  distance: number;
  /** 標高 [m] */
  elevation: number;
  /** 区間勾配 [%] */
  grade: number;
  /** 進行方向 [degree] */
  heading: number;
};

export type Route = {
  name: string;
  /** サンプリング間隔 [m] */
  intervalMeters: number;
  points: RoutePoint[];
};

/** センサー入力を共通形式に変換するアダプタ（キーボード / シリアル / BLE） */
export interface SensorAdapter {
  start(): Promise<void> | void;
  stop(): void;
  /** 現在の速度 [m/s]（勾配補正前） */
  getSpeedMps(): number;
  /** 表示用RPM（キーボード入力時は換算値） */
  getRpm(): number;
}
