# Bike Street View - 屋内エアロバイク × Street View 擬似サイクリング

エアロバイクを漕ぐと Google Street View が進む、屋内ダイエット用の個人プロトタイプ。
詳細は設計仕様書（aerobike_streetview_design_spec.docx）を参照。

現在の実装状態: **Phase 1 MVP**（キーボード入力・KMZルート・100m更新・HUD）＋ Phase 2 ESP32机上検証完了（Web Serial / ESP32 NDJSONファームウェア）

チームメンバー向けの概要・セットアップ・共有時の注意事項は
[`README_TEAM.md`](./README_TEAM.md)を参照。
プロジェクト全体の要約は[`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md)を参照。

## セットアップ

### 1. 必要なもの

| 項目 | 内容 |
|---|---|
| Node.js | 20.19 以上（`node -v` で確認） |
| ブラウザ | デスクトップ版 Chrome / Edge（ESP32接続に使う Web Serial のため） |
| Google Cloud アカウント | 地図・Street View・ルート作成に使う。請求先アカウントの登録が必要（無料枠あり） |

### 2. インストールと起動

```bash
npm install
cp .env.example .env.local   # 下の「3. APIキー」を見てキーを記入する
npm run dev
```

ブラウザで `http://localhost:5173` を開く（`127.0.0.1` で開いた場合は自動で `localhost` に切り替わる）。
APIキーがなくても、キーボード走行・HUD・走行ロジックは動く（地図とStreet Viewは表示されない）。

自動テスト・型チェック:

```bash
npm test
npx tsc -b
```

`.env.local` を書き換えたときは `npm run dev` を再起動する。

### 3. APIキー（`.env.local`）

| 変数名 | 使う場所 | 必要なAPI | 未設定のとき |
|---|---|---|---|
| `VITE_GOOGLE_MAPS_API_KEY` | ブラウザ（地図・Street View・住所表示・パノラマ列の作成） | Maps JavaScript API、Geocoding API | 地図とStreet Viewが表示されない |
| `GOOGLE_ROUTES_API_KEY` | 開発サーバー（ルート作成） | Routes API | `VITE_GOOGLE_MAPS_API_KEY` で代用（リファラー制限付きだと失敗する） |
| `GOOGLE_ELEVATION_API_KEY` | 開発サーバー（標高・勾配の取得） | Elevation API | `GOOGLE_ROUTES_API_KEY` で代用 |

`VITE_` で始まるキーはブラウザに配信される。`GOOGLE_ROUTES_API_KEY` と `GOOGLE_ELEVATION_API_KEY` は
開発サーバー（`vite.config.ts`）からGoogleへ送るだけで、ブラウザには出ない。

#### 3-1. Google Cloud の準備（最初に1回）

1. [Google Cloud Console](https://console.cloud.google.com/) にログインし、画面上部のプロジェクト選択から「新しいプロジェクト」を作る
2. [お支払い](https://console.cloud.google.com/billing) で請求先アカウントを作成し、プロジェクトに紐づける
   （Google Maps Platform は請求先の登録が必須。月ごとの無料枠の範囲なら請求は発生しない）
3. **予算アラートを設定する**: [お支払い → 予算とアラート](https://console.cloud.google.com/billing/budgets) で月の上限額（例: 1,000円）とメール通知を設定する
4. 使うAPIを有効化する（各リンクを開いて「有効にする」）
   - [Maps JavaScript API](https://console.cloud.google.com/apis/library/maps-backend.googleapis.com)（地図・Street View）
   - [Geocoding API](https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com)（住所表示・地点名の自動入力）
   - [Routes API](https://console.cloud.google.com/apis/library/routes.googleapis.com)（ルート作成）
   - [Elevation API](https://console.cloud.google.com/apis/library/elevation-backend.googleapis.com)（標高・勾配）

#### 3-2. ブラウザ用キー（`VITE_GOOGLE_MAPS_API_KEY`）

1. [APIとサービス → 認証情報](https://console.cloud.google.com/apis/credentials) で「認証情報を作成」→「APIキー」
2. 作成したキーの「編集」を開き、制限を設定する
   - **アプリケーションの制限**: 「ウェブサイト」を選び、`http://localhost:5173/*` を追加
     （別のポートで起動する場合は `http://localhost:*/*` にする）
   - **APIの制限**: 「キーを制限」を選び、`Maps JavaScript API` と `Geocoding API` だけにチェック
3. キーを `.env.local` の `VITE_GOOGLE_MAPS_API_KEY=` に貼る

#### 3-3. サーバー用キー（`GOOGLE_ROUTES_API_KEY` / `GOOGLE_ELEVATION_API_KEY`）

開発サーバーからの通信にはリファラー（参照元URL）が付かないため、**ブラウザ用キーとは別のキー**を作る。

1. 同じ「認証情報」画面で、もう1つAPIキーを作成する
2. 制限を設定する
   - **アプリケーションの制限**: 「なし」（固定IPがある環境なら「IPアドレス」で制限する）
   - **APIの制限**: `Routes API` と `Elevation API` にチェック
3. 同じキーを `.env.local` の `GOOGLE_ROUTES_API_KEY=` と `GOOGLE_ELEVATION_API_KEY=` に貼る
   （分けて管理したい場合はキーを2つ作り、それぞれのAPIだけを許可する）

`.env.local` の完成形:

```dotenv
VITE_GOOGLE_MAPS_API_KEY=AIza...（ブラウザ用）
GOOGLE_ROUTES_API_KEY=AIza...（サーバー用）
GOOGLE_ELEVATION_API_KEY=AIza...（サーバー用。Routesと同じキーでよい）
```

`.env.local` はgit管理外。APIキーをチャット・README・Issue・コミットへ貼らないこと。

#### 3-4. 料金の目安と注意

- Street View は **パノラマ表示の生成（ルートを開いたとき・確認画面を開いたとき）** が課金対象。
  走行中の移動（`setPano`）とパノラマ情報の取得（`StreetViewService`）、パノラマ列の自動作成は追加課金なし
- ルート一覧に当月のStreet View使用回数の目安（月5,000回）を表示する
- 住所表示（Geocoding）は走行中250mごとに1回、ルート作成で地図から地点を選ぶたびに1回
- 料金と無料枠は変わることがあるため、[Google Maps Platform の料金](https://mapsplatform.google.com/pricing/) を確認し、予算アラートを必ず設定しておく

#### 3-5. うまく動かないとき

| 症状 | 確認すること |
|---|---|
| 地図が灰色・「このページでは Google マップが正しく読み込まれませんでした」 | ブラウザ用キーのリファラーに `http://localhost:5173/*` があるか、Maps JavaScript API が有効か |
| ルート作成で `REQUEST_DENIED` / `API_KEY_HTTP_REFERRER_BLOCKED` | `GOOGLE_ROUTES_API_KEY` にリファラー制限付きのキーを使っていないか（サーバー用キーにする） |
| 標高・勾配が取れない | `GOOGLE_ELEVATION_API_KEY`（または Routes 用キー）で Elevation API が許可されているか |
| 住所が「住所取得失敗」になる | ブラウザ用キーで Geocoding API が許可されているか |

### 4. ローカルデータの保存先

開発サーバーが `bike-streetview/.data/` に保存する（git管理外）。

| ファイル | 内容 |
|---|---|
| `.data/custom-routes.json` | ブラウザで作成したルート |
| `.data/pano-chains.json` | ルートごとのパノラマ列（確認・修正済みの並び） |
| `.data/pano-chain-settings.json` | パノラマ列を作る区間の設定 |

ルート名・説明・地点ラベル・走行進捗はブラウザの localStorage に保存される。
別のPCへ移すときはルート選択画面の「移行データを書き出し / 読み込み」と、`.data/` フォルダのコピーを使う。

### ブラウザでルートを作成

初期画面の「新しいルートを作成」から、駅名・住所・「緯度,経度」でルートを追加できる。

- 地点は 出発地 → 経由地（最大25地点）→ 目的地 の順に並ぶ。地図をクリックして選ぶと地点名が住所から自動で入る
- 移動モード: 幹線道路優先（推奨）、自転車優先、自転車、車、徒歩
- 地点の間ごとに「この区間はパノラマ列を使う」を選べる（都心など高架・地下の取り違えが起きやすい区間だけオンにすると速い）
- 標高取得: Elevation APIから標高・勾配データを生成

### パノラマ列（高架・地下の取り違え対策）

走行中にパノラマを探す方式では、高架と高架下、橋と河川敷、道路と地下駅を取り違えることがある。
ルート一覧の「パノラマ列」から、走行時に表示するパノラマの並びを事前に作って確認・修正できる。

1. 「区間の設定」で対象区間を選ぶ（地点の間ごと、または距離で指定。地図クリックでも指定可）
2. 「自動作成」で並びを作る（7kmで約2〜3分）
3. 要確認区間を見て、高架下・河川敷・反対車線などに入っている所に「除外予定」の印を付ける
4. 「まとめて再生成」で印を付けた周辺だけ作り直し、「保存」する

保存したルートは、対象区間ではパノラマ列を順に再生し、それ以外は従来の探索方式で走る。
`?debug=1` を付けて開くと、DevToolsで `bikeSvDiagnostics()` を実行して移動の記録を確認できる。

### 標準ルート

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

Street View の移動は「まとめ」（既定: 直線は約50mごと・曲がり角付近は1枚ずつ）と「なめらか」（1枚ずつ）を走行画面で切り替えられる。
Street View更新時にGeocoding APIで現在地を逆引きし、HUDへ都道府県・市区町村・町名まで表示する。住所取得は250mごとに間引く。

## 操作（キーボードテスト・仕様書 8章）

| キー | 動作 |
|---|---|
| ↑ | 速度アップ（+1km/h） |
| ↓ | 速度ダウン |
| Space | 停止 |
| R | 確認後にリセット |

### 仮想ESP32

実機なしでESP32入力を再現できる。

- `仮想ESP32`: 60RPMから開始
- `-10` / `+10`: 目標RPM変更
- `停止`: 目標RPMを0へ変更
- `通信途絶`: センサー値を0にして通信断を再現
- `再接続`: 通信を復帰

走行距離はルート別にブラウザへ自動保存される。
Street Viewの切り替えが成功した直後に保存し、次回同じルートを選ぶと保存地点から再開する。
`R`を押すとアプリ内の確認画面を表示し、「リセットする」を押した場合のみルート先頭へ戻して保存済み進捗も削除する。

### ESP32実機テスト

KY-003ホールセンサーを使うESP32実機テスト用に、NDJSON出力ファームウェアと単体Web Serialテストページを用意している。

配線:

| KY-003 | ESP32 |
|---|---|
| `-` | `GND` |
| `+` | `3V3` |
| `S` | `GPIO27` |

ファームウェア:

```text
firmware/esp32_hall_rpm/esp32_hall_rpm.ino
```

出力形式:

```json
{"pulses":1,"rpm":60.0,"timestamp_ms":123456}
```

単体テストページ:

```bash
cd web-serial-test
python3 -m http.server 5173
```

Chromeで`http://localhost:5173`を開き、`Connect ESP32`からシリアルポートを選択する。
本体アプリの`ESP32接続`も同じNDJSON形式を読み取る。移行期間のため旧形式`RPM:72.5`も受け付ける。

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
    streetViewController.ts      Maps APIロード・Street View移動（探索方式／パノラマ列の再生）
    panoChain.ts                 パノラマ列の型・要確認区間・寄り道の除去
    panoChainBuilder.ts          パノラマ列の自動作成（リンク追従・近傍検索で乗り継ぎ）
    panoChainRepair.ts           除外予定のまとめ反映（部分的な作り直し）
    panoChainSegments.ts         パノラマ列を作る区間（地点の間・距離指定）の計算
    panoChainStore.ts            パノラマ列の保存（.data/pano-chains.json）
    panoChainSettingsStore.ts    区間設定の保存（.data/pano-chain-settings.json）
    customRoutes.ts              作成ルートの保存（.data/custom-routes.json）
    sensorKeyboard.ts            キーボード疑似入力（Phase 1）
    sensorSerial.ts              ESP32 Web Serial入力（NDJSON / 旧RPM形式対応）
    grade.ts                     RPM→速度変換・勾配補正係数
  PanoChainEditor.tsx            パノラマ列の作成・確認画面
  RouteCreator.tsx               ルート作成画面
  data/routes/
    osaka-kyoto.sample.json      サンプルルート（約11.7km・50m間隔・232点）
routes/sources/
  osaka-kyoto-yodogawa.kmz       起動時に読み込む大阪→京都ルート
firmware/
  esp32_hall_rpm/esp32_hall_rpm.ino  ホールセンサーRPM計測（NDJSONを毎秒出力）
web-serial-test/
  index.html                     ESP32単体Web Serialテストページ
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
- [ ] Phase 2: ESP32机上テスト（NDJSONファームウェア・単体テストページ実装済み、実機検証待ち）
- [ ] Phase 3: エアロバイク実機連携
- [ ] Phase 4: ルート作成ツール（GPX/GeoJSON・50m再サンプリング・標高取得）
- [ ] Phase 5: 傾斜補正の本格運用（補正ロジック自体は実装済み）
- [ ] Phase 6: 快適化（スマホリモコン・走行ログ・BLE化）
