import { describe, expect, it, vi } from "vitest";
import {
  createGoogleRoutesRoute,
  decodeGooglePolyline,
} from "./googleRoutesLoader";

describe("decodeGooglePolyline", () => {
  it("Google公式サンプルをデコードする", () => {
    expect(decodeGooglePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
  });

  it("不正なpolylineを拒否する", () => {
    expect(() => decodeGooglePolyline("_")).toThrow(
      "Routes APIのpolylineが不正です"
    );
  });
});

describe("createGoogleRoutesRoute", () => {
  it("入力内容をPOSTして徒歩ルートを生成する", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
          travelMode: "WALK",
        }),
        { status: 200 }
      )
    );

    const request = {
      name: "徒歩テスト",
      origin: "大阪駅",
      destination: "梅田駅",
      intermediates: ["北新地駅"],
      travelMode: "WALK" as const,
      includeElevation: false,
    };
    const result = await createGoogleRoutesRoute(request);

    expect(fetchMock).toHaveBeenCalledWith("/api/routes/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(result.route.name).toBe("徒歩テスト");
    expect(result.routeType).toBe("徒歩ルート");
  });

  it("緯度経度の入力内容もPOSTできる", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
          travelMode: "DRIVE",
        }),
        { status: 200 }
      )
    );

    const request = {
      name: "座標テスト",
      origin: { latitude: 34.75875, longitude: 135.49713 },
      destination: { latitude: 34.83167, longitude: 135.48955 },
      intermediates: [
        {
          latitude: 34.8,
          longitude: 135.49,
          label: "34.800000,135.490000",
        },
      ],
      travelMode: "DRIVE" as const,
      includeElevation: true,
    };
    await createGoogleRoutesRoute(request);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/routes/compute",
      expect.objectContaining({
        body: JSON.stringify(request),
      })
    );
  });

  it("幹線道路優先ルート種別を受け取れる", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
          travelMode: "DRIVE",
          routeType: "幹線道路優先ルート",
        }),
        { status: 200 }
      )
    );

    const result = await createGoogleRoutesRoute({
      name: "幹線道路テスト",
      origin: "大阪駅",
      destination: "京都駅",
      intermediates: [],
      travelMode: "MAIN_ROAD",
      includeElevation: false,
    });

    expect(result.routeType).toBe("幹線道路優先ルート");
  });

  it("ステップ単位で生成された座標列を優先してルートを生成する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          travelMode: "DRIVE",
          coordinates: [
            { lat: 34, lng: 135, elevation: 0 },
            { lat: 34.0001, lng: 135.0001, elevation: 0 },
            { lat: 34.0002, lng: 135.0001, elevation: 0 },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await createGoogleRoutesRoute({
      name: "高精度ルート",
      origin: "大阪駅",
      destination: "梅田駅",
      intermediates: [],
      travelMode: "DRIVE",
      includeElevation: false,
    });

    expect(result.route.name).toBe("高精度ルート");
    expect(result.route.points[0]).toMatchObject({ lat: 34, lng: 135 });
    expect(result.route.points.at(-1)).toMatchObject({
      lat: 34.0002,
      lng: 135.0001,
    });
  });
});
