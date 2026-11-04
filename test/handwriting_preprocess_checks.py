import tempfile
import sys
import unittest
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from handwriting_preprocess import split_header


class CropTests(unittest.TestCase):
    def test_two_text_lines_are_separated_from_a_long_underline(self):
        with tempfile.TemporaryDirectory(prefix='handwriting-crop-test-') as directory:
            image = Image.new('RGB', (480, 250), 'white')
            draw = ImageDraw.Draw(image)
            font = ImageFont.load_default(size=48)
            draw.text((30, 20), '7700001361', font=font, fill=(30,30,120))
            draw.line((20,105,420,105), fill=(30,30,120), width=3)
            draw.text((30,140), '03-11-26', font=font, fill=(30,30,120))
            source = Path(directory) / 'header.png'
            image.save(source)
            result = split_header(source, directory)
            self.assertEqual(len(result['bands']), 2)
            self.assertLess(result['bands'][0]['bottom'], result['bands'][1]['top'])
            for name in ['number', 'date']:
                with Image.open(result[name]) as crop:
                    self.assertGreater(crop.width, 30)
                    self.assertGreater(crop.height, 20)

    def test_blank_crop_does_not_create_fake_lines(self):
        with tempfile.TemporaryDirectory(prefix='handwriting-crop-test-') as directory:
            source = Path(directory) / 'blank.png'
            Image.new('RGB', (300,150), 'white').save(source)
            with self.assertRaisesRegex(ValueError, 'two substantial'):
                split_header(source, directory)


if __name__ == '__main__':
    unittest.main()
