"""OCR + Random Forest ranking pipeline for scholarship applications.

Public entry points used by ``ml/pipeline.py`` (the NDJSON CLI).
"""

__all__ = ["config", "preproc", "ocr_engine", "features", "rank_model", "storage"]
