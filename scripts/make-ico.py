# -*- coding: utf-8 -*-
# 一次性：从 build/icon.png（1024x1024）生成 build/icon.ico（多尺寸，零 npm 依赖，用 Pillow）
from PIL import Image

src = r'F:\Active_Project\Skill-Manager\build\icon.png'
dst = r'F:\Active_Project\Skill-Manager\build\icon.ico'
img = Image.open(src)
print('source:', img.size, img.mode)
if img.mode != 'RGBA':
    img = img.convert('RGBA')
img.save(dst, format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
back = Image.open(dst)
import os
print('ico written:', dst, os.path.getsize(dst), 'bytes, largest entry:', back.size)
