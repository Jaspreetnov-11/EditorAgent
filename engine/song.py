"""song.py - understands a song for the 🎵 Song edit: beats, bars, parts (intro / verse / chorus / instrumental / outro)
and the singing voice on its own (Demucs), so the lyrics can be heard (transcribe.py) and the cuts follow the music.

Usage: python song.py <song file> <work dir> <out.json>
Writes out.json:
  { duration, bpm, beats: [t...], downbeats: [t...], energy: [0..1 per beat], vocal: [0..1 per beat],
    sections: [ { start, end, label, energy, vocal } ], vocals: <path of the voice-only wav or null> }
The work dir keeps vocals.wav / no_vocals.wav, so a second run on the same song is quick.
Beat tracking: spectral-flux onsets, tempo by autocorrelation, beats by dynamic programming (Ellis 2007) - so a song
whose tempo drifts keeps every cut on its real beat. Bars: the beat phase with the strongest bass hits and harmony
changes is "1". Parts: a novelty curve over a self-similarity matrix of the beat-by-beat sound, cut on bar lines.
"""
import json
import os
import subprocess
import sys

import numpy as np

SR, HOP, NFFT = 22050, 512, 2048
FPS = SR / HOP


def progress(p, msg=""):
    print(f"PROGRESS {int(p)} {msg}", file=sys.stderr, flush=True)


def load(path, sr=SR):
    """mono float32 samples through FFmpeg (reads every format)"""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                       capture_output=True, check=False)
    if r.returncode != 0 or not r.stdout:
        raise SystemExit(f"could not read {path}: {r.stderr.decode(errors='ignore')[-300:]}")
    return np.frombuffer(r.stdout, dtype=np.float32).copy()


def mel_filters(n_mels=64, fmin=30.0, fmax=8000.0):
    hz2mel = lambda f: 2595 * np.log10(1 + f / 700)
    mel2hz = lambda m: 700 * (10 ** (m / 2595) - 1)
    pts = mel2hz(np.linspace(hz2mel(fmin), hz2mel(fmax), n_mels + 2))
    bins = np.floor((NFFT + 1) * pts / SR).astype(int)
    fb = np.zeros((n_mels, NFFT // 2 + 1), dtype=np.float32)
    for i in range(n_mels):
        a, b, c = bins[i], bins[i + 1], max(bins[i + 2], bins[i + 1] + 1)
        if b > a:
            fb[i, a:b] = (np.arange(a, b) - a) / (b - a)
        fb[i, b:c] = (c - np.arange(b, c)) / (c - b)
    return fb


def logmel(y):
    """log-mel spectrogram, frames centred on t * HOP"""
    y = np.pad(y, NFFT // 2)
    n = 1 + (len(y) - NFFT) // HOP
    win = np.hanning(NFFT).astype(np.float32)
    fb = mel_filters()
    out = np.empty((n, fb.shape[0]), dtype=np.float32)
    for s in range(0, n, 2048):  # in blocks: a 5-minute song is ~13k frames
        idx = np.arange(s, min(n, s + 2048))[:, None] * HOP + np.arange(NFFT)[None, :]
        spec = np.abs(np.fft.rfft(y[idx] * win, axis=1)) ** 2
        out[s:s + len(idx)] = spec @ fb.T
    return np.log1p(1000 * out)


def onset_env(M):
    flux = np.maximum(0, np.diff(M, axis=0, prepend=M[:1])).sum(axis=1)
    k = int(FPS * 0.5)
    local = np.convolve(flux, np.ones(k) / k, mode="same")
    o = np.maximum(0, flux - local)
    return o / (o.std() + 1e-9)


def tempo_period(o):
    """beat period in frames: autocorrelation, with a mild preference for 75-140 BPM (most film / pop songs)"""
    o = o - o.mean()
    ac = np.correlate(o, o, mode="full")[len(o) - 1:]
    best, bp = -1e9, None
    for lag in range(int(FPS * 60 / 190), int(FPS * 60 / 55) + 1):
        bpm = 60 * FPS / lag
        w = np.exp(-0.5 * (np.log2(bpm / 105) / 0.8) ** 2)
        # a true tempo also lines up at twice the lag
        s = (ac[lag] + 0.5 * ac[min(len(ac) - 1, 2 * lag)]) * w
        if s > best:
            best, bp = s, lag
    return float(bp)


def track_beats(o, P, tight=100.0):
    n = len(o)
    score = o.copy()
    back = np.full(n, -1)
    lo, hi = int(round(P / 2)), int(round(2 * P))
    offs = np.arange(lo, hi + 1)
    pen = -tight * np.log(offs / P) ** 2
    for t in range(lo, n):
        ps = t - offs
        ok = ps >= 0
        if not ok.any():
            continue
        cand = score[ps[ok]] + pen[ok]
        k = int(np.argmax(cand))
        if cand[k] > 0:
            score[t] = o[t] + cand[k]
            back[t] = ps[ok][k]
    # end on the best-scoring frame within the last beat
    tail = max(0, n - int(P) - 1)
    t = tail + int(np.argmax(score[tail:]))
    beats = []
    while t >= 0:
        beats.append(t)
        t = back[t]
    beats = np.array(beats[::-1])
    # the first beats before the music really starts (silence / count-in) are dropped below by energy
    return beats


def main():
    song, work, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(work, exist_ok=True)
    progress(2, "reading the song")
    y = load(song)
    dur = len(y) / SR

    # 1. the singing voice on its own (Demucs, on the GPU when there is one) - for the lyrics and to know when they sing
    voc_path, acc_path = os.path.join(work, "vocals.wav"), os.path.join(work, "no_vocals.wav")
    if not (os.path.exists(voc_path) and os.path.exists(acc_path)):
        progress(5, "separating the voice from the music (Demucs)")
        wav = os.path.join(work, "in.wav")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", song, "-vn", "-ac", "2", "-ar", "44100", wav], check=False)
        r = subprocess.run([sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", work, wav], capture_output=True)
        sep = os.path.join(work, "htdemucs", "in")
        if r.returncode == 0 and os.path.exists(os.path.join(sep, "vocals.wav")):
            os.replace(os.path.join(sep, "vocals.wav"), voc_path)
            os.replace(os.path.join(sep, "no_vocals.wav"), acc_path)
        else:
            print(f"demucs failed: {r.stderr.decode('utf-8', errors='ignore')[-400:]}", file=sys.stderr)
        try:
            os.remove(wav)
        except OSError:
            pass
    have_voc = os.path.exists(voc_path)
    progress(60, "finding the beat")

    # 2. beats on the music without the voice (cleaner drums); bars from bass hits + harmony changes
    acc = load(acc_path) if os.path.exists(acc_path) else y
    M = logmel(acc)
    o = onset_env(M)
    P = tempo_period(o)
    bf = track_beats(o, P)
    bt = bf / FPS
    # per-beat sound: mean log-mel between beats; loudness of the full song; how much they sing
    Mfull = logmel(y)
    rms = np.sqrt(np.convolve(y ** 2, np.ones(HOP) / HOP, mode="same")[::HOP][: len(Mfull)] + 1e-12)
    vr = None
    if have_voc:
        v = load(voc_path)
        vr = np.sqrt(np.convolve(v ** 2, np.ones(HOP) / HOP, mode="same")[::HOP][: len(Mfull)] + 1e-12)
    edges = np.append(bf, len(Mfull))
    feat, loud, sing = [], [], []
    for a, b in zip(edges[:-1], edges[1:]):
        b = max(b, a + 1)
        feat.append(Mfull[a:b].mean(axis=0))
        loud.append(20 * np.log10(rms[a:b].mean() + 1e-9))
        sing.append(20 * np.log10(vr[a:b].mean() + 1e-9) if vr is not None else -80)
    feat, loud, sing = np.array(feat), np.array(loud), np.array(sing)
    norm = lambda x: np.clip((x - np.percentile(x, 10)) / max(1e-6, np.percentile(x, 95) - np.percentile(x, 10)), 0, 1)
    energy = norm(loud)
    # singing = the voice stem close to the whole song's level (within ~12 dB); Demucs leaves a faint bleed elsewhere
    vocal = np.clip((sing - (loud - 22)) / 10, 0, 1) if vr is not None else np.zeros(len(bt))
    # leading beats in real silence (not just a quiet intro) go
    audible = loud > np.max(loud) - 45
    start = int(np.argmax(audible)) if audible.any() else 0
    bt, feat, energy, vocal, bf = bt[start:], feat[start:], energy[start:], vocal[start:], bf[start:]

    low = onset_env(M[:, :8])  # bass / kick band
    change = np.r_[0, np.linalg.norm(np.diff(feat, axis=0), axis=1)]
    change = change / (change.std() + 1e-9)
    ph_score = [low[bf[k::4]].mean() + change[k::4].mean() for k in range(4)]
    ph = int(np.argmax(ph_score))
    down_idx = np.arange(ph, len(bt), 4)
    progress(75, "finding verses and choruses")

    # 3. parts: novelty on the beat-synchronous self-similarity, boundaries on bar lines
    F = np.column_stack([feat / (np.linalg.norm(feat, axis=1, keepdims=True) + 1e-9), 0.5 * vocal[:, None], 0.5 * energy[:, None]])
    k = 4
    Fs = np.array([F[max(0, i - k // 2): i + k // 2 + 1].mean(axis=0) for i in range(len(F))])
    Fs = Fs / (np.linalg.norm(Fs, axis=1, keepdims=True) + 1e-9)
    S = Fs @ Fs.T
    L = 16  # half a 32-beat checkerboard (8 bars)
    g = np.outer(np.r_[-np.ones(L), np.ones(L)], np.r_[-np.ones(L), np.ones(L)])
    g *= np.outer(np.hanning(2 * L), np.hanning(2 * L))
    nov = np.zeros(len(S))
    Sp = np.pad(S, L, mode="edge")
    for i in range(len(S)):
        nov[i] = -(Sp[i:i + 2 * L, i:i + 2 * L] * g).sum()
    nov = (nov - nov.mean()) / (nov.std() + 1e-9)
    cands = [i for i in range(1, len(nov) - 1) if nov[i] >= nov[i - 1] and nov[i] >= nov[i + 1] and nov[i] > 0.4]
    cands.sort(key=lambda i: -nov[i])
    bounds = []
    for i in cands:
        j = int(down_idx[np.argmin(np.abs(down_idx - i))]) if len(down_idx) else i
        if all(abs(j - b) >= 16 for b in bounds) and 8 <= j <= len(bt) - 8:
            bounds.append(j)
    bounds = sorted(bounds)
    segs = list(zip([0] + bounds, bounds + [len(bt)]))
    # label: who sings, how loud, and which parts come back (the chorus repeats)
    means = [F[a:b].mean(axis=0) for a, b in segs]
    sim = np.array([[float(np.dot(x, y) / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-9)) for y in means] for x in means])
    sections = []
    e_hi = np.percentile([energy[a:b].mean() for a, b in segs], 60) if segs else 1
    for n, (a, b) in enumerate(segs):
        e, v = float(energy[a:b].mean()), float(vocal[a:b].mean())
        rep = max([sim[n][m] for m in range(len(segs)) if m != n] or [0])
        if n == 0 and v < 0.35:
            lab = "intro"
        elif n == len(segs) - 1 and (v < 0.35 or e < 0.4):
            lab = "outro"
        elif v < 0.3:
            lab = "instrumental"
        elif e >= e_hi and rep > 0.97:
            lab = "chorus"
        else:
            lab = "verse"
        sections.append({"start": round(float(bt[a]) if a < len(bt) else dur, 3), "end": round(float(bt[b]) if b < len(bt) else dur, 3),
                         "label": lab, "energy": round(e, 3), "vocal": round(v, 3)})
    if sections:
        sections[0]["start"] = 0.0
        sections[-1]["end"] = round(dur, 3)
    bpm = 60 * FPS / P
    res = {"duration": round(dur, 3), "bpm": round(float(bpm), 1), "beats": [round(float(t), 3) for t in bt],
           "downbeats": [round(float(bt[i]), 3) for i in down_idx], "energy": [round(float(x), 3) for x in energy],
           "vocal": [round(float(x), 3) for x in vocal], "sections": sections, "vocals": voc_path if have_voc else None}
    json.dump(res, open(out_path, "w", encoding="utf-8"))
    progress(100, "done")


if __name__ == "__main__":
    main()
