from PIL import Image, ImageDraw, ImageFont
import os

out = r"D:\Documents\deepseek-harness\default-workspace\legado-ios\webapp\icons"
appicon_out = r"D:\Documents\deepseek-harness\default-workspace\legado-ios\ios\LegadoMobile\Assets.xcassets\AppIcon.appiconset"
os.makedirs(out, exist_ok=True)
PAPER = (246, 247, 245, 255)
INK = (20, 23, 26, 255)
SEAL = (192, 68, 46, 255)
RULE = (214, 219, 215, 255)


def font(sz):
    for p in [r"C:\Windows\Fonts\simsun.ttc", r"C:\Windows\Fonts\msyh.ttc"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
    return ImageFont.load_default()


for size in (180, 192, 512, 1024):
    img = Image.new("RGBA", (size, size), PAPER)
    d = ImageDraw.Draw(img)
    s = size

    # the gutter of an open book: one hairline down the middle, cropped by the edge
    d.line([(s / 2, 0), (s / 2, s)], fill=RULE, width=max(1, s // 256))

    # the character, large and confident
    f = font(int(s * 0.62))
    txt = "阅"
    bb = d.textbbox((0, 0), txt, font=f)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    d.text((s / 2 - w / 2 - bb[0], s * 0.47 - h / 2 - bb[1]), txt, font=f, fill=INK)

    # a chop: small solid vermilion square, the way a reader marks a page
    seal = s * 0.105
    sx, sy = s - seal - s * 0.115, s - seal - s * 0.115
    d.rectangle([sx, sy, sx + seal, sy + seal], fill=SEAL)
    # a paper-coloured notch so it reads as a stamp, not a blob
    notch = seal * 0.26
    d.rectangle([sx + notch, sy + notch, sx + seal * 0.52, sy + seal * 0.52], fill=PAPER)

    img.save(os.path.join(out, f"icon-{size}.png"))
    print("wrote", f"icon-{size}.png")

# iOS App Store icon: 1024x1024, fully opaque, no alpha channel
import shutil
src = os.path.join(out, "icon-1024.png")
if os.path.exists(src):
    im = Image.open(src).convert("RGB")
    im.save(os.path.join(appicon_out, "icon-1024.png"))
    print("wrote AppIcon 1024 (RGB, no alpha)")
