import type { Route } from "../types";
import type { PanoChainRange } from "./panoChainSegments";

/**
 * パノラマ列（事前作り込み）のデータ型と純粋関数。
 *
 * 走行中にパノラマを探すと、高架/高架下・橋/河川敷・道路/地下駅のように
 * 平面上で重なる場所を取り違える。そこでルートごとにパノラマの並びを
 * 事前に組み、運営者が確認・修正したものを走行時に順に再生する。
 */

/** 要確認の印 */
export type PanoChainFlag =
  /** リンクが途切れ、近傍検索で次の撮影列へ乗り継いだ（高さの入れ替わりが起きやすい） */
  | "gap"
  /**
   * 撮影時期が直前と変わった（旧データ互換のため型に残す。撮影時期の変化は頻繁に起こるため、
   * 現在は付けず、表示もしない）
   */
  | "dateChange"
  /** 直前からルートに対する左右位置が大きく変わった */
  | "sideJump"
  /** ルート線から離れている */
  | "farFromRoute"
  /** 撮影車がルートと逆向きに走っていた（反対車線・一方通行の逆方向の可能性） */
  | "captureOpposite";

export type PanoChainEntry = {
  pano: string;
  lat: number;
  lng: number;
  /** ルート累積距離 [m] */
  distanceM: number;
  /** ルート線に対する符号付きずれ [m]（進行方向の右が正） */
  sideM: number;
  imageDate?: string;
  description?: string;
  /** link: 直前とリンクでつながる / search: 近傍検索で乗り継いだ（先頭も search） */
  source: "link" | "search";
  flags: PanoChainFlag[];
};

export type PanoChain = {
  version: 1;
  routeId: string;
  builtAt: string;
  /** 作成時のルート総距離 [m]（ルートが作り直されたかの判定用） */
  routeDistanceM: number;
  /** 作成時のルート点数（同上） */
  routePointCount: number;
  entries: PanoChainEntry[];
  /** 運営者が除外したパノラマID */
  excluded: string[];
  /**
   * パノラマ列を作った距離範囲（省略時はルート全体）。
   * 範囲外は走行中の探索方式で走る
   */
  ranges?: PanoChainRange[];
};

export const PANO_CHAIN_FLAG_LABELS: Record<PanoChainFlag, string> = {
  gap: "リンク途切れ（乗り継ぎ）",
  dateChange: "撮影時期の変化",
  sideJump: "左右位置の急変",
  farFromRoute: "ルートから離れている",
  captureOpposite: "逆向きの撮影",
};

/** 確認を強く勧める印（高さの入れ替わり・逆走が起きやすい） */
const MAJOR_FLAGS: PanoChainFlag[] = ["gap", "sideJump", "captureOpposite"];

/** 確認画面に表示する印（撮影時期の変化は頻繁に起こるため除く） */
export function reviewFlags(entry: PanoChainEntry): PanoChainFlag[] {
  return entry.flags.filter((flag) => flag !== "dateChange");
}

export function isMajorFlagged(entry: PanoChainEntry): boolean {
  return entry.flags.some((flag) => MAJOR_FLAGS.includes(flag));
}

/** distanceM 以下で最も先にあるエントリの添字（先頭より手前なら0） */
export function findChainIndexAtDistance(
  entries: PanoChainEntry[],
  distanceM: number
): number {
  let low = 0;
  let high = entries.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (entries[mid].distanceM <= distanceM) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** ルートが作り直されていて、パノラマ列が古くなっていないか */
export function isChainStale(chain: PanoChain, route: Route): boolean {
  const lastDistance = route.points[route.points.length - 1]?.distance ?? 0;
  return (
    chain.routePointCount !== route.points.length ||
    Math.abs(chain.routeDistanceM - lastDistance) > 1
  );
}

/** 要確認区間（連続する要確認エントリをまとめたもの） */
export type PanoChainReviewSection = {
  startIndex: number;
  endIndex: number;
  startM: number;
  endM: number;
  flags: PanoChainFlag[];
};

/** この件数以内の切れ目は同じ要確認区間としてまとめる */
const SECTION_MERGE_GAP_ENTRIES = 3;

/**
 * 確認を強く勧める印（gap・左右位置の急変・逆向き撮影）が付いたエントリを、
 * 近いもの同士でまとめて要確認区間にする。1枚ずつ並べると数が多すぎるため
 */
export function groupReviewSections(
  entries: PanoChainEntry[]
): PanoChainReviewSection[] {
  const sections: PanoChainReviewSection[] = [];
  entries.forEach((entry, index) => {
    if (!isMajorFlagged(entry)) return;
    const last = sections[sections.length - 1];
    if (last && index - last.endIndex <= SECTION_MERGE_GAP_ENTRIES) {
      last.endIndex = index;
      last.endM = entry.distanceM;
      reviewFlags(entry).forEach((flag) => {
        if (!last.flags.includes(flag)) last.flags.push(flag);
      });
      return;
    }
    sections.push({
      startIndex: index,
      endIndex: index,
      startM: entry.distanceM,
      endM: entry.distanceM,
      flags: reviewFlags(entry),
    });
  });
  return sections;
}

/** 寄り道とみなす最大エントリ数 */
const EXCURSION_MAX_ENTRIES = 3;
/** 寄り道とみなす最大の長さ [m] */
const EXCURSION_MAX_SPAN_METERS = 35;
/** 寄り道を取り除いた後、前後をつなぐ距離の上限 [m]（長い飛びは作らない） */
const EXCURSION_MAX_BRIDGE_METERS = 70;
/** 前後が「同じ道」とみなす左右位置の差 [m] */
const EXCURSION_SAME_SIDE_METERS = 3;
/** 寄り道が前の道と「違う道」とみなす左右位置の差 [m] */
const EXCURSION_DIFFERENT_SIDE_METERS = 2;

/** 乗り継ぎ・左右位置の急変で区切ったまとまりの [開始, 終了] 添字 */
function splitRuns(entries: PanoChainEntry[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  entries.forEach((entry, index) => {
    const boundary =
      index === 0 ||
      entry.source === "search" ||
      entry.flags.includes("sideJump");
    if (boundary) runs.push([index, index]);
    else runs[runs.length - 1][1] = index;
  });
  return runs;
}

function medianSide(entries: PanoChainEntry[]): number {
  const sorted = entries.map((entry) => entry.sideM).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * 1〜数枚だけ別の道（高架下・側道・反対車線など）へ行ってすぐ戻る「寄り道」を取り除く。
 * 前後のまとまり同士は同じ道（左右位置が近い・撮影時期が同じ）なのに、
 * 間の短いまとまりだけ左右位置か撮影時期が違う場合に寄り道とみなす。
 * 長く続く別の道はそのまま残す（高架の画像がない区間は下道を走る）。
 */
export function removeShortExcursions(entries: PanoChainEntry[]): {
  entries: PanoChainEntry[];
  removedCount: number;
} {
  let current = entries;
  let removedCount = 0;

  for (let guard = 0; guard < 1000; guard += 1) {
    const runs = splitRuns(current);
    let target: [number, number] | null = null;

    for (let r = 1; r < runs.length - 1; r += 1) {
      const [start, end] = runs[r];
      const short = current.slice(start, end + 1);
      const span = short[short.length - 1].distanceM - short[0].distanceM;
      if (short.length > EXCURSION_MAX_ENTRIES || span > EXCURSION_MAX_SPAN_METERS) {
        continue;
      }
      const before = current[start - 1];
      const after = current[end + 1];
      if (after.distanceM - before.distanceM > EXCURSION_MAX_BRIDGE_METERS) continue;

      const neighborsAgree =
        Math.abs(before.sideM - after.sideM) <= EXCURSION_SAME_SIDE_METERS ||
        (before.imageDate !== undefined && before.imageDate === after.imageDate);
      const shortSide = medianSide(short);
      const shortDiffers =
        Math.abs(shortSide - before.sideM) > EXCURSION_DIFFERENT_SIDE_METERS ||
        short.every(
          (entry) =>
            entry.imageDate !== undefined &&
            entry.imageDate !== before.imageDate &&
            entry.imageDate !== after.imageDate
        );
      if (neighborsAgree && shortDiffers) {
        target = [start, end];
        break;
      }
    }

    if (!target) break;
    const [start, end] = target;
    const before = current[start - 1];
    const after = current[end + 1];
    // つなぎ目は直前（寄り道の手前）と比べて印を付け直す。隣接しないので再生時は直接移動する
    const flags: PanoChainFlag[] = after.flags.filter(
      (flag) => flag !== "gap" && flag !== "sideJump" && flag !== "dateChange"
    );
    if (Math.abs(after.sideM - before.sideM) > EXCURSION_SAME_SIDE_METERS) {
      flags.unshift("sideJump");
    }
    const bridged: PanoChainEntry = { ...after, source: "search", flags };
    current = [...current.slice(0, start), bridged, ...current.slice(end + 2)];
    removedCount += end - start + 1;
  }

  return { entries: current, removedCount };
}

export type PanoChainSummary = {
  count: number;
  gapCount: number;
  /** 要確認区間の数 */
  majorCount: number;
  /** 最後のエントリまでの距離 / ルート総距離 */
  coverage: number;
};

export function summarizeChain(
  chain: PanoChain,
  routeDistanceM = chain.routeDistanceM
): PanoChainSummary {
  const last = chain.entries[chain.entries.length - 1];
  // 範囲指定がある場合は、最後の範囲の終わりまで届いたかで見る
  const targetEndM = chain.ranges?.length
    ? chain.ranges[chain.ranges.length - 1].endM
    : routeDistanceM;
  return {
    count: chain.entries.length,
    gapCount: chain.entries.filter((entry) => entry.flags.includes("gap"))
      .length,
    majorCount: groupReviewSections(chain.entries).length,
    coverage:
      targetEndM > 0 && last ? Math.min(last.distanceM / targetEndM, 1) : 0,
  };
}

export function isPanoChain(value: unknown): value is PanoChain {
  if (!value || typeof value !== "object") return false;
  const chain = value as Partial<PanoChain>;
  return (
    chain.version === 1 &&
    typeof chain.routeId === "string" &&
    typeof chain.builtAt === "string" &&
    Array.isArray(chain.entries) &&
    Array.isArray(chain.excluded)
  );
}
