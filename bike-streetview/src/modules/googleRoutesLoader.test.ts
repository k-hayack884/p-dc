import { describe, expect, it } from "vitest";
import { decodeGooglePolyline } from "./googleRoutesLoader";

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
