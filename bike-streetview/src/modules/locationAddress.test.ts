import { describe, expect, it } from "vitest";
import { formatJapaneseArea } from "./locationAddress";

describe("formatJapaneseArea", () => {
  it("都道府県・市・区・町名までを連結する", () => {
    expect(
      formatJapaneseArea([
        { long_name: "日本", types: ["country"] },
        {
          long_name: "大阪府",
          types: ["administrative_area_level_1"],
        },
        { long_name: "大阪市", types: ["locality"] },
        { long_name: "城東区", types: ["sublocality_level_1"] },
        { long_name: "蒲生", types: ["sublocality_level_2"] },
        { long_name: "4丁目", types: ["sublocality_level_3"] },
        { long_name: "10", types: ["street_number"] },
      ])
    ).toBe("大阪府大阪市城東区蒲生");
  });

  it("存在する地域階層だけで整形する", () => {
    expect(
      formatJapaneseArea([
        {
          long_name: "京都府",
          types: ["administrative_area_level_1"],
        },
        { long_name: "京都市", types: ["locality"] },
        { long_name: "上京区", types: ["sublocality_level_1"] },
      ])
    ).toBe("京都府京都市上京区");
  });
});
