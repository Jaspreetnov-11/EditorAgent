"""🧬 Same-voice AI dubbing (Phase 22): every line spoken in the ORIGINAL speaker's voice, in another language - like
ElevenLabs dubbing, but on this computer (free, nothing is uploaded). Chatterbox Multilingual (Resemble AI, MIT licence):
a 10-15 s sample of the speaker is enough, no training.

Runs with its own Python (tools/aivoice/venv - its versions of torch / transformers must not touch the editor's own):
  <venv python> voiceclone.py <job.json>
job.json: { "ref": "speaker.wav", "lang": "hi", "lines": [ { "text": "...", "out": "l0.wav" } ], "exaggeration": 0.5, "cfg": 0.5 }
prints "PROGRESS <pct> <msg>" lines, then one JSON line: { "done": n } or { "error": "..." }
Languages: ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh
"""
import json
import os
import sys

LANGS = set("ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh".split())


def say(p, msg):
    print(f"PROGRESS {p} {msg}", flush=True)  # (stdout: the server reads it line by line; the answer is the last line)


def main():
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    lang = job.get("lang", "hi")
    if lang not in LANGS:
        print(json.dumps({"error": f"The same-voice model does not speak '{lang}' - use a Microsoft Edge voice for it"}))
        return
    say(1, "loading the voice model (first time: downloads ~3 GB)")
    import torch
    import torchaudio as ta
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = ChatterboxMultilingualTTS.from_pretrained(device=dev)
    lines = job["lines"]
    retried = 0
    for i, l in enumerate(lines):
        say(5 + int(90 * i / max(1, len(lines))), f"line {i + 1} of {len(lines)}")
        # the model sometimes keeps talking after the sentence (made-up words at the end): a take much longer than the
        # text needs is made again (another seed) and the take nearest the expected length is kept
        want = expected(l["text"], lang)
        best = None
        for tryno in range(4):
            torch.manual_seed(1234 + tryno * 7919 + i)
            wav = model.generate(l["text"], language_id=lang, audio_prompt_path=job["ref"],
                                 exaggeration=float(job.get("exaggeration", 0.5)), cfg_weight=float(job.get("cfg", 0.5)))
            d = wav.shape[-1] / model.sr
            if best is None or abs(d - want) < abs(best[1] - want):
                best = (wav, d)
            if d <= want * 1.25 + 0.5:
                break
            retried += 1
        ta.save(l["out"], best[0].cpu(), model.sr)
    print(json.dumps({"done": len(lines), "device": dev, "retried": retried}))


def expected(text, lang):
    """about how long a sentence takes to say, in seconds (Hindi in Devanagari ~11 characters a second, Latin ~14)"""
    letters = sum(1 for ch in text if not ch.isspace())
    return 0.4 + letters / (11.0 if lang == "hi" else 14.0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # (the server shows this to the editor)
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
