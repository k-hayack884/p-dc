# 設計書B: ハイパーラプス動画走行モード（個人用実験・案3）

作成日: 2026-07-13 ／ 想定担当: Claude Opus（M1-M2）→ Sonnet（M3-M4）
前提: **個人利用限定の実験**。Street View画像の保存・動画化はGoogle Maps Platform
規約のグレー領域のため、生成した動画・本モードを第三者へ配布/提供しないこと。

## 目的

ルートのStreet View画像を事前に動画化し、走行時は `<video>` の再生速度を
ペダル速度に連動させる。走行中のパノラマ切り替え（ぼやけ・酔いの原因）を
なくし、走行中のGoogle API呼び出しをゼロにする。

## アーキテクチャ概要

```
[ルート作成(既存)] → route JSON (RoutePoint[])
      ↓ scripts/generate-hyperlapse.mjs
[座標列抽出] → streetwarp-cli → out/<routeId>.mp4 + <routeId>.meta.json
      ↓                          （距離⇔フレームの対応表）
[アプリ] 動画走行モード: 累積距離 → currentTime へマッピング
         speed → playbackRate、HUD/ミニマップ/勾配は既存ロジック流用
```

## マイルストーン1: streetwarp-cli の検証（PoC）

1. https://github.com/mattdsteele/streetwarp （streetwarp-cli）をローカル導入。
   前提ツール（node, ffmpeg）を確認し、セットアップ手順を
   `docs/hyperlapse-setup.md` に記録する
2. 短いルート（2〜3km、例: 江坂→緑地公園）のGPX/座標列を渡して動画を生成
   - 使用APIキー: `GOOGLE_ROUTES_API_KEY` とは別に Street View Static API を
     有効化したキーを用意（`.env.local` に `SV_STATIC_API_KEY`）
3. 計測して記録: 生成時間、消費画像枚数（無料枠 月10,000枚に対する割合）、
   出力fps・解像度、ガタつきの主観評価
4. 判断ゲート: 「毎日見るに耐える品質か」を人間（発注者）が確認。
   NGならここで中止し、設計書Aに注力する

成果物: 動画1本＋計測レポート（docs/hyperlapse-setup.md 内に追記）

## マイルストーン2: 生成パイプライン統合

1. `scripts/generate-hyperlapse.mjs` を新規作成:
   - 入力: localStorage からエクスポートしたカスタムルートJSON、
     または `/api/routes/:id` のレスポンス
   - ルート座標列を streetwarp-cli 入力形式へ変換 → 実行 → mp4 出力
   - **meta.json を必ず生成**: `{ routeId, totalDistanceM, frameCount, fps,
     samples: [{ distanceM, timeSec }] }`（streetwarpの取得点列から算出。
     距離→再生位置の線形補間に使う）
2. 出力先: `public/hyperlapse/<routeId>.mp4` / `.meta.json`
   （gitignoreに `public/hyperlapse/` を追加。動画はコミットしない）
3. 画像枚数の安全弁: 推定枚数が月間無料枠の残りを超える場合は
   実行前に確認プロンプトを出す

受け入れ: コマンド1発で「ルートID → mp4 + meta.json」が完成する。

## マイルストーン3: アプリに動画走行モードを追加

1. ルート一覧: `public/hyperlapse/<routeId>.meta.json` が存在するルートに
   「動画モードで走行」ボタンを表示（fetch HEADで存在確認）
2. 新規モジュール `src/modules/hyperlapsePlayer.ts`:
   - `distanceToTime(meta, distanceM)`: samples の線形補間
   - `class HyperlapsePlayer`: `<video>` 要素を管理し、
     `setTarget(distanceM, speedMps)` で
     `video.playbackRate = clamp(speedMps / baseSpeedMps, 0.0625, 4)` と
     ドリフト補正（`|currentTime - 目標time| > 1s` なら seek）を行う。
     速度0で `pause()`
   - baseSpeedMps は meta から算出（総距離 / 総再生時間）
3. App.tsx: 走行画面で StreetViewController の代わりに HyperlapsePlayer を
   使う分岐（既存のHUD・ミニマップ・勾配・進捗保存はそのまま流用。
   住所表示は動画モードでは「ルート名区間表示」に簡略化してよい）
4. Street View関連の課金・使用量UIは動画モード時は非表示

受け入れ: キーボード/仮想ESP32で速度を変えると動画の進みが連動する。
停止で動画も停止。進捗保存・再開・リセットが動作。`npm test` 全通過。

## マイルストーン4: 比較評価と仕上げ

1. 同一ルートでSVモード/動画モードを切り替えて主観比較
   （酔い・没入感・起動時間）。結果を docs に記録
2. 動画モードの既知の限界を README_TEAM.md に明記
   （ルートごとに事前生成が必要、個人利用限定、ハイパーラプス特有のガタつき）
3. 発注者の評価で「常用する」となれば、お気に入りルートの一括生成
   スクリプト（複数routeIdをループ）を追加

## リスク

- streetwarp-cli がメンテ停止で動かない場合: 代替として
  Street View Static API を直接叩き ffmpeg で連結する自前実装
  （+2〜3日、meta.json 生成は共通）
- 無料枠超過: Static API は従量課金のため、生成前見積りの安全弁（M2-3）を必須とする
