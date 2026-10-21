"""vision.py - where the faces (and the action) are in a piece of a clip. Used by 🎯 Follow faces (reframe) and
🙈 Blur faces in the Inspector.

Usage: python vision.py <file> <start> <end> [--fps 6] [--model Models/face_detection_yunet_2023mar.onnx]
Prints JSON: { "size": [w, h], "samples": [ { "t": seconds in the file, "faces": [[x, y, w, h, score, activity], ...],
               "motion": [cx, cy, amount] } ] }   boxes / centres as fractions of the picture (x, y = top-left)

Faces: OpenCV YuNet when the model file is there (finds side faces, small and dim faces), else the Haar cascades.
Motion: where the picture changed since the previous sample (for shots without a face - follow the action).
"""
import json
import os
import subprocess
import sys


def main():
    import cv2
    import numpy as np

    file, t0, t1 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    fps = float(sys.argv[sys.argv.index("--fps") + 1]) if "--fps" in sys.argv else 6.0
    model = sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else ""
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation",
                            "-of", "json", file], capture_output=True, text=True)
    st = json.loads(probe.stdout or "{}").get("streams", [{}])[0]
    w0, h0 = st.get("width", 1920), st.get("height", 1080)
    rot = next((abs(int(d.get("rotation", 0))) for d in st.get("side_data_list", []) if "rotation" in d), 0)
    if rot == 90:
        w0, h0 = h0, w0
    W = 640
    H = max(2, int(round(W * h0 / max(1, w0) / 2)) * 2)
    p = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{t0:.3f}", "-t", f"{max(0.05, t1 - t0):.3f}", "-i", file,
                        "-an", "-vf", f"fps={fps},scale={W}:{H}", "-pix_fmt", "bgr24", "-f", "rawvideo", "-"], capture_output=True)
    n = len(p.stdout) // (W * H * 3)
    frames = np.frombuffer(p.stdout[: n * W * H * 3], dtype=np.uint8).reshape(n, H, W, 3) if n else []

    yunet = None
    if model and os.path.exists(model):
        yunet = cv2.FaceDetectorYN.create(model, "", (W, H), 0.6, 0.3, 5000)
    else:
        base = cv2.data.haarcascades
        frontal = cv2.CascadeClassifier(base + "haarcascade_frontalface_default.xml")
        profile = cv2.CascadeClassifier(base + "haarcascade_profileface.xml")

    out, prev = [], None
    for i, img in enumerate(frames):
        faces = []
        if yunet is not None:
            _, det = yunet.detect(img)
            for d in det if det is not None else []:
                x, y, w, h, score = float(d[0]), float(d[1]), float(d[2]), float(d[3]), float(d[-1])
                faces.append([x / W, y / H, w / W, h / H, score])
        else:
            g = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
            ms = max(20, H // 18)
            boxes = list(frontal.detectMultiScale(g, 1.1, 6, minSize=(ms, ms)))
            if not boxes:
                boxes = list(profile.detectMultiScale(g, 1.1, 6, minSize=(ms, ms)))
                boxes += [(W - x - w, y, w, h) for (x, y, w, h) in profile.detectMultiScale(cv2.flip(g, 1), 1.1, 6, minSize=(ms, ms))]
            faces = [[x / W, y / H, w / W, h / H, 0.8] for (x, y, w, h) in boxes]
        small = cv2.GaussianBlur(cv2.cvtColor(cv2.resize(img, (160, max(2, H * 160 // W))), cv2.COLOR_BGR2GRAY), (5, 5), 0).astype(np.float32)
        motion = [0.5, 0.5, 0.0]
        if prev is not None:
            d = np.abs(small - prev)
            d[d < 12] = 0
            tot = float(d.sum())
            if tot > 0:
                ys, xs = np.mgrid[0: d.shape[0], 0: d.shape[1]]
                motion = [float((d * xs).sum() / tot / d.shape[1]), float((d * ys).sum() / tot / d.shape[0]), float(np.count_nonzero(d) / d.size)]
        # how much each face (and the area just below it: mouth, hands) moved - the speaker usually moves most
        if prev is not None:
            sh, sw = small.shape
            for f in faces:
                x0, y0 = int(f[0] * sw), int(f[1] * sh)
                x1, y1 = int((f[0] + f[2]) * sw) + 1, int(min(1, f[1] + f[3] * 1.8) * sh) + 1
                patch = np.abs(small[y0:y1, x0:x1] - prev[y0:y1, x0:x1])
                f.append(float(patch.mean()) if patch.size else 0.0)
        else:
            for f in faces:
                f.append(0.0)
        prev = small
        out.append({"t": round(t0 + i / fps, 3), "faces": [[round(v, 4) for v in f] for f in faces], "motion": [round(v, 4) for v in motion]})
        if i % 10 == 0:
            print(f"PROGRESS {int(100 * (i + 1) / max(1, len(frames)))}", file=sys.stderr, flush=True)
    print(json.dumps({"size": [w0, h0], "samples": out}))


if __name__ == "__main__":
    main()
