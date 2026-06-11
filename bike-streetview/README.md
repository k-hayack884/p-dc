# Bike Street View - 屋内エアロバイク × Street View 擬似サイクリング

エアロバイクを漕ぐと Google Street View が進む、屋内ダイエット用の個人プロトタイプ。
詳細は設計仕様書（aerobike_streetview_design_spec.docx）を参照。

現在の実装状態: **Phase 1 MVP**（キーボード入力・サンプルルート・100m更新・HUD）＋ Phase 2 準備（Web Serial / ESP32ファームウェア雛形）

## セットアップ

```bash
npm install
cp .env.example .env.local   # APIキーを記入（なくてもHUD・走行ロジックは動く）
npm run dev
```

ブラウザは **デスクトップChrome系** を使用すること（Web Serial対応のため）。

### Google Maps APIキー

1. Google Cloud Console でプロジェクト作成、**Maps JavaScript API** を有効化
2. **予算アラートとクォータ制限を必ず設定**（仕様書 7章・10章）
3. `.env.local` の `VITE_GOOGLE_MAPS_API_KEY` に記入

Street View 更新は100mごと（`STREET_VIEW_INTERVAL`）。毎日1時間・月450km走行でも Dynamic Street View の無料枠（月5,000回）内に収まる設計。

## 操作（キーボードテスト・仕様書 8章）

| キー | 動作 |
|---|---|
| ↑ | 速度アップ（+1km/h） |
| ↓ | 速度ダウン |
| Space | 停止 |
| R | リセット |

## 構成

```
src/
  types.ts                       RoutePoint / Route / SensorAdapter 型
  modules/
    routeLoader.ts               ルートJSON読み込み・検証
    routeSampler.ts              累積距離 → ルート上の現在点（補間）
    streetViewController.ts      Maps APIロード・100m更新・近傍探索
    sensorKeyboard.ts            キーボード疑似入力（Phase 1）
    sensorSerial.ts              ESP32 Web Serial入力（Phase 2）
    grade.ts                     RPM→速度変換・勾配補正係数
  data/routes/
    osaka-kyoto.sample.json      サンプルルート（約11.7km・50m間隔・232点）
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

## ロードマップ（仕様書 9章）

- [x] Phase 1: センサーなしMVP（キーボード・100m更新・HUD）
- [ ] Phase 2: ESP32机上テスト（ファームウェア雛形・Web Serial実装済み、実機検証待ち）
- [ ] Phase 3: エアロバイク実機連携
- [ ] Phase 4: ルート作成ツール（GPX/GeoJSON・50m再サンプリング・標高取得）
- [ ] Phase 5: 傾斜補正の本格運用（補正ロジック自体は実装済み）
- [ ] Phase 6: 快適化（スマホリモコン・走行ログ・BLE化）
