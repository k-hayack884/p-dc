import { describe, expect, it } from "vitest";
import {
  distanceAlongRoute,
  locatePointsOnRoute,
  mergeRanges,
  rangesFromSegments,
  rangesFromSettings,
  totalRangeDistance,
} from "./panoChainSegments";
import type { Route } from "../types";

const METERS_PER_DEGREE_LAT = 111_320;

/** 北へ lengthM のまっすぐなルート（100m間隔） */
function northRoute(lengthM: number): Route {
  const points = [];
  for (let y = 0; y <= lengthM; y += 100) {
    points.push({
      lat: 34.7 + y / METERS_PER_DEGREE_LAT,
      lng: 135.5,
      distance: y,
      elevation: 0,
      grade: 0,
      heading: 0,
    });
  }
  return { name: "t", intervalMeters: 100, points };
}

const at = (y: number) => ({ lat: 34.7 + y / METERS_PER_DEGREE_LAT, lng: 135.5 });

describe("locatePointsOnRoute", () => {
  it("出発地は0、目的地は総距離、経由地はルート上の距離になる", () => {
    const distances = locatePointsOnRoute(northRoute(3000), [
      at(0),
      at(1200),
      at(2500),
      at(3000),
    ]);
    expect(distances[0]).toBe(0);
    expect(distances[1]).toBeCloseTo(1200, 0);
    expect(distances[2]).toBeCloseTo(2500, 0);
    expect(distances[3]).toBe(3000);
  });

  it("座標のない地点（地名入力）は null", () => {
    expect(locatePointsOnRoute(northRoute(1000), [at(0), null, at(1000)])[1]).toBeNull();
  });
});

describe("rangesFromSegments", () => {
  it("すべて選択ならルート全体（undefined）", () => {
    expect(rangesFromSegments([0, 1000, 2000], [true, true])).toBeUndefined();
  });

  it("大阪→守口と伏見→京都だけ選ぶと、2つの範囲になる", () => {
    // 大阪 0 / 守口 10km / 枚方 20km / 淀 30km / 伏見 40km / 京都 48km
    const distances = [0, 10000, 20000, 30000, 40000, 48000];
    const ranges = rangesFromSegments(distances, [true, false, false, false, true]);
    expect(ranges).toEqual([
      { startM: 0, endM: 10000 },
      { startM: 40000, endM: 48000 },
    ]);
    expect(totalRangeDistance(ranges!)).toBe(18000);
  });

  it("隣り合う選択区間はつなげる", () => {
    expect(rangesFromSegments([0, 100, 200, 300], [true, true, false])).toEqual([
      { startM: 0, endM: 200 },
    ]);
  });

  it("何も選ばなければ空（パノラマ列を使わない）", () => {
    expect(rangesFromSegments([0, 100, 200], [false, false])).toEqual([]);
  });
});

describe("mergeRanges", () => {
  it("重なる・接する範囲をつなげて開始順に並べる", () => {
    expect(
      mergeRanges([
        { startM: 500, endM: 800 },
        { startM: 0, endM: 200 },
        { startM: 150, endM: 300 },
        { startM: 800, endM: 900 },
      ])
    ).toEqual([
      { startM: 0, endM: 300 },
      { startM: 500, endM: 900 },
    ]);
  });
});

describe("rangesFromSettings", () => {
  it("経由地のないルートでも距離指定で局所的な区間を選べる", () => {
    // 地点は出発地・目的地のみ（区間1つ）、その区間はオフ
    expect(
      rangesFromSettings([0, 48000], {
        segments: [false],
        extraRanges: [
          { startM: 40000, endM: 48000 },
          { startM: 0, endM: 10000 },
        ],
      })
    ).toEqual([
      { startM: 0, endM: 10000 },
      { startM: 40000, endM: 48000 },
    ]);
  });

  it("地点の間の選択と距離指定を合わせる", () => {
    expect(
      rangesFromSettings([0, 10000, 48000], {
        segments: [true, false],
        extraRanges: [{ startM: 9000, endM: 12000 }],
      })
    ).toEqual([{ startM: 0, endM: 12000 }]);
  });

  it("地点の間がすべてオンならルート全体", () => {
    expect(
      rangesFromSettings([0, 48000], { segments: [true], extraRanges: [] })
    ).toBeUndefined();
  });
});

describe("distanceAlongRoute", () => {
  it("地図でクリックした位置のルート上の距離を返す", () => {
    expect(distanceAlongRoute(northRoute(3000), at(1700))).toBeCloseTo(1700, 0);
  });
});
