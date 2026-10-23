# Premiere Pro effects vs the Limelight editor

What an editor coming from Premiere Pro finds in the Effects panel here, folder by folder. Written before the
"Premiere effects" work (2026-10-23) and kept as the record of what was added, what already existed under another
name, and what was left out and why.

Legend: **have** = was already in the editor · **added** = added in this round · **mapped** = Premiere's effect is
covered by another part of the editor · **skip** = not added, with the reason.

Where things live: video effects `public/js/effects.js` (`VFX`), transitions `public/js/model.js` (`TRANSITIONS`) and
`public/js/fx.js` (custom xfade shapes + the monitor's live look of a transition), colour `engine/color.mjs` /
`public/js/colormath.js` (the Color page), clip audio effects `public/js/audioeffects.js` (`AFX`), track clean-up
`public/js/audiofx.js`. The render is `engine/render2.mjs` (FFmpeg); the monitor previews with CSS / SVG filters, a
canvas (`pix`) or, for the rest, Accurate preview (the render's own FFmpeg filters).

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
| Shadow/Highlight (Obsolete) | **mapped** Color page (shadows / highlights wheels) |
| Convolution Kernel (Obsolete) | **skip** - a 3x3 number grid nobody uses; Sharpen / Emboss / Find Edges cover the uses |

### Blur & Sharpen
| Premiere | Here |
|---|---|
| Gaussian Blur | **have** `blur` |
| Directional Blur | **have** `dblur` |
| Sharpen | **have** `sharpen` |
| Unsharp Mask | **added** `unsharp` |
| Reduce Interlace Flicker | **added** `flicker` (vertical-only blur) |
| Camera Blur / Channel Blur / Compound Blur (Obsolete) | **skip** - Gaussian blur covers Camera Blur; Compound Blur needs a second layer as the blur map |

### Channel
| Premiere | Here |
|---|---|
| Invert | **have** `invert` |
| Solid Composite | **added** `solidcomp` (solid colour over the picture, opacity) |
| Arithmetic | **added** `arith` (add / subtract / multiply / min / max per channel) |
| Blend, Calculations, Compound Arithmetic, Set Matte | **skip** - each takes a second layer as input; use a track blend mode (Opacity > Blend mode) or an opacity mask |

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
| Rolling Shutter Repair | **skip** - no FFmpeg filter re-times scan lines; needs optical flow per row |
| Bend (Obsolete) | **skip** - Wave Warp covers it |

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
| Cell Pattern | **skip** - Voronoi cells per pixel in an FFmpeg expression are far too slow to render |
| Lightning | **skip** - procedural animated bolts; no FFmpeg equivalent, would be a fake |
| Paint Bucket | **skip** - a flood fill from a point; FFmpeg has no flood fill |
| Eyedropper Fill | **skip** - Solid Composite with a picked colour gives the same result |
| Write-on | **skip** - an animated brush stroke; use a graphic / Motion title instead |

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
| VR Blur, VR Glow, VR Projection, VR Rotate Sphere, ... | **skip** - 360 / VR footage is not edited here |

### Keying
| Premiere | Here |
|---|---|
| Ultra Key | **mapped** Green screen (chroma key) `chromakey` |
| Color Key | **added** `colorkey` (RGB distance key - FFmpeg `colorkey`) |
| Luma Key | **added** `lumakey` |
| Track Matte Key | **mapped** opacity masks (`clip.omask`) and track blend modes |
| Alpha Adjust | **mapped** clip Opacity |
| Four / Eight / Sixteen-Point Garbage Matte | **mapped** shape masks on the clip / effect |
| Image Matte Key, Difference Matte, Remove Matte, Blue Screen Key, Non Red Key, RGB Difference Key (Obsolete) | **skip** - covered by the keys above, or need a second picture as the matte |

### Noise & Grain
| Premiere | Here |
|---|---|
| Noise | **added** `noise` (colour or mono) - Film grain `grain` was already there too |
| Median | **added** `median` |
| Dust & Scratches | **added** `dust` (median with a threshold, mixed back where the change is small) - approximate |
| Noise HLS / Noise HLS Auto | **added** `noisehls` (lightness and colour noise amounts) |
| Noise Alpha | **skip** - noise in the alpha channel; clips here are opaque before Motion |

### Obsolete
Everything Adobe marks Obsolete is listed in its own folder above; the useful ones were added (Auto Levels family).

### Perspective
| Premiere | Here |
|---|---|
| Basic 3D | **have** `basic3d` |
| Bevel Edges | **added** `bevel` (lit top / left, shaded bottom / right) |
| Drop Shadow | **skip** - effects run on the full frame before Motion, so a shadow would fall outside the picture; titles / graphics have their own shadow |
| Bevel Alpha, Radial Shadow | **skip** - need a picture with transparent parts (alpha); same reason |

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
| Brush Strokes, Texturize, Roughen Edges | **skip** - painterly / texture-map effects with no FFmpeg filter; a geq imitation would look nothing like them |

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
| Horizontal Hold / Vertical Hold, Camera View (Obsolete) | **skip** - Offset covers the hold effects; Camera View is Basic 3D |

### Transition (effects)
| Premiere | Here |
|---|---|
| Linear Wipe | **added** `linwipe` |
| Radial Wipe | **added** `radwipe` |
| Venetian Blinds | **added** `blinds` |
| Block Dissolve | **added** `blockdiss` |
| Gradient Wipe | **skip** - needs a second layer as the gradient |

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
| SDR Conform | **skip** - HDR footage is not handled by the editor's pipeline |

## Video Transitions

| Premiere folder | Premiere | Here |
|---|---|---|
| Dissolve | Cross Dissolve, Dip to Black, Dip to White, Film Dissolve | **have** `fade`, `fadeblack`, `fadewhite`, `fadegrays` |
| Dissolve | Additive Dissolve | **added** `adddissolve` |
| Dissolve | Non-Additive Dissolve | **added** `nonadddissolve` |
| Dissolve | Morph Cut | **skip** - face-tracked optical-flow morphing; no FFmpeg equivalent |
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
| Wipe | Gradient Wipe | **skip** - needs a gradient picture chosen by the user |
| Wipe | Paint Splatter, Spiral Boxes, Random Wipe, Zig-Zag Blocks | **skip** - Random Blocks / Checker Wipe cover the look; the exact patterns are Adobe's |
| Zoom | Cross Zoom | **mapped** `zoomin` (Zoom in) |
| 3D Motion | Flip Over | **added** `flipover` (flat squeeze, no perspective) |
| 3D Motion | Cube Spin | **skip** - needs a real 3D projection of two faces; a squeeze would be a fake |
| Page Peel | Page Peel, Page Turn | **skip** - curled-page 3D rendering; no FFmpeg equivalent |
| Immersive Video | VR transitions | **skip** - no 360 footage |

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
