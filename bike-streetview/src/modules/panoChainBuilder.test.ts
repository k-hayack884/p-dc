import { beforeEach, describe, expect, it, vi } from "vitest";
import { PanoChainBuilder, type PanoMetadataService } from "./panoChainBuilder";
import { groupMarkedSections, repairPanoChain } from "./panoChainRepair";
import type { Route, RoutePoint } from "../types";

const METERS_PER_DEGREE_LAT = 111_320;
const BASE_LAT = 34.7;
const BASE_LNG = 135.5;

function toLatLng(xMeters: number, yMeters: number) {
  const latScale = Math.cos((BASE_LAT * Math.PI) / 180);
  return {
    lat: BASE_LAT + yMeters / METERS_PER_DEGREE_LAT,
    lng: BASE_LNG + xMeters / (METERS_PER_DEGREE_LAT * latScale),
  };
}

/** 北へ lengthM のまっすぐなルート（10m間隔） */
function makeNorthRoute(lengthM: number): Route {
  const points: RoutePoint[] = [];
  for (let y = 0; y <= lengthM; y += 10) {
    points.push({
      ...toLatLng(0, y),
      distance: y,
      elevation: 0,
      grade: 0,
      heading: 0,
    });
  }
  return { name: "test", intervalMeters: 10, points };
}

type Node = {
  x: number;
  y: number;
  links: string[];
  imageDate?: string;
  description?: string;
  captureHeading?: number;
  indoor?: boolean;
};

/** パノラマグラフを再現する StreetViewService モック */
function mockService(graph: Record<string, Node>): PanoMetadataService {
  const latScale = Math.cos((BASE_LAT * Math.PI) / 180);
  const dataFor = (id: string) => {
    const node = graph[id];
    const p = toLatLng(node.x, node.y);
    return {
      location: {
        pano: id,
        latLng: { lat: () => p.lat, lng: () => p.lng },
        // 道路のパノラマには説明文が付く（空なら屋内の疑いとして扱われる）
        description:
          node.description === undefined
            ? "テスト通, 大阪市, 大阪府"
            : node.description,
      },
      links: node.links.map((target) => {
        const t = graph[target];
        const heading =
          (Math.atan2(t.x - node.x, t.y - node.y) * 180) / Math.PI;
        return { pano: target, heading: (heading + 360) % 360 };
      }),
      copyright: "© Google",
      imageDate: node.imageDate,
      tiles:
        node.captureHeading === undefined
          ? undefined
          : { centerHeading: node.captureHeading },
    } as unknown as google.maps.StreetViewPanoramaData;
  };

  return {
    getPanorama: vi.fn(async (request) => {
      if ("pano" in request && request.pano) {
        if (!graph[request.pano]) throw new Error("NOT_FOUND");
        return { data: dataFor(request.pano) };
      }
      const req = request as google.maps.StreetViewLocationRequest;
      const loc = req.location as google.maps.LatLngLiteral;
      let best: { id: string; d: number } | null = null;
      for (const [id, node] of Object.entries(graph)) {
        if (node.indoor) continue;
        const p = toLatLng(node.x, node.y);
        const d = Math.hypot(
          (p.lat - loc.lat) * METERS_PER_DEGREE_LAT,
          (p.lng - loc.lng) * METERS_PER_DEGREE_LAT * latScale
        );
        if (d <= (req.radius ?? 50) && (!best || d < best.d)) best = { id, d };
      }
      if (!best) throw new Error("ZERO_RESULTS");
      return { data: dataFor(best.id) };
    }),
  };
}

/** 北へ10m間隔のパノラマ列 ids を作り、隣同士を双方向リンクする */
function straightRun(
  prefix: string,
  x: number,
  fromY: number,
  toY: number,
  extra: Partial<Node> = {}
): Record<string, Node> {
  const graph: Record<string, Node> = {};
  for (let y = fromY; y <= toY; y += 10) {
    const links: string[] = [];
    if (y > fromY) links.push(`${prefix}${y - 10}`);
    if (y < toY) links.push(`${prefix}${y + 10}`);
    graph[`${prefix}${y}`] = { x, y, links, ...extra };
  }
  return graph;
}

describe("PanoChainBuilder", () => {
  beforeEach(() => {
    vi.stubGlobal("google", {
      maps: { StreetViewSource: { OUTDOOR: "outdoor" } },
    });
  });

  it("リンクだけで終点まで辿り、印のない並びを作る", async () => {
    const route = makeNorthRoute(100);
    const service = mockService(straightRun("m", 0, 0, 100));

    const chain = await new PanoChainBuilder(service).build({
      routeId: "r1",
      route,
    });

    expect(chain.entries.map((entry) => entry.pano)).toEqual([
      "m0", "m10", "m20", "m30", "m40", "m50", "m60", "m70", "m80", "m90",
    ]);
    expect(chain.entries.every((entry) => entry.flags.length === 0)).toBe(true);
    expect(chain.entries.slice(1).every((entry) => entry.source === "link")).toBe(true);
    expect(chain.routePointCount).toBe(route.points.length);
  });

  it("分岐では本線（左右位置の変化が小さい方）を選び、降り口へは入らない", async () => {
    const route = makeNorthRoute(100);
    const graph = straightRun("m", 0, 0, 100);
    // m30から右へ逸れていく降り口（1歩の左右変化は4m）
    graph.m30.links.push("ramp1");
    graph.ramp1 = { x: 4, y: 40, links: ["m30", "ramp2"] };
    graph.ramp2 = { x: 8, y: 50, links: ["ramp1"] };
    const service = mockService(graph);

    const chain = await new PanoChainBuilder(service).build({
      routeId: "r1",
      route,
    });

    const panos = chain.entries.map((entry) => entry.pano);
    expect(panos).toContain("m40");
    expect(panos).not.toContain("ramp1");
  });

  it("リンクが途切れたら近傍検索で乗り継ぎ、gap の印を付ける", async () => {
    const route = makeNorthRoute(100);
    const graph = {
      ...straightRun("a", 0, 0, 40),
      ...straightRun("b", 1, 60, 100, { imageDate: "2024-01" }),
    };
    const service = mockService(graph);

    const chain = await new PanoChainBuilder(service).build({
      routeId: "r1",
      route,
    });

    const joined = chain.entries.find((entry) => entry.pano === "b60");
    expect(joined?.source).toBe("search");
    expect(joined?.flags).toContain("gap");
    // 撮影時期の変化は頻繁に起こるため要確認の印にしない
    expect(chain.entries.some((entry) => entry.flags.includes("dateChange"))).toBe(false);
    expect(chain.entries[chain.entries.length - 1].distanceM).toBeGreaterThan(85);
  });

  it("除外したパノラマは辿らず、別の撮影列へ乗り継ぐ", async () => {
    const route = makeNorthRoute(100);
    const graph = {
      ...straightRun("up", 0, 0, 100, { imageDate: "2025-08" }),
      // 同じ位置に重なる別の撮影列（高架下の想定）
      ...straightRun("dn", 0.5, 0, 100, { imageDate: "2025-08" }),
    };
    const service = mockService(graph);

    const chain = await new PanoChainBuilder(service).build({
      routeId: "r1",
      route,
      excluded: ["up50"],
      baseEntries: undefined,
    });

    const panos = chain.entries.map((entry) => entry.pano);
    expect(panos).not.toContain("up50");
    expect(chain.excluded).toEqual(["up50"]);
  });

  it("途中までの並びを渡すと、その続きから作り直す", async () => {
    const route = makeNorthRoute(100);
    const service = mockService(straightRun("m", 0, 0, 100));
    const builder = new PanoChainBuilder(service);
    const first = await builder.build({ routeId: "r1", route });

    const rebuilt = await builder.build({
      routeId: "r1",
      route,
      baseEntries: first.entries.slice(0, 3),
    });

    expect(rebuilt.entries.slice(0, 3)).toEqual(first.entries.slice(0, 3));
    expect(rebuilt.entries[3].pano).toBe("m30");
  });

  it("説明文が施設名・駅のパノラマ、屋内パノラマには入らない", async () => {
    const route = makeNorthRoute(60);
    const graph = straightRun("m", 0, 0, 60);
    graph.m20.links.push("station");
    graph.station = {
      x: 0.3,
      y: 30,
      links: ["m20"],
      description: "ホワイティうめだ, 大阪市, 大阪府",
    };
    graph.m20.links.push("indoorPano");
    graph.indoorPano = { x: -0.3, y: 30, links: ["m20"], indoor: true };
    const service = mockService(graph);

    const chain = await new PanoChainBuilder(service).build({
      routeId: "r1",
      route,
    });

    const panos = chain.entries.map((entry) => entry.pano);
    expect(panos).toContain("m30");
    expect(panos).not.toContain("station");
    expect(panos).not.toContain("indoorPano");
  });

  it("撮影向きがルートと同じ撮影列を優先し、逆向きなら captureOpposite の印を付ける", async () => {
    const route = makeNorthRoute(60);
    const graph = {
      ...straightRun("along", -1, 0, 60, { captureHeading: 0 }),
      ...straightRun("oncoming", 1, 0, 60, { captureHeading: 180 }),
    };
    graph.along0.links.push("oncoming10");
    const service = mockService(graph);

    const chain = await new PanoChainBuilder(service).build({
      routeId: "r1",
      route,
    });

    expect(chain.entries.some((entry) => entry.pano.startsWith("oncoming"))).toBe(false);

    const onlyOncoming = await new PanoChainBuilder(
      mockService(straightRun("oncoming", 0, 0, 60, { captureHeading: 180 }))
    ).build({ routeId: "r2", route });
    expect(onlyOncoming.entries[1].flags).toContain("captureOpposite");
  });
  it("説明文が空のパノラマ（駅構内などの屋内に多い）には乗り継がない", async () => {
    const route = makeNorthRoute(100);
    const graph = {
      ...straightRun("a", 0, 0, 40),
      // 10m先に説明文なしの撮影列（地下ホーム想定）、30m先に道路の撮影列
      ...straightRun("platform", 0.5, 50, 70, { description: "" }),
      ...straightRun("b", 1, 70, 100),
    };
    const chain = await new PanoChainBuilder(mockService(graph)).build({
      routeId: "r1",
      route,
    });

    const panos = chain.entries.map((entry) => entry.pano);
    expect(panos.some((pano) => pano.startsWith("platform"))).toBe(false);
    // 近傍検索は最寄り1件しか返らないため、ホームが途切れた先の道路へ乗り継ぐ
    expect(panos.some((pano) => pano.startsWith("b"))).toBe(true);
  });

  it("乗り継ぐ前に、降り口へ離れていった末尾を取り消す（降りてから戻る上下移動の防止）", async () => {
    const route = makeNorthRoute(120);
    const graph: Record<string, Node> = {
      ...straightRun("m", 0, 0, 40),
      // 本線の撮影列がそのまま降り口へ続き、左へ離れていく
      ramp50: { x: -2.5, y: 50, links: ["m40", "ramp60"] },
      ramp60: { x: -5, y: 60, links: ["ramp50", "ramp70"] },
      ramp70: { x: -7.5, y: 70, links: ["ramp60"] },
      // 本線の続きは別の撮影列（リンクなし）
      ...straightRun("main", 0.3, 50, 120, { imageDate: "2025-06" }),
    };
    graph.m40.links.push("ramp50");

    const chain = await new PanoChainBuilder(mockService(graph)).build({
      routeId: "r1",
      route,
    });

    const panos = chain.entries.map((entry) => entry.pano);
    expect(panos.some((pano) => pano.startsWith("ramp"))).toBe(false);
    expect(panos).toContain("main50");
  });

  it("乗り継ぎでは、近くの逆向き撮影より少し先の同じ向きの撮影列を選ぶ", async () => {
    const route = makeNorthRoute(120);
    const graph = {
      ...straightRun("a", 0, 0, 40),
      ...straightRun("oncoming", 2, 50, 60, { captureHeading: 180 }),
      ...straightRun("along", 0, 70, 120, { captureHeading: 0 }),
    };
    const chain = await new PanoChainBuilder(mockService(graph)).build({
      routeId: "r1",
      route,
    });

    const panos = chain.entries.map((entry) => entry.pano);
    expect(panos.some((pano) => pano.startsWith("oncoming"))).toBe(false);
    expect(panos).toContain("along70");
  });
  describe("除外予定のまとめ反映（部分的な作り直し）", () => {
    it("除外予定を連続区間にまとめる", () => {
      const entries = ["a", "b", "c", "d", "e"].map((pano) => ({
        pano,
        lat: 0,
        lng: 0,
        distanceM: 0,
        sideM: 0,
        source: "link" as const,
        flags: [],
      }));
      expect(groupMarkedSections(entries, new Set(["b", "c", "e"]))).toEqual([
        { startIndex: 1, endIndex: 2 },
        { startIndex: 4, endIndex: 4 },
      ]);
    });

    it("除外した区間だけを作り直し、元の並びに合流して続きをそのまま使う", async () => {
      const route = makeNorthRoute(200);
      const graph = {
        ...straightRun("up", 0, 0, 200),
        // 高架下の想定: 同じ位置に重なる別の撮影列（up40〜up60 から乗り移れる）
        ...straightRun("dn", 0.5, 40, 80),
      };
      graph.up30.links.push("dn40");
      graph.dn80.links.push("up90");
      const service = mockService(graph);
      const builder = new PanoChainBuilder(service);
      const original = await builder.build({ routeId: "r1", route });
      // 自動作成が高架下 dn に入ったと仮定した並びを作る
      const wrong = {
        ...original,
        entries: original.entries.map((entry) =>
          entry.pano === "up50" ? { ...entry, pano: "dn50" } : entry
        ),
      };
      const callsBefore = (service.getPanorama as ReturnType<typeof vi.fn>).mock.calls.length;

      const repaired = await repairPanoChain({
        builder,
        chain: wrong,
        route,
        marked: new Set(["dn50"]),
      });

      const panos = repaired.entries.map((entry) => entry.pano);
      expect(panos).not.toContain("dn50");
      expect(panos).toContain("up50");
      expect(panos[panos.length - 1]).toBe(original.entries[original.entries.length - 1].pano);
      expect(repaired.excluded).toContain("dn50");
      // ルート全体を作り直していない（合流後の区間は再取得しない）
      const repairCalls =
        (service.getPanorama as ReturnType<typeof vi.fn>).mock.calls.length - callsBefore;
      expect(repairCalls).toBeLessThan(15);
    });

    it("複数区間をまとめて反映する", async () => {
      const route = makeNorthRoute(200);
      const graph = straightRun("m", 0, 0, 200);
      graph.m20.links.push("alt30");
      graph.alt30 = { x: 0.4, y: 30, links: ["m20", "m40"] };
      graph.m40.links.push("alt30");
      graph.m120.links.push("alt130");
      graph.alt130 = { x: 0.4, y: 130, links: ["m120", "m140"] };
      graph.m140.links.push("alt130");
      const builder = new PanoChainBuilder(mockService(graph));
      const chain = await builder.build({ routeId: "r1", route });

      const repaired = await repairPanoChain({
        builder,
        chain,
        route,
        marked: new Set(["m30", "m130"]),
      });

      const panos = repaired.entries.map((entry) => entry.pano);
      expect(panos).not.toContain("m30");
      expect(panos).not.toContain("m130");
      expect(panos).toContain("alt30");
      expect(panos).toContain("alt130");
      expect(panos).toContain("m190");
    });
  });
  it("除外した高架下がルート真上にあっても、左右にずらして探して高架上へ乗り継ぐ（スキップしない）", async () => {
    const route = makeNorthRoute(200);
    const graph = {
      ...straightRun("up", -3, 0, 40, { imageDate: "2025-08" }),
      // ルート真上の高架下（除外する）
      ...straightRun("dn", 0, 50, 150, { imageDate: "2025-12" }),
      // 高架上の続き（3m左・up40とはリンクなし）
      ...straightRun("up2_", -3, 50, 200, { imageDate: "2025-08" }),
    };
    const excluded = Object.keys(graph).filter((id) => id.startsWith("dn"));

    const chain = await new PanoChainBuilder(mockService(graph)).build({
      routeId: "r1",
      route,
      excluded,
    });

    const panos = chain.entries.map((entry) => entry.pano);
    expect(panos.some((pano) => pano.startsWith("dn"))).toBe(false);
    expect(panos).toContain("up2_50");
    const distances = chain.entries.map((entry) => entry.distanceM);
    const maxJump = Math.max(...distances.slice(1).map((d, i) => d - distances[i]));
    expect(maxJump).toBeLessThan(15);
  });
  it("距離範囲を指定すると、その範囲だけパノラマ列を作る", async () => {
    const route = makeNorthRoute(300);
    const service = mockService(straightRun("m", 0, 0, 300));

    const chain = await new PanoChainBuilder(service).build({
      routeId: "r1",
      route,
      ranges: [
        { startM: 0, endM: 80 },
        { startM: 200, endM: 300 },
      ],
    });

    const distances = chain.entries.map((entry) => entry.distanceM);
    expect(distances.every((d) => d <= 80 || d >= 200)).toBe(true);
    expect(distances.some((d) => d >= 200)).toBe(true);
    // 2つ目の範囲の始まりは乗り継ぎ扱い（隣接しない）だが要確認の印は付けない
    const secondStart = chain.entries.find((entry) => entry.distanceM >= 200)!;
    expect(secondStart.source).toBe("search");
    expect(secondStart.flags).not.toContain("gap");
    expect(chain.ranges).toHaveLength(2);
  });
});
