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
| OCR inference runtime | ONNX Runtime (CPU on Vercel, DirectML GPU on Windows) | 1.24.4+ |
| OCR model OpenCV dependency | opencv-python | 5.0.0.93 |
| Random Forest classifier + regressor, metrics | scikit-learn | 1.9.1 |
| Model persistence (`rf_ranking_seed2026.joblib`) | joblib | 1.6.0 |
| Storage, streaming, process bridge | FastAPI service | `backend/app/main.py` and `backend/ml/service.py` |

Install: `py -3 -m pip install -r backend\requirements.txt` (install `onnxruntime-directml`
last so it replaces the stock ONNX runtime).

## Files

- `config.py` - `.env.local` loader, priority weights, income limits, stack versions.
- `preproc.py` - image decode / enhancement / candidate variants.
- `ocr_engine.py` - RapidOCR wrapper: DirectML execution provider, keyword-based
  extraction of the family annual income, declared-vs-OCR comparison.
- `cache.py` - OCR result cache keyed by `path|size|updated_at` (skips unchanged files).
- `features.py` - the model feature set, financial-need score, priority target.
- `rank_model.py` - synthetic training rows, RandomForest fit, metrics, joblib dump.
- `storage.py` - recursive bucket listing + signed URL download (service role key).
- `pipeline.py` - NDJSON CLI: `echo '{...}' | python ml\pipeline.py`.
- `service.py` - internal FastAPI endpoints for the ranking pipeline and CSV / Excel sheet parsing (`POST /parse-sheet`). Vercel's Node.js app delegates sheet parsing here instead of requiring Python in its runtime.

## Contract

Input (stdin JSON): `mode` (`scan` | `rank` | `full`), `seed`, `n_trees`, `n_synth`,
`applicants[]` (`application_id`, `student_name`, `declared_income`, `itr_path`,
`year_level`, `sex`, `shs_gwa`, `college_gpa`), optional `ocr_results[]`.

Output (stdout, one JSON object per line): `start`, `log`, `doc`, `doc_result`,
`scan_progress`, `scan_analytics`, `preprocess`, `train`, `rank`, `done`, `error`.
Every event carries `t` = seconds since the process started.

## Training and applicant ranking

The uploaded-file training uses the Colab notebook's five income-derived
features and binary target (`NPCINC <= 4`), with the same 80/20 stratified
split, seed 42, 200 trees, depth 3 and minimum leaf size 200. If a program is
selected when **Execute AI Ranking** is clicked, the pipeline scans that
program's ITRs, freshly trains from the uploaded file only, and ranks those
applicants with that same model. With no program selected, the action performs
file-only training and displays its evaluation and dataset analytics.

The classifier reports its predicted priority class and probability; the
companion regressor reports a priority score. The final applicant order is
deterministically sorted by the effective annual family income, ascending:
a reliable OCR-read ITR amount corrects the typed amount, otherwise the
declared amount is used. Thus Rank 1 is the applicant with the lowest usable
annual income, and rows without any usable income sort last. OCR match status,
model probability and priority score remain visible as separate review
analytics; a mismatch does not silently place a higher-income applicant first.

The dataset summary and model analytics are stored inside the deployed model
artifact in Supabase Storage. Accuracy, precision, recall, F1, ROC-AUC, R², and
RMSE are evaluated only on held-out rows with an observed `NPCINC` target
(`NPCINC <= 4`); income-derived proxy labels are used for ranking but never
reported as independent model-quality metrics. If the uploaded dataset has no
observed `NPCINC` labels, the UI says independent evaluation is unavailable.
Model-evaluation analytics and live OCR/ranking analytics are displayed
separately so validation against held-out training labels is not confused with
the current applicants' OCR match results.

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
