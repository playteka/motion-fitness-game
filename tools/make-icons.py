#!/usr/bin/env python3
# PWA / 添加到主屏用的图标生成器（一次性工具，产物已经提交进仓库，平时不用跑）。
#
# 为什么需要图标：
#   - Android / Chrome 的「安装 / 添加到主屏」要求 manifest 里有 192 与 512 的 PNG，
#     **没有 icons 的 manifest 会被判定为不可安装**；
#   - iOS 的「添加到主屏」不看 manifest，只看 `<link rel="apple-touch-icon">`（180×180）。
#
# 用法（需要 Pillow；DSH 自带的 python 里就有）：
#   <python> tools/make-icons.py
#
# 图形：品牌深底 + 薄荷→天蓝渐变的**线条哑铃**（线条图标，不是 emoji），
# 与页面顶栏那颗 Lucide dumbbell 图标同一个意象；四周留足安全区，
# 这样 Android 的 maskable 圆形裁切也不会切到哑铃。
from PIL import Image, ImageDraw

OUT = {
    'icons/icon-512.png': 512,
    'icons/icon-192.png': 192,
    'icons/apple-touch-icon-180.png': 180,
}
BG_TOP = (11, 16, 23)        # --bg 附近（#0b1017）
BG_BOTTOM = (18, 42, 58)     # 深青，和页面深色底一致
MINT = (52, 229, 196)        # --accent
SKY = (56, 189, 248)         # --accent-2


def background(size):
    """从上到下的深色渐变底（满幅、不透明：iOS 会自己切圆角，Android maskable 也不该有透明边）"""
    img = Image.new('RGB', (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        draw.line(
            [(0, y), (size, y)],
            fill=tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)),
        )
    return img


def dumbbell_mask(size):
    """哑铃的蒙版（L 模式，白=要画的像素）——线条风格，两端圆角"""
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    u = size / 512.0                      # 以 512 为基准等比缩放

    def box(x0, y0, x1, y1):
        return [round(x0 * u), round(y0 * u), round(x1 * u), round(y1 * u)]

    bar = round(14 * u)
    plate = round(19 * u)
    # 杠铃杆
    d.rounded_rectangle(box(150, 242, 362, 270), radius=bar, fill=255)
    # 内侧配重片
    d.rounded_rectangle(box(176, 210, 214, 302), radius=plate, fill=255)
    d.rounded_rectangle(box(298, 210, 336, 302), radius=plate, fill=255)
    # 外侧配重片（更高）
    d.rounded_rectangle(box(120, 186, 158, 326), radius=plate, fill=255)
    d.rounded_rectangle(box(354, 186, 392, 326), radius=plate, fill=255)
    return mask


def gradient(size):
    """薄荷 → 天蓝的横向渐变（当作哑铃的“颜色”）"""
    img = Image.new('RGB', (size, size))
    draw = ImageDraw.Draw(img)
    for x in range(size):
        t = x / (size - 1)
        draw.line(
            [(x, 0), (x, size)],
            fill=tuple(round(MINT[i] + (SKY[i] - MINT[i]) * t) for i in range(3)),
        )
    return img


def build(size):
    img = background(size)
    img.paste(gradient(size), (0, 0), dumbbell_mask(size))
    return img


def main():
    import os
    for path, size in OUT.items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        icon = build(size)
        icon.save(path, 'PNG', optimize=True)
        print(f'{path}  {size}x{size}  {os.path.getsize(path)} bytes')


if __name__ == '__main__':
    main()
