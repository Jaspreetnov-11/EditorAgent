"""thumbpick.py - the frames most worth a thumbnail.

Usage: python thumbpick.py <request.json>
Request: { "items": [ { "file", "t" } ], "out": "<folder>", "keep": 9, "model": "<yunet.onnx or ''>" }
Prints JSON: { "frames": [ { "i", "file" (jpg in out), "t", "src", "score", "face": [x, y, w, h] | null } ] } best first.

Score: sharp (Laplacian), a big clear face (YuNet / Haar), good brightness, colourful, not a near copy of a better pick.
"""
import json
import os
import subprocess
import sys


def main():
    import cv2
    import numpy as np

    req = json.load(open(sys.argv[1], encoding="utf-8-sig"))
    out = req["out"]
    os.makedirs(out, exist_ok=True)
    model = req.get("model") or ""
    yunet = None
    if model and os.path.exists(model):
        yunet = cv2.FaceDetectorYN.create(model, "", (640, 360), 0.7, 0.3, 5000)
    haar = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    cands = []
    items = req["items"]
    for i, it in enumerate(items):
        jpg = os.path.join(out, f"cand{i:02d}.jpg")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{it['t']:.3f}", "-i", it["file"], "-frames:v", "1",
                        "-vf", "scale='min(1920,iw)':-2", "-q:v", "2", "-update", "1", jpg], capture_output=True)
        img = cv2.imread(jpg)
        if img is None:
            continue
        h0, w0 = img.shape[:2]
        small = cv2.resize(img, (640, max(2, int(640 * h0 / w0))))
        sh, sw = small.shape[:2]
        g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        sharp = cv2.Laplacian(g, cv2.CV_64F).var()
        bright = float(g.mean())
        b, gr, r = [small[:, :, k].astype(np.float32) for k in range(3)]
        colour = float(np.sqrt(np.std(r - gr) ** 2 + np.std(0.5 * (r + gr) - b) ** 2))
        face = None
        if yunet is not None:
            yunet.setInputSize((sw, sh))
            _, det = yunet.detect(small)
            if det is not None and len(det):
                d = max(det, key=lambda x: x[2] * x[3])
                face = [float(d[0]) / sw, float(d[1]) / sh, float(d[2]) / sw, float(d[3]) / sh]
        else:
            fs = haar.detectMultiScale(cv2.equalizeHist(g), 1.1, 6, minSize=(24, 24))
            if len(fs):
                x, y, w, h = max(fs, key=lambda f: f[2] * f[3])
                face = [x / sw, y / sh, w / sw, h / sh]
        score = min(1.0, sharp / 400) * 2 + min(1.0, colour / 60) - abs(bright - 125) / 125
        if face:
            score += 1.5 + min(1.0, face[3] / 0.35)  # a face, the bigger the better (up to a third of the height)
        sig = cv2.resize(g, (16, 9)).astype(np.float32).flatten()
        cands.append({"i": i, "file": jpg, "t": it["t"], "src": it.get("src", ""), "score": round(score, 3), "face": [round(v, 4) for v in face] if face else None, "_sig": sig / (np.linalg.norm(sig) or 1)})
        print(f"PROGRESS {int(100 * (i + 1) / len(items))}", file=sys.stderr, flush=True)
    cands.sort(key=lambda c: -c["score"])
    picked = []
    for c in cands:
        if any(float(c["_sig"] @ p["_sig"]) > 0.995 for p in picked):
            continue
        picked.append(c)
        if len(picked) >= int(req.get("keep", 9)):
            break
    keep = {p["file"] for p in picked}
    for c in cands:
        if c["file"] not in keep:
            try:
                os.remove(c["file"])
            except OSError:
                pass
    print(json.dumps({"frames": [{k: v for k, v in c.items() if k != "_sig"} for c in picked]}))


if __name__ == "__main__":
    main()
