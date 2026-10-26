"""Random Forest ranking model (scikit-learn + joblib).

Two forests are trained on the same feature matrix:

* ``RandomForestClassifier`` -> High Need / Low Need + probability
  (accuracy / precision / recall / F1 / ROC-AUC for the analytics panel)
* ``RandomForestRegressor``  -> the composite **priority score** used to rank
  applicants. Rank 1 = highest priority = most in need of financial aid.

The training set is a seeded synthetic population blended with the real
applicants of the current run, then persisted with joblib.
"""

from __future__ import annotations

import math
import time
from typing import Dict, List, Optional, Tuple

import numpy as np

from . import config as _config
from . import csv_data as _csv_data
from . import features as _features


def _synthetic_rows(n: int, seed: int) -> List[Dict]:
    rng = np.random.default_rng(seed)
    rows: List[Dict] = []
    for _ in range(n):
        income = float(np.exp(rng.uniform(np.log(40_000.0), np.log(600_000.0))))
        ocr_roll = rng.random()
        if ocr_roll < 0.72:
            ocr_pct = float(rng.uniform(96.0, 100.0))
        elif ocr_roll < 0.92:
            ocr_pct = float(rng.uniform(75.0, 96.0))
        else:
            ocr_pct = float(rng.uniform(0.0, 75.0))
        has_itr = 1.0 if rng.random() < 0.9 else 0.0
        if has_itr < 0.5:
            ocr_pct = 0.0
        row = {
            "declared_income": income,
            "financial_need_score": _features.financial_need_score(income),
            "ocr_match_pct": round(ocr_pct, 2),
            "income_log": _features.income_log(income),
            "has_itr": has_itr,
            "ocr_verified": 1.0 if ocr_pct > 0 else 0.0,
            "year_level_num": float(rng.integers(1, 6)),
            "sex_code": float(rng.integers(0, 2)),
            "academic_norm": float(np.clip(rng.normal(0.75, 0.12), 0.2, 1.0)),
        }
        row["priority_target"] = _features.priority_target(row)
        rows.append(row)
    return rows


def _income_of(row: Dict) -> Optional[float]:
    for key in ("income_used", "declared_income", "ocr_income"):
        value = row.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return None


_INCOME_BINS = (
    (None, 100_000.0, "\u2264100k"),
    (100_000.0, 200_000.0, "100\u2013200k"),
    (200_000.0, 300_000.0, "200\u2013300k"),
    (300_000.0, 400_000.0, "300\u2013400k"),
    (400_000.0, 500_000.0, "400\u2013500k"),
    (500_000.0, 600_000.0, "500\u2013600k"),
    (600_000.0, None, "600k+"),
)


def _dataset_analytics(synth: List[Dict], csv_rows: List[Dict], real_rows: List[Dict]) -> Dict:
    """Distribution proof for the UI: sources, income histogram + quantiles."""
    all_rows = list(synth) + list(csv_rows) + list(real_rows)
    incomes: List[float] = []
    needs: List[float] = []
    has_itr = 0
    verified = 0
    for row in all_rows:
        income = _income_of(row)
        if income is None:
            continue
        incomes.append(income)
        try:
            needs.append(float(row.get("financial_need_score") or 0.0))
        except (TypeError, ValueError):
            pass
        if row.get("has_itr"):
            has_itr += 1
        if row.get("ocr_verified"):
            verified += 1

    out: Dict = {
        "sources": {"synthetic": len(synth), "csv": len(csv_rows), "real": len(real_rows)},
        "total": len(all_rows),
        "with_income": len(incomes),
        "coverage": {"has_itr": has_itr, "ocr_verified": verified},
        "need_mean": round(float(np.mean(needs)), 2) if needs else None,
    }
    if not incomes:
        return out

    arr = np.asarray(incomes, dtype=np.float64)
    out["income"] = {
        "min": round(float(arr.min()), 0),
        "p25": round(float(np.percentile(arr, 25)), 0),
        "median": round(float(np.median(arr)), 0),
        "p75": round(float(np.percentile(arr, 75)), 0),
        "max": round(float(arr.max()), 0),
        "mean": round(float(arr.mean()), 0),
    }
    total = len(arr)
    histogram = []
    for low, high, label in _INCOME_BINS:
        mask = np.ones(total, dtype=bool)
        if low is not None:
            mask &= arr > low
        if high is not None:
            mask &= arr <= high
        count = int(mask.sum())
        histogram.append({"label": label, "count": count, "pct": round(100.0 * count / total, 1)})
    out["histogram"] = histogram
    return out


def train(
    real_rows: List[Dict],
    seed: int = _config.DEFAULT_SEED,
    n_trees: int = _config.DEFAULT_N_TREES,
    n_synth: int = _config.DEFAULT_SYNTH_SAMPLES,
    max_depth: int = _config.DEFAULT_MAX_DEPTH,
) -> Dict:
    """Train both forests, persist with joblib, return analytics."""
    from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
    from sklearn.metrics import (
        accuracy_score,
        confusion_matrix,
        f1_score,
        precision_score,
        recall_score,
        roc_auc_score,
        r2_score,
        root_mean_squared_error,
    )
    from sklearn.model_selection import train_test_split
    import joblib

    started = time.time()
    synth = _synthetic_rows(n_synth, seed)
    csv_rows, csv_warnings = _csv_data.load_training_csv()
    rows = synth + csv_rows + list(real_rows)
    dataset = _dataset_analytics(synth, csv_rows, real_rows)

    X, medians = _features.matrix(rows)
    y_cls = np.array(
        [1 if row["priority_target"] >= _config.HIGH_NEED_LABEL_SCORE else 0 for row in rows],
        dtype=np.int64,
    )
    y_reg = np.array([row["priority_target"] for row in rows], dtype=np.float64)

    stratify = y_cls if len(np.unique(y_cls)) > 1 and np.min(np.bincount(y_cls)) >= 2 else None
    X_train, X_test, y_cls_train, y_cls_test, y_reg_train, y_reg_test = train_test_split(
        X,
        y_cls,
        y_reg,
        test_size=0.2,
        random_state=seed,
        stratify=stratify,
    )

    clf = RandomForestClassifier(
        n_estimators=n_trees,
        max_depth=max_depth,
        min_samples_split=5,
        min_samples_leaf=2,
        class_weight="balanced",
        random_state=seed,
        n_jobs=-1,
    )
    clf.fit(X_train, y_cls_train)

    reg = RandomForestRegressor(
        n_estimators=n_trees,
        max_depth=max_depth,
        min_samples_split=5,
        min_samples_leaf=2,
        random_state=seed,
        n_jobs=-1,
    )
    reg.fit(X_train, y_reg_train)

    cls_pred = clf.predict(X_test)
    cls_proba = clf.predict_proba(X_test)[:, 1]
    reg_pred = reg.predict(X_test)

    auc = None
    if len(np.unique(y_cls_test)) > 1:
        auc = float(roc_auc_score(y_cls_test, cls_proba))
    matrix = confusion_matrix(y_cls_test, cls_pred, labels=[0, 1]).tolist()

    importance = {
        name: round(float(value), 5)
        for name, value in zip(_features.FEATURE_COLUMNS, reg.feature_importances_)
    }

    _config.MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_path = _config.MODEL_DIR / f"rf_ranking_seed{seed}.joblib"
    payload = {
        "classifier": clf,
        "regressor": reg,
        "feature_columns": list(_features.FEATURE_COLUMNS),
        "medians": medians,
        "seed": seed,
        "n_trees": n_trees,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "weights": {
            "financial_need": _config.W_NEED,
            "ocr_match": _config.W_OCR,
            "academic": _config.W_ACADEMIC,
        },
    }
    joblib.dump(payload, model_path, compress=3)
    size_kb = round(model_path.stat().st_size / 1024.0, 1)

    return {
        "classifier": clf,
        "regressor": reg,
        "medians": medians,
        "n_samples": int(len(rows)),
        "n_real": int(len(real_rows)),
        "n_synthetic": int(len(synth)),
        "n_csv": int(len(csv_rows)),
        "csv_warnings": list(csv_warnings),
        "dataset": dataset,
        "n_trees": int(n_trees),
        "seed": int(seed),
        "accuracy": round(float(accuracy_score(y_cls_test, cls_pred)), 4),
        "precision": round(float(precision_score(y_cls_test, cls_pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y_cls_test, cls_pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y_cls_test, cls_pred, zero_division=0)), 4),
        "roc_auc": round(auc, 4) if auc is not None else None,
        "confusion_matrix": matrix,
        "r2": round(float(r2_score(y_reg_test, reg_pred)), 4),
        "rmse": round(float(root_mean_squared_error(y_reg_test, reg_pred)), 4),
        "feature_importance": importance,
        "model_path": str(model_path).replace("\\", "/"),
        "model_size_kb": size_kb,
        "train_ms": round((time.time() - started) * 1000, 1),
    }


def _income_for_sort(item: Dict) -> float:
    """Tie-break: the figure the ranking actually used, else the declared one."""
    for key in ("income_used", "declared_income", "ocr_income"):
        value = item.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return math.inf


def predict(rows: List[Dict], trained: Dict) -> List[Dict]:
    """Score every applicant and return them sorted Rank 1 = most needed."""
    if not rows:
        return []
    X, _ = _features.matrix(rows, trained["medians"])
    scores = trained["regressor"].predict(X)
    labels = trained["classifier"].predict(X)
    probabilities = trained["classifier"].predict_proba(X)[:, 1]

    ranked: List[Dict] = []
    for row, score, label, proba in zip(rows, scores, labels, probabilities):
        trust = _features.itr_trust(row)
        ranked.append(
            {
                **{k: row.get(k) for k in (
                    "application_id",
                    "student_name",
                    "student_number",
                    "scholarship",
                    "program",
                    "year_level",
                    "sex",
                    "declared_income",
                    "ocr_income",
                    "income_used",
                    "income_source",
                    "income_delta",
                    "income_corrected",
                    "ocr_match_pct",
                    "ocr_exact_match",
                    "ocr_status",
                    "financial_need_score",
                    "itr_path",
                    "priority_target",
                )},
                "itr_trust": trust,
                "itr_verified": trust == "verified",
                "priority_score": round(float(score), 2),
                "prediction": "High Need" if int(label) == 1 else "Low Need",
                "probability": round(float(proba), 4),
            }
        )

    # Trust gate first: ITR-verified applicants (typed income matches the
    # scanned ITR) are ranked before everyone else; within each group the
    # Random Forest priority score decides, Rank 1 = most in need.
    ranked.sort(
        key=lambda item: (
            0 if item["itr_verified"] else 1,
            -item["priority_score"],
            _income_for_sort(item),
        )
    )
    for position, item in enumerate(ranked, start=1):
        item["rank"] = position
    return ranked
