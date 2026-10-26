# AI OCR + Random Forest ranking pipeline

Python side of the ranking feature. It reads every ITR image uploaded to the
`itr-documents` Supabase bucket with OCR, compares the figure it reads against the
income the applicant typed, then trains a Random Forest that ranks applicants so
**Rank 1 = highest priority = most in need of financial assistance**.

## Tools used

| Step | Tool | Version |
| --- | --- | --- |
| Runtime | Python | 3.14.3 |
| Image preprocessing (decode, upscale, normalize, Otsu, deskew) | Pillow | 12.3.0 |
| Numerics, feature matrix, median imputation | NumPy | 2.5.3 |
| Median/rank maths inside the preprocessor | SciPy | 1.18.1 |
| Text detection + recognition (OCR) | rapidocr-onnxruntime (PP-OCRv3) | 1.2.3 |
| OCR inference runtime | onnxruntime-directml (GPU) | 1.24.4 |
| OCR model OpenCV dependency | opencv-python | 5.0.0.93 |
| Random Forest classifier + regressor, metrics | scikit-learn | 1.9.1 |
| Model persistence (`rf_ranking_seed2026.joblib`) | joblib | 1.6.0 |
| Storage, streaming, process bridge | Node.js / Next.js route handler | `app/api/ml/ocr-rank/route.ts` |

Install: `py -3 -m pip install -r ml\requirements.txt` (install `onnxruntime-directml`
last so it replaces the stock ONNX runtime).

## Files

- `config.py` - `.env.local` loader, priority weights, income limits, stack versions.
- `preproc.py` - image decode / enhancement / candidate variants.
- `ocr_engine.py` - RapidOCR wrapper: DirectML execution provider, keyword-based
  extraction of the family annual income, declared-vs-OCR comparison.
- `cache.py` - OCR result cache keyed by `path|size|updated_at` (skips unchanged files).
- `features.py` - the 8 model features, financial-need score, priority target.
- `rank_model.py` - synthetic training rows, RandomForest fit, metrics, joblib dump.
- `storage.py` - recursive bucket listing + signed URL download (service role key).
- `pipeline.py` - NDJSON CLI: `echo '{...}' | python ml\pipeline.py`.

## Contract

Input (stdin JSON): `mode` (`scan` | `rank` | `full`), `seed`, `n_trees`, `n_synth`,
`applicants[]` (`application_id`, `student_name`, `declared_income`, `itr_path`,
`year_level`, `sex`, `shs_gwa`, `college_gpa`), optional `ocr_results[]`.

Output (stdout, one JSON object per line): `start`, `log`, `doc`, `doc_result`,
`scan_progress`, `scan_analytics`, `preprocess`, `train`, `rank`, `done`, `error`.
Every event carries `t` = seconds since the process started.

## Priority model

`priority_target = 0.60 * financial_need_score + 0.25 * ocr_match_pct + 0.15 * academic_norm`

- `financial_need_score` - 100 at or below the income floor (100k), 0 at the ceiling (600k).
- `ocr_match_pct` - how close the OCR figure is to the declared income (`1 - diff/max`).
- `academic_norm` - normalised SHS GWA / college GPA.

The regressor predicts `priority_score` (sorted descending -> Rank 1) and the
classifier reports `High Need` / `Low Need`.

## Performance on the reference machine (AMD Athlon 300GE, 2C/4T)

| Path | Time |
| --- | --- |
| Cold scan of a real 2-page ITR (fast pass, `box_thresh=0.75`) | ~60-75 s |
| Full-detail retry (`box_thresh=0.5`) | ~50 s extra |
| Cached scan (unchanged file) | instant |
| `from sklearn.ensemble import ...` first import | 7-41 s (warmed in background during the scan) |
| Random Forest training (801 rows, 100 trees) | ~5-10 s |
| End-to-end cold `mode=full` | ~85 s |
| End-to-end warm `mode=full` | ~39 s |

Optimisations already applied: DirectML execution provider, angle classification
disabled, strict-first/threshold escalation (`0.75 -> 0.5`), OCR result cache,
sub-500 px files skipped, scikit-learn import warmed in a background thread.
