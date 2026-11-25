"""Inspect an illustration and optionally preview its centered circular avatar crop."""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--circle-preview", type=Path, help="Write a 160 px PNG for visual review")
    args = parser.parse_args()
    if args.circle_preview is not None and args.circle_preview.resolve() == args.image.resolve():
        parser.error("the preview path must differ from the source image")

    with Image.open(args.image) as source:
        rgba = source.convert("RGBA")
        alpha_min, alpha_max = rgba.getchannel("A").getextrema()
        print(f"{source.format} {source.width}x{source.height}, alpha={alpha_min}..{alpha_max}")

    if args.circle_preview is None:
        return

    thumb = ImageOps.fit(rgba, (160, 160), method=Image.Resampling.LANCZOS)
    mask = Image.new("L", thumb.size)
    ImageDraw.Draw(mask).ellipse((0, 0, thumb.width - 1, thumb.height - 1), fill=255)
    circle = Image.new("RGBA", thumb.size)
    circle.paste(thumb, mask=mask)

    args.circle_preview.parent.mkdir(parents=True, exist_ok=True)
    circle.save(args.circle_preview, format="PNG")
    print(args.circle_preview)


if __name__ == "__main__":
    main()
