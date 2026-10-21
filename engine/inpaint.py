"""✨ Content-aware fill for video: boxes drawn over a logo / burnt-in text are filled in by LaMa (big-lama, Apache-2.0,
tools/models/big-lama.pt) on the GPU, frame by frame, and a new file of that piece of the clip is written (its sound
copied from the source). The editor then puts that file on the timeline in place of the clip's piece.

  python engine/inpaint.py <src> <t0> <t1> <out.mp4> <boxes.json> <width> <height> <fps> [--ffmpeg ffmpeg]

boxes.json: [{x, y, w, h}] as fractions of the picture (as the file plays, i.e. after rotation). Prints [i/n] progress.
Only the area around the boxes goes through the model (sharper and much faster than the whole frame), and the filled
part is blended in with a soft edge.
"""
import json, os, subprocess, sys
import numpy as np
import cv2
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, 'tools', 'models', 'big-lama.pt')


def main():
    a = sys.argv[1:]
    ff = 'ffmpeg'
    if '--ffmpeg' in a:
        i = a.index('--ffmpeg'); ff = a[i + 1]; del a[i:i + 2]
    src, t0, t1, out, boxes_file, W, H, fps = a[0], float(a[1]), float(a[2]), a[3], a[4], int(a[5]), int(a[6]), float(a[7])
    boxes = json.load(open(boxes_file, encoding='utf-8'))
    dur = max(0.05, t1 - t0)
    n = max(1, round(dur * fps))

    # the mask: the boxes, a little bigger (text edges, glow, shadow)
    mask = np.zeros((H, W), np.uint8)
    for b in boxes:
        x0, y0 = int(max(0, b['x']) * W), int(max(0, b['y']) * H)
        x1, y1 = int(min(1, b['x'] + b['w']) * W), int(min(1, b['y'] + b['h']) * H)
        if x1 > x0 and y1 > y0: mask[y0:y1, x0:x1] = 255
    if not mask.any(): sys.exit('No box to fill')
    # (a box drawn by hand is often a few pixels short of the text's edge - the model then grows the rest back from it)
    grow = max(6, int(min(W, H) * 0.012))
    mask = cv2.dilate(mask, np.ones((grow * 2 + 1, grow * 2 + 1), np.uint8))
    ys, xs = np.nonzero(mask)
    bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    # the area the model sees: the boxes and as much around them again (it fills from what it sees)
    m = int(max(48, 0.75 * max(bx1 - bx0, by1 - by0)))
    cx0, cy0, cx1, cy1 = max(0, bx0 - m), max(0, by0 - m), min(W, bx1 + m), min(H, by1 + m)
    cw, ch = cx1 - cx0, cy1 - cy0
    k = min(1.0, 768 / max(cw, ch))  # (a bigger area is shrunk for the model, the result scaled back)
    mw, mh = max(8, int(round(cw * k / 8)) * 8), max(8, int(round(ch * k / 8)) * 8)
    crop_mask = mask[cy0:cy1, cx0:cx1]
    mt = torch.from_numpy((cv2.resize(crop_mask, (mw, mh), interpolation=cv2.INTER_NEAREST) > 127).astype(np.float32))[None, None]
    soft = cv2.GaussianBlur(crop_mask, (0, 0), max(1.5, grow * 0.8)).astype(np.float32)[..., None] / 255.0

    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    model = torch.jit.load(MODEL, map_location=dev); model.eval()
    mt = mt.to(dev)

    rd = subprocess.Popen([ff, '-hide_banner', '-loglevel', 'error', '-ss', f'{t0:.3f}', '-i', src, '-t', f'{dur:.3f}',
                           '-vf', f'scale={W}:{H}', '-r', f'{fps}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
    wr = subprocess.Popen([ff, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', f'{fps}', '-i', '-',
                           '-ss', f'{t0:.3f}', '-t', f'{dur:.3f}', '-i', src, '-map', '0:v', '-map', '1:a?',
                           '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
                           '-movflags', '+faststart', '-shortest', out], stdin=subprocess.PIPE)
    size, i, B, batch = W * H * 3, 0, 8, []

    def flush():
        imgs = [f[cy0:cy1, cx0:cx1] for f in batch]
        x = torch.from_numpy(np.stack([cv2.resize(c, (mw, mh), interpolation=cv2.INTER_AREA)[..., ::-1] for c in imgs]).copy()).to(dev)
        x = x.permute(0, 3, 1, 2).float() / 255.0
        with torch.no_grad():
            y = model(x, mt.expand(len(imgs), -1, -1, -1))
        y = (y.clamp(0, 1) * 255).byte().permute(0, 2, 3, 1).cpu().numpy()
        for f, c, r in zip(batch, imgs, y):
            r = cv2.resize(r[..., ::-1], (cw, ch), interpolation=cv2.INTER_CUBIC).astype(np.float32)
            f[cy0:cy1, cx0:cx1] = (c.astype(np.float32) * (1 - soft) + r * soft).clip(0, 255).astype(np.uint8)
            wr.stdin.write(f.tobytes())

    while True:
        buf = rd.stdout.read(size)
        if len(buf) < size: break
        batch.append(np.frombuffer(buf, np.uint8).reshape(H, W, 3).copy())
        i += 1
        if len(batch) == B:
            flush(); batch = []
            print(f'[{i}/{n}]', flush=True)
    if batch: flush(); print(f'[{i}/{n}]', flush=True)
    rd.wait(); wr.stdin.close(); code = wr.wait()
    if code != 0 or i == 0: sys.exit(f'Could not write the filled video (frames read: {i})')


if __name__ == '__main__':
    main()
