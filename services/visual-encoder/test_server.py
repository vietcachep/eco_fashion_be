import base64
import io
import unittest
from unittest.mock import patch
from PIL import Image
from server import decode_image


def encoded_image(kind="PNG", size=(32, 32)):
    output = io.BytesIO()
    Image.new("RGB", size, "red").save(output, format=kind)
    return base64.b64encode(output.getvalue()).decode()


class ImageDecodeTests(unittest.TestCase):
    def test_valid_images_become_rgb(self):
        for kind in ("PNG", "JPEG", "WEBP"):
            image = decode_image(encoded_image(kind))
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.size, (32, 32))
            image.close()

    def test_invalid_base64_and_non_images(self):
        for value in (None, 123, "not-base64", base64.b64encode(b"html, not image").decode()):
            with self.assertRaises(ValueError):
                decode_image(value)

    def test_gif_is_not_accepted(self):
        with self.assertRaises(ValueError):
            decode_image(encoded_image("GIF"))

    def test_dimension_bomb_rejected_before_loading(self):
        image = encoded_image(size=(11, 11))
        with patch("server.Image.MAX_IMAGE_PIXELS", 100):
            with self.assertRaises(ValueError):
                decode_image(image)


if __name__ == "__main__":
    unittest.main()
