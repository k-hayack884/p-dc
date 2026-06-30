# ESP32 Bike RPM Web Serial Test

ESP32 + KY-003ホールセンサーからUSBシリアルで出力されるNDJSONを、ChromeのWeb Serial APIで確認する単体テストページです。

## 配線

| KY-003 | ESP32 |
|---|---|
| `-` | `GND` |
| `+` | `3V3` |
| `S` | `GPIO27` |

KY-003は最初は必ず`3V3`で給電してください。ESP32のGPIOへ5V信号を直結しないでください。

## ESP32ファームウェア

Arduino IDEで以下を書き込みます。

```text
firmware/esp32_hall_rpm/esp32_hall_rpm.ino
```

設定:

- Board: `ESP32 Dev Module`
- Baud rate: `115200`
- Hall sensor pin: `GPIO27`
- Magnets per rev: `1`

出力例:

```json
{"status":"boot","message":"esp32_hall_rpm_ready"}
{"pulses":1,"rpm":60.0,"timestamp_ms":123456}
```

## 起動

Web Serial APIはChromeまたはChromium系ブラウザで使用します。

```bash
cd web-serial-test
python3 -m http.server 5173
```

ブラウザで開きます。

```text
http://localhost:5173
```

`Connect ESP32`を押し、ESP32のシリアルポートを選択します。

実機作業のチェックリストはブラウザで開けます。

```text
http://localhost:5173/checklist.html
```

## 期待結果

- 起動時に`status: boot`のJSONログが表示される
- 磁石をKY-003へ近づけると`pulses`と`rpm`が変化する
- `speedFactor`に応じて仮想速度と距離が増える
- JSON以外の行や壊れた行が来てもページが落ちない

## speedFactor

テストページでは以下の仮式で速度と距離を計算します。

```text
speed_kmh = rpm * speedFactor
distance_m += speed_kmh * 1000 / 3600 * deltaSeconds
```

初期値は`0.2`です。例として、`60 RPM`で`12 km/h`になります。

## トラブルシューティング

### Arduino IDEにポートが出ない

- USBケーブルがデータ通信対応か確認する
- 別のUSBポートで試す
- Macでは`/dev/cu.usbserial-*`、`/dev/cu.SLAB_USBtoUART`、`/dev/cu.wchusbserial*`を確認する
- Windowsでは`COM3`などのCOMポートを確認する

### UploadでConnectingのまま止まる

- ESP32基板上の`BOOT`ボタンを押しながらUploadする
- 書き込み開始後に`BOOT`を離す

### センサーが反応しない

- KY-003の`S/+/-`の向きを確認する
- `+`がESP32の`3V3`に接続されているか確認する
- `-`が`GND`に接続されているか確認する
- `S`が`GPIO27`に接続されているか確認する
- 磁石の表裏を変える
- 磁石とセンサーの距離を1〜5mmまで近づける

### 常に検出状態になる

- `S`と`GND`が短絡していないか確認する
- 磁石が近くに置きっぱなしになっていないか確認する
- センサーの向きを変えて試す

### 3.3Vで動かない

5V給電を検討する場合でも、ESP32 GPIOに5V信号を直結しないでください。レベル変換または抵抗分圧が必要です。
