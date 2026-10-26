"""Optional historical training data from CSV / Excel.

Sources, in priority order:

1. The school's uploaded file in the ``training-data`` Supabase Storage
   bucket (``historical/training_data.csv`` or ``.xlsx``) — admins upload
   real past scholarship applications from the Ranking page.
2. ``ml/training_data.csv`` or ``ml/training_data.xlsx`` shipped with the
   repo (small sample used when nothing is uploaded).

Rows join every training run alongside the seeded synthetic population and
the current run's real applicants:

    synthetic rows + historical rows + real applicant rows -> RandomForest fit

Required column: annual income. Everything else is optional.

    annual_income,year_level,sex,gwa,gpa,ocr_match_pct,has_itr
    120000,3,Female,1.55,,99.2,yes
    450000,1,Male,,3.10,88.0,no

Header aliases are accepted (income, family_income, gender, grade, ...).
Values may carry currency symbols and thousands separators
("PHP 120,000.00" parses as 120000.0).

Nothing here is ever fatal, and nothing has to be present for training or
ranking to run:

* A file without an income column (or a row without a usable income) still
  contributes every other recognized column as a *neutral* row (need score
  50, the default income baseline). Only rows with no income column AND no
  other recognized column are dropped.
"""

from __future__ import annotations

import csv
import io
import math
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

from . import config as _config
from . import features as _features

TRAINING_CSV = _config.ML_DIR / "training_data.csv"
TRAINING_XLSX = _config.ML_DIR / "training_data.xlsx"
STORAGE_BUCKET = "training-data"
STORAGE_PREFIX = "historical/"

_ALIASES = {
    "income": ("annual_income", "income", "family_income", "total_family_annual_income",
               "family_annual_income", "yearly_income", "declared_income", "amount",
               "annual_income_family", "total_family_income"),
    "year_level": ("year_level", "year", "level", "grade_level", "year_lvl"),
    "sex": ("sex", "gender"),
    "gwa": ("gwa", "shs_gwa", "senior_high_gwa"),
    "gpa": ("gpa", "college_gpa", "tertiary_gpa"),
    "ocr_match_pct": ("ocr_match_pct", "ocr_match", "match_pct", "ocr_pct"),
    "has_itr": ("has_itr", "itr", "has_itr_upload", "itr_uploaded",
                "income_tax_return", "itr_path", "itr_file"),
    "student_name": ("student_name", "name", "full_name", "applicant"),
}


def _canonical(header: str) -> str:
    return header.strip().lower().replace("-", "_").replace(" ", "_")


def _resolve(header_map: Dict[str, str]) -> Dict[str, Optional[str]]:
    """canonical field -> actual CSV column name present in the file."""
    resolved: Dict[str, Optional[str]] = {}
    for field, names in _ALIASES.items():
        resolved[field] = next((header_map[n] for n in names if n in header_map), None)
    return resolved


def _money(value) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    for token in ("php", "peso", "₱", "p", "per", "year", "annum", "annual"):
        text = text.replace(token, "")
    text = text.replace(",", "").replace(" ", "").strip()
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1]
    try:
        number = float(text)
    except ValueError:
        return None
    return number if number > 0 else None


def _num(value) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if number > 0 else None


def _flag(value, default: bool) -> bool:
    if value is None:
        return default
    text = str(value).strip().lower()
    if not text:
        return default
    if text in ("no", "n", "false", "0", "none", "-"):
        return False
    if text in ("yes", "y", "true", "1"):
        return True
    return default


def row_from(record: Dict[str, str], resolved: Dict[str, Optional[str]]) -> Optional[Dict]:
    """One CSV record -> the same feature-row shape the forests train on.

    A record with no usable income is kept as a *neutral* row (need score 50,
    default income baseline) whenever any other column is recognized, so
    historical files without income data still join every training run.
    Only records with no income AND no other recognized column are dropped.
    """
    raw_income = record.get(resolved["income"], "") if resolved["income"] else ""
    income = _money(raw_income)

    has_other = any(
        resolved.get(field) for field in ("year_level", "sex", "gwa", "gpa", "ocr_match_pct", "has_itr")
    )
    if income is None and not has_other:
        return None

    gwa = _num(record.get(resolved["gwa"], "")) if resolved["gwa"] else None
    gpa = _num(record.get(resolved["gpa"], "")) if resolved["gpa"] else None

    year_text = record.get(resolved["year_level"], "") if resolved["year_level"] else ""
    sex_text = record.get(resolved["sex"], "") if resolved["sex"] else ""

    ocr_default = 100.0 if _flag(record.get(resolved["has_itr"], "") if resolved["has_itr"] else None, True) else 0.0
    raw_pct = _num(record.get(resolved["ocr_match_pct"], "")) if resolved["ocr_match_pct"] else None
    ocr_pct = float(min(max(raw_pct, 0.0), 100.0)) if raw_pct is not None else ocr_default

    has_itr = 1.0 if _flag(record.get(resolved["has_itr"], "") if resolved["has_itr"] else None, True) else 0.0
    if has_itr < 0.5:
        ocr_pct = 0.0

    row = {
        "declared_income": income,
        "financial_need_score": _features.financial_need_score(income),
        "ocr_match_pct": round(ocr_pct, 2),
        "income_log": _features.income_log(income),
        "has_itr": has_itr,
        "ocr_verified": 1.0 if ocr_pct > 0 else 0.0,
        "year_level_num": _features.year_level_num(year_text),
        "sex_code": _features.sex_code(sex_text),
        "academic_norm": _features.academic_norm(gwa, gpa),
        "source": "csv",
    }
    if income is None:
        row["income_missing"] = True
    if math.isnan(row["academic_norm"]):
        row["academic_norm"] = None
    row["priority_target"] = _features.priority_target(row)
    return row


def _read_records(csv_path: Path) -> tuple[List[Dict[str, str]], List[str]]:
    """Read CSV or Excel (.xlsx) into row dicts keyed by header text."""
    if csv_path.suffix.lower() == ".xlsx":
        try:
            from openpyxl import load_workbook
        except ImportError:
            return [], ["openpyxl is not installed - cannot read .xlsx (save the sheet as CSV instead)"]
        try:
            book = load_workbook(csv_path, read_only=True, data_only=True)
            sheet = book.active
            rows_iter = sheet.iter_rows(values_only=True)
            header = ["" if cell is None else str(cell).strip() for cell in next(rows_iter, []) or []]
            records: List[Dict[str, str]] = []
            for values in rows_iter:
                cells = ["" if cell is None else str(cell) for cell in values]
                if not any(cell.strip() for cell in cells):
                    continue
                records.append({h: c for h, c in zip(header, cells) if h})
            book.close()
            return records, []
        except OSError as exc:
            return [], [f"training workbook unreadable: {exc}"]

    try:
        text = csv_path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return [], [f"training CSV unreadable: {exc}"]
    if not text.strip():
        return [], []

    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel

    reader = csv.reader(io.StringIO(text), dialect)
    try:
        header = next(reader)
    except StopIteration:
        return [], []
    header = [cell.strip() for cell in header]

    records = []
    for values in reader:
        if not any(cell.strip() for cell in values):
            continue
        records.append({h: c for h, c in zip(header, values) if h})
    return records, []


def _download_uploaded() -> Optional[Path]:
    """Fetch the admin-uploaded historical file from Supabase Storage.

    Returns a local temp path (.csv or .xlsx) or None when nothing is
    uploaded / storage is unreachable. Never raises.
    """
    try:
        from . import storage as _storage
    except Exception:
        return None
    try:
        files = _storage.list_all(STORAGE_BUCKET, STORAGE_PREFIX)
    except Exception:
        return None
    target = next(
        (f for f in files if f["path"].lower().endswith((".csv", ".xlsx"))),
        None,
    )
    if not target:
        return None
    try:
        data = _storage.download(STORAGE_BUCKET, target["path"])
    except Exception:
        return None
    suffix = ".xlsx" if target["path"].lower().endswith(".xlsx") else ".csv"
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix, prefix="historical_")
    handle.write(data)
    handle.close()
    return Path(handle.name)


def load_training_csv(path: Optional[Path] = None) -> tuple[List[Dict], List[str]]:
    """Read the historical training file (uploaded, or the bundled sample).

    Returns (rows, warnings); never raises.
    """
    temp_path: Optional[Path] = None
    if path:
        csv_path: Optional[Path] = Path(path)
    else:
        temp_path = _download_uploaded()
        if temp_path is not None:
            csv_path = temp_path
        elif TRAINING_CSV.is_file():
            csv_path = TRAINING_CSV
        elif TRAINING_XLSX.is_file():
            csv_path = TRAINING_XLSX
        else:
            csv_path = None
    try:
        if csv_path is None or not csv_path.is_file():
            return [], []

        records, warnings = _read_records(csv_path)
        if warnings and not records:
            return [], warnings
        if not records:
            return [], []

        header_map = {_canonical(name): name for name in records[0].keys() if name.strip()}
        resolved = _resolve(header_map)
        if not resolved["income"]:
            warnings.append(
                "training data has no income column — every row is kept with a neutral need score "
                f"(accepted income headers: {', '.join(_ALIASES['income'])})"
            )

        rows: List[Dict] = []
        neutral = 0
        for index, record in enumerate(records, start=2):
            row = row_from(record, resolved)
            if row is None:
                warnings.append(f"training data line {index}: skipped (nothing usable)")
                continue
            if row.get("income_missing"):
                neutral += 1
                warnings.append(
                    f"training data line {index}: no income value — row kept "
                    "with a neutral need score"
                )
            rows.append(row)
        if neutral:
            warnings.append(
                f"{neutral} of {len(rows)} training row(s) have no income — "
                "they contribute their other columns with a neutral need score;"
                " ranking still works normally for applicants."
            )

        return rows, warnings
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink()
            except OSError:
                pass


def load_count() -> int:
    return len(load_training_csv()[0])
