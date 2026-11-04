"""Bark 3.0 speech worker for Natively (one process per audio channel).

Protocol: newline-delimited JSON, same shape as the Apple Speech helper.
  stdin : {"type":"init"} | {"type":"audio","sampleRate":N,"pcm":"<b64 int16 mono>"}
          | {"type":"flush"} | {"type":"stop"}
  stdout: {"type":"ready"} | {"type":"transcript","text":..,"isFinal":bool}
          | {"type":"error","message":..} | {"type":"status","message":..}

Bark is an offline model, so this worker segments speech on pauses: it
re-transcribes the growing phrase every PARTIAL_EVERY_S for live partials and
emits a final once SILENCE_END_S of quiet follows speech.
"""
import base64, difflib, json, os, re, sys, time
import numpy as np

HOME = os.environ.get("NATIVELY_BARK_HOME", os.path.expanduser("~/.natively-bark"))
BARK_DIR = os.path.join(HOME, "bark-3.0")
# NATIVELY_BARK_BITS=8 (or 16) trades RAM and start-up time for accuracy; each
# precision keeps its own converted-model cache.
BITS = int(os.environ.get("NATIVELY_BARK_BITS", "4"))
if BITS not in (4, 8, 16):
    BITS = 4
CACHE_DIR = os.path.join(HOME, f"mlx_{BITS}bit")

FRAME = 480                 # 30 ms @ 16 kHz
SILENCE_END_S = 0.9
PARTIAL_EVERY_S = 1.0
MAX_UTTERANCE_S = 14.0      # Bark's window is 15 s; cut before it
MIN_SPEECH_S = 0.25
PREROLL_FRAMES = 15         # keep ~450 ms before speech onset so soft word starts survive
MIN_THRESHOLD = 0.004       # RMS floor; adapts upward with the noise floor


VOCAB_FILE = os.path.join(HOME, "vocabulary.txt")
FUZZY_CUTOFF = 0.8
FUZZY_MIN_LEN = 5           # short words are too easy to over-correct


def load_vocabulary():
    """vocabulary.txt, one entry per line ('#' starts a comment):
         Ubuntu            -> near-misses ("Ubantu") are corrected to this spelling
         among => Aman     -> exact rule: every whole-word "among" becomes "Aman"
    """
    terms, rules = [], {}
    try:
        for raw in open(VOCAB_FILE, encoding="utf-8"):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            if "=>" in line:
                bad, good = (x.strip() for x in line.split("=>", 1))
                if bad and good:
                    rules[bad.lower()] = good
            else:
                terms.append(line)
    except OSError:
        pass
    return terms, rules


def apply_vocabulary(text, terms, rules):
    if not terms and not rules:
        return text
    by_lower = {t.lower(): t for t in terms if " " not in t}

    def fix(m):
        w = m.group(0)
        lw = w.lower()
        if lw in rules:
            return rules[lw]
        if lw in by_lower:
            return by_lower[lw]
        if len(w) >= FUZZY_MIN_LEN:
            hit = difflib.get_close_matches(lw, by_lower, n=1, cutoff=FUZZY_CUTOFF)
            if hit:
                return by_lower[hit[0]]
        return w

    return re.sub(r"[A-Za-z][A-Za-z'’-]*", fix, text)


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    sys.path.insert(0, BARK_DIR)
    import bark_mlx, soxr
    try:
        model = bark_mlx.load_model(os.path.join(BARK_DIR, "model.bark"), bits=BITS, cache_dir=CACHE_DIR)
    except Exception as e:  # noqa: BLE001
        send({"type": "error", "message": f"Cannot load Bark model from {BARK_DIR}: {e}"})
        return 1

    terms, rules = load_vocabulary()

    def transcribe(wave):
        return apply_vocabulary(bark_mlx.transcribe(model, wave, 16000).strip(), terms, rules)

    resampler, resampler_rate = None, None
    carry = np.zeros(0, np.float32)           # samples not yet forming a full frame
    preroll = []                              # recent silent frames
    utt = []                                  # frames of the current utterance
    speaking, silent_run, last_partial_n, noise = False, 0, 0, MIN_THRESHOLD / 2
    last_partial_text = ""

    def utt_wave():
        return np.concatenate(utt) if utt else np.zeros(0, np.float32)

    def emit_final():
        nonlocal utt, speaking, silent_run, last_partial_n, last_partial_text
        wave = utt_wave()
        if len(wave) >= MIN_SPEECH_S * 16000:
            text = transcribe(wave)
            if text:
                send({"type": "transcript", "text": text, "isFinal": True})
        utt, speaking, silent_run, last_partial_n, last_partial_text = [], False, 0, 0, ""

    send({"type": "ready"})
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        kind = msg.get("type")
        if kind == "stop":
            if speaking:
                emit_final()
            return 0
        if kind == "flush":
            if speaking:
                emit_final()
            continue
        if kind != "audio":
            continue
        rate = int(msg.get("sampleRate", 16000))
        pcm = np.frombuffer(base64.b64decode(msg["pcm"]), dtype="<i2").astype(np.float32) / 32768.0
        if rate != 16000:
            if resampler is None or resampler_rate != rate:
                resampler, resampler_rate = soxr.ResampleStream(rate, 16000, 1, dtype="float32"), rate
            pcm = resampler.resample_chunk(pcm)
        carry = np.concatenate([carry, pcm])
        while len(carry) >= FRAME:
            frame, carry = carry[:FRAME], carry[FRAME:]
            rms = float(np.sqrt(np.mean(frame * frame)) + 1e-9)
            threshold = max(MIN_THRESHOLD, noise * 3.0)
            voiced = rms > threshold
            if not voiced:
                noise = 0.95 * noise + 0.05 * rms   # track the floor on quiet frames only
            if not speaking:
                if voiced:
                    speaking, silent_run = True, 0
                    utt = list(preroll) + [frame]
                    preroll = []
                else:
                    preroll.append(frame)
                    preroll = preroll[-PREROLL_FRAMES:]
                continue
            utt.append(frame)
            silent_run = 0 if voiced else silent_run + 1
            n = len(utt) * FRAME
            if silent_run * FRAME >= SILENCE_END_S * 16000 or n >= MAX_UTTERANCE_S * 16000:
                emit_final()
            elif n - last_partial_n >= PARTIAL_EVERY_S * 16000:
                last_partial_n = n
                text = transcribe(utt_wave())
                if text and text != last_partial_text:
                    last_partial_text = text
                    send({"type": "transcript", "text": text, "isFinal": False})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        send({"type": "error", "message": f"Bark worker crashed: {e}"})
        sys.exit(1)
