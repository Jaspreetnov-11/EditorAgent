"""✨ AI Enhance (like Topaz): Real-ESRGAN (BSD-3, tools/models) cleans noise and compression, brings back detail and
can upscale - frame by frame on the GPU. A new file of the clip's piece is written (its sound copied); the editor puts
it on the timeline in place of the piece.

  python engine/enhance.py <src> <t0> <t1> <out.mp4> <srcW> <srcH> <fps> <outW> <outH> [--model fast|detail] [--denoise 0..1]

fast   realesr-general-x4v3 (+ its -wdn twin: --denoise blends them, 1 = clean, 0 = keep the grain); quick
detail RealESRGAN_x4plus: more detail, slower
The picture goes into the model at its own size (at most the output size) and comes out 4x, then is scaled to the
output size - so a 1080p shot also comes out cleaner and sharper at 1080p. Prints [i/n] progress.
"""
import os, subprocess, sys
import numpy as np
import torch
from torch import nn
import torch.nn.functional as F

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MD = os.path.join(ROOT, 'tools', 'models')


class SRVGGNetCompact(nn.Module):  # the "realesr-general" network (Real-ESRGAN, BSD-3)
    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList([nn.Conv2d(num_in_ch, num_feat, 3, 1, 1), nn.PReLU(num_parameters=num_feat)])
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1)); self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body: out = layer(out)
        return self.upsampler(out) + F.interpolate(x, scale_factor=self.upscale, mode='nearest')


class RDB(nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.conv1 = nn.Conv2d(nf, gc, 3, 1, 1); self.conv2 = nn.Conv2d(nf + gc, gc, 3, 1, 1); self.conv3 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1)
        self.conv4 = nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1); self.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1); self.lrelu = nn.LeakyReLU(0.2, True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x)); x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1))); x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1))); x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.rdb1, self.rdb2, self.rdb3 = RDB(nf, gc), RDB(nf, gc), RDB(nf, gc)

    def forward(self, x): return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x


class RRDBNet(nn.Module):  # RealESRGAN_x4plus (Real-ESRGAN, BSD-3)
    def __init__(self, nf=64, nb=23, gc=32):
        super().__init__()
        self.conv_first = nn.Conv2d(3, nf, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(nf, gc) for _ in range(nb)])
        self.conv_body = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(nf, nf, 3, 1, 1); self.conv_up2 = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_hr = nn.Conv2d(nf, nf, 3, 1, 1); self.conv_last = nn.Conv2d(nf, 3, 3, 1, 1); self.lrelu = nn.LeakyReLU(0.2, True)

    def forward(self, x):
        feat = self.conv_first(x); feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode='nearest')))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode='nearest')))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


def weights(name):
    d = torch.load(os.path.join(MD, name), map_location='cpu', weights_only=True)
    return d.get('params_ema') or d.get('params') or d


def load(kind, denoise):
    if kind == 'detail':
        net = RRDBNet(); net.load_state_dict(weights('RealESRGAN_x4plus.pth'), strict=True)
    else:
        net = SRVGGNetCompact()
        a = weights('realesr-general-x4v3.pth')
        wdn = os.path.join(MD, 'realesr-general-wdn-x4v3.pth')
        if denoise < 1 and os.path.exists(wdn):  # (Real-ESRGAN's own way: blend the two nets' weights)
            b = weights('realesr-general-wdn-x4v3.pth')
            a = {k: denoise * a[k] + (1 - denoise) * b[k] for k in a}
        net.load_state_dict(a, strict=True)
    return net


def run_tiled(net, x, tile=480, pad=16):
    _, _, h, w = x.shape
    if h <= tile and w <= tile: return net(x)
    out = torch.zeros((1, 3, h * 4, w * 4), dtype=x.dtype, device=x.device)
    for y0 in range(0, h, tile):
        for x0 in range(0, w, tile):
            y1, x1 = min(h, y0 + tile), min(w, x0 + tile)
            py0, px0, py1, px1 = max(0, y0 - pad), max(0, x0 - pad), min(h, y1 + pad), min(w, x1 + pad)
            o = net(x[:, :, py0:py1, px0:px1])
            out[:, :, y0 * 4:y1 * 4, x0 * 4:x1 * 4] = o[:, :, (y0 - py0) * 4:(y0 - py0 + y1 - y0) * 4, (x0 - px0) * 4:(x0 - px0 + x1 - x0) * 4]
    return out


def main():
    a = sys.argv[1:]
    opt = {'--model': 'fast', '--denoise': '0.5', '--ffmpeg': 'ffmpeg'}
    for k in list(opt):
        if k in a: i = a.index(k); opt[k] = a[i + 1]; del a[i:i + 2]
    src, t0, t1, out = a[0], float(a[1]), float(a[2]), a[3]
    sw, sh, fps, ow, oh = int(a[4]), int(a[5]), float(a[6]), int(a[7]) // 2 * 2, int(a[8]) // 2 * 2
    ff, kind, denoise = opt['--ffmpeg'], opt['--model'], max(0.0, min(1.0, float(opt['--denoise'])))
    dur = max(0.05, t1 - t0); n = max(1, round(dur * fps))
    # into the model at the shot's own size (smaller than the output: upscaled; same size: 4x and back down, which keeps
    # every detail - feeding it half size made a clean 1080p shot look smooth / plastic); a bigger shot at the output size
    k = min(1.0, oh / sh, ow / sw)
    if kind == 'detail': k = min(k, 720 / max(1, min(sw, sh)))  # (the big model at 1080p would take many minutes a second)
    iw, ih = max(16, int(sw * k) // 2 * 2), max(16, int(sh * k) // 2 * 2)

    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    net = load(kind, denoise).eval().to(dev)
    half = dev == 'cuda'
    if half: net = net.half()

    rd = subprocess.Popen([ff, '-hide_banner', '-loglevel', 'error', '-ss', f'{t0:.3f}', '-i', src, '-t', f'{dur:.3f}',
                           '-vf', f'scale={iw}:{ih}:flags=area', '-r', f'{fps}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    wr = subprocess.Popen([ff, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{ow}x{oh}', '-r', f'{fps}', '-i', '-',
                           '-ss', f'{t0:.3f}', '-t', f'{dur:.3f}', '-i', src, '-map', '0:v', '-map', '1:a?',
                           '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
                           '-movflags', '+faststart', '-shortest', out], stdin=subprocess.PIPE)
    size, i = iw * ih * 3, 0
    with torch.no_grad():
        while True:
            buf = rd.stdout.read(size)
            if len(buf) < size: break
            x = torch.from_numpy(np.frombuffer(buf, np.uint8).reshape(ih, iw, 3).copy()).to(dev).permute(2, 0, 1)[None]
            x = x.half() / 255.0 if half else x.float() / 255.0
            y = run_tiled(net, x, tile=480 if kind == 'fast' else 256)
            y = F.interpolate(y.float(), size=(oh, ow), mode='bicubic', align_corners=False, antialias=True) if (y.shape[2], y.shape[3]) != (oh, ow) else y.float()
            wr.stdin.write((y.clamp(0, 1)[0].permute(1, 2, 0) * 255).round().byte().cpu().numpy().tobytes())
            i += 1
            if i % 4 == 0 or i == n: print(f'[{i}/{n}]', flush=True)
    rd.wait(); wr.stdin.close(); code = wr.wait()
    if code != 0 or i == 0: sys.exit(f'Could not write the enhanced video (frames read: {i})')


if __name__ == '__main__':
    main()
