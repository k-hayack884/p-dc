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
});
