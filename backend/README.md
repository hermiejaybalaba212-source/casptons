# Backend

This folder contains the Python backend for the scholarship system.

## Run locally

From the repository root:

```powershell
py -3 -m pip install -r backend\requirements.txt
cd backend
py -3 -m uvicorn app.main:app --reload --port 8000
```

The FastAPI service is available at `http://localhost:8000`.

## Endpoints

- `GET /` - backend health check
- `POST /pipeline` - OCR and Random Forest ranking stream

The OCR, ranking, storage, and spreadsheet processing code is in `backend/ml/`.
