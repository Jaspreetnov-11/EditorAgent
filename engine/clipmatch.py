"""clipmatch.py - offline visual understanding with OpenCLIP (no internet after the first model download).

Input JSON (argv[1]):
  { "cacheDir": "...", "media": [ { "id": "...", "frames": [ { "t": 1.5, "path": "f0001.jpg" } ] } ],
    "texts": [ { "id": "s0", "text": "a waterfall in the forest" } ] }
Output JSON (argv[2]):
  { "media": { id: { "times": [...], "quality": [...], "sims": { textId: [...] } } } }

quality = how much a frame looks like a good shot (sharp, well exposed, composed) minus how much it looks like a bad
one (blurry, dark, shaky, floor/wall, black). sims = cosine similarity between each frame and each text (VO line).
Frame embeddings are cached per media id, so re-running the agent on the same footage is fast.
"""
import json
import os
import sys

# the model is normally downloaded already: load it without asking the internet (saves seconds per agent run); if it is
# not there yet, this script runs itself again online once (see main)
if os.environ.get("CLIP_ONLINE") != "1":
    os.environ["HF_HUB_OFFLINE"] = "1"

MODEL, PRETRAINED = "ViT-B-32", "laion2b_s34b_b79k"
GOOD = ["a beautiful sharp well-composed professional photograph", "a vivid cinematic film still", "a clear detailed photo with good lighting"]
BAD = ["a blurry out of focus photo", "a dark underexposed photo", "a shaky motion-blurred frame", "a photo of the floor or a blank wall", "a black screen", "an overexposed washed out photo"]


def progress(p, msg=""):
    print(f"PROGRESS {int(p)} {msg}", file=sys.stderr, flush=True)


def main():
    req = json.load(open(sys.argv[1], encoding="utf-8-sig"))  # tolerate a BOM (Windows tools add one)
    out_path = sys.argv[2]
    import numpy as np
    import torch
    import open_clip
    from PIL import Image

    torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
    progress(1, "loading CLIP model (first run downloads ~600 MB)")
    try:
        model, _, preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED)
    except Exception:
        if os.environ.get("CLIP_ONLINE") == "1":
            raise
        import subprocess
        env = {k: v for k, v in os.environ.items() if k != "HF_HUB_OFFLINE"}
        env["CLIP_ONLINE"] = "1"
        sys.exit(subprocess.call([sys.executable] + sys.argv, env=env))
    tokenizer = open_clip.get_tokenizer(MODEL)
    model.eval()
    # NVIDIA GPU when the CUDA build of PyTorch is installed (several times faster), else the CPU as before
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = model.to(dev)
    amp = (lambda: torch.autocast("cuda", dtype=torch.float16)) if dev == "cuda" else (lambda: __import__("contextlib").nullcontext())
    step = 128 if dev == "cuda" else 32
    progress(3, f"CLIP on {dev}")

    def embed_texts(texts):
        if not texts:
            return np.zeros((0, 512), dtype=np.float32)
        with torch.no_grad(), amp():
            e = model.encode_text(tokenizer(texts).to(dev)).float()
            e = e / e.norm(dim=-1, keepdim=True)
        return e.cpu().numpy()

    # frames are decoded and resized on several threads (PIL releases the GIL), the model runs on the rest
    from concurrent.futures import ThreadPoolExecutor
    pool = ThreadPoolExecutor(max_workers=6)

    def load(f):
        try:
            return preprocess(Image.open(f["path"]).convert("RGB"))
        except Exception:
            return torch.zeros(3, 224, 224)

    cache = req.get("cacheDir")
    if cache:
        os.makedirs(cache, exist_ok=True)
    texts = req.get("texts", [])
    T = embed_texts([t["text"] for t in texts])
    Q = embed_texts(GOOD + BAD)
    qg, qb = Q[: len(GOOD)], Q[len(GOOD):]

    media = req.get("media", [])
    total = sum(len(m["frames"]) for m in media) or 1
    done, result = 0, {}
    for m in media:
        times = [f["t"] for f in m["frames"]]
        cf = os.path.join(cache, f"{m['id']}.npz") if cache else None
        E = None
        if cf and os.path.exists(cf):
            z = np.load(cf)
            if len(z["times"]) == len(times) and np.allclose(z["times"], times, atol=0.01):
                E = z["emb"]
        if E is None:
            embs = []
            for i in range(0, len(m["frames"]), step):
                batch = list(pool.map(load, m["frames"][i:i + step]))
                with torch.no_grad(), amp():
                    e = model.encode_image(torch.stack(batch).to(dev)).float()
                    e = e / e.norm(dim=-1, keepdim=True)
                embs.append(e.cpu().numpy())
                done += len(batch)
                progress(5 + 90 * done / total, m["id"])
            E = np.concatenate(embs) if embs else np.zeros((0, 512), dtype=np.float32)
            if cf:
                np.savez(cf, times=np.array(times), emb=E)
        else:
            done += len(times)
            progress(5 + 90 * done / total, m["id"])
        quality = (E @ qg.T).mean(axis=1) - (E @ qb.T).mean(axis=1) if len(E) else np.zeros(0)
        # (a clip without frames - unreadable file - gets empty lists instead of stopping the whole match)
        sims = (E @ T.T) if len(T) and len(E) else np.zeros((len(E), len(T)))
        result[m["id"]] = {
            "times": times,
            "quality": [round(float(x), 4) for x in quality],
            "sims": {t["id"]: [round(float(x), 4) for x in sims[:, j]] for j, t in enumerate(texts)},
            # what each frame looks like (unit CLIP vectors), so the agent can avoid near-identical shots
            "emb": [[round(float(v), 3) for v in row] for row in E] if req.get("embeddings") else None,
        }
    json.dump({"media": result}, open(out_path, "w", encoding="utf-8"))
    progress(100, "done")


if __name__ == "__main__":
    main()
