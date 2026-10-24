"""Backend tests. The Gemini call is mocked; vision.py's real validation runs."""
import base64
import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402

client = TestClient(main.app)
SMOKE = Path(__file__).resolve().parents[1] / "_smoke_test.png"


def b64_png(size=(64, 64)):
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture
def fake_model(monkeypatch):
    """Replace only the network call; keep real input validation + decoding."""
    calls = []

    class FakeModels:
        def generate_content(self, **kw):
            calls.append(kw)

            class R:
                text = "A red square in the centre."
                candidates = []
            return R()

    class FakeClient:
        models = FakeModels()

    monkeypatch.setitem(main.analyze_image.__globals__, "_get_client", lambda: FakeClient())
    return calls


@pytest.mark.parametrize("action", ["describe", "read", "translate", "explain"])
def test_all_four_actions(fake_model, action):
    r = client.post("/analyze", json={
        "image_base64": b64_png(), "action": action,
        "question": "what is it?", "language": "French"})
    assert r.status_code == 200
    assert r.json() == {"answer": "A red square in the centre."}
    prompt = fake_model[-1]["contents"][1]
    assert "French" in prompt and "what is it?" in prompt


def test_data_url_and_smoke_image(fake_model):
    raw = base64.b64encode(SMOKE.read_bytes()).decode()
    r = client.post("/analyze", json={"image_base64": "data:image/png;base64," + raw})
    assert r.status_code == 200


def test_browser_style_jpeg_frame(fake_model):
    buf = io.BytesIO()
    Image.new("RGB", (1280, 720), (10, 120, 200)).save(buf, "JPEG", quality=80)
    url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    assert client.post("/analyze", json={"image_base64": url, "action": "describe"}).status_code == 200


def test_oversized_pixel_image_is_resized_not_rejected(fake_model):
    r = client.post("/analyze", json={"image_base64": b64_png((5000, 5000))})  # 25 MP > 20 MP
    assert r.status_code == 200
    sent = fake_model[-1]["contents"][0]
    w, h = Image.open(io.BytesIO(sent.inline_data.data)).size
    assert w * h <= 20_000_000


@pytest.mark.parametrize("payload,fragment", [
    ({"image_base64": "not base64!!"}, "base64"),
    ({"image_base64": base64.b64encode(b"hello").decode()}, "invalid"),
    ({"image_base64": b64_png(), "action": "hack"}, "Action"),
    ({"image_base64": b64_png(), "language": ""}, "Language"),
    ({"image_base64": b64_png(), "question": "x" * 2001}, "Question"),
])
def test_invalid_input_gives_400(fake_model, payload, fragment):
    r = client.post("/analyze", json=payload)
    assert r.status_code == 400
    assert fragment.lower() in r.json()["detail"].lower()


def test_missing_field_gives_friendly_422():
    r = client.post("/analyze", json={})
    assert r.status_code == 422 and "malformed" in r.json()["detail"]


def test_vision_error_maps_to_502_and_timeout_to_504(monkeypatch):
    def boom(msg):
        def f(*a, **k):
            raise main.VisionError(msg)
        return f
    monkeypatch.setattr(main, "analyze_image", boom("Gemma API request failed (HTTP 500)."))
    assert client.post("/analyze", json={"image_base64": "x"}).status_code == 502
    monkeypatch.setattr(main, "analyze_image", boom("Gemma request timed out. Please try again."))
    assert client.post("/analyze", json={"image_base64": "x"}).status_code == 504


def test_unexpected_error_does_not_leak(monkeypatch):
    def f(*a, **k):
        raise RuntimeError("secret-key-123")
    monkeypatch.setattr(main, "analyze_image", f)
    r = client.post("/analyze", json={"image_base64": "x"})
    assert r.status_code == 500 and "secret" not in r.text


def test_missing_api_key_message(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    g = main.analyze_image.__globals__
    g["_get_client"].cache_clear()
    monkeypatch.setitem(g, "load_dotenv", lambda *a, **k: None)
    r = client.post("/analyze", json={"image_base64": b64_png()})
    assert r.status_code == 502 and "GEMINI_API_KEY" in r.json()["detail"]
    g["_get_client"].cache_clear()


def test_frontend_served_and_has_no_api_key():
    r = client.get("/")
    assert r.status_code == 200 and "E.D.I.T.H. Assist" in r.text
    assert "GEMINI" not in r.text and "AIza" not in r.text
