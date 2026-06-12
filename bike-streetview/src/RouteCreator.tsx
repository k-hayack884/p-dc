import { useState, type FormEvent } from "react";
import type {
  CreateGoogleRouteRequest,
  GoogleTravelMode,
} from "./modules/googleRoutesLoader";
import { createGoogleRoutesRoute } from "./modules/googleRoutesLoader";
import {
  saveCustomRoute,
  type CustomRoute,
} from "./modules/customRoutes";

type RouteCreatorProps = {
  onCancel: () => void;
  onCreated: (route: CustomRoute) => void;
};

export function RouteCreator({ onCancel, onCreated }: RouteCreatorProps) {
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [intermediates, setIntermediates] = useState("");
  const [travelMode, setTravelMode] =
    useState<GoogleTravelMode | "AUTO">("AUTO");
  const [includeElevation, setIncludeElevation] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const request: CreateGoogleRouteRequest = {
      name: name.trim() || `${origin.trim()} → ${destination.trim()}`,
      origin: origin.trim(),
      destination: destination.trim(),
      intermediates: intermediates
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      travelMode,
      includeElevation,
    };

    try {
      const result = await createGoogleRoutesRoute(request);
      onCreated(saveCustomRoute(request, result));
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="route-selection">
      <form className="route-creator" onSubmit={submit}>
        <div>
          <p className="route-selection-kicker">ROUTE CREATOR</p>
          <h1>新しいルートを作成</h1>
        </div>

        <label>
          ルート名
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例: 大阪駅 → 京都駅"
          />
        </label>

        <div className="route-creator-columns">
          <label>
            出発地
            <input
              required
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="例: 大阪駅"
            />
          </label>
          <label>
            目的地
            <input
              required
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder="例: 京都駅"
            />
          </label>
        </div>

        <label>
          経由地
          <textarea
            value={intermediates}
            onChange={(event) => setIntermediates(event.target.value)}
            placeholder={"1行に1地点を入力\n例: 蒲生四丁目駅"}
            rows={4}
          />
          <small>入力順に通過します。最大25地点です。</small>
        </label>

        <div className="route-creator-columns">
          <label>
            移動モード
            <select
              value={travelMode}
              onChange={(event) =>
                setTravelMode(
                  event.target.value as GoogleTravelMode | "AUTO"
                )
              }
            >
              <option value="AUTO">自転車優先・なければ車</option>
              <option value="BICYCLE">自転車</option>
              <option value="DRIVE">車</option>
              <option value="WALK">徒歩</option>
            </select>
          </label>
          <label className="route-creator-checkbox">
            <input
              type="checkbox"
              checked={includeElevation}
              onChange={(event) => setIncludeElevation(event.target.checked)}
            />
            標高・勾配データを取得
          </label>
        </div>

        {error && <p className="route-creator-error">{error}</p>}

        <div className="route-creator-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" disabled={submitting}>
            {submitting ? "ルート作成中…" : "作成して走行"}
          </button>
        </div>
      </form>
    </div>
  );
}
