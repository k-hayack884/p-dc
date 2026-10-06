import type { Route } from "../types";
import {
  removeShortExcursions,
  type PanoChain,
  type PanoChainEntry,
  type PanoChainFlag,
} from "./panoChain";
import { getPointAtDistance } from "./routeSampler";
import type { PanoChainRange } from "./panoChainSegments";
import { totalDistance } from "./routeLoader";
import {
  bearingBetween,
  distanceBetweenMeters,
  hasIndoorDescription,
  headingDelta,
  isCapturedAlong,
  isOfficialPano,
  locationDescription,
  normalizeHeading,
  projectOntoRoute,
} from "./streetViewController";

/**
 * パノラマ列の自動作成。
 *
 * ルートに沿ってパノラマのリンクだけを辿り、走行時に再生する並びを作る。
 * 走行中の判定と違い時間をかけられるため、リンク候補をすべて検証して比べる。
 * リンクが途切れた所だけ近傍検索で次の撮影列へ乗り継ぎ、「gap」の印を付けて
 * 運営者の確認対象にする。メタデータ取得（StreetViewService）のみで無課金。
 */

/** リンク先がルート線からこの距離を超えたら採用しない [m] */
const MAX_OFF_ROUTE_METERS = 8;
/** 乗り継ぎ（近傍検索）先のルート線からの許容ずれ [m] */
const MAX_SEARCH_OFF_ROUTE_METERS = 12;
/** 1歩でのルートに対する左右位置の最大変化 [m]（並走する別の撮影列への乗り移り防止） */
const MAX_LATERAL_SHIFT_METERS = 6;
/** 1歩の最大移動距離 [m]（異常なワープ防止） */
const MAX_STEP_LENGTH_METERS = 35;
/** 移動方位とルート進行方向の許容差 [deg]（1枚ずつ見るので曲がり角も含めて判定できる） */
const MAX_MOVE_BEARING_DELTA_DEGREES = 60;
/** 最低限の前進距離 [m]（後退・振動防止） */
const MIN_PROGRESS_METERS = 1;
/** 進行方向を求めるときのルート先読み距離 [m] */
const ROUTE_LOOKAHEAD_METERS = 15;
/** ルート終端からこの距離以内に入ったら完成とする [m] */
const END_MARGIN_METERS = 15;
const METERS_PER_DEGREE_LAT = 111_320;
/** 屋外検証の探索半径 [m]（候補位置のOUTDOOR検索で自分自身が返るか） */
const OUTDOOR_VERIFY_RADIUS_METERS = 10;
/** 乗り継ぎ先を探す前方オフセット [m]（近い順に試し、最初に見つかった距離で決める） */
const SEARCH_OFFSETS_METERS = [10, 20, 30, 45, 60, 80, 100, 130, 160, 200];
/**
 * 乗り継ぎ先を探す地点のルート線からの左右オフセット [m]（右が正）。
 * 近傍検索は最寄りの1件しか返さないため、ルート真上で探すと、除外した高架下の
 * パノラマばかりが返り高架上のパノラマが見つからない。左右にずらした地点からも探す
 */
const SEARCH_LATERAL_OFFSETS_METERS = [0, -6, 6, -12, 12];
/** 乗り継ぎ先の探索半径 [m] */
const SEARCH_RADIUS_METERS = 30;
/** 開始地点の探索オフセット [m] */
const START_OFFSETS_METERS = [0, 10, 20, 30, 50, 80, 120];
/**
 * 乗り継ぎ先はこの距離先までの候補を集めて比べる [m]。
 * 最初に見つかった候補が逆向き撮影・別の撮影列で、少し先に本命があることが多い
 */
const SEARCH_COMPARE_WITHIN_METERS = 60;
/**
 * 乗り継ぐ前に、直前で左右に離れていったエントリを取り消す [m]。
 * 撮影列が降り口（ランプ）へ続いていると、離れきってから乗り継ぐため
 * 「降りてから戻る」上下移動になる。基準から離れた末尾を戻してから乗り継ぐ
 */
const BACKTRACK_SIDE_DRIFT_METERS = 1.5;
/** 乗り継ぎ候補が「左右位置も申し分ない」とみなす基準からのずれ [m] */
const IDEAL_SEARCH_SIDE_DELTA_METERS = 3;
/** 取り消すエントリ数の上限 */
const MAX_BACKTRACK_ENTRIES = 8;
/** 乗り継ぎ候補の左右位置の基準に使う直近のエントリ数 */
const RECENT_SIDE_SAMPLES = 5;
/** 要確認の印: 直前からの左右位置の変化 [m] */
const FLAG_SIDE_JUMP_METERS = 3;
/** 要確認の印: ルート線からのずれ [m] */
const FLAG_FAR_FROM_ROUTE_METERS = 6;

/** StreetViewService の必要部分（テストで差し替えられるようにする） */
export type PanoMetadataService = {
  getPanorama(
    request: google.maps.StreetViewLocationRequest | google.maps.StreetViewPanoRequest
  ): Promise<{ data: google.maps.StreetViewPanoramaData }>;
};

export type PanoChainBuildProgress = {
  distanceM: number;
  routeDistanceM: number;
  count: number;
};

export type PanoChainBuildOptions = {
  routeId: string;
  route: Route;
  /** 運営者が除外したパノラマID（辿らない・乗り継がない） */
  excluded?: string[];
  /** この並びの続きから作る（途中から作り直す場合） */
  baseEntries?: PanoChainEntry[];
  onProgress?: (progress: PanoChainBuildProgress) => void;
  signal?: AbortSignal;
  /**
   * 部分的な作り直し用: このパノラマのどれかに辿り着いたら合流して終了する
   * （元の並びの続きにつなげるため）
   */
  joinPanos?: Set<string>;
  /** 部分的な作り直し用: 合流できなくても、この距離まで来たら終了する [m] */
  untilDistanceM?: number;
  /** パノラマ列を作る距離範囲（省略時はルート全体） */
  ranges?: PanoChainRange[];
};

export type PanoChainBuildResult = PanoChain & {
  /** joinPanos のどれに合流したか（合流せずに終わった場合は undefined） */
  joinedPano?: string;
  /** 自動で取り除いた寄り道のエントリ数 */
  removedExcursions?: number;
};

type PanoMeta = {
  pano: string;
  position: google.maps.LatLngLiteral;
  links: Array<{ pano: string; heading: number }>;
  copyright?: string;
  imageDate?: string;
  description?: string;
  captureHeading?: number;
};

type Candidate = {
  meta: PanoMeta;
  distanceM: number;
  sideM: number;
  offsetM: number;
  capturedAlong: boolean;
  sameDate: boolean;
  sideDelta: number;
  bearingDelta: number;
};

function toMeta(
  pano: string,
  data: google.maps.StreetViewPanoramaData
): PanoMeta | null {
  const latLng = data.location?.latLng;
  if (!latLng) return null;
  return {
    pano,
    position: { lat: latLng.lat(), lng: latLng.lng() },
    links: (data.links ?? [])
      .filter(
        (link): link is google.maps.StreetViewLink & {
          pano: string;
          heading: number;
        } => Boolean(link?.pano) && typeof link?.heading === "number"
      )
      .map((link) => ({ pano: link.pano, heading: link.heading })),
    copyright: data.copyright,
    imageDate: data.imageDate,
    description: locationDescription(data.location),
    captureHeading: data.tiles?.centerHeading,
  };
}

/**
 * 屋内・地下の疑いがある説明文か。道路のパノラマには少なくとも「大阪市, 大阪府」の
 * ような説明文が付くため、空の説明文（駅構内などのGoogle撮影屋内パノラマに多い）も疑う
 */
function isSuspiciousDescription(description: string | undefined): boolean {
  return !description || hasIndoorDescription(description);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 候補の並べ替え: 撮影向きが同じ → 撮影時期が同じ → 左右位置が近い → ルート方向に近い */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    Number(b.capturedAlong) - Number(a.capturedAlong) ||
    Number(b.sameDate) - Number(a.sameDate) ||
    a.sideDelta - b.sideDelta ||
    a.bearingDelta - b.bearingDelta
  );
}

export class PanoChainBuilder {
  private service: PanoMetadataService;
  private metaCache = new Map<string, PanoMeta | null>();
  private outdoorCache = new Map<string, boolean>();

  constructor(service: PanoMetadataService) {
    this.service = service;
  }

  async build(options: PanoChainBuildOptions): Promise<PanoChainBuildResult> {
    const { route, routeId, signal } = options;
    const excluded = new Set(options.excluded ?? []);
    const routeDistanceM = totalDistance(route);
    const ranges = options.ranges ?? [{ startM: 0, endM: routeDistanceM }];
    const entries: PanoChainEntry[] = [...(options.baseEntries ?? [])];
    const visited = new Set(entries.map((entry) => entry.pano));
    const minKeep = options.baseEntries?.length ?? 0;

    const report = () =>
      options.onProgress?.({
        distanceM: entries[entries.length - 1]?.distanceM ?? 0,
        routeDistanceM,
        count: entries.length,
      });
    report();

    let joinedPano: string | undefined;
    let finished = false;
    for (const range of ranges) {
      if (finished) break;
      const lastBase = entries[entries.length - 1];
      // 途中から作り直す場合: 既存の並びで終わっている範囲は飛ばす
      if (lastBase && lastBase.distanceM >= range.endM - END_MARGIN_METERS) continue;

      let current: PanoMeta | null = null;
      if (lastBase && lastBase.distanceM >= range.startM - END_MARGIN_METERS) {
        current = await this.getMeta(lastBase.pano);
      } else {
        // 範囲の始まり: 前の範囲とはつながっていないので、近傍検索で開始する
        const start = await this.findStart(route, excluded, signal, range);
        if (start) {
          entries.push(this.makeEntry(start, null, "search", route));
          visited.add(start.meta.pano);
          current = start.meta;
          report();
        }
      }

      // 範囲の長さに対して十分な上限（無限ループ防止）
      const maxSteps = Math.ceil((range.endM - range.startM) / 2) + 500;
      for (let step = 0; step < maxSteps && current; step += 1) {
        if (signal?.aborted) throw new DOMException("中止しました", "AbortError");
        const last = entries[entries.length - 1];
        if (last.distanceM >= range.endM - END_MARGIN_METERS) break;
        if (
          options.untilDistanceM !== undefined &&
          last.distanceM >= options.untilDistanceM
        ) {
          finished = true;
          break;
        }

        const recentSide = median(
          entries.slice(-RECENT_SIDE_SAMPLES).map((entry) => entry.sideM)
        );
        let next: Candidate | null = await this.nextByLink(
          route,
          current,
          last,
          excluded,
          visited
        );
        let source: PanoChainEntry["source"] = "link";

        let from = last;
        if (!next) {
          // 降り口などへ離れていった末尾を取り消してから乗り継ぐ
          const keep = this.backtrackDrift(entries, minKeep);
          if (keep < entries.length) {
            entries.splice(keep);
            from = entries[entries.length - 1];
          }
          const baseSide = median(
            entries.slice(-RECENT_SIDE_SAMPLES).map((entry) => entry.sideM)
          );
          next = await this.nextBySearch(
            route,
            from,
            baseSide ?? recentSide,
            excluded,
            visited,
            range.endM
          );
          source = "search";
        }
        if (!next) break;

        entries.push(this.makeEntry(next, from, source, route));
        visited.add(next.meta.pano);
        current = next.meta;
        report();
        if (options.joinPanos?.has(next.meta.pano)) {
          joinedPano = next.meta.pano;
          finished = true;
          break;
        }
      }
    }

    return {
      version: 1,
      routeId,
      builtAt: new Date().toISOString(),
      routeDistanceM,
      routePointCount: route.points.length,
      ...(options.ranges ? { ranges: options.ranges } : {}),
      ...this.finishEntries(entries, options),
      excluded: [...excluded],
      joinedPano,
    };
  }

  /**
   * 1〜数枚だけ別の道へ行ってすぐ戻る寄り道を取り除く。
   * 部分的な作り直し（合流して続きをつなぐ）では、つなぐ前に全体で行うため対象外
   */
  private finishEntries(
    entries: PanoChainEntry[],
    options: PanoChainBuildOptions
  ): { entries: PanoChainEntry[]; removedExcursions: number } {
    if (options.joinPanos) return { entries, removedExcursions: 0 };
    const result = removeShortExcursions(entries);
    return { entries: result.entries, removedExcursions: result.removedCount };
  }

  /**
   * 末尾のリンクエントリのうち、それ以前の基準（中央値）から左右に離れていったものを
   * 取り消した後の長さを返す。minKeep 件（作り直しで残す分）より短くはしない
   */
  private backtrackDrift(entries: PanoChainEntry[], minKeep: number): number {
    let keep = entries.length;
    const floor = Math.max(minKeep, 1, entries.length - MAX_BACKTRACK_ENTRIES);
    while (keep - 1 >= floor) {
      const tail = entries[keep - 1];
      if (tail.source !== "link") break;
      const baseline = median(
        entries
          .slice(Math.max(0, keep - 1 - RECENT_SIDE_SAMPLES), keep - 1)
          .map((entry) => entry.sideM)
      );
      if (baseline === null) break;
      if (Math.abs(tail.sideM - baseline) <= BACKTRACK_SIDE_DRIFT_METERS) break;
      keep -= 1;
    }
    return keep;
  }

  /** リンクから次のパノラマを選ぶ。前進できなければ、前進しない1枚（交差点中央など）を経由できるか試す */
  private async nextByLink(
    route: Route,
    current: PanoMeta,
    last: PanoChainEntry,
    excluded: Set<string>,
    visited: Set<string>
  ): Promise<Candidate | null> {
    const forward: Candidate[] = [];
    const stalls: Candidate[] = [];

    for (const link of current.links) {
      if (excluded.has(link.pano) || visited.has(link.pano)) continue;
      const candidate = await this.evaluate(route, current, last, link.pano);
      if (!candidate) continue;
      if (candidate.distanceM >= last.distanceM + MIN_PROGRESS_METERS) {
        forward.push(candidate);
      } else if (candidate.distanceM >= last.distanceM - 2) {
        stalls.push(candidate);
      }
    }

    if (forward.length > 0) return forward.sort(compareCandidates)[0];

    for (const stall of stalls.sort(compareCandidates)) {
      const stallEntry: PanoChainEntry = {
        ...last,
        pano: stall.meta.pano,
        lat: stall.meta.position.lat,
        lng: stall.meta.position.lng,
        sideM: stall.sideM,
      };
      for (const link of stall.meta.links) {
        if (
          link.pano === current.pano ||
          excluded.has(link.pano) ||
          visited.has(link.pano)
        ) {
          continue;
        }
        const onward = await this.evaluate(route, stall.meta, stallEntry, link.pano);
        if (onward && onward.distanceM >= last.distanceM + MIN_PROGRESS_METERS) {
          return { ...stall, distanceM: Math.max(stall.distanceM, last.distanceM) };
        }
      }
    }
    return null;
  }

  /** リンク先候補を検証し、合格なら候補情報を返す */
  private async evaluate(
    route: Route,
    from: PanoMeta,
    fromEntry: PanoChainEntry,
    panoId: string
  ): Promise<Candidate | null> {
    const meta = await this.getMeta(panoId);
    if (!meta) return null;
    if (!isOfficialPano(panoId, meta.copyright)) return null;
    if (distanceBetweenMeters(from.position, meta.position) > MAX_STEP_LENGTH_METERS) {
      return null;
    }

    const projection = projectOntoRoute(route, meta.position, fromEntry.distanceM);
    if (projection.offsetM > MAX_OFF_ROUTE_METERS) return null;
    if (Math.abs(projection.sideM - fromEntry.sideM) > MAX_LATERAL_SHIFT_METERS) {
      return null;
    }

    const desiredHeading = this.routeHeadingAhead(route, from.position, fromEntry.distanceM);
    const moveBearing = bearingBetween(from.position, meta.position);
    const bearingDelta = headingDelta(moveBearing, desiredHeading);
    const progress = projection.distanceM - fromEntry.distanceM;
    // 前進する候補だけ方位を確認する（交差点中央など前進しない経由候補は別扱い）
    if (progress >= MIN_PROGRESS_METERS && bearingDelta > MAX_MOVE_BEARING_DELTA_DEGREES) {
      return null;
    }

    if (isSuspiciousDescription(meta.description)) return null;
    if (!(await this.isOutdoor(meta))) return null;

    return {
      meta,
      distanceM: projection.distanceM,
      sideM: projection.sideM,
      offsetM: projection.offsetM,
      capturedAlong: isCapturedAlong(meta.captureHeading, desiredHeading),
      sameDate:
        fromEntry.imageDate === undefined ||
        meta.imageDate === undefined ||
        meta.imageDate === fromEntry.imageDate,
      sideDelta: Math.abs(projection.sideM - fromEntry.sideM),
      bearingDelta,
    };
  }

  /** リンクが途切れたとき、少し先を近傍検索して次の撮影列へ乗り継ぐ */
  private async nextBySearch(
    route: Route,
    last: PanoChainEntry,
    recentSide: number | null,
    excluded: Set<string>,
    visited: Set<string>,
    routeDistanceM: number
  ): Promise<Candidate | null> {
    const candidates: Candidate[] = [];
    for (const offset of SEARCH_OFFSETS_METERS) {
      const queryDistance = Math.min(last.distanceM + offset, routeDistanceM);
      const nearEnd = queryDistance >= routeDistanceM - END_MARGIN_METERS * 2;

      for (const meta of await this.searchAround(route, queryDistance)) {
        if (excluded.has(meta.pano) || visited.has(meta.pano)) continue;
        if (candidates.some((candidate) => candidate.meta.pano === meta.pano)) {
          continue;
        }
        if (!isOfficialPano(meta.pano, meta.copyright)) continue;
        if (isSuspiciousDescription(meta.description)) continue;

        const projection = projectOntoRoute(route, meta.position, queryDistance);
        if (projection.offsetM > MAX_SEARCH_OFF_ROUTE_METERS) continue;
        if (projection.distanceM < last.distanceM + MIN_PROGRESS_METERS) continue;

        const entryHere: PanoChainEntry = {
          ...last,
          pano: meta.pano,
          lat: meta.position.lat,
          lng: meta.position.lng,
          distanceM: projection.distanceM,
          sideM: projection.sideM,
          imageDate: meta.imageDate,
        };
        // 行き止まり（駅改札・高架下の袋小路など）へは乗り継がない
        if (!nearEnd && !(await this.hasForwardLink(route, meta, entryHere, excluded))) {
          continue;
        }

        const desiredHeading = getPointAtDistance(route, queryDistance).heading;
        candidates.push({
          meta,
          distanceM: projection.distanceM,
          sideM: projection.sideM,
          offsetM: projection.offsetM,
          capturedAlong: isCapturedAlong(meta.captureHeading, desiredHeading),
          sameDate:
            last.imageDate === undefined ||
            meta.imageDate === undefined ||
            meta.imageDate === last.imageDate,
          sideDelta:
            recentSide === null ? 0 : Math.abs(projection.sideM - recentSide),
          bearingDelta: 0,
        });
      }

      // 撮影向き・左右位置とも申し分ない候補があれば、その時点で決める。
      // なければ SEARCH_COMPARE_WITHIN_METERS まで集めて比べ、それでもなければさらに先を探す
      const ideal = candidates.some(
        (candidate) =>
          candidate.capturedAlong &&
          candidate.sideDelta <= IDEAL_SEARCH_SIDE_DELTA_METERS
      );
      if (
        candidates.length > 0 &&
        (ideal || offset >= SEARCH_COMPARE_WITHIN_METERS)
      ) {
        break;
      }
    }
    if (candidates.length === 0) return null;
    return candidates.sort(
      (a, b) =>
        compareCandidates(a, b) ||
        a.distanceM - b.distanceM ||
        a.offsetM - b.offsetM
    )[0];
  }

  private async hasForwardLink(
    route: Route,
    meta: PanoMeta,
    entry: PanoChainEntry,
    excluded: Set<string>
  ): Promise<boolean> {
    for (const link of meta.links) {
      if (excluded.has(link.pano)) continue;
      const candidate = await this.evaluate(route, meta, entry, link.pano);
      if (candidate && candidate.distanceM >= entry.distanceM + MIN_PROGRESS_METERS) {
        return true;
      }
    }
    return false;
  }

  private async findStart(
    route: Route,
    excluded: Set<string>,
    signal: AbortSignal | undefined,
    range: PanoChainRange
  ): Promise<Candidate | null> {
    for (const offset of START_OFFSETS_METERS) {
      if (signal?.aborted) throw new DOMException("中止しました", "AbortError");
      const queryDistance = Math.min(range.startM + offset, range.endM);
      for (const meta of await this.searchAround(route, queryDistance)) {
        if (excluded.has(meta.pano)) continue;
        if (!isOfficialPano(meta.pano, meta.copyright)) continue;
        if (isSuspiciousDescription(meta.description)) continue;
        const projection = projectOntoRoute(route, meta.position, queryDistance);
        if (projection.offsetM > MAX_SEARCH_OFF_ROUTE_METERS) continue;

        const entry: PanoChainEntry = {
          pano: meta.pano,
          lat: meta.position.lat,
          lng: meta.position.lng,
          distanceM: projection.distanceM,
          sideM: projection.sideM,
          imageDate: meta.imageDate,
          source: "search",
          flags: [],
        };
        if (!(await this.hasForwardLink(route, meta, entry, excluded))) continue;

        return {
          meta,
          distanceM: projection.distanceM,
          sideM: projection.sideM,
          offsetM: projection.offsetM,
          capturedAlong: isCapturedAlong(
            meta.captureHeading,
            getPointAtDistance(route, queryDistance).heading
          ),
          sameDate: true,
          sideDelta: 0,
          bearingDelta: 0,
        };
      }
    }
    return null;
  }

  private makeEntry(
    candidate: Candidate,
    previous: PanoChainEntry | null,
    source: PanoChainEntry["source"],
    route: Route
  ): PanoChainEntry {
    const flags: PanoChainFlag[] = [];
    if (previous && source === "search") flags.push("gap");
    if (previous && Math.abs(candidate.sideM - previous.sideM) > FLAG_SIDE_JUMP_METERS) {
      flags.push("sideJump");
    }
    if (Math.abs(candidate.sideM) > FLAG_FAR_FROM_ROUTE_METERS) {
      flags.push("farFromRoute");
    }
    const routeHeading = getPointAtDistance(route, candidate.distanceM).heading;
    if (!isCapturedAlong(candidate.meta.captureHeading, routeHeading)) {
      flags.push("captureOpposite");
    }

    return {
      pano: candidate.meta.pano,
      lat: candidate.meta.position.lat,
      lng: candidate.meta.position.lng,
      distanceM: Math.max(candidate.distanceM, previous?.distanceM ?? 0),
      sideM: candidate.sideM,
      imageDate: candidate.meta.imageDate,
      description: candidate.meta.description,
      source,
      flags,
    };
  }

  private routeHeadingAhead(
    route: Route,
    position: google.maps.LatLngLiteral,
    distanceM: number
  ): number {
    const ahead = getPointAtDistance(
      route,
      Math.min(distanceM + ROUTE_LOOKAHEAD_METERS, totalDistance(route))
    );
    if (distanceBetweenMeters(position, ahead) < 1) {
      return normalizeHeading(ahead.heading);
    }
    return bearingBetween(position, { lat: ahead.lat, lng: ahead.lng });
  }

  private async getMeta(panoId: string): Promise<PanoMeta | null> {
    const cached = this.metaCache.get(panoId);
    if (cached !== undefined) return cached;
    let meta: PanoMeta | null;
    try {
      const { data } = await this.service.getPanorama({ pano: panoId });
      meta = toMeta(panoId, data);
    } catch {
      meta = null;
    }
    this.metaCache.set(panoId, meta);
    return meta;
  }

  /**
   * ルート上の地点と、その左右にずらした地点で近傍検索し、見つかったパノラマを
   * 重複なく返す（ルートに近い地点の結果から順）
   */
  private async searchAround(route: Route, distanceM: number): Promise<PanoMeta[]> {
    const point = getPointAtDistance(route, distanceM);
    const headingRad = (point.heading * Math.PI) / 180;
    const latScale = Math.cos((point.lat * Math.PI) / 180);
    const results: PanoMeta[] = [];
    for (const lateral of SEARCH_LATERAL_OFFSETS_METERS) {
      // 進行方向の右向き単位ベクトル（東, 北）= (cos h, -sin h)
      const east = Math.cos(headingRad) * lateral;
      const north = -Math.sin(headingRad) * lateral;
      const meta = await this.searchNear(
        {
          lat: point.lat + north / METERS_PER_DEGREE_LAT,
          lng: point.lng + east / (METERS_PER_DEGREE_LAT * latScale),
        },
        SEARCH_RADIUS_METERS
      );
      if (meta && !results.some((result) => result.pano === meta.pano)) {
        results.push(meta);
      }
    }
    return results;
  }

  private async searchNear(
    location: google.maps.LatLngLiteral,
    radius: number
  ): Promise<PanoMeta | null> {
    try {
      const { data } = await this.service.getPanorama({
        location,
        radius,
        source: google.maps.StreetViewSource.OUTDOOR,
      });
      const pano = data.location?.pano;
      if (!pano) return null;
      const meta = toMeta(pano, data);
      if (meta && !this.metaCache.has(pano)) this.metaCache.set(pano, meta);
      return meta;
    } catch {
      return null;
    }
  }

  /** 候補位置をOUTDOORで検索し、自分自身が返れば屋外とみなす */
  private async isOutdoor(meta: PanoMeta): Promise<boolean> {
    const cached = this.outdoorCache.get(meta.pano);
    if (cached !== undefined) return cached;
    let outdoor: boolean;
    try {
      const { data } = await this.service.getPanorama({
        location: meta.position,
        radius: OUTDOOR_VERIFY_RADIUS_METERS,
        source: google.maps.StreetViewSource.OUTDOOR,
      });
      outdoor = data.location?.pano === meta.pano;
    } catch {
      outdoor = false;
    }
    this.outdoorCache.set(meta.pano, outdoor);
    return outdoor;
  }
}
