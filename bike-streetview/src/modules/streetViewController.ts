import type { RoutePoint } from "../types";

/** Street View更新間隔 [m]（100m標準＝Dynamic Street View無料枠運用。仕様書 6.3 / 7章） */
export const STREET_VIEW_INTERVAL = 100;
const STREET_VIEW_SEARCH_RADII_METERS = [50, 150, 300];

type StreetViewCandidate = {
  distance: number;
  point: RoutePoint;
};

type PanoramaChangedOptions = {
  syncDistance?: boolean;
};

let mapsApiPromise: Promise<typeof google> | null = null;
const MAPS_CALLBACK_NAME = "__bikeStreetViewMapsReady";

type MapsWindow = Window &
  typeof globalThis & {
    [MAPS_CALLBACK_NAME]?: () => void;
  };

/** Maps JavaScript API を動的ロードする */
export function loadMapsApi(apiKey: string): Promise<typeof google> {
  if (window.google?.maps?.StreetViewPanorama) {
    return Promise.resolve(window.google);
  }
  if (mapsApiPromise) return mapsApiPromise;

  mapsApiPromise = new Promise((resolve, reject) => {
    const mapsWindow = window as MapsWindow;
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey
    )}&v=weekly&loading=async&callback=${MAPS_CALLBACK_NAME}`;
    script.async = true;
    mapsWindow[MAPS_CALLBACK_NAME] = () => {
      delete mapsWindow[MAPS_CALLBACK_NAME];
      resolve(window.google);
    };
    script.onerror = () => {
      delete mapsWindow[MAPS_CALLBACK_NAME];
      mapsApiPromise = null;
      reject(new Error("Maps JavaScript APIのロードに失敗しました"));
    };
    document.head.appendChild(script);
  });
  return mapsApiPromise;
}

/**
 * StreetViewPanorama のラッパー。
 * 100mごとの位置更新と、パノラマ未対応地点の近傍探索を担当する。
 */
export class StreetViewController {
  private panorama: google.maps.StreetViewPanorama;
  private svService: google.maps.StreetViewService;
  private lastUpdateDistance: number;
  private onPanoramaChanged?: (
    distance: number,
    position: google.maps.LatLngLiteral,
    options?: PanoramaChangedOptions
  ) => void;
  private generation = 0;
  /** 更新回数（API料金の目安として HUD に表示） */
  panoUpdateCount = 0;
  /** 初期表示用のStreet View探索が完了したか */
  ready: Promise<boolean>;

  constructor(
    container: HTMLElement,
    start: RoutePoint,
    initialDistance = 0,
    onPanoramaChanged?: (
      distance: number,
      position: google.maps.LatLngLiteral,
      options?: PanoramaChangedOptions
    ) => void,
    initialSearchCandidates: StreetViewCandidate[] = []
  ) {
    this.panorama = new google.maps.StreetViewPanorama(container, {
      position: { lat: start.lat, lng: start.lng },
      pov: { heading: start.heading, pitch: 0 },
      addressControl: false,
      linksControl: false,
      panControl: false,
      zoomControl: false,
      fullscreenControl: false,
      motionTracking: false,
      showRoadLabels: false,
    });
    this.svService = new google.maps.StreetViewService();
    this.lastUpdateDistance = initialDistance;
    this.onPanoramaChanged = onPanoramaChanged;
    this.ready = this.moveToFirstAvailable(
      [{ distance: initialDistance, point: start }, ...initialSearchCandidates],
      this.generation,
      { syncDistance: true }
    );
  }

  /**
   * 累積距離が前回更新から STREET_VIEW_INTERVAL 以上進んでいたらパノラマを更新する。
   * @returns 更新した場合 true
   */
  maybeUpdate(totalDistanceMeters: number, point: RoutePoint): boolean {
    if (totalDistanceMeters - this.lastUpdateDistance < STREET_VIEW_INTERVAL) {
      return false;
    }
    this.lastUpdateDistance = totalDistanceMeters;
    void this.moveTo(totalDistanceMeters, point, this.generation);
    return true;
  }

  private async moveToFirstAvailable(
    candidates: StreetViewCandidate[],
    generation: number,
    options: PanoramaChangedOptions = {}
  ): Promise<boolean> {
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const key = candidate.distance.toFixed(1);
      if (seen.has(key)) continue;
      seen.add(key);

      const found = await this.moveTo(
        candidate.distance,
        candidate.point,
        generation,
        options
      );
      if (found) return true;
      if (generation !== this.generation) return false;
    }

    return false;
  }

  /** パノラマ未対応地点は段階的に近傍探索し、なければスキップ */
  private async moveTo(
    distance: number,
    point: RoutePoint,
    generation: number,
    options: PanoramaChangedOptions = {}
  ): Promise<boolean> {
    for (const radius of STREET_VIEW_SEARCH_RADII_METERS) {
      try {
        const { data } = await this.svService.getPanorama({
          location: { lat: point.lat, lng: point.lng },
          radius,
          source: google.maps.StreetViewSource.OUTDOOR,
        });

        if (generation !== this.generation) return false;
        if (!data.location?.latLng) continue;

        this.panorama.setPosition(data.location.latLng);
        this.panorama.setPov({ heading: point.heading, pitch: 0 });
        this.panoUpdateCount++;
        this.onPanoramaChanged?.(distance, {
          lat: data.location.latLng.lat(),
          lng: data.location.latLng.lng(),
        }, options);
        return true;
      } catch {
        // パノラマなし: 半径を広げて再探索する
      }
    }

    return false;
  }

  reset(start: RoutePoint): void {
    this.generation++;
    this.lastUpdateDistance = 0;
    this.panorama.setPosition({ lat: start.lat, lng: start.lng });
    this.panorama.setPov({ heading: start.heading, pitch: 0 });
    void this.moveTo(0, start, this.generation, { syncDistance: true });
  }

  destroy(): void {
    this.generation++;
    this.panorama.setVisible(false);
  }
}
