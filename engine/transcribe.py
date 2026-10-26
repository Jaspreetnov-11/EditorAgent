"""Transcribe a video/audio file to SRT with faster-whisper.

Usage:
  python transcribe.py <media> [--lang hi|en|auto] [--task transcribe|translate]
                       [--model large-v3] [--words 0] [--prompt "script text..."] [--out file.srt]

--words N   split captions into chunks of N words using word timestamps
            (use 3-5 for reels; 0 = natural sentence-level segments for documentaries)
--prompt    pass the VO/script text so names and Hindi terms are spelled right
--task translate  outputs English subtitles from Hindi speech
Install: pip install faster-whisper
"""
import argparse
import sys


def ts(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--lang", default="auto")
    ap.add_argument("--task", default="transcribe", choices=["transcribe", "translate"])
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--words", type=int, default=0)
    ap.add_argument("--max-chars", type=int, default=42)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--json", default=None, help="also write sentence segments as JSON: [{start, end, text}]")
    ap.add_argument("--song", action="store_true",
                    help="singing (a voice stem from engine/song.py): each line is heard on its own - with the previous lines as context Whisper skips whole verses of a long song")
    ap.add_argument("--translate-json", default=None,
                    help="speech not in English: also translate it to English with the same loaded model and audio, as JSON like --json")
    a = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper not installed: pip install faster-whisper")

    import numpy as np
    # NVIDIA's cuBLAS / cuDNN come as pip packages (nvidia-cublas-cu12, nvidia-cudnn-cu12): put their DLL folders on the
    # search path so CTranslate2 can find them on Windows
    import os
    import site
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        for lib in ("cublas", "cudnn", "cuda_nvrtc"):
            d = os.path.join(sp, "nvidia", lib, "bin")
            if os.path.isdir(d):
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
    # A model already on this PC is loaded without asking the internet first: that check took ~11 s on every run (and
    # longer on a PC without internet). Only a model that is not here yet is downloaded.
    def load(**kw):
        try:
            return WhisperModel(a.model, local_files_only=True, **kw)
        except Exception:
            return WhisperModel(a.model, **kw)

    # An NVIDIA card without the CUDA/cuBLAS runtime loads the model fine and only fails on first use,
    # so prove the GPU with a 1-second dry run before trusting it.
    model = None
    try:
        model = load(device="cuda", compute_type="float16")
        list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en")[0])
        print("using GPU", file=sys.stderr)
    except Exception:
        # all but a few cores (faster-whisper uses only 4 threads unless told): about 3x faster on a 24-core PC
        import os
        threads = max(4, (os.cpu_count() or 8) - 4)
        model = load(device="cpu", compute_type="int8", cpu_threads=threads)
        print(f"using CPU ({threads} threads)", file=sys.stderr)

    # Decode with FFmpeg ourselves: faster-whisper's own PyAV decoder breaks when PyAV is newer than it expects
    # ("open() got an unexpected keyword argument 'metadata_errors'"), and FFmpeg reads every format anyway.
    import subprocess
    import numpy as np
    pcm = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", a.media, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                         capture_output=True, check=False)
    if pcm.returncode != 0 or not pcm.stdout:
        sys.exit(f"could not read audio from {a.media}: {pcm.stderr.decode(errors='ignore')[-400:]}")
    audio = np.frombuffer(pcm.stdout, dtype=np.int16).astype(np.float32) / 32768.0

    from types import SimpleNamespace as NS

    def pieces():
        # a song is heard in ~30 s pieces cut where the voice is quietest (between sung lines, no word cut in two):
        # in one long pass Whisper drops whole verses and choruses of a song
        hop = 1600  # 0.1 s
        e = np.sqrt(np.convolve(audio ** 2, np.ones(hop) / hop, mode="same")[::hop] + 1e-12)
        cuts, t, end = [0.0], 30.0, len(audio) / 16000
        while t < end - 10:
            lo, hi = int((t - 8) * 10), min(len(e), int((t + 8) * 10))
            k = lo + int(np.argmin(e[lo:hi]))
            cuts.append(k / 10)
            t = k / 10 + 30
        cuts.append(end)
        return [(int(cuts[i] * 16000), int(cuts[i + 1] * 16000)) for i in range(len(cuts) - 1)]

    def hear(task, lang, words):
        out, first = [], None
        for s0, s1 in pieces():
            segs, inf = model.transcribe(audio[s0:s1], language=lang, task=task, initial_prompt=a.prompt if task == "transcribe" else None,
                                         vad_filter=False, word_timestamps=words, condition_on_previous_text=False)
            first = first or inf
            off = s0 / 16000
            for sg in segs:
                out.append(NS(start=sg.start + off, end=sg.end + off, text=sg.text,
                              words=[NS(start=w.start + off, end=w.end + off, word=w.word) for w in sg.words] if sg.words else None))
            print(f"PROGRESS {min(99, int(s1 / len(audio) * 100))}", file=sys.stderr, flush=True)
        return out, NS(language=first.language if first else (lang or "en"), language_probability=first.language_probability if first else 0, duration=len(audio) / 16000)

    if a.song:
        segments, info = hear(a.task, None if a.lang == "auto" else a.lang, a.words > 0)
    else:
        segments, info = model.transcribe(
            audio,
            language=None if a.lang == "auto" else a.lang,
            task=a.task,
            initial_prompt=a.prompt,
            vad_filter=True,
            word_timestamps=a.words > 0,
        )
    print(f"language={info.language} p={info.language_probability:.2f} duration={info.duration:.1f}s", file=sys.stderr)

    cues, sentences = [], []
    for seg in segments:
        sentence = {"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip()}
        if a.words > 0 and seg.words:  # word timings (karaoke captions, pause trimming in auto reels)
            sentence["words"] = [{"s": round(w.start, 3), "e": round(w.end, 3), "w": w.word.strip()} for w in seg.words if w.word.strip()]
        sentences.append(sentence)
        print(f"PROGRESS {min(99, int(seg.end / max(1, info.duration) * 100))}", file=sys.stderr, flush=True)
        if a.words > 0 and seg.words:
            ws = list(seg.words)
            for i in range(0, len(ws), a.words):
                chunk = ws[i:i + a.words]
                cues.append((chunk[0].start, chunk[-1].end, "".join(w.word for w in chunk).strip()))
        else:
            text = seg.text.strip()
            # wrap long sentence-level cues onto two lines
            if len(text) > a.max_chars:
                words, line, lines = text.split(), "", []
                for w in words:
                    if len(line) + len(w) + 1 > a.max_chars and line:
                        lines.append(line)
                        line = w
                    else:
                        line = f"{line} {w}".strip()
                lines.append(line)
                text = "\n".join(lines)
            cues.append((seg.start, seg.end, text))
        print(f"  {ts(cues[-1][0])}  {cues[-1][2]}", file=sys.stderr)

    out = a.out or a.media.rsplit(".", 1)[0] + ".srt"
    with open(out, "w", encoding="utf-8") as f:
        for n, (s, e, t) in enumerate(cues, 1):
            f.write(f"{n}\n{ts(s)} --> {ts(e)}\n{t}\n\n")
    if a.json:
        import json
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump({"language": info.language, "duration": info.duration, "segments": sentences}, f, ensure_ascii=False)
    # the English version (the agent matches pictures to English lines) without loading the model or decoding again
    if a.translate_json and info.language != "en":
        print("translating to English", file=sys.stderr, flush=True)
        tsegs, _ = hear("translate", info.language, False) if a.song else model.transcribe(audio, language=info.language, task="translate", vad_filter=True)
        tr = [{"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()} for s in tsegs]
        import json
        with open(a.translate_json, "w", encoding="utf-8") as f:
            json.dump({"language": "en", "duration": info.duration, "segments": tr}, f, ensure_ascii=False)
    print(out)


if __name__ == "__main__":
    main()
