"""faces.py - where are the faces? Used by auto reels to keep the speaker in a 9:16 crop of 16:9 footage.

Usage: python faces.py <request.json> <out.json>
Request: { "file": "...", "width": 1920, "height": 1080, "fps": 3, "spans": [[start, end], ...] }
Output:  { "spans": [ { "samples": [ { "t": 12.33, "faces": [[cx, cy, w, h], ...] }, ... ], "cuts": [seconds, ...] }, ... ] }
         face boxes are centre + size as fractions of the frame (0..1); t is seconds in the file.

OpenCV Haar cascades (frontal, then profile both ways when no frontal face is found). Frames are decoded by FFmpeg
at 640 px wide, so camera files (MXF, 10-bit, HEVC) work too. Install: pip install "opencv-python-headless<5"
"""
import json
import re
import subprocess
import sys


def main():
    req = json.load(open(sys.argv[1], encoding="utf-8-sig"))
    import cv2
    import numpy as np

    base = cv2.data.haarcascades
    frontal = cv2.CascadeClassifier(base + "haarcascade_frontalface_default.xml")
    profile = cv2.CascadeClassifier(base + "haarcascade_profileface.xml")
    W = 640
    H = max(2, int(round(W * req["height"] / max(1, req["width"]) / 2)) * 2)
    fps = float(req.get("fps", 3))
    out, total = [], max(1e-6, sum(b - a for a, b in req["spans"]))
    done = 0.0
    for a, b in req["spans"]:
        p = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", req["file"],
                            "-an", "-vf", f"fps={fps},scale={W}:{H},format=gray", "-f", "rawvideo", "-"], capture_output=True)
        n = len(p.stdout) // (W * H)
        frames = np.frombuffer(p.stdout[: n * W * H], dtype=np.uint8).reshape(n, H, W) if n else []
        samples = []
        for i, g in enumerate(frames):
            g = cv2.equalizeHist(g)
            min_side = max(20, H // 18)
            boxes = list(frontal.detectMultiScale(g, scaleFactor=1.1, minNeighbors=6, minSize=(min_side, min_side)))
            if not boxes:
                boxes = list(profile.detectMultiScale(g, 1.1, 6, minSize=(min_side, min_side)))
                flipped = profile.detectMultiScale(cv2.flip(g, 1), 1.1, 6, minSize=(min_side, min_side))
                boxes += [(W - x - w, y, w, h) for (x, y, w, h) in flipped]
            faces = [[round((x + w / 2) / W, 4), round((y + h / 2) / H, 4), round(w / W, 4), round(h / H, 4)] for (x, y, w, h) in boxes]
            samples.append({"t": round(a + (i + 0.5) / fps, 3), "faces": faces})
        # frame-accurate camera cuts in this span, so crop changes land exactly on a cut and never mid-shot
        sc = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", req["file"], "-an",
                             "-vf", "scale=320:-2,select='gt(scene,0.28)',showinfo", "-f", "null", "-"], capture_output=True, text=True, errors="ignore")
        cuts = [round(a + float(x), 3) for x in re.findall(r"pts_time:([\d.]+)", sc.stderr)]
        out.append({"samples": samples, "cuts": cuts})
        done += b - a
        print(f"PROGRESS {int(done / total * 100)}", file=sys.stderr, flush=True)
    json.dump({"spans": out}, open(sys.argv[2], "w", encoding="utf-8"))


if __name__ == "__main__":
    main()
