/*
 * ESP32 + KY-003 ホールセンサー RPM 計測ファームウェア（周期測定方式）
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
 * RPM算出:
 *   1秒窓のパルス数ではなく「パルス間隔（周期）」からRPMを算出する。
 *   磁石1個・低回転（60RPM未満）でも1周ごとに正確な値が出る。
 *   最後のパルスから時間が経つほどRPMを減衰させ、
 *   PULSE_TIMEOUT_US を超えたら0にする。
 *
 * 出力（1秒ごとのNDJSON。pulsesはその1秒間のパルス数）:
 *   {"pulses":1,"rpm":60.0,"timestamp_ms":123456}
 */

const int HALL_PIN = 27;
const int MAGNETS_PER_REV = 1;
const unsigned long DEBOUNCE_US = 30000;
const unsigned long REPORT_INTERVAL_MS = 1000;
/** このパルス間隔を超えたら停止(0 RPM)とみなす [us]（= 12RPM相当） */
const unsigned long PULSE_TIMEOUT_US = 5000000UL;
const float MAX_RPM = 240.0;

volatile unsigned long windowPulseCount = 0;
volatile unsigned long lastPulseUs = 0;
volatile unsigned long lastPeriodUs = 0;

unsigned long lastReportMs = 0;

void IRAM_ATTR onHallPulse() {
  unsigned long now = micros();
  unsigned long elapsed = now - lastPulseUs;

  if (elapsed > DEBOUNCE_US) {
    if (lastPulseUs != 0) {
      lastPeriodUs = elapsed;
    }
    windowPulseCount++;
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
    unsigned long count = windowPulseCount;
    windowPulseCount = 0;
    unsigned long periodUs = lastPeriodUs;
    unsigned long pulseUs = lastPulseUs;
    interrupts();

    unsigned long nowUs = micros();
    unsigned long sinceLastPulseUs = pulseUs == 0 ? 0 : nowUs - pulseUs;

    float rpm = 0.0;
    if (pulseUs != 0 && periodUs > 0 && sinceLastPulseUs < PULSE_TIMEOUT_US) {
      rpm = 60000000.0 / (float)periodUs / (float)MAGNETS_PER_REV;

      // 減速検知: 最後のパルスからの経過時間が周期を上回ったら、
      // 経過時間ベースのRPMまで引き下げる（止めた瞬間に高止まりしない）
      if (sinceLastPulseUs > periodUs) {
        float decayRpm =
            60000000.0 / (float)sinceLastPulseUs / (float)MAGNETS_PER_REV;
        if (decayRpm < rpm) rpm = decayRpm;
      }

      if (rpm > MAX_RPM) rpm = MAX_RPM;
      if (rpm < 0.0) rpm = 0.0;
    }

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
