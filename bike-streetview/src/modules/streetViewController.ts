import type { Route } from "../types";
import { getPointAtDistance } from "./routeSampler";
import { totalDistance } from "./routeLoader";

/**
 * リンク追従（ハイブリッド）方式の定数。
 * Dynamic Street Viewの課金は「パノラマオブジェクトのインスタンス化」単位のため、
 * 単一インスタンスを維持して setPano / setPosition で移動する限り追加課金は発生しない。
 * StreetViewService によるメタデータ取得（pano ID / 位置指定）も無課金。
 */
/** 曲がり角付近: ターゲットがこの距離以上先に進んだら次のパノラマへ進む [m] */
export const FINE_STEP_TRIGGER_METERS = 5;
/** 直線区間: この距離たまったらリンク鎖をまとめて移動する [m]（遷移回数の削減） */
export const COARSE_STEP_TRIGGER_METERS = 35;
/** 1回のまとめ移動で進む最大距離 [m] */
const COARSE_HOP_MAX_METERS = 45;
/** 1回のまとめ移動で辿る最大パノラマ数 */
const MAX_TRAVERSE_PANOS = 10;
/** この距離先までにルート方位が大きく変わるなら「曲がり角付近」とみなす [m] */
const TURN_SCAN_AHEAD_METERS = 25;
/** 曲がり角とみなすルート方位変化 [deg] */
const TURN_HEADING_THRESHOLD_DEGREES = 30;
/** リンク選択時にルート上の先読み点を置く距離の下限・上限 [m] */
const LINK_LOOKAHEAD_MIN_METERS = 10;
const LINK_LOOKAHEAD_MAX_METERS = 30;
/** 進行方向とリンク方向の許容角度差 [deg]。超えたらリンク追従を諦めて再同期 */
const LINK_MAX_HEADING_DELTA_DEGREES = 60;
/**
 * リンク先パノラマがルートからこの距離以上離れていたら採用しない [m]。
 * 車道撮影のパノラマはルート線から数m以内。建物内・中庭・遊歩道の
 * パノラマは10m超ずれることが多いため、厳しめに切る
 */
const STEP_OFF_ROUTE_METERS = 8;
/** 再同期先パノラマのルートからの許容ずれ [m] */
const RESYNC_OFF_ROUTE_METERS = 12;
/** 移動前の旋回を行う視線と進行方向の角度差 [deg] */
const TURN_BEFORE_MOVE_DEGREES = 25;
/** 移動前の旋回待ち時間 [ms] */
const TURN_BEFORE_MOVE_WAIT_MS = 400;
/**
 * 公式（Google撮影車）パノラマの著作権表示パターン。
 * ユーザー投稿パノラマ（© 投稿者名）は建物内・遊歩道・私有地が多いため辿らない
 */
const OFFICIAL_PANO_COPYRIGHT_PATTERN = /google/i;
/**
 * 投稿パノラマ特有のIDプレフィックス。
 * ユーザー投稿・ビジネスビュー（店内等）のパノラマIDはAF1Qip等で始まる。
 * 著作権表示が取れない場合でもIDで確実に除外する
 */
const CONTRIBUTED_PANO_ID_PATTERN = /^(AF1Qip|CAoS|CIHM)/;
/** 実際の移動方位（現在地→リンク先）と進行方向の許容角度差 [deg]（横ステップ防止） */
const STEP_MAX_MOVE_BEARING_DELTA_DEGREES = 50;
/** 1ステップの最大移動距離 [m]（異常なワープ防止） */
const STEP_MAX_LENGTH_METERS = 35;
/**
 * 曲がり角付近の1ステップ最大移動距離 [m]。
 * 交差点中央のパノラマを飛ばした対角線移動（角の建物貫通）を防ぐ
 */
const TURN_STEP_MAX_LENGTH_METERS = 18;
/** 1ステップで検証するリンク候補の最大数 */
const MAX_LINK_CANDIDATES_PER_STEP = 3;
/**
 * 屋外検証の探索半径 [m]。
 * 候補パノラマの位置をOUTDOORソースで検索し、自分自身が返ってこなければ
 * 屋内・地下（地下街・駅構内など）のパノラマとみなして棄却する
 */
const OUTDOOR_VERIFY_RADIUS_METERS = 10;
/** リンク先が最低これだけ前進していなければ採用しない [m]（後退・振動防止） */
const MIN_FORWARD_PROGRESS_METERS = 2;
/** 1回のadvanceで行う表示更新の最大回数（フレーム間の暴走防止） */
const MAX_STEPS_PER_ADVANCE = 3;
/** setPano後のリンク更新待ちタイムアウト [ms] */
const PANO_CHANGE_TIMEOUT_MS = 3000;
/** 視線方向の補間時間 [ms] */
const HEADING_TWEEN_MS = 600;
/** 再同期失敗後、次に再同期を試すまでに必要な走行距離 [m] */
const RESYNC_RETRY_DISTANCE_METERS = 25;
/** 再同期時の近傍探索半径 [m] */
const RESYNC_SEARCH_RADII_METERS = [25, 50];
/** 初期表示時の近傍探索半径 [m] */
const STREET_VIEW_INITIAL_SEARCH_RADII_METERS = [50, 150, 300];
/** 初期表示時にルート沿いへずらして探索するオフセット [m] */
const STREET_VIEW_INITIAL_SEARCH_OFFSETS_METERS = [
  0, 100, -100, 200, -200, 300, -300, 500, -500, 800, -800, 1000, -1000, 1500,
  -1500, 2000, -2000,
];
/** ルート投影時の探索窓 [m] */
const PROJECTION_WINDOW_METERS = 200;

const METERS_PER_DEGREE_LAT = 111_320;

type PanoramaChangedOptions = {
  /** 初期表示・リセット時: アプリ側の走行距離をこの値へ同期する */
  syncDistance?: boolean;
  /** パノラマのインスタンス化（Dynamic Street View課金対象）が発生した */
  billed?: boolean;
};

type PanoramaChangedCallback = (
  distance: number,
  position: google.maps.LatLngLiteral,
  options?: PanoramaChangedOptions
) => void;

type PanoMetadata = {
  position: google.maps.LatLngLiteral;
  links: google.maps.StreetViewLink[];
  copyright?: string;
};

/**
 * 移動の見せ方。
 * - smooth: 隣のパノラマへ1枚ずつsetPanoし、Street View標準の移動アニメーションを見せる（移動感重視）
 * - hop: リンク鎖をまとめて移動し、遷移回数を減らす（酔いにくさ重視・カット表示）
 */
export type StreetViewMotionMode = "smooth" | "hop";

function normalizeHeading(heading: number): number {
  return ((heading % 360) + 360) % 360;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headingDelta(a: number, b: number): number {
  const delta = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return Math.min(delta, 360 - delta);
}

/**
 * 公式（Google撮影）パノラマか。
 * 投稿パノラマはID形式と著作権表示の両方で判定して確実に除外する
 */
function isOfficialPano(
  panoId: string | undefined,
  copyright: string | undefined
): boolean {
  if (panoId && CONTRIBUTED_PANO_ID_PATTERN.test(panoId)) return false;
  return !copyright || OFFICIAL_PANO_COPYRIGHT_PATTERN.test(copyright);
}

/** 2点間の距離 [m]（等距円筒近似・近距離用） */
function distanceBetweenMeters(
  from: google.maps.LatLngLiteral,
  to: google.maps.LatLngLiteral
): number {
  const latScale = Math.cos((from.lat * Math.PI) / 180);
  const dx = (to.lng - from.lng) * METERS_PER_DEGREE_LAT * latScale;
  const dy = (to.lat - from.lat) * METERS_PER_DEGREE_LAT;
  return Math.hypot(dx, dy);
}

/** 2点間の方位角 [deg]（等距円筒近似・近距離用） */
function bearingBetween(
  from: google.maps.LatLngLiteral,
  to: google.maps.LatLngLiteral
): number {
  const latScale = Math.cos((from.lat * Math.PI) / 180);
  const dx = (to.lng - from.lng) * METERS_PER_DEGREE_LAT * latScale;
  const dy = (to.lat - from.lat) * METERS_PER_DEGREE_LAT;
  return normalizeHeading((Math.atan2(dx, dy) * 180) / Math.PI);
}

type RouteProjection = {
  /** 投影点のルート累積距離 [m] */
  distanceM: number;
  /** ルート線までの垂直距離 [m] */
  offsetM: number;
};

/**
 * 位置をルート線上へ投影し、累積距離とルートからのずれを返す。
 * aroundDistanceM 前後 PROJECTION_WINDOW_METERS の区間だけを探索する。
 */
export function projectOntoRoute(
  route: Route,
  position: google.maps.LatLngLiteral,
  aroundDistanceM: number,
  windowM = PROJECTION_WINDOW_METERS
): RouteProjection {
  const points = route.points;
  const latScale = Math.cos((position.lat * Math.PI) / 180);
  const toLocal = (p: { lat: number; lng: number }) => ({
    x: (p.lng - position.lng) * METERS_PER_DEGREE_LAT * latScale,
    y: (p.lat - position.lat) * METERS_PER_DEGREE_LAT,
  });

  let best: RouteProjection = {
    distanceM: aroundDistanceM,
    offsetM: Number.POSITIVE_INFINITY,
  };

  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (b.distance < aroundDistanceM - windowM) continue;
    if (a.distance > aroundDistanceM + windowM) break;

    const pa = toLocal(a);
    const pb = toLocal(b);
    const abX = pb.x - pa.x;
    const abY = pb.y - pa.y;
    const lengthSq = abX * abX + abY * abY;
    const t =
      lengthSq > 0
        ? Math.min(Math.max(-(pa.x * abX + pa.y * abY) / lengthSq, 0), 1)
        : 0;
    const projX = pa.x + abX * t;
    const projY = pa.y + abY * t;
    const offset = Math.hypot(projX, projY);

    if (offset < best.offsetM) {
      best = {
        distanceM: a.distance + (b.distance - a.distance) * t,
        offsetM: offset,
      };
    }
  }

  return best;
}

/** 指定距離から先読み範囲内にルート方位の大きな変化（曲がり角）があるか */
export function isNearTurn(
  route: Route,
  fromDistanceM: number,
  scanAheadM = TURN_SCAN_AHEAD_METERS,
  thresholdDegrees = TURN_HEADING_THRESHOLD_DEGREES
): boolean {
  const baseHeading = getPointAtDistance(route, fromDistanceM).heading;
  const routeDistance = totalDistance(route);

  // ルート点は50m間隔で方位がなまるため、補間した方位も含めて確認する
  for (const aheadM of [scanAheadM / 2, scanAheadM]) {
    const sampleDistance = Math.min(fromDistanceM + aheadM, routeDistance);
    const sampleHeading = getPointAtDistance(route, sampleDistance).heading;
    if (headingDelta(sampleHeading, baseHeading) >= thresholdDegrees) {
      return true;
    }
  }

  for (const point of route.points) {
    if (point.distance <= fromDistanceM) continue;
    if (point.distance > fromDistanceM + scanAheadM) break;
    if (headingDelta(point.heading, baseHeading) >= thresholdDegrees) {
      return true;
    }
  }

  return false;
}

function closestRoadHeading(
  links: google.maps.StreetViewLink[] | undefined,
  routeHeading: number
): number {
  const headings = (links ?? [])
    .map((link) => link?.heading)
    .filter((heading): heading is number => typeof heading === "number");

  if (headings.length === 0) {
    return normalizeHeading(routeHeading);
  }

  return headings
    .flatMap((heading) => [heading, heading + 180])
    .map((heading) => ({
      heading: normalizeHeading(heading),
      delta: headingDelta(heading, routeHeading),
    }))
    .sort((a, b) => a.delta - b.delta)[0].heading;
}

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
 * StreetViewPanorama のラッパー（リンク追従・ハイブリッド方式）。
 *
 * 単一のパノラマインスタンスを維持し、走行距離に合わせてパノラマリンクを
 * setPano で進める。直線区間は約35mぶんのリンク鎖をメタデータ検証済みで
 * まとめて移動し（遷移回数削減）、曲がり角の約25m手前からは1枚ずつ辿って
 * 自然に曲がる。リンク先はメタデータ（無課金）で事前検証し、
 * ルートから20m超ずれる・前進しないパノラマは表示前に棄却する。
 * setPano / setPosition は追加課金なし（課金はインスタンス化時のみ）。
 */
export class StreetViewController {
  private route: Route;
  private panorama: google.maps.StreetViewPanorama;
  private svService: google.maps.StreetViewService;
  private onPanoramaChanged?: PanoramaChangedCallback;
  private targetDistance: number;
  private panoDistance: number;
  private advancing = false;
  private generation = 0;
  private headingAnimation: number | null = null;
  private resyncBlockedUntilDistance = Number.NEGATIVE_INFINITY;
  private metadataCache = new Map<string, PanoMetadata | null>();
  private outdoorVerifyCache = new Map<string, boolean>();
  private motionMode: StreetViewMotionMode = "smooth";
  /** 表示パノラマの移動回数（追加課金なし・HUD表示用） */
  panoStepCount = 0;
  /** パノラマのインスタンス化回数（Dynamic Street View課金対象） */
  panoBillingCount = 0;
  /** 初期表示用のStreet View探索が完了したか */
  ready: Promise<boolean>;

  constructor(
    container: HTMLElement,
    route: Route,
    initialDistance = 0,
    onPanoramaChanged?: PanoramaChangedCallback
  ) {
    const start = getPointAtDistance(route, initialDistance);
    this.route = route;
    this.targetDistance = initialDistance;
    this.panoDistance = initialDistance;
    this.onPanoramaChanged = onPanoramaChanged;
    this.panorama = new google.maps.StreetViewPanorama(container, {
      position: { lat: start.lat, lng: start.lng },
      pov: { heading: normalizeHeading(start.heading), pitch: 0 },
      addressControl: false,
      linksControl: false,
      panControl: false,
      zoomControl: false,
      fullscreenControl: false,
      motionTracking: false,
      showRoadLabels: false,
    });
    this.panoBillingCount = 1;
    this.svService = new google.maps.StreetViewService();
    this.ready = this.initialize(initialDistance, this.generation);
  }

  private async initialize(
    initialDistance: number,
    generation: number
  ): Promise<boolean> {
    const routeDistance = totalDistance(this.route);

    for (const offset of STREET_VIEW_INITIAL_SEARCH_OFFSETS_METERS) {
      const candidateDistance = initialDistance + offset;
      if (candidateDistance < 0 || candidateDistance > routeDistance) continue;
      if (generation !== this.generation) return false;

      const found = await this.resyncToRoute(
        candidateDistance,
        STREET_VIEW_INITIAL_SEARCH_RADII_METERS,
        generation,
        { syncDistance: true, billed: true },
        { strict: false }
      );
      if (found) return true;
    }

    return false;
  }

  /** 移動の見せ方を切り替える（走行中に変更可） */
  setMotionMode(mode: StreetViewMotionMode): void {
    this.motionMode = mode;
  }

  /**
   * 走行ループから毎フレーム呼び、ライダーの現在累積距離を伝える。
   * smooth: 常に1枚ずつ／hop: 直線はまとめて、曲がり角付近のみ1枚ずつ。
   */
  setTarget(distanceM: number): void {
    this.targetDistance = Math.min(
      Math.max(distanceM, 0),
      totalDistance(this.route)
    );
    void this.advance();
  }

  private async advance(): Promise<void> {
    if (this.advancing) return;
    this.advancing = true;
    const generation = this.generation;

    try {
      await this.ready;

      let steps = 0;
      while (generation === this.generation && steps < MAX_STEPS_PER_ADVANCE) {
        const trigger =
          this.motionMode === "smooth" ||
          isNearTurn(this.route, this.panoDistance)
            ? FINE_STEP_TRIGGER_METERS
            : COARSE_STEP_TRIGGER_METERS;
        if (this.targetDistance - this.panoDistance < trigger) return;

        const stepped = await this.hopAlongLinks(generation);
        if (generation !== this.generation) return;

        if (!stepped) {
          if (this.targetDistance < this.resyncBlockedUntilDistance) return;
          const resynced = await this.resyncToRoute(
            this.targetDistance,
            RESYNC_SEARCH_RADII_METERS,
            generation,
            {},
            { strict: true }
          );
          if (!resynced) {
            // パノラマ空白地帯など: 一定距離進むまで再探索を控える
            this.resyncBlockedUntilDistance =
              this.targetDistance + RESYNC_RETRY_DISTANCE_METERS;
          }
          return;
        }
        steps += 1;
      }
    } finally {
      this.advancing = false;
    }
  }

  /**
   * パノラマリンクをメタデータで事前検証しながら辿り、まとめて1回表示を更新する。
   * 曲がり角付近では1枚だけ進む。表示前に検証するため、後退や
   * ルート外（公園・私道など）への迷い込みは画面に出ない。
   */
  private async hopAlongLinks(generation: number): Promise<boolean> {
    const position = this.panorama.getPosition?.();
    let links = this.panorama.getLinks?.() ?? [];
    if (!position || links.length === 0) return false;

    const startDistance = this.panoDistance;
    let currentPosition: google.maps.LatLngLiteral = {
      lat: position.lat(),
      lng: position.lng(),
    };
    let currentDistance = startDistance;
    let candidate: { pano: string; heading: number } | null = null;
    const fineMode =
      this.motionMode === "smooth" || isNearTurn(this.route, startDistance);

    for (let index = 0; index < MAX_TRAVERSE_PANOS; index += 1) {
      if (generation !== this.generation) return false;

      const gap = this.targetDistance - currentDistance;
      if (gap <= 0) break;
      const lookahead = Math.min(
        Math.max(gap, LINK_LOOKAHEAD_MIN_METERS),
        LINK_LOOKAHEAD_MAX_METERS
      );
      const aheadPoint = getPointAtDistance(
        this.route,
        currentDistance + lookahead
      );
      const desiredHeading = bearingBetween(currentPosition, {
        lat: aheadPoint.lat,
        lng: aheadPoint.lng,
      });

      // 進行方向に近い順のリンク候補（許容角度内のみ）
      const linkCandidates = links
        .filter(
          (link): link is google.maps.StreetViewLink & {
            pano: string;
            heading: number;
          } => Boolean(link?.pano) && typeof link?.heading === "number"
        )
        .map((link) => ({
          pano: link.pano,
          heading: link.heading,
          delta: headingDelta(link.heading, desiredHeading),
        }))
        .filter((link) => link.delta <= LINK_MAX_HEADING_DELTA_DEGREES)
        .sort((a, b) => a.delta - b.delta)
        .slice(0, MAX_LINK_CANDIDATES_PER_STEP);

      let accepted: {
        pano: string;
        heading: number;
        metadata: PanoMetadata;
        projection: RouteProjection;
      } | null = null;

      for (const link of linkCandidates) {
        const metadata = await this.getPanoMetadata(link.pano);
        if (generation !== this.generation) return false;
        if (!metadata) continue;

        // 表示前検証（すべて満たしたリンクだけ採用する）:
        // 1. 公式パノラマ（投稿画像は建物内・遊歩道が多い）
        if (!isOfficialPano(link.pano, metadata.copyright)) continue;
        // 2. 実際の移動方位が進行方向に沿っている（横ステップ防止）
        const moveBearing = bearingBetween(currentPosition, metadata.position);
        if (
          headingDelta(moveBearing, desiredHeading) >
          STEP_MAX_MOVE_BEARING_DELTA_DEGREES
        ) {
          continue;
        }
        // 3. 移動距離が異常でない（曲がり角付近は交差点パノラマを飛ばさない）
        const maxStepLength = fineMode
          ? TURN_STEP_MAX_LENGTH_METERS
          : STEP_MAX_LENGTH_METERS;
        if (
          distanceBetweenMeters(currentPosition, metadata.position) >
          maxStepLength
        ) {
          continue;
        }
        // 4. ルート線から離れない・後退や停滞をしない
        const projection = projectOntoRoute(
          this.route,
          metadata.position,
          currentDistance
        );
        if (projection.offsetM > STEP_OFF_ROUTE_METERS) continue;
        if (
          projection.distanceM <
          currentDistance + MIN_FORWARD_PROGRESS_METERS
        ) {
          continue;
        }
        // 5. 屋外パノラマである（地下街・駅構内への潜り込み防止）
        const outdoor = await this.isOutdoorPano(link.pano, metadata.position);
        if (generation !== this.generation) return false;
        if (!outdoor) continue;

        accepted = {
          pano: link.pano,
          heading: link.heading,
          metadata,
          projection,
        };
        break;
      }

      if (!accepted) break;

      candidate = { pano: accepted.pano, heading: accepted.heading };
      currentPosition = accepted.metadata.position;
      currentDistance = accepted.projection.distanceM;
      links = accepted.metadata.links;

      if (fineMode) break; // 曲がり角付近: 1枚ずつ表示する
      if (currentDistance >= this.targetDistance) break;
      if (currentDistance - startDistance >= COARSE_HOP_MAX_METERS) break;
      if (isNearTurn(this.route, currentDistance)) break; // 曲がり角に差し掛かったら一旦表示
    }

    if (!candidate) return false;

    // 曲がってから進む: 視線が進行方向から大きくずれている場合は
    // 先に旋回してから移動し、横滑りに見える遷移を防ぐ
    const pov = this.panorama.getPov?.();
    const povDelta =
      typeof pov?.heading === "number"
        ? headingDelta(pov.heading, candidate.heading)
        : 0;
    if (povDelta > TURN_BEFORE_MOVE_DEGREES) {
      this.tweenHeading(candidate.heading);
      await sleep(TURN_BEFORE_MOVE_WAIT_MS);
      if (generation !== this.generation) return false;
    }

    const moved = await this.setPanoAndWait(candidate.pano);
    if (!moved || generation !== this.generation) return false;

    this.panoDistance = currentDistance;
    this.panoStepCount += 1;
    this.tweenHeading(candidate.heading);
    this.onPanoramaChanged?.(this.panoDistance, currentPosition, {});
    return true;
  }

  /**
   * 候補パノラマが屋外かを検証する（無課金・キャッシュあり）。
   * 候補の位置をOUTDOORソースで検索し、自分自身が最寄りとして返って
   * くれば屋外。地下街・駅構内などの屋内パノラマはOUTDOOR検索に
   * 現れないため、別のパノラマが返り false になる。
   */
  private async isOutdoorPano(
    panoId: string,
    position: google.maps.LatLngLiteral
  ): Promise<boolean> {
    const cached = this.outdoorVerifyCache.get(panoId);
    if (cached !== undefined) return cached;

    let outdoor = false;
    try {
      const { data } = await this.svService.getPanorama({
        location: position,
        radius: OUTDOOR_VERIFY_RADIUS_METERS,
        source: google.maps.StreetViewSource.OUTDOOR,
      });
      outdoor = data.location?.pano === panoId;
    } catch {
      outdoor = false;
    }

    this.outdoorVerifyCache.set(panoId, outdoor);
    return outdoor;
  }

  /** パノラマIDのメタデータ（位置・リンク）を無課金で取得しキャッシュする */
  private async getPanoMetadata(panoId: string): Promise<PanoMetadata | null> {
    const cached = this.metadataCache.get(panoId);
    if (cached !== undefined) return cached;

    let metadata: PanoMetadata | null = null;
    try {
      const { data } = await this.svService.getPanorama({ pano: panoId });
      const latLng = data.location?.latLng;
      if (latLng) {
        metadata = {
          position: { lat: latLng.lat(), lng: latLng.lng() },
          links: data.links ?? [],
          copyright: data.copyright,
        };
      }
    } catch {
      metadata = null;
    }

    this.metadataCache.set(panoId, metadata);
    return metadata;
  }

  /** setPanoし、リンク情報の更新（links_changed）を待つ */
  private setPanoAndWait(panoId: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const listener = this.panorama.addListener("links_changed", () => {
        if (settled) return;
        settled = true;
        listener.remove();
        window.clearTimeout(timer);
        resolve(true);
      });
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        listener.remove();
        resolve(false);
      }, PANO_CHANGE_TIMEOUT_MS);
      this.panorama.setPano(panoId);
    });
  }

  /**
   * ルート上の指定距離付近のパノラマをStreetViewServiceで探し、
   * setPositionで再同期する（インスタンス再生成なし＝無課金）。
   * strict時はルート外・後退となる再同期を棄却する（初期表示・リセット時は緩和）。
   */
  private async resyncToRoute(
    distanceM: number,
    radiiMeters: number[],
    generation: number,
    options: PanoramaChangedOptions,
    { strict }: { strict: boolean }
  ): Promise<boolean> {
    const point = getPointAtDistance(this.route, distanceM);

    for (const radius of radiiMeters) {
      if (generation !== this.generation) return false;
      try {
        const { data } = await this.svService.getPanorama({
          location: { lat: point.lat, lng: point.lng },
          radius,
          source: google.maps.StreetViewSource.OUTDOOR,
        });

        if (generation !== this.generation) return false;
        const latLng = data.location?.latLng;
        if (!latLng) continue;
        // 投稿パノラマ（建物内・遊歩道など）へは再同期しない
        if (strict && !isOfficialPano(data.location?.pano, data.copyright)) {
          continue;
        }

        const found = { lat: latLng.lat(), lng: latLng.lng() };
        const projection = projectOntoRoute(this.route, found, distanceM);

        if (strict) {
          // ルート外パノラマ（公園・私道など）や後退方向への再同期は表示しない
          if (projection.offsetM > RESYNC_OFF_ROUTE_METERS) return false;
          if (
            projection.distanceM <
            this.panoDistance - MIN_FORWARD_PROGRESS_METERS
          ) {
            return false;
          }
        }

        this.panorama.setPosition(latLng);
        this.cancelHeadingTween();
        this.panorama.setPov({
          heading: closestRoadHeading(data.links, point.heading),
          pitch: 0,
        });

        this.panoDistance =
          projection.offsetM <= RESYNC_OFF_ROUTE_METERS
            ? projection.distanceM
            : distanceM;
        this.panoStepCount += 1;
        this.onPanoramaChanged?.(this.panoDistance, found, options);
        return true;
      } catch {
        // パノラマなし: 半径を広げて再探索する
      }
    }

    return false;
  }

  /** 視線方向を最短回転方向で滑らかに補間する */
  private tweenHeading(targetHeading: number): void {
    this.cancelHeadingTween();
    const pov = this.panorama.getPov?.();
    const from =
      typeof pov?.heading === "number" ? pov.heading : targetHeading;
    const diff = ((targetHeading - from + 540) % 360) - 180;

    if (Math.abs(diff) < 2 || typeof requestAnimationFrame !== "function") {
      this.panorama.setPov({
        heading: normalizeHeading(targetHeading),
        pitch: 0,
      });
      return;
    }

    const startTime = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - startTime) / HEADING_TWEEN_MS, 1);
      const eased = t * (2 - t);
      this.panorama.setPov({
        heading: normalizeHeading(from + diff * eased),
        pitch: 0,
      });
      this.headingAnimation = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.headingAnimation = requestAnimationFrame(step);
  }

  private cancelHeadingTween(): void {
    if (this.headingAnimation !== null) {
      cancelAnimationFrame(this.headingAnimation);
      this.headingAnimation = null;
    }
  }

  reset(initialDistance = 0): void {
    this.generation += 1;
    this.cancelHeadingTween();
    this.targetDistance = initialDistance;
    this.panoDistance = initialDistance;
    this.resyncBlockedUntilDistance = Number.NEGATIVE_INFINITY;
    this.ready = this.initialize(initialDistance, this.generation);
  }

  destroy(): void {
    this.generation += 1;
    this.cancelHeadingTween();
    this.panorama.setVisible(false);
  }
}
