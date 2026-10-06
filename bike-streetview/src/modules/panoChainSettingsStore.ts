import type { PanoChainSettings } from "./panoChainSegments";

/**
 * ルートごとの「パノラマ列を使う区間」の設定の保存先。
 * 開発サーバーの .data/pano-chain-settings.json に { [routeId]: PanoChainSettings } で保存する。
 */
const API_PATH = "/api/pano-chain-settings";

function isSettings(value: unknown): value is PanoChainSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<PanoChainSettings>;
  return Array.isArray(settings.segments) && Array.isArray(settings.extraRanges);
}

export async function loadPanoChainSettings(): Promise<Record<string, PanoChainSettings>> {
  try {
    const response = await fetch(API_PATH);
    if (!response.ok) return {};
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};
    return Object.fromEntries(
      Object.entries(body).filter(([, settings]) => isSettings(settings))
    ) as Record<string, PanoChainSettings>;
  } catch {
    return {};
  }
}

export async function savePanoChainSettings(
  routeId: string,
  settings: PanoChainSettings
): Promise<void> {
  const all = await loadPanoChainSettings();
  all[routeId] = settings;
  const response = await fetch(API_PATH, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(all),
  });
  if (!response.ok) throw new Error("区間の設定を保存できませんでした");
}
