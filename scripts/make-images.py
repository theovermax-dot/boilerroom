# Генерирует картинки бота (без внешних ассетов). Запуск: python3 scripts/make-images.py
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'img')
os.makedirs(OUT, exist_ok=True)
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
S = 1080
ORANGE = (255, 96, 32)
EMBER = (190, 30, 20)

def base():
    img = Image.new('RGB', (S, S), (10, 10, 12))
    px = img.load()
    # радиальный красно-оранжевый свет снизу
    for y in range(S):
        for x in range(0, S):
            pass
    glow = Image.new('RGB', (S, S), (0, 0, 0))
    d = ImageDraw.Draw(glow)
    for r in range(900, 0, -6):
        t = 1 - r / 900
        c = (int(200 * t), int(50 * t), int(15 * t))
        d.ellipse([S/2 - r, S*0.95 - r, S/2 + r, S*0.95 + r], fill=c)
    glow = glow.filter(ImageFilter.GaussianBlur(40))
    return Image.blend(img, glow, 1.0)

def grain_lines(img):
    d = ImageDraw.Draw(img)
    for i in range(-S, S * 2, 46):
        d.line([(i, S), (i + S, 0)], fill=(255, 255, 255, 10), width=1)
    return img

def center_text(d, y, text, font, fill, spacing=0):
    w = d.textlength(text, font=font)
    d.text(((S - w) / 2, y), text, font=font, fill=fill)

def welcome():
    img = grain_lines(base())
    d = ImageDraw.Draw(img)
    f_big = ImageFont.truetype(BOLD, 150)
    f_mid = ImageFont.truetype(BOLD, 64)
    f_small = ImageFont.truetype(REG, 42)
    center_text(d, 300, 'BOILER', f_big, (245, 245, 245))
    center_text(d, 450, 'ROOM', f_big, ORANGE)
    d.rectangle([S/2 - 180, 640, S/2 + 180, 646], fill=ORANGE)
    center_text(d, 690, 'BATUMI', f_mid, (245, 245, 245))
    center_text(d, 800, 'Футбол · UFC · Бокс', f_small, (200, 200, 200))
    center_text(d, 860, 'Бронь стола в Telegram — без звонков', f_small, (160, 160, 160))
    img.save(os.path.join(OUT, 'welcome.jpg'), quality=92)

def cover():
    img = grain_lines(base())
    d = ImageDraw.Draw(img)
    # «ринг»-квадрат и мяч-круг как декор
    d.rounded_rectangle([90, 90, S - 90, S - 90], radius=36, outline=ORANGE, width=6)
    f_tag = ImageFont.truetype(BOLD, 56)
    f_big = ImageFont.truetype(BOLD, 118)
    f_small = ImageFont.truetype(REG, 44)
    center_text(d, 170, 'LIVE NOW', f_tag, ORANGE)
    center_text(d, 430, 'ТРАНСЛЯЦИЯ', f_big, (245, 245, 245))
    center_text(d, 580, 'Бронь стола в боте', f_small, (200, 200, 200))
    center_text(d, 840, 'BOILER ROOM · BATUMI', f_tag, (235, 235, 235))
    img.save(os.path.join(OUT, 'cover.jpg'), quality=92)

welcome()
cover()
print('ok:', sorted(os.listdir(OUT)))
