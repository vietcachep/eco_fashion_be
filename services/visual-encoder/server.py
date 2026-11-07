"""Internal SigLIP2 image embeddings. No URL fetching, image persistence, or request logging."""
import base64
import binascii
import hmac
import io
import json
import os
import threading
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageOps

MODEL_ID = "google/siglip2-base-patch16-224"
REVISION = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
MODEL_VERSION = f"{MODEL_ID}@{REVISION}"
MAX_IMAGE = 5 * 1024 * 1024
MAX_BODY = 29 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 20_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
gate = threading.BoundedSemaphore(1)
model = None
processor = None


def decode_image(encoded):
    if not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE * 4 // 3 + 8):
        raise ValueError("invalid image")
    try:
        data = base64.b64decode(encoded, validate=True)
        if len(data) > MAX_IMAGE:
            raise ValueError("image too large")
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in ("JPEG", "PNG", "WEBP") or image.width * image.height > Image.MAX_IMAGE_PIXELS:
                raise ValueError("invalid image format or dimensions")
            image.load()
            return ImageOps.exif_transpose(image).convert("RGB")
    except (binascii.Error, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ValueError("invalid image") from error


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_args):
        pass

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not found"})
        return self.reply(200 if model is not None else 503, {"ready": model is not None, "modelVersion": MODEL_VERSION, "dimensions": 768})

    def do_POST(self):
        if self.path != "/v1/embed":
            return self.reply(404, {"error": "not found"})
        token = os.environ.get("VISUAL_ENCODER_TOKEN", "")
        if not token or not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {token}"):
            return self.reply(401, {"error": "unauthorized"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_BODY:
                return self.reply(413, {"error": "body too large"})
        except ValueError:
            return self.reply(400, {"error": "invalid length"})
        if model is None:
            return self.reply(503, {"error": "model loading"})
        if not gate.acquire(blocking=False):
            return self.reply(429, {"error": "encoder busy"})
        images = []
        try:
            payload = json.loads(self.rfile.read(size))
            entries = payload.get("images") if isinstance(payload, dict) else None
            if not isinstance(entries, list) or not 1 <= len(entries) <= 4:
                raise ValueError("invalid batch")
            images = [decode_image(entry) for entry in entries]
            import torch
            inputs = processor(images=images, return_tensors="pt")
            with torch.inference_mode():
                features = model(**inputs).pooler_output
                features = torch.nn.functional.normalize(features.float(), dim=-1)
            return self.reply(200, {"modelVersion": MODEL_VERSION, "vectors": features.tolist()})
        except (ValueError, TypeError):
            return self.reply(400, {"error": "invalid images"})
        except Exception:
            return self.reply(503, {"error": "encoding failed"})
        finally:
            for image in images:
                image.close()
            gate.release()


def load_model():
    global model, processor
    import torch
    from transformers import SiglipImageProcessor, SiglipVisionModel
    torch.set_num_threads(max(1, min(4, int(os.environ.get("VISUAL_CPU_THREADS", "2")))))
    loaded = SiglipVisionModel.from_pretrained(MODEL_ID, revision=REVISION, use_safetensors=True).eval()
    processor = SiglipImageProcessor.from_pretrained(MODEL_ID, revision=REVISION)
    model = loaded


if __name__ == "__main__":
    if not os.environ.get("VISUAL_ENCODER_TOKEN"):
        raise SystemExit("VISUAL_ENCODER_TOKEN is required")
    threading.Thread(target=load_model, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    server.timeout = 30
    server.serve_forever()
