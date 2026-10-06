import type { Route } from "../types";
import { getPointAtDistance } from "./routeSampler";
import { totalDistance } from "./routeLoader";
import { findChainIndexAtDistance, type PanoChainEntry } from "./panoChain";
import type { PanoChainRange } from "./panoChainSegments";

/** パノラマ列の範囲と、その範囲に含まれるエントリの添字 */
type ChainRangeBound = {
  range: PanoChainRange;
  first: number;
  last: number;
};

/**
 * リンク追従（ハイブリッド）方式の定数。
 * Dynamic Street Viewの課金は「パノラマオブジェクトのインスタンス化」単位のため、
 * 単一インスタンスを維持して setPano / setPosition で移動する限り追加課金は発生しない。
 * StreetViewService によるメタデータ取得（pano ID / 位置指定）も無課金。
 */
/** 曲がり角付近: ターゲットがこの距離以上先に進んだら次のパノラマへ進む [m] */
export const FINE_STEP_TRIGGER_METERS = 5;
/** 直線区間: この距離たまったらリンク鎖をまとめて移動する [m]（遷移回数の削減） */
export const COARSE_STEP_TRIGGER_METERS = 50;
/** 1回のまとめ移動で進む最大距離 [m] */
const COARSE_HOP_MAX_METERS = 60;
/** 1回のまとめ移動で辿る最大パノラマ数 */
const MAX_TRAVERSE_PANOS = 14;
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
 * 高架の降り口（ランプ）や側道へは1歩ごとの左右変化が小さいまま徐々に離れていくため、
 * 1歩ごとの変化（MAX_LATERAL_SHIFT_METERS）だけでなく絶対値でも厳しめに切る
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
/**
 * 実際の移動方位（現在地→リンク先）と進行方向の許容角度差 [deg]（横ステップ防止）。
 * 直線区間は斜め移動（横向きに進んで見える）を抑えるため厳しめにする
 */
const STEP_MAX_MOVE_BEARING_DELTA_DEGREES = 30;
/** 曲がり角付近の移動方位の許容角度差 [deg] */
const TURN_STEP_MAX_MOVE_BEARING_DELTA_DEGREES = 50;
/**
 * 1ステップでのルート線に対する左右位置（符号付きずれ）の最大変化 [m]。
 * 反対車線・側道・高架/高架下など、並走する別の撮影列への乗り移りを防ぐ
 */
const MAX_LATERAL_SHIFT_METERS = 6;
/**
 * 再同期で撮影時期（imageDate）が同じ候補が見つからないとき、表示が止まってから
 * この距離だけ進むまで別の撮影時期への再同期を保留する [m]。
 * 撮影時期の切り替わり自体は頻繁に起きる（1ルートで10種類程度）ため短めにする。
 * 高架と高架下・橋と河川敷・道路と地下駅は平面上で重なるが撮影列が別のため、
 * 撮影時期の一致を「同じ高さの道を走り続けている」目安にする
 */
const RESYNC_DATE_RELAX_DISTANCE_METERS = 50;
/**
 * 屋内・地下パノラマの説明文パターン。
 * Google撮影の駅構内はOUTDOOR検索をすり抜けることがあるため、説明文でも弾く
 * （「駅前」は地上の地名に多いので除外しない）
 */
const INDOOR_DESCRIPTION_PATTERN =
  /(駅|ステーション)(?!前)|ホーム|改札|構内|コンコース|地下|station|platform|concourse|underground/i;
/**
 * 撮影車の進行方向（tiles.centerHeading）とルート進行方向の許容差 [deg]。
 * 超える候補は反対車線・一方通行の逆方向で撮影された可能性が高いため後回しにする
 */
const CAPTURE_HEADING_MAX_DELTA_DEGREES = 90;
/**
 * まとめ移動で途中のパノラマを順に表示する間隔 [ms]。
 * 隣接していないパノラマへ直接setPanoすると移動アニメーションにならず暗転するため、
 * 途中を短い間隔で辿って移動感を保つ
 */
const HOP_PLAYTHROUGH_INTERVAL_MS = 250;
/** 再同期候補の左右位置の基準に使う直近の表示ステップ数 */
const RECENT_SIDE_SAMPLES = 5;
/** 移動後の視線: パノラマ位置からこの距離先のルート上の点を向く [m] */
const VIEW_LOOKAHEAD_METERS = 20;
/** 診断ログの保持件数 */
const DIAGNOSTICS_MAX_ENTRIES = 10000;
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
/** 再同期時、ターゲット地点に加えて候補を探す前方オフセット [m] */
const RESYNC_AHEAD_METERS = 20;
/** 再同期時の近傍探索半径 [m] */
const RESYNC_SEARCH_RADII_METERS = [25, 50];
/** 初期表示時の近傍探索半径 [m] */
const STREET_VIEW_INITIAL_SEARCH_RADII_METERS = [50, 150, 300];
/** 初期表示時にルート沿いへずらして探索するオフセット [m] */
const STREET_VIEW_INITIAL_SEARCH_OFFSETS_METERS = [
  0, 10, 20, 30, 50, 100, -100, 200, -200, 300, -300, 500, -500, 800, -800, 1000, -1000, 1500,
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
  /** 撮影年月（"YYYY-MM"）。同じ撮影列かどうかの目安 */
  imageDate?: string;
  /** 場所の説明文（駅名・住所など） */
  description?: string;
  /** 撮影車の進行方向 [deg]（tiles.centerHeading） */
  captureHeading?: number;
};

/** リンク候補・再同期候補を棄却した理由（診断ログ用） */
export type StepRejectReason =
  | "metadata"
  | "contributed"
  | "bearing"
  | "length"
  | "offRoute"
  | "lateral"
  | "noProgress"
  | "indoorName"
  | "indoor"
  | "dateChange"
  | "noForwardLink";

/** 診断ログ1件（?debug=1 の検証用） */
export type StreetViewDiagnosticEntry = {
  /**
   * link: リンク移動 / bridge: 交差点などを経由したリンク移動 /
   * resync: 近傍検索で再同期 / reject: 再同期候補を棄却 / stop: リンク追従が途切れた
   */
  kind: "link" | "bridge" | "resync" | "reject" | "stop";
  pano?: string;
  imageDate?: string;
  description?: string;
  /** ルート累積距離 [m] */
  distanceM: number;
  /** ルート線に対する符号付きずれ [m]（右が正） */
  sideM?: number;
  /** 撮影時期が直前と変わったか */
  dateChanged?: boolean;
  reason?: StepRejectReason;
  /** このステップで棄却したリンク候補 */
  rejected?: Array<{ pano: string; reason: StepRejectReason }>;
};

/**
 * 移動の見せ方。
 * - smooth: 隣のパノラマへ1枚ずつsetPanoし、Street View標準の移動アニメーションを見せる（移動感重視）
 * - hop: リンク鎖をまとめて移動し、遷移回数を減らす（酔いにくさ重視・カット表示）
 */
export type StreetViewMotionMode = "smooth" | "hop";

export function normalizeHeading(heading: number): number {
  return ((heading % 360) + 360) % 360;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function headingDelta(a: number, b: number): number {
  const delta = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return Math.min(delta, 360 - delta);
}

/**
 * 公式（Google撮影）パノラマか。
 * 投稿パノラマはID形式と著作権表示の両方で判定して確実に除外する
 */
export function isOfficialPano(
  panoId: string | undefined,
  copyright: string | undefined
): boolean {
  if (panoId && CONTRIBUTED_PANO_ID_PATTERN.test(panoId)) return false;
  return !copyright || OFFICIAL_PANO_COPYRIGHT_PATTERN.test(copyright);
}

/** 説明文の先頭要素が行政区画名（大阪市など）か */
const ADMIN_AREA_NAME_PATTERN = /(都|道|府|県|市|区|町|村|郡)$/;
/** 説明文の先頭要素が道路・橋の名前か（国道423号・御堂筋・曽根崎通・新淀川大橋など） */
const ROAD_NAME_PATTERN =
  /(号|線|通|通り|筋|道|街道|橋|𣘺|バイパス|ロード|坂|トンネル|高架|ランプ|IC|JCT)$/;

/**
 * 屋内・地下パノラマらしい説明文か。
 * 屋外の道路パノラマの説明文は「道路名, 市, 府」か「市, 府」になる。
 * 先頭が道路名でも行政区画名でもない（ホワイティうめだ等の施設名）なら屋内とみなす
 */
export function hasIndoorDescription(description: string | undefined): boolean {
  if (!description) return false;
  if (INDOOR_DESCRIPTION_PATTERN.test(description)) return true;
  const head = description.split(",")[0]?.trim() ?? "";
  if (!head) return false;
  return !ADMIN_AREA_NAME_PATTERN.test(head) && !ROAD_NAME_PATTERN.test(head);
}

/** 撮影車の進行方向がルートの進行方向に沿っているか（不明なら沿っているとみなす） */
export function isCapturedAlong(
  captureHeading: number | undefined,
  routeHeading: number
): boolean {
  return (
    typeof captureHeading !== "number" ||
    headingDelta(captureHeading, routeHeading) <= CAPTURE_HEADING_MAX_DELTA_DEGREES
  );
}

export function locationDescription(
  location: google.maps.StreetViewLocation | null | undefined
): string | undefined {
  return (
    [location?.description, location?.shortDescription]
      .filter((text): text is string => Boolean(text))
      .join(" ") || undefined
  );
}

/** 2点間の距離 [m]（等距円筒近似・近距離用） */
export function distanceBetweenMeters(
  from: google.maps.LatLngLiteral,
  to: google.maps.LatLngLiteral
): number {
  const latScale = Math.cos((from.lat * Math.PI) / 180);
  const dx = (to.lng - from.lng) * METERS_PER_DEGREE_LAT * latScale;
  const dy = (to.lat - from.lat) * METERS_PER_DEGREE_LAT;
  return Math.hypot(dx, dy);
}

/** 2点間の方位角 [deg]（等距円筒近似・近距離用） */
export function bearingBetween(
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
  /** ルート線に対する符号付きずれ [m]（進行方向の右が正） */
  sideM: number;
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
    sideM: 0,
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
      // 区間ベクトルと（区間始点→位置）の外積: 負なら進行方向の右側
      const cross = abX * -pa.y - abY * -pa.x;
      best = {
        distanceM: a.distance + (b.distance - a.distance) * t,
        offsetM: offset,
        sideM: cross < 0 ? offset : -offset,
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

export function closestRoadHeading(
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
  /** 表示中パノラマの撮影年月（撮影列が変わったかの判定用） */
  private currentImageDate: string | undefined;
  /** 表示中パノラマのルート線に対する符号付きずれ [m] */
  private currentSideM: number | null = null;
  /** 直近の表示ステップの左右位置（再同期候補の基準。ランプ等で離れ始めた値に引きずられない） */
  private recentSides: number[] = [];
  /** 事前作り込みのパノラマ列（あれば走行中の探索をせず、この並びを順に再生する） */
  private chain: PanoChainEntry[] | null = null;
  /** 表示中のパノラマ列の添字 */
  private chainIndex = 0;
  /** パノラマ列の範囲（null ならルート全体がパノラマ列） */
  private rangeBounds: ChainRangeBound[] | null = null;
  /** 再生中の範囲（範囲外を探索方式で走っている間は null） */
  private activeBound: ChainRangeBound | null = null;
  /** 直近の移動種別・棄却理由（?debug=1 での検証用・新しい順ではなく発生順） */
  diagnostics: StreetViewDiagnosticEntry[] = [];
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
    onPanoramaChanged?: PanoramaChangedCallback,
    chain?: PanoChainEntry[] | null,
    chainRanges?: PanoChainRange[] | null
  ) {
    const start = getPointAtDistance(route, initialDistance);
    this.route = route;
    this.chain = chain && chain.length > 0 ? chain : null;
    if (this.chain && chainRanges) {
      const entries = this.chain;
      this.rangeBounds = chainRanges
        .map((range) => {
          const indexes = entries
            .map((entry, index) => ({ entry, index }))
            .filter(
              ({ entry }) =>
                entry.distanceM >= range.startM - 1 &&
                entry.distanceM <= range.endM + 1
            )
            .map(({ index }) => index);
          return indexes.length > 0
            ? { range, first: indexes[0], last: indexes[indexes.length - 1] }
            : null;
        })
        .filter((bound): bound is ChainRangeBound => bound !== null);
    }
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
    this.ready = this.chain
      ? this.initializeFromChain(initialDistance, this.generation)
      : this.initialize(initialDistance, this.generation);
  }

  /** パノラマ列を使って走行しているか（一部の区間だけの場合も含む） */
  get usesChain(): boolean {
    return this.chain !== null;
  }

  /** いまパノラマ列を再生しているか（範囲外を探索方式で走っている間は false） */
  private get chainPlaying(): boolean {
    return this.chain !== null && (this.rangeBounds === null || this.activeBound !== null);
  }

  private boundAt(distanceM: number): ChainRangeBound | null {
    return (
      this.rangeBounds?.find(
        (bound) => distanceM >= bound.range.startM && distanceM < bound.range.endM
      ) ?? null
    );
  }

  /** パノラマ列の指定距離のエントリから表示を始める */
  private async initializeFromChain(
    initialDistance: number,
    generation: number
  ): Promise<boolean> {
    const chain = this.chain;
    if (!chain) return false;
    let index = findChainIndexAtDistance(chain, initialDistance);
    if (this.rangeBounds) {
      // 範囲外から始まる場合は探索方式で始め、範囲に入ったらパノラマ列へ移る
      const bound = this.boundAt(initialDistance);
      this.activeBound = bound;
      if (!bound) return this.initialize(initialDistance, generation);
      index = Math.min(Math.max(index, bound.first), bound.last);
    }
    const entry = chain[index];
    const moved = await this.setPanoAndWait(entry.pano);
    if (generation !== this.generation) return false;
    if (!moved) {
      // パノラマが削除・差し替えされた場合: 従来の探索方式で走れるようにする
      this.chain = null;
      return this.initialize(initialDistance, generation);
    }

    const position = { lat: entry.lat, lng: entry.lng };
    this.chainIndex = index;
    this.panoDistance = entry.distanceM;
    this.cancelHeadingTween();
    this.panorama.setPov({
      heading: this.headingToRouteAhead(
        position,
        entry.distanceM,
        VIEW_LOOKAHEAD_METERS
      ),
      pitch: 0,
    });
    this.panoStepCount += 1;
    this.onPanoramaChanged?.(entry.distanceM, position, {
      syncDistance: true,
      billed: true,
    });
    return true;
  }

  /**
   * パノラマ列の範囲に応じて進め方を決める。
   * stepped: パノラマ列で進んだ / idle: 今は進まない / live: 範囲外なので探索方式で進む
   */
  private async advanceChain(
    generation: number
  ): Promise<"stepped" | "idle" | "live"> {
    const chain = this.chain;
    if (!chain) return "live";
    if (!this.rangeBounds) {
      return (await this.stepAlongChain(generation, chain.length - 1))
        ? "stepped"
        : "idle";
    }

    const active = this.activeBound;
    if (active) {
      if (this.chainIndex < active.last) {
        return (await this.stepAlongChain(generation, active.last))
          ? "stepped"
          : "idle";
      }
      if (this.targetDistance <= active.range.endM) return "idle";
      // 範囲の終わり: ここから先は探索方式で走る（現在のパノラマのリンクから続ける）
      const last = chain[this.chainIndex];
      this.activeBound = null;
      this.currentSideM = last.sideM;
      this.currentImageDate = last.imageDate;
      this.recentSides = [];
      this.rememberSide(last.sideM);
      return "live";
    }

    const bound = this.boundAt(this.targetDistance);
    if (!bound) return "live";

    // 範囲に入った: パノラマ列へ移る
    const index = Math.min(
      Math.max(findChainIndexAtDistance(chain, this.targetDistance), bound.first),
      bound.last
    );
    const entry = chain[index];
    const moved = await this.setPanoAndWait(entry.pano);
    if (generation !== this.generation) return "idle";
    if (!moved) return "live";

    const position = { lat: entry.lat, lng: entry.lng };
    this.activeBound = bound;
    this.chainIndex = index;
    this.panoDistance = entry.distanceM;
    this.panoStepCount += 1;
    this.log({
      kind: "resync",
      pano: entry.pano,
      imageDate: entry.imageDate,
      description: entry.description,
      distanceM: entry.distanceM,
      sideM: entry.sideM,
    });
    this.tweenHeading(
      this.headingToRouteAhead(position, entry.distanceM, VIEW_LOOKAHEAD_METERS)
    );
    this.onPanoramaChanged?.(entry.distanceM, position, {});
    return "stepped";
  }

  /**
   * パノラマ列を進める。なめらか: 1枚ずつ / まとめ: 直線は約50mぶんを
   * 短い間隔で連続表示し、曲がり角付近は1枚ずつ。リンクの途切れ（乗り継ぎ）では一度止める。
   */
  private async stepAlongChain(
    generation: number,
    maxIndex: number
  ): Promise<boolean> {
    const chain = this.chain;
    if (!chain) return false;
    const targetIndex = Math.min(
      findChainIndexAtDistance(chain, this.targetDistance),
      maxIndex
    );
    if (targetIndex <= this.chainIndex) return false;

    const current = chain[this.chainIndex];
    const fineMode =
      this.motionMode === "smooth" || isNearTurn(this.route, current.distanceM);
    let stopIndex = this.chainIndex + 1;
    if (!fineMode) {
      // 乗り継ぎ（隣接しない）エントリの手前で区切り、そこは単独で移動する
      while (
        stopIndex < targetIndex &&
        chain[stopIndex + 1].source === "link" &&
        chain[stopIndex].source === "link" &&
        !isNearTurn(this.route, chain[stopIndex].distanceM)
      ) {
        stopIndex += 1;
      }
    }

    const destination = chain[stopIndex];
    const from = { lat: current.lat, lng: current.lng };
    const to = { lat: destination.lat, lng: destination.lng };

    // 曲がってから進む: 視線を移動方向へ先に向け、横向きのまま進んで見えるのを防ぐ
    const moveBearing = bearingBetween(from, to);
    const pov = this.panorama.getPov?.();
    if (
      typeof pov?.heading === "number" &&
      headingDelta(pov.heading, moveBearing) > TURN_BEFORE_MOVE_DEGREES
    ) {
      this.tweenHeading(moveBearing);
      await sleep(TURN_BEFORE_MOVE_WAIT_MS);
      if (generation !== this.generation) return false;
    }

    for (let index = this.chainIndex + 1; index <= stopIndex; index += 1) {
      const moved = await this.setPanoAndWait(chain[index].pano);
      if (!moved || generation !== this.generation) return false;
      this.chainIndex = index;
      this.panoDistance = chain[index].distanceM;
      if (index < stopIndex) {
        await sleep(HOP_PLAYTHROUGH_INTERVAL_MS);
        if (generation !== this.generation) return false;
      }
    }

    this.panoStepCount += 1;
    this.log({
      kind: destination.source === "search" ? "resync" : "link",
      pano: destination.pano,
      imageDate: destination.imageDate,
      description: destination.description,
      distanceM: destination.distanceM,
      sideM: destination.sideM,
    });
    this.tweenHeading(
      this.headingToRouteAhead(to, destination.distanceM, VIEW_LOOKAHEAD_METERS)
    );
    this.onPanoramaChanged?.(destination.distanceM, to, {});
    return true;
  }

  private async initialize(
    initialDistance: number,
    generation: number
  ): Promise<boolean> {
    const routeDistance = totalDistance(this.route);

    // 1巡目: ルート沿いに前進できるパノラマだけを開始地点にする
    // （高架下・駅構内など進めない場所で止まり、その後誤った再同期をするのを防ぐ）
    // 2巡目: 見つからなければ従来どおり最寄りのパノラマで開始する
    for (const requireForwardLink of [true, false]) {
      for (const offset of STREET_VIEW_INITIAL_SEARCH_OFFSETS_METERS) {
        const candidateDistance = initialDistance + offset;
        if (candidateDistance < 0 || candidateDistance > routeDistance) continue;
        if (generation !== this.generation) return false;

        const found = await this.resyncToRoute(
          candidateDistance,
          STREET_VIEW_INITIAL_SEARCH_RADII_METERS,
          generation,
          { syncDistance: true, billed: true },
          { strict: false, requireForwardLink }
        );
        if (found) return true;
      }
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
          isNearTurn(this.route, this.panoDistance) ||
          // パノラマ列の乗り継ぎ地点は50m待たずに越える（区切った直後に止まらない）
          (this.chainPlaying &&
            this.chain?.[this.chainIndex + 1]?.source === "search")
            ? FINE_STEP_TRIGGER_METERS
            : COARSE_STEP_TRIGGER_METERS;
        if (this.targetDistance - this.panoDistance < trigger) return;

        if (this.chain) {
          // パノラマ列の範囲内: 走行中の探索・再同期はしない
          const mode = await this.advanceChain(generation);
          if (generation !== this.generation) return;
          if (mode === "stepped") {
            steps += 1;
            continue;
          }
          if (mode === "idle") return;
          // mode === "live": 範囲外は従来の探索方式で進む
        }

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

  private rememberSide(sideM: number | null): void {
    if (sideM === null) return;
    this.recentSides.push(sideM);
    if (this.recentSides.length > RECENT_SIDE_SAMPLES) this.recentSides.shift();
  }

  /** 再同期候補の左右位置の基準: 直近ステップの中央値（なければ現在値） */
  private referenceSide(): number | null {
    if (this.recentSides.length === 0) return this.currentSideM;
    const sorted = [...this.recentSides].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** 診断ログへ追記する（上限を超えたら古いものから捨てる） */
  private log(entry: StreetViewDiagnosticEntry): void {
    this.diagnostics.push(entry);
    if (this.diagnostics.length > DIAGNOSTICS_MAX_ENTRIES) {
      this.diagnostics.splice(0, this.diagnostics.length - DIAGNOSTICS_MAX_ENTRIES);
    }
  }

  /**
   * リンク先パノラマを表示前に検証する（すべてメタデータ・無課金）。
   * allowStall=true のときは前進しない（交差点中央など）候補も許可する。
   */
  private async evaluateLink(
    link: { pano: string; heading: number },
    from: {
      position: google.maps.LatLngLiteral;
      distanceM: number;
      sideM: number | null;
    },
    desiredHeading: number,
    fineMode: boolean,
    allowStall: boolean
  ): Promise<
    | { ok: true; metadata: PanoMetadata; projection: RouteProjection }
    | { ok: false; reason: StepRejectReason }
  > {
    const metadata = await this.getPanoMetadata(link.pano);
    if (!metadata) return { ok: false, reason: "metadata" };

    // 1. 公式パノラマ（投稿画像は建物内・遊歩道が多い）
    if (!isOfficialPano(link.pano, metadata.copyright)) {
      return { ok: false, reason: "contributed" };
    }
    // 2. 実際の移動方位が進行方向に沿っている（横ステップ・斜め移動防止）
    const moveBearing = bearingBetween(from.position, metadata.position);
    const maxBearingDelta = fineMode
      ? TURN_STEP_MAX_MOVE_BEARING_DELTA_DEGREES
      : STEP_MAX_MOVE_BEARING_DELTA_DEGREES;
    if (!allowStall && headingDelta(moveBearing, desiredHeading) > maxBearingDelta) {
      return { ok: false, reason: "bearing" };
    }
    // 3. 移動距離が異常でない（曲がり角付近は交差点パノラマを飛ばさない）
    const maxStepLength = fineMode
      ? TURN_STEP_MAX_LENGTH_METERS
      : STEP_MAX_LENGTH_METERS;
    if (distanceBetweenMeters(from.position, metadata.position) > maxStepLength) {
      return { ok: false, reason: "length" };
    }
    // 4. ルート線から離れない
    const projection = projectOntoRoute(
      this.route,
      metadata.position,
      from.distanceM
    );
    if (projection.offsetM > STEP_OFF_ROUTE_METERS) {
      return { ok: false, reason: "offRoute" };
    }
    // 5. 並走する別の撮影列（反対車線・高架/高架下）へ横に乗り移らない。
    //    曲がり角ではルート線の基準が切り替わるため判定しない
    if (
      !fineMode &&
      from.sideM !== null &&
      Math.abs(projection.sideM - from.sideM) > MAX_LATERAL_SHIFT_METERS
    ) {
      return { ok: false, reason: "lateral" };
    }
    // 6. 後退や停滞をしない
    const minProgress = allowStall
      ? -MIN_FORWARD_PROGRESS_METERS
      : MIN_FORWARD_PROGRESS_METERS;
    if (projection.distanceM < from.distanceM + minProgress) {
      return { ok: false, reason: "noProgress" };
    }
    // 7. 屋内・地下でない（説明文 → OUTDOOR検索の順に確認）
    if (hasIndoorDescription(metadata.description)) {
      return { ok: false, reason: "indoorName" };
    }
    const outdoor = await this.isOutdoorPano(link.pano, metadata.position);
    if (!outdoor) return { ok: false, reason: "indoor" };

    return { ok: true, metadata, projection };
  }

  /** リンクを進行方向に近い順に並べ、許容角度内の上位候補を返す */
  private rankLinks(
    links: google.maps.StreetViewLink[],
    desiredHeading: number,
    maxDelta = LINK_MAX_HEADING_DELTA_DEGREES
  ): Array<{ pano: string; heading: number }> {
    return links
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
      .filter((link) => link.delta <= maxDelta)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, MAX_LINK_CANDIDATES_PER_STEP);
  }

  /** ルート上の (distanceM + lookahead) 地点への方位 */
  private headingToRouteAhead(
    position: google.maps.LatLngLiteral,
    distanceM: number,
    lookaheadM: number
  ): number {
    const ahead = getPointAtDistance(
      this.route,
      Math.min(distanceM + lookaheadM, totalDistance(this.route))
    );
    if (distanceBetweenMeters(position, ahead) < 1) {
      return normalizeHeading(ahead.heading);
    }
    return bearingBetween(position, { lat: ahead.lat, lng: ahead.lng });
  }

  /**
   * パノラマリンクをメタデータで事前検証しながら辿り、まとめて1回表示を更新する。
   * 曲がり角付近では1枚だけ進む。表示前に検証するため、後退や
   * ルート外（公園・私道など）・別の撮影列（高架/高架下・地下）への迷い込みは画面に出ない。
   * 撮影時期が同じ候補を優先し、前進できるリンクがなければ
   * 交差点中央など前進しないパノラマを1枚だけ経由して先へ進めるか試す。
   */
  private async hopAlongLinks(generation: number): Promise<boolean> {
    const position = this.panorama.getPosition?.();
    let links: google.maps.StreetViewLink[] = (
      this.panorama.getLinks?.() ?? []
    ).filter((link): link is google.maps.StreetViewLink => link !== null);
    if (!position || links.length === 0) return false;

    const startDistance = this.panoDistance;
    const startPosition: google.maps.LatLngLiteral = {
      lat: position.lat(),
      lng: position.lng(),
    };
    let current = {
      position: startPosition,
      distanceM: startDistance,
      sideM: this.currentSideM,
      imageDate: this.currentImageDate,
    };
    let candidate: {
      pano: string;
      metadata: PanoMetadata;
      kind: "link" | "bridge";
      rejected: Array<{ pano: string; reason: StepRejectReason }>;
    } | null = null;
    const fineMode =
      this.motionMode === "smooth" || isNearTurn(this.route, startDistance);
    let firstRejected: Array<{ pano: string; reason: StepRejectReason }> = [];
    /** まとめ移動で辿ったパノラマ（最後が表示先） */
    const path: string[] = [];

    for (let index = 0; index < MAX_TRAVERSE_PANOS; index += 1) {
      if (generation !== this.generation) return false;

      const gap = this.targetDistance - current.distanceM;
      if (gap <= 0) break;
      const lookahead = Math.min(
        Math.max(gap, LINK_LOOKAHEAD_MIN_METERS),
        LINK_LOOKAHEAD_MAX_METERS
      );
      const desiredHeading = this.headingToRouteAhead(
        current.position,
        current.distanceM,
        lookahead
      );

      const rejected: Array<{ pano: string; reason: StepRejectReason }> = [];
      const accepted: Array<{
        pano: string;
        metadata: PanoMetadata;
        projection: RouteProjection;
      }> = [];
      for (const link of this.rankLinks(links, desiredHeading)) {
        const result = await this.evaluateLink(
          link,
          current,
          desiredHeading,
          fineMode,
          false
        );
        if (generation !== this.generation) return false;
        if (result.ok) {
          accepted.push({ pano: link.pano, ...result });
        } else {
          rejected.push({ pano: link.pano, reason: result.reason });
        }
      }

      // 同じ撮影列（撮影時期が同じ）の候補を優先する
      // 撮影車が同じ向きに走っていた候補（逆走防止）→ 同じ撮影列（撮影時期が同じ）の順に優先する
      const rank = (entry: (typeof accepted)[number]) =>
        (isCapturedAlong(entry.metadata.captureHeading, desiredHeading) ? 2 : 0) +
        (current.imageDate !== undefined &&
        entry.metadata.imageDate === current.imageDate
          ? 1
          : 0);
      let chosen = [...accepted].sort((a, b) => rank(b) - rank(a))[0];
      let kind: "link" | "bridge" = "link";

      if (!chosen && index === 0) {
        const bridge = await this.findBridgeStep(
          links,
          current,
          desiredHeading,
          fineMode,
          generation
        );
        if (generation !== this.generation) return false;
        if (bridge) {
          chosen = bridge;
          kind = "bridge";
        }
      }

      if (index === 0) firstRejected = rejected;
      if (!chosen) break;

      candidate = { pano: chosen.pano, metadata: chosen.metadata, kind, rejected };
      path.push(chosen.pano);
      current = {
        position: chosen.metadata.position,
        distanceM: Math.max(chosen.projection.distanceM, current.distanceM),
        sideM: chosen.projection.sideM,
        imageDate: chosen.metadata.imageDate ?? current.imageDate,
      };
      links = chosen.metadata.links;

      if (fineMode || kind === "bridge") break; // 1枚ずつ表示する
      if (current.distanceM >= this.targetDistance) break;
      if (current.distanceM - startDistance >= COARSE_HOP_MAX_METERS) break;
      if (isNearTurn(this.route, current.distanceM)) break; // 曲がり角に差し掛かったら一旦表示
    }

    if (!candidate) {
      this.log({
        kind: "stop",
        distanceM: startDistance,
        sideM: this.currentSideM ?? undefined,
        imageDate: this.currentImageDate,
        rejected: firstRejected.length > 0 ? firstRejected : undefined,
      });
      return false;
    }

    // 曲がってから進む: 視線を実際の移動方向へ先に向けてから移動し、
    // 横向きのまま進んで見える遷移を防ぐ
    const moveBearing = bearingBetween(startPosition, current.position);
    const pov = this.panorama.getPov?.();
    const povDelta =
      typeof pov?.heading === "number"
        ? headingDelta(pov.heading, moveBearing)
        : 0;
    if (povDelta > TURN_BEFORE_MOVE_DEGREES) {
      this.tweenHeading(moveBearing);
      await sleep(TURN_BEFORE_MOVE_WAIT_MS);
      if (generation !== this.generation) return false;
    }

    // まとめ移動: 途中のパノラマを短い間隔で順に表示し、暗転ではなく移動アニメーションで進む
    for (const pano of path.slice(0, -1)) {
      const passed = await this.setPanoAndWait(pano);
      if (!passed || generation !== this.generation) return false;
      await sleep(HOP_PLAYTHROUGH_INTERVAL_MS);
      if (generation !== this.generation) return false;
    }
    const moved = await this.setPanoAndWait(candidate.pano);
    if (!moved || generation !== this.generation) return false;

    const dateChanged =
      this.currentImageDate !== undefined &&
      current.imageDate !== undefined &&
      current.imageDate !== this.currentImageDate;
    this.panoDistance = current.distanceM;
    this.currentSideM = current.sideM;
    this.rememberSide(current.sideM);
    this.currentImageDate = current.imageDate;
    this.panoStepCount += 1;
    this.log({
      kind: candidate.kind,
      pano: candidate.pano,
      imageDate: candidate.metadata.imageDate,
      description: candidate.metadata.description,
      distanceM: this.panoDistance,
      sideM: current.sideM ?? undefined,
      dateChanged,
      rejected: candidate.rejected.length > 0 ? candidate.rejected : undefined,
    });
    // 移動後は少し先のルート上の点を向く（リンク方向に合わせると斜めを向きやすい）
    this.tweenHeading(
      this.headingToRouteAhead(
        current.position,
        current.distanceM,
        VIEW_LOOKAHEAD_METERS
      )
    );
    this.onPanoramaChanged?.(this.panoDistance, current.position, {});
    return true;
  }

  /** そのパノラマからルート沿いに前進できる検証済みリンクがあるか */
  private async hasForwardLink(
    links: Array<google.maps.StreetViewLink | null>,
    position: google.maps.LatLngLiteral,
    projection: RouteProjection,
    generation: number
  ): Promise<boolean> {
    const from = {
      position,
      distanceM: projection.distanceM,
      sideM: projection.sideM,
    };
    const desiredHeading = this.headingToRouteAhead(
      position,
      projection.distanceM,
      LINK_LOOKAHEAD_MIN_METERS
    );
    const validLinks = links.filter(
      (link): link is google.maps.StreetViewLink => link !== null
    );
    for (const link of this.rankLinks(validLinks, desiredHeading)) {
      const result = await this.evaluateLink(
        link,
        from,
        desiredHeading,
        true,
        false
      );
      if (generation !== this.generation) return false;
      if (result.ok) return true;
    }
    return false;
  }

  /**
   * 前進できるリンクがないとき、前進しないパノラマ（交差点中央など）を
   * 1枚経由すれば先へ進めるかを確かめる。進めるなら経由パノラマを返す。
   */
  private async findBridgeStep(
    links: google.maps.StreetViewLink[],
    from: {
      position: google.maps.LatLngLiteral;
      distanceM: number;
      sideM: number | null;
      imageDate: string | undefined;
    },
    desiredHeading: number,
    fineMode: boolean,
    generation: number
  ): Promise<{
    pano: string;
    metadata: PanoMetadata;
    projection: RouteProjection;
  } | null> {
    // 交差点中央は進行方向から大きく外れることがあるため90°まで見る
    for (const link of this.rankLinks(links, desiredHeading, 90)) {
      const bridge = await this.evaluateLink(
        link,
        from,
        desiredHeading,
        fineMode,
        true
      );
      if (generation !== this.generation) return null;
      if (!bridge.ok) continue;
      // 撮影列が変わる経由は高さの乗り換えになりやすいので使わない
      if (
        from.imageDate !== undefined &&
        bridge.metadata.imageDate !== undefined &&
        bridge.metadata.imageDate !== from.imageDate
      ) {
        continue;
      }

      const next = {
        position: bridge.metadata.position,
        distanceM: Math.max(bridge.projection.distanceM, from.distanceM),
        sideM: bridge.projection.sideM,
      };
      const nextHeading = this.headingToRouteAhead(
        next.position,
        next.distanceM,
        LINK_LOOKAHEAD_MIN_METERS
      );
      for (const onward of this.rankLinks(bridge.metadata.links, nextHeading)) {
        if (onward.pano === link.pano) continue;
        const result = await this.evaluateLink(
          onward,
          { ...next, distanceM: from.distanceM },
          nextHeading,
          fineMode,
          false
        );
        if (generation !== this.generation) return null;
        if (result.ok) {
          return { pano: link.pano, ...bridge };
        }
      }
    }
    return null;
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
          imageDate: data.imageDate,
          description: locationDescription(data.location),
          captureHeading: data.tiles?.centerHeading,
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
   * strict（走行中）は複数地点・半径の候補から同じ撮影列らしいものを選ぶ。
   * 非strict（初期表示・リセット時）は最寄りのパノラマを使う。
   */
  private async resyncToRoute(
    distanceM: number,
    radiiMeters: number[],
    generation: number,
    options: PanoramaChangedOptions,
    {
      strict,
      requireForwardLink = false,
    }: { strict: boolean; requireForwardLink?: boolean }
  ): Promise<boolean> {
    if (strict) {
      return this.resyncAlongRoute(distanceM, radiiMeters, generation, options);
    }

    const point = getPointAtDistance(this.route, distanceM);
    for (const radius of radiiMeters) {
      if (generation !== this.generation) return false;
      const data = await this.searchPanorama(point, radius);
      if (generation !== this.generation) return false;
      const latLng = data?.location?.latLng;
      if (!data || !latLng) continue;

      const found = { lat: latLng.lat(), lng: latLng.lng() };
      const projection = projectOntoRoute(this.route, found, distanceM);
      if (requireForwardLink) {
        const viable = await this.hasForwardLink(
          data.links ?? [],
          found,
          projection,
          generation
        );
        if (generation !== this.generation) return false;
        if (!viable) continue;
      }

      this.applyResync(data, found, projection, distanceM, point.heading, options);
      return true;
    }
    return false;
  }

  /** 位置指定でOUTDOORパノラマを探す（見つからなければnull） */
  private async searchPanorama(
    location: google.maps.LatLngLiteral,
    radius: number
  ): Promise<google.maps.StreetViewPanoramaData | null> {
    try {
      const { data } = await this.svService.getPanorama({
        location: { lat: location.lat, lng: location.lng },
        radius,
        source: google.maps.StreetViewSource.OUTDOOR,
      });
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 走行中の再同期。ターゲット地点と少し先の地点を複数の半径で探し、
   * 「撮影時期が同じ → 左右位置が近い → ルートに近い」の順で候補を選ぶ。
   * 高架/高架下・橋/河川敷は平面上で重なるため、直前まで走っていた撮影列に
   * 近い候補を選ぶことで高さの入れ替わりを減らす。
   */
  private async resyncAlongRoute(
    distanceM: number,
    radiiMeters: number[],
    generation: number,
    options: PanoramaChangedOptions
  ): Promise<boolean> {
    const queries = [
      { distanceM, radius: radiiMeters[0] },
      { distanceM: distanceM + RESYNC_AHEAD_METERS, radius: radiiMeters[0] },
      ...radiiMeters.slice(1).map((radius) => ({ distanceM, radius })),
    ];
    const routeDistance = totalDistance(this.route);
    const seen = new Set<string>();
    const candidates: Array<{
      data: google.maps.StreetViewPanoramaData;
      found: google.maps.LatLngLiteral;
      projection: RouteProjection;
      queryDistanceM: number;
      capturedAlong: boolean;
      sameDate: boolean;
      sideDelta: number;
    }> = [];
    const referenceSide = this.referenceSide();

    for (const query of queries) {
      if (generation !== this.generation) return false;
      const queryDistanceM = Math.min(query.distanceM, routeDistance);
      const point = getPointAtDistance(this.route, queryDistanceM);
      const data = await this.searchPanorama(point, query.radius);
      if (generation !== this.generation) return false;
      const latLng = data?.location?.latLng;
      if (!data || !latLng) continue;
      const panoId = data.location?.pano ?? `${latLng.lat()},${latLng.lng()}`;
      if (seen.has(panoId)) continue;
      seen.add(panoId);

      const found = { lat: latLng.lat(), lng: latLng.lng() };
      const projection = projectOntoRoute(this.route, found, queryDistanceM);
      const imageDate = data.imageDate;
      const description = locationDescription(data.location);
      const reject = (reason: StepRejectReason) =>
        this.log({
          kind: "reject",
          pano: data.location?.pano,
          imageDate,
          description,
          distanceM: projection.distanceM,
          sideM: projection.sideM,
          reason,
        });

      // 投稿パノラマ（建物内・遊歩道など）へは再同期しない
      if (!isOfficialPano(data.location?.pano, data.copyright)) {
        reject("contributed");
        continue;
      }
      // ルート外パノラマ（公園・私道など）や後退方向への再同期は表示しない
      if (projection.offsetM > RESYNC_OFF_ROUTE_METERS) {
        reject("offRoute");
        continue;
      }
      if (
        projection.distanceM <
        this.panoDistance - MIN_FORWARD_PROGRESS_METERS
      ) {
        reject("noProgress");
        continue;
      }
      // 駅構内・地下街など（OUTDOOR検索をすり抜けた屋内）へは再同期しない
      if (hasIndoorDescription(description)) {
        reject("indoorName");
        continue;
      }

      candidates.push({
        data,
        found,
        projection,
        queryDistanceM,
        capturedAlong: isCapturedAlong(data.tiles?.centerHeading, point.heading),
        sameDate:
          this.currentImageDate === undefined ||
          imageDate === undefined ||
          imageDate === this.currentImageDate,
        sideDelta:
          referenceSide === null
            ? 0
            : Math.abs(projection.sideM - referenceSide),
      });
    }

    candidates.sort(
      (a, b) =>
        Number(b.capturedAlong) - Number(a.capturedAlong) ||
        Number(b.sameDate) - Number(a.sameDate) ||
        a.sideDelta - b.sideDelta ||
        a.projection.offsetM - b.projection.offsetM
    );

    const stalledM = this.targetDistance - this.panoDistance;
    const relaxed = stalledM >= RESYNC_DATE_RELAX_DISTANCE_METERS;

    for (const candidate of candidates) {
      const { data, found, projection } = candidate;
      const logReject = (reason: StepRejectReason) =>
        this.log({
          kind: "reject",
          pano: data.location?.pano,
          imageDate: data.imageDate,
          description: locationDescription(data.location),
          distanceM: projection.distanceM,
          sideM: projection.sideM,
          reason,
        });

      if (!relaxed) {
        // 同じ撮影列・左右位置の候補がなければ、少し進むまで待つ
        if (!candidate.sameDate) {
          logReject("dateChange");
          return false;
        }
        if (candidate.sideDelta > MAX_LATERAL_SHIFT_METERS) {
          logReject("lateral");
          return false;
        }
      } else {
        // 保留を解いた再同期でも、行き止まり（駅改札など）へは飛ばない
        const viable = await this.hasForwardLink(
          data.links ?? [],
          found,
          projection,
          generation
        );
        if (generation !== this.generation) return false;
        if (!viable) {
          logReject("noForwardLink");
          continue;
        }
      }

      const point = getPointAtDistance(this.route, candidate.queryDistanceM);
      this.applyResync(
        data,
        found,
        projection,
        candidate.queryDistanceM,
        point.heading,
        options
      );
      return true;
    }

    return false;
  }

  /** 再同期先へsetPositionで移動し、状態と診断ログを更新する */
  private applyResync(
    data: google.maps.StreetViewPanoramaData,
    found: google.maps.LatLngLiteral,
    projection: RouteProjection,
    distanceM: number,
    routeHeading: number,
    options: PanoramaChangedOptions
  ): void {
    const imageDate = data.imageDate;
    const dateChanged =
      this.currentImageDate !== undefined &&
      imageDate !== undefined &&
      imageDate !== this.currentImageDate;
    const onRoute = projection.offsetM <= RESYNC_OFF_ROUTE_METERS;

    const latLng = data.location?.latLng;
    if (latLng) this.panorama.setPosition(latLng);
    this.cancelHeadingTween();
    this.panorama.setPov({
      heading: closestRoadHeading(data.links ?? undefined, routeHeading),
      pitch: 0,
    });

    this.panoDistance = onRoute ? projection.distanceM : distanceM;
    this.currentImageDate = imageDate ?? this.currentImageDate;
    this.currentSideM = onRoute ? projection.sideM : null;
    this.recentSides = [];
    this.rememberSide(this.currentSideM);
    this.panoStepCount += 1;
    this.log({
      kind: "resync",
      pano: data.location?.pano,
      imageDate,
      description: locationDescription(data.location),
      distanceM: this.panoDistance,
      sideM: projection.sideM,
      dateChanged,
    });
    this.onPanoramaChanged?.(this.panoDistance, found, options);
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
    this.currentImageDate = undefined;
    this.currentSideM = null;
    this.recentSides = [];
    this.activeBound = null;
    this.ready = this.chain
      ? this.initializeFromChain(initialDistance, this.generation)
      : this.initialize(initialDistance, this.generation);
  }

  destroy(): void {
    this.generation += 1;
    this.cancelHeadingTween();
    this.panorama.setVisible(false);
  }
}
