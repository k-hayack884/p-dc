/*
 * ESP32 ホールセンサー RPM 計測ファームウェア（Phase 2 机上テスト用）
 *
 * 配線:
 *   ホールセンサーモジュール VCC -> 3.3V, GND -> GND, OUT -> GPIO 27
 *   回転側に小型ネオジム磁石1個（センサー本体は固定側に置く）
 *
 * 出力: 1秒ごとに USB シリアルへ "RPM:72.5" 形式で出力（115200bps）
 * Webアプリ側は sensorSerial.ts がこの行を読み取る。
 */

const int HALL_PIN = 27;
const unsigned long REPORT_INTERVAL_MS = 1000;
const unsigned long DEBOUNCE_US = 30000; // 30ms: チャタリング・二重検出防止

volatile unsigned long pulseCount = 0;
volatile unsigned long lastPulseUs = 0;

void IRAM_ATTR onPulse() {
  unsigned long now = micros();
  if (now - lastPulseUs > DEBOUNCE_US) {
    pulseCount++;
    lastPulseUs = now;
  }
}

unsigned long lastReportMs = 0;
unsigned long lastCount = 0;

void setup() {
  Serial.begin(115200);
  pinMode(HALL_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(HALL_PIN), onPulse, FALLING);
}

void loop() {
  unsigned long now = millis();
  if (now - lastReportMs >= REPORT_INTERVAL_MS) {
    noInterrupts();
    unsigned long count = pulseCount;
    interrupts();

    unsigned long pulses = count - lastCount;
    float elapsedSec = (now - lastReportMs) / 1000.0f;
    // 磁石1個 = 1回転1パルス
    float rpm = (pulses / elapsedSec) * 60.0f;

    Serial.print("RPM:");
    Serial.println(rpm, 1);

    lastCount = count;
    lastReportMs = now;
  }
}
