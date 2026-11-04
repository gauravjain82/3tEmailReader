"""Separate the two handwritten lines by image content, without reading their values."""
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps


def line_bands(mask):
    active = mask.sum(axis=1) > max(3, mask.shape[1] * .006)
    # Join small gaps inside a handwritten line.
    for y in range(1, len(active)-3):
        if active[y-1] and not active[y] and active[y:y+4].any():
            end = y + int(np.argmax(active[y:y+4]))
            active[y:end] = True
    bands = []
    start = None
    for y, value in enumerate([*active, False]):
        if value and start is None:
            start = y
        elif not value and start is not None:
            ink = int(mask[start:y].sum())
            if y-start >= 10 and ink >= 80:
                bands.append({'top': start, 'bottom': y, 'ink': ink})
            start = None
    return bands


def split_header(filename, directory):
    source = Image.open(filename).convert('RGB')
    rgb = np.asarray(source).astype(np.int16)
    blue = (rgb[:, :, 2] > rgb[:, :, 0]+10) & (rgb[:, :, 2] > rgb[:, :, 1]+8) & (rgb[:, :, :2].min(axis=2) < 210)
    coloured = int(blue.sum()) > 100
    mask = blue if coloured else rgb.min(axis=2) < 170
    bitmap = Image.fromarray(mask.astype(np.uint8)*255)
    best = None
    for angle in range(-15, 16):
        rotated = np.asarray(bitmap.rotate(angle, expand=True, resample=Image.Resampling.NEAREST, fillcolor=0)) > 0
        projection = rotated.sum(axis=1)
        score = float((projection.astype(float)**2).sum())
        if best is None or score > best[0]:
            best = (score, angle, rotated)
    _, angle, mask = best
    rotated_source = np.asarray(ImageOps.grayscale(source.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC, fillcolor='white')))
    # Long rules are the underline, not the number/date. Do not substitute any digit.
    rules = np.where(mask.sum(axis=1) > mask.shape[1]*.42)[0]
    for y in rules:
        mask[max(0,y-1):min(mask.shape[0],y+2)] = False
    bands = sorted(sorted(line_bands(mask), key=lambda b:b['ink'], reverse=True)[:2], key=lambda b:b['top'])
    if len(bands) != 2:
        raise ValueError('Could not isolate exactly two substantial handwritten lines.')
    output = {}
    for name, band in zip(['number', 'date'], bands):
        top, bottom = max(0,band['top']-3), min(mask.shape[0],band['bottom']+3)
        part = mask[top:bottom]
        cols = np.where(part.any(axis=0))[0]
        if not len(cols):
            raise ValueError('Handwriting line has no readable ink.')
        left, right = max(0,int(cols[0])-5), min(part.shape[1],int(cols[-1])+6)
        part = part[:, left:right]
        grey = rotated_source[top:bottom,left:right]
        image = ImageOps.expand(Image.fromarray(np.where(part,grey,255).astype(np.uint8)), border=14, fill=255).convert('RGB')
        target = Path(directory) / (Path(filename).stem+'-'+name+'-isolated.png')
        image.save(target)
        output[name] = str(target)
    return {**output, 'angle': angle, 'blueInkIsolated': coloured, 'bands': bands}
