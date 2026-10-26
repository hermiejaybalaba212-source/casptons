"""Configuration, environment loading and tunable ranking weights."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

ML_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = ML_DIR.parent
MODEL_DIR = ML_DIR / "models"
ENV_FILE = PROJECT_ROOT / ".env.local"

# --- model defaults -------------------------------------------------------
DEFAULT_SEED = 2026
DEFAULT_N_TREES = 100
DEFAULT_SYNTH_SAMPLES = 800
DEFAULT_MAX_DEPTH = 8

# --- financial-need scaling (pesos) ---------------------------------------
INCOME_FLOOR = 100_000.0       # annual family income -> need score 100
INCOME_CEIL = 600_000.0        # annual family income -> need score 0
HIGH_NEED_INCOME = 150_000.0   # app-wide "High Need" cut-off (matches lib/ml)

# --- composite priority target (what the regressor learns) ---------------
# The ranking is based on financial need only (the income read from the ITR).
# Academic grades are deliberately NOT part of the scholarship ranking, and
# the OCR match percentage acts as a trust gate (OCR_TRUST_MIN_PCT) instead
# of a score component: applicants whose typed income does not match their
# ITR (or who uploaded no ITR at all) are placed after the verified ones.
W_NEED = 1.00                  # financial need score (driven by the ITR income)
W_OCR = 0.00                   # trust gate only - never adds score
W_ACADEMIC = 0.00              # academics excluded on purpose

OCR_TRUST_MIN_PCT = 90.0       # typed vs ITR align >= this % = "ITR verified"

HIGH_NEED_LABEL_SCORE = 55.0   # classifier label threshold

# --- storage --------------------------------------------------------------
STORAGE_BUCKET = "itr-documents"

# --- OCR limits -----------------------------------------------------------
OCR_MAX_VARIANTS = 3           # preprocessing candidates tried before giving up
OCR_LINE_PREVIEW = 8           # OCR lines returned per document for the UI
OCR_MIN_CONFIDENCE = 0.30


def load_env(path: Optional[Path] = None) -> dict:
    """Read ``.env.local`` style KEY=VALUE lines into a dict (never logged)."""
    env_path = Path(path) if path else ENV_FILE
    out: dict = {}
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    # Process env always wins.
    for key, value in os.environ.items():
        if value:
            out.setdefault(key, value)
    return out


def supabase_config(env: Optional[dict] = None) -> tuple:
    env = env if env is not None else load_env()
    url = env.get("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") or ""
    return url, key


def stack_info() -> dict:
    """Versions of every library used - surfaced in the UI analytics panel.

    Reads distribution metadata only: importing onnxruntime/rapidocr just to
    print a version string costs ~28 s on this machine.
    """
    from importlib.metadata import PackageNotFoundError, version as _dist_version

    info = {"python": ".".join(str(v) for v in __import__("sys").version_info[:3])}
    for dist_name in (
        "numpy",
        "scikit-learn",
        "joblib",
        "scipy",
        "pillow",
        "rapidocr-onnxruntime",
        "onnxruntime-directml",
        "opencv-python",
        "opencv-python-headless",
    ):
        try:
            info[dist_name] = _dist_version(dist_name)
        except PackageNotFoundError:
            continue
    if "onnxruntime-directml" in info:
        info["onnxruntime"] = info["onnxruntime-directml"]
    if "opencv-python" not in info and "opencv-python-headless" in info:
        info["opencv-python"] = info["opencv-python-headless"]
    return info
