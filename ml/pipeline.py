#!/usr/bin/env python
"""NDJSON pipeline: OCR every uploaded ITR, verify it, then rank with a
Random Forest. Progress is streamed line-by-line on stdout.

    echo '{...}' | python ml/pipeline.py

Event types: start, log, doc, doc_result, scan_progress, scan_analytics,
preprocess, train, rank, done, error.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# NDJSON is UTF-8. On Windows the default stdout/stderr codecs are cp1252,
# which cannot encode e.g. the peso sign in dataset labels - force UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass

from ml import cache as ocr_cache
from ml import config as cfg
from ml import features as ft
from ml import ocr_engine, preproc, rank_model, storage

# Fast pass first: a strict box threshold keeps only high-confidence text
# boxes (71 vs 187 on the reference ITR) and still reaches the income line.
# If no income label survives it, the full-detail pass runs before giving up.
THRESHOLD_LEVELS = (0.75, 0.5)


START_TIME = time.time()


def emit(payload: dict) -> None:
    payload.setdefault("t", round(time.time() - START_TIME, 2))
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def log(message: str, **extra) -> None:
    emit(
        {
            "type": "log",
            "msg": message,
            **extra,
        }
    )


def _peso(value) -> str:
    if value is None:
        return "PHP -"
    try:
        return f"PHP {float(value):,.0f}"
    except (TypeError, ValueError):
        return str(value)


def storage_index() -> dict:
    """path -> {size, updated_at} for every object in the ITR bucket."""
    try:
        return {item["path"]: item for item in storage.list_all(cfg.STORAGE_BUCKET)}
    except Exception as exc:  # storage is optional for a pure scan
        log(f"Storage listing skipped: {exc}")
        return {}


def build_docs(applicants: list) -> list:
    index = storage_index()
    docs = []
    seen = set()

    for applicant in applicants:
        path = applicant.get("itr_path")
        if not path:
            continue
        meta = index.get(path, {})
        docs.append(
            {
                "path": path,
                "size": meta.get("size"),
                "updated_at": meta.get("updated_at"),
                "application_id": applicant.get("application_id"),
                "student_name": applicant.get("student_name"),
                "declared_income": applicant.get("declared_income"),
                "linked": True,
            }
        )
        seen.add(path)

    for path, meta in index.items():
        if path in seen:
            continue
        docs.append(
            {
                "path": path,
                "size": meta.get("size"),
                "updated_at": meta.get("updated_at"),
                "application_id": None,
                "student_name": None,
                "declared_income": None,
                "linked": False,
            }
        )

    docs.sort(key=lambda d: (not d["linked"], d["path"]))
    return docs


def scan_documents(docs: list) -> tuple:
    """OCR every document -> ({path: result}, scan analytics)."""
    total = len(docs)
    results: dict = {}
    started = time.time()
    cache_hits = 0

    for index, doc in enumerate(docs, start=1):
        path = doc["path"]
        emit(
            {
                "type": "doc",
                "index": index,
                "total": total,
                "path": path,
                "student_name": doc.get("student_name"),
                "declared_income": doc.get("declared_income"),
                "status": "scanning",
            }
        )

        cached = ocr_cache.get(path, doc.get("size"), doc.get("updated_at"))
        if cached:
            cache_hits += 1
            record = {**cached, "cached": True}
            record["application_id"] = doc.get("application_id")
            record["student_name"] = doc.get("student_name")
            record["declared_income"] = doc.get("declared_income")
            record["linked"] = doc["linked"]
            record["match"] = ocr_engine.match_declared(
                record.get("ocr_value"), doc.get("declared_income")
            )
            log(f"[{index}/{total}] {path} - cached OCR result reused ({record.get('ocr_ms', 0)} ms)")
        else:
            log(f"[{index}/{total}] Scanning {path}")
            record = _scan_one(doc)

        if not record["error"] and not doc["linked"]:
            record["error"] = "No application linked to this ITR file"

        if not record["cached"]:
            ocr_cache.put(path, doc.get("size"), doc.get("updated_at"), record)

        results[path] = record
        annotate_record(record)
        status = (
            "skipped"
            if record.get("skipped")
            else ("error" if record.get("error") else "done")
        )
        emit(
            {
                "type": "doc_result",
                "index": index,
                "total": total,
                "status": status,
                "cached": bool(record.get("cached")),
                "record": record,
            }
        )
        emit({"type": "scan_progress", "done": index, "total": total})

    elapsed = time.time() - started
    stats = analytics_from(results, elapsed)
    stats["cache_hits"] = cache_hits
    return results, stats


def _scan_one(doc: dict) -> dict:
    """Download + preprocess + OCR a single ITR document."""
    path = doc["path"]
    record = {
        "path": path,
        "application_id": doc.get("application_id"),
        "student_name": doc.get("student_name"),
        "declared_income": doc.get("declared_income"),
        "linked": doc["linked"],
        "ocr_value": None,
        "match": {"exact_match": False, "align_pct": 0.0, "diff": None, "status": "not_comparable"},
        "confidence": 0.0,
        "ocr_ms": 0.0,
        "line_count": 0,
        "preview": [],
        "method": None,
        "variant": None,
        "box_thresh": None,
        "attempts": 0,
        "image": {},
        "cached": False,
        "skipped": None,
        "error": None,
    }

    try:
        blob = storage.download(cfg.STORAGE_BUCKET, path)
        rgb, meta = preproc.decode(blob)
        record["image"] = {**meta, **preproc.image_stats(rgb), "bytes": len(blob)}

        # Storage also holds icons/thumbnails; OCR'ing them only burns time and
        # drags the detection rate down. A real ITR page is never this small.
        if min(rgb.shape[:2]) < 500 or len(blob) < 20_000:
            record["skipped"] = f"{rgb.shape[1]}x{rgb.shape[0]} px - not an ITR page"
            record["error"] = "Skipped: image too small to be a document page"
            log(f"      skipped ({rgb.shape[1]}x{rgb.shape[0]} px, {len(blob)} bytes)")
            return record

        if ocr_engine.peek() is None:
            log("Loading the RapidOCR engine (ONNX Runtime + DirectML GPU)...")
        engine = ocr_engine.shared()
        candidates = preproc.build_candidates(rgb)

        for position, candidate in enumerate(candidates):
            final_variant = position == len(candidates) - 1
            levels = THRESHOLD_LEVELS if position == 0 else (THRESHOLD_LEVELS[-1],)
            for level_index, threshold in enumerate(levels):
                record["attempts"] += 1
                outcome = engine.scan(
                    candidate["array"],
                    box_thresh=threshold,
                    allow_fallback=final_variant,
                )
                record["line_count"] = outcome["line_count"]
                record["confidence"] = outcome["avg_confidence"]
                record["ocr_ms"] = round(record["ocr_ms"] + outcome["ocr_ms"], 1)
                record["preview"] = [
                    {"text": line["text"], "score": round(line["score"], 3)}
                    for line in outcome["lines"][: cfg.OCR_LINE_PREVIEW]
                ]
                record["box_thresh"] = threshold

                if outcome["extracted"]:
                    record["ocr_value"] = outcome["extracted"]["value"]
                    record["method"] = outcome["extracted"]["method"]
                    record["low_confidence"] = bool(outcome["extracted"].get("low_confidence"))
                    record["anchor"] = outcome["extracted"].get("anchor")
                    record["amount_line"] = outcome["extracted"].get("amount_line")
                    record["confidence"] = outcome["extracted"]["confidence"]
                    record["variant"] = candidate["name"]
                    record["steps"] = candidate["steps"]
                    break

                log(
                    f"      no income label at box_thresh={threshold} on '{candidate['name']}' "
                    f"({outcome['line_count']} lines)"
                    + (
                        " -> escalating to the full-detail pass"
                        if level_index < len(levels) - 1
                        else ""
                    )
                )

            if record["ocr_value"] is not None:
                break
            if position < len(candidates) - 1:
                log(
                    f"      retrying preprocessing: "
                    f"'{candidate['name']}' -> '{candidates[position + 1]['name']}'"
                )

        record["match"] = ocr_engine.match_declared(
            record["ocr_value"], doc.get("declared_income")
        )
        if record["ocr_value"] is None:
            record["error"] = "No income value detected in the ITR image"

    except Exception as exc:
        record["error"] = str(exc)
        log(f"      failed: {exc}")

    return record


def annotate_record(record: dict) -> dict:
    """Per-document: typed-income accuracy + the income/need score ranking uses."""
    typed = record.get("declared_income")
    ocr_value = record.get("ocr_value")
    record["accuracy_pct"] = (
        round(float(record["match"]["align_pct"]), 2)
        if typed is not None and ocr_value is not None and record.get("match")
        else None
    )
    income, source = ft.effective_income(typed, ocr_value, bool(record.get("low_confidence")))
    record["income_used"] = income
    record["income_source"] = source
    record["income_delta"] = (
        round(float(ocr_value) - float(typed), 2)
        if typed is not None and ocr_value is not None
        else None
    )
    record["need_score"] = ft.financial_need_score(income) if typed is not None or ocr_value is not None else None
    return record


def analytics_from(results: dict, elapsed: float, engine=None) -> dict:
    all_records = list(results.values())
    records = [r for r in all_records if not r.get("skipped")]
    skipped = [r for r in all_records if r.get("skipped")]
    linked = [r for r in records if r["linked"]]
    comparable = [r for r in linked if r["ocr_value"] is not None and r["declared_income"] is not None]
    exact = [r for r in comparable if r["match"]["exact_match"]]
    detected = [r for r in records if r["ocr_value"] is not None]
    aligned = [r["match"]["align_pct"] for r in comparable]
    confidences = [r["confidence"] for r in records if r["confidence"]]

    for rec in linked:
        if rec.get("need_score") is None:
            annotate_record(rec)

    need_scores = [r["need_score"] for r in linked if r.get("need_score") is not None]

    engine_obj = engine or ocr_engine.peek()
    return {
        "documents_in_bucket": len(all_records),
        "documents_scanned": len(records),
        "skipped_documents": len(skipped),
        "linked_to_application": len(linked),
        "unlinked": len(records) - len(linked),
        "income_detected": len(detected),
        "detection_rate_pct": round(100.0 * len(detected) / len(records), 2) if records else 0.0,
        "comparable": len(comparable),
        "exact_matches": len(exact),
        "mismatches": len(comparable) - len(exact),
        "match_rate_pct": round(100.0 * len(exact) / len(comparable), 2) if comparable else 0.0,
        "avg_align_pct": round(sum(aligned) / len(aligned), 2) if aligned else 0.0,
        "typed_accuracy_pct": round(sum(aligned) / len(aligned), 2) if aligned else 0.0,
        "avg_need_score": round(sum(need_scores) / len(need_scores), 2) if need_scores else None,
        "avg_confidence": round(sum(confidences) / len(confidences), 4) if confidences else 0.0,
        "total_ocr_ms": round(sum(r["ocr_ms"] for r in records), 1),
        "engine_load_ms": engine_obj.load_ms if engine_obj else 0.0,
        "engine": (engine_obj.engine_info if engine_obj and engine_obj.engine_info else {"status": "engine not loaded (all documents served from cache)"}),
        "scan_seconds": round(elapsed, 2),
    }


def index_by_application(scan_results: dict) -> dict:
    out: dict = {}
    for record in scan_results.values():
        app_id = record.get("application_id")
        if app_id is None:
            continue
        out[int(app_id)] = record
    return out


ML_WARM = threading.Event()


def _warm_ml_stack() -> None:
    """Import scikit-learn up front.

    On this machine the first ``from sklearn.ensemble import ...`` takes ~40 s,
    so it is started at t=0 and overlaps the OCR scan instead of blocking the
    ranking step.
    """
    try:
        from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor  # noqa: F401
        from sklearn.metrics import accuracy_score, roc_auc_score  # noqa: F401
        from sklearn.model_selection import train_test_split  # noqa: F401
        import joblib  # noqa: F401
    except Exception:
        pass
    finally:
        ML_WARM.set()


def main() -> int:
    started = time.time()
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        emit({"type": "error", "message": f"Invalid JSON payload: {exc}"})
        return 1

    mode = str(payload.get("mode") or "full")
    seed = int(payload.get("seed") or cfg.DEFAULT_SEED)
    n_trees = int(payload.get("n_trees") or cfg.DEFAULT_N_TREES)
    n_synth = int(payload.get("n_synth") or cfg.DEFAULT_SYNTH_SAMPLES)
    applicants = list(payload.get("applicants") or [])
    preloaded = {
        int(item["application_id"]): item
        for item in (payload.get("ocr_results") or [])
        if item.get("application_id") is not None
    }

    warm = None

    stack = cfg.stack_info()
    emit(
        {
            "type": "start",
            "mode": mode,
            "applicants": len(applicants),
            "seed": seed,
            "n_trees": n_trees,
            "stack": stack,
            "weights": {"need": cfg.W_NEED, "ocr": cfg.W_OCR, "academic": cfg.W_ACADEMIC},
            "limits": {
                "income_floor": cfg.INCOME_FLOOR,
                "income_ceil": cfg.INCOME_CEIL,
                "high_need_income": cfg.HIGH_NEED_INCOME,
            },
        }
    )
    log(
        f"Python {stack.get('python')} | NumPy {stack.get('numpy')} | "
        f"scikit-learn {stack.get('scikit-learn')} | joblib {stack.get('joblib')} | "
        f"scipy {stack.get('scipy')} | Pillow {stack.get('pillow')}"
    )
    log(f"OCR: rapidocr {stack.get('rapidocr-onnxruntime')} | onnxruntime {stack.get('onnxruntime')} (DML)")

    try:
        scan_results: dict = {}
        scan_stats: dict = {}
        needs_scan = mode in ("scan", "full", "rank") and not preloaded

        if needs_scan:
            docs = build_docs(applicants)
            emit(
                {
                    "type": "log",
                    "msg": f"Found {len(docs)} ITR document(s) to scan "
                    f"({len(applicants)} applicant(s) with an uploaded ITR)",
                }
            )
            if not docs:
                log("No ITR documents found in storage - nothing to scan.")
            else:
                misses = [
                    doc
                    for doc in docs
                    if ocr_cache.get(doc["path"], doc.get("size"), doc.get("updated_at")) is None
                ]
                if misses and mode in ("rank", "full"):
                    # Real OCR is about to run: import scikit-learn concurrently so
                    # the ~40 s first import overlaps the scan instead of the ranking.
                    warm = threading.Thread(target=_warm_ml_stack, name="ml-warm", daemon=True)
                    warm.start()
                    log(
                        f"{len(misses)} document(s) need a fresh OCR scan - loading scikit-learn "
                        "in the background (first import costs ~40 s on this CPU) so ranking "
                        "does not wait for it..."
                    )
                scan_results, scan_stats = scan_documents(docs)
                log("OCR scan complete.")
        else:
            log("Reusing OCR results from the previous scan.")
            for app_id, item in preloaded.items():
                scan_results[f"app-{app_id}"] = {
                    "path": item.get("file"),
                    "application_id": app_id,
                    "student_name": item.get("student_name"),
                    "declared_income": item.get("declared_income"),
                    "linked": True,
                    "ocr_value": item.get("ocr_value"),
                    "match": item.get("match")
                    or {"exact_match": False, "align_pct": 0.0, "diff": None, "status": "not_comparable"},
                    "confidence": item.get("confidence") or 0.0,
                    "ocr_ms": 0.0,
                    "line_count": 0,
                    "preview": [],
                    "method": item.get("method"),
                    "variant": None,
                    "variants_tried": 0,
                    "image": {},
                    "error": None,
                }
            scan_stats = analytics_from(scan_results, 0.0)

        emit({"type": "scan_analytics", "analytics": scan_stats})

        ranking: list = []
        training: dict = {}
        if mode in ("rank", "full"):
            by_app = index_by_application(scan_results)
            rows = [ft.build_row(applicant, by_app.get(int(applicant["application_id"]))) for applicant in applicants]

            corrected = [r for r in rows if r.get("income_corrected")]
            for item in corrected:
                log(
                    f"ITR income used for {item['student_name']}: {_peso(item.get('income_used'))} "
                    f"(applicant typed {_peso(item.get('declared_income'))}) - the scanned ITR is the "
                    "source of truth for the financial-need score."
                )
            if not corrected and any(r.get("ocr_income") is not None for r in rows):
                log("OCR income matches the typed income - no correction needed.")
            elif not any(r.get("ocr_income") is not None for r in rows):
                log("No OCR income available - ranking falls back to the typed income.")

            comparable = [r for r in rows if r["ocr_status"] == "match"]
            log(
                f"Preprocessing {len(rows)} applicant(s) -> {len(ft.FEATURE_COLUMNS)} features "
                f"with NumPy (median imputation)."
            )
            log(
                f"Financial-need / OCR-alignment check: {len(comparable)} of {len(rows)} applicant(s) "
                f"match their uploaded ITR exactly."
            )
            verified = [r for r in rows if ft.itr_trust(r) == "verified"]
            unverified = len(rows) - len(verified)
            log(
                f"Trust gate: {len(verified)} applicant(s) verified against their ITR are ranked first; "
                f"{unverified} with a mismatching or missing ITR are ranked last."
            )

            X, medians = ft.matrix(rows)
            emit(
                {
                    "type": "preprocess",
                    "feature_columns": ft.FEATURE_COLUMNS,
                    "matrix_shape": list(X.shape),
                    "medians": {k: round(float(v), 4) for k, v in medians.items()},
                    "rows": [
                        {
                            "application_id": r["application_id"],
                            "student_name": r["student_name"],
                            "income_used": r.get("income_used"),
                            "income_source": r.get("income_source"),
                            "income_delta": r.get("income_delta"),
                            "financial_need_score": r["financial_need_score"],
                            "ocr_match_pct": r["ocr_match_pct"],
                            "priority_target": r["priority_target"],
                        }
                        for r in rows
                    ],
                }
            )

            if not ML_WARM.is_set() and warm is not None and warm.is_alive():
                log("Waiting for the scikit-learn import to finish...")
                ML_WARM.wait(300)
            log(f"Training Random Forest ({n_trees} trees, seed {seed}) on {n_synth} synthetic + {len(rows)} real rows...")
            training = rank_model.train(rows, seed=seed, n_trees=n_trees, n_synth=n_synth)
            if training.get("n_csv"):
                log(
                    f"Loaded {training['n_csv']} historical training row(s) "
                    f"({training['n_samples']} rows total in the fit)."
                )
            for warning in training.get("csv_warnings") or []:
                log(warning)
            emit(
                {
                    "type": "train",
                    **{k: v for k, v in training.items() if k not in ("classifier", "regressor", "medians")},
                }
            )
            log(
                f"Model saved with joblib -> {training['model_path']} "
                f"({training['model_size_kb']} KB) in {training['train_ms']} ms"
            )

            ranking = rank_model.predict(rows, training)
            emit({"type": "rank", "rows": ranking})
            for item in ranking:
                log(
                    f"  #{item['rank']} {item['student_name']} - priority {item['priority_score']} "
                    f"({item['prediction']}, need {item['financial_need_score']}, OCR {item['ocr_match_pct']}%, "
                    f"income {_peso(item.get('income_used'))} from {item.get('income_source', 'declared')})"
                )
            log("Ranking complete: Rank 1 = highest priority = most in need of financial assistance.")

        emit(
            {
                "type": "done",
                "ok": True,
                "mode": mode,
                "scan_analytics": scan_stats,
                "documents": list(scan_results.values()),
                "train": {k: v for k, v in training.items() if k not in ("classifier", "regressor", "medians")},
                "rankings": ranking,
                "total_seconds": round(time.time() - started, 2),
            }
        )
        return 0

    except Exception as exc:
        emit({"type": "error", "message": str(exc), "trace": traceback.format_exc(limit=6)})
        emit({"type": "done", "ok": False, "mode": mode, "total_seconds": round(time.time() - started, 2)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
