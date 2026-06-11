import type { RoutePoint } from "../types";

/** Street View更新間隔 [m]（100m標準＝Dynamic Street View無料枠運用。仕様書 6.3 / 7章） */
export const STREET_VIEW_INTERVAL = 100;

let mapsApiPromise: Promise<typeof google> | null = null;

/** Maps JavaScript API を動的ロードする */
export function loadMapsApi(apiKey: string): Promise<typeof google> {
  if (mapsApiPromise) return mapsApiPromise;
  mapsApiPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey
    )}&v=weekly`;
    script.async = true;
    script.onload = () => resolve(google);
    script.onerror = () => reject(new Error("Maps JavaScript APIのロードに失敗しました"));
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
  private lastUpdateDistance = 0;
  /** 更新回数（API料金の目安として HUD に表示） */
  panoUpdateCount = 0;

  constructor(container: HTMLElement, start: RoutePoint) {
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
    void this.moveTo(point);
    return true;
  }

  /** パノラマ未対応地点は半径50mで近傍探索し、なければスキップ */
  private async moveTo(point: RoutePoint): Promise<void> {
    try {
      const { data } = await this.svService.getPanorama({
        location: { lat: point.lat, lng: point.lng },
        radius: 50,
        source: google.maps.StreetViewSource.OUTDOOR,
      });
      if (data.location?.latLng) {
        this.panorama.setPosition(data.location.latLng);
        this.panorama.setPov({ heading: point.heading, pitch: 0 });
        this.panoUpdateCount++;
      }
    } catch {
      // パノラマなし: 今回はスキップして次の更新地点を待つ（仕様書 10章）
    }
  }

  reset(start: RoutePoint): void {
    this.lastUpdateDistance = 0;
    this.panorama.setPosition({ lat: start.lat, lng: start.lng });
    this.panorama.setPov({ heading: start.heading, pitch: 0 });
  }
}
