# Development tools

These scripts are optional development and model-training utilities. They are
not part of the production frontend or FastAPI backend.

## Colab tools

The files in `tools/colab/` are intended to be copied into Google Colab:

- `colab-one-cell.py` - trains the demo model in one Colab cell.
- `colab-cell2-upload.py` - optionally retrains using uploaded historical data.
- `google-colab-training.ipynb` - notebook version of the training workflow.

## Local training tools

The files in `tools/training/` are for local data preparation and experiments.
Production ML code belongs in `backend/ml/`.
