import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = [".csv", ".xlsx", ".xlsm", ".xltx"];

/** Uploaded sheets are saved so they survive a refresh, exactly like the ML
 *  training-data panel. One bucket, one folder per page. */
const BUCKET = "imported-sheets";
const SCOPES = new Set(["applications", "approvals"]);

let cachedPython: string | null = null;

function resolvePython(): string {
  if (cachedPython) return cachedPython;
  const candidates: Array<{ bin: string; args: string[] }> = [];
  if (process.env.PYTHON_BIN) {
    candidates.push({ bin: process.env.PYTHON_BIN, args: ["-c", "import sys; print(sys.version)"] });
  }
  candidates.push({ bin: "python", args: ["-c", "import sys; print(sys.version)"] });
  candidates.push({ bin: "py", args: ["-3", "-c", "import sys; print(sys.version)"] });
  if (process.platform === "win32") {
    candidates.push({
      bin: path.join("C:", "Program Files", "Python314", "python.exe"),
      args: ["-c", "import sys; print(sys.version)"],
    });
  }

  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate.bin, candidate.args, {
        windowsHide: true,
        timeout: 15000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (probe.status === 0 && probe.stdout && probe.stdout.toString().trim().startsWith("3")) {
        cachedPython = candidate.bin;
        return cachedPython;
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error("Python 3 was not found. Install Python 3 (or set PYTHON_BIN) so ml/read_sheet.py can run.");
}

function cookieName() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const match = url.match(/https?:\/\/([^./]+)/);
  return `sb-${match ? match[1] : "xflsxzmniseetvkrddmj"}-auth-token`;
}

function getToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7);
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === cookieName()) {
      try {
        const parsed = JSON.parse(decodeURIComponent(rest.join("=")));
        if (parsed?.access_token) return parsed.access_token;
      } catch {
        return rest.join("=");
      }
    }
  }
  return null;
}

/** Same guard as the ML training-data routes: only an Admin may save, read back
 *  or delete an uploaded sheet. */
async function assertAdmin(req: Request) {
  const token = getToken(req);
  if (!token) return "Not authenticated.";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const svc = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await svc.auth.getUser();
  if (error || !data.user) return "Session expired. Please log in again.";
  const { data: row } = await svc.from("users").select("role").eq("auth_user_id", data.user.id).maybeSingle();
  if (!row || row.role !== "Admin") return "Only admins can manage uploaded files.";
  return true;
}

function serviceBucket() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return sb.storage.from(BUCKET);
}

/** Keep the admin's own filename (stripped of separators / leading dots) so the
 *  card can show exactly what was uploaded. */
function objectNameFor(original: string): string {
  const base = original.split(/[\\/]/).pop() || "upload.csv";
  return base.replace(/^[.\s]+/, "").trim() || "upload.csv";
}

/** Two known object names per scope, so replacing and deleting never needs a
 *  folder listing: the raw file plus a JSON sidecar of the parsed sheet. */
function objectsFor(scope: string, original: string) {
  const safe = objectNameFor(original);
  return { raw: `${scope}/${safe}`, sidecar: `${scope}/${safe}.json` };
}

export async function POST(req: Request) {
  const auth = await assertAdmin(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Upload must be multipart/form-data." }, { status: 400 });
  }

  const scope = String(form.get("scope") || "applications");
  if (!SCOPES.has(scope)) {
    return NextResponse.json({ error: `Unknown upload scope "${scope}".` }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file chosen." }, { status: 400 });

  const suffix = path.extname(file.name).toLowerCase();
  if (!ALLOWED.includes(suffix)) {
    return NextResponse.json(
      { error: `Unsupported file type "${suffix || "(none)"}". Use .csv or .xlsx.` },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File must be 20 MB or smaller." }, { status: 400 });
  }

  let pythonBin: string;
  try {
    pythonBin = resolvePython();
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Python unavailable." }, { status: 500 });
  }

  const workDir = mkdtempSync(path.join(tmpdir(), "sheet-"));
  // Keep the original extension: read_sheet.py dispatches on it.
  const savedPath = path.join(workDir, `upload${suffix}`);

  try {
    writeFileSync(savedPath, Buffer.from(await file.arrayBuffer()));

    const reader = path.join(process.cwd(), "ml", "read_sheet.py");
    const result = spawnSync(pythonBin, [reader, savedPath], {
      windowsHide: true,
      timeout: 45000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf-8",
      cwd: process.cwd(),
    });

    const stdout = (result.stdout || "").trim();
    if (!stdout) {
      const detail = (result.stderr || "").trim().split("\n").slice(-4).join(" ");
      return NextResponse.json(
        { error: detail || `Reader exited with code ${result.status ?? "unknown"}.` },
        { status: 500 },
      );
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Reader returned unreadable output." }, { status: 500 });
    }

    if (payload.ok !== true) {
      return NextResponse.json({ error: String(payload.error || "Could not read this file.") }, { status: 400 });
    }

    const sheet = {
      ...payload,
      file_name: file.name,
      file_size: file.size,
    } as Record<string, unknown>;

    // Keep the upload so it survives a refresh: the raw file plus a JSON
    // sidecar of the parsed sheet (restored by GET, removed by DELETE).
    let saveWarning: string | undefined;
    try {
      const bucket = serviceBucket();
      if (!bucket) throw new Error("Server is missing SUPABASE_SERVICE_ROLE_KEY.");
      const { raw, sidecar } = objectsFor(scope, file.name);
      // Clear first: overwriting an object of the same name is not guaranteed.
      await bucket.remove([raw, sidecar]).catch(() => {});
      const bytes = Buffer.from(await file.arrayBuffer());
      await bucket.upload(raw, bytes, { contentType: file.type || "application/octet-stream", upsert: false });
      await bucket.upload(sidecar, JSON.stringify(sheet), { contentType: "application/json", upsert: false });
    } catch (err: unknown) {
      saveWarning = `Could not save this file for later (a refresh will lose it): ${
        err instanceof Error ? err.message : "storage unavailable"
      }`;
    }

    return NextResponse.json({ ...sheet, saved: !saveWarning, warning: saveWarning });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read this file." },
      { status: 500 },
    );
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
}

interface RawEntry {
  name: string;
  metadata?: { size?: number; mimetype?: string } | null;
  updated_at?: string;
  created_at?: string;
}

/** Re-run the reader over a stored upload, used when the JSON sidecar is
 *  missing. Same call shape as the POST handler above. */
function readStoredFile(bytes: Buffer, name: string): Record<string, unknown> | null {
  const suffix = path.extname(name).toLowerCase();
  if (!ALLOWED.includes(suffix)) return null;
  let pythonBin: string;
  try {
    pythonBin = resolvePython();
  } catch {
    return null;
  }
  const workDir = mkdtempSync(path.join(tmpdir(), "sheet-"));
  const savedPath = path.join(workDir, `stored${suffix}`);
  try {
    writeFileSync(savedPath, bytes);
    const reader = path.join(process.cwd(), "ml", "read_sheet.py");
    const result = spawnSync(pythonBin, [reader, savedPath], {
      windowsHide: true,
      timeout: 45000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf-8",
      cwd: process.cwd(),
    });
    const stdout = (result.stdout || "").trim();
    if (!stdout) return null;
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    return payload.ok === true ? payload : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
}

/** Restore the last uploaded sheet for a page so the card is still filled in
 *  after a refresh. Prefers the JSON sidecar (instant); if that is missing it
 *  re-reads the stored raw file. */
export async function GET(req: Request) {
  const auth = await assertAdmin(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

  const scope = new URL(req.url).searchParams.get("scope") || "applications";
  if (!SCOPES.has(scope)) {
    return NextResponse.json({ error: `Unknown upload scope "${scope}".` }, { status: 400 });
  }

  const bucket = serviceBucket();
  if (!bucket) return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });

  const { data: entries, error } = await bucket.list(scope, { limit: 100 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const sidecars = ((entries || []) as RawEntry[]).filter((e) => e.name.endsWith(".json"));
  const raws = ((entries || []) as RawEntry[])
    .filter((e) => !e.name.endsWith(".json"))
    .sort(
      (a, b) =>
        Date.parse(b.updated_at || b.created_at || "") - Date.parse(a.updated_at || a.created_at || ""),
    );

  // Sidecar path: the parsed sheet exactly as the upload produced it.
  for (const entry of sidecars) {
    try {
      const { data, error: dlErr } = await bucket.download(`${scope}/${entry.name}`);
      if (dlErr || !data) continue;
      const parsed = JSON.parse(await data.text()) as Record<string, unknown>;
      if (Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
        return NextResponse.json({ ok: true, restored: true, ...parsed });
      }
    } catch {
      // try the next sidecar, then fall back to the raw file below
    }
  }

  // Fallback: re-read the newest stored raw file (used if the sidecar is gone).
  const raw = raws[0];
  if (!raw) return NextResponse.json({ ok: true, file: null });
  try {
    const { data, error: dlErr } = await bucket.download(`${scope}/${raw.name}`);
    if (dlErr || !data) return NextResponse.json({ ok: true, file: null });
    const bytes = Buffer.from(await data.arrayBuffer());
    const parsed = readStoredFile(bytes, raw.name);
    if (!parsed) return NextResponse.json({ ok: true, file: null });
    const file_size = raw.metadata?.size ?? bytes.byteLength;
    const original = raw.name.replace(/\\/g, "/").split("/").pop() || raw.name;
    return NextResponse.json({
      ok: true,
      restored: true,
      ...parsed,
      file_name: original,
      file_size,
    });
  } catch {
    return NextResponse.json({ ok: true, file: null });
  }
}

/** Delete the saved upload for a page - removes the raw file and its sidecar. */
export async function DELETE(req: Request) {
  const auth = await assertAdmin(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

  const scope = new URL(req.url).searchParams.get("scope") || "applications";
  if (!SCOPES.has(scope)) {
    return NextResponse.json({ error: `Unknown upload scope "${scope}".` }, { status: 400 });
  }

  const bucket = serviceBucket();
  if (!bucket) return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });

  const { data: entries } = await bucket.list(scope, { limit: 100 });
  const paths = ((entries || []) as RawEntry[]).map((e) => `${scope}/${e.name}`);
  if (paths.length) {
    const { error } = await bucket.remove(paths);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deleted: paths.length });
}
