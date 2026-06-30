# ESP32実機検証 知見共有メモ

> 対象範囲: 「ESP32を準備できたので、この解説をよんで実装してください。」以降の、ESP32実機準備・Arduino IDE書き込み・KY-003配線・Web Serial接続・本体アプリ接続・エアロバイク取り付け方針まで。

## 1. 結論

ESP32 + KY-003ホールセンサーの机上テストは完了しました。

確認できたこと:

- ESP32へRPM計測ファームウェアを書き込める
- ESP32からUSBシリアルでNDJSONを出力できる
- ChromeのWeb Serial APIでESP32へ接続できる
- KY-003に磁石を近づけると`pulses`と`rpm`が変化する
- 本体アプリの`ESP32接続`まで確認済み

次の作業は、エアロバイク実機へ磁石とKY-003を仮固定し、ペダル回転で安定してパルスが取れるか確認することです。

## 2. 使用部品

| 部品 | 用途 |
|---|---|
| ESP32 Dev Board | USBシリアルでRPMをPCへ送る |
| KY-003ホールセンサー | 磁石の通過を検出する |
| 磁石 | クランクに取り付け、1回転ごとにセンサー前を通過させる |
| ジャンパーワイヤ | ESP32とKY-003の配線 |
| USBケーブル | ESP32とPCの接続。データ通信対応が必要 |
| 結束バンド / 両面テープ / マジックテープ | 実機取り付け用 |

## 3. 関連ファイル

| ファイル | 内容 |
|---|---|
| `firmware/esp32_hall_rpm/esp32_hall_rpm.ino` | ESP32用RPM計測ファームウェア |
| `web-serial-test/index.html` | ESP32単体Web Serialテストページ |
| `web-serial-test/checklist.html` | 実機作業チェックリスト |
| `web-serial-test/README.md` | ESP32単体テスト手順 |
| `output/pdf/esp32_airbike_mount_guide.png` | エアロバイク取り付け図解PNG |
| `output/pdf/esp32_airbike_mount_guide.pdf` | エアロバイク取り付け図解PDF |

## 4. Arduino IDE設定

Arduino IDE 2.xを使用します。

### 4.1 Boards Manager

Boards Managerでは以下を入れます。

```text
esp32 by Espressif Systems
```

似た名前の`Arduino ESP32 Boards by Arduino`も表示されますが、今回使うのは`esp32 by Espressif Systems`です。

### 4.2 Board

Boardは以下を選択します。

```text
ESP32 Dev Module
```

ユーザー環境ではESP32候補が大量に表示されましたが、通常のESP32-WROOM-32系Dev Boardなら`ESP32 Dev Module`で進めます。

### 4.3 Port

Macでは以下のようなポートが表示されました。

```text
/dev/cu.usbserial-0001
```

Bluetooth系やデバッグコンソールではなく、USB接続時に増える`usbserial`系を選びます。

Windowsでは`COM3`などのCOMポートになります。

### 4.4 Upload Speed

高速書き込みで失敗する場合は、Upload Speedを`115200`へ下げます。

実際に発生したエラー:

```text
A fatal error occurred: The chip stopped responding.
Failed uploading: uploading error: exit status 2
```

この場合はUpload Speedを下げるか、`BOOT`ボタンを押しながらUploadします。

## 5. ファームウェア

Arduino IDEで以下を開いてUploadします。

```text
firmware/esp32_hall_rpm/esp32_hall_rpm.ino
```

主な設定:

| 項目 | 値 |
|---|---|
| Baud rate | `115200` |
| Hall sensor pin | `GPIO27` |
| Magnets per rev | `1` |
| Report interval | `1000ms` |
| Debounce | `30000us` |

起動時の期待ログ:

```json
{"status":"boot","message":"esp32_hall_rpm_ready"}
```

計測時の期待ログ:

```json
{"pulses":1,"rpm":60.0,"timestamp_ms":123456}
```

## 6. 配線

ESP32のUSBを抜いた状態で配線します。

| KY-003 | ESP32 |
|---|---|
| `-` | `GND` |
| `+` | `3V3` |
| `S` | `GPIO27` / `D27` / `27` |

KY-003側は基板に印字されている`S`、`+`、`-`を見て接続します。基板の向きで左右が変わるため、位置ではなく印字を基準にします。

重要:

- KY-003は`3V3`給電で運用する
- `5V`給電は使わない
- ESP32のGPIOへ5V信号を直結しない
- 配線変更時は必ずUSBを抜く

## 7. 5V信号を直結しない、の意味

ESP32のGPIOは基本的に3.3V系です。

KY-003を`5V`で動かすと、`S`ピンからESP32の`GPIO27`へ5V信号が入る可能性があります。これはESP32を壊すリスクがあります。

今回の机上テストでは`3V3`給電で反応したため、実機でも`3V3`給電のまま進めます。

## 8. 単体Web Serialテスト

Arduino IDEのSerial Monitorは閉じます。同じUSBシリアルポートを複数アプリで同時に使えないためです。

起動:

```bash
cd web-serial-test
python3 -m http.server 5173
```

Chromeで開く:

```text
http://localhost:5173
```

手順:

1. `Connect ESP32`を押す
2. ESP32のポートを選ぶ
3. `Serial port opened`が出ることを確認する
4. ESP32のEN / RESETを押す
5. `esp32_hall_rpm_ready`または`pulses/rpm`のJSONが出ることを確認する
6. 磁石をKY-003の黒いセンサー部へ近づけて離す
7. `pulses`と`rpm`が変化すれば成功

補足:

- `WARN: JSON parse skipped`は、ESP32の起動ログなどJSONではない行を読み飛ばしているだけなので問題ありません
- 磁石を置きっぱなしにすると1回しか反応しません
- 磁石は「通過させる」ように動かします

## 9. 本体アプリ接続

Web SerialテストとArduino IDEのSerial Monitorを閉じてから、本体アプリで接続します。

開発サーバー例:

```bash
PATH="$HOME/.nvm/versions/node/v20.19.5/bin:$PATH" npm run dev -- --host 127.0.0.1 --port 5173
```

Chromeで開く:

```text
http://127.0.0.1:5173
```

手順:

1. ルートを選択する
2. `ESP32接続`を押す
3. ESP32のシリアルポートを選ぶ
4. 磁石を動かして速度/RPMが変化することを確認する

Google APIキーのHTTPリファラー制限を設定している場合、開発サーバーのポートを変えるとブロックされます。面倒を避けるなら、登録済みの`5173`で起動します。

## 10. 実際に詰まった点と対処

| 症状 | 原因・対処 |
|---|---|
| ViteがNode.js 16で起動しない | Node.js `20.19+`へ切り替える |
| Arduino IDEでESP32ボード候補が多すぎる | `esp32 by Espressif Systems`の`ESP32 Dev Module`を選ぶ |
| Portに候補が複数出る | Macでは`/dev/cu.usbserial-*`系を選ぶ |
| Uploadで止まる | Upload Speedを`115200`へ下げる。必要なら`BOOT`押しながらUpload |
| Serial Monitorが文字化けする | Baud rateを`115200`へ合わせる。表示UIが切り替わらない場合は閉じ直す |
| Web Serialで`No port selected` | ブラウザのポート選択ダイアログでポートを選ばず閉じた状態。再度`Connect ESP32` |
| `WARN: JSON parse skipped`が出る | ESP32起動ログなど非JSON行の読み飛ばし。問題なし |
| 磁石に反応しない | 磁石の表裏、センサーとの距離、`S/+/-`配線、`GPIO27`を確認 |
| 別ポートでGoogle APIがブロックされる | APIキーのHTTPリファラー制限にそのポートを追加するか、`5173`を使う |

## 11. エアロバイク取り付け方針

分解せず、外側から仮固定して検証します。

基本方針:

- 磁石は回る側に付ける
- KY-003は動かない側に付ける
- 磁石とKY-003は接触させない
- まずはクランク側で試す

推奨位置:

| 部品 | 取り付け先 |
|---|---|
| 磁石 | ペダルから伸びるクランクアーム |
| KY-003 | 本体カバー、フレームなど動かない場所 |
| ESP32 | ハンドル下、サドル下、フレーム横など |

磁石とKY-003の距離はまず`2〜5mm`程度で試します。反応が弱い場合は近づける、磁石の表裏を変える、センサーの向きを変えます。

図解資料:

- `output/pdf/esp32_airbike_mount_guide.png`
- `output/pdf/esp32_airbike_mount_guide.pdf`

## 12. 実機取り付け時のチェックリスト

1. ESP32単体でWeb Serial接続できる
2. KY-003単体で磁石に反応する
3. エアロバイクのクランクに磁石を仮固定する
4. 固定フレーム側にKY-003を仮固定する
5. ペダルを手でゆっくり回して反応を見る
6. 磁石とセンサーが接触しないことを確認する
7. 配線がペダル、クランク、足へ巻き込まれないことを確認する
8. 本体アプリで`ESP32接続`し、速度/RPMが出ることを確認する
9. 問題なければ結束バンドや両面テープで本固定する

## 13. 運用上の安全ルール

- 配線変更はUSBを抜いてから行う
- KY-003は`3V3`給電のままにする
- `5V`は使わない
- 磁石とセンサーを接触させない
- ケーブルを可動部に近づけない
- 走行前に必ず手回しで干渉確認する
- 本固定前に仮固定で数分テストする

## 14. 現時点の残タスク

| タスク | 状態 |
|---|---|
| ESP32ファーム書き込み | 完了 |
| KY-003机上反応確認 | 完了 |
| Web Serial単体テスト | 完了 |
| 本体アプリ接続確認 | 完了 |
| エアロバイクへの仮固定 | 未実施 |
| 走行中の安定性確認 | 未実施 |
| センサー固定方法の最終決定 | 未実施 |
| RPMから実走速度への係数調整 | 未実施 |

## 15. チームへ共有する時の要点

- ハードウェアはESP32 + KY-003 + 磁石1個の単純構成
- 1磁石=1回転なので、現ファームの`MAGNETS_PER_REV = 1`でよい
- ESP32は`{"pulses":1,"rpm":60.0,"timestamp_ms":123456}`形式のNDJSONを出す
- WebアプリはChromeのWeb Serial APIでUSBシリアルを読む
- Arduino IDEやSerial MonitorとWebアプリは同じポートを同時利用できない
- 実機取り付けは、まずクランクに磁石、固定フレームにKY-003で検証する
- 一番重要な安全注意は、`3V3`給電・可動部巻き込み防止・磁石とセンサー非接触
