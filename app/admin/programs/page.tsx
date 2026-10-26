"use client";
import toast from "react-hot-toast";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDate, formatDateTime, downloadCsv } from "@/lib/utils";
import { STATUS_STYLES, PROGRAM_REQUIREMENT_OPTIONS, getProgramRequirementDocs } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

interface ScholarshipProgram {
  scholarship_id: number;
  scholarship_name: string;
  description?: string;
  requirements?: string;
  deadline?: string;
  status: "Open" | "Closed";
  created_by?: number;
  created_at?: string;
}

interface ProgramApplication {
  application_id: number;
  student_id: number;
  scholarship_id: number;
  application_date: string;
  application_status: string;
  remarks?: string | null;
  student_accounts?: {
    given_name?: string; last_name?: string; student_number?: string;
    program_name?: string; year_level?: string; sex?: string;
    registration_status?: string; account_status?: string;
  } | {
    given_name?: string; last_name?: string; student_number?: string;
    program_name?: string; year_level?: string; sex?: string;
    registration_status?: string; account_status?: string;
  }[];
}

interface ProgramForm {
  application_id: number;
  student_id?: string;
  given_name?: string; last_name?: string; middle_name?: string; ext_name?: string;
  sex?: string; birthdate?: string; complete_program_name?: string; year_level?: string;
  father_name?: string; mother_name?: string; street_barangay?: string; zipcode?: string;
  disability?: string; indigenous_people_group?: string; contact_number?: string;
  email_address?: string; income_tax_return?: string; annual_income_family?: number;
}

interface ProgramDoc {
  document_id: number;
  student_id: number;
  application_id?: number;
  document_type: string;
  file_path: string;
  upload_date: string;
}

interface ProgramAcad {
  record_id: number;
  student_id: number;
  applicant_type?: string;
  shs_gwa?: number;
  college_gpa?: number;
  proof_image_path?: string;
}

function fill(value: unknown): string {
  if (value === null || value === undefined || value === "") return "N/A";
  return String(value);
}

const emptyForm = { scholarship_name: "", description: "", requirements: [] as string[], deadline: "", status: "Open" as "Open" | "Closed" };

export default function ManageProgramsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [programs, setPrograms] = useState<ScholarshipProgram[]>([]);
  const [apps, setApps] = useState<ProgramApplication[]>([]);
  const [forms, setForms] = useState<ProgramForm[]>([]);
  const [docs, setDocs] = useState<ProgramDoc[]>([]);
  const [acads, setAcads] = useState<ProgramAcad[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [previewProgram, setPreviewProgram] = useState<ScholarshipProgram | null>(null);
  const [editingPreview, setEditingPreview] = useState(false);
  const [previewDraft, setPreviewDraft] = useState<{
    scholarship_name: string;
    description: string;
    requirements: string[];
    deadline: string;
    status: "Open" | "Closed";
  } | null>(null);
  const [savingPreview, setSavingPreview] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const [progQ, appQ, formQ, docsQ, acadQ] = await Promise.all([
        sb.from("scholarship_programs").select("*").order("created_at", { ascending: false }),
        sb.from("scholarship_applications")
          .select("application_id, student_id, scholarship_id, application_date, application_status, remarks, student_accounts(given_name, last_name, student_number, program_name, year_level, sex, registration_status, account_status)")
          .order("application_date", { ascending: false }),
        sb.from("ched_form_input").select("*").order("ched_form_id", { ascending: false }),
        sb.from("support_documents").select("*").order("upload_date", { ascending: false }),
        sb.from("support_academic_records").select("*").order("created_at", { ascending: false }),
      ]);
      if (!progQ.error) setPrograms(progQ.data || []);
      if (!appQ.error) setApps(appQ.data || []);
      if (!formQ.error) setForms(formQ.data || []);
      if (!docsQ.error) setDocs(docsQ.data || []);
      if (!acadQ.error) setAcads(acadQ.data || []);
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  function openNew() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError("");
    setMessage("");
    setShowModal(true);
  }

  function openEdit(p: ScholarshipProgram) {
    setEditingId(p.scholarship_id);
    setForm({
      scholarship_name: p.scholarship_name || "",
      description: p.description || "",
      requirements: getProgramRequirementDocs(p.requirements),
      deadline: p.deadline || "",
      status: p.status || "Open",
    });
    setFormError("");
    setMessage("");
    setShowModal(true);
  }

  function toggleRequirement(requirement: string, checked: boolean) {
    setFormError("");
    setForm((prev) => ({
      ...prev,
      requirements: checked
        ? prev.requirements.includes(requirement)
          ? prev.requirements
          : [...prev.requirements, requirement]
        : prev.requirements.filter((r) => r !== requirement),
    }));
  }

  function openPreview(p: ScholarshipProgram) {
    setPreviewProgram(p);
    setPreviewDraft({
      scholarship_name: p.scholarship_name || "",
      description: p.description || "",
      requirements: getProgramRequirementDocs(p.requirements),
      deadline: p.deadline || "",
      status: p.status || "Open",
    });
    setEditingPreview(false);
  }

  function closePreview() {
    setPreviewProgram(null);
    setPreviewDraft(null);
    setEditingPreview(false);
    setFormError("");
  }

  function togglePreviewRequirement(requirement: string, checked: boolean) {
    if (!previewDraft) return;
    setPreviewDraft({
      ...previewDraft,
      requirements: checked
        ? previewDraft.requirements.includes(requirement)
          ? previewDraft.requirements
          : [...previewDraft.requirements, requirement]
        : previewDraft.requirements.filter((r) => r !== requirement),
    });
  }

  async function handleSavePreview() {
    if (!previewProgram || !previewDraft) return;
    const name = previewDraft.scholarship_name.trim();
    if (!name) {
      setFormError("Please enter a scholarship name.");
      return;
    }
    if (previewDraft.requirements.length === 0) {
      setFormError("Please check at least one requirement for this program.");
      return;
    }
    setFormError("");
    setSavingPreview(true);
    const ordered = PROGRAM_REQUIREMENT_OPTIONS.filter((opt) =>
      previewDraft.requirements.includes(opt)
    );
    const sb = getSupabase();
    const payload = {
      scholarship_name: name,
      description: previewDraft.description.trim() || null,
      requirements: ordered.join(" | "),
      deadline: previewDraft.deadline || null,
      status: previewDraft.status,
    };
    const res = await sb
      .from("scholarship_programs")
      .update(payload)
      .eq("scholarship_id", previewProgram.scholarship_id);
    setSavingPreview(false);
    if (res.error) {
      setFormError(res.error.message);
      return;
    }
    setPreviewProgram({ ...previewProgram, ...payload, deadline: payload.deadline ?? undefined, description: payload.description ?? undefined });
    setPreviewDraft({ ...previewDraft, scholarship_name: name, requirements: ordered });
    setEditingPreview(false);
    const { data } = await sb.from("scholarship_programs").select("*").order("created_at", { ascending: false });
    if (data) setPrograms(data);
    setMessage(`Updated "${name}" — ${ordered.length} requirement(s) checked.`);
    toast.success(`Updated "${name}" — ${ordered.length} requirement(s) checked.`);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    setFormError("");

    const name = form.scholarship_name.trim();
    if (!name) {
      setFormError("Please enter a scholarship name.");
      return;
    }
    if (form.requirements.length === 0) {
      setFormError("Please check at least one requirement for this program. Students will be asked to upload exactly what you check.");
      return;
    }

    // Keep only canonical options, in stable order, pipe-separated for storage.
    const orderedRequirements = PROGRAM_REQUIREMENT_OPTIONS.filter((opt) =>
      form.requirements.includes(opt)
    );

    setSaving(true);
    const sb = getSupabase();

    const payload = {
      scholarship_name: name,
      description: form.description.trim() || null,
      requirements: orderedRequirements.join(" | "),
      deadline: form.deadline || null,
      status: form.status,
    };

    const res = editingId
      ? await sb.from("scholarship_programs").update(payload).eq("scholarship_id", editingId)
      : await sb.from("scholarship_programs").insert(payload);

    setSaving(false);

    if (res.error) {
      setMessage(res.error.message);
      return;
    }

    setShowModal(false);
    setMessage(
      editingId
        ? `Updated "${name}" — ${orderedRequirements.length} requirement(s) checked.`
        : `Created "${name}" — ${orderedRequirements.length} requirement(s) checked.`
    );
    const { data } = await sb.from("scholarship_programs").select("*").order("created_at", { ascending: false });
    if (data) setPrograms(data);
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this program?")) return;
    const sb = getSupabase();
    const { error } = await sb.from("scholarship_programs").delete().eq("scholarship_id", id);
    if (!error) setPrograms((prev) => prev.filter((p) => p.scholarship_id !== id));
  }

  function buildProgramCsvRows(scholarshipId: number) {
    const prog = programs.find((p) => p.scholarship_id === scholarshipId);
    const programApps = apps
      .filter((a) => a.scholarship_id === scholarshipId)
      .sort((a, b) => a.application_id - b.application_id);
    const docByApp: Record<number, string> = {};
    const docFilesByApp: Record<number, string> = {};
    docs.forEach((d) => {
      const key = d.application_id ?? d.student_id;
      if (!key) return;
      docByApp[key] = docByApp[key] ? `${docByApp[key]}; ${d.document_type}` : d.document_type;
      docFilesByApp[key] = docFilesByApp[key] ? `${docFilesByApp[key]}; ${d.file_path}` : d.file_path;
    });
    const rows = programApps.map((a) => {
      const c = forms.find((f) => f.application_id === a.application_id);
      const sa = Array.isArray(a.student_accounts) ? a.student_accounts[0] : a.student_accounts;
      const acad = acads.find((ac) => ac.student_id === a.student_id);
      return {
        "Application ID": a.application_id,
        "Student No.": fill(sa?.student_number || c?.student_id),
        "Last Name": fill(c?.last_name || sa?.last_name),
        "First Name": fill(c?.given_name || sa?.given_name),
        "Middle Name": fill(c?.middle_name),
        "Ext. Name": fill(c?.ext_name),
        "Sex": fill(c?.sex || sa?.sex),
        "Birthdate": fill(c?.birthdate),
        "Program": fill(c?.complete_program_name || sa?.program_name),
        "Year Level": fill(c?.year_level || sa?.year_level),
        "Scholarship Program": fill(prog?.scholarship_name),
        "Application Status": a.application_status,
        "Application Date": formatDateTime(a.application_date),
        "Father's Full Name": fill(c?.father_name),
        "Mother's Full Name": fill(c?.mother_name),
        "Street / Barangay": fill(c?.street_barangay),
        "Zipcode": fill(c?.zipcode),
        "Contact Number": fill(c?.contact_number),
        "Email Address": fill(c?.email_address),
        "Disability": fill(c?.disability),
        "Indigenous People Group": fill(c?.indigenous_people_group),
        "Annual Family Income (PHP)": c?.annual_income_family != null ? Number(c.annual_income_family) : 0,
        "ITR File Present": c?.income_tax_return ? "Yes" : "No",
        "ITR File Path": fill(c?.income_tax_return),
        "Registration Status": fill(sa?.registration_status),
        "Account Status": fill(sa?.account_status),
        "Supporting Documents": fill(docByApp[a.application_id]),
        "Supporting Doc Files": fill(docFilesByApp[a.application_id]),
        "Applicant Type": fill(acad?.applicant_type),
        "SHS GWA": acad?.shs_gwa != null ? Number(acad.shs_gwa) : acad?.college_gpa != null ? Number(acad.college_gpa) : "N/A",
        "College GPA": acad?.college_gpa != null ? Number(acad.college_gpa) : acad?.shs_gwa != null ? Number(acad.shs_gwa) : "N/A",
        "Academic Proof File": fill(acad?.proof_image_path),
        "Remarks": fill(a.remarks),
      };
    });
    return { rows, name: prog?.scholarship_name || "scholarship" };
  }

  function exportProgramCsv(scholarshipId: number) {
    const { rows, name } = buildProgramCsvRows(scholarshipId);
    if (!rows.length) { setMessage("No applications yet for this scholarship."); return; }
    downloadCsv(`${name.replace(/[^\w]+/g, "_").toLowerCase()}-applications.csv`, rows);
    setMessage(`Exported ${rows.length} application form(s) for "${name}".`);
    toast.success(`Exported ${rows.length} application form(s) for "${name}".`);
  }

  function exportAllProgramsCsv() {
    const all = programs.flatMap((p) => buildProgramCsvRows(p.scholarship_id).rows);
    if (!all.length) { setMessage("No applications found yet."); return; }
    downloadCsv("all-scholarship-applications.csv", all);
    setMessage(`Exported ${all.length} application form(s) across all scholarships.`);
    toast.success(`Exported ${all.length} application form(s) across all scholarships.`);
  }

  if (loading) return <Spinner label="Loading programs..." color="maroon" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-bold text-[#241012]">Manage Scholarship Programs</h1>
          <p className="mt-1 text-xs text-[#8B7376]">Create, edit, or close the scholarships students can apply to.</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={exportAllProgramsCsv}
            disabled={!apps.length}
            className="rounded-lg border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] hover:bg-[#7B1113]/5 disabled:opacity-40"
          >
            &#11015; Export All Applications CSV
          </button>
          <button onClick={openNew} className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111]">
            + Create New
          </button>
        </div>
      </div>

      {message && (
        <div className="rounded-xl border border-[#7B1113]/20 bg-white px-4 py-3 text-xs font-medium text-[#7B1113] shadow-sm">
          {message}
        </div>
      )}

      {programs.length === 0 ? (
        <EmptyState icon="&#128218;" title="No programs yet" hint="Create your first scholarship program." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {programs.map((p) => (
            <article key={p.scholarship_id} className="flex flex-col rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-bold text-[#7B1113]">{p.scholarship_name}</h3>
                <Badge className={STATUS_STYLES[p.status] || ""}>{p.status}</Badge>
              </div>
              <p className="mt-2 line-clamp-2 flex-1 text-xs text-[#6B5458]">{p.description || "No description."}</p>
              {getProgramRequirementDocs(p.requirements).length > 0 && (
                <div className="mt-2">
                  <p className="text-[11px] font-semibold text-[#241012]">Requirements</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {getProgramRequirementDocs(p.requirements).map((r) => (
                      <span key={r} className="rounded-full bg-[#7B1113]/5 px-2 py-0.5 text-[10px] font-semibold text-[#7B1113]">{r}</span>
                    ))}
                  </div>
                </div>
              )}
              <p className="mt-2 text-[11px] text-[#8B7376]">
                Deadline: <span className="font-semibold text-[#241012]">{formatDate(p.deadline)}</span>
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => exportProgramCsv(p.scholarship_id)}
                  className="whitespace-nowrap rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-bold text-[#7B1113] hover:bg-[#7B1113]/5"
                  title={`Download ${apps.filter((a) => a.scholarship_id === p.scholarship_id).length} application form(s) as CSV`}
                >
                  ⬇ Applications CSV
                </button>
                <button
                  onClick={() => openPreview(p)}
                  className="whitespace-nowrap rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-bold text-[#7B1113] hover:bg-[#7B1113]/5"
                  title="Preview and edit the student application form for this program"
                >
                  📄 View Form
                </button>
                <button
                  onClick={() => openEdit(p)}
                  className="whitespace-nowrap rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-bold text-[#7B1113] hover:bg-[#7B1113]/5"
                >
                  ✏ Edit
                </button>
                <button
                  onClick={() => handleDelete(p.scholarship_id)}
                  className="whitespace-nowrap rounded-lg border border-red-200 px-3 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-50"
                >
                  🗑 Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="mb-4 text-sm font-bold text-[#241012]">
              {editingId ? "Edit Program" : "Create New Program"}
            </h2>
            <form onSubmit={handleSave} className="space-y-4">
              <label className="block text-xs font-semibold text-[#241012]">
                Scholarship Name
                <input
                  type="text"
                  value={form.scholarship_name}
                  onChange={(e) => setForm({ ...form, scholarship_name: e.target.value })}
                  required
                  className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
                />
              </label>
              <label className="block text-xs font-semibold text-[#241012]">
                Description
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
                />
              </label>
              <div className="block text-xs font-semibold text-[#241012]">
                <span>
                  Requirements
                  <span className="ml-1 font-normal text-[#7B1113]">* required</span>
                </span>
                <span className="mt-1 block text-[10px] font-normal text-[#8B7376]">
                  Check every document students must upload. Checked items appear on the student application form and are required before they can submit.
                </span>
                <div
                  className={`mt-2 grid gap-x-4 gap-y-2 rounded-xl border p-3 sm:grid-cols-2 ${
                    formError && form.requirements.length === 0
                      ? "border-red-300 bg-red-50/50"
                      : "border-[#241012]/[0.06]"
                  }`}
                >
                  {PROGRAM_REQUIREMENT_OPTIONS.map((requirement) => (
                    <label key={requirement} className="flex cursor-pointer items-center gap-2 rounded-lg border border-[#241012]/[0.06] px-3 py-2 text-[11px] text-[#241012] transition hover:border-[#7B1113]/40 has-checked:border-[#7B1113] has-checked:bg-[#FAF5F5]">
                      <input
                        type="checkbox"
                        checked={form.requirements.includes(requirement)}
                        onChange={(e) => toggleRequirement(requirement, e.target.checked)}
                        className="h-3.5 w-3.5 accent-[#7B1113]"
                      />
                      {requirement}
                    </label>
                  ))}
                </div>
                <p className={`mt-1.5 text-[10px] font-semibold ${form.requirements.length ? "text-[#7B1113]" : "text-[#8B7376]"}`}>
                  {form.requirements.length} of {PROGRAM_REQUIREMENT_OPTIONS.length} checked
                  {form.requirements.length > 0 ? `: ${form.requirements.join(", ")}` : " — select at least one"}
                </p>
              </div>
              {formError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-medium text-red-700">
                  {formError}
                </div>
              )}
              <label className="block text-xs font-semibold text-[#241012]">
                Deadline
                <input
                  type="date"
                  value={form.deadline}
                  onChange={(e) => setForm({ ...form, deadline: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
                />
              </label>
              <label className="block text-xs font-semibold text-[#241012]">
                Status
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as "Open" | "Closed" })}
                  className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
                >
                  <option value="Open">Open</option>
                  <option value="Closed">Closed</option>
                </select>
              </label>
              <div className="flex justify-end gap-2 border-t border-[#241012]/[0.06] pt-4">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-lg border border-[#241012]/[0.06] px-4 py-2 text-xs font-bold text-[#6B5458] hover:bg-[#FAF7F5]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111] disabled:opacity-50"
                >
                  {saving ? "Saving..." : editingId ? "Update" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {previewProgram && previewDraft && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={closePreview}>
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-[#241012]">
                  {editingPreview ? "Edit Application Form" : "Student Application Form — Preview"}
                </h2>
                <p className="mt-1 text-xs text-[#8B7376]">
                  {editingPreview ? (
                    <>Change the program details and requirements students must check before applying.</>
                  ) : (
                    <>This is what students see when they apply to <span className="font-semibold text-[#7B1113]">{previewProgram.scholarship_name}</span>.</>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={closePreview}
                className="shrink-0 rounded-lg border border-[#241012]/10 px-3 py-1.5 text-xs font-bold text-[#6B5458] hover:bg-[#FAF7F5]"
              >
                Close
              </button>
            </div>

            {editingPreview ? (
              <div className="mt-4 space-y-3">
                <label className="block text-xs font-semibold text-[#241012]">
                  Scholarship Name *required
                  <input
                    type="text"
                    value={previewDraft.scholarship_name}
                    onChange={(e) => setPreviewDraft({ ...previewDraft, scholarship_name: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
                  />
                </label>
                <label className="block text-xs font-semibold text-[#241012]">
                  Description
                  <textarea
                    value={previewDraft.description}
                    onChange={(e) => setPreviewDraft({ ...previewDraft, description: e.target.value })}
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs font-semibold text-[#241012]">
                    Deadline
                    <input
                      type="date"
                      value={previewDraft.deadline}
                      onChange={(e) => setPreviewDraft({ ...previewDraft, deadline: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
                    />
                  </label>
                  <label className="block text-xs font-semibold text-[#241012]">
                    Status
                    <select
                      value={previewDraft.status}
                      onChange={(e) => setPreviewDraft({ ...previewDraft, status: e.target.value as "Open" | "Closed" })}
                      className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
                    >
                      <option value="Open">Open</option>
                      <option value="Closed">Closed</option>
                    </select>
                  </label>
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#241012]">
                    Requirements *required
                    <span className="ml-1 font-normal text-[#7B1113]">* required</span>
                  </p>
                  <p className="mt-0.5 text-[10px] font-normal text-[#8B7376]">
                    Checked items are what students must upload. At least one must be checked.
                  </p>
                  <div
                    className={`mt-2 grid gap-x-4 gap-y-2 rounded-xl border p-3 sm:grid-cols-2 ${
                      formError && previewDraft.requirements.length === 0
                        ? "border-red-300 bg-red-50/50"
                        : "border-[#241012]/[0.06]"
                    }`}
                  >
                    {PROGRAM_REQUIREMENT_OPTIONS.map((requirement) => (
                      <label key={requirement} className="flex cursor-pointer items-center gap-2 rounded-lg border border-[#241012]/[0.06] px-3 py-2 text-[11px] text-[#241012] transition hover:border-[#7B1113]/40 has-checked:border-[#7B1113] has-checked:bg-[#FAF5F5]">
                        <input
                          type="checkbox"
                          checked={previewDraft.requirements.includes(requirement)}
                          onChange={(e) => togglePreviewRequirement(requirement, e.target.checked)}
                          className="h-3.5 w-3.5 accent-[#7B1113]"
                        />
                        {requirement}
                      </label>
                    ))}
                  </div>
                  <p className={`mt-1.5 text-[10px] font-semibold ${previewDraft.requirements.length ? "text-[#7B1113]" : "text-[#8B7376]"}`}>
                    {previewDraft.requirements.length} of {PROGRAM_REQUIREMENT_OPTIONS.length} checked
                    {previewDraft.requirements.length > 0 ? `: ${previewDraft.requirements.join(", ")}` : " — select at least one"}
                  </p>
                </div>
                {formError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-medium text-red-700">
                    {formError}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="mt-4 rounded-xl border border-[#7B1113]/20 bg-[#FAF5F5] p-4 text-xs text-[#241012]">
                  <p className="font-bold text-[#7B1113]">{previewProgram.scholarship_name}</p>
                  <p className="mt-1 text-[#6B5458]">{previewProgram.description || "No description provided."}</p>
                  <p className="mt-2 text-[11px] text-[#8B7376]">
                    Deadline: <span className="font-semibold text-[#241012]">{formatDate(previewProgram.deadline)}</span>
                    {" · "}Status: <span className="font-semibold text-[#241012]">{previewProgram.status}</span>
                  </p>
                </div>

                <div className="mt-3 space-y-3 rounded-xl border border-[#241012]/[0.06] bg-[#FAF7F5]/60 p-4 text-xs text-[#241012]">
                  <p className="font-bold uppercase tracking-wide text-[#7B1113]">Section 1 — Scholarship Program</p>
                  <p>Dropdown to choose {previewProgram.scholarship_name} and note the deadline.</p>

                  <p className="mt-3 font-bold uppercase tracking-wide text-[#7B1113]">Section 2 — CHED Application Form</p>
                  <ul className="list-inside list-disc space-y-1 text-[#6B5458]">
                    <li>Father&apos;s Full Name *</li>
                    <li>Mother&apos;s Full Name *</li>
                    <li>Street / Barangay *</li>
                    <li>Zipcode *</li>
                    <li>Contact Number *</li>
                    <li>Email Address *</li>
                    <li>Disability / IP Group (optional)</li>
                    <li>Annual Family Income (PHP) *</li>
                    <li>Income Tax Return (ITR) File * — JPG / PNG / PDF, max 10 MB (OCR may auto-detect income)</li>
                  </ul>

                  <p className="mt-3 font-bold uppercase tracking-wide text-[#7B1113]">Section 3 — Supporting Documents</p>
                  {getProgramRequirementDocs(previewProgram.requirements).length > 0 ? (
                    <>
                      <p className="text-[#6B5458]">Students must upload every checked requirement below before they can submit:</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {getProgramRequirementDocs(previewProgram.requirements).map((r) => (
                          <span key={r} className="rounded-full bg-[#7B1113]/10 px-2.5 py-1 text-[10px] font-bold text-[#7B1113]">
                            {r} *
                          </span>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="text-amber-700">No requirements checked yet — students fall back to COR, Valid ID, Signature Form.</p>
                  )}

                  <p className="mt-3 font-bold uppercase tracking-wide text-[#7B1113]">Section 4 — Academic Records</p>
                  <ul className="list-inside list-disc space-y-1 text-[#6B5458]">
                    <li>Applicant Type * (Freshman / Alumni)</li>
                    <li>SHS GWA or College GPA * (1–100)</li>
                    <li>Proof File *</li>
                  </ul>

                  <p className="mt-3 text-[11px] font-semibold text-[#7B1113]">Submit Application</p>
                  <p className="text-[#8B7376]">All fields marked * are required. Missing files block submission.</p>
                </div>
              </>
            )}

            <div className="mt-4 flex justify-end gap-2">
              {editingPreview ? (
                <>
                  <button
                    type="button"
                    onClick={() => { setEditingPreview(false); setFormError(""); }}
                    disabled={savingPreview}
                    className="rounded-lg border border-[#241012]/[0.06] px-4 py-2.5 text-xs font-bold text-[#6B5458] hover:bg-[#FAF7F5] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSavePreview}
                    disabled={savingPreview}
                    className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111] disabled:opacity-50"
                  >
                    {savingPreview ? "Saving..." : "Save Form"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => { setEditingPreview(true); setFormError(""); }}
                    className="rounded-lg border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] hover:bg-[#7B1113]/5"
                  >
                    Edit Form
                  </button>
                  <button
                    type="button"
                    onClick={() => { const p = previewProgram; closePreview(); openEdit(p); }}
                    className="rounded-lg border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] hover:bg-[#7B1113]/5"
                  >
                    Open Full Editor
                  </button>
                  <button
                    type="button"
                    onClick={closePreview}
                    className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111]"
                  >
                    Close Preview
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
