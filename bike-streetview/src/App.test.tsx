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
import { saveCustomRoute } from "./modules/customRoutes";
import {
  loadRouteProgress,
  saveRouteProgress,
} from "./modules/routeProgress";

function findButtonByText(container: HTMLElement, text: string) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button")
  ).find((button) => button.textContent?.includes(text));
}

function updateTextArea(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function updateInput(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

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
    vi.spyOn(window, "confirm").mockReturnValue(true);
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

    const routeButton = findButtonByText(container, "大阪・淀川");
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

    const returnButton = findButtonByText(container, "ルート変更");
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
    const routeButton = findButtonByText(container, "大阪・淀川");

    await act(async () => {
      routeButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".app")).not.toBeNull();
    });

    const openResetButton = findButtonByText(container, "リセット");
    await act(async () => {
      openResetButton?.click();
    });

    expect(
      container.querySelector('[role="dialog"]')
    ).not.toBeNull();
    expect(loadRouteProgress("osaka-kyoto")).toBe(500);

    const cancelButton = findButtonByText(container, "キャンセル");
    await act(async () => {
      cancelButton?.click();
    });
    expect(loadRouteProgress("osaka-kyoto")).toBe(500);

    await act(async () => {
      openResetButton?.click();
    });
    const resetButton = findButtonByText(container, "リセットする");
    await act(async () => {
      resetButton?.click();
    });

    expect(loadRouteProgress("osaka-kyoto")).toBe(0);

    await act(async () => {
      root.unmount();
    });
  });

  it("ゴール到着時は総距離も小数2桁で表示しゴール演出を出す", async () => {
    saveRouteProgress("osaka-kyoto", 100);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });
    const routeButton = findButtonByText(container, "大阪・淀川");

    await act(async () => {
      routeButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".app")).not.toBeNull();
    });

    expect(container.textContent).toContain("距離 0.10 km / 0.10 km");
    expect(container.textContent).toContain("ゴール到着");
    expect(container.textContent).toContain("ゴール！");

    await act(async () => {
      root.unmount();
    });
  });

  it("走行画面に現在位置ミニマップを表示する", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });
    const routeButton = findButtonByText(container, "大阪・淀川");

    await act(async () => {
      routeButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".app")).not.toBeNull();
    });

    expect(
      container.querySelector('[aria-label="現在位置ミニマップ"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("ルート位置");

    await act(async () => {
      root.unmount();
    });
  });

  it("ミニマップに入力した地点名を表示する", async () => {
    saveCustomRoute(
      {
        name: "ラベルテスト",
        origin: {
          latitude: 34.7,
          longitude: 135.5,
          label: "出発地名",
        },
        destination: {
          latitude: 34.72,
          longitude: 135.52,
          label: "目的地名",
        },
        intermediates: [
          {
            latitude: 34.71,
            longitude: 135.51,
            label: "経由地名",
          },
        ],
        travelMode: "DRIVE",
        includeElevation: false,
      },
      {
        route: {
          name: "ラベルテスト",
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
              distance: 50,
              elevation: 0,
              grade: 0,
              heading: 45,
            },
            {
              lat: 34.72,
              lng: 135.52,
              distance: 100,
              elevation: 0,
              grade: 0,
              heading: 45,
            },
          ],
        },
        routeType: "車ルート",
      }
    );
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });
    const routeButton = findButtonByText(container, "ラベルテスト");

    await act(async () => {
      routeButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".app")).not.toBeNull();
    });

    expect(container.textContent).toContain("出発地名");
    expect(container.textContent).toContain("経由地名");
    expect(container.textContent).toContain("目的地名");

    await act(async () => {
      root.unmount();
    });
  });

  it("ルート編集で地点ラベルを変更してミニマップに反映できる", async () => {
    saveCustomRoute(
      {
        name: "ラベル編集テスト",
        origin: {
          latitude: 34.7,
          longitude: 135.5,
          label: "旧出発地",
        },
        destination: {
          latitude: 34.72,
          longitude: 135.52,
          label: "旧目的地",
        },
        intermediates: [
          {
            latitude: 34.71,
            longitude: 135.51,
            label: "旧経由地",
          },
        ],
        travelMode: "DRIVE",
        includeElevation: false,
      },
      {
        route: {
          name: "ラベル編集テスト",
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
              distance: 50,
              elevation: 0,
              grade: 0,
              heading: 45,
            },
            {
              lat: 34.72,
              lng: 135.52,
              distance: 100,
              elevation: 0,
              grade: 0,
              heading: 45,
            },
          ],
        },
        routeType: "車ルート",
      }
    );
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    const pointEditButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="ラベル編集テストの地点ラベルを編集"]'
    );
    expect(pointEditButton).not.toBeNull();

    await act(async () => {
      pointEditButton?.click();
    });

    const startInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="ラベル編集テストの出発地ラベル"]'
    );
    const waypointInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="ラベル編集テストの経由地1ラベル"]'
    );
    const goalInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="ラベル編集テストの目的地ラベル"]'
    );
    expect(startInput).not.toBeNull();
    expect(waypointInput).not.toBeNull();
    expect(goalInput).not.toBeNull();

    await act(async () => {
      updateInput(startInput as HTMLInputElement, "新出発地");
    });
    await act(async () => {
      updateInput(waypointInput as HTMLInputElement, "新経由地");
    });
    await act(async () => {
      updateInput(goalInput as HTMLInputElement, "新目的地");
    });

    expect(startInput?.value).toBe("新出発地");
    expect(waypointInput?.value).toBe("新経由地");
    expect(goalInput?.value).toBe("新目的地");

    const saveButton = container.querySelector<HTMLButtonElement>(
      ".point-label-editor-actions button[type='submit']"
    );
    expect(saveButton).not.toBeNull();
    await act(async () => {
      saveButton?.click();
    });
    expect(
      window.localStorage.getItem("bike-streetview:route-point-labels")
    ).toContain("新出発地");

    const routeButton = findButtonByText(container, "ラベル編集テスト");
    await act(async () => {
      routeButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".app")).not.toBeNull();
    });

    expect(container.textContent).toContain("新出発地");
    expect(container.textContent).toContain("新経由地");
    expect(container.textContent).toContain("新目的地");
    expect(container.textContent).not.toContain("旧出発地");
    expect(container.textContent).not.toContain("旧経由地");
    expect(container.textContent).not.toContain("旧目的地");

    await act(async () => {
      root.unmount();
    });
  });

  it("ルート一覧から標準ルートを削除して復元できる", async () => {
    saveRouteProgress("esaka-minoh-kayano", 500);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    expect(container.textContent).toContain("江坂 → 箕面萱野");
    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="江坂 → 箕面萱野を削除"]'
    );
    expect(deleteButton).not.toBeNull();

    await act(async () => {
      deleteButton?.click();
    });

    expect(container.textContent).not.toContain("江坂 → 箕面萱野");
    expect(loadRouteProgress("esaka-minoh-kayano")).toBe(0);

    const restoreButton = findButtonByText(container, "標準ルートを復元");
    expect(restoreButton).toBeDefined();

    await act(async () => {
      restoreButton?.click();
    });

    expect(container.textContent).toContain("江坂 → 箕面萱野");

    await act(async () => {
      root.unmount();
    });
  });

  it("ルート削除をキャンセルすると削除しない", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    saveRouteProgress("esaka-minoh-kayano", 500);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="江坂 → 箕面萱野を削除"]'
    );
    expect(deleteButton).not.toBeNull();

    await act(async () => {
      deleteButton?.click();
    });

    expect(container.textContent).toContain("江坂 → 箕面萱野");
    expect(loadRouteProgress("esaka-minoh-kayano")).toBe(500);

    await act(async () => {
      root.unmount();
    });
  });

  it("ルート説明を編集して保存できる", async () => {
    let root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    const editButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="江坂 → 箕面萱野を編集"]'
    );
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.click();
    });

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="江坂 → 箕面萱野の説明"]'
    );
    expect(textarea).not.toBeNull();

    await act(async () => {
      updateTextArea(textarea as HTMLTextAreaElement, "北摂ヒルクライム確認用");
    });

    const saveButton = findButtonByText(container, "保存");
    await act(async () => {
      saveButton?.click();
    });

    expect(container.textContent).toContain("北摂ヒルクライム確認用");

    await act(async () => {
      root.unmount();
    });

    container.innerHTML = "";
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    expect(container.textContent).toContain("北摂ヒルクライム確認用");

    await act(async () => {
      root.unmount();
    });
  });

  it("ルート名を編集して走行画面にも反映できる", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    const editButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="大阪・淀川 → 京都御所を編集"]'
    );
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.click();
    });

    const titleInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="大阪・淀川 → 京都御所のルート名"]'
    );
    expect(titleInput).not.toBeNull();

    await act(async () => {
      updateInput(titleInput as HTMLInputElement, "淀川サイクリング");
    });

    const saveButton = findButtonByText(container, "保存");
    await act(async () => {
      saveButton?.click();
    });

    expect(container.textContent).toContain("淀川サイクリング");
    expect(container.textContent).not.toContain("大阪・淀川 → 京都御所");

    const routeButton = findButtonByText(container, "淀川サイクリング");
    await act(async () => {
      routeButton?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(container.querySelector(".app")).not.toBeNull();
    });

    expect(container.querySelector(".route-name")?.textContent).toBe(
      "淀川サイクリング"
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("ルート選択画面から地図プレビューを開ける", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    const previewButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="大阪・淀川 → 京都御所の地図を確認"]'
    );
    expect(previewButton).not.toBeNull();

    await act(async () => {
      previewButton?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    });

    expect(container.textContent).toContain("ROUTE PREVIEW");
    expect(container.textContent).toContain("大阪・淀川 → 京都御所");
    expect(
      container.querySelector(".route-preview-map") ??
        container.textContent?.includes("地図確認には")
    ).toBeTruthy();

    const closeButton = findButtonByText(container, "閉じる");
    await act(async () => {
      closeButton?.click();
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
