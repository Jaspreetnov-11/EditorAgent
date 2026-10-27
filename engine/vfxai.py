"""
vfxai.py - the AI mattes of the VFX page: a depth video (near = white, far = black) and a sky matte (white = sky) of a
piece of a clip, made on the GPU. The editor's VFX effects read them: Depth fog, Depth of field, Sky replacement
(public/js/vfxfx.js). Runs in its own Python (tools/vfxai/venv, set up from the VFX page - server POST /api/vfxai/setup).

Usage:
  python vfxai.py fetch [--models DIR]                       download the model once (about 100 MB)
  python vfxai.py depth <video> <start s> <end s> <out.mp4> [--fps 30] [--width 960] [--models DIR]
  python vfxai.py sky   <video> <start s> <end s> <out.mp4> [--fps 30] [--width 960] [--models DIR]
Prints [i/n] progress lines; writes <out.mp4> (grey, H.264) the length of start..end at --fps.

Model: Depth Anything V2 Small (Apache-2.0 - fine for client work; the Base / Large ones are not, so they are never used),
through Hugging Face transformers. The sky is what the model sees as farthest away AND joined to the top of the picture,
its edge snapped to the picture's own edges with a guided filter (as matte.py does).
"""
import os
import subprocess
import sys

import cv2
import numpy as np

MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def models_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return arg("--models", os.environ.get("VFXAI_MODELS") or os.path.join(here, "..", "tools", "vfxai", "models"))


def model_path():
    return os.path.join(models_dir(), "depth-anything-v2-small")


def fetch():
    from huggingface_hub import snapshot_download
    dst = model_path()
    os.makedirs(dst, exist_ok=True)
    snapshot_download(MODEL_ID, local_dir=dst, allow_patterns=["*.json", "*.safetensors", "*.md"])
    print("model ready:", dst, flush=True)


def guided(I, p, r, eps):
    """He et al. guided filter (grey guide): the output follows p but takes its edges from I."""
    box = lambda x: cv2.boxFilter(x, -1, (r, r))
    mI, mp = box(I), box(p)
    a = (box(I * p) - mI * mp) / (box(I * I) - mI * mI + eps)
    b = mp - a * mI
    return box(a) * I + box(b)


def load():
    import torch
    from transformers import AutoModelForDepthEstimation
    path = model_path()
    if not os.path.exists(os.path.join(path, "config.json")):
        sys.exit("the depth model is not downloaded - set up VFX AI on this PC (VFX page > AI)")
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = AutoModelForDepthEstimation.from_pretrained(path).to(dev).eval()
    if dev == "cuda":
        model = model.half()
    return torch, model, dev


def run(kind):
    src, t0, t1, out = sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
    width, fps = int(arg("--width", 960)), float(arg("--fps", 30))
    torch, model, dev = load()
    half = dev == "cuda"
    mean = torch.tensor([0.485, 0.456, 0.406], device=dev).view(1, 3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225], device=dev).view(1, 3, 1, 1)
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        sys.exit(f"cannot open {src}")
    cap.set(cv2.CAP_PROP_POS_MSEC, t0 * 1000)
    sw, sh = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    W = min(width, sw) // 2 * 2
    H = int(round(W * sh / sw)) // 2 * 2
    # the model looks at 518 px on the short side (multiples of 14, its patch size)
    k = 518 / min(sw, sh)
    mw, mh = max(14, int(round(sw * k / 14)) * 14), max(14, int(round(sh * k / 14)) * 14)
    n = max(1, int(round((t1 - t0) * fps)))
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or fps
    frame, t_read, lo, hi, prev = None, t0 - 1, None, None, None
    r = max(4, W // 160)
    for i in range(n):
        t = t0 + i / fps
        while t_read + 0.5 / src_fps < t or frame is None:
            ok, f = cap.read()
            if not ok:
                break
            frame, t_read = f, cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
        if frame is None:
            break
        small = cv2.resize(frame, (mw, mh), interpolation=cv2.INTER_AREA)
        x = torch.from_numpy(cv2.cvtColor(small, cv2.COLOR_BGR2RGB)).to(dev).permute(2, 0, 1)[None].float() / 255
        x = (x - mean) / std
        with torch.no_grad():
            disp = model(pixel_values=x.half() if half else x).predicted_depth.float()[0].cpu().numpy()  # bigger = nearer
        # steady normalisation: the 2nd / 98th percentiles, smoothed over time (a per-frame stretch would flicker)
        a, b = np.percentile(disp, 2), np.percentile(disp, 98)
        lo, hi = (a, b) if lo is None else (0.9 * lo + 0.1 * a, 0.9 * hi + 0.1 * b)
        d = np.clip((disp - lo) / max(1e-6, hi - lo), 0, 1).astype(np.float32)
        d = cv2.resize(d, (W, H), interpolation=cv2.INTER_CUBIC)
        guide = cv2.cvtColor(cv2.resize(frame, (W, H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
        if kind == "sky":
            s = np.clip((0.1 - d) / 0.08, 0, 1)
            # only sky that touches the top of the picture (far walls, distant hills inside the frame are not sky)
            nb, lab = cv2.connectedComponents((s > 0.5).astype(np.uint8))
            top = set(np.unique(lab[: max(2, H // 40)]).tolist()) - {0}
            keep = np.isin(lab, list(top)).astype(np.float32) if top else np.zeros_like(s)
            keep = cv2.dilate(keep, np.ones((r * 2 + 1, r * 2 + 1), np.uint8))
            m = guided(guide, s * keep, r, 1e-3)
            m = np.clip((m - 0.25) / 0.5, 0, 1)
        else:
            m = guided(guide, d, r, 1e-2)
        prev = m if prev is None else 0.7 * m + 0.3 * prev
        enc.stdin.write((np.clip(prev, 0, 1) * 255).astype(np.uint8).tobytes())
        print(f"[{i + 1}/{n}]", flush=True)
    enc.stdin.close()
    enc.wait()
    cap.release()
    if enc.returncode != 0:
        sys.exit("could not write the matte video")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "fetch":
        fetch()
    elif cmd in ("depth", "sky"):
        run(cmd)
    else:
        sys.exit(__doc__)
