# 引き継ぎ手順書: OpenRouteService によるルート生成の置き換え

作成日: 2026-07-09 ／ 引き継ぎ先: Claude Opus（実装担当）
対象プロジェクト: bike-streetview（屋内エアロバイク × Street View 擬似サイクリング）

## 1. 背景と目的

現在のルート自動作成は Google Routes API（`travelMode: DRIVE` + `avoidTolls` + `avoidHighways` + 代替ルートから曲がり最少を選択）だが、以下の課題が残っている。

- 車が通れないような細い生活道路をルートに含めることがある
- 「国道・府道のような大きい道路を優先」という指定が Google Routes API では原理的に不可能（道路種別の指定機能がない）

OpenRouteService（以下 ORS）は OSM ベースのルーティング API で、無料枠が大きく、
高速・有料回避に対応し、標高付きジオメトリも返せる。本手順書は ORS への置き換え
（Googleフォールバック付き）の実装手順を定義する。

将来的に「国道・府道の明示的な優先」が必要になった場合は、GraphHopper の
カスタムモデル（road_class 重み付け）へ進む。→ 9章参照。

## 2. 料金・制限（2026-07 時点の調査結果）

- ORS 公式ホスト版（HeiGIT アカウント）: **無料。2,500リクエスト/日、40,000/月、同時40**
  - 出典: https://openrouteservice.org/restrictions/ 、https://account.heigit.org/info/plans
  - 本アプリはルート作成・プレビュー時のみ呼ぶため、無料枠で十分（1日数十回程度）
- API キー取得: https://account.heigit.org/ でサインアップ → トークン発行

## 3. 現状アーキテクチャ（変更対象の把握）

ルート生成はすべて **`vite.config.ts` 内のローカルAPIプラグイン**（`routesApiPlugin`）で行う。
フロントエンドは `/api/routes/:id`（組み込みルート）と `/api/routes/compute`（POST・カスタム作成）
を叩くだけで、レスポンス形式（`RouteApiResult`）しか知らない。**フロント側の改修はほぼ不要**。

```
RouteCreator.tsx / App.tsx
  └─ fetch /api/routes/compute        ← ここは変えない
       └─ vite.config.ts routesApiPlugin
            ├─ 現在: Google Routes API + Elevation API
            └─ 今回: ORS を第一候補に、失敗時 Google へフォールバック
```

レスポンス契約（`RouteApiResult`、vite.config.ts 冒頭で定義）:

```ts
{
  encodedPolyline: string;        // ORS利用時は "" でよい（coordinates優先のため）
  distanceMeters?: number;
  travelMode: "BICYCLE" | "DRIVE" | "WALK";
  routeType?: "自転車ルート" | "車ルート" | "徒歩ルート" | "幹線道路優先ルート";
  coordinates?: Array<{ lat: number; lng: number; elevation: number }>;
  warning?: string;
}
```

重要: フロント（`googleRoutesLoader.ts` の `parseGoogleRoutesResponse`）は
`coordinates` があれば `encodedPolyline` を無視して使う。**ORS は座標列＋標高を
直接返せるので、`coordinates` に詰めるだけでよい**。Elevation API 呼び出しも不要になる。

## 4. 実装方針

- 環境変数 `ORS_API_KEY` が設定されている場合のみ ORS を使う（未設定なら現行 Google のまま）
- ORS 呼び出しが失敗（レート超過・タイムアウト・経路なし）したら現行の Google 実装へフォールバックし、`warning` にその旨を入れる
- 対象は移動モード `MAIN_ROAD`（幹線道路優先）と `DRIVE`。`BICYCLE`/`WALK`/`AUTO` は当面 Google のまま（ORSのcycling-regular等への拡張は任意）
- 曲がり最少選択（`selectFewestTurnRoute` 相当）は ORS の `alternative_routes` に対しても適用する

## 5. ORS API 仕様（実装に必要な部分のみ）

エンドポイント（driving-car・GeoJSON形式）:

```
POST https://api.openrouteservice.org/v2/directions/driving-car/geojson
Authorization: <ORS_API_KEY>
Content-Type: application/json
```

リクエストボディ例:

```json
{
  "coordinates": [[135.501, 34.693], [135.868, 35.004]],
  "preference": "recommended",
  "elevation": true,
  "options": { "avoid_features": ["highways", "tollways", "ferries"] },
  "alternative_routes": { "target_count": 3, "share_factor": 0.6, "weight_factor": 1.6 },
  "instructions": false,
  "geometry_simplify": false
}
```

必ず守ること:

- **座標は [経度, 緯度] の順**（Google と逆。バグの定番）
- `elevation: true` のとき GeoJSON の各座標は `[lng, lat, ele]` の3要素になる
- `alternative_routes` は **経由地（3点以上の coordinates）と併用不可**。経由地ありのときは外す
- 経由地は `coordinates` 配列の中間要素として渡す（現行の `intermediates` をそのまま座標化して挿入）
- `preference: "recommended"` は大きい道路を選びやすい（`fastest`/`shortest` は抜け道を選びやすい）
- レート制限時は HTTP 429、`error.message` 入りのJSONが返る

レスポンス（GeoJSON）の読み方:

```
features[i].geometry.coordinates  → [[lng, lat, ele], ...]  経路ジオメトリ
features[i].properties.summary.distance → 距離 [m]
```

## 6. ジオコーディング（地名 → 座標）

ORS は地名文字列を受けないため、`origin`/`destination`/`intermediates` が文字列の場合は
座標化が必要。方法は2つ（どちらでもよいが a を推奨）:

- (a) **ORS Geocoding**（同じAPIキー・同じ無料枠内）:
  `GET https://api.openrouteservice.org/geocode/search?text=大阪駅&boundary.country=JP&size=1`
  → `features[0].geometry.coordinates` が `[lng, lat]`
- (b) 既存の Google Geocoding API を流用

地図クリックで作った経由地はすでに座標なのでジオコーディング不要。
RouteCreator の入力形式（`表示名 | 緯度,経度`）のパースは `routeWaypointInput.ts` 参照。

## 7. 実装手順（ステップ・バイ・ステップ）

1. `.env.example` に `ORS_API_KEY=` を追記し、コメントで取得先URLを書く
2. `vite.config.ts` に `computeOrsRoute(definition)` を追加:
   - 文字列ウェイポイントをジオコーディング（6章）
   - 5章のボディで directions を呼ぶ（経由地なしなら alternative_routes 付き）
   - 代替が複数返ったら既存 `sharpTurnsPerKm` / `selectFewestTurnRoute` と同等のロジックで
     曲がり最少を選択（座標形式が違うので流用時は変換に注意）
   - GeoJSON → `RouteApiResult` へ変換:
     `coordinates: geometry.coordinates.map(([lng, lat, ele]) => ({ lat, lng, elevation: ele ?? 0 }))`
     `travelMode: "DRIVE"`、`routeType: "幹線道路優先ルート"`、`encodedPolyline: ""`
   - `distanceMeters: properties.summary.distance`
3. `routesApiPlugin` のハンドラで、`ORS_API_KEY` があり、かつ移動モードが
   `MAIN_ROAD` / `DRIVE` のとき `computeOrsRoute` を先に試す。
   例外時は現行 Google パスへフォールバックし、
   `warning: "ORSでの取得に失敗したため、Google Routesのルートを使用しています。"` を付ける
4. `includeElevation` フラグ: ORS 使用時は Elevation API を呼ばない
   （`elevation: true` で足りる）。ORS 失敗 → Google フォールバック時のみ従来通り
5. キャッシュ: 組み込みルートの `routeCache` の仕組みは現行のまま流用
6. RouteCreator の移動モード表記を更新（例:「幹線道路優先（OSM・高速/有料回避）」）。
   ORS には既知の制限として自転車通行不可道路の完全判定はないことをUI注記に追加してもよい

## 8. テスト・受け入れ条件

- `npm test` 全通過（既存 70件以上）。vite.config.ts はテスト対象外だが、
  座標変換・曲がり最少選択を関数として切り出せる場合は単体テストを追加すること
- 手動確認（要 ORS_API_KEY）:
  1. 淀屋橋 → 大津 を幹線道路優先で作成 → プレビューの青線が
     高速に乗らず、細い生活道路を通らないこと（御堂筋・京阪国道等の大きな道になるはず）
  2. 経由地ピンを置いて引き直しても機能すること（alternative_routes が外れること）
  3. `ORS_API_KEY` を消して起動 → 従来の Google ルートで動くこと（回帰確認）
  4. 標高グラフ・勾配が ORS 経由でも表示されること（elevation値の妥当性）
- Street View 表示側（streetViewController.ts）は**一切変更しない**こと。
  表示はルート polyline にのみ依存しており、今回のスコープ外

## 9. 将来拡張: 国道・府道の明示的な優先（GraphHopper）

ORS ホスト版でも道路クラスの重み付けはできない。「国道・府道を優先」を厳密にやる場合:

- GraphHopper のカスタムモデルで `road_class` に priority を掛ける:

```json
{
  "priority": [
    { "if": "road_class == MOTORWAY", "multiply_by": "0.0" },
    { "if": "road_class == TRUNK || road_class == PRIMARY", "multiply_by": "1.0" },
    { "if": "road_class == SECONDARY", "multiply_by": "0.9" },
    { "if": "road_class == RESIDENTIAL", "multiply_by": "0.3" },
    { "else": "", "multiply_by": "0.6" }
  ]
}
```

- OSMでは 国道 ≒ trunk/primary、府道 ≒ primary/secondary
- クラウド版 GraphHopper の無料枠（500クレジット/日）でカスタムモデルが使えるかは
  要確認（要検証: https://www.graphhopper.com/pricing/ ）。使えない場合は
  Docker で自前ホスト（日本の OSM 抽出 ~2GB、`graphhopper/graphhopper` イメージ +
  custom_models 設定）すれば完全無料
- この場合も `/api/routes` のレスポンス契約はそのままでよく、フロント改修は不要

## 10. 参考リンク

- ORS 制限: https://openrouteservice.org/restrictions/
- ORS Directions API リファレンス: https://openrouteservice.org/dev/#/api-docs/v2/directions
- ORS Geocoding: https://openrouteservice.org/dev/#/api-docs/geocode
- HeiGIT アカウント（キー発行）: https://account.heigit.org/
- GraphHopper カスタムモデル: https://docs.graphhopper.com/openapi/custom-model
