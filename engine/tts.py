"""AI voice-over with Microsoft Edge neural voices (free, needs internet: the text is sent to Microsoft's speech service).

usage:
  python tts.py voices                                  -> JSON list of voices (Hindi / Indian English / English first)
  python tts.py say <text.txt> <voice> <out.mp3> [--rate +0%] [--srt out.srt]
      speaks the text; with --srt also writes subtitles timed from the voice's own word boundaries
"""
import asyncio
import json
import sys

import edge_tts


async def voices():
    vs = await edge_tts.list_voices()
    pref = lambda v: (0 if v["Locale"].startswith("hi-") else 1 if v["Locale"] == "en-IN" else 2 if v["Locale"].startswith("en-") else 3, v["ShortName"])
    out = [{"id": v["ShortName"], "name": v["ShortName"].split("-")[-1].replace("Neural", ""), "locale": v["Locale"], "gender": v["Gender"]} for v in sorted(vs, key=pref)]
    print(json.dumps(out, ensure_ascii=False))


def tc(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


async def say(text_file, voice, out, rate="+0%", srt=None):
    text = open(text_file, encoding="utf-8").read().strip()
    com = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    words = []
    with open(out, "wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                s = chunk["offset"] / 1e7
                words.append((s, s + chunk["duration"] / 1e7, chunk["text"]))
    if srt and words:
        # lines of up to 7 words, broken where the voice pauses (sentence ends); a line ends before the next starts
        lines, cur = [], []
        for i, w in enumerate(words):
            cur.append(w)
            nxt = words[i + 1] if i + 1 < len(words) else None
            if len(cur) >= 7 or not nxt or nxt[0] - w[1] > 0.3:
                lines.append(cur)
                cur = []
        # a lone word cut off by the length limit joins the line before it
        merged = []
        for l in lines:
            if merged and len(l) == 1 and l[0][0] - merged[-1][-1][1] < 0.3:
                merged[-1] = merged[-1] + l
            else:
                merged.append(l)
        lines = merged
        with open(srt, "w", encoding="utf-8") as f:
            for i, l in enumerate(lines, 1):
                end = l[-1][1] + 0.15
                if i < len(lines):
                    end = min(end, lines[i][0][0] - 0.02)
                f.write(f"{i}\n{tc(l[0][0])} --> {tc(end)}\n{' '.join(w[2] for w in l)}\n\n")
    print(json.dumps({"out": out, "words": len(words), "duration": round(words[-1][1], 3) if words else None}))


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] == "voices":
        asyncio.run(voices())
    else:
        opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d
        asyncio.run(say(a[1], a[2], a[3], rate=opt("--rate", "+0%"), srt=opt("--srt")))
