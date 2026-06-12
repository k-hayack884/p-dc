import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteCustomRoute,
  loadCustomRoutes,
  saveCustomRoute,
} from "./customRoutes";
import type { CreateGoogleRouteRequest } from "./googleRoutesLoader";

const request: CreateGoogleRouteRequest = {
  name: "大阪駅 → 京都駅",
  origin: "大阪駅",
  destination: "京都駅",
  intermediates: [],
  travelMode: "AUTO",
  includeElevation: true,
};

const result = {
  routeType: "自転車ルート" as const,
  route: {
    name: request.name,
    intervalMeters: 50,
    points: [
      {
        lat: 34.7,
        lng: 135.5,
        distance: 0,
        elevation: 10,
        grade: 0,
        heading: 0,
      },
      {
        lat: 35,
        lng: 135.7,
        distance: 100,
        elevation: 12,
        grade: 2,
        heading: 30,
      },
    ],
  },
};

describe("customRoutes", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  it("作成したルートを保存して読み込める", () => {
    const saved = saveCustomRoute(request, result);

    expect(saved.id).toMatch(/^custom-1000-/);
    expect(loadCustomRoutes()).toEqual([saved]);
  });

  it("指定したルートだけ削除する", () => {
    const first = saveCustomRoute(request, result);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const second = saveCustomRoute(
      { ...request, name: "大阪駅 → 奈良駅" },
      { ...result, route: { ...result.route, name: "大阪駅 → 奈良駅" } }
    );

    deleteCustomRoute(first.id);

    expect(loadCustomRoutes()).toEqual([second]);
  });

  it("壊れた保存データは無視する", () => {
    window.localStorage.setItem("bike-streetview:custom-routes", "{broken");

    expect(loadCustomRoutes()).toEqual([]);
  });
});
