import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  StreetViewController,
  isNearTurn,
  projectOntoRoute,
} from "./streetViewController";
import type { Route, RoutePoint } from "../types";

const METERS_PER_DEGREE_LAT = 111_320;
const BASE_LAT = 34.7;
const BASE_LNG = 135.5;

/** ローカル座標（東x[m]・北y[m]）→ 緯度経度 */
function toLatLng(xMeters: number, yMeters: number) {
  const latScale = Math.cos((BASE_LAT * Math.PI) / 180);
  return {
    lat: BASE_LAT + yMeters / METERS_PER_DEGREE_LAT,
    lng: BASE_LNG + xMeters / (METERS_PER_DEGREE_LAT * latScale),
  };
}

/** 区間方位のリストから50m間隔のルートを作る */
function makeRoute(segmentHeadings: number[], spacingM = 50): Route {
  const points: RoutePoint[] = [];
  let x = 0;
  let y = 0;
  points.push({
    ...toLatLng(0, 0),
    distance: 0,
    elevation: 0,
    grade: 0,
    heading: segmentHeadings[0] ?? 0,
  });
  segmentHeadings.forEach((heading, index) => {
    const rad = (heading * Math.PI) / 180;
    x += Math.sin(rad) * spacingM;
    y += Math.cos(rad) * spacingM;
    points.push({
      ...toLatLng(x, y),
      distance: (index + 1) * spacingM,
      elevation: 0,
      grade: 0,
      heading,
    });
  });
  return { name: "test", intervalMeters: spacingM, points };
}

type GraphNode = {
  x: number;
  y: number;
  links: Array<{ pano: string; heading: number }>;
  /** 投稿パノラマを再現する場合に指定（例: "© Taro Yamada"） */
  copyright?: string;
  /** 屋内・地下パノラマを再現する場合にtrue（OUTDOOR検索に現れない） */
  indoor?: boolean;
  /** 撮影年月（撮影列の違いを再現する） */
  imageDate?: string;
  /** 場所の説明文（駅構内などを再現する） */
  description?: string;
};

type PanoGraph = Record<string, GraphNode>;

function latLngFns(xMeters: number, yMeters: number) {
  const p = toLatLng(xMeters, yMeters);
  return { lat: () => p.lat, lng: () => p.lng };
}

/**
 * パノラマグラフを再現するモック。
 * getPanoramaはpano ID指定（メタデータ・無課金）はグラフから自動応答し、
 * location指定（再同期）はテストごとにlocationGetPanoramaへ委譲する。
 */
function setupMockMaps(graph: PanoGraph) {
  const setVisible = vi.fn();
  const setPano = vi.fn();
  const setPosition = vi.fn();
  const setPov = vi.fn();
  const locationGetPanorama = vi.fn();
  const panoramaConstructor = vi.fn();

  const getPanorama = vi.fn(
    async (request: {
      pano?: string;
      location?: { lat: number; lng: number };
      radius?: number;
    }) => {
      if (request.pano !== undefined) {
        const node = graph[request.pano];
        if (!node) throw new Error("NOT_FOUND");
        return {
          data: {
            location: {
              latLng: latLngFns(node.x, node.y),
              description: node.description,
            },
            links: node.links,
            copyright: node.copyright ?? "© Google",
            imageDate: node.imageDate,
          },
        };
      }

      // OUTDOOR屋外検証（半径10m）: 屋内ノードを除く最寄りノードを返す
      if (request.location && request.radius === 10) {
        const latScale = Math.cos((BASE_LAT * Math.PI) / 180);
        let best: { id: string; node: GraphNode; d: number } | null = null;
        for (const [id, node] of Object.entries(graph)) {
          if (node.indoor) continue;
          const p = toLatLng(node.x, node.y);
          const d = Math.hypot(
            (p.lat - request.location.lat) * METERS_PER_DEGREE_LAT,
            (p.lng - request.location.lng) * METERS_PER_DEGREE_LAT * latScale
          );
          if (d <= 10 && (!best || d < best.d)) best = { id, node, d };
        }
        if (!best) throw new Error("ZERO_RESULTS");
        return {
          data: {
            location: {
              latLng: latLngFns(best.node.x, best.node.y),
              pano: best.id,
            },
            links: best.node.links,
            copyright: best.node.copyright ?? "© Google",
          },
        };
      }

      return locationGetPanorama(request);
    }
  );

  const state: {
    node: GraphNode | null;
    position: { lat: number; lng: number } | null;
    pov: { heading: number; pitch: number };
    listeners: Record<string, Array<() => void>>;
  } = {
    node: null,
    position: null,
    pov: { heading: 0, pitch: 0 },
    listeners: {},
  };

  const findNodeAt = (lat: number, lng: number): GraphNode | null => {
    for (const node of Object.values(graph)) {
      const p = toLatLng(node.x, node.y);
      if (Math.abs(p.lat - lat) < 1e-7 && Math.abs(p.lng - lng) < 1e-7) {
        return node;
      }
    }
    return null;
  };

  const fire = (event: string) => {
    queueMicrotask(() => {
      for (const listener of state.listeners[event] ?? []) listener();
    });
  };

  vi.stubGlobal("google", {
    maps: {
      StreetViewSource: { OUTDOOR: "outdoor" },
      StreetViewPanorama: panoramaConstructor.mockImplementation(function (
        _container: HTMLElement,
        options: { pov?: { heading: number; pitch: number } }
      ) {
        if (options.pov) state.pov = options.pov;
        return {
          setVisible,
          setPano: setPano.mockImplementation((panoId: string) => {
            const node = graph[panoId];
            if (!node) return; // 存在しないパノラマは表示されない（links_changedなし）
            state.node = node;
            state.position = toLatLng(node.x, node.y);
            fire("links_changed");
          }),
          setPosition: setPosition.mockImplementation(
            (latLng: { lat: () => number; lng: () => number }) => {
              state.position = { lat: latLng.lat(), lng: latLng.lng() };
              state.node = findNodeAt(state.position.lat, state.position.lng);
              fire("links_changed");
            }
          ),
          getPosition: () => {
            if (!state.position) return null;
            const { lat, lng } = state.position;
            return { lat: () => lat, lng: () => lng };
          },
          getLinks: () => state.node?.links ?? [],
          getPov: () => state.pov,
          setPov: setPov.mockImplementation(
            (pov: { heading: number; pitch: number }) => {
              state.pov = pov;
            }
          ),
          addListener: (event: string, listener: () => void) => {
            (state.listeners[event] ??= []).push(listener);
            return {
              remove: () => {
                state.listeners[event] = (
                  state.listeners[event] ?? []
                ).filter((entry) => entry !== listener);
              },
            };
          },
        };
      }),
      StreetViewService: vi.fn().mockImplementation(function () {
        return { getPanorama };
      }),
    },
  });

  return {
    setVisible,
    setPano,
    setPosition,
    setPov,
    getPanorama,
    locationGetPanorama,
    panoramaConstructor,
    state,
  };
}

describe("projectOntoRoute", () => {
  it("ルート線上へ投影して累積距離とずれを返す", () => {
    const route = makeRoute([0, 0, 0, 0]); // 北へ200m
    const projection = projectOntoRoute(route, toLatLng(10, 75), 50);
    expect(projection.distanceM).toBeCloseTo(75, 0);
    expect(projection.offsetM).toBeCloseTo(10, 0);
  });
});

describe("isNearTurn", () => {
  it("直線区間では曲がり角なしと判定する", () => {
    const route = makeRoute([0, 0, 0, 0]);
    expect(isNearTurn(route, 50)).toBe(false);
  });

  it("先読み範囲内に方位変化があれば曲がり角付近と判定する", () => {
    const route = makeRoute([0, 0, 90, 90]); // 100m地点から東へ
    expect(isNearTurn(route, 95)).toBe(true);
    expect(isNearTurn(route, 20)).toBe(false);
  });
});

describe("StreetViewController（リンク追従・ハイブリッド方式）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("初期表示時に近傍のStreet Viewパノラマへ再同期し、課金1回を通知する", async () => {
    const route = makeRoute([0, 0]);
    const mocks = setupMockMaps({ n0: { x: 0, y: 0, links: [] } });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) }, links: [{ heading: 2 }] },
    });
    const onPanoramaChanged = vi.fn();

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0,
      onPanoramaChanged
    );
    await expect(controller.ready).resolves.toBe(true);

    expect(mocks.locationGetPanorama).toHaveBeenCalledWith({
      location: { lat: route.points[0].lat, lng: route.points[0].lng },
      radius: 50,
      source: "outdoor",
    });
    expect(mocks.panoramaConstructor).toHaveBeenCalledTimes(1);
    expect(controller.panoBillingCount).toBe(1);
    expect(mocks.setPosition).toHaveBeenCalledTimes(1);
    expect(onPanoramaChanged).toHaveBeenCalledWith(
      expect.any(Number),
      { lat: route.points[0].lat, lng: route.points[0].lng },
      { syncDistance: true, billed: true }
    );
  });

  it("初期50mで見つからない場合は探索半径を広げる", async () => {
    const route = makeRoute([0, 0]);
    const mocks = setupMockMaps({});
    mocks.locationGetPanorama
      .mockRejectedValueOnce(new Error("ZERO_RESULTS"))
      .mockResolvedValue({
        data: { location: { latLng: latLngFns(0, 10) } },
      });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await expect(controller.ready).resolves.toBe(true);

    expect(mocks.locationGetPanorama).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ radius: 50 })
    );
    expect(mocks.locationGetPanorama).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ radius: 150 })
    );
  });

  it("なめらかモード（既定）では1枚ずつsetPanoし移動アニメーションを見せる", async () => {
    const route = makeRoute([0, 0, 0, 0]); // 北へ200m
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "n1", heading: 0 }] },
      n1: {
        x: 0,
        y: 10,
        links: [
          { pano: "n0", heading: 180 },
          { pano: "n2", heading: 0 },
        ],
      },
      n2: {
        x: 0,
        y: 20,
        links: [{ pano: "n1", heading: 180 }],
      },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.locationGetPanorama.mockClear();

    controller.setTarget(20);

    await vi.waitFor(() => {
      expect(mocks.setPano).toHaveBeenNthCalledWith(1, "n1");
      expect(mocks.setPano).toHaveBeenNthCalledWith(2, "n2");
    });
    expect(mocks.locationGetPanorama).not.toHaveBeenCalled();
    expect(mocks.panoramaConstructor).toHaveBeenCalledTimes(1);
  });

  it("まとめ移動モードでは約50mごとに、途中のパノラマを短い間隔で順に辿る（暗転防止）", async () => {
    const route = makeRoute([0, 0, 0, 0]); // 北へ200m
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "n1", heading: 0 }] },
      n1: {
        x: 0,
        y: 10,
        links: [
          { pano: "n0", heading: 180 },
          { pano: "n2", heading: 0 },
        ],
      },
      n2: {
        x: 0,
        y: 20,
        links: [
          { pano: "n1", heading: 180 },
          { pano: "n3", heading: 0 },
        ],
      },
      n3: {
        x: 0,
        y: 30,
        links: [
          { pano: "n2", heading: 180 },
          { pano: "n4", heading: 0 },
        ],
      },
      n4: {
        x: 0,
        y: 40,
        links: [
          { pano: "n3", heading: 180 },
          { pano: "n5", heading: 0 },
        ],
      },
      n5: {
        x: 0,
        y: 50,
        links: [{ pano: "n4", heading: 180 }],
      },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    controller.setMotionMode("hop");
    mocks.locationGetPanorama.mockClear();

    controller.setTarget(50);

    await vi.waitFor(
      () => {
        // 50mたまってから、n1〜n5を連続して表示する（隣接パノラマなので移動アニメーションになる）
        expect(mocks.setPano.mock.calls.map((call) => call[0])).toEqual([
          "n1",
          "n2",
          "n3",
          "n4",
          "n5",
        ]);
      },
      { timeout: 3000 }
    );
    expect(mocks.locationGetPanorama).not.toHaveBeenCalled();
    expect(mocks.panoramaConstructor).toHaveBeenCalledTimes(1);
    expect(controller.panoBillingCount).toBe(1);
  });

  it("曲がり角付近では1枚ずつ、ルート先読み点に最も近いリンクを選ぶ", async () => {
    // 北へ100m進んだ後、東へ曲がるルート
    const route = makeRoute([0, 0, 90, 90]);
    const mocks = setupMockMaps({
      corner: {
        x: 0,
        y: 95,
        links: [
          { pano: "north", heading: 0 },
          { pano: "east", heading: 90 },
        ],
      },
      north: { x: 0, y: 105, links: [] },
      east: { x: 10, y: 100, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 95) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      95
    );
    await controller.ready;

    controller.setTarget(110);

    await vi.waitFor(() => {
      expect(mocks.setPano).toHaveBeenCalledWith("east");
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("north");
    expect(mocks.setPano).toHaveBeenCalledTimes(1);
  });

  it("進行方向のリンクがない場合はsetPositionで再同期する（再生成なし）", async () => {
    const route = makeRoute([0, 0]);
    const mocks = setupMockMaps({
      deadEnd: { x: 0, y: 0, links: [{ pano: "back", heading: 180 }] },
      back: { x: 0, y: -10, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.locationGetPanorama.mockClear();
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 40) } },
    });

    controller.setTarget(40);

    await vi.waitFor(() => {
      expect(mocks.locationGetPanorama).toHaveBeenCalledWith(
        expect.objectContaining({ radius: 25 })
      );
      expect(mocks.setPosition).toHaveBeenCalledTimes(2);
    });
    expect(mocks.setPano).not.toHaveBeenCalled();
    expect(mocks.panoramaConstructor).toHaveBeenCalledTimes(1);
  });

  it("投稿パノラマ（建物内など）は辿らず、次点の公式リンクを使う", async () => {
    const route = makeRoute([0, 0, 0, 0]); // 北へ200m
    const mocks = setupMockMaps({
      n0: {
        x: 0,
        y: 0,
        links: [
          { pano: "indoor", heading: 0 }, // 進行方向に最も近いが投稿パノラマ
          { pano: "official", heading: 10 },
        ],
      },
      indoor: { x: 0, y: 10, links: [], copyright: "© Taro Yamada" },
      official: { x: 2, y: 10, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;

    controller.setTarget(10);

    await vi.waitFor(() => {
      expect(mocks.setPano).toHaveBeenCalledWith("official");
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("indoor");
  });

  it("投稿パノラマ形式のID（AF1Qip等）は著作権表示に関わらず辿らない", async () => {
    const route = makeRoute([0, 0, 0, 0]);
    const mocks = setupMockMaps({
      n0: {
        x: 0,
        y: 0,
        links: [
          { pano: "AF1QipXYZ123", heading: 0 }, // ビジネスビュー等の投稿ID形式
          { pano: "official", heading: 10 },
        ],
      },
      AF1QipXYZ123: { x: 0, y: 10, links: [] }, // モック上は© Googleでも弾く
      official: { x: 2, y: 10, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;

    controller.setTarget(10);

    await vi.waitFor(() => {
      expect(mocks.setPano).toHaveBeenCalledWith("official");
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("AF1QipXYZ123");
  });

  it("屋内・地下パノラマ（地下街など）はOUTDOOR検証で棄却する", async () => {
    const route = makeRoute([0, 0]);
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "underground", heading: 0 }] },
      // ルート直上・公式著作権だが地下街のパノラマ
      underground: { x: 0, y: 10, links: [], indoor: true },
      // 同じ場所の地上パノラマ（OUTDOOR検索はこちらを返す）
      street: { x: 0, y: 11, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.locationGetPanorama.mockClear();
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 30) } },
    });

    controller.setTarget(30);

    await vi.waitFor(() => {
      expect(mocks.locationGetPanorama).toHaveBeenCalled(); // 再同期へ
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("underground");
  });

  it("リンクの自称方向と実移動方位がずれるパノラマ（横ステップ）は辿らない", async () => {
    const route = makeRoute([0, 0]);
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "sideStep", heading: 0 }] },
      // heading=0（北）を自称するが、実際の位置は真横（東15m）
      sideStep: { x: 15, y: 1, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.locationGetPanorama.mockClear();
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 50) } },
    });

    controller.setTarget(50);

    await vi.waitFor(() => {
      expect(mocks.locationGetPanorama).toHaveBeenCalled(); // 再同期へ
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("sideStep");
  });

  it("リンク先がルート外（公園・私道など）なら表示せずに再同期する", async () => {
    const route = makeRoute([0, 0]);
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "offRoute", heading: 0 }] },
      // 方位は進行方向だが、実際は西へ50mずれた位置（公園内など）
      offRoute: { x: -50, y: 10, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.locationGetPanorama.mockClear();
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 50) } },
    });

    controller.setTarget(50);

    await vi.waitFor(() => {
      expect(mocks.locationGetPanorama).toHaveBeenCalledWith(
        expect.objectContaining({ radius: 25 })
      );
    });
    // ルート外パノラマは表示前に棄却される
    expect(mocks.setPano).not.toHaveBeenCalledWith("offRoute");
  });

  it("再同期先が現在位置より後方なら表示しない（後退防止）", async () => {
    const route = makeRoute([0, 0, 0, 0]);
    const mocks = setupMockMaps({
      isolated: { x: 0, y: 50, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 50) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      50
    );
    await controller.ready;
    expect(mocks.setPosition).toHaveBeenCalledTimes(1);
    mocks.locationGetPanorama.mockClear();
    // 再同期先として後方（20m地点）のパノラマしか見つからないケース
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 20) } },
    });

    controller.setTarget(90);

    await vi.waitFor(() => {
      expect(mocks.locationGetPanorama).toHaveBeenCalled();
    });
    expect(mocks.setPosition).toHaveBeenCalledTimes(1); // 後退表示なし
    expect(mocks.setPano).not.toHaveBeenCalled();
  });

  it("視線方向はStreet Viewの道路リンク方向に補正される", async () => {
    const route = makeRoute([90, 90]);
    const mocks = setupMockMaps({});
    mocks.locationGetPanorama.mockResolvedValue({
      data: {
        location: { latLng: latLngFns(0, 0) },
        links: [{ heading: 88 }],
      },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;

    expect(mocks.setPov).toHaveBeenLastCalledWith({ heading: 88, pitch: 0 });
  });

  it("リセット時は先頭へ再同期する（再生成なし）", async () => {
    const route = makeRoute([0, 0]);
    const mocks = setupMockMaps({});
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      50
    );
    await controller.ready;
    mocks.locationGetPanorama.mockClear();

    controller.reset(0);
    await expect(controller.ready).resolves.toBe(true);

    expect(mocks.locationGetPanorama).toHaveBeenCalledWith(
      expect.objectContaining({
        location: { lat: route.points[0].lat, lng: route.points[0].lng },
      })
    );
    expect(mocks.panoramaConstructor).toHaveBeenCalledTimes(1);
  });
  it("同じ撮影時期（同じ撮影列）のリンクを優先する（高架/高架下の乗り換え防止）", async () => {
    const route = makeRoute([0, 0, 0, 0]);
    const mocks = setupMockMaps({
      n0: {
        x: 0,
        y: 0,
        imageDate: "2023-05",
        links: [
          { pano: "otherRun", heading: 0 }, // 進行方向に最も近いが別の撮影列
          { pano: "sameRun", heading: 5 },
        ],
      },
      otherRun: { x: 0, y: 10, links: [], imageDate: "2019-08" },
      sameRun: { x: 1, y: 10, links: [], imageDate: "2023-05" },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) }, imageDate: "2023-05" },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;

    controller.setTarget(10);

    await vi.waitFor(() => {
      expect(mocks.setPano).toHaveBeenCalledWith("sameRun");
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("otherRun");
  });

  it("説明文が駅構内のパノラマはOUTDOOR検索をすり抜けても辿らない", async () => {
    const route = makeRoute([0, 0]);
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "platform", heading: 0 }] },
      // OUTDOOR検索には現れる（indoor指定なし）が、説明文が駅
      platform: { x: 0, y: 10, links: [], description: "南森町駅" },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.locationGetPanorama.mockClear();
    mocks.locationGetPanorama.mockRejectedValue(new Error("ZERO_RESULTS"));

    controller.setTarget(30);

    await vi.waitFor(() => {
      expect(mocks.locationGetPanorama).toHaveBeenCalled(); // 再同期へ
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("platform");
    expect(
      controller.diagnostics.filter((entry) => entry.kind === "link")
    ).toEqual([]);
  });

  it("並走する別の撮影列へ横に乗り移るリンクは辿らない", async () => {
    const route = makeRoute([0, 0, 0, 0]);
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "parallel", heading: 19 }] },
      // 前方20m・右へ7m（方位差19°・ルートから7m以内だが左右位置が7m変わる）
      parallel: { x: 7, y: 20, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    controller.setMotionMode("hop");
    mocks.locationGetPanorama.mockClear();
    mocks.locationGetPanorama.mockRejectedValue(new Error("ZERO_RESULTS"));

    controller.setTarget(60);

    await vi.waitFor(() => {
      expect(mocks.locationGetPanorama).toHaveBeenCalled();
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("parallel");
  });

  it("撮影時期が異なる再同期は保留し、一定距離止まった後に許可する", async () => {
    const route = makeRoute([0, 0, 0, 0, 0, 0]); // 北へ300m
    const mocks = setupMockMaps({
      start: { x: 0, y: 0, links: [] },
      afterBridge: { x: 0, y: 40, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: {
        location: { latLng: latLngFns(0, 0), pano: "start" },
        imageDate: "2023-05",
      },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.setPosition.mockClear();
    // 近傍検索では別の撮影列（河川敷・高架下など）しか見つからない
    mocks.locationGetPanorama.mockResolvedValue({
      data: {
        location: { latLng: latLngFns(0, 30), pano: "underBridge" },
        links: [{ pano: "afterBridge", heading: 0 }],
        imageDate: "2018-03",
      },
    });

    controller.setTarget(30);
    await vi.waitFor(() => {
      expect(controller.diagnostics).toContainEqual(
        expect.objectContaining({ kind: "reject", reason: "dateChange" })
      );
    });
    expect(mocks.setPosition).not.toHaveBeenCalled();

    controller.setTarget(200);
    await vi.waitFor(() => {
      expect(mocks.setPosition).toHaveBeenCalledTimes(1);
    });
    expect(controller.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "resync", dateChanged: true })
    );
  });

  it("前進できるリンクがなければ交差点中央のパノラマを1枚経由して進む", async () => {
    const route = makeRoute([0, 0, 0, 0]);
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "center", heading: 80 }] },
      // 真横に近い交差点中央（前進しない）だが、その先に前進リンクがある
      center: {
        x: 4,
        y: 1,
        links: [
          { pano: "n0", heading: 260 },
          { pano: "ahead", heading: 0 },
        ],
      },
      ahead: { x: 3, y: 12, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.locationGetPanorama.mockClear();

    controller.setTarget(12);

    await vi.waitFor(() => {
      expect(mocks.setPano).toHaveBeenNthCalledWith(1, "center");
      expect(mocks.setPano).toHaveBeenNthCalledWith(2, "ahead");
    });
    expect(controller.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "bridge", pano: "center" })
    );
    expect(mocks.locationGetPanorama).not.toHaveBeenCalled();
  });

  it("移動後の視線はリンク方向ではなくルートの少し先を向く", async () => {
    const route = makeRoute([0, 0, 0, 0]); // 北へ200m
    const mocks = setupMockMaps({
      // リンク方向は25°と斜めだが、ルートは真北
      n0: { x: 0, y: 0, links: [{ pano: "n1", heading: 25 }] },
      n1: { x: 1, y: 10, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;

    controller.setTarget(10);

    await vi.waitFor(() => {
      expect(mocks.setPano).toHaveBeenCalledWith("n1");
      const lastHeading = mocks.setPov.mock.lastCall?.[0].heading as number;
      expect(Math.min(lastHeading, 360 - lastHeading)).toBeLessThan(5);
    }, { timeout: 3000 }); // 視線補間（600ms）の完了を待つ
  });
  it("初期表示では前進できないパノラマ（高架下・駅改札など）を避けて少し先から始める", async () => {
    const route = makeRoute([0, 0, 0, 0]);
    const mocks = setupMockMaps({
      deadEnd: { x: 0, y: 0, links: [] },
      good: { x: 0, y: 10, links: [{ pano: "next", heading: 0 }] },
      next: { x: 0, y: 20, links: [] },
    });
    mocks.locationGetPanorama.mockImplementation(
      async (request: { location: { lat: number } }) => {
        const atStart = Math.abs(request.location.lat - route.points[0].lat) < 1e-9;
        return atStart
          ? { data: { location: { latLng: latLngFns(0, 0), pano: "deadEnd" }, links: [] } }
          : {
              data: {
                location: { latLng: latLngFns(0, 10), pano: "good" },
                links: [{ pano: "next", heading: 0 }],
              },
            };
      }
    );

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await expect(controller.ready).resolves.toBe(true);

    expect(mocks.setPosition).toHaveBeenCalledTimes(1);
    expect(mocks.state.position).toEqual(toLatLng(0, 10));
  });

  it("保留を解いた再同期でも、先へ進めない行き止まりパノラマへは飛ばない", async () => {
    const route = makeRoute([0, 0, 0, 0, 0, 0]);
    const mocks = setupMockMaps({ start: { x: 0, y: 0, links: [] } });
    mocks.locationGetPanorama.mockResolvedValue({
      data: {
        location: { latLng: latLngFns(0, 0), pano: "start" },
        imageDate: "2023-05",
      },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.setPosition.mockClear();
    mocks.locationGetPanorama.mockResolvedValue({
      data: {
        location: { latLng: latLngFns(0, 200), pano: "ticketGate" },
        links: [],
        imageDate: "2018-03",
      },
    });

    controller.setTarget(200);
    await vi.waitFor(() => {
      expect(controller.diagnostics).toContainEqual(
        expect.objectContaining({ kind: "reject", reason: "noForwardLink" })
      );
    });
    expect(mocks.setPosition).not.toHaveBeenCalled();
  });
  it("説明文が施設名（地下街など）のパノラマは辿らない", async () => {
    const route = makeRoute([0, 0]);
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "mall", heading: 0 }] },
      mall: {
        x: 0,
        y: 10,
        links: [],
        description: "ホワイティうめだ, 大阪市, 大阪府",
      },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.locationGetPanorama.mockRejectedValue(new Error("ZERO_RESULTS"));

    controller.setTarget(30);

    await vi.waitFor(() => {
      expect(controller.diagnostics).toContainEqual(
        expect.objectContaining({
          kind: "stop",
          rejected: [{ pano: "mall", reason: "indoorName" }],
        })
      );
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("mall");
  });

  it("道路名・行政区画名の説明文は屋外として辿る", async () => {
    const route = makeRoute([0, 0]);
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "road", heading: 0 }] },
      road: {
        x: 0,
        y: 10,
        links: [],
        description: "新淀川大橋, 大阪市, 大阪府",
      },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;

    controller.setTarget(10);

    await vi.waitFor(() => {
      expect(mocks.setPano).toHaveBeenCalledWith("road");
    });
  });

  it("再同期は撮影時期が同じ候補を、最寄りでなくても優先する", async () => {
    const route = makeRoute([0, 0, 0, 0]);
    const mocks = setupMockMaps({ start: { x: 0, y: 0, links: [] } });
    mocks.locationGetPanorama.mockResolvedValue({
      data: {
        location: { latLng: latLngFns(0, 0), pano: "start" },
        imageDate: "2023-05",
      },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.setPosition.mockClear();
    // ターゲット地点の最寄りは別の撮影列、少し先には同じ撮影列がある
    mocks.locationGetPanorama.mockImplementation(
      async (request: { location: { lat: number } }) => {
        const atTarget =
          Math.abs(request.location.lat - toLatLng(0, 30).lat) < 1e-9;
        return atTarget
          ? {
              data: {
                location: { latLng: latLngFns(0, 30), pano: "otherLevel" },
                imageDate: "2019-01",
              },
            }
          : {
              data: {
                location: { latLng: latLngFns(1, 45), pano: "sameLevel" },
                imageDate: "2023-05",
              },
            };
      }
    );

    controller.setTarget(30);

    await vi.waitFor(() => {
      expect(controller.diagnostics).toContainEqual(
        expect.objectContaining({ kind: "resync", pano: "sameLevel" })
      );
    });
    expect(controller.diagnostics).not.toContainEqual(
      expect.objectContaining({ kind: "resync", pano: "otherLevel" })
    );
  });
  it("撮影車が逆向きに走っていたパノラマ（反対車線・一方通行の逆方向）は後回しにする", async () => {
    const route = makeRoute([0, 0, 0, 0]);
    const mocks = setupMockMaps({
      n0: {
        x: 0,
        y: 0,
        links: [
          { pano: "oncoming", heading: 0 }, // 進行方向に最も近いが逆向き撮影
          { pano: "along", heading: 5 },
        ],
      },
      oncoming: { x: 0, y: 10, links: [] },
      along: { x: 1, y: 10, links: [] },
    });
    const baseGetPanorama = mocks.getPanorama.getMockImplementation()!;
    mocks.getPanorama.mockImplementation(async (request) => {
      const result = await baseGetPanorama(request);
      if (request.pano === "oncoming") {
        return { data: { ...result.data, tiles: { centerHeading: 180 } } };
      }
      if (request.pano === "along") {
        return { data: { ...result.data, tiles: { centerHeading: 2 } } };
      }
      return result;
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;

    controller.setTarget(10);

    await vi.waitFor(() => {
      expect(mocks.setPano).toHaveBeenCalledWith("along");
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("oncoming");
  });

  it("降り口のように少しずつルートから離れていくリンクは8mを超えたら辿らない", async () => {
    const route = makeRoute([0, 0, 0, 0]);
    const mocks = setupMockMaps({
      n0: { x: 0, y: 0, links: [{ pano: "r1", heading: 0 }] },
      r1: { x: -3, y: 10, links: [{ pano: "r2", heading: 0 }] },
      r2: { x: -6, y: 20, links: [{ pano: "r3", heading: 0 }] },
      // 1歩の左右変化は3mだが、ルートから9m離れる
      r3: { x: -9, y: 30, links: [] },
    });
    mocks.locationGetPanorama.mockResolvedValue({
      data: { location: { latLng: latLngFns(0, 0) } },
    });

    const controller = new StreetViewController(
      document.createElement("div"),
      route,
      0
    );
    await controller.ready;
    mocks.locationGetPanorama.mockRejectedValue(new Error("ZERO_RESULTS"));

    controller.setTarget(30);

    await vi.waitFor(() => {
      expect(controller.diagnostics).toContainEqual(
        expect.objectContaining({
          kind: "stop",
          rejected: [{ pano: "r3", reason: "offRoute" }],
        })
      );
    });
    expect(mocks.setPano).not.toHaveBeenCalledWith("r3");
  });
  describe("パノラマ列（事前作り込み）での走行", () => {
    /** 北へ10m間隔のパノラマ列と、対応するグラフ */
    function chainFixture(count: number, searchAt: number[] = []) {
      const graph: PanoGraph = {};
      const chain = [];
      for (let index = 0; index < count; index += 1) {
        const y = index * 10;
        graph[`c${index}`] = { x: 0, y, links: [] };
        chain.push({
          pano: `c${index}`,
          ...toLatLng(0, y),
          distanceM: y,
          sideM: 0,
          source: (index === 0 || searchAt.includes(index) ? "search" : "link") as
            | "search"
            | "link",
          flags: [],
        });
      }
      return { graph, chain };
    }

    it("開始距離に対応するエントリを表示し、近傍検索はしない", async () => {
      const route = makeRoute([0, 0, 0, 0]);
      const { graph, chain } = chainFixture(10);
      const mocks = setupMockMaps(graph);
      const onPanoramaChanged = vi.fn();

      const controller = new StreetViewController(
        document.createElement("div"),
        route,
        35,
        onPanoramaChanged,
        chain
      );
      await expect(controller.ready).resolves.toBe(true);

      expect(controller.usesChain).toBe(true);
      expect(mocks.setPano).toHaveBeenCalledWith("c3");
      expect(mocks.locationGetPanorama).not.toHaveBeenCalled();
      expect(onPanoramaChanged).toHaveBeenCalledWith(
        30,
        expect.anything(),
        { syncDistance: true, billed: true }
      );
    });

    it("まとめ移動では約50mぶんのエントリを連続表示する", async () => {
      const route = makeRoute([0, 0, 0, 0]);
      const { graph, chain } = chainFixture(10);
      const mocks = setupMockMaps(graph);

      const controller = new StreetViewController(
        document.createElement("div"),
        route,
        0,
        undefined,
        chain
      );
      await controller.ready;
      controller.setMotionMode("hop");
      mocks.setPano.mockClear();

      controller.setTarget(30); // 50m未満は動かない
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mocks.setPano).not.toHaveBeenCalled();

      controller.setTarget(55);
      await vi.waitFor(
        () => {
          expect(mocks.setPano.mock.calls.map((call) => call[0])).toEqual([
            "c1", "c2", "c3", "c4", "c5",
          ]);
        },
        { timeout: 3000 }
      );
      expect(mocks.locationGetPanorama).not.toHaveBeenCalled();
    });

    it("乗り継ぎ（search）エントリの手前で区切り、そこは単独で移動する", async () => {
      const route = makeRoute([0, 0, 0, 0]);
      const { graph, chain } = chainFixture(10, [3]);
      const mocks = setupMockMaps(graph);

      const controller = new StreetViewController(
        document.createElement("div"),
        route,
        0,
        undefined,
        chain
      );
      await controller.ready;
      controller.setMotionMode("hop");
      mocks.setPano.mockClear();

      controller.setTarget(55);
      await vi.waitFor(
        () => {
          expect(mocks.setPano.mock.calls.map((call) => call[0])).toEqual([
            "c1", "c2", "c3",
          ]);
        },
        { timeout: 3000 }
      );
      // c1-c2 を連続表示 → 乗り継ぎの c3 は単独で移動（その先は再び約50mごと）
      expect(controller.diagnostics.map((entry) => entry.kind)).toEqual([
        "link",
        "resync",
      ]);
    });

    /** 北へ10m間隔のノード（id = prefix+番号）を from〜to まで双方向リンクで作る */
    function linkedRun(prefix: string, from: number, to: number): PanoGraph {
      const graph: PanoGraph = {};
      for (let i = from; i <= to; i += 1) {
        const links = [];
        if (i > from) links.push({ pano: `${prefix}${i - 1}`, heading: 180 });
        if (i < to) links.push({ pano: `${prefix}${i + 1}`, heading: 0 });
        graph[`${prefix}${i}`] = { x: 0, y: i * 10, links };
      }
      return graph;
    }

    function chainOf(prefix: string, from: number, to: number) {
      const chain = [];
      for (let i = from; i <= to; i += 1) {
        chain.push({
          pano: `${prefix}${i}`,
          ...toLatLng(0, i * 10),
          distanceM: i * 10,
          sideM: 0,
          source: (i === from ? "search" : "link") as "search" | "link",
          flags: [],
        });
      }
      return chain;
    }

    it("範囲の終わりまでパノラマ列を再生し、その先は探索方式（リンク追従）で進む", async () => {
      const route = makeRoute([0, 0, 0, 0, 0, 0]); // 北へ300m
      const graph = { ...linkedRun("c", 0, 8), ...linkedRun("l", 9, 20) };
      graph.c8.links.push({ pano: "l9", heading: 0 });
      graph.l9.links.push({ pano: "c8", heading: 180 });
      const mocks = setupMockMaps(graph);

      const controller = new StreetViewController(
        document.createElement("div"),
        route,
        0,
        undefined,
        chainOf("c", 0, 8),
        [{ startM: 0, endM: 80 }]
      );
      await controller.ready;
      mocks.setPano.mockClear();

      // 走行ループと同じく毎フレーム目標距離を伝える
      const ticker = setInterval(() => controller.setTarget(110), 20);
      try {
        await vi.waitFor(
          () => {
            const calls = mocks.setPano.mock.calls.map((call) => call[0]);
            expect(calls.slice(0, 8)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
            expect(calls).toContain("l9");
          },
          { timeout: 8000 }
        );
      } finally {
        clearInterval(ticker);
      }
      expect(mocks.locationGetPanorama).not.toHaveBeenCalled();
    }, 15000);

    it("範囲外から始めると探索方式で走り、範囲に入ったらパノラマ列へ移る", async () => {
      const route = makeRoute([0, 0, 0, 0, 0, 0]);
      const graph = { ...linkedRun("l", 0, 9), ...linkedRun("c", 10, 20) };
      const mocks = setupMockMaps(graph);
      mocks.locationGetPanorama.mockResolvedValue({
        data: { location: { latLng: latLngFns(0, 0), pano: "l0" }, links: [{ pano: "l1", heading: 0 }] },
      });

      const controller = new StreetViewController(
        document.createElement("div"),
        route,
        0,
        undefined,
        chainOf("c", 10, 20),
        [{ startM: 100, endM: 200 }]
      );
      await expect(controller.ready).resolves.toBe(true);
      expect(mocks.locationGetPanorama).toHaveBeenCalled(); // 範囲外は従来の初期化

      const ticker = setInterval(() => controller.setTarget(125), 20);
      try {
        await vi.waitFor(
          () => {
            expect(mocks.setPano).toHaveBeenCalledWith("c12");
          },
          { timeout: 8000 }
        );
      } finally {
        clearInterval(ticker);
      }
    }, 10000);

    it("列のパノラマが表示できなければ従来の探索方式に切り替える", async () => {
      const route = makeRoute([0, 0]);
      const mocks = setupMockMaps({});
      mocks.locationGetPanorama.mockResolvedValue({
        data: { location: { latLng: latLngFns(0, 0) } },
      });
      const chain = [
        {
          pano: "removed",
          ...toLatLng(0, 0),
          distanceM: 0,
          sideM: 0,
          source: "search" as const,
          flags: [],
        },
      ];

      const controller = new StreetViewController(
        document.createElement("div"),
        route,
        0,
        undefined,
        chain
      );
      await expect(controller.ready).resolves.toBe(true);
      expect(controller.usesChain).toBe(false);
      expect(mocks.locationGetPanorama).toHaveBeenCalled();
    }, 10000);
  });
});
