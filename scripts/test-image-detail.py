import base64
import io
import pathlib
import sys
import unittest
from PIL import Image, ImageDraw

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from wechat_image_normalize import normalize_image

class DetailImageTest(unittest.TestCase):
    def test_screenshot_keeps_colored_text_pixels_without_loss_within_cap(self):
        image = Image.new('RGB',(1100,520),'white')
        ImageDraw.Draw(image).text((70,80),'DETAIL 42',fill=(193,16,40))
        source = io.BytesIO()
        image.save(source,format='PNG')
        output = normalize_image(source.getvalue(),max_side=2048,prefer_detail=True)
        self.assertEqual(output['mime'],'image/png')
        decoded=Image.open(io.BytesIO(base64.b64decode(output['b64'])))
        self.assertEqual(decoded.tobytes(),image.tobytes())

    def test_large_png_stays_within_transport_limit(self):
        image=Image.effect_noise((900,900),100).convert('RGB')
        source=io.BytesIO()
        image.save(source,format='PNG')
        output=normalize_image(source.getvalue(),max_kib=96,prefer_detail=True)
        self.assertEqual(output['mime'],'image/jpeg')
        self.assertLessEqual(output['bytes'],96*1024)

if __name__=='__main__':
    unittest.main()
