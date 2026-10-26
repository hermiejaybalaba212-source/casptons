# Scholarship Management System

A full-stack scholarship management system for a college (SPC). Students apply to
scholarship programs, submit supporting documents and CHED application forms, and are
ranked by a Machine Learning (Random Forest) model written in TypeScript. CHED personnel
and an Administrator review, approve, and notify applicants.

## Tech Stack

- **Frontend:** Next.js (App Router), React, Tailwind CSS, TypeScript
- **Database & Auth:** Supabase (PostgreSQL + RLS) — main project + a separate registrar project
- **ML Ranking:** Python — OCR (RapidOCR / onnxruntime-DirectML) + scikit-learn Random Forest, in `ml/`

The ranking pipeline lives in `ml/pipeline.py`. It is exposed through the Next.js route
`app/api/ml/ocr-rank/route.ts`, which either spawns the local Python interpreter
(`PYTHON_BIN` → `python` → `py -3`) or, when `ML_URL` is set, calls the FastAPI service
`ml/service.py` (see `vercel.json`), so **one deploy covers app + ML**.

> A second, pure-TypeScript Random Forest exists in `lib/ml/` and backs the
> `/api/ml/train|predict|run|health|parse-csv` routes. It is a standalone/legacy path —
> the Ranking page uses the Python pipeline, not these routes.

## Features

- **Student:** register, apply to scholarship programs, upload documents (COR, Valid ID,
  Signature Form, Academic Record) and academic records, view application status & notifications.
- **Admin:** manage applications (status filter, batch approve/reject/notify, notify missing
  documents, full detail view, CSV export), run ML ranking, approve beneficiaries.
- **CHED:** review ranking result, manage applications (mirrors Admin), approve beneficiaries,
  export final list.
- **Faculty:** early warning alerts and interventions.
- **Business rule:** a student may apply to multiple programs, but approving **one** application
  automatically marks all their other applications as **Not Approved** and notifies them.
- **Notifications:** bell with unread badge across all dashboards.

## Roles

| Role | Access |
|------|--------|
| Student | Apply, upload docs, view status |
| Faculty | Alerts, interventions |
| CHED | Applications (manage), Ranking Result, Approvals |
| Admin | Applications (manage), Ranking, Approvals, Programs, Users |

## Getting Started (local)

```bash
npm install
py -3 -m pip install -r ml/requirements.txt   # OCR + Random Forest (ranking only)
npm run dev        # app on http://localhost:3000
```

Copy `.env.local.example` to `.env.local` and fill in the Supabase values
(see `DEPLOYMENT.md`). Without them every page fails with
`Supabase is not configured`.

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the Vercel deployment guide.