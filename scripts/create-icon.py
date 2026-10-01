"""Draw the original Orbit Lab icon. Pillow is a build-time tool only."""
from pathlib import Path
import math
from PIL import Image, ImageDraw

output = Path(__file__).resolve().parent.parent / 'resources'
output.mkdir(exist_ok=True)
image = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((9, 9, 503, 503), radius=100, fill='#101c31', outline='#365979', width=8)
# An inclined ellipse with the star at a focus, rather than at its centre.
cx, cy, a, b, angle = 249, 264, 187, 126, -.40
def rotate(x, y):
    return (cx + x*math.cos(angle)-y*math.sin(angle), cy + x*math.sin(angle)+y*math.cos(angle))
points = [rotate(a*math.cos(t*math.tau/256), b*math.sin(t*math.tau/256)) for t in range(257)]
draw.line(points, fill='#70dce9', width=11, joint='curve')
focus = rotate(-math.sqrt(a*a-b*b), 0)
for radius, color in [(40, '#4b3c35'), (28, '#e6ad62'), (18, '#ffe1a0')]:
    draw.ellipse((focus[0]-radius,focus[1]-radius,focus[0]+radius,focus[1]+radius), fill=color)
particle = rotate(a*math.cos(-.75), b*math.sin(-.75))
draw.line((focus, particle), fill='#7c91b3', width=5)
draw.ellipse((particle[0]-20,particle[1]-20,particle[0]+20,particle[1]+20), fill='#d8faff', outline='#70dce9', width=4)
# Equal-time observation wedges are a small motif, not a physical scale legend.
draw.arc((77, 81, 154, 158), 210, 355, fill='#f6c177', width=8)
draw.line((107, 106, 127, 86), fill='#f6c177', width=5)
draw.line((107, 106, 146, 121), fill='#f6c177', width=5)
draw.rounded_rectangle((169, 435, 351, 446), radius=5, fill='#587996')
image.save(output / 'app.png')
image.save(output / 'app.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Created Orbit Lab resources/app.png and app.ico')
