"""footage.py - smart footage tools with OpenCLIP (offline after the first model download).

Runs as a small worker: one JSON request per line on stdin, one JSON answer per line on stdout, so the model is
loaded once and every search after the first is instant. Progress goes to stderr as "PROGRESS <pct> <msg>".

  { "cmd": "scan", "cacheDir": "...", "media": [ { "id", "frames": [ { "t", "path" } ] } ] }
      -> { "media": { id: { "tags": [...], "shot": "wide", "scores": {...}, "quality": q } }, "dups": [ [id, id, sim], ... ] }
  { "cmd": "search", "cacheDir": "...", "ids": [...], "q": "a waterfall", "top": 40 }
      -> { "results": [ { "id", "t", "score" } ] }   (score = best frame's similarity to the words)

Frame embeddings are cached per media id in cacheDir/<id>.npz - the same files the agent's clipmatch.py writes, so a
clip the agent has already looked at is not looked at again (and the other way round).
"""
import json
import os
import sys

MODEL, PRETRAINED = "ViT-B-32", "laion2b_s34b_b79k"
GOOD = ["a beautiful sharp well-composed professional photograph", "a vivid cinematic film still", "a clear detailed photo with good lighting"]
BAD = ["a blurry out of focus photo", "a dark underexposed photo", "a shaky motion-blurred frame", "a photo of the floor or a blank wall", "a black screen", "an overexposed washed out photo"]

# zero-shot questions: each group's answers compete with each other on every frame (softmax), averaged over the clip
# (worded and checked on real stock footage: with only two answers CLIP says "drone" / "people" far too easily)
GROUPS = {
    "shot": [("wide", "a wide establishing shot of a landscape, a place or a crowd seen from far away"),
             ("medium", "a medium shot of one person from the waist up"),
             ("close-up", "a close-up of a face"),
             ("detail", "a close-up of hands or a small object")],
    "angle": [("drone", "an aerial drone photo looking down at the land from high in the sky"), ("ground", "a photo of a landscape taken standing on the ground"),
              ("sky", "a photo of the sky and clouds"), ("near", "a photo of something nearby")],
    "people": [("people", "a photo of a person or people"), ("nature", "a photo of nature, water, trees or landscape without people"),
               ("object", "a photo of an object or a building"), ("animal", "a photo of an animal")],
    "crowd": [("crowd", "a large crowd of many people"), ("few", "one or two people")],
    "where": [("indoor", "inside a room, hall or building"), ("outdoor", "outdoors in the open air")],
    "light": [("night", "a photo of a city or street at night with lights in the dark"), ("day", "a photo taken in bright daylight"),
              ("dusk", "a photo at sunset, sunrise or dusk"), ("shade", "a photo in the shade of trees or indoors")],
    "text": [("text", "a screen or poster full of written text"), ("notext", "a photo without any writing")],
}


def progress(p, msg=""):
    print(f"PROGRESS {int(p)} {msg}", file=sys.stderr, flush=True)


class Clip:
    def __init__(self):
        import numpy as np
        import torch
        import open_clip
        from PIL import Image
        self.np, self.torch, self.Image = np, torch, Image
        torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
        progress(1, "loading the picture model (first run downloads ~600 MB)")
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED)
        self.tok = open_clip.get_tokenizer(MODEL)
        self.model.eval()
        # NVIDIA GPU when the CUDA build of PyTorch is installed, else the CPU as before
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = self.model.to(self.dev)
        import contextlib
        self.amp = (lambda: torch.autocast("cuda", dtype=torch.float16)) if self.dev == "cuda" else contextlib.nullcontext
        self.scale = float(self.model.logit_scale.exp().item())
        self.qg, self.qb = self.text(GOOD), self.text(BAD)
        self.groups = {g: ([k for k, _ in v], self.text([t for _, t in v])) for g, v in GROUPS.items()}

    def text(self, texts):
        with self.torch.no_grad(), self.amp():
            e = self.model.encode_text(self.tok(texts).to(self.dev)).float()
            e = e / e.norm(dim=-1, keepdim=True)
        return e.cpu().numpy()

    def frames(self, cache, m, done, total):
        """unit vectors of a clip's frames, from the cache when the same frames were seen before"""
        np = self.np
        times = [f["t"] for f in m["frames"]]
        cf = os.path.join(cache, f"{m['id']}.npz")
        if os.path.exists(cf):
            z = np.load(cf)
            if len(z["times"]) == len(times) and np.allclose(z["times"], times, atol=0.01):
                return z["emb"], times
        embs = []
        for i in range(0, len(m["frames"]), 32):
            batch = []
            for f in m["frames"][i:i + 32]:
                try:
                    batch.append(self.preprocess(self.Image.open(f["path"]).convert("RGB")))
                except Exception:
                    batch.append(self.torch.zeros(3, 224, 224))
            with self.torch.no_grad(), self.amp():
                e = self.model.encode_image(self.torch.stack(batch).to(self.dev)).float()
                e = e / e.norm(dim=-1, keepdim=True)
            embs.append(e.cpu().numpy())
            done[0] += len(batch)
            progress(3 + 90 * done[0] / max(1, total), m["id"])
        E = np.concatenate(embs) if embs else np.zeros((0, 512), dtype=np.float32)
        np.savez(cf, times=np.array(times), emb=E)
        return E, times

    def cached(self, cache, mid):
        cf = os.path.join(cache, f"{mid}.npz")
        if not os.path.exists(cf):
            return None, None
        z = self.np.load(cf)
        return z["emb"], list(z["times"])

    def scan(self, req):
        np = self.np
        cache = req["cacheDir"]
        os.makedirs(cache, exist_ok=True)
        media = [m for m in req["media"] if m.get("frames")]
        total = sum(len(m["frames"]) for m in media)
        done, out, means = [0], {}, {}
        for m in media:
            E, _ = self.frames(cache, m, done, total)
            if not len(E):
                continue
            scores = {}
            for g, (keys, T) in self.groups.items():
                logits = self.scale * (E @ T.T)
                p = np.exp(logits - logits.max(axis=1, keepdims=True))
                p = p / p.sum(axis=1, keepdims=True)
                for k, v in zip(keys, p.mean(axis=0)):
                    scores[k] = round(float(v), 3)
            shot = max(["wide", "medium", "close-up", "detail"], key=lambda k: scores[k])
            tags = [shot]
            if scores["drone"] > 0.6: tags.append("drone")
            if scores["people"] > 0.55:
                tags.append("people")
                if scores["crowd"] > 0.6: tags.append("crowd")
            if scores["indoor"] > 0.65: tags.append("indoor")
            elif scores["outdoor"] > 0.65: tags.append("outdoor")
            if scores["night"] > 0.6: tags.append("night")
            if scores["dusk"] > 0.6: tags.append("sunset")
            if scores["text"] > 0.7: tags.append("text")
            q = float(((E @ self.qg.T).mean(axis=1) - (E @ self.qb.T).mean(axis=1)).mean())
            mv = E.mean(axis=0)
            means[m["id"]] = mv / (np.linalg.norm(mv) or 1)
            out[m["id"]] = {"tags": tags, "shot": shot, "scores": scores, "quality": round(q, 4)}
        # near-identical clips: the average look of the whole clip is almost the same
        ids = list(means)
        dups = []
        if len(ids) > 1:
            M = np.stack([means[i] for i in ids])
            S = M @ M.T
            for a in range(len(ids)):
                for b in range(a + 1, len(ids)):
                    if S[a, b] > 0.965:
                        dups.append([ids[a], ids[b], round(float(S[a, b]), 4)])
        progress(100, "done")
        return {"media": out, "dups": dups}

    def search(self, req):
        np = self.np
        q = self.text([req["q"], f"a photo of {req['q']}"]).mean(axis=0)
        q = q / np.linalg.norm(q)
        res = []
        for mid in req.get("ids", []):
            E, times = self.cached(req["cacheDir"], mid)
            if E is None or not len(E):
                continue
            s = E @ q
            k = int(s.argmax())
            res.append({"id": mid, "t": round(float(times[k]), 2), "score": round(float(s[k]), 4)})
        res.sort(key=lambda r: -r["score"])
        return {"results": res[: int(req.get("top", 40))]}


def main():
    clip = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if clip is None:
                clip = Clip()
            ans = clip.scan(req) if req["cmd"] == "scan" else clip.search(req) if req["cmd"] == "search" else {"error": "unknown command"}
        except Exception as e:  # one bad request must not end the worker
            ans = {"error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(ans) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
