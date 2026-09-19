"""Build an annotated frame strip for the recall-history capture.

Bands come from the capture script's own numbered screenshots rather than from
frames sampled out of the GIF. Each of those screenshots is taken at a moment the
script ASSERTED, so a band label states a checkpoint that was verified rather than
a timestamp guessed after the fact. The original strips sampled the GIF and
labelled bands with frame index and elapsed time; those labels cannot be
reproduced honestly without re-deriving the timeline, and the checkpoint name is
the thing a reviewer actually needs.

Each band is a label bar above the bottom slice of the frame -- the composer and
the readout panel, which is where every asserted value is legible.

Usage:
  python3 build_recall_strip.py <mode> <screenshots-dir> <out.png>
    mode  fixed | prefix
"""
import sys
from PIL import Image, ImageDraw, ImageFont

WIDTH = 800
LABEL_H = 19
CROP_H = 200
BAND_H = LABEL_H + CROP_H

LABEL_BG = (245, 197, 66)
LABEL_FG = (26, 26, 26)
FONT_PATH = "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"

# (screenshot suffix, checkpoint label, outcome per mode)
BANDS = [
    ("01", "before", "start -- composer empty, transcript holds only the earlier prompt", None),
    ("02", "typed", "typed -- composer holds the prompt that is about to be lost", None),
    ("03", "lost", "submitted, then reconnect -- refreshSlot replaced the transcript; prompt nowhere on the page", None),
    ("04", "after-abort", "past the 10s send abort -- composer still empty, nothing restored it", None),
    ("05", "first-arrowup", "first ArrowUp", {
        "fixed": "recovers the LOST prompt",
        "prefix": "yields the EARLIER prompt; the lost one is unreachable",
    }),
    ("06", "second-arrowup", "second ArrowUp", {
        "fixed": "steps back to the earlier prompt",
        "prefix": "still does not reach the lost prompt",
    }),
]


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    mode, src_dir, out_path = sys.argv[1], sys.argv[2].rstrip("/"), sys.argv[3]
    if mode not in ("fixed", "prefix"):
        print(f"mode must be fixed or prefix (got {mode!r})")
        return 2

    font = ImageFont.truetype(FONT_PATH, 11)
    strip = Image.new("RGB", (WIDTH, BAND_H * len(BANDS)), (0, 0, 0))
    draw = ImageDraw.Draw(strip)

    for i, (num, suffix, label, outcomes) in enumerate(BANDS):
        path = f"{src_dir}/{num}-{mode}-{suffix}.png"
        frame = Image.open(path).convert("RGB")
        scaled = frame.resize((WIDTH, round(frame.height * WIDTH / frame.width)), Image.LANCZOS)
        band_top = i * BAND_H

        draw.rectangle([0, band_top, WIDTH, band_top + LABEL_H - 1], fill=LABEL_BG)
        text = f"{mode}  {num}  {label}"
        if outcomes:
            text = f"{mode}  {num}  {label} -- {outcomes[mode]}"
        draw.text((6, band_top + 4), text, fill=LABEL_FG, font=font)

        strip.paste(scaled.crop((0, scaled.height - CROP_H, WIDTH, scaled.height)),
                    (0, band_top + LABEL_H))
        print(f"  band {num}: {path}")

    strip.save(out_path)
    print(f"wrote {out_path} ({strip.width}x{strip.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
