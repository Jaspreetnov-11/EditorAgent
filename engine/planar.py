"""Planar tracking (Phase 22): follow a flat surface - a wall, a banner, a screen, a board - through a shot, so a logo,
picture or video can be stuck onto it in perspective (corner pin), like Mocha.

usage: python planar.py <video> <tStart> <t0> <tEnd> <x0> <y0> <x1> <y1> <x2> <y2> <x3> <y3> [--fps 25]
  the four corners of the surface at t0 (top-left, top-right, bottom-left, bottom-right) as fractions (0..1) of the
  picture; it is tracked forwards to tEnd and backwards to tStart.
prints JSON: {"points": [{"t", "q": [x0, y0, x1, y1, x2, y2, x3, y3]}...], "lost": [t, ...]}  (t = seconds in the file)

How: corner points on the surface (and a little around it) are followed frame to frame with optical flow, checked
forwards and backwards. Every point remembers where it was on the surface in the first frame, so the surface's
perspective (a homography, RANSAC) is always worked out from the first frame - small errors do not add up into drift.
When points are lost (blur, a hand in front) new ones are found on the surface where it now is. A sudden jump of the
corners is not believed: that frame keeps the last good shape (and is reported as lost).
"""
import json
import sys

import cv2
import numpy as np

LK = dict(winSize=(21, 21), maxLevel=4, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))


def frames(cap, t_from, t_to, small):
    """(t, grey) from t_from to t_to"""
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t_from) * 1000)
    out = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if t < t_from - 0.02:
            continue
        if t > t_to + 1e-3:
            break
        out.append((t, small(f)))
    return out


def track(seq, quad0, W, H):
    """seq[0] is the frame the corners were drawn on. -> [(t, quad 4x2 px)], lost times"""
    g0 = seq[0][1]
    mask = np.zeros_like(g0)
    cv2.fillConvexPoly(mask, quad0[[0, 1, 3, 2]].astype(np.int32), 255)
    mask = cv2.erode(mask, np.ones((9, 9), np.uint8))  # (only points well inside: the edge has the background moving past it)

    def feats(g, m):
        p = cv2.goodFeaturesToTrack(g, maxCorners=300, qualityLevel=0.005, minDistance=5, mask=m, blockSize=5)
        return p.reshape(-1, 2) if p is not None else np.empty((0, 2), np.float32)

    cur = feats(g0, mask)          # where the points are now
    ref = cur.copy()               # where they were in the first frame
    Hm = np.eye(3)
    out, lost, prev = [(seq[0][0], quad0.copy())], [], g0
    q_last = quad0.copy()
    for t, g in seq[1:]:
        ok = False
        if len(cur) >= 8:
            p1, st, _ = cv2.calcOpticalFlowPyrLK(prev, g, cur.reshape(-1, 1, 2).astype(np.float32), None, **LK)
            pb, st2, _ = cv2.calcOpticalFlowPyrLK(g, prev, p1, None, **LK)
            keep = (st.ravel() == 1) & (st2.ravel() == 1) & (np.abs(cur - pb.reshape(-1, 2)).max(1) < 1.0)
            cur, ref = p1.reshape(-1, 2)[keep], ref[keep]
            if len(cur) >= 8:
                Hn, inl = cv2.findHomography(ref, cur, cv2.RANSAC, 3.0)
                if Hn is not None and inl is not None and inl.sum() >= 8:
                    inl = inl.ravel().astype(bool)
                    cur, ref = cur[inl], ref[inl]
                    q = cv2.perspectiveTransform(quad0.reshape(-1, 1, 2), Hn).reshape(4, 2)
                    # believe it unless a corner jumped more than a fifth of the picture in one frame
                    if np.abs(q - q_last).max() < 0.2 * max(W, H) and cv2.isContourConvex(q[[0, 1, 3, 2]].astype(np.float32)):
                        Hm, q_last, ok = Hn, q, True
        if not ok:
            lost.append(round(t, 3))
        # new points on the surface where it is now (their first-frame place through the inverse homography)
        if len(cur) < 120:
            m = np.zeros_like(g)
            cv2.fillConvexPoly(m, q_last[[0, 1, 3, 2]].astype(np.int32), 255)
            m = cv2.erode(m, np.ones((9, 9), np.uint8))
            if len(cur):
                for x, y in cur.astype(int):
                    cv2.circle(m, (int(x), int(y)), 5, 0, -1)
            new = feats(g, m)
            if len(new):
                try:
                    back = cv2.perspectiveTransform(new.reshape(-1, 1, 2).astype(np.float64), np.linalg.inv(Hm)).reshape(-1, 2)
                    cur, ref = np.vstack([cur, new]), np.vstack([ref, back.astype(np.float32)])
                except np.linalg.LinAlgError:
                    pass
        out.append((t, q_last.copy()))
        prev = g
    return out, lost


def main():
    a = sys.argv[1:]
    path, ts, t0, te = a[0], float(a[1]), float(a[2]), float(a[3])
    c = [float(v) for v in a[4:12]]
    fps_out = float(a[a.index("--fps") + 1]) if "--fps" in a else 25.0
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print(json.dumps({"error": "cannot open video"}))
        return
    cap.set(cv2.CAP_PROP_POS_MSEC, t0 * 1000)
    ok, f = cap.read()
    if not ok:
        print(json.dumps({"error": "cannot read the frame at the playhead"}))
        return
    H0, W0 = f.shape[:2]
    k = min(1.0, 960.0 / W0)  # work at 960 wide at most
    small = lambda fr: cv2.cvtColor(cv2.resize(fr, None, fx=k, fy=k, interpolation=cv2.INTER_AREA) if k < 1 else fr, cv2.COLOR_BGR2GRAY)
    W, H = int(round(W0 * k)), int(round(H0 * k))
    quad0 = np.array(c, np.float64).reshape(4, 2) * [W, H]

    fwd = frames(cap, t0, te, small)
    if not fwd:
        print(json.dumps({"error": "no frames after the playhead"}))
        return
    res, lost = track(fwd, quad0, W, H)
    if t0 - ts > 0.05:
        back = frames(cap, ts, t0, small)[::-1]
        if back and abs(back[0][0] - fwd[0][0]) > 0.02:
            back = [fwd[0]] + back  # (start from the drawn frame)
        rb, lb = track(back, quad0, W, H)
        res = rb[::-1][:-1] + res
        lost += lb
    # thin out to fps_out (always keep the first and the last)
    pts, last_t = [], -1e9
    for i, (t, q) in enumerate(res):
        if t - last_t >= 1.0 / fps_out - 1e-3 or i == len(res) - 1:
            pts.append({"t": round(t, 3), "q": [round(float(v), 4) for v in (q / [W, H]).ravel()]})
            last_t = t
    print(json.dumps({"points": pts, "lost": sorted(lost)[:300], "size": [W0, H0]}))


if __name__ == "__main__":
    main()
