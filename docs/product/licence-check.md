# Licence check - every AI model, tool and font in Limelight Editor (for selling it)

Checked 2026-10-28 against what the code actually loads (engine/*.py, engine/*.mjs, public/). Licences are as known on
that date - **read each licence text again before the first sale** (model owners do change them), and keep a copy of
each one in the product's `licences/` folder.

Legend: **OK** = may be used in a paid product as is (keep its notice) · **CONDITIONS** = allowed if we do what the
note says · **CHANGE** = must be replaced or licensed before selling.

## AI models

| What | Used for | Licence | Paid product | Note |
|---|---|---|---|---|
| OpenCLIP ViT-B-32 `laion2b_s34b_b79k` | smart search, archive, footage tags | MIT (code and weights) | OK | keep the notice |
| Google SigLIP `siglip-base-patch16-256-multilingual` | Agent v2 vision (Hindi search) | Apache-2.0 | OK | keep the notice |
| YuNet face detection / SFace recognition (OpenCV zoo) | follow faces, blur faces, people | MIT / Apache-2.0 | CONDITIONS | recognising people is personal data: customers need consent / a lawful reason (India's DPDP Act) - say so in the terms; a switch to turn face recognition off |
| EasyOCR | text read off the footage | Apache-2.0 | OK | |
| Whisper large-v3 / turbo via faster-whisper | transcripts, captions, reels | MIT | OK | |
| LaMa `big-lama` | AI Fill | Apache-2.0 | OK | |
| Real-ESRGAN | AI Enhance | BSD-3-Clause | OK | |
| Chatterbox Multilingual (Resemble AI) | VoiceVerse, same-voice dubbing | MIT | CONDITIONS | cloning a voice needs that person's consent - a consent tick when a voice is saved, and the terms say so; keep its audio watermark on |
| Demucs `htdemucs` | voice / music apart | MIT | OK | |
| Qwen2.5-7B-Instruct (GGUF) | Agent's understanding of the brief | Apache-2.0 | OK | **only the 7B**: other Qwen sizes (3B, 72B) have different licences - do not swap without checking |
| Depth-Anything-V2 **Small** | VFX depth / fog | Apache-2.0 | OK | **only Small**: Base and Large are CC-BY-NC-4.0 (no paid use) - never switch to them |
| torchvision DeepLabV3 (MobileNetV3 / ResNet101) | AI Roto subject matte | BSD-3-Clause | OK | |
| BiRefNet (`Models/birefnet`) | cut-outs | MIT | OK | |

## Services the editor calls

| What | Used for | Paid product | Note |
|---|---|---|---|
| Microsoft Edge "Read aloud" voices (`edge-tts`) | free AI voice-over | **CHANGE** | an unofficial use of Edge's service, not licensed for a product - replace with VoiceVerse (ours) or Azure Speech (paid, licensed) before selling |
| ElevenLabs | voice-over (optional) | CONDITIONS | each customer uses their own paid ElevenLabs key; never ours |
| Anthropic Claude (Agent, Assistant, help chat, QC spelling) | AI | **CHANGE** | today it runs through a Claude Code sign-in - a product needs the Claude API with commercial terms: each customer's own API key, or ours under a business agreement |
| Pexels / Pixabay | stock footage | CONDITIONS | each customer's own API key; show "from Pexels / Pixabay" where results appear (their API rules) |
| YouTube / Facebook / Instagram publish | publishing | CONDITIONS | each customer connects their own Google / Meta app; Meta needs app review for public use |

## Tools bundled with the editor

| What | Licence | Paid product | Note |
|---|---|---|---|
| FFmpeg (gyan.dev "essentials" build, with x264 / x265) | **GPL-3.0** | CONDITIONS | allowed if we ship its licence and offer its source; H.264 / HEVC encoding can need patent licences (MPEG LA / Access Advance) in some countries - ask a lawyer, or use the GPU encoders (NVENC) and an LGPL FFmpeg build |
| Gyroflow | GPL-3.0 | CONDITIONS | ship it as a separate program with its licence and source link (as now - it is run as its own process) |
| llama.cpp | MIT | OK | |
| Node.js, acme-client and the npm packages | MIT / Apache / BSD | OK | `npm ls` + a licence list in the product |
| Python, PyTorch, OpenCV, numpy | BSD / Apache | OK | |
| Microsoft WebView2 (Limelight Editor.exe) | Microsoft redistributable | OK | |

## Fonts

| What | Paid product | Note |
|---|---|---|
| **Helvetica Now** (public/css/fonts, served to every browser) | **CHANGE** | a Monotype font: serving it to other devices and putting it inside software needs a web / app licence from Monotype - buy that licence, or use Inter (already in the editor, SIL OFL) for the product |
| Inter, Google Fonts | OK | SIL Open Font License / Apache |

## Before the first sale - the list

1. Replace Edge voices with VoiceVerse / Azure Speech.
2. Claude through the API (customer's key or a business agreement), not a sign-in.
3. Helvetica Now: buy the app / web licence or switch the product to Inter.
4. FFmpeg and Gyroflow: licence texts and source links in the product; ask about H.264 / HEVC patents.
5. Consent ticks: saving a cloned voice, face recognition (with an off switch).
6. A `licences/` folder and an "About > Licences" page listing everything above.
