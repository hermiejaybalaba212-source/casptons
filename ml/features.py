"""Feature engineering: financial need score, OCR match percentage, encoding.

Everything is plain NumPy so the feature matrix, the imputation statistics and
the final ranking can all be reported in the analytics panel.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import config as _config

FEATURE_COLUMNS: List[str] = [
    "financial_need_score",   # 0-100, higher = poorer
    "ocr_match_pct",          # 0-100, OCR figure vs typed figure
    "income_log",             # log1p(income) scaled to 0-1
    "has_itr",                # 1 when an ITR document exists
    "ocr_verified",           # 1 when OCR actually read an income value
    "year_level_num",         # 1..5
    "sex_code",               # 0 male / 1 female / 2 unknown
    "academic_norm",          # GPA/4 or GWA/100, 0-1 (NaN when missing)
]

AVERAGE_ACADEMIC = 0.70


def financial_need_score(income: Optional[float]) -> float:
    """Annual family income -> 0..100 need score (100 = most needed)."""
    if income is None:
        return 50.0
    value = float(income)
    span = _config.INCOME_CEIL - _config.INCOME_FLOOR
    score = 100.0 * (_config.INCOME_CEIL - value) / span
    return round(float(np.clip(score, 0.0, 100.0)), 2)


def year_level_num(value: Optional[str]) -> float:
    if not value:
        return 0.0
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    return float(int(digits)) if digits and 1 <= int(digits) <= 5 else 0.0


def sex_code(value: Optional[str]) -> float:
    text = (value or "").strip().lower()
    if text.startswith("m"):
        return 0.0
    if text.startswith("f"):
        return 1.0
    return 2.0


def academic_norm(gwa: Optional[float], gpa: Optional[float]) -> float:
    """College GPA (4.0 scale) wins, otherwise SHS GWA (100 scale)."""
    if gpa is not None and not math.isnan(gpa) and gpa > 0:
        return float(np.clip(gpa / 4.0, 0.0, 1.0))
    if gwa is not None and not math.isnan(gwa) and gwa > 0:
        return float(np.clip(gwa / 100.0, 0.0, 1.0))
    return float("nan")


def income_log(income: Optional[float]) -> float:
    if income is None:
        return float(np.log1p(150_000.0)) / float(np.log1p(_config.INCOME_CEIL))
    return float(np.log1p(max(0.0, float(income)))) / float(np.log1p(_config.INCOME_CEIL))


def itr_trust(row: Dict) -> str:
    """Trust gate: 'verified' | 'mismatch' | 'no_itr'.

    An applicant is only 'verified' when an ITR was uploaded and the income
    the applicant typed matches the figure OCR read from it (>= OCR_TRUST_MIN_PCT).
    Everyone else is ranked after the verified group.
    """
    has_itr = bool(row.get("itr_path")) or bool(row.get("has_itr"))
    if not has_itr:
        return "no_itr"
    match = row.get("ocr_match_pct") or 0.0
    try:
        match = float(match)
    except (TypeError, ValueError):
        match = 0.0
    return "verified" if match >= _config.OCR_TRUST_MIN_PCT else "mismatch"


def priority_target(row: Dict) -> float:
    """Ground-truth priority (0-100) the Random Forest learns.

    Financial need only (W_NEED = 1.0): the income the OCR read from the ITR.
    No academic weight, no OCR-match bonus - the match is handled as the
    trust gate that decides which group an applicant is ranked in.
    """
    need = row.get("financial_need_score", 0.0)
    ocr = row.get("ocr_match_pct", 0.0)
    academic = row.get("academic_norm", AVERAGE_ACADEMIC)
    if academic is None or (isinstance(academic, float) and math.isnan(academic)):
        academic = AVERAGE_ACADEMIC
    return round(
        100.0
        * (
            _config.W_NEED * (need / 100.0)
            + _config.W_OCR * (ocr / 100.0)
            + _config.W_ACADEMIC * academic
        ),
        4,
    )


def effective_income(
    declared: Optional[float],
    ocr_value: Optional[float],
    low_confidence: bool = False,
) -> Tuple[Optional[float], str]:
    """The figure the ranking actually uses.

    The ITR is the source of truth: when OCR produced an income value the
    ranking is driven by it, even when the applicant typed something else.
    The declared value is only used when OCR produced nothing (or only a
    low-confidence fallback).
    """
    ocr = None
    if ocr_value is not None:
        try:
            ocr = float(ocr_value)
        except (TypeError, ValueError):
            ocr = None
    typed = None
    if declared is not None:
        try:
            typed = float(declared)
        except (TypeError, ValueError):
            typed = None

    if ocr is not None and not low_confidence:
        return ocr, "ocr"
    if typed is not None:
        return typed, "declared" if ocr is None else "declared_low_confidence_ocr"
    if ocr is not None:
        return ocr, "ocr_low_confidence"
    return None, "none"


def build_row(applicant: Dict, ocr_result: Optional[Dict]) -> Dict:
    """One applicant -> derived features used by both the RF and the UI."""
    declared = applicant.get("declared_income")
    ocr_value = (ocr_result or {}).get("ocr_value")
    match = (ocr_result or {}).get("match") or {}
    low_confidence = bool((ocr_result or {}).get("low_confidence"))

    income_used, income_source = effective_income(declared, ocr_value, low_confidence)
    delta = None
    if declared is not None and ocr_value is not None:
        try:
            delta = round(float(ocr_value) - float(declared), 2)
        except (TypeError, ValueError):
            delta = None

    gpa = _num(applicant.get("college_gpa"))
    gwa = _num(applicant.get("shs_gwa"))

    row = {
        "application_id": applicant.get("application_id"),
        "student_name": applicant.get("student_name") or "",
        "student_number": applicant.get("student_number") or "",
        "scholarship": applicant.get("scholarship") or "",
        "program": applicant.get("program") or "",
        "year_level": applicant.get("year_level") or "",
        "sex": applicant.get("sex") or "",
        "declared_income": declared,
        "ocr_income": ocr_value,
        "income_used": income_used,
        "income_source": income_source,
        "income_delta": delta,
        "income_corrected": bool(
            income_source == "ocr" and delta is not None and abs(delta) > 0.005
        ),
        "itr_path": applicant.get("itr_path"),
        "financial_need_score": financial_need_score(income_used),
        "ocr_match_pct": float(match.get("align_pct") or 0.0),
        "ocr_exact_match": bool(match.get("exact_match")),
        "ocr_status": match.get("status", "not_comparable"),
        "income_log": income_log(income_used),
        "has_itr": 1.0 if applicant.get("itr_path") else 0.0,
        "ocr_verified": 1.0 if ocr_value is not None else 0.0,
        "year_level_num": year_level_num(applicant.get("year_level")),
        "sex_code": sex_code(applicant.get("sex")),
        "academic_norm": academic_norm(gwa, gpa),
        "priority_target": 0.0,
    }
    row["priority_target"] = priority_target(row)
    row["itr_trust"] = itr_trust(row)
    return row


def matrix(rows: Sequence[Dict], medians: Optional[Dict[str, float]] = None) -> Tuple[np.ndarray, Dict[str, float]]:
    """Rows -> float matrix with median imputation (NaN-safe)."""
    if medians is None:
        collected: Dict[str, List[float]] = {c: [] for c in FEATURE_COLUMNS}
        for row in rows:
            for col in FEATURE_COLUMNS:
                value = row.get(col)
                if value is None or (isinstance(value, float) and math.isnan(value)):
                    continue
                collected[col].append(float(value))
        medians = {
            col: float(np.median(vals)) if vals else 0.0
            for col, vals in collected.items()
        }

    data = np.zeros((len(rows), len(FEATURE_COLUMNS)), dtype=np.float64)
    for i, row in enumerate(rows):
        for j, col in enumerate(FEATURE_COLUMNS):
            value = row.get(col)
            if value is None or (isinstance(value, float) and math.isnan(value)):
                value = medians[col]
            data[i, j] = float(value)
    return data, medians


def _num(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return number
