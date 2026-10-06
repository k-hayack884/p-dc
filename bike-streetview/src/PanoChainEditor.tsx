import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "./types";
import {
  PANO_CHAIN_FLAG_LABELS,
  groupReviewSections,
  isChainStale,
  isMajorFlagged,
  reviewFlags,
  summarizeChain,
  type PanoChain,
  type PanoChainEntry,
} from "./modules/panoChain";
import {
  PanoChainBuilder,
  type PanoChainBuildProgress,
} from "./modules/panoChainBuilder";
import { loadPanoChain, savePanoChain } from "./modules/panoChainStore";
import {
  groupMarkedSections,
  repairPanoChain,
  type RepairProgress,
} from "./modules/panoChainRepair";
import { getPointAtDistance } from "./modules/routeSampler";
import { totalDistance } from "./modules/routeLoader";
import {
  distanceAlongRoute,
  rangesFromSettings,
  totalRangeDistance,
  type PanoChainRange,
  type PanoChainSettings,
} from "./modules/panoChainSegments";
import { savePanoChainSettings } from "./modules/panoChainSettingsStore";
import { loadMapsApi } from "./modules/streetViewController";
import { recordStreetViewUsage } from "./modules/streetViewUsage";

/** 区間設定に使う地点（出発地・経由地・目的地）とルート上の距離（不明なら null） */
export type PanoChainSectionPoint = {
  label: string;
  distanceM: number | null;
};

/** 地図クリックで距離指定の区間の開始・終了を選んでいる状態 */
type RangePick = { index: number; edge: "startM" | "endM" };

type PanoChainEditorProps = {
  apiKey: string;
  routeId: string;
  title: string;
  /** ルートと、区間設定用の地点・保存済みの区間設定を読み込む */
  loadRoute: () => Promise<{
    route: Route;
    points: PanoChainSectionPoint[];
    settings: PanoChainSettings;
  }>;
  onClose: () => void;
};

/** 確認画面の自動再生間隔 [ms] */
const PLAY_INTERVAL_MS = 400;

function formatKm(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km`;
}

/**
 * パノラマ列の作成・確認画面。
 * 自動作成した並びを1枚ずつ（または要確認の箇所だけ）見て、
 * 高架下・河川敷・反対車線などの誤りを「除外して作り直す」で直す。
 */
export function PanoChainEditor({
  apiKey,
  routeId,
  title,
  loadRoute,
  onClose,
}: PanoChainEditorProps) {
  const [route, setRoute] = useState<Route | null>(null);
  const [points, setPoints] = useState<PanoChainSectionPoint[]>([]);
  const [settings, setSettings] = useState<PanoChainSettings | null>(null);
  const [savedSettingsJson, setSavedSettingsJson] = useState("");
  const [rangePick, setRangePick] = useState<RangePick | null>(null);
  const settingsDirty =
    settings !== null && JSON.stringify(settings) !== savedSettingsJson;
  const ranges = useMemo<PanoChainRange[] | undefined>(
    () =>
      settings
        ? rangesFromSettings(
            points.map((point) => point.distanceM),
            settings
          )
        : undefined,
    [points, settings]
  );
  const [chain, setChain] = useState<PanoChain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [building, setBuilding] = useState<PanoChainBuildProgress | null>(null);
  const [repairing, setRepairing] = useState<RepairProgress | null>(null);
  /** 除外予定のパノラマID（「まとめて再生成」で反映する） */
  const [marked, setMarked] = useState<Set<string>>(() => new Set());
  const busy = Boolean(building) || Boolean(repairing);
  const [playing, setPlaying] = useState(false);
  const buildAbortRef = useRef<AbortController | null>(null);
  const builderRef = useRef<PanoChainBuilder | null>(null);

  const entries = useMemo(() => chain?.entries ?? [], [chain]);
  const entry: PanoChainEntry | undefined = entries[index];
  const sections = useMemo(() => groupReviewSections(entries), [entries]);
  const flaggedIndexes = useMemo(
    () => sections.map((section) => section.startIndex),
    [sections]
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadRoute(), loadPanoChain(routeId)])
      .then(([loaded, loadedChain]) => {
        if (cancelled) return;
        setRoute(loaded.route);
        setPoints(loaded.points);
        setSettings(loaded.settings);
        setSavedSettingsJson(JSON.stringify(loaded.settings));
        setChain(loadedChain);
      })
      .catch((loadError: Error) => {
        if (!cancelled) setError(loadError.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadRoute, routeId]);

  useEffect(() => () => buildAbortRef.current?.abort(), []);

  const getBuilder = useCallback(async () => {
    if (!builderRef.current) {
      const googleApi = await loadMapsApi(apiKey);
      builderRef.current = new PanoChainBuilder(
        new googleApi.maps.StreetViewService()
      );
    }
    return builderRef.current;
  }, [apiKey]);

  /** 先頭 keepCount 件を残して作り直す（0なら最初から） */
  const build = useCallback(
    async (keepCount: number, excluded: string[]) => {
      if (!route) return;
      buildAbortRef.current?.abort();
      const abort = new AbortController();
      buildAbortRef.current = abort;
      setPlaying(false);
      setMessage(null);
      setBuilding({
        distanceM: 0,
        routeDistanceM: totalDistance(route),
        count: keepCount,
      });
      try {
        if (settings && settingsDirty) {
          await savePanoChainSettings(routeId, settings);
          setSavedSettingsJson(JSON.stringify(settings));
        }
        const builder = await getBuilder();
        const built = await builder.build({
          routeId,
          route,
          excluded,
          baseEntries: chain?.entries.slice(0, keepCount),
          ranges,
          onProgress: setBuilding,
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setChain(built);
        setMarked(new Set());
        setDirty(true);
        setIndex(Math.min(Math.max(keepCount - 1, 0), built.entries.length - 1));
        const summary = summarizeChain(built, totalDistance(route));
        setMessage(
          summary.coverage < 0.98
            ? `終点まで届きませんでした（${Math.round(summary.coverage * 100)}%）。最後の付近を確認してください`
            : `作成しました。要確認 ${summary.majorCount} 件${
                built.removedExcursions
                  ? `（1〜数枚だけ別の道へ行く寄り道 ${built.removedExcursions} 枚を自動で除去）`
                  : ""
              }`
        );
      } catch (buildError) {
        if ((buildError as Error).name !== "AbortError") {
          setMessage(`作成に失敗しました: ${(buildError as Error).message}`);
        }
      } finally {
        if (buildAbortRef.current === abort) {
          buildAbortRef.current = null;
          setBuilding(null);
        }
      }
    },
    [chain, getBuilder, ranges, route, routeId, settings, settingsDirty]
  );

  const saveSettings = async () => {
    if (!settings) return;
    try {
      await savePanoChainSettings(routeId, settings);
      setSavedSettingsJson(JSON.stringify(settings));
      setMessage(
        chain
          ? "区間の設定を保存しました。「最初から作り直す」でパノラマ列に反映されます"
          : "区間の設定を保存しました"
      );
    } catch (saveError) {
      setMessage((saveError as Error).message);
    }
  };

  /** 地図クリック: 距離指定の区間を選んでいる最中なら、その位置の距離を入れる */
  const handleMapClick = (position: google.maps.LatLngLiteral): boolean => {
    if (!rangePick || !route || !settings) return false;
    const distanceM = Math.round(distanceAlongRoute(route, position));
    setSettings({
      ...settings,
      extraRanges: settings.extraRanges.map((range, rangeIndex) =>
        rangeIndex === rangePick.index ? { ...range, [rangePick.edge]: distanceM } : range
      ),
    });
    setRangePick(null);
    return true;
  };

  const markedSections = useMemo(
    () => groupMarkedSections(entries, marked),
    [entries, marked]
  );

  /** 表示中のパノラマの除外予定を付け外しする */
  const toggleMark = () => {
    if (!entry) return;
    setMarked((current) => {
      const next = new Set(current);
      if (next.has(entry.pano)) next.delete(entry.pano);
      else next.add(entry.pano);
      return next;
    });
  };

  /** 現在地から次の乗り継ぎ手前まで（同じ撮影列の区間）を除外予定にする */
  const markSection = () => {
    if (!entry) return;
    let end = index + 1;
    while (end < entries.length && entries[end].source === "link") end += 1;
    setMarked((current) => {
      const next = new Set(current);
      entries.slice(index, end).forEach((item) => next.add(item.pano));
      return next;
    });
    // 区間の終わりの次へ進めて、続けて確認できるようにする
    setIndex(Math.min(end, entries.length - 1));
  };

  /** 除外予定をまとめて反映する（印を付けた区間の周辺だけ作り直す） */
  const applyMarks = async () => {
    if (!chain || !route || marked.size === 0) return;
    buildAbortRef.current?.abort();
    const abort = new AbortController();
    buildAbortRef.current = abort;
    setPlaying(false);
    setMessage(null);
    const firstMarkedIndex = markedSections[0]?.startIndex ?? 0;
    try {
      const builder = await getBuilder();
      const repaired = await repairPanoChain({
        builder,
        chain,
        route,
        marked,
        onProgress: setRepairing,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      setChain(repaired);
      setMarked(new Set());
      setDirty(true);
      setIndex(Math.max(Math.min(firstMarkedIndex - 1, repaired.entries.length - 1), 0));
      const summary = summarizeChain(repaired, totalDistance(route));
      setMessage(
        `${markedSections.length}区間を再生成しました。要確認 ${summary.majorCount} 件（保存すると走行に反映されます）`
      );
    } catch (repairError) {
      if ((repairError as Error).name !== "AbortError") {
        setMessage(`再生成に失敗しました: ${(repairError as Error).message}`);
      }
    } finally {
      if (buildAbortRef.current === abort) {
        buildAbortRef.current = null;
        setRepairing(null);
      }
    }
  };

  const rebuildFromHere = () => {
    void build(Math.max(index, 1), chain?.excluded ?? []);
  };

  const save = async () => {
    if (!chain) return;
    setSaving(true);
    try {
      await savePanoChain(chain);
      setDirty(false);
      setMessage("保存しました。次回の走行からこのパノラマ列で再生します");
    } catch (saveError) {
      setMessage((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (
      (dirty || marked.size > 0 || settingsDirty) &&
      !window.confirm(
        "保存していない変更（除外予定・区間の設定を含む）があります。閉じますか？"
      )
    ) {
      return;
    }
    buildAbortRef.current?.abort();
    onClose();
  };

  const jumpFlag = (direction: 1 | -1) => {
    const next =
      direction > 0
        ? flaggedIndexes.find((itemIndex) => itemIndex > index)
        : [...flaggedIndexes].reverse().find((itemIndex) => itemIndex < index);
    if (next !== undefined) setIndex(next);
  };

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (index >= entries.length - 1) {
        setPlaying(false);
        return;
      }
      setIndex(index + 1);
    }, PLAY_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [entries.length, index, playing]);

  const routeDistanceM = route ? totalDistance(route) : 0;
  const summary = chain ? summarizeChain(chain, routeDistanceM) : null;
  const stale = chain && route ? isChainStale(chain, route) : false;
  // ルート作成時の区間設定と、パノラマ列を作ったときの範囲が違う
  const rangesChanged =
    chain !== null &&
    JSON.stringify(chain.ranges ?? null) !== JSON.stringify(ranges ?? null);
  const noRanges = ranges !== undefined && ranges.length === 0;

  return (
    <div className="route-preview-backdrop" role="presentation">
      <section
        className="route-preview-dialog pano-chain-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pano-chain-title"
      >
        <div className="route-preview-header">
          <div>
            <p className="route-selection-kicker">PANORAMA CHAIN</p>
            <h2 id="pano-chain-title">{title}</h2>
            {summary && (
              <small>
                {summary.count}枚 ｜ 到達 {Math.round(summary.coverage * 100)}% ｜
                要確認 {summary.majorCount}件 ｜ 作成{" "}
                {new Date(chain!.builtAt).toLocaleString("ja-JP")}
                {dirty && " ｜ 未保存"}
              </small>
            )}
            {!summary && !loading && <small>パノラマ列はまだありません</small>}
          </div>
          <div className="pano-chain-header-actions">
            <button
              type="button"
              disabled={!route || busy || noRanges}
              onClick={() => {
                if (
                  chain &&
                  !window.confirm("最初から作り直します。除外の指定は引き継ぎます。よろしいですか？")
                ) {
                  return;
                }
                void build(0, chain?.excluded ?? []);
              }}
            >
              {chain ? "最初から作り直す" : "自動作成"}
            </button>
            {chain && chain.excluded.length > 0 && (
              <button
                type="button"
                disabled={!route || busy}
                title="これまでに除外したパノラマもすべて候補に戻し、まっさらな状態から作り直します"
                onClick={() => {
                  if (
                    !window.confirm(
                      `除外した ${chain.excluded.length} 枚もすべて候補に戻して、最初から作り直します。よろしいですか？`
                    )
                  ) {
                    return;
                  }
                  setMarked(new Set());
                  void build(0, []);
                }}
              >
                除外もリセットして作り直す（{chain.excluded.length}枚）
              </button>
            )}
            <button
              type="button"
              className="pano-chain-save"
              disabled={!chain || !dirty || saving || busy || marked.size > 0}
              title={marked.size > 0 ? "除外予定を「まとめて再生成」で反映してから保存してください" : undefined}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
            </button>
            <button type="button" onClick={close}>
              閉じる
            </button>
          </div>
        </div>

        {loading && <p className="route-preview-message">読み込み中…</p>}
        {error && <p className="route-preview-error">{error}</p>}
        {stale && (
          <p className="route-preview-error">
            ルートが作り直されているため、このパノラマ列は走行に使われません。作り直してください。
          </p>
        )}
        {settings && route && (
          <PanoSectionSettings
            points={points}
            settings={settings}
            ranges={ranges}
            routeDistanceM={routeDistanceM}
            dirty={settingsDirty}
            rangePick={rangePick}
            disabled={busy}
            onChange={setSettings}
            onPick={setRangePick}
            onSave={() => void saveSettings()}
          />
        )}
        {noRanges && (
          <p className="route-preview-error">
            パノラマ列を使う区間が選ばれていません。下の「区間の設定」で選んでください。
          </p>
        )}
        {rangesChanged && !stale && (
          <p className="route-preview-error">
            区間の設定がパノラマ列を作ったときと変わっています。「最初から作り直す」で反映してください。
          </p>
        )}
        {building && (
          <p className="route-preview-message pano-chain-progress">
            作成中… {formatKm(building.distanceM)} / {formatKm(building.routeDistanceM)}
            （{building.count}枚）
            <button type="button" onClick={() => buildAbortRef.current?.abort()}>
              中止
            </button>
          </p>
        )}
        {repairing && (
          <p className="route-preview-message pano-chain-progress">
            再生成中… 区間 {repairing.section} / {repairing.sectionCount}（
            {formatKm(repairing.build.distanceM)} 付近）
            <button type="button" onClick={() => buildAbortRef.current?.abort()}>
              中止
            </button>
          </p>
        )}
        {marked.size > 0 && !busy && (
          <div className="route-preview-message pano-chain-pending">
            <span>
              除外予定 {marked.size}枚（{markedSections.length}区間）
            </span>
            <button type="button" className="pano-chain-apply" onClick={() => void applyMarks()}>
              まとめて再生成
            </button>
            <button type="button" onClick={() => setMarked(new Set())}>
              すべて取り消す
            </button>
          </div>
        )}
        {message && !busy && <p className="route-preview-message">{message}</p>}

        {route && !loading && (
          <div className="pano-chain-body">
            <PanoChainViewer
              apiKey={apiKey}
              route={route}
              entries={entries}
              marked={marked}
              ranges={ranges}
              index={index}
              onSelectIndex={setIndex}
              onMapClick={handleMapClick}
            />

            {entry && (
              <div className="pano-chain-controls">
                <div className="pano-chain-nav">
                  <button type="button" onClick={() => jumpFlag(-1)}>
                    ◀◀ 前の要確認
                  </button>
                  <button
                    type="button"
                    onClick={() => setIndex((current) => Math.max(current - 1, 0))}
                  >
                    ◀ 前
                  </button>
                  <button type="button" onClick={() => setPlaying((value) => !value)}>
                    {playing ? "停止" : "再生"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setIndex((current) => Math.min(current + 1, entries.length - 1))
                    }
                  >
                    次 ▶
                  </button>
                  <button type="button" onClick={() => jumpFlag(1)}>
                    次の要確認 ▶▶
                  </button>
                </div>
                <input
                  type="range"
                  aria-label="パノラマ列の位置"
                  min={0}
                  max={Math.max(entries.length - 1, 0)}
                  value={index}
                  onChange={(event) => setIndex(Number(event.target.value))}
                />
                <div className="pano-chain-entry-info">
                  <strong>
                    {index + 1} / {entries.length} ｜ {formatKm(entry.distanceM)}
                  </strong>
                  <span>
                    撮影 {entry.imageDate ?? "不明"} ｜ ずれ {entry.sideM.toFixed(1)} m ｜{" "}
                    {entry.source === "search" ? "乗り継ぎ" : "リンク"}
                  </span>
                  <span>{entry.description ?? ""}</span>
                  {marked.has(entry.pano) && (
                    <span className="pano-chain-marked-badge">除外予定</span>
                  )}
                  {reviewFlags(entry).length > 0 && (
                    <span className="pano-chain-flags">
                      {reviewFlags(entry)
                        .map((flag) => PANO_CHAIN_FLAG_LABELS[flag])
                        .join(" / ")}
                    </span>
                  )}
                </div>
                <div className="pano-chain-fix">
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    onClick={toggleMark}
                  >
                    {marked.has(entry.pano)
                      ? "このパノラマの除外予定を取り消す"
                      : "このパノラマを除外予定にする"}
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    onClick={markSection}
                    title="高架下・河川敷などの別の撮影列に入った場合、次の乗り継ぎまでをまとめて除外予定にします"
                  >
                    この区間（次の乗り継ぎまで）を除外予定にする
                  </button>
                  <button
                    type="button"
                    disabled={busy || marked.size > 0}
                    onClick={rebuildFromHere}
                  >
                    ここから先を作り直す
                  </button>
                </div>
              </div>
            )}

            {sections.length > 0 && (
              <div className="pano-chain-flag-list">
                <strong>要確認区間 {sections.length}件</strong>
                <ul>
                  {sections.map((section) => {
                    const current =
                      index >= section.startIndex && index <= section.endIndex;
                    return (
                      <li key={section.startIndex}>
                        <button
                          type="button"
                          className={["is-major", current ? "is-current" : ""].join(" ")}
                          onClick={() =>
                            // 区間の少し手前から見ると、どこで別の道に入ったか分かりやすい
                            setIndex(Math.max(section.startIndex - 2, 0))
                          }
                        >
                          {section.startIndex === section.endIndex
                            ? formatKm(section.startM)
                            : `${formatKm(section.startM)}〜${formatKm(section.endM)}`}{" "}
                          ｜{" "}
                          {section.flags
                            .map((flag) => PANO_CHAIN_FLAG_LABELS[flag])
                            .join(" / ")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

type PanoChainViewerProps = {
  apiKey: string;
  route: Route;
  entries: PanoChainEntry[];
  marked: Set<string>;
  /** パノラマ列を作る範囲（地図に太線で示す） */
  ranges: PanoChainRange[] | undefined;
  index: number;
  onSelectIndex: (index: number) => void;
  /** 地図クリックを先に処理する（true を返したらエントリ選択はしない） */
  onMapClick: (position: google.maps.LatLngLiteral) => boolean;
};

/** パノラマのプレビューと、ルート・パノラマ列・要確認地点の地図 */
function PanoChainViewer({
  apiKey,
  route,
  entries,
  marked,
  ranges,
  index,
  onSelectIndex,
  onMapClick,
}: PanoChainViewerProps) {
  const panoElementRef = useRef<HTMLDivElement>(null);
  const mapElementRef = useRef<HTMLDivElement>(null);
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const currentMarkerRef = useRef<google.maps.Circle | null>(null);
  const overlaysRef = useRef<Array<{ setMap(map: google.maps.Map | null): void }>>([]);
  const entriesRef = useRef(entries);
  const onSelectRef = useRef(onSelectIndex);
  const onMapClickRef = useRef(onMapClick);
  const rangeOverlaysRef = useRef<google.maps.Polyline[]>([]);
  const [ready, setReady] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);

  useEffect(() => {
    entriesRef.current = entries;
    onSelectRef.current = onSelectIndex;
    onMapClickRef.current = onMapClick;
  }, [entries, onMapClick, onSelectIndex]);

  // 地図とパノラマ（インスタンス化1回＝Dynamic Street View課金1回）を用意する
  useEffect(() => {
    let cancelled = false;
    loadMapsApi(apiKey)
      .then(async (googleApi) => {
        const { Map } = (await googleApi.maps.importLibrary(
          "maps"
        )) as google.maps.MapsLibrary;
        if (cancelled || !mapElementRef.current || !panoElementRef.current) return;

        const path = route.points.map((point) => ({ lat: point.lat, lng: point.lng }));
        const map = new Map(mapElementRef.current, {
          center: path[0],
          zoom: 17,
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false,
          clickableIcons: false,
        });
        new googleApi.maps.Polyline({
          path,
          strokeColor: "#2563eb",
          strokeOpacity: 0.6,
          strokeWeight: 6,
          map,
        });
        // 地図クリックで最寄りのエントリへ移動する
        map.addListener("click", (event: google.maps.MapMouseEvent) => {
          const latLng = event.latLng;
          if (!latLng) return;
          if (onMapClickRef.current(latLng.toJSON())) return;
          let best = -1;
          let bestDistance = Number.POSITIVE_INFINITY;
          entriesRef.current.forEach((item, itemIndex) => {
            const distance = Math.hypot(
              item.lat - latLng.lat(),
              (item.lng - latLng.lng()) * Math.cos((item.lat * Math.PI) / 180)
            );
            if (distance < bestDistance) {
              bestDistance = distance;
              best = itemIndex;
            }
          });
          if (best >= 0) onSelectRef.current(best);
        });
        mapRef.current = map;

        panoramaRef.current = new googleApi.maps.StreetViewPanorama(
          panoElementRef.current,
          {
            addressControl: false,
            linksControl: false,
            fullscreenControl: false,
            motionTracking: false,
            showRoadLabels: false,
            visible: true,
          }
        );
        recordStreetViewUsage();
        setReady(true);
      })
      .catch((loadError: Error) => {
        if (!cancelled) setViewerError(loadError.message);
      });
    return () => {
      cancelled = true;
      panoramaRef.current?.setVisible(false);
    };
  }, [apiKey, route]);

  // パノラマ列の線と要確認地点を描く
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    overlaysRef.current.forEach((overlay) => overlay.setMap(null));
    overlaysRef.current = [];

    overlaysRef.current.push(
      new google.maps.Polyline({
        path: entries.map((item) => ({ lat: item.lat, lng: item.lng })),
        strokeColor: "#22c55e",
        strokeOpacity: 0.95,
        strokeWeight: 3,
        map,
      })
    );
    entries.forEach((item) => {
      const isMarked = marked.has(item.pano);
      if (reviewFlags(item).length === 0 && !isMarked) return;
      overlaysRef.current.push(
        new google.maps.Circle({
          center: { lat: item.lat, lng: item.lng },
          radius: isMarked ? 6 : isMajorFlagged(item) ? 7 : 4,
          strokeWeight: isMarked ? 2 : 0,
          strokeColor: "#f8fafc",
          // 除外予定は黒、要確認は赤（強）・黄（弱）
          fillColor: isMarked
            ? "#111827"
            : isMajorFlagged(item)
              ? "#ef4444"
              : "#f59e0b",
          fillOpacity: 0.9,
          clickable: false,
          map,
        })
      );
    });
  }, [entries, marked, ready]);

  // パノラマ列を作る範囲を太いオレンジ線で示す（ルート全体なら描かない）
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    rangeOverlaysRef.current.forEach((overlay) => overlay.setMap(null));
    rangeOverlaysRef.current = (ranges ?? []).map(
      (range) =>
        new google.maps.Polyline({
          path: route.points
            .filter(
              (point) => point.distance >= range.startM && point.distance <= range.endM
            )
            .map((point) => ({ lat: point.lat, lng: point.lng })),
          strokeColor: "#f97316",
          strokeOpacity: 0.55,
          strokeWeight: 12,
          clickable: false,
          map,
        })
    );
  }, [ranges, ready, route]);

  // 選択中のエントリを表示する
  useEffect(() => {
    const entry = entries[index];
    const map = mapRef.current;
    const panorama = panoramaRef.current;
    if (!ready || !entry || !map || !panorama) return;

    const ahead = getPointAtDistance(route, entry.distanceM + 20);
    const heading =
      (Math.atan2(
        (ahead.lng - entry.lng) * Math.cos((entry.lat * Math.PI) / 180),
        ahead.lat - entry.lat
      ) *
        180) /
      Math.PI;
    panorama.setPano(entry.pano);
    panorama.setPov({ heading: (heading + 360) % 360, pitch: 0 });

    const center = { lat: entry.lat, lng: entry.lng };
    if (!currentMarkerRef.current) {
      currentMarkerRef.current = new google.maps.Circle({
        radius: 9,
        strokeColor: "#ffffff",
        strokeWeight: 2,
        fillColor: "#0ea5e9",
        fillOpacity: 1,
        clickable: false,
        zIndex: 10,
        map,
      });
    }
    currentMarkerRef.current.setCenter(center);
    map.panTo(center);
  }, [entries, index, ready, route]);

  if (viewerError) return <p className="route-preview-error">{viewerError}</p>;

  return (
    <div className="pano-chain-viewer">
      <div ref={panoElementRef} className="pano-chain-pano" />
      <div ref={mapElementRef} className="pano-chain-map" />
      {entries.length === 0 && (
        <p className="pano-chain-empty">
          「自動作成」でルートに沿ったパノラマ列を作ります（数分かかることがあります）
        </p>
      )}
    </div>
  );
}

type PanoSectionSettingsProps = {
  points: PanoChainSectionPoint[];
  settings: PanoChainSettings;
  ranges: PanoChainRange[] | undefined;
  routeDistanceM: number;
  dirty: boolean;
  rangePick: RangePick | null;
  disabled: boolean;
  onChange: (settings: PanoChainSettings) => void;
  onPick: (pick: RangePick | null) => void;
  onSave: () => void;
};

/**
 * パノラマ列を使う区間の設定。地点の間ごとのチェックと、距離での指定（地図クリック可）。
 * 経由地のない標準ルートでも、距離で局所的な区間だけを選べる
 */
function PanoSectionSettings({
  points,
  settings,
  ranges,
  routeDistanceM,
  dirty,
  rangePick,
  disabled,
  onChange,
  onPick,
  onSave,
}: PanoSectionSettingsProps) {
  const allSegments = settings.segments.every(Boolean);
  const setSegment = (segmentIndex: number, checked: boolean) =>
    onChange({
      ...settings,
      segments: settings.segments.map((value, index) =>
        index === segmentIndex ? checked : value
      ),
    });
  const setAllSegments = (checked: boolean) =>
    onChange({ ...settings, segments: settings.segments.map(() => checked) });
  const updateExtra = (rangeIndex: number, edge: "startM" | "endM", km: number) =>
    onChange({
      ...settings,
      extraRanges: settings.extraRanges.map((range, index) =>
        index === rangeIndex
          ? { ...range, [edge]: Math.round(Math.min(Math.max(km, 0) * 1000, routeDistanceM)) }
          : range
      ),
    });

  return (
    <details className="pano-section-settings" open={dirty || !allSegments}>
      <summary>
        区間の設定：
        {ranges === undefined
          ? "ルート全体でパノラマ列を使う"
          : ranges.length === 0
            ? "パノラマ列を使う区間なし"
            : `${ranges
                .map((range) => `${formatKm(range.startM)}〜${formatKm(range.endM)}`)
                .join("、")}（計 ${formatKm(totalRangeDistance(ranges))} / 全体 ${formatKm(routeDistanceM)}）`}
        {dirty && " ｜ 未保存"}
      </summary>
      <p className="pano-section-help">
        都心など高架・地下の取り違えが起きやすい区間だけ選ぶと、作成が速くなります。選んでいない区間は走行中にパノラマを探す方式で走ります。
      </p>

      <div className="pano-section-group">
        <div className="pano-section-group-header">
          <strong>地点の間</strong>
          <button type="button" disabled={disabled} onClick={() => setAllSegments(true)}>
            すべてオン
          </button>
          <button type="button" disabled={disabled} onClick={() => setAllSegments(false)}>
            すべてオフ
          </button>
        </div>
        {settings.segments.map((checked, segmentIndex) => {
          const from = points[segmentIndex];
          const to = points[segmentIndex + 1];
          return (
            <label key={segmentIndex} className="pano-section-segment">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => setSegment(segmentIndex, event.target.checked)}
              />
              {from?.label ?? "?"} → {to?.label ?? "?"}
              <small>
                {from?.distanceM !== null && from?.distanceM !== undefined
                  ? formatKm(from.distanceM)
                  : "?"}
                〜
                {to?.distanceM !== null && to?.distanceM !== undefined
                  ? formatKm(to.distanceM)
                  : "?"}
              </small>
            </label>
          );
        })}
        {allSegments && settings.segments.length > 0 && (
          <small>すべてオンの間はルート全体が対象です（距離での指定は使われません）。</small>
        )}
      </div>

      <div className="pano-section-group">
        <div className="pano-section-group-header">
          <strong>距離で指定</strong>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onChange({
                ...settings,
                extraRanges: [
                  ...settings.extraRanges,
                  { startM: 0, endM: Math.min(1000, routeDistanceM) },
                ],
              })
            }
          >
            ＋ 区間を追加
          </button>
        </div>
        {settings.extraRanges.length === 0 && (
          <small>経由地のないルートでも、km で区間を選べます（地図クリックでも指定できます）。</small>
        )}
        {settings.extraRanges.map((range, rangeIndex) => (
          <div key={rangeIndex} className="pano-section-range">
            {(["startM", "endM"] as const).map((edge) => (
              <span key={edge} className="pano-section-range-edge">
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  aria-label={`距離指定${rangeIndex + 1}の${edge === "startM" ? "開始" : "終了"} km`}
                  value={(range[edge] / 1000).toFixed(1)}
                  disabled={disabled}
                  onChange={(event) => updateExtra(rangeIndex, edge, Number(event.target.value))}
                />
                km
                <button
                  type="button"
                  disabled={disabled}
                  className={
                    rangePick?.index === rangeIndex && rangePick.edge === edge ? "is-picking" : ""
                  }
                  onClick={() =>
                    onPick(
                      rangePick?.index === rangeIndex && rangePick.edge === edge
                        ? null
                        : { index: rangeIndex, edge }
                    )
                  }
                >
                  {rangePick?.index === rangeIndex && rangePick.edge === edge
                    ? "地図をクリック…"
                    : "地図で選ぶ"}
                </button>
                {edge === "startM" && <span>〜</span>}
              </span>
            ))}
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...settings,
                  extraRanges: settings.extraRanges.filter((_, index) => index !== rangeIndex),
                })
              }
            >
              削除
            </button>
          </div>
        ))}
      </div>

      <div className="pano-section-actions">
        <button type="button" disabled={disabled || !dirty} onClick={onSave}>
          区間の設定を保存
        </button>
        <small>「自動作成」「最初から作り直す」を押すと、未保存の設定も保存してから作成します。</small>
      </div>
    </details>
  );
}
