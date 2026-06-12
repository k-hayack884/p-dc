# Bike Street View - 屋内エアロバイク × Street View 擬似サイクリング

エアロバイクを漕ぐと Google Street View が進む、屋内ダイエット用の個人プロトタイプ。
詳細は設計仕様書（aerobike_streetview_design_spec.docx）を参照。

現在の実装状態: **Phase 1 MVP**（キーボード入力・KMZルート・100m更新・HUD）＋ Phase 2 準備（Web Serial / ESP32ファームウェア雛形）

## セットアップ

```bash
npm install
cp .env.example .env.local   # APIキーを記入（なくてもHUD・走行ロジックは動く）
npm run dev
```

ブラウザは **デスクトップChrome系** を使用すること（Web Serial対応のため）。

自動テスト:

```bash
npm test
```

### ブラウザでルートを作成

初期画面の「新しいルートを作成」から、住所や駅名を使ってルートを追加できる。

- 移動モード: 自転車優先（取得できない場合は車）、自転車、車、徒歩
- 経由地: 1行に1地点、最大25地点
- 標高取得: Elevation APIから標高・勾配データを生成
- 保存先: ブラウザのlocalStorage

作成には`GOOGLE_ROUTES_API_KEY`が必要。標高取得を有効にする場合は
`GOOGLE_ELEVATION_API_KEY`も設定する。

### Google Maps APIキー

1. Google Cloud Console でプロジェクト作成、**Maps JavaScript API** と **Geocoding API** を有効化
2. **予算アラートとクォータ制限を必ず設定**（仕様書 7章・10章）
3. `.env.local` の `VITE_GOOGLE_MAPS_API_KEY` に記入
4. Routes API を有効化し、`GOOGLE_ROUTES_API_KEY` にサーバー側キーを記入

Routes API有効化:
https://console.cloud.google.com/apis/library/routes.googleapis.com

Elevation API有効化:
https://console.cloud.google.com/apis/library/elevation-backend.googleapis.com

APIキーにAPI制限を設定している場合は、許可対象へ
`Maps JavaScript API`、`Geocoding API`、`Routes API`、`Elevation API`を追加する。

Elevation APIはHTTPリファラー制限付きキーを利用できない。
`.env.local`の`GOOGLE_ELEVATION_API_KEY`にはサーバー用キーを設定し、
可能なら実行環境のIPアドレス制限と`Elevation API`のAPI制限を設定する。

起動時は Routes API で以下の自転車ルートを生成する。

- 出発地: 新大阪駅
- 中間地点: 蒲生四丁目駅
- 目的地: 奈良駅

標高・勾配テスト用ルート:

- 出発地: 江坂駅
- 目的地: 箕面萱野駅
- Routes APIの経路に沿ってElevation APIを約50m間隔で取得
- 標高は前後2点の加重移動平均で平滑化
- 勾配は前後約200mの標高差から算出し、±12%に制限

Routes APIが失敗した場合は、既存KMZルートへフォールバックする。
Google Routes APIが自転車経路を返さない地域では車経路を代用し、
画面上に警告を表示する。車経路には自転車が通行できない道路が含まれる可能性がある。

Street View 更新は100mごと（`STREET_VIEW_INTERVAL`）。毎日1時間・月450km走行でも Dynamic Street View の無料枠（月5,000回）内に収まる設計。
Street View更新成功時にGeocoding APIで現在地を逆引きし、HUDへ都道府県・市区町村・町名まで表示する。

## 操作（キーボードテスト・仕様書 8章）

| キー | 動作 |
|---|---|
| ↑ | 速度アップ（+1km/h） |
| ↓ | 速度ダウン |
| Space | 停止 |
| R | リセット |

### 仮想ESP32

実機なしでESP32入力を再現できる。

- `仮想ESP32`: 60RPMから開始
- `-10` / `+10`: 目標RPM変更
- `停止`: 目標RPMを0へ変更
- `通信途絶`: センサー値を0にして通信断を再現
- `再接続`: 通信を復帰

走行距離はルート別にブラウザへ自動保存される。
Street Viewの切り替えが成功した直後に保存し、次回同じルートを選ぶと保存地点から再開する。
`R`でリセットすると、そのルートの保存済み進捗も削除する。

## 構成

```
src/
  types.ts                       RoutePoint / Route / SensorAdapter 型
  modules/
    routeLoader.ts               ルートJSON読み込み・検証
    kmzRouteLoader.ts            KMZ展開・KML解析・50m再サンプリング
    googleRoutesLoader.ts        Routes API polyline読込・デコード
    routeGeometry.ts             座標列から50mルート点を生成
    routeSampler.ts              累積距離 → ルート上の現在点（補間）
    streetViewController.ts      Maps APIロード・100m更新・近傍探索
    sensorKeyboard.ts            キーボード疑似入力（Phase 1）
    sensorSerial.ts              ESP32 Web Serial入力（Phase 2）
    grade.ts                     RPM→速度変換・勾配補正係数
  data/routes/
    osaka-kyoto.sample.json      サンプルルート（約11.7km・50m間隔・232点）
routes/sources/
  osaka-kyoto-yodogawa.kmz       起動時に読み込む大阪→京都ルート
firmware/
  esp32-rpm/esp32-rpm.ino        ホールセンサーRPM計測（"RPM:72.5"を毎秒出力）
```

## ルートJSON形式

```ts
type RoutePoint = {
  lat: number;
  lng: number;
  distance: number;   // スタートからの累積距離[m]
  elevation: number;  // 標高[m]
  grade: number;      // 区間勾配[%]
  heading: number;    // 進行方向[degree]
};
```

※ サンプルルートの標高・勾配は合成値。Phase 4 でルート作成ツール（GPX読み込み＋Elevation API）に置き換える。

現在のKMZは標高値がすべて0のため、KMZルート走行時の標高・勾配表示は0になる。

## ロードマップ（仕様書 9章）

- [x] Phase 1: センサーなしMVP（キーボード・100m更新・HUD）
- [ ] Phase 2: ESP32机上テスト（ファームウェア雛形・Web Serial実装済み、実機検証待ち）
- [ ] Phase 3: エアロバイク実機連携
- [ ] Phase 4: ルート作成ツール（GPX/GeoJSON・50m再サンプリング・標高取得）
- [ ] Phase 5: 傾斜補正の本格運用（補正ロジック自体は実装済み）
- [ ] Phase 6: 快適化（スマホリモコン・走行ログ・BLE化）
