from pathlib import Path
from PIL import Image, ImageDraw

target = Path(__file__).resolve().parents[1] / 'extension' / 'icons'
target.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128):
    im = Image.new('RGBA', (256, 256))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((6, 6, 250, 250), radius=56, fill='#255acf')
    # A browser tab, with an editing stroke, stays legible at toolbar size.
    d.rounded_rectangle((43, 62, 213, 196), radius=19, fill='white')
    d.rounded_rectangle((56, 47, 137, 88), radius=13, fill='white')
    d.line((77, 126, 165, 126), fill='#255acf', width=14)
    d.line((77, 158, 137, 158), fill='#255acf', width=14)
    d.line((181, 108, 181, 174), fill='#255acf', width=10)
    im.resize((size, size), Image.Resampling.LANCZOS).save(target / f'{size}.png')
