import sys
import tempfile
import unittest
from io import BytesIO
import contextlib
import io
import json
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import joblib

from ml import features
from ml.csv_data import _resolve, row_from
from ml.pipeline import build_docs
from ml.rank_model import load_external, predict, train
from ml.service import MAX_SHEET_BYTES, _parse_sheet


class ForestStub:
    feature_importances_ = [0.7, 0.3]
    n_estimators = 200
    n_features_in_ = 2

    def predict(self, rows):
        return [0 for _ in rows]


class FixedScoreRegressor:
    def __init__(self, scores):
        self.scores = scores

    def predict(self, rows):
        return self.scores


class RankingAnalyticsTests(unittest.TestCase):
    def test_sheet_reader_parses_upload_bytes(self):
        parsed = _parse_sheet(
            "previous-applications.csv",
            b"Student ID,Program,Year Level\n1001,Computer Science,2\n1002,Nursing,3\n",
        )

        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["columns"], ["Student ID", "Program", "Year Level"])
        self.assertEqual(parsed["row_count"], 2)
        self.assertEqual(parsed["year_kind"], "level")

    def test_sheet_reader_parses_excel_upload_bytes(self):
        workbook = Workbook()
        worksheet = workbook.active
        worksheet.append(["Student ID", "Program", "Year Level"])
        worksheet.append([1001, "Computer Science", 2])
        content = BytesIO()
        workbook.save(content)

        parsed = _parse_sheet("previous-applications.xlsx", content.getvalue())

        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["row_count"], 1)
        self.assertEqual(parsed["rows"][0]["Student ID"], "1001")
        self.assertEqual(parsed["year_kind"], "level")

    def test_sheet_reader_rejects_bad_type_and_oversized_upload(self):
        with self.assertRaises(HTTPException) as bad_type:
            _parse_sheet("legacy.xls", b"")
        with self.assertRaises(HTTPException) as too_large:
            _parse_sheet("oversized.csv", b"x" * (MAX_SHEET_BYTES + 1))

        self.assertEqual(bad_type.exception.status_code, 400)
        self.assertEqual(too_large.exception.status_code, 413)

    def test_training_loader_marks_observed_npcinc_labels_separately(self):
        resolved = _resolve({"toinc": "TOINC", "npcinc": "NPCINC"})
        observed = row_from({"TOINC": "120000", "NPCINC": "4"}, resolved, income_ranked=True)
        proxy = row_from({"TOINC": "120000"}, resolved, income_ranked=True)

        self.assertEqual(observed["priority_target"], 100.0)
        self.assertEqual(observed["target_source"], "npcinc")
        self.assertEqual(proxy["target_source"], "income_proxy")

    def test_build_docs_only_includes_selected_applicant_itr_files(self):
        applicants = [
            {
                "itr_path": f"student/{index}.png",
                "application_id": index,
                "declared_income": 100_000,
            }
            for index in range(1, 10)
        ]
        bucket_files = [
            {"path": f"student/{index}.png", "size": 50_000, "updated_at": None}
            for index in range(1, 41)
        ]

        with patch("ml.pipeline.storage.list_all", return_value=bucket_files):
            docs = build_docs(applicants)

        self.assertEqual(len(docs), 9)
        self.assertTrue(all(doc["linked"] for doc in docs))
        self.assertEqual({doc["application_id"] for doc in docs}, set(range(1, 10)))

    def test_external_model_restores_saved_training_analytics(self):
        analytics = {
            "accuracy": 0.741,
            "precision": 0.755,
            "recall": 0.802,
            "f1": 0.777,
            "roc_auc": 0.7945,
            "evaluation": {
                "available": True,
                "source": "observed NPCINC <= 4",
                "n_test": 200,
                "n_train": 800,
            },
            "confusion_matrix": [[100, 20], [15, 80]],
            "r2": 0.61,
            "rmse": 12.3,
            "feature_importance": {"annual_income_family": 0.7, "year_level": 0.3},
            "dataset": {"total": 10_006, "sources": {"csv": 10_006, "synthetic": 0, "real": 0}},
            "train_ms": 3_732.4,
        }
        payload = {
            "regressor": ForestStub(),
            "feature_columns": ["annual_income_family", "year_level"],
            "n_samples": 10_006,
            "n_csv": 10_006,
            "n_trees": 200,
            "analytics": analytics,
        }

        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "scholarship_rf_model.joblib"
            joblib.dump(payload, model_path)

            model = load_external(path=model_path)

        self.assertEqual(model["accuracy"], analytics["accuracy"])
        self.assertEqual(model["f1"], analytics["f1"])
        self.assertEqual(model["roc_auc"], analytics["roc_auc"])
        self.assertEqual(model["confusion_matrix"], analytics["confusion_matrix"])
        self.assertEqual(model["dataset"], analytics["dataset"])
        self.assertEqual(model["evaluation"], analytics["evaluation"])
        self.assertEqual(model["feature_importance"], analytics["feature_importance"])

    def test_external_model_hides_legacy_proxy_metrics_without_label_provenance(self):
        payload = {
            "regressor": ForestStub(),
            "feature_columns": ["annual_income_family", "year_level"],
            "analytics": {"accuracy": 0.99, "f1": 0.99, "roc_auc": 1.0},
        }
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "legacy.joblib"
            joblib.dump(payload, model_path)
            model = load_external(path=model_path)

        self.assertFalse(model["evaluation"]["available"])
        self.assertIsNone(model["accuracy"])
        self.assertIsNone(model["f1"])
        self.assertIsNone(model["roc_auc"])

    def test_training_persists_analytics_with_deployed_model(self):
        rows = []
        for index in range(60):
            income = 30_000 + index * 10_000
            label = index % 2
            rows.append(
                {
                    "annual_income_family": income,
                    "monthly_income_equiv": features.monthly_income_equiv(income),
                    "is_train_tax_exempt": features.is_train_tax_exempt(income),
                    "is_ched_priority_ceiling": features.is_ched_priority_ceiling(income),
                    "itr_income_bracket": features.itr_income_bracket(income),
                    "priority_target": 100.0 if label else 0.0,
                    "target_source": "npcinc",
                    "npcinc": 4 if label else 5,
                    "income_used": income,
                    "financial_need_score": features.financial_need_score(income),
                    "has_itr": 1,
                    "ocr_verified": 1,
                }
            )

        with tempfile.TemporaryDirectory() as directory:
            model_dir = Path(directory)
            with (
                patch("ml.rank_model._config.MODEL_DIR", model_dir),
                patch("ml.storage.upload"),
            ):
                trained = train(
                    [],
                    seed=42,
                    n_trees=5,
                    n_synth=0,
                    max_depth=3,
                    min_samples_leaf=1,
                    income_ranked=True,
                    csv_rows_override=rows,
                    columns=features.NOTEBOOK_FEATURE_COLUMNS,
                )
                restored = load_external(path=trained["deployed_path"])
                payload = joblib.load(trained["deployed_path"])

        self.assertTrue(trained["persisted"])
        self.assertTrue(trained["evaluation"]["available"])
        self.assertEqual(trained["evaluation"]["n_test"], 12)
        self.assertEqual(payload["analytics"]["accuracy"], trained["accuracy"])
        self.assertEqual(restored["accuracy"], trained["accuracy"])
        self.assertEqual(restored["f1"], trained["f1"])
        self.assertEqual(restored["roc_auc"], trained["roc_auc"])
        self.assertEqual(restored["dataset"], trained["dataset"])
        self.assertEqual(restored["evaluation"], trained["evaluation"])
        self.assertTrue(restored["persisted"])

    def test_income_proxy_targets_are_not_reported_as_model_accuracy(self):
        rows = []
        for index in range(60):
            income = 30_000 + index * 10_000
            need = features.financial_need_score(income)
            rows.append(
                {
                    "annual_income_family": income,
                    "monthly_income_equiv": features.monthly_income_equiv(income),
                    "is_train_tax_exempt": features.is_train_tax_exempt(income),
                    "is_ched_priority_ceiling": features.is_ched_priority_ceiling(income),
                    "itr_income_bracket": features.itr_income_bracket(income),
                    "priority_target": need,
                    "income_used": income,
                    "financial_need_score": need,
                    "has_itr": 1,
                    "ocr_verified": 1,
                }
            )

        with tempfile.TemporaryDirectory() as directory:
            with patch("ml.rank_model._config.MODEL_DIR", Path(directory)):
                trained = train(
                    [],
                    seed=42,
                    n_trees=5,
                    n_synth=0,
                    max_depth=3,
                    min_samples_leaf=1,
                    income_ranked=True,
                    csv_rows_override=rows,
                    columns=features.NOTEBOOK_FEATURE_COLUMNS,
                )

        self.assertFalse(trained["evaluation"]["available"])
        self.assertEqual(trained["evaluation"]["n_test"], 0)
        self.assertIsNone(trained["accuracy"])
        self.assertIsNone(trained["f1"])
        self.assertIsNone(trained["roc_auc"])

    def test_income_order_uses_reliable_ocr_income_before_match_status_or_model_score(self):
        rows = [
            {
                "application_id": 1,
                "income_used": 100_000,
                "annual_income_family": 100_000,
                "has_itr": 0,
                "ocr_match_pct": 0,
            },
            {
                "application_id": 2,
                "income_used": 200_000,
                "annual_income_family": 200_000,
                "has_itr": 1,
                "ocr_match_pct": 100,
            },
            {
                "application_id": 3,
                "income_used": 150_000,
                "annual_income_family": 150_000,
                "has_itr": 1,
                "ocr_match_pct": 10,
            },
        ]
        model = {
            "regressor": FixedScoreRegressor([1, 100, 50]),
            "classifier": None,
            "feature_columns": ["annual_income_family"],
            "medians": {"annual_income_family": 0},
        }

        ranked = predict(rows, model)

        self.assertEqual([row["application_id"] for row in ranked], [1, 3, 2])
        self.assertEqual([row["rank"] for row in ranked], [1, 2, 3])

    def test_uploaded_training_and_ranking_uses_one_fresh_file_only_model(self):
        from ml import csv_data, pipeline

        training_rows = [{"annual_income_family": 90_000, "priority_target": 100}]
        training_result = {
            "classifier": object(),
            "regressor": object(),
            "medians": {},
            "feature_columns": list(features.NOTEBOOK_FEATURE_COLUMNS),
            "n_samples": 1,
            "n_real": 0,
            "n_synthetic": 0,
            "n_csv": 1,
            "n_trees": 200,
            "seed": 42,
            "evaluation": {"available": True, "source": "observed NPCINC <= 4", "n_test": 1, "n_train": 0},
            "feature_importance": {},
            "dataset": {"sources": {"csv": 1, "synthetic": 0, "real": 0}, "total": 1},
            "model_path": "model.joblib",
            "model_size_kb": 1,
            "deployed_path": "scholarship_rf_model.joblib",
            "persisted": True,
            "train_ms": 1,
            "csv_warnings": [],
        }
        ranked_rows = [
            {
                "application_id": 10,
                "rank": 1,
                "priority_score": 99,
                "prediction": "High Need",
                "financial_need_score": 96,
                "ocr_match_pct": 0,
                "income_used": 120_000,
                "income_source": "declared",
            }
        ]
        payload = {
            "mode": "rank",
            "train_uploaded": True,
            "seed": 42,
            "n_trees": 200,
            "n_synth": 0,
            "max_depth": 3,
            "min_samples_leaf": 200,
            "applicants": [
                {
                    "application_id": 10,
                    "student_name": "Test Applicant",
                    "declared_income": 120_000,
                    "itr_path": None,
                }
            ],
        }
        output = io.StringIO()

        with (
            patch("sys.stdin", io.StringIO(json.dumps(payload))),
            patch("sys.stdout", output),
            patch.object(csv_data, "load_training_csv", return_value=(training_rows, [])),
            patch.object(pipeline.storage, "list_all", return_value=[]),
            patch.object(pipeline.rank_model, "train", return_value=training_result) as train_mock,
            patch.object(pipeline.rank_model, "predict", return_value=ranked_rows) as predict_mock,
        ):
            result = pipeline.main()

        self.assertEqual(result, 0, output.getvalue())
        train_kwargs = train_mock.call_args.kwargs
        self.assertEqual(train_kwargs["n_synth"], 0)
        self.assertTrue(train_kwargs["income_ranked"])
        self.assertEqual(train_kwargs["csv_rows_override"], training_rows)
        self.assertEqual(train_kwargs["columns"], features.NOTEBOOK_FEATURE_COLUMNS)
        predict_mock.assert_called_once()
        events = [json.loads(line) for line in output.getvalue().splitlines() if line.startswith("{")]
        self.assertTrue(any(event.get("type") == "train" for event in events))
        self.assertTrue(any(event.get("type") == "rank" for event in events))
        self.assertTrue(next(event for event in events if event.get("type") == "done")["ok"])


if __name__ == "__main__":
    unittest.main()
