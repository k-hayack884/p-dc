import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import App from "./App";
import {
  loadRouteProgress,
  saveRouteProgress,
} from "./modules/routeProgress";

vi.mock("./modules/kmzRouteLoader", () => ({
  loadRouteFromKmzUrl: vi.fn().mockResolvedValue({
    name: "テストルート",
    intervalMeters: 50,
    points: [
      {
        lat: 34.7,
        lng: 135.5,
        distance: 0,
        elevation: 0,
        grade: 0,
        heading: 0,
      },
      {
        lat: 34.71,
        lng: 135.51,
        distance: 100,
        elevation: 0,
        grade: 0,
        heading: 45,
      },
    ],
  }),
}));

describe("Appのルート画面遷移", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  it("走行画面のinline styleをルート選択画面へ引き継がない", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const routeButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".route-option")
    ).find((button) => button.textContent?.includes("大阪・淀川"));
    expect(routeButton).toBeDefined();

    await act(async () => {
      routeButton?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(container.querySelector(".app")).not.toBeNull();
    });

    const runningFirstChild =
      container.querySelector<HTMLElement>(".app > div");
    expect(runningFirstChild).not.toBeNull();
    runningFirstChild?.style.setProperty("background", "white");

    const returnButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.includes("ルート変更"));
    expect(returnButton).toBeDefined();

    await act(async () => {
      returnButton?.click();
    });

    const selectionPanel =
      container.querySelector<HTMLElement>(".route-selection-panel");
    expect(selectionPanel).not.toBe(runningFirstChild);
    expect(selectionPanel?.style.background).toBe("");

    await act(async () => {
      root.unmount();
    });
  });

  it("リセット確認で承認するまで進捗を削除しない", async () => {
    saveRouteProgress("osaka-kyoto", 500);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });
    const routeButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".route-option")
    ).find((button) => button.textContent?.includes("大阪・淀川"));

    await act(async () => {
      routeButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".app")).not.toBeNull();
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "R" }));
    });

    expect(
      container.querySelector('[role="dialog"]')
    ).not.toBeNull();
    expect(loadRouteProgress("osaka-kyoto")).toBe(500);

    const cancelButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent === "キャンセル");
    await act(async () => {
      cancelButton?.click();
    });
    expect(loadRouteProgress("osaka-kyoto")).toBe(500);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "R" }));
    });
    const resetButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent === "リセットする");
    await act(async () => {
      resetButton?.click();
    });

    expect(loadRouteProgress("osaka-kyoto")).toBe(0);

    await act(async () => {
      root.unmount();
    });
  });
});
