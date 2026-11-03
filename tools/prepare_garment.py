"""prepare_garment.py — turn a product photo into a cut-out garment PNG for FitCheck.

One-time asset preparation (NOT part of the running app, so it does not break
the "no build step" rule). It:
  1. removes the plain light background (flood fill from the image border),
  2. softens the cut edge a little,
  3. fills the transparent pixels with the garment's average colour ("colour bleed"),
     so the 3D shell never shows white background where the photo outline ends,
  4. crops to the garment and saves
       <name>.png          cut-out with transparency (catalog thumbnail)
       <name>-texture.jpg  the same pixels without transparency (3D texture)

Usage (needs Pillow:  pip install pillow):
    python tools/prepare_garment.py photo.jpg assets/garments/my-jacket.png
    python tools/prepare_garment.py photo.jpg out.png --tolerance 28

After that, open the PNG, note the anchor points (pixels) and add them to
data/garments.json — see README "Adding your own garment".
"""
import argparse
from collections import deque

from PIL import Image, ImageFilter


def remove_background(img: Image.Image, tolerance: int) -> Image.Image:
    """Make every pixel connected to the border and close to the border colour transparent."""
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    # Background colour = average of the four corners
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))

    def is_bg(p):
        return max(abs(p[0] - bg[0]), abs(p[1] - bg[1]), abs(p[2] - bg[2])) <= tolerance

    alpha = Image.new("L", (w, h), 255)
    a = alpha.load()
    seen = bytearray(w * h)
    queue = deque()
    for x in range(w):
        queue.append((x, 0))
        queue.append((x, h - 1))
    for y in range(h):
        queue.append((0, y))
        queue.append((w - 1, y))
    while queue:  # breadth-first flood fill (like a BFS over a grid)
        x, y = queue.popleft()
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        if not is_bg(px[x, y]):
            continue
        a[x, y] = 0
        if x > 0: queue.append((x - 1, y))
        if x < w - 1: queue.append((x + 1, y))
        if y > 0: queue.append((x, y - 1))
        if y < h - 1: queue.append((x, y + 1))

    # Soft edge: shrink the mask by 1 px and blur it slightly
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))

    # Colour bleed: background pixels get the garment's average colour (alpha stays 0)
    garment_pixels = [px[x, y] for y in range(0, h, 4) for x in range(0, w, 4) if a[x, y] > 128]
    n = max(1, len(garment_pixels))
    avg = tuple(sum(p[i] for p in garment_pixels) // n for i in range(3))
    filled = Image.composite(rgb, Image.new("RGB", (w, h), avg), alpha.point(lambda v: 255 if v > 8 else 0))

    out = filled.convert("RGBA")
    out.putalpha(alpha)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("src")
    parser.add_argument("dst")
    parser.add_argument("--tolerance", type=int, default=24, help="how far from the background colour still counts as background (0-255)")
    parser.add_argument("--max-size", type=int, default=1400, help="longest side of the output in px")
    args = parser.parse_args()

    img = remove_background(Image.open(args.src), args.tolerance)
    img = img.crop(img.getchannel("A").getbbox())  # crop to the garment
    img.thumbnail((args.max_size, args.max_size))
    img.save(args.dst, optimize=True)
    texture_path = args.dst.rsplit(".", 1)[0] + "-texture.jpg"
    img.convert("RGB").save(texture_path, quality=90)  # colour-bled background, no alpha
    print(f"saved {args.dst} and {texture_path} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
