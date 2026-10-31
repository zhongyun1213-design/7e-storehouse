"""生成 PWA 图标（192 / 512 / 180），与 icons/icon.svg 的构图一致。"""

from PIL import Image, ImageDraw

SCALE = 4
S = 512


def lerp(a, b, t):
    return a + (b - a) * t


def gradient(size, c1, c2, step=96):
    small = Image.new("RGB", (step, step))
    px = small.load()
    for y in range(step):
        for x in range(step):
            t = (x + y) / (2 * (step - 1))
            px[x, y] = (
                round(lerp(c1[0], c2[0], t)),
                round(lerp(c1[1], c2[1], t)),
                round(lerp(c1[2], c2[2], t)),
            )
    return small.resize((size, size), Image.BICUBIC)


def rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def main():
    size = S * SCALE
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg = gradient(size, (176, 42, 63), (92, 15, 31)).convert("RGBA")

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=116 * SCALE, fill=255)
    canvas.paste(bg, (0, 0), mask)

    draw = ImageDraw.Draw(canvas)
    rect(draw, (104 * SCALE, 140 * SCALE, 408 * SCALE, 412 * SCALE), 58 * SCALE, (255, 250, 246, 255))
    rect(draw, (170 * SCALE, 112 * SCALE, 196 * SCALE, 180 * SCALE), 13 * SCALE, (247, 230, 224, 255))
    rect(draw, (316 * SCALE, 112 * SCALE, 342 * SCALE, 180 * SCALE), 13 * SCALE, (247, 230, 224, 255))

    cells = [(168, 222), (232, 222), (296, 222),
             (168, 276), (232, 276), (296, 276),
             (168, 330), (232, 330)]
    for x, y in cells:
        rect(draw, (x * SCALE, y * SCALE, (x + 48) * SCALE, (y + 40) * SCALE), 12 * SCALE, (232, 198, 202, 255))
    rect(draw, (296 * SCALE, 330 * SCALE, 344 * SCALE, 370 * SCALE), 12 * SCALE, (157, 34, 53, 255))

    for out, edge in ((512, 512), (192, 192), (180, 180)):
        canvas.resize((edge, edge), Image.LANCZOS).save(f"icons/icon-{out}.png")
    print("icons written")


if __name__ == "__main__":
    main()
