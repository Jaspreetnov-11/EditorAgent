"""
matte.py - one-click roto: a black & white "subject matte" video of a clip (white = the subject, black = the rest),
made by an AI segmentation model on the GPU. The editor uses it to cut the subject out (text behind a person,
the subject over a new background, effects only on the background...).

Usage: python matte.py <video> <start s> <end s> <out.mp4> [--width 1920] [--fps 30] [--quality best|fast]
Prints [i/n] progress lines; writes <out.mp4> (grey, H.264) the length of start..end at --fps.

The subject = every pixel the model sees as a person, animal or vehicle (Pascal VOC classes). For clean edges:
  - the model looks at the frame at 720 px (best) and once more mirrored - the two answers are averaged
  - a guided filter then snaps the matte's edges to the edges in the picture itself (hair, fingers, silhouettes)
  - a light temporal smoothing keeps it from flickering without lagging behind fast moves
Model: torchvision DeepLabV3 ResNet-101 (best) / MobileNet (fast) - weights downloaded once by torchvision.
"""
import subprocess
import sys

import cv2
import numpy as np
import torch
import torchvision


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def guided(I, p, r, eps):
    """He et al. guided filter (grey guide): the output follows p but takes its edges from I."""
    box = lambda x: cv2.boxFilter(x, -1, (r, r))
    mI, mp = box(I), box(p)
    a = (box(I * p) - mI * mp) / (box(I * I) - mI * mI + eps)
    b = mp - a * mI
    return box(a) * I + box(b)


def main():
    src, t0, t1, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    width, fps, quality = int(arg("--width", 1920)), float(arg("--fps", 30)), arg("--quality", "best")
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    seg = torchvision.models.segmentation
    if quality == "fast":
        model, short = seg.deeplabv3_mobilenet_v3_large(weights=seg.DeepLabV3_MobileNet_V3_Large_Weights.DEFAULT), 520
    else:
        model, short = seg.deeplabv3_resnet101(weights=seg.DeepLabV3_ResNet101_Weights.DEFAULT), 720
    model = model.to(dev).eval()
    half = dev == "cuda"
    if half:
        model = model.half()
    mean = torch.tensor([0.485, 0.456, 0.406], device=dev).view(1, 3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225], device=dev).view(1, 3, 1, 1)

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        sys.exit(f"cannot open {src}")
    cap.set(cv2.CAP_PROP_POS_MSEC, t0 * 1000)
    sw, sh = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    W = min(width, sw) // 2 * 2
    H = int(round(W * sh / sw)) // 2 * 2
    n = max(1, int(round((t1 - t0) * fps)))
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
    prev = None
    src_fps = cap.get(cv2.CAP_PROP_FPS) or fps
    frame, t_read = None, t0 - 1
    r = max(4, W // 160)  # guided filter radius: a few pixels at the matte's size
    for i in range(n):
        t = t0 + i / fps
        # read source frames until the one at time t (source and matte rates may differ)
        while t_read + 0.5 / src_fps < t or frame is None:
            ok, f = cap.read()
            if not ok:
                break
            frame, t_read = f, cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
        if frame is None:
            break
        h, w = frame.shape[:2]
        k = short / min(h, w)
        small = cv2.resize(frame, (int(w * k) // 8 * 8, int(h * k) // 8 * 8), interpolation=cv2.INTER_AREA)
        x = torch.from_numpy(cv2.cvtColor(small, cv2.COLOR_BGR2RGB)).to(dev).permute(2, 0, 1)[None].float() / 255
        x = (x - mean) / std
        x = torch.cat([x, torch.flip(x, [3])])  # the frame and its mirror image in one go
        with torch.no_grad():
            o = model(x.half() if half else x)["out"].float()
        pr = 1 - torch.softmax(o, 1)[:, 0]  # everything that is not "background"
        prob = ((pr[0] + torch.flip(pr[1], [1])) / 2).cpu().numpy()
        # light temporal smoothing (steady, but follows fast moves)
        prev = prob if prev is None else 0.75 * prob + 0.25 * prev
        m = cv2.resize(prev, (W, H), interpolation=cv2.INTER_CUBIC).astype(np.float32)
        guide = cv2.cvtColor(cv2.resize(frame, (W, H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
        m = guided(guide, np.clip(m, 0, 1), r, 1e-3)
        # firm edges with a little softness left for hair / motion blur
        m = np.clip((m - 0.3) / 0.4, 0, 1)
        enc.stdin.write((m * 255).astype(np.uint8).tobytes())
        print(f"[{i + 1}/{n}]", flush=True)
    enc.stdin.close()
    enc.wait()
    cap.release()
    if enc.returncode != 0:
        sys.exit("could not write the matte video")


if __name__ == "__main__":
    main()
