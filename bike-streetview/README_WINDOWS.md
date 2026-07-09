# Windows版 起動・データ移行手順

## 目的

Windowsではコマンド入力なしで、アイコンを押すだけでBike Street Viewを起動する。

現時点では軽量ランチャー方式です。Electronなどの完全なインストーラー化は次段階です。

## 前提

- WindowsにNode.js 20.19以上を入れておく
- 初回だけ`npm install`を実行しておく
- `.env.local`はWindows側で別途作成する

`.env.local`にはAPIキーを含むため、移行JSONには含めません。

## 起動方法

`tools/windows/start-bike-streetview.bat`をダブルクリックする。

実行すると以下を自動で行います。

1. `localhost:5173`でサーバーが起動済みか確認する
2. 未起動なら`npm run dev -- --host localhost --port 5173`を起動する
3. ブラウザで`http://localhost:5173/`を開く

ショートカットをデスクトップに作れば、通常のアプリ風に起動できます。

## MacからWindowsへのデータ移行

Mac側のルート選択画面で`移行データを書き出し`を押す。

出力された`bike-streetview-data-*.json`をWindowsへコピーし、Windows側のルート選択画面で`移行データを読み込み`を押して選択する。

移行対象:

- Routes APIで保存したルート
- ルート名
- ルート説明
- 出発地・目的地・経由地ラベル
- 走行進捗
- 表示・利用量系のローカル設定

移行しないもの:

- `.env.local`
- Google Maps / Routes / Elevation APIキー
- `node_modules`

APIキーはWindows側の`.env.local`へ個別に設定してください。
