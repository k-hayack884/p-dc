import { isPanoChain, type PanoChain } from "./panoChain";

/**
 * パノラマ列の保存先。開発サーバーの .data/pano-chains.json に
 * { [routeId]: PanoChain } の形で永続化する（custom-routes と同じ方式）。
 */
const API_PATH = "/api/pano-chains";

export async function loadPanoChains(): Promise<Record<string, PanoChain>> {
  try {
    const response = await fetch(API_PATH);
    if (!response.ok) return {};
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};
    return Object.fromEntries(
      Object.entries(body).filter(([, chain]) => isPanoChain(chain))
    ) as Record<string, PanoChain>;
  } catch {
    return {};
  }
}

export async function loadPanoChain(
  routeId: string
): Promise<PanoChain | null> {
  return (await loadPanoChains())[routeId] ?? null;
}

async function persistPanoChains(
  chains: Record<string, PanoChain>
): Promise<void> {
  const response = await fetch(API_PATH, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chains),
  });
  if (!response.ok) {
    throw new Error("パノラマ列を保存できませんでした");
  }
}

export async function savePanoChain(chain: PanoChain): Promise<void> {
  const chains = await loadPanoChains();
  chains[chain.routeId] = chain;
  await persistPanoChains(chains);
}

export async function deletePanoChain(routeId: string): Promise<void> {
  const chains = await loadPanoChains();
  if (!(routeId in chains)) return;
  delete chains[routeId];
  await persistPanoChains(chains);
}
