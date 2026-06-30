# Bike Street View チーム共有ガイド

> エアロバイクの回転数に合わせてGoogle Street View上を疑似走行する、屋内サイクリング用Webアプリのプロトタイプです。

## 1. 共有時点の状況

現在は、キーボード入力、仮想ESP32、ESP32実機の机上テストまで確認できる状態です。
ESP32実機検証の詳細は[`README_ESP32_HANDOFF.md`](./README_ESP32_HANDOFF.md)を参照してください。

| 項目 | 状況 |
|---|---|
| キーボード走行 | 実装済み |
| 仮想ESP32 | 実装済み |
| Web Serial接続 | NDJSON対応済み・ESP32机上検証済み |
| Street View更新 | 100mごとに更新 |
| ルート選択 | 固定ルートとブラウザ作成ルートに対応 |
| ルート作成 | 出発地・目的地・経由地から作成可能 |
| 移動モード | 自転車、車、徒歩、自転車優先・車代替 |
| 標高・勾配 | Elevation API取得、平滑化、勾配補正に対応 |
| 現在地表示 | 都道府県・市区町村・町名まで表示 |
| 進捗保存 | Street View更新成功時に自動保存 |
| 自動テスト | Vitestで27件 |

## 2. 主な画面と操作

### ルート選択画面

- 登録済みルートを選択して走行を開始
- 「新しいルートを作成」から任意ルートを追加
- 作成ルートはブラウザの`localStorage`へ保存
- 保存したルートは選択画面から削除可能

### 走行画面

左上のHUDに以下を表示します。

- 現在地
- 速度
- 走行距離と総距離
- 標高と勾配
- RPM
- ルート種別
- Street View更新回数
- 入力センサー種別

| キー・操作 | 動作 |
|---|---|
| `↑` | 速度を1km/h上げる |
| `↓` | 速度を1km/h下げる |
| `Space` | 停止 |
| `R` | リセット確認画面を開く |
| `リセットする` | 走行位置と保存済み進捗を初期化 |
| `ルート変更` | ルート選択画面へ戻る |

## 3. 登録済みルート

| ルート | データ取得方式 |
|---|---|
| 大阪・淀川 → 京都御所 | KMZ |
| 新大阪 → 蒲生四丁目 → 奈良 | Google Routes API |
| 江坂 → 箕面萱野 | Google Routes API + Elevation API |

ブラウザ作成ルートでは、駅名・施設名・住所を出発地、目的地、経由地として指定できます。

## 4. 必要環境

- Node.js `20.19.0`以上
- npm
- デスクトップ版Chrome系ブラウザ
- Google Cloudプロジェクト

Node.js 16ではViteを起動できません。nvmを使用する場合の例:

```bash
nvm use 20.19.5
node --version
```

## 5. セットアップ

```bash
git clone <repository-url>
cd bike-streetview
npm install
cp .env.example .env.local
npm run dev
```

起動後、ターミナルに表示されたローカルURLをChromeで開きます。

## 6. Google API設定

Google Cloud Consoleで以下のAPIを有効にします。

- Maps JavaScript API
- Geocoding API
- Routes API
- Elevation API

`.env.local`へキーを設定します。

```dotenv
VITE_GOOGLE_MAPS_API_KEY=
GOOGLE_ROUTES_API_KEY=
GOOGLE_ELEVATION_API_KEY=
```

### キーの用途

| 環境変数 | 用途 | 推奨制限 |
|---|---|---|
| `VITE_GOOGLE_MAPS_API_KEY` | Street View、現在地の逆ジオコーディング | HTTPリファラー制限 |
| `GOOGLE_ROUTES_API_KEY` | ルート生成 | API制限、可能ならIP制限 |
| `GOOGLE_ELEVATION_API_KEY` | 標高取得 | API制限、可能ならIP制限 |

`GOOGLE_ELEVATION_API_KEY`にはHTTPリファラー制限付きキーを使用できません。

APIキーは`.env.local`だけに記載し、チャット、README、Issue、コミットへ貼らないでください。

## 7. 開発コマンド

```bash
# 開発サーバー
npm run dev

# 自動テスト
npm test

# テスト監視
npm run test:watch

# 本番ビルド
npm run build

# Lint
npm run lint
```

現在の基準は、自動テスト27件と本番ビルドが成功することです。

## 8. データ保存

以下のデータはサーバーやDBではなく、ブラウザの`localStorage`へ保存されます。

- ブラウザで作成したルート
- ルート別の走行進捗

ブラウザデータを削除すると、作成ルートと進捗も削除されます。別PC・別ブラウザ間では同期されません。

## 9. 実装上の要点

- ルート座標は約50m間隔へ再サンプリング
- Street Viewは100m走行ごとに更新
- Street Viewがない地点では半径50mで近傍探索
- 更新成功直後に走行進捗を保存
- 標高は前後2点の加重移動平均で平滑化
- 勾配は前後約200mの標高差から算出
- 異常な勾配値は±12%へ制限
- 自転車ルートが返らない場合は車ルートへ代替可能

## 10. 既知の制約

- エアロバイク実機への取り付けと走行中の安定性確認は未実施
- Web SerialはChrome系ブラウザが必要
- KMZルートは標高データがないため、標高・勾配が0になる
- 自転車ルートの車代替には、自転車通行不可道路が含まれる可能性がある
- Google APIの利用には請求先設定、予算アラート、クォータ管理が必要
- 本番向けバックエンドはなく、Routes API連携はVite開発サーバーのローカルAPIで動作

## 11. 今後の候補

1. エアロバイクへのホールセンサー仮固定
2. 走行中のRPM安定性確認
3. GPX・GeoJSONのインポート
4. 作成ルートと走行ログのファイル出力
5. スマートフォンリモコン
6. BLE接続
7. 本番配信用バックエンドとAPIキー管理

## 12. 関連ファイル

| ファイル・ディレクトリ | 内容 |
|---|---|
| `README.md` | 開発者向けの詳細説明 |
| `.env.example` | 必要な環境変数 |
| `src/App.tsx` | 画面と走行状態管理 |
| `src/RouteCreator.tsx` | ブラウザのルート作成画面 |
| `src/modules/` | ルート、センサー、Street View、保存処理 |
| `routes/sources/` | KMZルート |
| `firmware/esp32_hall_rpm/` | ESP32 + KY-003用NDJSONファームウェア |
| `web-serial-test/` | ESP32単体Web Serialテストページ |
| `README_ESP32_HANDOFF.md` | ESP32実機検証の知見共有メモ |

## 13. チーム共有時の確認事項

- APIキーや`.env.local`が共有物へ含まれていないこと
- Node.jsのバージョンが20.19以上であること
- Google Cloudで必要APIが有効になっていること
- `npm test`と`npm run build`が成功すること
- API利用料金の予算アラートとクォータが設定されていること
