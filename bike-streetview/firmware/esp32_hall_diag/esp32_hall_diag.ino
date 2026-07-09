/*
 * ESP32 + KY-003 配線診断用スケッチ
 *
 * GPIO27の生のレベル（HIGH/LOW）を200msごとに表示する。
 * 磁石を近づけたときに level が 1 -> 0 に変われば配線・センサーはOK。
 *
 * 出力例:
 *   {"level":1,"changes":0,"uptime_ms":1000}   磁石なし（通常時HIGH）
 *   {"level":0,"changes":1,"uptime_ms":1200}   磁石あり（LOWに変化）
 *
 * 判定:
 *   - 磁石を近づけても level が常に1  -> S線がGPIO27に届いていない、
 *     磁石の極性が逆（A3144はS極のみ反応）、または3.3V駆動で出力が
 *     切り替わらない個体
 *   - level が常に0                   -> S線がGNDに短絡、または配線違い
 *   - 磁石で 1 -> 0 に変わる          -> ハードOK。本番ファームで動くはず
 */

const int HALL_PIN = 27;

int lastLevel = -1;
unsigned long changeCount = 0;
unsigned long lastPrintMs = 0;

void setup() {
  Serial.begin(115200);
  delay(1000);
  pinMode(HALL_PIN, INPUT_PULLUP);
  Serial.println("{\"status\":\"boot\",\"message\":\"esp32_hall_diag_ready\"}");
}

void loop() {
  int level = digitalRead(HALL_PIN);
  if (lastLevel != -1 && level != lastLevel) {
    changeCount++;
  }
  lastLevel = level;

  unsigned long nowMs = millis();
  if (nowMs - lastPrintMs >= 200) {
    Serial.print("{\"level\":");
    Serial.print(level);
    Serial.print(",\"changes\":");
    Serial.print(changeCount);
    Serial.print(",\"uptime_ms\":");
    Serial.print(nowMs);
    Serial.println("}");
    lastPrintMs = nowMs;
  }

  delay(5);
}
