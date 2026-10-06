# 設計書A: 現行Street View方式の継続改良（個人用・案1）

作成日: 2026-07-13 ／ 想定担当: Codex または Claude Sonnet
前提知識: `src/modules/streetViewController.ts` のリンク追従方式（公式パノラマ限定・
OUTDOOR検証・オフルート8m棄却・曲がってから進む旋回）、`vite.config.ts` のルート生成。

## 目的

Street View利用は維持したまま、(1) ルート品質（細い道・変な曲がりの削減）、
(2) 切り替え時のぼやけ・酔いの緩和、を段階的に改善する。

## スコープ外

- 動画方式への置き換え（設計書B/C）
- Street View遷移アニメーション自体の除去（API仕様上不可能）

---

## マイルストーン1: OSMルーター（ORS）導入によるルート品質改善

**既存の手順書 `docs/handover-ors-routing.md` をそのまま実施する。**
詳細・API仕様・受け入れ条件はすべてそちらに記載済み。

- 成果物: ORS優先＋Googleフォールバックのルート生成
- 受け入れ: handover-ors-routing.md 8章の条件

## マイルストーン2: 遷移マスキング（ぼやけ・酔い対策の本命）

Street Viewの遷移中モーションブラーは消せないため、**遷移の瞬間を演出で隠す**。

タスク:

1. `StreetViewController` に遷移イベントを追加:
   `onTransition?: (phase: "start" | "end") => void` をコンストラクタoptionsに追加し、
   `setPanoAndWait` の直前で `start`、解決後（heading tween開始時）に `end` を発火
2. App側: `.streetview` の上に全画面オーバーレイdivを重ね、`start` で
   `opacity: 0 → 0.35`（黒 or 白のソフトフェード、CSS transition 120ms）、
   `end` で 0 に戻す。ブラーがフェードに紛れて知覚されにくくなる
3. オーバーレイ強度を設定化: `localStorage` キー
   `bike-streetview:transition-mask` = "off" | "soft"(既定) | "strong"
   走行画面のコントロールにトグル追加（「移動:」ボタンの隣）
4. 検証: なめらか/まとめ両モードで違和感がないこと。連続ステップ時に
   フェードが点滅にならないこと（連続遷移中はフェードを維持する）

受け入れ条件: 遷移マスクON/OFFを走行中に切替可能。`npm test` 全通過
（controllerのイベント発火はモックで単体テスト追加）。

## マイルストーン3: 視覚安定化の微調整

1. 遷移中のPOVズーム: 遷移`start`で `panorama.setZoom(現在値+0.3)` →
   `end`で戻す（視野を狭めると周辺流れの知覚が減る）。効果は主観評価で採否判断
2. heading tween の easing 調整: 現行 easeOutQuad 600ms を
   速度比例（低速ほどゆっくり）にする
3. 「まとめ移動」モードの間隔（35m）を設定化:
   `bike-streetview:hop-interval` = 25/35/50m

受け入れ: 主観評価（高麗橋・中之島・淀屋橋→大津の定点ルート）で
M2前より酔いにくいこと。パラメータがUIから変更できること。

## マイルストーン4: 診断モードと回帰チェック

1. デバッグHUD（`?debug=1` クエリで表示）: 直近のリンク棄却理由
   （投稿ID/著作権/方位ずれ/オフルート/屋内/後退）、再同期回数、現在のオフルート距離
2. 定点回帰チェックリストを `docs/checklist-sv-regression.md` に作成:
   高麗橋（建物貫通なし）、中之島（公園進入なし）、天満橋（地下街進入なし）、
   任意の曲がり角（旋回→前進の順序）
3. 発見された問題はパラメータ調整（閾値定数はすべて
   streetViewController.ts 冒頭に集約済み）で対応

受け入れ: チェックリスト全項目パス。デバッグHUDが本番表示に影響しないこと。
