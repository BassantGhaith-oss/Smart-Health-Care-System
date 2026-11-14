import time, glob, threading, math, json
from collections import deque
from datetime import datetime, timezone
import smbus
import board, digitalio
import RPi.GPIO as GPIO
import paho.mqtt.client as mqtt
from PIL import Image, ImageDraw, ImageFont
from adafruit_rgb_display import st7735
from max30102 import MAX30102
import hrcalc

LED_PIN = 22
TOUCH_PIN = 17
BUZZER_PIN = 27
BUZZER_ENABLED = True
ALARM_ON_NO_READING = True

MQTT_HOST = "broker.hivemq.com"
MQTT_PORT = 1883
MQTT_TOPIC = "pulsecare/iot/current"
DEVICE_ID = "pi-01"

ACC_ADDR = 0x68
CHANGE_G = 0.6
SETTLE_SECONDS = 0.3
STILL_TOLERANCE = 0.25
STILL_SECONDS = 1.0

NUM_MODES = 3
GRAPH_POINTS = 112
W, H = 128, 160
DEG = "\u00b0"

BG = (8, 12, 24)
PANEL = (20, 28, 52)
GRID = (30, 42, 74)
TEXT = (235, 240, 255)
MUTED = (125, 140, 175)
RED = (255, 64, 110)
CYAN = (0, 200, 255)
GREEN = (60, 230, 150)
AMBER = (255, 190, 60)
ACCENTS = [RED, CYAN, AMBER]

GPIO.setmode(GPIO.BCM)
GPIO.setup(LED_PIN, GPIO.OUT)
GPIO.setup(TOUCH_PIN, GPIO.IN)
GPIO.setup(BUZZER_PIN, GPIO.OUT)
GPIO.output(BUZZER_PIN, 0)

cs = digitalio.DigitalInOut(board.CE0)
dc = digitalio.DigitalInOut(board.D24)
rst = digitalio.DigitalInOut(board.D25)

disp = st7735.ST7735R(
    board.SPI(),
    cs=cs,
    dc=dc,
    rst=rst,
    width=W,
    height=H,
    rotation=0,
    baudrate=4000000,
    bgr=True
)


def load_font(size, bold=True):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"

    for p in (
        "/usr/share/fonts/truetype/dejavu/" + name,
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    ):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass

    return ImageFont.load_default()


F_BIG = load_font(32)
F_VAL = load_font(20)
F_MID = load_font(15)
F_HDR = load_font(13)
F_SM = load_font(11, False)
F_XS = load_font(10, False)

state = {
    "bpm": 0,
    "spo2": 0,
    "finger": False,
    "temp": None,
    "alarm": False,
    "alerts": [],
    "goto_alerts": False,
    "last_beat": 0.0
}

bpm_hist, spo2_hist = [], []
wave = deque(maxlen=GRAPH_POINTS)
beat_event = threading.Event()
i2c_lock = threading.Lock()


def buzz(on):
    if BUZZER_ENABLED:
        GPIO.output(BUZZER_PIN, 1 if on else 0)


def read_temp():
    try:
        f = glob.glob("/sys/bus/w1/devices/28-*/w1_slave")[0]
        lines = open(f).read().splitlines()

        if lines[0].endswith("YES"):
            return int(lines[1].split("t=")[1]) / 1000.0

    except Exception:
        pass

    return None


def median(lst):
    s = sorted(lst)
    return s[len(s) // 2]


def temp_thread():
    while True:
        raw_temp = read_temp()

        if raw_temp is not None:
            state["temp"] = round(raw_temp + 5, 1)
        else:
            state["temp"] = None

        time.sleep(1)


def hr_thread():
    while True:
        try:
            with i2c_lock:
                m = MAX30102()
            break
        except OSError:
            time.sleep(1)

    red_buf, ir_buf = [], []
    fast = slow = None
    amp = 1.0
    armed = False
    last_beat = 0
    last_calc = 0

    while True:
        try:
            with i2c_lock:
                red, ir = m.read_sequential(amount=4)

        except OSError:
            time.sleep(0.2)
            continue

        red_buf = (red_buf + list(red))[-100:]
        ir_buf = (ir_buf + list(ir))[-100:]

        if sum(ir) / len(ir) < 50000:
            state["finger"] = False
            state["bpm"] = state["spo2"] = 0

            bpm_hist.clear()
            spo2_hist.clear()
            red_buf.clear()
            ir_buf.clear()
            wave.clear()

            fast = slow = None
            continue

        state["finger"] = True

        for x in ir:
            if fast is None:
                fast = slow = x

            fast += 0.3 * (x - fast)
            slow += 0.02 * (x - slow)

            sig = fast - slow

            amp += 0.01 * (abs(sig) - amp)

            wave.append(
                max(-1.0, min(1.0, -sig / (2.5 * max(amp, 1.0)))
                )
            )

            if sig > 0:
                armed = True

            elif armed and sig < -0.5 * amp:
                armed = False
                now = time.time()

                if now - last_beat > 0.35:
                    last_beat = now
                    state["last_beat"] = now
                    beat_event.set()

        now = time.time()

        if now - last_calc > 1.0 and len(ir_buf) == 100:
            last_calc = now

            bpm, bv, spo2, sv = hrcalc.calc_hr_and_spo2(
                ir_buf,
                red_buf
            )

            if bv and 40 < bpm < 180:
                bpm_hist.append(bpm)
                del bpm_hist[:-8]
                state["bpm"] = median(bpm_hist)

            if sv and 90 <= spo2 <= 100:
                spo2_hist.append(spo2)
                del spo2_hist[:-8]
                state["spo2"] = median(spo2_hist)


def acc_init(bus):
    bus.write_byte_data(ACC_ADDR, 0x6B, 0)
    bus.write_byte_data(ACC_ADDR, 0x1C, 0x10)


def acc_g(bus):
    with i2c_lock:
        d = bus.read_i2c_block_data(ACC_ADDR, 0x3B, 6)

    vals = []

    for i in (0, 2, 4):
        v = (d[i] << 8) | d[i + 1]

        if v > 32767:
            v -= 65536

        vals.append(v / 4096.0)

    return math.sqrt(
        vals[0] ** 2 +
        vals[1] ** 2 +
        vals[2] ** 2
    )


def fall_thread():
    try:
        bus = smbus.SMBus(1)

        with i2c_lock:
            acc_init(bus)

    except Exception as e:
        print(
            "Accelerometer not found, fall detection disabled:",
            e
        )
        return

    while True:
        if state["alarm"]:
            time.sleep(0.2)
            continue

        try:
            g = acc_g(bus)

        except Exception:
            time.sleep(0.05)
            continue

        if abs(g - 1.0) > CHANGE_G:
            time.sleep(SETTLE_SECONDS)

            t_end = time.time() + STILL_SECONDS
            still = True

            while time.time() < t_end:
                try:
                    if abs(acc_g(bus) - 1.0) > STILL_TOLERANCE:
                        still = False
                        break

                except Exception:
                    pass

                time.sleep(0.02)

            if still:
                state["alerts"].append(
                    time.strftime("%H:%M:%S")
                )
                state["alarm"] = True
                state["goto_alerts"] = True

        time.sleep(0.01)


def led_thread():
    while True:
        if state["alarm"]:
            GPIO.output(LED_PIN, 1)
            buzz(True)
            time.sleep(0.15)

            GPIO.output(LED_PIN, 0)
            buzz(False)
            time.sleep(0.15)

            continue

        if beat_event.wait(timeout=0.05):
            beat_event.clear()

            if state["finger"]:
                GPIO.output(LED_PIN, 1)
                buzz(True)
                time.sleep(0.08)

                GPIO.output(LED_PIN, 0)
                buzz(False)

        if ALARM_ON_NO_READING and not state["finger"]:
            buzz(True)
        else:
            buzz(False)


def build_payload():
    contact = bool(state["finger"])

    bpm = int(state["bpm"]) if contact and state["bpm"] else None
    spo2 = int(state["spo2"]) if contact and state["spo2"] else None

    temp = state["temp"]

    if contact and bpm:
        quality = 0.9
    elif contact:
        quality = 0.4
    else:
        quality = 0.0

    return {
        "device_id": DEVICE_ID,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "mode": "physical",
        "bpm": bpm,
        "spo2_pct": float(spo2) if spo2 else None,
        "temp_c": temp,
        "signal_quality": quality,
        "contact_ok": contact,
        "heart_rate": bpm if bpm else 0,
        "spo2": spo2 if spo2 else 0,
        "temperature": temp,
        "is_wearing": contact,
    }


def mqtt_thread():
    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

    except AttributeError:
        client = mqtt.Client()

    client.connect_async(MQTT_HOST, MQTT_PORT, 30)
    client.loop_start()

    while True:
        try:
            client.publish(
                MQTT_TOPIC,
                json.dumps(build_payload())
            )

        except Exception:
            pass

        time.sleep(2)


for t in (
    temp_thread,
    hr_thread,
    fall_thread,
    led_thread,
    mqtt_thread
):
    threading.Thread(target=t, daemon=True).start()


def center(d, y, s, font, fill):
    w = d.textlength(s, font=font)
    d.text(
        ((W - w) / 2, y),
        s,
        font=font,
        fill=fill
    )


def right(d, x, y, s, font, fill):
    d.text(
        (x - d.textlength(s, font=font), y),
        s,
        font=font,
        fill=fill
    )


def header(d, title, accent, show_dot=True):
    d.text((8, 4), title, font=F_HDR, fill=accent)

    if show_dot:
        dot = GREEN if state["finger"] else (70, 80, 110)
        d.ellipse((113, 7, 121, 15), fill=dot)

    d.line((4, 22, 124, 22), fill=GRID, width=1)


def draw_heart(d, cx, cy, s, color):
    r = s / 4

    d.ellipse(
        (cx - s / 2, cy - s / 6 - r,
         cx, cy - s / 6 + r),
        fill=color
    )

    d.ellipse(
        (cx, cy - s / 6 - r,
         cx + s / 2, cy - s / 6 + r),
        fill=color
    )

    d.polygon(
        [
            (cx - s / 2 + 1, cy - s / 12),
            (cx + s / 2 - 1, cy - s / 12),
            (cx, cy + s / 2.2)
        ],
        fill=color
    )


def page_pulse(d):
    header(d, "PULSE", RED)

    if state["finger"] and state["bpm"]:
        bpm = "%d" % state["bpm"]
    elif state["finger"]:
        bpm = "..."
    else:
        bpm = "--"

    d.text((8, 24), bpm, font=F_BIG, fill=TEXT)

    w = d.textlength(bpm, font=F_BIG)

    d.text(
        (8 + w + 4, 44),
        "BPM",
        font=F_SM,
        fill=RED
    )

    beating = (
        state["finger"] and
        time.time() - state["last_beat"] < 0.18
    )

    draw_heart(
        d,
        111,
        42,
        20 if beating else 15,
        RED if state["finger"] else (70, 80, 110)
    )

    d.rounded_rectangle(
        (4, 64, 124, 132),
        radius=8,
        fill=PANEL
    )

    for gy in (81, 98, 115):
        d.line((8, gy, 120, gy), fill=GRID, width=1)

    for gx in range(24, 120, 16):
        d.line((gx, 68, gx, 128), fill=GRID, width=1)

    mid, half = 98, 28

    src = list(wave) if state["finger"] else []

    if len(src) >= 2:
        x0 = 8 + GRAPH_POINTS - len(src)

        pts = [
            (x0 + i, mid - v * half)
            for i, v in enumerate(src)
        ]

        d.line(
            pts,
            fill=(120, 20, 55),
            width=4,
            joint="curve"
        )

        d.line(
            pts,
            fill=RED,
            width=2,
            joint="curve"
        )

        ex, ey = pts[-1]

        d.ellipse(
            (ex - 3, ey - 3, ex + 3, ey + 3),
            fill=(255, 255, 255)
        )

    else:
        d.line(
            (8, mid, 120, mid),
            fill=(70, 80, 110),
            width=1
        )

        center(d, 80, "Place finger", F_SM, MUTED)

    if state["finger"] and state["spo2"]:
        spo2 = "%d%%" % state["spo2"]
    else:
        spo2 = "--"

    t = state["temp"]

    if t is not None:
        temp = "%.1f%sC" % (t, DEG)
    else:
        temp = "--"

    d.text(
        (8, 137),
        "SpO2 " + spo2,
        font=F_SM,
        fill=CYAN
    )

    right(d, 120, 137, temp, F_SM, GREEN)


def card(d, y, label, value, unit, accent):
    d.rounded_rectangle(
        (4, y, 124, y + 38),
        radius=8,
        fill=PANEL
    )

    d.rounded_rectangle(
        (4, y + 6, 8, y + 32),
        radius=2,
        fill=accent
    )

    d.text(
        (16, y + 4),
        label,
        font=F_XS,
        fill=MUTED
    )

    d.text(
        (16, y + 15),
        value,
        font=F_VAL,
        fill=TEXT
    )

    right(d, 118, y + 22, unit, F_SM, accent)


def page_vitals(d):
    header(d, "VITALS", CYAN)

    if state["finger"] and state["bpm"]:
        bpm = "%d" % state["bpm"]
    elif state["finger"]:
        bpm = "..."
    else:
        bpm = "--"

    if state["finger"] and state["spo2"]:
        spo2 = "%d" % state["spo2"]
    elif state["finger"]:
        spo2 = "..."
    else:
        spo2 = "--"

    t = state["temp"]
    temp = "%.1f" % t if t is not None else "--"

    card(d, 26, "HEART RATE", bpm, "BPM", RED)
    card(d, 68, "OXYGEN", spo2, "%", CYAN)
    card(d, 110, "TEMPERATURE", temp, DEG + "C", GREEN)


def page_alerts(d):
    alerts = state["alerts"]

    header(d, "ALERTS", AMBER, show_dot=False)

    if not alerts:
        d.ellipse(
            (40, 42, 88, 90),
            outline=GREEN,
            width=3
        )

        d.line(
            [(52, 66), (61, 75), (78, 57)],
            fill=GREEN,
            width=4,
            joint="curve"
        )

        center(d, 100, "ALL CLEAR", F_MID, GREEN)
        center(d, 122, "No falls detected", F_SM, MUTED)

        return

    d.polygon(
        [(64, 30), (92, 76), (36, 76)],
        fill=AMBER
    )

    d.line(
        (64, 46, 64, 62),
        fill=(70, 25, 0),
        width=4
    )

    d.ellipse(
        (61, 66, 67, 72),
        fill=(70, 25, 0)
    )

    center(d, 82, "FALL DETECTED", F_HDR, TEXT)
    center(d, 101, alerts[-1], F_VAL, AMBER)

    if state["alarm"]:
        center(d, 130, "Touch to silence", F_SM, TEXT)
    else:
        center(d, 130, "Total: %d" % len(alerts), F_SM, TEXT)


def draw(mode):
    bg = BG

    if mode == 2 and state["alerts"]:
        if state["alarm"] and int(time.time() * 3) % 2 == 0:
            bg = (110, 0, 30)
        else:
            bg = (50, 8, 22)

    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)

    if mode == 0:
        page_pulse(d)
    elif mode == 1:
        page_vitals(d)
    else:
        page_alerts(d)

    for i in range(NUM_MODES):
        cx = 64 + (i - 1) * 16

        if i == mode:
            d.rounded_rectangle(
                (cx - 7, 152, cx + 7, 158),
                radius=3,
                fill=ACCENTS[i]
            )
        else:
            d.ellipse(
                (cx - 3, 152, cx + 3, 158),
                fill=(60, 70, 100)
            )

    disp.image(img)


mode = 0
last_touch = 0
last_draw = 0

draw(mode)

try:
    while True:
        if state["goto_alerts"]:
            state["goto_alerts"] = False
            mode = 2
            draw(mode)
            last_draw = time.time()

        touch = GPIO.input(TOUCH_PIN)

        if touch and not last_touch:
            if state["alarm"]:
                state["alarm"] = False
            else:
                mode = (mode + 1) % NUM_MODES

            draw(mode)
            last_draw = time.time()

        last_touch = touch

        if time.time() - last_draw > 0.1:
            draw(mode)
            last_draw = time.time()

        time.sleep(0.02)

except KeyboardInterrupt:
    GPIO.output(BUZZER_PIN, 0)
    GPIO.output(LED_PIN, 0)
    GPIO.cleanup()










