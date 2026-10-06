import type { Route } from "../types";
import {
  removeShortExcursions,
  type PanoChain,
  type PanoChainEntry,
} from "./panoChain";
import type { PanoChainBuilder, PanoChainBuildProgress } from "./panoChainBuilder";
import { totalDistance } from "./routeLoader";

/**
 * 除外予定の印をまとめて反映する（部分的な作り直し）。
 *
 * 印を付けた区間ごとに、直前のエントリから作り直し、元の並びのどこかへ
 * リンクで合流できた時点で止めて続きをつなぐ。ルート全体は作り直さない。
 */

/** 合流先を探す範囲: 除外区間の直後からこの距離まで作り直しを続ける [m] */
const REPAIR_JOIN_WINDOW_METERS = 300;

function rangeEndContaining(
  chain: PanoChain,
  distanceM: number,
  routeDistanceM: number
): number {
  const range = chain.ranges?.find(
    (item) => distanceM >= item.startM - 1 && distanceM <= item.endM + 1
  );
  return range?.endM ?? routeDistanceM;
}

export type MarkedSection = {
  startIndex: number;
  endIndex: number;
};

/** 除外予定のエントリを連続区間にまとめる */
export function groupMarkedSections(
  entries: PanoChainEntry[],
  marked: Set<string>
): MarkedSection[] {
  const sections: MarkedSection[] = [];
  entries.forEach((entry, index) => {
    if (!marked.has(entry.pano)) return;
    const last = sections[sections.length - 1];
    if (last && last.endIndex === index - 1) {
      last.endIndex = index;
    } else {
      sections.push({ startIndex: index, endIndex: index });
    }
  });
  return sections;
}

export type RepairProgress = {
  /** 処理中の区間（1始まり） */
  section: number;
  sectionCount: number;
  build: PanoChainBuildProgress;
};

export type RepairOptions = {
  builder: PanoChainBuilder;
  chain: PanoChain;
  route: Route;
  /** 除外予定のパノラマID */
  marked: Set<string>;
  onProgress?: (progress: RepairProgress) => void;
  signal?: AbortSignal;
};

export async function repairPanoChain({
  builder,
  chain,
  route,
  marked,
  onProgress,
  signal,
}: RepairOptions): Promise<PanoChain> {
  const excluded = [...new Set([...chain.excluded, ...marked])];
  const sections = groupMarkedSections(chain.entries, marked);
  const routeDistanceM = totalDistance(route);
  let entries = chain.entries;

  // 後ろの区間から直すと、前の区間の添字がずれない
  for (let order = sections.length - 1; order >= 0; order -= 1) {
    const { startIndex, endIndex } = sections[order];
    const prefix = entries.slice(0, startIndex);
    const suffix = entries.slice(endIndex + 1).filter((entry) => !marked.has(entry.pano));
    const sectionNumber = sections.length - order;

    const result = await builder.build({
      routeId: chain.routeId,
      route,
      excluded,
      baseEntries: prefix,
      ranges: chain.ranges,
      joinPanos: new Set(suffix.map((entry) => entry.pano)),
      untilDistanceM: Math.min(
        (suffix[0]?.distanceM ?? routeDistanceM) + REPAIR_JOIN_WINDOW_METERS,
        // 範囲指定がある場合は、除外区間を含む範囲の終わりを越えて作らない
        rangeEndContaining(chain, entries[startIndex]?.distanceM ?? 0, routeDistanceM)
      ),
      signal,
      onProgress: (build) =>
        onProgress?.({ section: sectionNumber, sectionCount: sections.length, build }),
    });

    const rebuilt = result.entries;
    let tail: PanoChainEntry[];
    if (result.joinedPano) {
      const joinIndex = suffix.findIndex((entry) => entry.pano === result.joinedPano);
      tail = suffix.slice(joinIndex + 1);
    } else {
      // 合流できなかった: 作り直した末尾より先の元の並びへ乗り継ぐ
      const lastDistance = rebuilt[rebuilt.length - 1]?.distanceM ?? 0;
      tail = suffix.filter((entry) => entry.distanceM > lastDistance + 1);
      if (tail.length > 0) {
        tail = [
          {
            ...tail[0],
            source: "search",
            flags: tail[0].flags.includes("gap") ? tail[0].flags : ["gap", ...tail[0].flags],
          },
          ...tail.slice(1),
        ];
      }
    }
    entries = [...rebuilt, ...tail];
  }

  return {
    ...chain,
    builtAt: new Date().toISOString(),
    // つなぎ直した結果にも、短い寄り道が残っていれば取り除く
    entries: removeShortExcursions(entries).entries,
    excluded,
  };
}
