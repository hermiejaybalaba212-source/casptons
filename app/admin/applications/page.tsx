"use client";
import toast from "react-hot-toast";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime, downloadCsv } from "@/lib/utils";
import { STATUS_STYLES, getProgramRequirementDocs, matchRequirementOption } from "@/lib/constants";
import { autoRejectSiblings } from "@/lib/scholarship";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

const FILTER_TABS = [
  { key: "", label: "All", active: "bg-[#7B1113] text-white", idle: "text-[#6B5458] hover:bg-[#7B1113]/5 hover:text-[#7B1113]" },
  { key: "Pending", label: "Pending", active: "bg-amber-500 text-white", idle: "text-amber-700 hover:bg-amber-50" },
  { key: "Approved", label: "Approved", active: "bg-green-600 text-white", idle: "text-green-700 hover:bg-green-50" },
  { key: "Not Approved", label: "Not Approved", active: "bg-red-600 text-white", idle: "text-red-600 hover:bg-red-50" },
] as const;

const STATUS_ACTIONS = [
  { status: "Pending", label: "Pending", active: "bg-amber-500 border-amber-500 text-white", idle: "border-amber-300 text-amber-700 hover:bg-amber-50" },
] as const;

interface ScholarshipApplication {
  application_id: number;
  student_id: number;
  scholarship_id: number;
  application_date: string;
  application_status: string;
  remarks?: string | null;
  scholarship_programs?: { scholarship_name: string; requirements?: string };
  student_accounts?: { given_name: string; last_name: string; student_number: string; program_name: string; year_level?: string; sex?: string; registration_status?: string; account_status?: string };
}

interface SupportDocument {
  document_id: number;
  student_id: number;
  application_id?: number;
  document_type: string;
  file_path: string;
  upload_date: string;
}

interface SupportAcademicRecord {
  record_id: number;
  student_id: number;
  applicant_type?: string;
  shs_gwa?: number;
  college_gpa?: number;
  proof_image_path?: string;
  created_at?: string;
}

interface ChedFormInput {
  ched_form_id: number;
  application_id: number;
  student_id: string;
  given_name?: string;
  last_name?: string;
  ext_name?: string;
  middle_name?: string;
  sex?: string;
  birthdate?: string;
  complete_program_name?: string;
  year_level?: string;
  father_name?: string;
  mother_name?: string;
  street_barangay?: string;
  zipcode?: string;
  disability?: string;
  contact_number?: string;
  email_address?: string;
  indigenous_people_group?: string;
  income_tax_return?: string;
  annual_income_family?: number;
}

const NO_VALUE = "";

function fill(value: unknown): string {
  if (value === null || value === undefined || value === "") return "N/A";
  return String(value);
}

export default function ApplicationsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [applications, setApplications] = useState<ScholarshipApplication[]>([]);
  const [docs, setDocs] = useState<SupportDocument[]>([]);
  const [acads, setAcads] = useState<SupportAcademicRecord[]>([]);
  const [chedForms, setChedForms] = useState<ChedFormInput[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [programFilter, setProgramFilter] = useState("");
  const [viewingId, setViewingId] = useState<number | null>(null);
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [statusDraft, setStatusDraft] = useState<Record<number, { status: string; remarks: string }>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchMsg, setBatchMsg] = useState("");
  const [notifyDraft, setNotifyDraft] = useState<Record<number, string>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const [appsQ, docsQ, acadsQ, chedQ] = await Promise.all([
        sb.from("scholarship_applications")
          .select("*, scholarship_programs(scholarship_name, requirements), student_accounts(given_name, last_name, student_number, program_name, year_level, sex, registration_status, account_status)")
          .order("application_date", { ascending: false }),
        sb.from("support_documents").select("*").order("upload_date", { ascending: false }),
        sb.from("support_academic_records").select("*").order("created_at", { ascending: false }),
        sb.from("ched_form_input").select("*").order("ched_form_id", { ascending: false }),
      ]);

      if (!appsQ.error) setApplications(appsQ.data || []);
      if (!docsQ.error) setDocs(docsQ.data || []);
      if (!acadsQ.error) setAcads(acadsQ.data || []);
      if (!chedQ.error) setChedForms(chedQ.data || []);
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  useEffect(() => {
    if (viewingId !== null) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [viewingId]);

  const appChed = (app: ScholarshipApplication) => chedForms.filter((c) => c.application_id === app.application_id);
  const appDocs = (app: ScholarshipApplication) => docs.filter((d) => d.application_id === app.application_id || d.student_id === app.student_id);
  const appAcads = (app: ScholarshipApplication) => acads.filter((a) => a.student_id === app.student_id);

  // Requirement compliance for one application: the program's checked requirements
  // (COR / Valid ID / Signature Form / ITR / …) vs what the student actually uploaded.
  // ITR lives in the CHED form's income_tax_return field; the rest in support_documents.
  const requirementStats = (app: ScholarshipApplication) => {
    const required = getProgramRequirementDocs(app.scholarship_programs?.requirements);
    const present = new Set<string>();
    for (const d of docs.filter((x) => x.application_id === app.application_id)) {
      const canon = matchRequirementOption(d.document_type);
      if (canon) present.add(canon);
    }
    if (chedForms.some((c) => c.application_id === app.application_id && !!c.income_tax_return)) {
      present.add("Income Tax Return (ITR)");
    }
    const missing = required.filter((r) => !present.has(r));
    return { required, missing, done: required.length - missing.length };
  };

  const filteredApps = applications
    .filter((a) => !statusFilter || a.application_status === statusFilter)
    .filter((a) => !programFilter || programKey(a) === programFilter)
    .filter((a) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      const name = `${a.student_accounts?.given_name || ""} ${a.student_accounts?.last_name || ""}`.toLowerCase();
      const studentNo = a.student_accounts?.student_number?.toLowerCase() || "";
      const program = a.student_accounts?.program_name?.toLowerCase() || "";
      const scholarship = a.scholarship_programs?.scholarship_name?.toLowerCase() || "";
      return name.includes(q) || studentNo.includes(q) || program.includes(q) || scholarship.includes(q);
    });

  const pendingCount = applications.filter((a) => a.application_status === "Pending").length;
  const approvedCount = applications.filter((a) => a.application_status === "Approved").length;
  const notApprovedCount = applications.filter((a) => a.application_status === "Not Approved").length;

  // Clickable category chips: one per scholarship program, so Admin can jump to
  // a program and see only the applications filed under it. Counts respect the
  // active status tab (All / Pending / Approved / Not Approved).
  const programKey = (a: ScholarshipApplication) => a.scholarship_programs?.scholarship_name || "No Scholarship Program";
  const programNames = Array.from(new Set(applications.map(programKey))).sort();
  const programCounts: Record<string, number> = {};
  for (const name of programNames) {
    programCounts[name] = applications
      .filter((a) => programKey(a) === name && (!statusFilter || a.application_status === statusFilter))
      .length;
  }
  const totalByStatus = !statusFilter ? applications.length : applications.filter((a) => a.application_status === statusFilter).length;

  async function loadFileUrls(app: ScholarshipApplication) {
    setFileUrls({});
    const sb = getSupabase();
    const urls: Record<string, string> = {};
    for (const d of appDocs(app)) {
      const res = await sb.storage.from("support-documents").createSignedUrl(d.file_path, 3600);
      if (res.data?.signedUrl) urls[d.file_path] = res.data.signedUrl;
    }
    for (const a of appAcads(app)) {
      if (!a.proof_image_path) continue;
      const res = await sb.storage.from("academic-records").createSignedUrl(a.proof_image_path, 3600);
      if (res.data?.signedUrl) urls[a.proof_image_path] = res.data.signedUrl;
    }
    for (const c of appChed(app)) {
      if (!c.income_tax_return) continue;
      const res = await sb.storage.from("itr-documents").createSignedUrl(c.income_tax_return, 3600);
      if (res.data?.signedUrl) urls[c.income_tax_return] = res.data.signedUrl;
    }
    setFileUrls(urls);
  }

  function openDetails(appId: number) {
    const app = applications.find((a) => a.application_id === appId);
    if (!app) return;
    setViewingId(appId);
    loadFileUrls(app);
  }

  async function notifyStudent(app: ScholarshipApplication, title: string, message: string) {
    const sb = getSupabase();
    await sb.from("notifications_announcements").insert({
      student_id: app.student_id,
      title,
      message,
      notification_type: "Status Update",
      status: "Unread",
    });
  }

  function friendlyMessage(app: ScholarshipApplication, status: string) {
    const scholarship = app.scholarship_programs?.scholarship_name || "a scholarship";
    if (status === "Approved") return `Congratulations! Your application for "${scholarship}" has been approved.`;
    if (status === "Not Approved") return `Your application for "${scholarship}" has not been approved. Thank you for applying.`;
    return `Your application for "${scholarship}" is now pending review.`;
  }

  const CHED_ONLY_DECISION = "Only CHED can approve or not-approve applications. Admin can notify, validate against the Registrar, or set the status back to Pending.";

  async function quickStatus(app: ScholarshipApplication, targetStatus: string) {
    if (app.application_status === targetStatus || savingId !== null) return;
    if (targetStatus === "Approved" || (targetStatus === "Not Approved" && app.application_status !== "Not Approved")) {
      setMessage(CHED_ONLY_DECISION);
      return;
    }
    setSavingId(app.application_id);
    setMessage("");
    const sb = getSupabase();
    const { error } = await sb.from("scholarship_applications")
      .update({ application_status: targetStatus })
      .eq("application_id", app.application_id);
    if (error) { setMessage(error.message); setSavingId(null); return; }

    await notifyStudent(app, "Application Update", friendlyMessage(app, targetStatus));

    let rejectNote = "";
    if (targetStatus === "Approved" && app.application_status !== "Approved") {
      const res = await autoRejectSiblings([{ application_id: app.application_id, student_id: app.student_id }], applications);
      if (res.rejectedCount > 0) {
        rejectNote = ` Auto-rejected ${res.rejectedCount} other application(s).`;
        setApplications((prev) => prev.map((a) =>
          a.student_id === app.student_id && a.application_id !== app.application_id
            ? { ...a, application_status: "Not Approved", remarks: `Auto-rejected: already approved for "${app.scholarship_programs?.scholarship_name || "another scholarship"}".` }
            : a
        ));
      }
    }

    setApplications((prev) => prev.map((a) =>
      a.application_id === app.application_id ? { ...a, application_status: targetStatus } : a
    ));
    setMessage(`${app.student_accounts?.last_name || "Application"} marked as ${targetStatus} and the student was notified.${rejectNote}`);
    toast.success(`${app.student_accounts?.last_name || "Application"} marked as ${targetStatus} and the student was notified.${rejectNote}`);
    setSavingId(null);
  }

  async function handleStatusSave(app: ScholarshipApplication) {
    setMessage("");
    setSavingId(app.application_id);
    const draft = statusDraft[app.application_id] || { status: app.application_status, remarks: app.remarks || "" };
    const newStatus = draft.status;
    const newRemarks = draft.remarks.trim() || null;
    if (newStatus === "Approved" || (newStatus === "Not Approved" && app.application_status !== "Not Approved")) {
      setMessage(CHED_ONLY_DECISION);
      setSavingId(null);
      return;
    }
    const sb = getSupabase();
    const { error } = await sb.from("scholarship_applications")
      .update({ application_status: newStatus, remarks: newRemarks })
      .eq("application_id", app.application_id);

    if (error) { setMessage(error.message); setSavingId(null); return; }

    await notifyStudent(app, "Application Update",
      `Your application for "${app.scholarship_programs?.scholarship_name || "a scholarship"}" is now ${newStatus}. ${newRemarks || ""}`.trim());

    let rejectNote = "";
    if (newStatus === "Approved" && app.application_status !== "Approved") {
      const res = await autoRejectSiblings([{ application_id: app.application_id, student_id: app.student_id }], applications);
      if (res.rejectedCount > 0) {
        rejectNote = ` Auto-rejected ${res.rejectedCount} other application(s).`;
        setApplications((prev) => prev.map((a) =>
          a.student_id === app.student_id && a.application_id !== app.application_id
            ? { ...a, application_status: "Not Approved", remarks: `Auto-rejected: already approved for "${app.scholarship_programs?.scholarship_name || "another scholarship"}".` }
            : a
        ));
      }
    }

    setApplications((prev) => prev.map((a) =>
      a.application_id === app.application_id ? { ...a, application_status: newStatus, remarks: newRemarks } : a
    ));
    setMessage(`Updated status to ${newStatus} and notified the student.${rejectNote}`);
    toast.success(`Updated status to ${newStatus} and notified the student.${rejectNote}`);
    setSavingId(null);
  }

  async function handleNotify(app: ScholarshipApplication) {
    const msg = (notifyDraft[app.application_id] || "").trim();
    if (!msg) { setMessage("Type a message first."); return; }
    setMessage("");
    await notifyStudent(app, "Notification from SPC Scholarship Office", msg);
    setNotifyDraft((prev) => ({ ...prev, [app.application_id]: "" }));
    setMessage(`Notification sent to ${app.student_accounts?.last_name || "student"}.`);
    toast.success(`Notification sent to ${app.student_accounts?.last_name || "student"}.`);
  }

  function toggleSelect(appId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) next.delete(appId); else next.add(appId);
      return next;
    });
  }

  function toggleSelectAll() {
    const visibleIds = filteredApps.map((a) => a.application_id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = visibleIds.every((id) => next.has(id));
      visibleIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  const selectedApps = applications.filter((a) => selectedIds.has(a.application_id));

  async function batchStatus(targetStatus: string, scopeIds: number[]) {
    if (!scopeIds.length || batchBusy) return;
    if (targetStatus === "Approved") {
      setMessage(CHED_ONLY_DECISION);
      return;
    }
    if (targetStatus === "Not Approved") {
      const fresh = applications.filter((a) => scopeIds.includes(a.application_id) && a.application_status !== "Not Approved");
      if (fresh.length) {
        setMessage(CHED_ONLY_DECISION);
        return;
      }
    }
    setBatchBusy(true);
    setMessage("");
    const sb = getSupabase();
    try {
      const { error } = await sb.from("scholarship_applications")
        .update({ application_status: targetStatus })
        .in("application_id", scopeIds);
      if (error) { setMessage(`Batch update failed: ${error.message}`); setBatchBusy(false); return; }

      const targets = applications.filter((a) => scopeIds.includes(a.application_id));
      let rejectNote = "";
      if (targetStatus === "Approved") {
        const fresh = targets.filter((a) => a.application_status !== "Approved");
        const res = await autoRejectSiblings(fresh.map((a) => ({ application_id: a.application_id, student_id: a.student_id })), applications);
        if (res.rejectedCount > 0) rejectNote = ` Auto-rejected ${res.rejectedCount} other application(s).`;
      }

      const notifRows = targets.map((a) => ({
        student_id: a.student_id,
        title: "Application Update",
        message: friendlyMessage(a, targetStatus),
        notification_type: "Status Update",
        status: "Unread",
      }));
      if (notifRows.length) {
        const { error: nErr } = await sb.from("notifications_announcements").insert(notifRows);
        if (nErr) { setMessage(`Status saved ${notifRows.length} apps but notify failed: ${nErr.message}`); }
      }

      setApplications((prev) => prev.map((a) =>
        scopeIds.includes(a.application_id) ? { ...a, application_status: targetStatus } : a
      ));
      setSelectedIds(new Set());
      setMessage(`Updated ${scopeIds.length} application(s) to ${targetStatus} and notified students.${rejectNote}`);
      toast.success(`Updated ${scopeIds.length} application(s) to ${targetStatus} and notified students.${rejectNote}`);
    } finally {
      setBatchBusy(false);
    }
  }

  async function batchNotify() {
    if (!selectedIds.size || batchBusy) return;
    const msg = batchMsg.trim() || "You have a new update from the scholarship office.";
    setBatchBusy(true);
    setMessage("");
    const sb = getSupabase();
    const rows = selectedApps.map((a) => ({
      student_id: a.student_id,
      title: "Notification from SPC Scholarship Office",
      message: msg,
      notification_type: "Announcement",
      status: "Unread",
    }));
    const { error } = await sb.from("notifications_announcements").insert(rows);
    setBatchBusy(false);
    if (error) { setMessage(`Notify failed: ${error.message}`); return; }
    setBatchMsg("");
    setMessage(`Notification sent to ${rows.length} student(s).`);
    toast.success(`Notification sent to ${rows.length} student(s).`);
  }

  function buildCsvRows(apps: ScholarshipApplication[]) {
    const chedByApp = Object.fromEntries(chedForms.map((c) => [c.application_id, c]));
    const acadByStudent = Object.fromEntries(acads.map((a) => [a.student_id, a]));
    const docByApp: Record<number, string> = {};
    const docFilesByApp: Record<number, string> = {};
    docs.forEach((d) => {
      const key = d.application_id ?? d.student_id;
      if (!key) return;
      docByApp[key] = docByApp[key] ? `${docByApp[key]}; ${d.document_type}` : d.document_type;
      docFilesByApp[key] = docFilesByApp[key] ? `${docFilesByApp[key]}; ${d.file_path}` : d.file_path;
    });

    return apps.map((a) => {
      const c = chedByApp[a.application_id];
      const acad = acadByStudent[a.student_id];
      return {
        "Application ID": a.application_id,
        "Student No.": fill(a.student_accounts?.student_number || c?.student_id || NO_VALUE),
        "Last Name": fill(c?.last_name || a.student_accounts?.last_name || NO_VALUE),
        "First Name": fill(c?.given_name || a.student_accounts?.given_name || NO_VALUE),
        "Middle Name": fill(c?.middle_name || NO_VALUE),
        "Ext. Name": fill(c?.ext_name || NO_VALUE),
        "Sex": fill(c?.sex || a.student_accounts?.sex || NO_VALUE),
        "Birthdate": fill(c?.birthdate || NO_VALUE),
        "Program": fill(c?.complete_program_name || a.student_accounts?.program_name || NO_VALUE),
        "Year Level": fill(c?.year_level || a.student_accounts?.year_level || NO_VALUE),
        "Scholarship Program": fill(a.scholarship_programs?.scholarship_name || NO_VALUE),
        "Application Status": a.application_status,
        "Application Date": formatDateTime(a.application_date),
        "Father's Full Name": fill(c?.father_name || NO_VALUE),
        "Mother's Full Name": fill(c?.mother_name || NO_VALUE),
        "Street / Barangay": fill(c?.street_barangay || NO_VALUE),
        "Zipcode": fill(c?.zipcode || NO_VALUE),
        "Contact Number": fill(c?.contact_number || NO_VALUE),
        "Email Address": fill(c?.email_address || NO_VALUE),
        "Disability": fill(c?.disability || NO_VALUE),
        "Indigenous People Group": fill(c?.indigenous_people_group || NO_VALUE),
        "Annual Family Income (PHP)": c?.annual_income_family != null ? Number(c.annual_income_family) : 0,
        "ITR File Present": c?.income_tax_return ? "Yes" : "No",
        "ITR File Path": fill(c?.income_tax_return || NO_VALUE),
        "Registration Status": fill(a.student_accounts?.registration_status || NO_VALUE),
        "Account Status": fill(a.student_accounts?.account_status || NO_VALUE),
        "Supporting Documents": fill(docByApp[a.application_id] || NO_VALUE),
        "Supporting Doc Files": fill(docFilesByApp[a.application_id] || NO_VALUE),
        "Applicant Type": fill(acad?.applicant_type || NO_VALUE),
        "SHS GWA": acad?.shs_gwa != null ? Number(acad.shs_gwa) : acad?.college_gpa != null ? Number(acad.college_gpa) : "N/A",
        "College GPA": acad?.college_gpa != null ? Number(acad.college_gpa) : acad?.shs_gwa != null ? Number(acad.shs_gwa) : "N/A",
        "Academic Proof File": fill(acad?.proof_image_path || NO_VALUE),
        "Remarks": fill(a.remarks || NO_VALUE),
      };
    });
  }

  function exportCsv() {
    const rows = buildCsvRows(filteredApps);
    if (!rows.length) return;
    downloadCsv("scholarship-applications.csv", rows);
    setMessage(`Exported ${rows.length} application(s) as CSV.`);
    toast.success(`Exported ${rows.length} application(s) as CSV.`);
  }

  function exportOneCsv(app: ScholarshipApplication) {
    const rows = buildCsvRows([app]);
    downloadCsv(`application-${app.application_id}-details.csv`, rows);
    setMessage("Exported this student's full application form as CSV.");
    toast.success("Exported this student's full application form as CSV.");
  }

  const viewingApp = applications.find((a) => a.application_id === viewingId) || null;

  if (loading) return <Spinner label="Loading applications..." color="maroon" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Scholarship Applications</h1>
          <p className="mt-1 text-xs text-[#8B7376]">{applications.length} student application(s) received.</p>
        </div>
        <button
          onClick={exportCsv}
          disabled={!filteredApps.length}
          className="self-start rounded-xl border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-40"
        >
          &#11015; Export CSV
        </button>
      </div>

      {message && (
        <div className="rounded-xl border border-[#7B1113]/20 bg-white px-4 py-3 text-xs font-medium text-[#7B1113] shadow-sm">
          {message}
        </div>
      )}

      <div className="relative w-full sm:max-w-md">
        <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B7376]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search by name, student #, program, year, sex, scholarship..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-xl border border-[#241012]/[0.06] bg-white py-2.5 pl-10 pr-4 text-xs outline-none focus:border-[#7B1113] focus:ring-1 focus:ring-[#7B1113]/20"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTER_TABS.map((tab) => {
          const count = tab.key === "" ? applications.length : tab.key === "Approved" ? approvedCount : tab.key === "Not Approved" ? notApprovedCount : pendingCount;
          return (
            <button
              key={tab.key || "all"}
              onClick={() => setStatusFilter(tab.key)}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition ${statusFilter === tab.key ? tab.active : `${tab.idle} border border-transparent`} ${statusFilter === tab.key ? "" : "border border-[#241012]/[0.06]"}`}
            >
              {tab.label} ({count})
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setProgramFilter("")}
          className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition ${programFilter === "" ? "bg-[#7B1113] text-white shadow" : "border border-[#241012]/[0.08] bg-white text-[#241012] hover:border-[#7B1113]/40"}`}
          title="Show every scholarship program"
        >
          📚 All programs ({totalByStatus})
        </button>
        {programNames.map((name) => (
          <button
            key={name}
            onClick={() => setProgramFilter(programFilter === name ? "" : name)}
            className={`max-w-full truncate rounded-full px-3 py-1.5 text-[11px] font-bold transition ${programFilter === name ? "bg-[#7B1113] text-white shadow" : "border border-[#241012]/[0.08] bg-white text-[#241012] hover:border-[#7B1113]/40"}`}
            title={`Show only applications filed under "${name}"`}
          >
            📚 {name} ({programCounts[name] ?? 0})
          </button>
        ))}
      </div>

      {filteredApps.length === 0 ? (
        <EmptyState icon="&#128196;" title="No applications found" hint="Applications will appear here once students submit them." />
      ) : (
        <div className="space-y-3">
          <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-[#241012]">
                <input
                  type="checkbox"
                  checked={filteredApps.length > 0 && filteredApps.every((a) => selectedIds.has(a.application_id))}
                  onChange={toggleSelectAll}
                  className="h-4 w-4 accent-[#7B1113]"
                />
                Select all ({filteredApps.length})
              </label>
              {selectedIds.size > 0 && (
                <span className="rounded-full bg-[#7B1113]/10 px-2.5 py-1 text-[11px] font-bold text-[#7B1113]">{selectedIds.size} selected</span>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#241012]/[0.12] bg-[#F3EEEB] px-3 py-2 text-[11px] font-bold text-[#6B5458]"
                title="Locked for Admin — only CHED can approve or not-approve applications. Approve/Not approve buttons are on the CHED portal."
              >
                &#128274; Final approval: CHED only
              </span>
              <button
                onClick={() => batchStatus("Pending", [...selectedIds])}
                disabled={!selectedIds.size || batchBusy}
                className="rounded-lg border border-amber-300 px-3 py-2 text-[11px] font-bold text-amber-700 transition hover:bg-amber-50 disabled:opacity-40"
              >
                Mark Pending
              </button>
              <input
                value={batchMsg}
                onChange={(e) => setBatchMsg(e.target.value)}
                placeholder="Notification message for selected students..."
                className="min-w-40 flex-1 rounded-lg border border-[#241012]/[0.06] px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              />
              <button
                onClick={batchNotify}
                disabled={!selectedIds.size || batchBusy}
                className="rounded-lg border border-[#7B1113]/30 px-3 py-2 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-40"
              >
                Notify selected
              </button>
            </div>
          </div>

          {Object.entries(
            filteredApps.reduce<Record<string, ScholarshipApplication[]>>((acc, app) => {
              const key = app.scholarship_programs?.scholarship_name || "No Scholarship Program";
              (acc[key] = acc[key] || []).push(app);
              return acc;
            }, {})
          ).sort(([a], [b]) => a.localeCompare(b)).map(([programName, groupApps]) => (
            <section key={programName}>
              <div className="mb-2 mt-1 flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-bold text-[#7B1113]">📚 {programName}</h2>
                <span className="rounded-full bg-[#7B1113]/10 px-2.5 py-0.5 text-[10px] font-bold text-[#7B1113]">
                  {groupApps.length} application{groupApps.length === 1 ? "" : "s"}
                </span>
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-bold text-amber-700">
                  {groupApps.filter((a) => a.application_status === "Pending").length} pending
                </span>
                {groupApps.some((a) => a.application_status === "Approved") && (
                  <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-[10px] font-bold text-green-700">
                    {groupApps.filter((a) => a.application_status === "Approved").length} approved
                  </span>
                )}
                {groupApps.some((a) => a.application_status === "Not Approved") && (
                  <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-[10px] font-bold text-red-700">
                    {groupApps.filter((a) => a.application_status === "Not Approved").length} not approved
                  </span>
                )}
              </div>
              <div className="space-y-3">
                {groupApps.map((app) => {
            const currentStatus = app.application_status;
            const reqStats = requirementStats(app);
            const allReqs = reqStats.required.length > 0 && reqStats.missing.length === 0;
            return (
              <div key={app.application_id} className={`rounded-xl border bg-white p-4 shadow-sm transition ${selectedIds.has(app.application_id) ? "border-[#7B1113] ring-1 ring-[#7B1113]/20" : "border-[#241012]/[0.06]"}`}>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(app.application_id)}
                      onChange={() => toggleSelect(app.application_id)}
                      className="mt-1 h-4 w-4 shrink-0 accent-[#7B1113]"
                      title="Select this application"
                    />
                    <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-[#7B1113]/10 text-sm font-bold text-[#7B1113]">
                      {app.student_accounts?.given_name?.[0] || "S"}{app.student_accounts?.last_name?.[0] || ""}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold text-[#241012]">
                          {app.student_accounts?.last_name}, {app.student_accounts?.given_name}
                          <span className="font-normal text-[#8B7376]"> ({app.student_accounts?.student_number || "\u2014"})</span>
                        </p>
                        <Badge className={STATUS_STYLES[currentStatus] || ""}>{currentStatus}</Badge>
                        <Badge
                          className={allReqs
                            ? "border-green-200 bg-green-50 text-green-700"
                            : "border-amber-200 bg-amber-50 text-amber-700"}
                          title={
                            reqStats.missing.length === 0
                              ? "The student uploaded every requirement of this program"
                              : `Not compliant — missing: ${reqStats.missing.join(", ")}`
                          }
                        >
                          {allReqs ? "\u2713 " : "\u26A0 "}{reqStats.done}/{reqStats.required.length} requirements
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-[#7B1113]">{app.scholarship_programs?.scholarship_name || "\u2014"}</p>
                      <p className="text-[11px] text-[#8B7376]">{app.student_accounts?.program_name || "\u2014"} &middot; Submitted {formatDateTime(app.application_date)}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:flex-none">
                    {STATUS_ACTIONS.map((action) =>
                      currentStatus === action.status ? null : (
                        <button
                          key={action.status}
                          onClick={() => quickStatus(app, action.status)}
                          disabled={savingId === app.application_id}
                          className="whitespace-nowrap rounded-lg border border-amber-300 px-3 py-1.5 text-[11px] font-bold text-amber-700 transition hover:bg-amber-50 disabled:opacity-40"
                          title="Set this application back to Pending"
                        >
                          Mark {action.label}
                        </button>
                      )
                    )}
                    <button
                      onClick={() => openDetails(app.application_id)}
                      className="rounded-lg border border-[#241012]/15 px-3 py-1.5 text-[11px] font-bold text-[#241012] transition hover:bg-[#FAF7F5]"
                    >
                      View Details
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex flex-col gap-2 rounded-lg border border-[#241012]/[0.06] bg-[#FAF7F5]/60 p-2.5 sm:flex-row sm:items-center">
                  <button
                    onClick={() => handleNotify(app)}
                    className="rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                  >
                    Notify student
                  </button>
                  <input
                    value={notifyDraft[app.application_id] || ""}
                    onChange={(e) => setNotifyDraft((prev) => ({ ...prev, [app.application_id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleNotify(app); } }}
                    placeholder="Send this student a message..."
                    className="flex-1 rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-1.5 text-xs outline-none focus:border-[#7B1113]"
                  />
                  <button
                    onClick={() => openDetails(app.application_id)}
                    className="rounded-lg bg-[#7B1113] px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-[#540111]"
                  >
                    Update status &amp; docs
                  </button>
                </div>
              </div>
            );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {viewingApp && (
        <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-[#241012]/50 p-4 backdrop-blur-sm sm:p-8" onClick={() => setViewingId(null)}>
          <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-[#241012]/[0.06] p-5">
              <div className="min-w-0">
                <h3 className="text-lg font-bold text-[#241012]">Application Details</h3>
                <p className="mt-0.5 text-xs text-[#8B7376]">
                  {viewingApp.student_accounts?.last_name}, {viewingApp.student_accounts?.given_name} &middot; {viewingApp.student_accounts?.student_number || "\u2014"}
                </p>
              </div>
              <button onClick={() => setViewingId(null)} className="rounded-lg p-2 text-[#8B7376] transition hover:bg-[#F3EEEB] hover:text-[#241012]" aria-label="Close">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-5 w-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="max-h-[calc(100vh-12rem)] space-y-6 overflow-y-auto p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={STATUS_STYLES[viewingApp.application_status] || ""}>{viewingApp.application_status}</Badge>
                <Badge className="border-[#241012]/[0.06] bg-[#F3EEEB] text-[#6B5458]">{viewingApp.scholarship_programs?.scholarship_name || "\u2014"}</Badge>
                <button onClick={() => exportOneCsv(viewingApp)} className="rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5">
                  &#11015; Export full form CSV
                </button>
              </div>

              <div className="rounded-xl border border-[#241012]/[0.06] bg-[#FAF7F5]/60 p-4">
                <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Applicant Profile</h4>
                <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-4">
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Full Name</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.last_name}, {viewingApp.student_accounts?.given_name}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Student No.</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.student_number || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Program</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.program_name || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Year Level</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.year_level || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Sex</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.sex || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Registration</p><div className="mt-0.5"><Badge className={viewingApp.student_accounts?.registration_status === "Verified" ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}>{viewingApp.student_accounts?.registration_status || "\u2014"}</Badge></div></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Account Status</p><div className="mt-0.5"><Badge className={viewingApp.student_accounts?.account_status === "Active" ? "border-green-200 bg-green-50 text-green-700" : "border-[#241012]/[0.06] bg-[#F3EEEB] text-[#6B5458]"}>{viewingApp.student_accounts?.account_status || "\u2014"}</Badge></div></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Submitted</p><p className="mt-0.5 font-semibold text-[#241012]">{formatDateTime(viewingApp.application_date)}</p></div>
                </div>
              </div>

              {appChed(viewingApp).length > 0 ? (
                <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-4">
                  <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Application Form Submitted</h4>
                  {appChed(viewingApp).map((c) => (
                    <div key={c.ched_form_id} className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-4">
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Last Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.last_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">First Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.given_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Middle Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.middle_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Ext. Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.ext_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Sex</p><p className="mt-0.5 font-semibold text-[#241012]">{c.sex || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Birthdate</p><p className="mt-0.5 font-semibold text-[#241012]">{c.birthdate || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Program</p><p className="mt-0.5 font-semibold text-[#241012]">{c.complete_program_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Year Level</p><p className="mt-0.5 font-semibold text-[#241012]">{c.year_level || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Father&apos;s Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.father_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Mother&apos;s Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.mother_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Street / Barangay</p><p className="mt-0.5 font-semibold text-[#241012]">{c.street_barangay || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Zipcode</p><p className="mt-0.5 font-semibold text-[#241012]">{c.zipcode || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Contact Number</p><p className="mt-0.5 font-semibold text-[#241012]">{c.contact_number || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Email Address</p><p className="mt-0.5 font-semibold text-[#241012]">{c.email_address || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Disability</p><p className="mt-0.5 font-semibold text-[#241012]">{c.disability || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">IP Group</p><p className="mt-0.5 font-semibold text-[#241012]">{c.indigenous_people_group || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Annual Family Income</p><p className="mt-0.5 font-semibold text-[#241012]">&#8369;{Number(c.annual_income_family || 0).toLocaleString()}/yr</p></div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-[#8B7376]">ITR File</p>
                        {c.income_tax_return ? (
                          fileUrls[c.income_tax_return] ? (
                            <a href={fileUrls[c.income_tax_return]} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-[#7B1113] px-3 py-1.5 text-[11px] font-bold text-white shadow-sm transition hover:bg-[#540111]" title="Open the submitted Income Tax Return in a new tab">
                              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-3.5 w-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 10.5h18M3 6h18M12 6v18M10.5 3h3M4.5 21h15a1.5 1.5 0 001.5-1.5V7.5A1.5 1.5 0 0019.5 6h-15A1.5 1.5 0 003 7.5v12A1.5 1.5 0 004.5 21z" /></svg>
                              View ITR
                            </a>
                          ) : (
                            <button type="button" disabled className="mt-1 inline-flex cursor-default items-center gap-1.5 rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-semibold text-[#8B7376]" title="Opening...">
                              <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#7B1113]/30 border-t-[#7B1113]" />
                              Opening ITR...
                            </button>
                          )
                        ) : <p className="mt-0.5 font-semibold text-[#241012]">{"\u2014"}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-4">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Application Form</h4>
                  <p className="mt-2 text-[11px] text-[#8B7376]">The student has not completed the CHED application form yet.</p>
                </div>
              )}

              <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-4">
                <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Academic Records ({appAcads(viewingApp).length})</h4>
                {appAcads(viewingApp).length === 0 ? (
                  <p className="text-[11px] text-[#8B7376]">No academic records uploaded.</p>
                ) : (
                  <ul className="space-y-2">
                    {appAcads(viewingApp).map((a) => (
                      <li key={a.record_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#241012]/[0.06] bg-[#FAF7F5]/60 px-3 py-2">
                        <div className="flex items-center gap-3 text-xs">
                          <Badge className="border-[#241012]/[0.06] bg-white text-[#6B5458]">{a.applicant_type || "N/A"}</Badge>
                          <span className="font-semibold text-[#241012]">GWA/GPA: {a.shs_gwa ?? a.college_gpa ?? "\u2014"}</span>
                        </div>
                        {a.proof_image_path && fileUrls[a.proof_image_path] ? (
                          <a href={fileUrls[a.proof_image_path]} target="_blank" rel="noreferrer" className="font-semibold text-[#7B1113] hover:underline">View proof</a>
                        ) : a.proof_image_path ? (
                          <span className="text-[10px] font-semibold text-[#8B7376]">uploaded</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-4">
                <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Support Documents ({appDocs(viewingApp).length})</h4>
                {appDocs(viewingApp).length === 0 ? (
                  <p className="text-[11px] text-[#8B7376]">No documents uploaded.</p>
                ) : (
                  <ul className="space-y-2">
                    {appDocs(viewingApp).map((d) => (
                      <li key={d.document_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#241012]/[0.06] bg-[#FAF7F5]/60 px-3 py-2">
                        <div className="flex items-center gap-2 text-xs">
                          <Badge className="border-[#241012]/[0.06] bg-white text-[#6B5458]">{d.document_type}</Badge>
                          <span className="text-[10px] text-[#8B7376]">{d.file_path.split("/").pop()}</span>
                        </div>
                        {fileUrls[d.file_path] ? (
                          <a href={fileUrls[d.file_path]} target="_blank" rel="noreferrer" className="font-semibold text-[#7B1113] hover:underline">View</a>
                        ) : (
                          <span className="text-[10px] font-semibold text-[#8B7376]">uploaded</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-[#241012]/[0.06] p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Update Status</h4>
                  <p className="mt-0.5 text-[10px] text-[#8B7376]">
                    Approve &amp; Not Approve are decided by <b className="text-[#7B1113]">CHED only</b>.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {STATUS_ACTIONS.map((action) => {
                      const draft = statusDraft[viewingApp.application_id] || { status: viewingApp.application_status, remarks: viewingApp.remarks || "" };
                      const isActive = draft.status === action.status;
                      return (
                        <button
                          key={action.status}
                          onClick={() => setStatusDraft({ ...statusDraft, [viewingApp.application_id]: { ...draft, status: action.status } })}
                          className={`rounded-lg border px-3 py-1.5 text-[11px] font-bold transition ${isActive ? action.active : action.idle}`}
                        >
                          {action.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button
                  onClick={() => exportOneCsv(viewingApp)}
                  className="self-start rounded-xl bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white transition hover:bg-[#540111]"
                >
                  &#11015; Export form CSV
                </button>
              </div>

              <input
                value={(statusDraft[viewingApp.application_id] && statusDraft[viewingApp.application_id].remarks) ?? viewingApp.remarks ?? ""}
                onChange={(e) => setStatusDraft((prev) => ({ ...prev, [viewingApp.application_id]: { status: prev[viewingApp.application_id]?.status ?? viewingApp.application_status, remarks: e.target.value } }))}
                placeholder="Remarks (sent to the student)..."
                className="rounded-lg border border-[#241012]/[0.06] px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              />
              <button
                onClick={() => handleStatusSave(viewingApp)}
                disabled={savingId !== null}
                className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2.5 text-xs font-bold text-white transition hover:brightness-110 disabled:opacity-40"
              >
                {savingId === viewingApp.application_id ? "Saving..." : "Save Status + Notify Student"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
