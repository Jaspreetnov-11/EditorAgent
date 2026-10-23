"""pyfx.py - Premiere's effects that FFmpeg has no filter for, done with OpenCV (engine/premiere-effects-gap.md).

render2.mjs runs it before a shot is rendered (the effects work on the shot's own frames, first in its stack) and for the
Morph Cut transition. Frames come from FFmpeg and go back to it through pipes, so any file FFmpeg reads works.

  python pyfx.py effects <source> <in seconds> <length seconds> <out.mp4> <effects json>
      effects json: [{"type": "paintbucket" | "brushstrokes" | "rollingshutter", "p": {...}}] in order
      out.mp4 keeps the source's sound and frame rate (at most 1080 lines high, like the stabiliser's working copy)
  python pyfx.py morph <a.mp4> <a seconds> <b.mp4> <b seconds> <length> <fps> <width> <height> <out.mp4>
      a picture that flows from frame a (the outgoing shot) to frame b (the incoming one), by optical flow both ways

Needs numpy and opencv-python (cv2). Prints one line per 25 frames (progress) and exits 1 with a reason on errors.
"""
import json
import subprocess
import sys

import cv2
import numpy as np


def probe(src):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate',
                        '-of', 'json', src], capture_output=True, text=True)
    streams = json.loads(r.stdout or '{}').get('streams') if r.returncode == 0 else None
    if not streams:
        sys.exit(f'pyfx: cannot read the video of {src}: {(r.stderr or "no video stream").strip().splitlines()[-1:]}')
    s = streams[0]
    num, den = (s.get('avg_frame_rate') or '25/1').split('/')
    fps = float(num) / float(den or 1) if float(num) > 0 else 25.0
    return int(s['width']), int(s['height']), fps


def num(p, k, d):
    try:
        return float(p.get(k, d))
    except (TypeError, ValueError):
        return float(d)


def hex_bgr(c, d='#ffffff'):
    c = c if isinstance(c, str) and len(c) == 7 and c.startswith('#') else d
    return np.array([int(c[5:7], 16), int(c[3:5], 16), int(c[1:3], 16)], np.float32)


# ---------- the effects (frame: BGR uint8; state: a dict kept between frames) ----------

def paint_bucket(f, p, st):
    """Fills the area around a point whose colour is near the point's (Premiere's Paint Bucket, Fill Selector: Color)."""
    h, w = f.shape[:2]
    x = int(np.clip(num(p, 'x', 50) / 100 * w, 0, w - 1))
    y = int(np.clip(num(p, 'y', 50) / 100 * h, 0, h - 1))
    tol = num(p, 'tol', 10) * 2.55
    mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(f, mask, (x, y), (0, 0, 0), (tol,) * 3, (tol,) * 3, 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8))
    a = mask[1:-1, 1:-1].astype(np.float32) / 255
    soft = num(p, 'feather', 0)
    if soft > 0:
        a = cv2.GaussianBlur(a, (0, 0), soft * w / 1920)
    a = (a * num(p, 'opacity', 1))[..., None]
    if p.get('mode') == 'stroke':  # only the edge of the area
        a = np.abs(a - cv2.GaussianBlur(a, (0, 0), max(1.0, num(p, 'stroke', 6) * w / 1920))[..., None]) * 4
        a = np.clip(a, 0, 1)
    out = f.astype(np.float32) * (1 - a) + hex_bgr(p.get('color'), '#ff3b30') * a
    return np.clip(out, 0, 255).astype(np.uint8)


def brush_strokes(f, p, st):
    """Painterly strokes: flat areas kept, details smoothed along the stroke angle, a little stroke texture."""
    h, w = f.shape[:2]
    k = w / 1920
    L = max(3, int(num(p, 'length', 18) * k) | 1)
    ang = np.deg2rad(num(p, 'angle', 135))
    if 'kern' not in st:  # the stroke: a short line at the angle (two, a little apart, for some variety)
        ks = []
        for da in (-0.25, 0.25):
            kern = np.zeros((L, L), np.float32)
            c = L // 2
            dx, dy = np.cos(ang + da), -np.sin(ang + da)
            cv2.line(kern, (int(round(c - dx * c)), int(round(c - dy * c))), (int(round(c + dx * c)), int(round(c + dy * c))), 1.0, 1)
            ks.append(kern / max(1e-6, kern.sum()))
        st['kern'] = ks
        rng = np.random.default_rng(7)
        st['tex'] = cv2.GaussianBlur(rng.standard_normal((h, w)).astype(np.float32), (0, 0), 1.2 * max(1, k))
    base = cv2.edgePreservingFilter(f, flags=cv2.RECURS_FILTER, sigma_s=max(10, 40 * k), sigma_r=0.35)
    a = cv2.filter2D(base, -1, st['kern'][0])
    b = cv2.filter2D(base, -1, st['kern'][1])
    sel = (st['tex'] > 0)[..., None]
    s = np.where(sel, a, b).astype(np.float32)
    s += (cv2.filter2D(st['tex'], -1, st['kern'][0]) * 18 * num(p, 'texture', 1))[..., None]
    mix = num(p, 'blend', 0)
    out = s * (1 - mix) + f.astype(np.float32) * mix
    return np.clip(out, 0, 255).astype(np.uint8)


def rolling_shutter(f, p, st):
    """Rolling shutter repair: the camera moved while the sensor was read line by line, so each line is moved back by
    its share of the frame's motion (measured by optical flow from the frame before)."""
    h, w = f.shape[:2]
    g = cv2.cvtColor(cv2.resize(f, (max(16, w // 4), max(16, h // 4))), cv2.COLOR_BGR2GRAY)
    prev = st.get('prev')
    st['prev'] = g
    if prev is None:
        return f
    if 'dis' not in st:
        st['dis'] = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    flow = st['dis'].calc(prev, g, None) * 4  # (in full-size pixels)
    vx, vy = float(np.median(flow[..., 0])), float(np.median(flow[..., 1]))
    if p.get('method') == 'warp':  # per band of lines: the motion of that band (bends with uneven motion)
        bands = np.array([np.median(b[..., 0]) for b in np.array_split(flow, 8, axis=0)], np.float32)
        rows = np.interp(np.arange(h), np.linspace(0, h - 1, 8), bands)
        vxr = rows.astype(np.float32)
    else:
        vxr = np.full(h, vx, np.float32)
    share = num(p, 'rate', 50) / 100  # (the readout time, as a part of a frame)
    t = (np.arange(h, dtype=np.float32) / max(1, h - 1) - 0.5) * share
    if p.get('order') == 'bottom':
        t = -t
    mx, my = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    mx += (t * vxr)[:, None]
    my += (t * vy)[:, None]
    return cv2.remap(f, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


EFFECTS = {'paintbucket': paint_bucket, 'brushstrokes': brush_strokes, 'rollingshutter': rolling_shutter}


def run_effects(src, tin, dur, out, fx):
    w, h, fps = probe(src)
    if h > 1080:
        w, h = int(round(w * 1080 / h / 2)) * 2, 1080
    reader = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(tin), '-t', str(dur), '-i', src, '-vf', f'scale={w}:{h}',
                               '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
    writer = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-r', f'{fps:.6f}', '-i', '-',
                               '-ss', str(tin), '-t', str(dur), '-i', src, '-map', '0:v', '-map', '1:a?', '-shortest',
                               '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', out],
                              stdin=subprocess.PIPE)
    states = [{} for _ in fx]
    size, n = w * h * 3, 0
    while True:
        buf = reader.stdout.read(size)
        if len(buf) < size:
            break
        f = np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()
        for e, st in zip(fx, states):
            fn = EFFECTS.get(e.get('type'))
            if fn:
                f = fn(f, e.get('p') or {}, st)
        writer.stdin.write(f.tobytes())
        n += 1
        if n % 25 == 0:
            print(f'pyfx: {n} frames', flush=True)
    writer.stdin.close()
    reader.wait()
    if writer.wait() != 0 or n == 0:
        sys.exit(f'pyfx: could not make {out}')


def frame_at(src, t, w, h):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{max(0.0, t):.4f}', '-i', src, '-frames:v', '1', '-vf', f'scale={w}:{h}',
                        '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True)
    if len(r.stdout) < w * h * 3:  # (past the end: the last frame there is)
        r = subprocess.run(['ffmpeg', '-v', 'error', '-sseof', '-0.1', '-i', src, '-frames:v', '1', '-vf', f'scale={w}:{h}',
                            '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True)
    return np.frombuffer(r.stdout[:w * h * 3], np.uint8).reshape(h, w, 3)


def morph(a_src, ta, b_src, tb, dur, fps, w, h, out):
    """Morph Cut: the outgoing frame flows into the incoming one (each pulled along the optical flow towards the other,
    then mixed), so a jump cut in an interview reads as one take."""
    A, B = frame_at(a_src, ta, w, h), frame_at(b_src, tb, w, h)
    s = 2 if w > 1280 else 1  # (flow measured at half size for big frames)
    ga = cv2.cvtColor(cv2.resize(A, (w // s, h // s)), cv2.COLOR_BGR2GRAY)
    gb = cv2.cvtColor(cv2.resize(B, (w // s, h // s)), cv2.COLOR_BGR2GRAY)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    fab = cv2.resize(dis.calc(ga, gb, None), (w, h)) * s  # A(x) ~ B(x + fab(x))
    fba = cv2.resize(dis.calc(gb, ga, None), (w, h)) * s  # B(x) ~ A(x + fba(x))
    mx, my = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    n = max(1, int(round(dur * fps)))
    writer = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-r', f'{fps:.6f}', '-i', '-',
                               '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', out], stdin=subprocess.PIPE)
    for k in range(n):
        t = (k + 0.5) / n
        t = t * t * (3 - 2 * t)  # (eased: slow at both ends, like Premiere's)
        aw = cv2.remap(A, mx + fba[..., 0] * t, my + fba[..., 1] * t, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        bw = cv2.remap(B, mx + fab[..., 0] * (1 - t), my + fab[..., 1] * (1 - t), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        writer.stdin.write(cv2.addWeighted(aw, 1 - t, bw, t, 0).tobytes())
    writer.stdin.close()
    if writer.wait() != 0:
        sys.exit(f'pyfx: could not make {out}')


if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == 'effects' and len(a) == 6:
        run_effects(a[1], float(a[2]), float(a[3]), a[4], json.loads(a[5]))
    elif a and a[0] == 'morph' and len(a) == 10:
        morph(a[1], float(a[2]), a[3], float(a[4]), float(a[5]), float(a[6]), int(a[7]), int(a[8]), a[9])
    else:
        sys.exit(__doc__)
