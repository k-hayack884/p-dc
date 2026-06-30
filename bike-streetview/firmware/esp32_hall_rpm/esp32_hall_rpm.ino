/*
 * ESP32 + KY-003 ホールセンサー RPM 計測ファームウェア
 *
 * 配線:
 *   KY-003 - -> ESP32 GND
 *   KY-003 + -> ESP32 3V3
 *   KY-003 S -> ESP32 GPIO27
 *
 * 仕様:
 *   Baud rate: 115200
 *   Hall sensor pin: GPIO27
 *   Magnets per rev: 1
 *   Report interval: 1000ms
 *   Debounce: 30000us
 *
 * 出力:
 *   {"pulses":1,"rpm":60.0,"timestamp_ms":123456}
 */

const int HALL_PIN = 27;
const int MAGNETS_PER_REV = 1;
const unsigned long DEBOUNCE_US = 30000;
const unsigned long REPORT_INTERVAL_MS = 1000;

volatile unsigned long pulseCount = 0;
volatile unsigned long lastPulseUs = 0;

unsigned long lastReportMs = 0;

void IRAM_ATTR onHallPulse() {
  unsigned long now = micros();

  if (now - lastPulseUs > DEBOUNCE_US) {
    pulseCount++;
    lastPulseUs = now;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(HALL_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(HALL_PIN), onHallPulse, FALLING);

  Serial.println("{\"status\":\"boot\",\"message\":\"esp32_hall_rpm_ready\"}");
}

void loop() {
  unsigned long nowMs = millis();

  if (nowMs - lastReportMs >= REPORT_INTERVAL_MS) {
    noInterrupts();
    unsigned long count = pulseCount;
    pulseCount = 0;
    interrupts();

    float revPerSecond = (float)count / (float)MAGNETS_PER_REV;
    float rpm = revPerSecond * 60.0;

    Serial.print("{\"pulses\":");
    Serial.print(count);
    Serial.print(",\"rpm\":");
    Serial.print(rpm, 1);
    Serial.print(",\"timestamp_ms\":");
    Serial.print(nowMs);
    Serial.println("}");

    lastReportMs = nowMs;
  }
}
