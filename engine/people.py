"""people.py - who is in the footage, and what is written in it. Used by 🧠 Smart scan (People and Text), 🔎 Find and the
✨ Agent ("CM sahab bol rahe hain" -> a shot where the CM's face is seen).

Runs as a small worker like footage.py: one JSON request per line on stdin, one JSON answer per line on stdout, so the
models load once. Progress goes to stderr as "PROGRESS <pct> <msg>".

  { "cmd": "look", "cacheDir": "...", "cropDir": "...", "faces": true, "ocr": true,
    "det": "Models/face_detection_yunet_2023mar.onnx", "rec": "Models/face_recognition_sface_2021dec.onnx",
    "media": [ { "id", "file", "duration", "image": false, "ocr": 2, "rotate": false } ],   (ocr: frames to read, 0 = none)
    "library": [ { "id", "name", "embs": [[128 numbers], ...] } ] }
  -> { "people": [ { "key", "name", "libId", "count", "media": { id: [t, ...] }, "thumb": "<crop file>", "emb": [128] } ],
       "text": { id: [ { "t", "text", "conf" } ] } }

Faces: OpenCV YuNet finds them, SFace turns each into 128 numbers; faces whose numbers are close are one person
(the same person across clips and across projects - the named ones are kept in Library/people). Text: EasyOCR,
a Hindi and an English reader on a few frames of each clip (the Hindi reader turns English into
junk and the other way round, so each keeps only its own script). Frames are decoded by FFmpeg at 960 px wide (the agent's own frames are
224 px - too small to know a face or read a banner). Per clip results are cached in cacheDir/<id>.npz / <id>.ocr.json.
Install: pip install "opencv-python-headless<5" easyocr
"""
import json
import os
import re
import subprocess
import sys

W = 960
SAME = 0.40      # SFace cosine: same person above this (OpenCV's own threshold is 0.363)
KNOWN = 0.42     # a group is a named person from the library above this
MIN_FACE = 36    # px at 960 wide - smaller faces cannot be told apart
VER = 4          # bump when what is cached changes
DEVA = re.compile(r"[ऀ-ॣॱ-ॿ]{2}")   # two Devanagari letters (not digits / danda)
LATIN = re.compile(r"[A-Za-z]{3}")


def progress(p, msg=""):
    print(f"PROGRESS {int(p)} {msg}", file=sys.stderr, flush=True)


def sample_times(duration, image, n_max=40):
    if image:
        return [0.0]
    step = max(1.0, duration / n_max)
    t, out = step / 2, []
    while t < duration - 0.05:
        out.append(round(t, 3))
        t += step
    return out or [round(duration / 2, 3)]


def frames(file, times, image, np):
    """BGR frames at the given times (one FFmpeg pass with the fps filter; seeking per frame is slow on camera files)"""
    pr = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation",
                         "-of", "json", file], capture_output=True, text=True)
    st = (json.loads(pr.stdout or "{}").get("streams") or [{}])[0]
    w0, h0 = st.get("width", 1920), st.get("height", 1080)
    if next((abs(int(d.get("rotation", 0))) for d in st.get("side_data_list", []) if "rotation" in d), 0) == 90:
        w0, h0 = h0, w0
    H = max(2, int(round(W * h0 / max(1, w0) / 2)) * 2)
    if image:
        args = ["-i", file, "-frames:v", "1", "-vf", f"scale={W}:{H}"]
    else:
        step = times[1] - times[0] if len(times) > 1 else 1.0
        args = ["-ss", f"{max(0.0, times[0]):.3f}", "-i", file, "-an", "-vf", f"fps=1/{step:.4f},scale={W}:{H}", "-frames:v", str(len(times))]
    p = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", *args, "-pix_fmt", "bgr24", "-f", "rawvideo", "-"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = W * H * 3
    for t in times:
        buf = p.stdout.read(size)
        if len(buf) < size:
            break
        yield t, np.frombuffer(buf, dtype=np.uint8).reshape(H, W, 3)
    p.stdout.close()
    p.wait()


class Looker:
    def __init__(self, req):
        import cv2
        import numpy as np
        self.cv2, self.np = cv2, np
        self.det = self.rec = self.reader = None
        if req.get("faces") and os.path.exists(req.get("det", "")) and os.path.exists(req.get("rec", "")):
            self.det = cv2.FaceDetectorYN.create(req["det"], "", (W, 540), 0.7, 0.3, 5000)
            self.rec = cv2.FaceRecognizerSF.create(req["rec"], "")

    def read_text(self, img, rotate):
        """words on a frame: Devanagari from the Hindi reader, Latin words from the English one; digits / symbols alone are dropped"""
        if self.reader is None:
            progress(1, "loading the text reader (first run downloads ~100 MB)")
            import easyocr
            import torch
            gpu = torch.cuda.is_available()
            self.reader = (easyocr.Reader(["hi", "en"], gpu=gpu, verbose=False), easyocr.Reader(["en"], gpu=gpu, verbose=False))
        kw = {"rotation_info": [90, 270]} if rotate else {}
        out = []
        for reader, ok in ((self.reader[0], DEVA), (self.reader[1], LATIN)):
            for _, s, c in reader.readtext(img, **kw):
                s = " ".join(str(s).split())
                if c >= 0.4 and ok.search(s) and s not in out:
                    out.append((s, float(c)))
        return out

    def one(self, m, cache, want_faces, want_ocr):
        """faces (times, boxes, embeddings) and text of one clip, from the cache when the file has not changed"""
        np = self.np
        key = f"{VER}:{m['file']}:{os.path.getsize(m['file'])}:{int(os.path.getmtime(m['file']))}"
        fz, fo = os.path.join(cache, f"{m['id']}.npz"), os.path.join(cache, f"{m['id']}.ocr.json")
        faces = text = None
        if os.path.exists(fz):
            z = np.load(fz, allow_pickle=False)
            if str(z["key"]) == key:
                faces = {"t": z["t"], "box": z["box"], "emb": z["emb"], "crop": z["crop"]}
        if os.path.exists(fo):
            o = json.load(open(fo, encoding="utf-8"))
            if o.get("key") == key:
                text = o["text"]
        need_f = want_faces and self.det is not None and faces is None
        need_o = want_ocr and text is None and m.get("ocr", 2) > 0
        if not need_f and not need_o:
            return faces, text
        times = sample_times(m.get("duration") or 0, m.get("image"))
        # text: a few frames spread over the clip (a banner or a logo stays on screen; reading is slow)
        n_o = max(1, int(m.get("ocr", 2)))
        ocr_at = set(times[len(times) // (2 * n_o):: max(1, len(times) // n_o)][:n_o]) if need_o else set()
        T, B, E, C, found = [], [], [], [], []
        for t, img in frames(m["file"], times, m.get("image"), np):
            if need_f:
                h, w = img.shape[:2]
                self.det.setInputSize((w, h))
                _, dets = self.det.detect(img)
                for d in (dets if dets is not None else []):
                    if min(d[2], d[3]) < MIN_FACE or d[14] < 0.8:
                        continue
                    al = self.rec.alignCrop(img, d)
                    g = self.cv2.cvtColor(al, self.cv2.COLOR_BGR2GRAY)
                    if g.mean() < 45 or self.cv2.Laplacian(g, self.cv2.CV_64F).var() < 8:
                        continue  # too dark or too soft to know who it is (stage light, motion blur)
                    e = self.rec.feature(al).flatten()
                    T.append(t)
                    B.append([d[0] / w, d[1] / h, d[2] / w, d[3] / h, float(d[14])])
                    E.append(e / (np.linalg.norm(e) or 1))
                    C.append(al)  # the 112 px face SFace looked at - it is the picture in the People list
            if t in ocr_at:
                found += [{"t": t, "text": s, "conf": round(c, 3)} for s, c in self.read_text(img, m.get("rotate"))]
        if need_f:
            faces = {"t": np.array(T, dtype=np.float32), "box": np.array(B, dtype=np.float32).reshape(-1, 5),
                     "emb": np.array(E, dtype=np.float32).reshape(-1, 128), "crop": np.array(C, dtype=np.uint8).reshape(-1, 112, 112, 3)}
            np.savez(fz, key=np.array(key), **faces)
        if need_o:
            text = found
            json.dump({"key": key, "text": text}, open(fo, "w", encoding="utf-8"), ensure_ascii=False)
        return faces, text

    def look(self, req):
        np, cv2 = self.np, self.cv2
        cache = req["cacheDir"]
        os.makedirs(cache, exist_ok=True)
        media = [m for m in req["media"] if os.path.exists(m["file"])]
        for m in req["media"]:
            if m not in media:
                print(f"{m['id']}: file not found: {m['file']}", file=sys.stderr, flush=True)
        allf, text = {}, {}
        for k, m in enumerate(media):
            progress(3 + 80 * k / max(1, len(media)), m["id"])
            try:
                f, o = self.one(m, cache, bool(req.get("faces")), bool(req.get("ocr")))
            except Exception as e:  # one unreadable clip must not stop the rest
                print(f"{m['id']}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
                continue
            if f is not None and len(f["t"]):
                allf[m["id"]] = f
            if o:
                text[m["id"]] = o
        progress(85, "grouping faces")
        people = self.group(allf, req.get("library") or [], {m["id"]: m for m in media}, req.get("cropDir"))
        progress(100, "done")
        return {"people": people, "text": text}

    def group(self, allf, library, media, crop_dir):
        """faces -> people: greedy grouping on the running average of each group, best (biggest, surest) faces first"""
        np = self.np
        rows = [(mid, i, f["t"][i], f["box"][i], f["emb"][i]) for mid, f in allf.items() for i in range(len(f["t"]))]
        rows.sort(key=lambda r: -(r[3][2] * r[3][3] * r[3][4]))
        groups = []  # { sum, n, rows }
        for r in rows:
            best, bs = None, SAME
            for g in groups:
                c = g["sum"] / (np.linalg.norm(g["sum"]) or 1)
                s = float(c @ r[4])
                if s > bs:
                    best, bs = g, s
            if best is None:
                groups.append({"sum": r[4].copy(), "rows": [r]})
            else:
                best["sum"] += r[4]
                best["rows"].append(r)
        lib = [(p, np.array(p["embs"], dtype=np.float32).reshape(-1, 128)) for p in library if p.get("embs")]
        out = []
        for g in groups:
            c = g["sum"] / (np.linalg.norm(g["sum"]) or 1)
            hit, hs = None, KNOWN
            for p, L in lib:
                s = float((L @ c).max()) if len(L) else 0
                if s > hs:
                    hit, hs = p, s
            # a face seen once or twice in one clip is too often a poster, a passer-by or a wrong detection - unless named
            if not hit and len(g["rows"]) < 3 and len({r[0] for r in g["rows"]}) < 2:
                continue
            mm = {}
            for mid, _, t, _, _ in g["rows"]:
                mm.setdefault(mid, set()).add(round(float(t), 2))
            out.append({"name": hit["name"] if hit else None, "libId": hit["id"] if hit else None, "score": round(hs, 3) if hit else None,
                        "count": len(g["rows"]), "media": {k: sorted(v) for k, v in mm.items()}, "emb": [round(float(x), 5) for x in c],
                        "_best": g["rows"][0]})
        out.sort(key=lambda p: (-(p["libId"] is not None), -p["count"]))
        for k, p in enumerate(out):
            p["key"] = p["libId"] or f"p{k + 1}"
            mid, i, _, _, _ = p.pop("_best")
            p["thumb"] = None
            if crop_dir:
                os.makedirs(crop_dir, exist_ok=True)
                p["thumb"] = os.path.join(crop_dir, f"{p['key']}.jpg")
                self.cv2.imwrite(p["thumb"], self.cv2.resize(allf[mid]["crop"][i], (160, 160), interpolation=self.cv2.INTER_CUBIC))
        return out


def main():
    # Hindi file names and text: a Windows code page would turn them into "?" (file not found) or stop the worker
    sys.stdin.reconfigure(encoding="utf-8-sig")
    sys.stdout.reconfigure(encoding="utf-8")
    looker = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if looker is None or (req.get("faces") and looker.det is None):
                looker = Looker(req)
            ans = looker.look(req) if req["cmd"] == "look" else {"error": "unknown command"}
        except Exception as e:  # one bad request must not end the worker
            ans = {"error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(ans, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
