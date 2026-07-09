# 修正プラン: 2回目のルート選択でStreet Viewが真っ黒のままになるバグ

作成日: 2026-07-09 ／ 実装担当: Claude Sonnet 5
対象: bike-streetview `src/App.tsx`

## 1. 事象

1. サーバー起動 → ルート選択 → ビューが正常に表示される
2. 「ルート変更」でルート選択画面へ戻る
3. もう一度ルートを選ぶ（同じルートでも別ルートでも再現）
4. ミニマップ・HUDは表示されるが、ビューが真っ黒のまま。HUDは
   「SV移動 0回」「Street View 読み込み中…」の表示で止まる。エラー表示なし
5. ブラウザをリロードしてから選び直すと正常に戻る

## 2. 根本原因（コード解析済み・確度高）

登場箇所（行番号は2026-07-09時点の `src/App.tsx`）:

- L579-656: Street View初期化 useEffect。依存配列は `[route, selectedRouteId]`
- L603: `if (cancelled || !svRef.current) return;` ← **無言の中断**
- L764-777: `selectRoute()` — `setRouteLoading(true)` してから `setSelectedRouteId`
- L487-534: ルートローダー useEffect — `.then()` 内で `setRoute(...)`、
  `.finally()` 内で `setRouteLoading(false)`（**別々のマイクロタスク**）
- L1098: `if (!route || routeLoading) return <ローディング画面>;`
  → この間、走行画面の `<div ref={svRef} className="streetview" />`（L1125）は
  **マウントされていない**

メカニズム:

1. 2回目の選択では Maps API がロード済みのため、`loadMapsApi()` は即時解決する
2. `setRoute`（.then）と `setRouteLoading(false)`（.finally）が別マイクロタスクなので、
   「route はセット済みだが routeLoading === true」のコミットが発生し得る。
   このコミットの画面はローディング画面 → `svRef.current === null`
3. そのコミット直後に SV初期化 effect が走り（依存 `route` が変化したため）、
   即時解決した `loadMapsApi().then` 内の L603 で `!svRef.current` により
   **エラーも出さず return**。コントローラは生成されない
4. その後 `routeLoading` が false になり走行画面がマウントされるが、
   `routeLoading` は effect の依存配列にないため **effect は再実行されない**
5. 結果: mapsReady=false のまま「Street View 読み込み中…」「SV移動 0回」で恒久スタック

1回目の選択やリロード後に動く理由: Maps APIスクリプトの取得に時間がかかり、
`.then` が走る頃には走行画面がマウント済みで `svRef.current` が存在するため。
これは「初回OK・2回目NG・リロードで復活」という再現条件と完全に一致する。

## 3. 修正方針

### 必須修正A（本命）: コンテナのマウントをeffectの前提条件にする

`svRef`（object ref）をやめ、**callback ref + state** にしてコンテナDOMの
存在を React の再レンダリング・effect 再実行に乗せる:

```tsx
const [svContainer, setSvContainer] = useState<HTMLDivElement | null>(null);

// JSX（L1125相当）
<div key={selectedRouteId} ref={setSvContainer} className="streetview" />

// SV初期化effect
useEffect(() => {
  if (!API_KEY || !route || !selectedRouteId || !svContainer) return;
  ...
  loadMapsApi(API_KEY).then(() => {
    if (cancelled) return;
    const controller = new StreetViewController(svContainer, route, ...);
    ...
  });
  ...
}, [route, selectedRouteId, svContainer]);
```

- コンテナがマウントされた時点で `svContainer` が set され effect が再実行されるため、
  タイミング競合が構造的に消える
- `!svRef.current` の無言 return も不要になる（ガードは `!svContainer` の早期returnに置換）
- 注意: `key={selectedRouteId}` により選択ごとに div が再マウントされ、
  callback ref は null → 新div の順で呼ばれる。`setSvContainer(null)` が挟まっても
  effect の早期 return で安全

### 必須修正B: 無言スタックの禁止（防御）

万一コントローラ生成に至らない場合に原因が見えるよう、
`loadMapsApi().then` 内の早期 return 経路で `console.warn` を出す。
ユーザー向けには、一定時間（例: 10秒）mapsReady にならなければ
`setMapsError("Street Viewの初期化に失敗しました。ルートを選び直してください。")`
を表示するタイムアウトを effect 内に追加（クリーンアップで clearTimeout）。

### 任意修正C: レイアウト前生成による黒画面の予防

即時解決パスでは、パノラマ生成前に1フレーム待つとレイアウト未確定による
黒画面（サイズ0のWebGLキャンバス）も予防できる:

```ts
await new Promise(requestAnimationFrame);
```

（A で `svContainer` がマウント済みになるため通常は不要だが、安全側の1行）

## 4. 実装時の注意

- **`streetViewController.ts` は変更しないこと**（表示ロジックは正常。
  問題はコントローラが生成されないことにある）
- SV初期化 effect のクリーンアップ（destroy / controllerRef=null）と
  `returnToRouteSelection()`（L942-963）の手動 destroy の二重実行は
  現状 null ガードで安全。この構造は維持する
- `selectRoute()` が `setMapsReady(false)` している（L771）ことを壊さない
- ルートローダー側の `.finally(setRouteLoading(false))` を `.then` 内へ移す案は
  バッチングに依存した対症療法なので採用しない（修正Aで構造的に解決する）

## 5. 検証手順（受け入れ条件）

前提: `npm run dev`、APIキー設定済み、ブラウザリロードは行わない。

1. ルート選択 → 表示確認 → ルート変更 → **同じルート**を再選択 → ビューが表示される
2. ルート選択 → ルート変更 → **別ルート**を選択 → ビューが表示される
3. 上記1-2を連続5回繰り返してもすべて表示される（スタックしない）
4. 走行途中（数百m進めた状態）でルート変更 → 再選択 → 保存地点から再開し表示される
5. リセットボタン → 「リセットする」→ 先頭から表示される（回帰確認）
6. 初回ロード（リロード直後）の表示も従来どおり（回帰確認）
7. `npm test` 全通過（2026-07-09時点で75件）
8. `npm run lint` で新規エラーを増やさない（既存5件は許容）

## 6. 参考: 過去に修正済みの類似・関連事項

- Street View表示はリンク追従方式（単一パノラマインスタンス、setPano移動、
  公式パノラマ限定、OUTDOOR検証、オフルート8m棄却）。詳細は
  `src/modules/streetViewController.ts` のコメント参照
- ルート生成は Google Routes API（幹線道路優先=DRIVE+avoidTolls+avoidHighways+
  代替ルートから曲がり最少選択）。標高は完全ジオメトリへ距離比補間
- 本バグは表示ロジック導入前から存在していた（旧実装でも同じ effect 構造のため）
