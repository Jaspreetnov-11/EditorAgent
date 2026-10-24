"""vision2.py - the agent's eyes, v2: one multilingual SigLIP look at every second of a clip (offline after the first
model download), for engine/vision2.mjs.

Runs as a small worker like people.py: one JSON request per line on stdin, one JSON answer per line on stdout, so the
model loads once per agent run. Progress goes to stderr as "PROGRESS <pct> <msg>".

  { "cmd": "analyze", "id", "path", "proxy"?, "dur", "step", "image"?, "keyOnly"?, "out": "<cache>/<id>.json",
    "npy": "<cache>/<id>.npy", "embRel"?, "orig"?: "<the camera file>", "debug"? }
      -> the clip's JSON (also written to `out`; the embeddings go to `npy`, float16, one row per sample):
         { v, model, step, dur, src, rotation, samples: [ { t, size, beauty, sharp, faces, faceArea, text, lab } ], reject,
           colour, emb }   (keyOnly: keyframes only, a keyframe standing for several samples is one sample)
  { "cmd": "text", "lines": ["छत्तीसगढ़ के व्यंजन", "a temple at dawn"], "ids": [...], "dir": "<cache>" }
      -> { "scores": { lineIndex: { id: [ { t, sim } ] } } }   sim = SigLIP similarity z-scored per line over every sample
  { "cmd": "ping" } -> { dev, peakMB, reservedMB }     { "cmd": "quit" }

Why SigLIP multilingual: the VO / lyrics are Hindi; CLIP needed an English translation first and lost meaning on the
way. The same model also judges shot size, beauty and "is this a screen / screenshot", so each frame is embedded once.
Faces: OpenCV YuNet (the one people.py uses). Text: EasyOCR's detector on some frames and its reader on three (slow).
Frames are decoded by FFmpeg at 640 px on the long side (the proxy when there is one).
"""
import json
import os
import re
import subprocess
import sys
import threading
import queue

# the model is normally downloaded already: load it without asking the internet; if it is not there yet, it is
# downloaded on the first load (into Models/hf)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("HF_HOME", os.path.join(ROOT, "Models", "hf"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
MODEL_ID = "google/siglip-base-patch16-256-multilingual"
if os.path.isdir(os.path.join(os.environ["HF_HOME"], "hub", "models--" + MODEL_ID.replace("/", "--"), "snapshots")):
    os.environ["HF_HUB_OFFLINE"] = "1"  # (set before transformers is imported - it reads this once)
MODEL_TAG = "siglip-multilingual"
V = 1
LONG = 640       # px of the long side the frames are read at
BATCH = 32
DET_MAX = 24     # frames per clip the text detector looks at (the rest take the nearest one's answer)
OCR_N = 3        # frames per clip the text reader reads (GPS stamps, screen words)

# zero-shot answers that compete on each frame (worded for SigLIP: short "a photo of" style captions)
SIZES = {
    "wide": ["a wide establishing shot of a landscape", "a wide shot of a place seen from far away", "an aerial drone view of the land"],
    "medium": ["a medium shot of people", "a medium shot of a person from the waist up", "a group of people standing together"],
    "close": ["a close-up of a face", "a close-up portrait of a person", "a close-up shot of an object or food"],
    "xclose": ["an extreme close-up detail", "a macro shot of a tiny detail", "an extreme close-up of an eye or a texture"],
}
GOOD = ["a cinematic film still", "a well composed professional photograph", "a beautiful photo with beautiful light",
        "a stunning travel photograph", "a sharp high quality photo"]
BAD = ["an amateur badly framed photo", "an ugly boring photo", "a blurry out of focus photo", "a dark underexposed photo",
       "a shaky low quality video frame", "a photo of the floor or a blank wall"]
SCREEN = ["a screenshot of a phone screen", "a screen recording of an app", "a screenshot of a website", "a computer screen full of text"]
REAL = ["a photo of a real place", "a video frame of the real world", "a photo of people and things"]
# beauty = sigmoid((good - bad - B0) / BS): fixed (not per clip), so a dull clip stays dull next to a beautiful one
# (fitted on the test projects: good - bad ran -0.014..0.026 over drone footage, YouTube food films and edits)
B0, BS = 0.004, 0.006
SUB_BAND = (0.72, 0.97)  # where burned-in captions sit (fraction of the height)

GPS_WORDS = re.compile(r"\b(lat(itude)?|long(itude)?|gps|map\s*camera|altitude)\b", re.I)
COORD = re.compile(r"\d{1,3}[.,]\d{4,}\s*°?")
DATE = re.compile(r"\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b|\b(19|20)\d{2}[/\-.]\d{1,2}[/\-.]\d{1,2}\b")
TIME = re.compile(r"\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b", re.I)


def progress(p, msg=""):
    print(f"PROGRESS {int(p)} {msg}", file=sys.stderr, flush=True)


def tool(name):
    """FFmpeg / FFprobe on the PATH (as the rest of the engine runs it), else the copy in tools/"""
    import shutil
    if shutil.which(name):
        return name
    exe = os.path.join(ROOT, "tools", "ffmpeg-7.1.1-essentials_build", "bin", name + (".exe" if os.name == "nt" else ""))
    return exe if os.path.exists(exe) else name


FFMPEG, FFPROBE = tool("ffmpeg"), tool("ffprobe")


def probe(file):
    pr = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation:stream_tags=rotate",
                         "-of", "json", file], capture_output=True, text=True, errors="ignore")
    st = (json.loads(pr.stdout or "{}").get("streams") or [{}])[0]
    rot = next((int(float(d.get("rotation", 0))) for d in st.get("side_data_list", []) if "rotation" in d), int(float((st.get("tags") or {}).get("rotate", 0) or 0)))
    return st.get("width", 1920), st.get("height", 1080), rot


def sample_times(dur, step, image):
    if image:
        return [0.0]
    t, out = step / 2, []
    while t < dur - 0.05:
        out.append(round(t, 3))
        t += step
    return out or [round(max(0.0, dur / 2), 3)]


def frames(file, times, image, key_only, np):
    """(t, BGR frame) at the given times, from one FFmpeg pass (fps filter; FFmpeg turns rotated files upright)"""
    w0, h0, rot = probe(file)
    if abs(rot) % 180 == 90:
        w0, h0 = h0, w0
    if w0 >= h0:
        W, H = LONG, max(2, int(round(LONG * h0 / max(1, w0) / 2)) * 2)
    else:
        H, W = LONG, max(2, int(round(LONG * w0 / max(1, h0) / 2)) * 2)
    if image:
        args = ["-i", file, "-frames:v", "1", "-vf", f"scale={W}:{H}"]
    else:
        step = times[1] - times[0] if len(times) > 1 else 1.0
        # camera originals without a proxy: only the keyframes are decoded (3-10x faster, as analyze.mjs does)
        args = (["-skip_frame", "nokey"] if key_only else []) + ["-ss", f"{max(0.0, times[0]):.3f}", "-i", file, "-an", "-sn",
                "-vf", f"fps=1/{step:.4f}:round=near,scale={W}:{H}", "-frames:v", str(len(times))]
    p = subprocess.Popen([FFMPEG, "-hide_banner", "-loglevel", "error", *args, "-pix_fmt", "bgr24", "-f", "rawvideo", "-"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = W * H * 3
    # decoding runs on its own thread, so FFmpeg keeps going while the GPU looks at the last batch
    q = queue.Queue(maxsize=BATCH * 2)

    def read():
        # keyframes only: a keyframe that stands for several samples (long GOP) is one sample, at the middle of them
        held, ts = None, []
        for t in times:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            if key_only and held is not None and buf == held:
                ts.append(t)
                continue
            if held is not None:
                q.put((round(sum(ts) / len(ts), 3), np.frombuffer(held, dtype=np.uint8).reshape(H, W, 3)))
            held, ts = buf, [t]
        if held is not None:
            q.put((round(sum(ts) / len(ts), 3), np.frombuffer(held, dtype=np.uint8).reshape(H, W, 3)))
        q.put(None)
    threading.Thread(target=read, daemon=True).start()
    while True:
        x = q.get()
        if x is None:
            break
        yield x
    p.stdout.close()
    p.wait()
    yield None, rot  # last: the file's rotation metadata


class Eyes:
    def __init__(self):
        import cv2
        import numpy as np
        import torch
        self.cv2, self.np, self.torch = cv2, np, torch
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        self.dtype = torch.float16 if self.dev == "cuda" else torch.float32
        progress(1, "loading the SigLIP model (first run downloads ~1.5 GB)")
        from transformers import AutoModel, AutoTokenizer
        from transformers.utils import logging as hf_logging
        hf_logging.set_verbosity_error()
        self.model = AutoModel.from_pretrained(MODEL_ID, dtype=self.dtype)
        self.tok = AutoTokenizer.from_pretrained(MODEL_ID)
        self.model = self.model.to(self.dev).eval()
        if self.dev == "cpu":
            torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
        det = os.path.join(ROOT, "Models", "face_detection_yunet_2023mar.onnx")
        self.face = cv2.FaceDetectorYN.create(det, "", (LONG, 360), 0.7, 0.3, 5000) if os.path.exists(det) else None
        self.reader = None
        self.cache = {}  # id -> (times, unit embeddings) for "text"
        # every prompt embedded once
        self.P = {}
        for k, v in list(SIZES.items()) + [("good", GOOD), ("bad", BAD), ("screen", SCREEN), ("real", REAL)]:
            self.P[k] = self.embed_text(v)
        self.size_names = list(SIZES)
        self.size_mat = np.stack([self.P[k].mean(0) / np.linalg.norm(self.P[k].mean(0)) for k in self.size_names])
        self.scale = float(self.model.logit_scale.exp().item())
        progress(3, f"SigLIP on {self.dev}")

    # ---- the model ----
    def embed_text(self, texts):
        torch, np = self.torch, self.np
        out = []
        for i in range(0, len(texts), 64):
            x = self.tok(texts[i:i + 64], padding="max_length", max_length=64, truncation=True, return_tensors="pt").to(self.dev)
            with torch.no_grad():
                e = self.model.get_text_features(**x)
            e = (e if torch.is_tensor(e) else e.pooler_output).float()
            out.append((e / e.norm(dim=-1, keepdim=True)).cpu().numpy())
        return np.concatenate(out) if out else np.zeros((0, 768), dtype=np.float32)

    def embed_images(self, imgs):
        """BGR frames -> unit embeddings (SigLIP's own preprocessing: 256x256 squash, (x - 0.5) / 0.5), resized on the GPU"""
        torch, np = self.torch, self.np
        F = torch.nn.functional
        outs = []
        with torch.no_grad():
            for im in imgs:
                x = torch.from_numpy(im[:, :, ::-1].copy()).to(self.dev).permute(2, 0, 1)[None].float() / 255.0
                outs.append(F.interpolate(x, size=(256, 256), mode="bilinear", antialias=True, align_corners=False))
            x = ((torch.cat(outs) - 0.5) / 0.5).to(self.dtype)
            e = self.model.get_image_features(pixel_values=x)
            e = (e if torch.is_tensor(e) else e.pooler_output).float()
            e = e / e.norm(dim=-1, keepdim=True)
        return e.cpu().numpy()

    # ---- one frame's cheap facts ----
    def faces(self, img):
        if self.face is None:
            return []
        h, w = img.shape[:2]
        self.face.setInputSize((w, h))
        _, d = self.face.detect(img)
        return [] if d is None else [x for x in d if x[14] >= 0.8 and min(x[2], x[3]) >= 10]

    def sharp(self, g):
        """Laplacian variance of the sharpest tiles (a shallow-focus close-up is sharp where it matters), 0..1 on a log scale"""
        cv2, np = self.cv2, self.np
        L = cv2.Laplacian(g, cv2.CV_32F)
        h, w = g.shape
        v = [float(L[y * h // 4:(y + 1) * h // 4, x * w // 4:(x + 1) * w // 4].var()) for y in range(4) for x in range(4)]
        var = float(np.percentile(v, 85))
        return float(np.clip((np.log10(var + 1) - 1.3) / 1.5, 0, 1)), var  # var 20 -> 0, 100 -> 0.37, 300 -> 0.7, 630 -> 0.9 (proxies read softer)

    def flat(self, g):
        """share of the frame with no texture at all (screens, UI, end cards are flat; real pictures almost never are)"""
        cv2, np = self.cv2, self.np
        gx = cv2.Sobel(g, cv2.CV_16S, 1, 0, ksize=3)
        gy = cv2.Sobel(g, cv2.CV_16S, 0, 1, ksize=3)
        return float(((np.abs(gx) + np.abs(gy)) < 4).mean())

    def text_boxes(self, img):
        """boxes [x0, y0, x1, y1] as 0..1 where the text detector sees writing"""
        r = self.ocr()
        h, w = img.shape[:2]
        try:
            hz, fr = r.detect(img, canvas_size=LONG, min_size=8, text_threshold=0.7, low_text=0.4)
        except Exception:
            return []
        out = [[b[0] / w, b[2] / h, b[1] / w, b[3] / h] for b in (hz[0] if hz else [])]
        for poly in (fr[0] if fr else []):
            xs, ys = [p[0] for p in poly], [p[1] for p in poly]
            out.append([min(xs) / w, min(ys) / h, max(xs) / w, max(ys) / h])
        return [[max(0.0, min(1.0, v)) for v in b] for b in out]

    def read_text(self, file, t, image, small):
        """words on the frame at t, read at up to 1280 px (stamps are too small to read at 640), and again enlarged on
        its bottom third, where GPS-camera stamps and captions are"""
        np = self.np
        r = self.ocr()
        p = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", *([] if image else ["-ss", f"{t:.3f}"]), "-i", file, "-frames:v", "1",
                            "-vf", "scale='min(1280,iw)':-2", "-f", "image2pipe", "-vcodec", "bmp", "-"], capture_output=True)
        img = self.cv2.imdecode(np.frombuffer(p.stdout, np.uint8), 1) if p.stdout else None
        if img is None:
            img = small
        h = img.shape[0]
        strip = self.cv2.resize(img[int(h * 0.62):], None, fx=1.5, fy=1.5, interpolation=self.cv2.INTER_CUBIC)
        words = []
        for im in (img, strip):
            try:
                words += [str(s) for _, s, c in r.readtext(im) if c >= 0.3]
            except Exception:
                pass
        return " ".join(words)

    def ocr(self):
        if self.reader is None:
            import easyocr
            self.reader = easyocr.Reader(["en"], gpu=self.dev == "cuda", verbose=False)
        return self.reader

    # ---- one clip ----
    def analyze(self, req):
        np, cv2 = self.np, self.cv2
        file = req.get("proxy") if req.get("proxy") and os.path.exists(req["proxy"]) else req["path"]
        if not os.path.exists(file):
            raise FileNotFoundError(f"file not found: {file}")
        image = bool(req.get("image"))
        dur = float(req.get("dur") or 0)
        step = float(req.get("step") or 1.0)
        times = sample_times(dur, step, image)
        key_only = bool(req.get("keyOnly")) and not image
        S, E, flats = [], [], []
        rot = 0
        batch = []
        n = len(times)
        tag = req.get("id", "")
        # frames kept for the text detector / the sideways test (keeping all of a long clip's would take GBs)
        det_at = sorted(set(np.linspace(0, n - 1, min(n, DET_MAX)).round().astype(int).tolist()))
        side_at = sorted(set(np.linspace(0, n - 1, min(n, 12)).round().astype(int).tolist()))
        keep, imgs = set(det_at) | set(side_at), {}

        def flush():
            if not batch:
                return
            E.append(self.embed_images([b[1] for b in batch]))
            for t, img in batch:
                g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                h, w = g.shape
                fs = self.faces(img)
                big = max(fs, key=lambda d: d[2] * d[3]) if len(fs) else None
                sh, var = self.sharp(g)
                lab = cv2.cvtColor(cv2.resize(img, (64, 36 if w >= h else 64)).astype(np.float32) / 255.0, cv2.COLOR_BGR2Lab).reshape(-1, 3).mean(0)
                S.append({"t": t, "faces": len(fs), "faceArea": round(float(big[2] * big[3] / (w * h)), 4) if big is not None else 0.0,
                          "faceH": float(big[3] / h) if big is not None else 0.0, "sharp": round(sh, 3),
                          "lab": [round(float(lab[0]), 1), round(float(lab[1]), 1), round(float(lab[2]), 1)],
                          "std": float(g.std()), "_var": var})
                flats.append(self.flat(g))
                if len(S) - 1 in keep:
                    imgs[len(S) - 1] = img
            batch.clear()
            progress(5 + 75 * len(S) / max(1, n), tag)

        for x in frames(file, times, image, key_only, np):
            if x[0] is None:
                rot = x[1]
                break
            batch.append(x)
            if len(batch) >= BATCH:
                flush()
        flush()
        if not S:
            raise RuntimeError(f"no picture could be read from {os.path.basename(file)}")
        Em = np.concatenate(E)

        # ---- per sample: size, beauty, text ----
        sz = Em @ self.size_mat.T * self.scale
        sz = np.exp(sz - sz.max(1, keepdims=True))
        sz /= sz.sum(1, keepdims=True)
        good = (Em @ self.P["good"].T).mean(1) - (Em @ self.P["bad"].T).mean(1)
        beauty = 1 / (1 + np.exp(-(good - B0) / BS))
        screen = (Em @ self.P["screen"].T).max(1) - (Em @ self.P["real"].T).max(1)
        # text detector on up to DET_MAX frames spread over the clip; the others take the nearest one's answer
        k = len(S)
        det_at = [i for i in det_at if i in imgs] or [0]
        imgs.setdefault(0, None)
        boxes = {i: self.text_boxes(imgs[i]) if imgs[i] is not None else [] for i in det_at}
        tfrac = {i: min(1.0, sum((b[2] - b[0]) * (b[3] - b[1]) for b in bx)) for i, bx in boxes.items()}
        det_arr = np.array(det_at)
        for i, s in enumerate(S):
            j = int(det_arr[np.abs(det_arr - i).argmin()])
            s["text"] = round(float(tfrac[j]), 3)
            p = sz[i].copy()
            # the biggest face says the size best when there is one: face height / frame height
            if s["faces"]:
                fh = s["faceH"]
                prior = np.array([0.6, 0.3, 0.08, 0.02]) if fh < 0.08 else np.array([0.15, 0.6, 0.2, 0.05]) if fh < 0.2 else \
                    np.array([0.02, 0.18, 0.7, 0.1]) if fh < 0.45 else np.array([0.0, 0.05, 0.45, 0.5])
                p = 0.4 * p + 0.6 * prior
            s["size"] = "none" if s["std"] < 6 or s["lab"][0] < 4 else self.size_names[int(p.argmax())]
            s["beauty"] = round(float(beauty[i]), 3)
            s["_screen"] = float(screen[i])
            s["_good"] = float(good[i])
            s["_flat"] = flats[i]

        reject = self.reject(req, file, image, S, boxes, det_at, side_at, imgs)
        lab = np.array([s["lab"] for s in S]).mean(0)
        samples = [{"t": s["t"], "size": s["size"], "beauty": s["beauty"], "sharp": s["sharp"], "faces": s["faces"], "faceArea": s["faceArea"],
                    "text": s["text"], "lab": s["lab"],
                    **({"dbg": [round(s["_good"], 4), round(s["_var"], 1), round(s["_screen"], 4), round(s["_flat"], 3), round(s["faceH"], 3)]} if req.get("debug") else {})} for s in S]
        npy = req.get("npy")
        if npy:
            os.makedirs(os.path.dirname(npy), exist_ok=True)
            np.save(npy, Em.astype(np.float16))
            self.cache[tag] = (np.array([s["t"] for s in S]), Em.astype(np.float32))
        res = {"v": V, "model": MODEL_TAG, "step": step, "dur": dur, "src": "proxy" if file != req["path"] else "original", "rotation": rot,
               "samples": samples, "reject": reject, "colour": {"l": round(float(lab[0]), 1), "a": round(float(lab[1]), 1), "b": round(float(lab[2]), 1)},
               "emb": req.get("embRel")}
        out = req.get("out")
        if out:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out + ".tmp", "w", encoding="utf-8") as f:
                json.dump(res, f, ensure_ascii=False)
            os.replace(out + ".tmp", out)
        if self.dev == "cuda":
            self.torch.cuda.empty_cache()  # (the GPU is shared with renders and the LLM: keep only what the model needs)
        progress(100, tag)
        return res

    def reject(self, req, file, image, S, boxes, det_at, side_at, imgs):
        """clips not to cut into an edit: a screen / screenshot, a GPS-camera stamp, a sideways picture, an earlier
        render (our own captions / end card, or the file is in a renders / output folder), or blurry all through"""
        np = self.np
        k = len(S)
        why = []
        # words: the reader on OCR_N frames that the detector saw text on (the most text first)
        texty = sorted(det_at, key=lambda i: -S[i]["text"])
        read_at = [i for i in texty if S[i]["text"] > 0.002][:OCR_N]
        words = " ".join(self.read_text(file, S[i]["t"], image, imgs[i]) for i in read_at)
        # screen recording / phone screenshot: SigLIP says screen, and the picture is flat and has text
        scr = [s["_screen"] > 0.0 and s["_flat"] > 0.35 and s["text"] > 0.02 for s in S]
        screen = sum(scr) >= max(1, 0.5 * k)
        if screen:
            why.append("looks like a screen recording or a screenshot")
        # GPS / timestamp stamp: coordinates, Lat / Long, "GPS Map Camera", or a date and a time together
        g, c = GPS_WORDS.findall(words), COORD.findall(words)
        gps = bool(re.search(r"gps\s*map", words, re.I)) or len(c) >= 2 or (len(c) >= 1 and bool(g or DATE.search(words))) or \
            (bool(g) and bool(DATE.search(words)) and bool(TIME.search(words)))
        if gps:
            why.append("has a GPS / date stamp burned in")
        # sideways: no upright faces, but faces when the frame is turned a quarter
        sideways = False
        up = sum(1 for s in S if s["faces"])
        if up <= max(1, 0.05 * k):
            idx = [i for i in side_at if imgs.get(i) is not None]
            side = 0
            for i in idx:
                for code in (self.cv2.ROTATE_90_CLOCKWISE, self.cv2.ROTATE_90_COUNTERCLOCKWISE):
                    if len(self.faces(self.cv2.rotate(imgs[i], code))):
                        side += 1
                        break
            # (food / landscape clips have few faces at all: two sideways faces and next to no upright ones is enough)
            sideways = side >= max(2, 0.25 * len(idx)) and side >= 2 * up
        if sideways:
            why.append("the picture is sideways (faces lie on their side)")
        # an earlier render: captions in the subtitle band through most of the clip and an end card, or the file's folder
        folder = re.search(r"[\\/](renders?|output|exports?)[\\/]", req.get("orig") or req["path"], re.I) is not None
        band = [any(b[1] >= SUB_BAND[0] - 0.05 and b[3] <= SUB_BAND[1] + 0.02 and 0.25 < (b[0] + b[2]) / 2 < 0.75 and b[2] - b[0] > 0.12 for b in boxes[i]) for i in det_at]
        caps = len(det_at) >= 6 and sum(band) >= 0.6 * len(det_at)
        tail = S[-max(1, min(3, k // 10)):]
        endcard = k >= 6 and any(s["text"] > 0.03 and s["_flat"] > 0.4 for s in tail)
        render = folder or (caps and endcard)
        if render:
            why.append("is an earlier render (in a renders / output folder)" if folder else "is an earlier render (captions and an end card burned in)")
        blurry = sum(1 for s in S if s["sharp"] < 0.2) >= 0.7 * k
        if blurry:
            why.append("is out of focus or blurred almost all through")
        r = {"screen": screen, "gps": gps, "sideways": sideways, "render": render, "blurry": blurry, "why": "; ".join(why),
             "words": words[:300]}
        return r if why else None

    # ---- words -> moments ----
    def load(self, cid, d):
        np = self.np
        if cid in self.cache:
            return self.cache[cid]
        jf, nf = os.path.join(d, f"{cid}.json"), os.path.join(d, f"{cid}.npy")
        if not (os.path.exists(jf) and os.path.exists(nf)):
            return None
        j = json.load(open(jf, encoding="utf-8"))
        x = (np.array([s["t"] for s in j["samples"]]), np.load(nf).astype(np.float32))
        if len(self.cache) > 400:
            self.cache.pop(next(iter(self.cache)))
        self.cache[cid] = x
        return x

    def text(self, req):
        np = self.np
        lines = [str(s or "") for s in req.get("lines", [])]
        clips = [(cid, self.load(cid, req["dir"])) for cid in req.get("ids", [])]
        clips = [(cid, x) for cid, x in clips if x is not None and len(x[0]) == len(x[1])]
        out = {}
        if not lines or not clips:
            return {"scores": out}
        T = self.embed_text(lines)
        allE = np.concatenate([x[1] for _, x in clips])
        sims = allE @ T.T  # samples x lines
        mu, sd = sims.mean(0), sims.std(0) + 1e-6
        z = (sims - mu) / sd
        for j in range(len(lines)):
            row, o = {}, 0
            for cid, (ts, e) in clips:
                row[cid] = [{"t": round(float(t), 3), "sim": round(float(v), 3)} for t, v in zip(ts, z[o:o + len(ts), j])]
                o += len(ts)
            out[str(j)] = row
        return {"scores": out}


def main():
    # Hindi file names and text: a Windows code page would turn them into "?" (file not found) or stop the worker
    sys.stdin.reconfigure(encoding="utf-8-sig")
    sys.stdout.reconfigure(encoding="utf-8")
    eyes = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get("cmd") == "quit":
                break
            if eyes is None:
                eyes = Eyes()
            if req.get("cmd") == "analyze":
                ans = eyes.analyze(req)
            elif req.get("cmd") == "text":
                ans = eyes.text(req)
            elif req.get("cmd") == "ping":
                import torch
                c = eyes.dev == "cuda"
                ans = {"ok": True, "dev": eyes.dev, "peakMB": round(torch.cuda.max_memory_allocated() / 2**20) if c else 0,
                       "reservedMB": round(torch.cuda.memory_reserved() / 2**20) if c else 0}
            else:
                ans = {"error": "unknown command"}
        except Exception as e:  # one bad clip must not end the worker
            ans = {"error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(ans, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
