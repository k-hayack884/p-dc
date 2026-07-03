import { beforeEach, describe, expect, it, vi } from "vitest";
import { StreetViewController } from "./streetViewController";

describe("StreetViewController", () => {
  const setPosition = vi.fn();
  const setPov = vi.fn();
  const setVisible = vi.fn();
  const getPanorama = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("google", {
      maps: {
        StreetViewSource: {
          OUTDOOR: "outdoor",
        },
        StreetViewPanorama: vi.fn().mockImplementation(function () {
          return {
            setPosition,
            setPov,
            setVisible,
          };
        }),
        StreetViewService: vi.fn().mockImplementation(function () {
          return {
            getPanorama,
          };
        }),
      },
    });
  });

  it("初期表示時にも近傍のStreet Viewパノラマへ移動する", async () => {
    const nearbyLatLng = {
      lat: () => 34.701,
      lng: () => 135.501,
    };
    getPanorama.mockResolvedValue({
      data: {
        location: {
          latLng: nearbyLatLng,
        },
      },
    });
    const onPanoramaChanged = vi.fn();

    new StreetViewController(
      document.createElement("div"),
      {
        lat: 34.7,
        lng: 135.5,
        distance: 0,
        elevation: 0,
        grade: 0,
        heading: 90,
      },
      0,
      onPanoramaChanged
    );

    await vi.waitFor(() => {
      expect(getPanorama).toHaveBeenCalledWith({
        location: { lat: 34.7, lng: 135.5 },
        radius: 50,
        source: "outdoor",
      });
      expect(setPosition).toHaveBeenCalledWith(nearbyLatLng);
    });
    expect(setPov).toHaveBeenCalledWith({ heading: 90, pitch: 0 });
    expect(onPanoramaChanged).toHaveBeenCalledWith(
      0,
      {
        lat: 34.701,
        lng: 135.501,
      },
      { syncDistance: true }
    );
  });

  it("近傍50mで見つからない場合は探索半径を広げる", async () => {
    const fallbackLatLng = {
      lat: () => 34.702,
      lng: () => 135.502,
    };
    getPanorama
      .mockRejectedValueOnce(new Error("ZERO_RESULTS"))
      .mockResolvedValueOnce({
        data: {
          location: {
            latLng: fallbackLatLng,
          },
        },
      });

    new StreetViewController(document.createElement("div"), {
      lat: 34.7,
      lng: 135.5,
      distance: 0,
      elevation: 0,
      grade: 0,
      heading: 90,
    });

    await vi.waitFor(() => {
      expect(getPanorama).toHaveBeenNthCalledWith(1, {
        location: { lat: 34.7, lng: 135.5 },
        radius: 50,
        source: "outdoor",
      });
      expect(getPanorama).toHaveBeenNthCalledWith(2, {
        location: { lat: 34.7, lng: 135.5 },
        radius: 150,
        source: "outdoor",
      });
      expect(setPosition).toHaveBeenCalledWith(fallbackLatLng);
    });
  });
});
