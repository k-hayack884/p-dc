import { describe, expect, it } from "vitest";
import {
  groupReviewSections,
  removeShortExcursions,
  reviewFlags,
  type PanoChainEntry,
} from "./panoChain";

/** 10m間隔のエントリ。spec: [左右位置, 撮影時期, 区切り] */
function entriesOf(
  spec: Array<[number, string, ("search" | "sideJump")?]>
): PanoChainEntry[] {
  return spec.map(([sideM, imageDate, boundary], index) => ({
    pano: `p${index}`,
    lat: 0,
    lng: 0,
    distanceM: index * 10,
    sideM,
    imageDate,
    source: boundary === "search" ? "search" : "link",
    flags:
      boundary === "search"
        ? ["gap"]
        : boundary === "sideJump"
          ? ["sideJump"]
          : [],
  }));
}

describe("removeShortExcursions", () => {
  it("1〜2枚だけ別の道へ行ってすぐ戻る寄り道を取り除く", () => {
    const entries = entriesOf([
      [-1, "2025-08"],
      [-1, "2025-08"],
      [-1, "2025-08"],
      [-8, "2025-12", "search"], // 下道へ
      [-8, "2025-12"],
      [-1, "2025-08", "search"], // すぐ高架へ戻る
      [-1, "2025-08"],
      [-1, "2025-08"],
    ]);

    const result = removeShortExcursions(entries);

    expect(result.removedCount).toBe(2);
    expect(result.entries.map((entry) => entry.pano)).toEqual([
      "p0", "p1", "p2", "p5", "p6", "p7",
    ]);
    // つなぎ目は直前と同じ道なので要確認の印は付けない（再生時は直接移動）
    expect(result.entries[3]).toMatchObject({ source: "search", flags: [] });
  });

  it("長く続く別の道（高架の画像がない区間の下道）は残す", () => {
    const entries = entriesOf([
      [-1, "2025-08"],
      [-1, "2025-08"],
      [-8, "2025-12", "search"],
      [-8, "2025-12"],
      [-8, "2025-12"],
      [-8, "2025-12"],
      [-8, "2025-12"],
      [-1, "2025-08", "search"],
      [-1, "2025-08"],
    ]);

    const result = removeShortExcursions(entries);

    expect(result.removedCount).toBe(0);
    expect(result.entries).toHaveLength(entries.length);
  });

  it("前後が別の道なら（道が切り替わっただけなので）取り除かない", () => {
    const entries = entriesOf([
      [-1, "2025-08"],
      [-1, "2025-08"],
      [3, "2024-01", "search"],
      [3, "2024-01"],
      [8, "2026-01", "search"],
      [8, "2026-01"],
    ]);

    expect(removeShortExcursions(entries).removedCount).toBe(0);
  });

  it("取り除くと前後の間が70mを超える場合は取り除かない", () => {
    const entries = entriesOf([
      [-1, "2025-08"],
      [-8, "2025-12", "search"],
      [-1, "2025-08", "search"],
    ]).map((entry, index) => ({ ...entry, distanceM: index * 40 }));

    expect(removeShortExcursions(entries).removedCount).toBe(0);
  });
});

describe("groupReviewSections", () => {
  it("近い要確認エントリを1区間にまとめる", () => {
    const entries = entriesOf([
      [0, "a"],
      [0, "a", "search"],
      [0, "a"],
      [5, "a", "sideJump"],
      [5, "a"],
      [5, "a"],
      [5, "a"],
      [5, "a"],
      [0, "a", "search"],
    ]);

    expect(
      groupReviewSections(entries).map((section) => [
        section.startIndex,
        section.endIndex,
      ])
    ).toEqual([
      [1, 3],
      [8, 8],
    ]);
  });
});

describe("reviewFlags", () => {
  it("保存済みデータに残っている撮影時期の変化は表示しない", () => {
    const [entry] = entriesOf([[0, "a", "search"]]);
    expect(reviewFlags({ ...entry, flags: ["gap", "dateChange"] })).toEqual(["gap"]);
  });
});
