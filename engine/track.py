"""Motion tracking of one thing (a face, a number plate, a sign) through a clip.

usage: python track.py <video> <t0> <t1> <x> <y> <w> <h> [--fps 15]
  box x y w h: where the thing is at t0, as fractions (0..1) of the picture
prints JSON: {"points": [{"t", "x", "y", "w", "h"}...], "lost": [t, ...]}  (t = seconds in the file, box as fractions)

How: corner points inside the box are followed frame to frame with optical flow (checked forwards and backwards);
the box moves with their median motion and grows / shrinks with their spread. When too few points survive
(blur, a turn, something passing in front) the thing is searched for again by template matching near where it was.
"""
import json
import sys

import cv2
import numpy as np


def main():
    a = sys.argv[1:]
    path, t0, t1 = a[0], float(a[1]), float(a[2])
    bx, by, bw, bh = (float(v) for v in a[3:7])
    fps_out = float(a[a.index("--fps") + 1]) if "--fps" in a else 15.0
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print(json.dumps({"error": "cannot open video"}))
        return
    cap.set(cv2.CAP_PROP_POS_MSEC, t0 * 1000)
    ok, frame = cap.read()
    if not ok:
        print(json.dumps({"error": "cannot read the first frame"}))
        return
    H0, W0 = frame.shape[:2]
    k = min(1.0, 640.0 / W0)  # work at 640 wide at most
    small = lambda f: cv2.cvtColor(cv2.resize(f, None, fx=k, fy=k, interpolation=cv2.INTER_AREA) if k < 1 else f, cv2.COLOR_BGR2GRAY)
    g0 = small(frame)
    H, W = g0.shape
    cx, cy, w, h = (bx + bw / 2) * W, (by + bh / 2) * H, bw * W, bh * H
    tmpl = g0[int(max(0, cy - h / 2)):int(cy + h / 2), int(max(0, cx - w / 2)):int(cx + w / 2)].copy()

    def feats(g):
        m = np.zeros_like(g)
        x0, y0 = int(max(0, cx - w / 2)), int(max(0, cy - h / 2))
        m[y0:int(min(H, cy + h / 2)), x0:int(min(W, cx + w / 2))] = 255
        p = cv2.goodFeaturesToTrack(g, maxCorners=80, qualityLevel=0.01, minDistance=3, mask=m, blockSize=5)
        return p if p is not None else np.empty((0, 1, 2), np.float32)

    pts = feats(g0)
    out = [{"t": round(t0, 3), "x": cx / W - w / W / 2, "y": cy / H - h / H / 2, "w": w / W, "h": h / H}]
    lost, prev, next_t = [], g0, t0 + 1.0 / fps_out
    lk = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if t > t1 + 1e-3:
            break
        g = small(frame)
        good = 0
        if len(pts) >= 4:
            p1, st, _ = cv2.calcOpticalFlowPyrLK(prev, g, pts, None, **lk)
            p0r, st2, _ = cv2.calcOpticalFlowPyrLK(g, prev, p1, None, **lk)
            keep = (st.ravel() == 1) & (st2.ravel() == 1) & (np.abs(pts - p0r).reshape(-1, 2).max(1) < 1.0)
            a0, a1 = pts[keep].reshape(-1, 2), p1[keep].reshape(-1, 2)
            good = len(a1)
            if good >= 5:
                d = np.median(a1 - a0, axis=0)
                # scale from how the points' spread changed (limited per frame so noise cannot run away)
                s0, s1 = np.linalg.norm(a0 - a0.mean(0), axis=1).mean(), np.linalg.norm(a1 - a1.mean(0), axis=1).mean()
                sc = float(np.clip(s1 / s0, 0.95, 1.05)) if s0 > 2 else 1.0
                cx, cy, w, h = cx + d[0], cy + d[1], w * sc, h * sc
                pts = a1.reshape(-1, 1, 2)
        if good < 5:
            # search again near the last place (twice the box around it)
            sx0, sy0 = int(max(0, cx - w)), int(max(0, cy - h))
            sx1, sy1 = int(min(W, cx + w)), int(min(H, cy + h))
            region = g[sy0:sy1, sx0:sx1]
            if region.shape[0] > tmpl.shape[0] and region.shape[1] > tmpl.shape[1] and tmpl.size:
                res = cv2.matchTemplate(region, tmpl, cv2.TM_CCOEFF_NORMED)
                _, mx, _, loc = cv2.minMaxLoc(res)
                if mx > 0.45:
                    cx, cy = sx0 + loc[0] + tmpl.shape[1] / 2, sy0 + loc[1] + tmpl.shape[0] / 2
                else:
                    lost.append(round(t, 3))
            else:
                lost.append(round(t, 3))
        if len(pts) < 20:
            pts = feats(g)
        cx, cy = float(np.clip(cx, 0, W)), float(np.clip(cy, 0, H))
        if t >= next_t:
            out.append({"t": round(t, 3), "x": round((cx - w / 2) / W, 4), "y": round((cy - h / 2) / H, 4), "w": round(w / W, 4), "h": round(h / H, 4)})
            next_t += 1.0 / fps_out
        prev = g
    print(json.dumps({"points": out, "lost": lost[:200], "size": [W0, H0]}))


if __name__ == "__main__":
    main()
