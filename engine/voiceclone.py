"""🧬 Same-voice AI dubbing (Phase 22): every line spoken in the ORIGINAL speaker's voice, in another language - like
ElevenLabs dubbing, but on this computer (free, nothing is uploaded). Chatterbox Multilingual (Resemble AI, MIT licence):
a 10-15 s sample of the speaker is enough, no training.

Runs with its own Python (tools/aivoice/venv - its versions of torch / transformers must not touch the editor's own):
  <venv python> voiceclone.py <job.json>      one job, then it ends
  <venv python> voiceclone.py --serve         stays on: one job.json path per stdin line, the model stays loaded between
                                              jobs (loading it took 1-3 minutes every time); ends after IDLE s with no job
job.json: { "ref": "speaker.wav", "lang": "hi", "lines": [ { "text": "...", "out": "l0.wav" } ], "exaggeration": 0.5, "cfg": 0.5 }
prints "PROGRESS <pct> <msg>" lines, then one JSON line: { "done": n } or { "error": "..." } (--serve: "RESULT {...}")
Languages: ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh
"""
import json
import os
import sys
import threading

LANGS = set("ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh".split())
IDLE = 300  # (--serve: the model holds ~4 GB of the GPU - given back after 5 idle minutes)
TOKENS_PER_S = 25  # (speech tokens a second of voice)
FILES = ["ve.pt", "t3_mtl23ls_v2.safetensors", "s3gen.pt", "grapheme_mtl_merged_expanded_v1.json", "conds.pt", "Cangjie5_TC.json"]
model = None


def say(p, msg):
    print(f"PROGRESS {p} {msg}", flush=True)  # (stdout: the server reads it line by line; the answer is the last line)


def load():
    global model
    if model is not None:
        return
    say(1, "loading the voice model (first time: downloads ~3 GB)")
    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS, REPO_ID
    from huggingface_hub import snapshot_download

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    say(3, "loading the voice model")
    # from the files already downloaded - asking the internet whether they changed first held every start up
    try:
        ckpt = snapshot_download(repo_id=REPO_ID, local_files_only=True, allow_patterns=FILES)
        model = ChatterboxMultilingualTTS.from_local(ckpt, dev)
    except Exception:
        model = ChatterboxMultilingualTTS.from_pretrained(device=dev)
    model.dev = dev
    inference = model.t3.inference
    # (generate() always lets a take run to 1000 tokens = 40 s: a take that keeps talking now stops a little past what its
    # text needs - still long enough to be seen as too long and made again)
    model.t3.inference = lambda *a, **k: inference(*a, **{**k, "max_new_tokens": model.cap or k.get("max_new_tokens")})
    model.cap = None


def work(job):
    import torch
    import torchaudio as ta

    lang = job.get("lang", "hi")
    if lang not in LANGS:
        return {"error": f"The same-voice model does not speak '{lang}' - use a Microsoft Edge voice for it"}
    load()
    lines = job["lines"]
    ex = float(job.get("exaggeration", 0.5))
    say(5, "listening to the voice")
    model.prepare_conditionals(job["ref"], exaggeration=ex)  # (once a job - generate() used to read the sample every take)
    retried = 0
    for i, l in enumerate(lines):
        say(5 + int(90 * i / max(1, len(lines))), f"line {i + 1} of {len(lines)}")
        # the model sometimes keeps talking after the sentence (made-up words at the end): a take much longer than the
        # text needs is made again (another seed) and the take nearest the expected length is kept
        want = expected(l["text"], lang)
        model.cap = int(TOKENS_PER_S * (want * 1.6 + 2))
        best = None
        for tryno in range(4):
            torch.manual_seed(1234 + tryno * 7919 + i)
            wav = model.generate(l["text"], language_id=lang, exaggeration=ex, cfg_weight=float(job.get("cfg", 0.5)))
            d = wav.shape[-1] / model.sr
            if best is None or abs(d - want) < abs(best[1] - want):
                best = (wav, d)
            if d <= want * 1.25 + 0.5:
                break
            retried += 1
        ta.save(l["out"], best[0].cpu(), model.sr)
    return {"done": len(lines), "device": model.dev, "retried": retried}


def expected(text, lang):
    """about how long a sentence takes to say, in seconds (Hindi in Devanagari ~11 characters a second, Latin ~14)"""
    letters = sum(1 for ch in text if not ch.isspace())
    return 0.4 + letters / (11.0 if lang == "hi" else 14.0)


def run(path):
    try:
        return work(json.load(open(path, encoding="utf-8")))
    except Exception as e:  # (the server shows this to the editor)
        return {"error": f"{type(e).__name__}: {e}"}


def serve():
    # stdin is read only between jobs, on this thread: on Windows a read of the pipe waiting on another thread froze the
    # job (torch's imports). A timer ends an idle server instead.
    idle = [None]

    def rest():
        idle[0] = threading.Timer(IDLE, lambda: os._exit(0))
        idle[0].daemon = True
        idle[0].start()

    rest()
    for line in sys.stdin:  # (ends when the server is gone)
        if not line.strip():
            continue
        idle[0].cancel()
        print("RESULT " + json.dumps(run(line.strip())), flush=True)
        rest()


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        serve()
    else:
        print(json.dumps(run(sys.argv[1])))
