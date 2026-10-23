# Premiere Pro effects vs the Limelight editor

What an editor coming from Premiere Pro finds in the Effects panel here, folder by folder. Written before the
"Premiere effects" work (2026-10-23), round 2 the same day (the ones first left out) and kept as the record of what was added, what already existed under another
name, and what was left out and why.

Legend: **have** = was already in the editor · **added** = added in this round · **mapped** = Premiere's effect is
covered by another part of the editor · **skip** = not added, with the reason.

Where things live: video effects `public/js/effects.js` (`VFX`), transitions `public/js/model.js` (`TRANSITIONS`) and
`public/js/fx.js` (custom xfade shapes + the monitor's live look of a transition), colour `engine/color.mjs` /
`public/js/colormath.js` (the Color page), clip audio effects `public/js/audioeffects.js` (`AFX`), track clean-up
`public/js/audiofx.js`. The render is `engine/render2.mjs` (FFmpeg); the monitor previews with CSS / SVG filters, a
canvas (`pix`) or, for the rest, Accurate preview (the render's own FFmpeg filters).

Python / OpenCV (`engine/pyfx.py`, already installed with the editor's AI tools: Python, numpy, opencv-python): Paint
Bucket, Brush Strokes and Rolling Shutter Repair run on the shot's own frames before it is rendered (first in its effect
stack); Morph Cut makes its frames from the two shots in the V1 join. They show in Accurate preview and renders. A render
that uses them goes to a helper PC only when that PC has OpenCV (`pickHelper` need `cv2`); otherwise the editor makes it.

Keyframes: clip effect parameters are not keyframable in this editor (only Motion, Opacity, Volume and crop position
are - `KEYABLE` in model.js). The new effects follow the existing ones and are static per clip; time windows (Labs
`from` / `to`) and masks work on them like on every effect. Keyframing effect parameters is a follow-up of its own.

## Video Effects

### Adjust
| Premiere | Here |
|---|---|
| Extract | **added** `extract` (colorlevels / lutyuv band to white) |
| Levels | **added** `levels` (input / output black + white, gamma) |
| Lighting Effects | **added** `lighting` (one spotlight: centre, radius, intensity, ambient) - one light, not five |
| ProcAmp | **added** `procamp` |
| Auto Color / Auto Contrast / Auto Levels (Obsolete) | **added** `autolevels` (FFmpeg `normalize`, mode select) |
| Shadow/Highlight (Obsolete) | **added** `shadowhl` (shadows lifted, highlights pulled down); the Color page has the full wheels |
| Convolution Kernel (Obsolete) | **added** `convkernel` (3 x 3 grid, scale, offset - FFmpeg `convolution`) |

### Blur & Sharpen
| Premiere | Here |
|---|---|
| Gaussian Blur | **have** `blur` |
| Directional Blur | **have** `dblur` |
| Sharpen | **have** `sharpen` |
| Unsharp Mask | **added** `unsharp` |
| Reduce Interlace Flicker | **added** `flicker` (vertical-only blur) |
| Camera Blur / Channel Blur (Obsolete) | **added** `camerablur` (a disc-like blur), `channelblur` (red / green / blue each its own blur) |
| Compound Blur (Obsolete) | **mapped** Gaussian blur with a mask on the effect (the blur map Premiere takes from a second layer) |

### Channel
| Premiere | Here |
|---|---|
| Invert | **have** `invert` |
| Solid Composite | **added** `solidcomp` (solid colour over the picture, opacity) |
| Arithmetic | **added** `arith` (add / subtract / multiply / min / max per channel) |
| Blend | **added** `blendfx` - blends the layer with everything below it (Crossfade, Color only, Tint only, Darken, Lighten, Multiply, Screen, Overlay, Difference), in the final pass |
| Calculations, Compound Arithmetic | **mapped** the Blend effect and Opacity > Blend Mode (the same layer-on-layer arithmetic) |
| Set Matte | **mapped** Opacity mask / track matte (the transparency taken from another shape) |

### Color Correction
| Premiere | Here |
|---|---|
| Lumetri Color | **mapped** the Color page (wheels, curves, LUTs, HSL) - not repeated as an effect |
| ASC CDL | **added** `ascdl` (slope / offset / power per channel, saturation) |
| Brightness & Contrast | **have** `bricon` |
| Change Color | **added** `changecolor` (hue / lightness / saturation shift of one colour) |
| Change to Color | **added** `changetocolor` |
| Channel Mixer | **added** `chanmix` |
| Color Balance | **added** `colorbalance` (shadows / midtones / highlights RGB - FFmpeg `colorbalance`) |
| Color Balance (HLS) | **added** `colorbalancehls` |
| Equalize | **added** `equalize` (FFmpeg `histeq`) |
| Leave Color | **have** `leavecolor` |
| Tint | **have** `tint` |
| Video Limiter / Broadcast Colors | **added** `limiter` (legal-range clamp) |

### Distort
| Premiere | Here |
|---|---|
| Lens Distortion | **have** `lens` |
| Mirror | **have** `mirror` (left half reflected) |
| Offset | **have** `offset` |
| Corner Pin | **have** `cornerpin` |
| Wave Warp | **have** `wave` |
| Warp Stabilizer | **have** `warpstab` (vid.stab, two passes) |
| Magnify | **added** `magnify` |
| Spherize | **added** `spherize` |
| Twirl | **added** `twirl` |
| Transform | **added** `transform` (position, scale, rotation, skew, opacity - inside the effect stack, before Motion) |
| Turbulent Displace | **added** `turbulent` - smooth sine turbulence, not After Effects' fractal noise |
| Rolling Shutter Repair | **added** `rollingshutter` (Python / OpenCV: each line moved back by its share of the frame's motion, measured by optical flow; whole frame or band by band) |
| Bend (Obsolete) | **mapped** Wave Warp (the same bend along a direction) |

### Generate
| Premiere | Here |
|---|---|
| 4-Color Gradient | **added** `grad4` (four corners) |
| Ramp | **added** `ramp` (linear / radial, two colours) |
| Circle | **added** `circle` |
| Ellipse | **added** `ellipse` |
| Checkerboard | **added** `checker` |
| Grid | **added** `grid` |
| Lens Flare | **added** `flare` - a glow and three ghosts along the flare line, not Adobe's lens models |
| Cell Pattern | **added** `cellpattern` (Bubbles: distance to the nearest jittered cell point, moving) |
| Lightning | **added** `lightning` (a bolt start -> end, bent by three sines that jump to new shapes several times a second, with glow) |
| Paint Bucket | **added** `paintbucket` (Python / OpenCV flood fill from the point, tolerance, feather, fill or stroke) |
| Eyedropper Fill | **added** `eyedropper` (the average colour around a point, every frame, laid over the picture) |
| Write-on | **added** `writeon` (the brush moves start -> end in the given time; on the picture, or revealing it) - a straight stroke, since effect keyframes are not there yet |

### Image Control
| Premiere | Here |
|---|---|
| Black & White | **have** `bw` |
| Color Balance (RGB) | **added** `cbrgb` |
| Color Pass | **mapped** Leave Color (`leavecolor`) - the same effect |
| Color Replace | **added** `colorreplace` |
| Gamma Correction | **added** `gamma` |

### Immersive Video
| Premiere | Here |
|---|---|
| VR Projection | **added** `vrproj` (a flat view into 360 footage: pan, tilt, roll, field of view - FFmpeg `v360`) |
| VR Rotate Sphere | **added** `vrrotate` |
| VR Plane to Sphere | **added** `vrplane` (a flat shot laid on the sphere, black around) |
| VR Blur, VR Glow, VR Sharpen, VR De-Noise, VR Color Gradients, VR Chromatic Aberrations, VR Digital Glitch, VR Fractal Noise | **mapped** the normal Gaussian Blur, Glow, Sharpen, Median, Ramp, RGB split, Glitch cut effect, Turbulent Displace - their VR versions only wrap the seam |

### Keying
| Premiere | Here |
|---|---|
| Ultra Key | **mapped** Green screen (chroma key) `chromakey` |
| Color Key | **added** `colorkey` (RGB distance key - FFmpeg `colorkey`) |
| Luma Key | **added** `lumakey` |
| Track Matte Key | **mapped** opacity masks (`clip.omask`) and track blend modes |

| Four / Eight / Sixteen-Point Garbage Matte | **mapped** shape masks on the clip / effect |
| Remove Matte | **added** `despill` (Spill Suppressor: the green / blue cast on the edges taken out) |
| Alpha Adjust | **added** `alphaadjust` (opacity, ignore / invert alpha, mask only - after the keys) |
| Image Matte Key, Difference Matte, Blue Screen Key, Non Red Key, RGB Difference Key (Obsolete) | **mapped** Color Key / Green screen (Blue Screen, Non Red, RGB Difference are colour keys) and opacity masks (Image / Difference Matte take a second picture) |
### Noise & Grain
| Premiere | Here |
|---|---|
| Noise | **added** `noise` (colour or mono) - Film grain `grain` was already there too |
| Median | **added** `median` |
| Dust & Scratches | **added** `dust` (median with a threshold, mixed back where the change is small) - approximate |
| Noise HLS / Noise HLS Auto | **added** `noisehls` (lightness and colour noise amounts) |
| Noise Alpha | **added** `noisealpha` (random holes in the layer's transparency, new each frame - V2 layers) |

### Obsolete
Everything Adobe marks Obsolete is listed in its own folder above; the useful ones were added (Auto Levels family).

### Perspective
| Premiere | Here |
|---|---|
| Basic 3D | **have** `basic3d` |
| Bevel Edges | **added** `bevel` (lit top / left, shaded bottom / right) |
| Drop Shadow | **added** `dropshadow` - on the layer's outline after Motion (a white frame moved by the same Motion is its transparency); V1: on the black around it, V2: on the shots below |
| Radial Shadow | **added** `radialshadow` (the outline thrown away from a point light) |
| Bevel Alpha | **added** `bevelalpha` (the outline's edge lit and shaded) |

### Stylize
| Premiere | Here |
|---|---|
| Alpha Glow | **mapped** Glow `glow` |
| Mosaic | **have** `pixelate` |
| Strobe Light | **have** `strobe` |
| Color Emboss | **added** `coloremboss` |
| Emboss | **added** `emboss` |
| Find Edges | **added** `findedges` |
| Posterize | **added** `posterize` |
| Replicate | **added** `replicate` |
| Solarize | **added** `solarize` |
| Threshold | **added** `threshold` |
| Texturize | **added** `texturize` (canvas / brick / burlap relief, lit from the top left) |
| Roughen Edges | **added** `roughen` (the edge eaten away along a ragged, optionally moving line) |
| Brush Strokes | **added** `brushstrokes` (Python / OpenCV: edge-keeping smoothing, strokes along the angle, stroke texture) |

### Time
| Premiere | Here |
|---|---|
| Echo | **have** `echo` |
| Posterize Time | **have** `posterizetime` |

### Transform
| Premiere | Here |
|---|---|
| Crop | **have** `crop` |
| Horizontal Flip / Vertical Flip | **have** `fliph` / `flipv` |
| Edge Feather | **added** `edgefeather` (edges fade to black) |
| Auto Reframe | **mapped** 🎯 Follow faces (crop position keyframes) and the reel reframing |
| Horizontal Hold | **added** `hhold` (the picture skewed and wrapped) |
| Vertical Hold | **added** `vhold` (the picture rolling) |
| Camera View (Obsolete) | **mapped** Basic 3D |

### Transition (effects)
| Premiere | Here |
|---|---|
| Linear Wipe | **added** `linwipe` |
| Radial Wipe | **added** `radwipe` |
| Venetian Blinds | **added** `blinds` |
| Block Dissolve | **added** `blockdiss` |
| Gradient Wipe | **added** `gradwipe` (built-in gradient layers: linear, radial, diamond, clouds, or the shot's own brightness) |

These are static (no effect keyframes here); put them on a Labs time window or use the real transitions below.

### Utility
| Premiere | Here |
|---|---|
| Cineon Converter | **added** `cineon` (log to linear, black / white points) |

### Video
| Premiere | Here |
|---|---|
| Timecode | **added** `timecode` (burnt-in source timecode) |
| Clip Name | **added** `clipname` |
| Simple Text | **mapped** titles |
| SDR Conform | **added** `sdrconform` (HDR10 / HLG to Rec.709: zscale to linear light, tone-mapped) |

## Video Transitions

| Premiere folder | Premiere | Here |
|---|---|---|
| Dissolve | Cross Dissolve, Dip to Black, Dip to White, Film Dissolve | **have** `fade`, `fadeblack`, `fadewhite`, `fadegrays` |
| Dissolve | Additive Dissolve | **added** `adddissolve` |
| Dissolve | Non-Additive Dissolve | **added** `nonadddissolve` |
| Dissolve | Morph Cut | **added** `morphcut` (Python / OpenCV: the outgoing frame flows into the incoming one by optical flow both ways - for jump cuts in interviews; no face tracking) |
| Iris | Iris Box, Iris Round | **have** `rectcrop`, `circleopen` / `circlecrop` |
| Iris | Iris Cross | **added** `iriscross` |
| Iris | Iris Diamond | **added** `irisdiamond` |
| Slide | Push | **have** `slideleft` / `slideright` / `slideup` / `slidedown` |
| Slide | Slide | **have** `coverleft`; **added** `coverright`, `coverup`, `coverdown` |
| Slide | Split | **have** `vertopen` / `horzopen`; **added** `horzclose` |
| Slide | Center Split | **added** `centersplit` |
| Slide | Band Slide | **added** `bandslide` |
| Wipe | Wipe, Barn Doors, Radial Wipe | **have** `wipeleft` etc., `vertopen`, `radial` |
| Wipe | Band Wipe | **added** `bandwipe` |
| Wipe | Checker Wipe | **added** `checkerwipe` |
| Wipe | CheckerBoard | **added** `checkerboard` |
| Wipe | Clock Wipe | **added** `clockwipe` |
| Wipe | Inset | **added** `inset` |
| Wipe | Pinwheel | **added** `pinwheel` |
| Wipe | Random Blocks | **added** `randomblocks` |
| Wipe | Venetian Blinds | **added** `venetian` |
| Wipe | Wedge Wipe | **added** `wedgewipe` |
| Wipe | Gradient Wipe | **added** `gradientwipe` (a clouds gradient) |
| Wipe | Spiral Boxes | **added** `spiralboxes` (8 x 6 boxes round the outside ring, then inwards) |
| Wipe | Zig-Zag Blocks | **added** `zigzag` |
| Wipe | Random Wipe | **added** `randomwipe` |
| Wipe | Paint Splatter | **added** `paintsplatter` |
| Zoom | Cross Zoom | **mapped** `zoomin` (Zoom in) |
| 3D Motion | Flip Over | **added** `flipover` (flat squeeze, no perspective) |
| 3D Motion | Cube Spin | **added** `cubespin` (two faces turning, the far side of each smaller) |
| Page Peel | Page Turn | **added** `pageturn` (the page folds over from the right; its back is the shot mirrored and paler) |
| Page Peel | Page Peel | **added** `pagepeel` (the same from the bottom-right corner, along the diagonal) |
| Immersive Video | VR transitions | **mapped** the normal transitions (on 360 footage they only differ at the seam) |

The new ones are FFmpeg `xfade` built-ins or `xfade=transition=custom` expressions (fx.js `XFADE_EXPR`). The monitor
now also draws wipes, irises and slides live (fx.js `trLive`) instead of showing every transition as a dissolve.

## Audio Effects

Already complete before this round (`public/js/audioeffects.js`), in Premiere's folders: Amplitude and Compression
(Amplify, Channel Mixer, Channel Volume, DeEsser, Dynamics, Dynamics Processing, Hard Limiter, Multiband Compressor,
Single-band Compressor, Tube-modeled Compressor), Delay and Echo (Analog Delay, Delay, Multitap Delay), Filter and EQ
(Bandpass, Bass, FFT Filter, Graphic Equalizer 10 / 20 / 30, Highpass, Lowpass, Notch Filter, Parametric Equalizer,
Scientific Filter, Simple Notch Filter, Simple Parametric EQ, Treble), Modulation (Chorus/Flanger, Flanger, Phaser),
Noise Reduction/Restoration (Automatic Click Remover, DeHummer, DeNoise, DeReverb), Reverb (Convolution, Studio,
Surround), Special (Distortion, Fill Left with Right, Fill Right with Left, GuitarSuite, Invert, Loudness Meter,
Loudness Radar, Mastering, Swap Channels, Vocal Enhancer), Stereo Imagery (Stereo Expander), Time and Pitch (Pitch
Shifter), Basic (Balance, Mute, Volume).

| Premiere | Here |
|---|---|
| Adaptive Noise Reduction (Obsolete) | **added** `adaptivenr` (FFmpeg `afftdn` with noise tracking) |
| Panner - Ambisonics, Binauralizer - Ambisonics | **skip** - ambisonic (360) audio is not mixed here |

## Audio Transitions

| Premiere | Here |
|---|---|
| Constant Gain, Constant Power, Exponential Fade | **have** (`ATRANS`, Audio transitions › Crossfade) |
