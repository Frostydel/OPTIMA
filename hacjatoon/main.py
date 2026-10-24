"""
EDITH Assist - FastAPI backend.

A thin HTTP wrapper around the existing vision module. All image validation,
resizing and AI logic lives in analyze_image(); nothing is duplicated here.

Run:
    python -m uvicorn main:app --reload
Then open http://localhost:8000

Contract:
    POST /analyze
    {"image_base64": "...", "action": "describe|read|translate|explain",
     "question": "", "language": "English"}
    -> {"answer": "..."}   or   {"detail": "human readable error"}
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# The module is saved as vesion.py in this repository but documented as
# vision.py. Accept either name so renaming the file later needs no code change.
try:
    from vision import VisionError, analyze_image
except ModuleNotFoundError as exc:
    if exc.name != "vision":
        raise
    from vesion import VisionError, analyze_image

logger = logging.getLogger("edith")

STATIC_DIR = Path(__file__).with_name("static")

# Slightly above vision's 8 MiB limit in base64, so vision.py produces its own
# friendly size message for borderline cases; this only stops absurd payloads.
MAX_REQUEST_IMAGE_CHARS = 12_000_000

app = FastAPI(title="EDITH Assist")


class AnalyzeRequest(BaseModel):
    image_base64: str = Field(..., max_length=MAX_REQUEST_IMAGE_CHARS)
    action: str = "describe"
    question: str = ""
    language: str = "English"


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "detail": (
                "The request was malformed or the image is too large. "
                "Send image_base64, action, question and language."
            )
        },
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# Plain `def` so FastAPI runs the blocking Gemini call in a worker thread.
@app.post("/analyze")
def analyze(req: AnalyzeRequest) -> dict[str, str]:
    try:
        return analyze_image(
            req.image_base64,
            action=req.action,
            question=req.question,
            language=req.language,
        )
    except ValueError as exc:  # bad input: image, action, question, language
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except VisionError as exc:  # expected AI / network failure
        message = str(exc)
        status = 504 if "timed out" in message.lower() else 502
        raise HTTPException(status_code=status, detail=message) from exc
    except Exception as exc:  # never leak internals (or secrets) to the client
        logger.exception("Unexpected error in /analyze")
        raise HTTPException(
            status_code=500,
            detail="Unexpected server error. Please try again.",
        ) from exc


# Registered last so /analyze and /health take precedence.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
