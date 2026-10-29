"""Data preprocessing for the St. Peter's College TES Application Form export.

Source : Google Forms sheet export (.xlsx, 1192 rows x 30 cols)
Outputs:
  1. <name>_CLEANED.xlsx  - full data, every value normalized + QA flags
  2. <name>_ML_READY.csv  - anonymous ML training features (NO PII, NO income)

Pipeline: load -> text cleanup -> categorical normalization -> date/age
validation -> format repair (phone/email/zip/id) -> flag/standardize
priority fields (PWD / IP / 4Ps / solo-parent / first-gen) -> dedupe ->
validate -> export + QA report.

Run from the repository root:  python tools\training\preprocess_tes_form.py "<path to form export .xlsx>"
"""
from __future__ import annotations

import csv
import datetime as dt
import re
import sys
from collections import Counter
from pathlib import Path

from openpyxl import Workbook, load_workbook

# ---------------------------------------------------------------- helpers
JUNK = {
    "", "n/a", "na", "n.a", "n.a.", "n/f", "none", "no", "not", "not applicable",
    ".", "-", "_", "*", "0", "nil", "wala", "non", "nope", "nothing", "nave",
    "nan", "blank", "(blank)", "leave blank", "leave", "not applicable.",
}
JUNK_NO = JUNK | {"no", "n", "false", "-"}  # explicit negatives

IP_WHITELIST = {  # recognized indigenous groups (IPRA/NCIP) - normalized
    "maranao": "Maranao", "meranao": "Maranao", "meranaw": "Maranao",
    "higaonon": "Higaonon", "subanin": "Subanen", "subanen": "Subanen",
    "blaan": "Blaan", "tagakaulo": "Tagakaulo", "manobo": "Manobo",
    "teguanaa": "T'boli", "tboli": "T'boli", "yakan": "Yakan",
    "tausug": "Tausug", "maguindanaon": "Maguindanaon", "bagobo": "Bagobo",
    "lumad": "Lumad", "lumad group": "Lumad", "mangguangan": "Mangguangan",
    "calagan": "Calagan", "pangutaro": "Pangutaro", "nonok": "Nonok",
    "maguindanao": "Maguindanao", "maranaw": "Maranao", "maranaw ": "Maranao",
    "iranun": "Iranun", "kalagan": "Kalagan", "tagabawa": "Tagabawa",
    "badjao": "Badjao", "badjau": "Badjao", "sama": "Sama", "sangil": "Sangil",
}
# ethnolinguistic / religion / nationality words that are NOT IP under IPRA
NON_IP_WORDS = {
    "cebuano", "bisaya", "waray", "iliganon", "ilonggo", "tagalog", "bicolano",
    "ilocano", "pangasinense", "kampampangan", "kapampangan", "iganon",
    "binisaya", "bisdak", "muslim", "islam", "christian", "catholic",
    "roman catholic", "filipino", "pilipino", "religion", "iglesia", "born again",
    "english", "american", "spanish", "mixed", "n/a", "other",
}
IP_VAGUE = {"ip", "yes", "y", "1", "indigenous", "indigenous people"}

PWD_CATEGORIES = [
    ("visual", r"eye|vision|visual|see|blind|esotropia|strabismus|cataract|glaucoma|myopia|astigmat"),
    ("hearing", r"hear|deaf|ears?|otitis"),
    ("physical/orthopedic", r"ortho|bone|bones?|limb|physical|weakness|polio|amput|fracture|spine|dislocat|crutch|wheelchair|scoliosis|club ?foot|cleft"),
    ("psychological", r"psych|mental|behavior|autis|adhd|depress|anxiet|bipolar"),
    ("speech", r"speech|stutter|mute|delay"),
    ("chronic/other", r"diabet|asthma|epilep|heart|kidney|cancer|sickle|chronic|disabil"),
]
# entries that look like answers but are NOT a disability
PWD_NOT_DISABILITY = (
    "working student", "financial", "tuition", "normal", "nose clip", "blood",
    "student", "problem", "none", "wala", "n/a", "healthy", "ok", "good",
    "type", "nose", "nome",
)
GENDER_MAP = {"0": "Male", "1": "Female", "m": "Male", "f": "Female",
               "male": "Male", "female": "Female"}
REGION_MAP = {
    "10": "Region X", "x": "Region X", "region x": "Region X", "region 10": "Region X",
    "region10": "Region X", "region-10": "Region X", "regionx": "Region X",
    "9": "Region IX", "region ix": "Region IX", "region 9": "Region IX",
    "ix": "Region IX", "region9": "Region IX", "region-9": "Region IX",
    "12": "Region XII", "region xii": "Region XII", "region 12": "Region XII",
    "7": "Region VII", "region 7": "Region VII", "region vii": "Region VII",
    "8": "Region VIII", "region 8": "Region VIII", "region viii": "Region VIII",
    "barmm": "BARMM", "islam": "BARMM", "bangsamoro": "BARMM",
    "car": "CAR", "ncr": "NCR",
}
TRUE_FALSE = {"1": 1, "0": 0, "yes": 1, "y": 1, "no": 0, "n": 0, "true": 1, "false": 0}
YEAR_RE = re.compile(r"^\s*([1-5])\s*$")
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
AGE_MIN, AGE_MAX = 15, 60


def s(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return re.sub(r"\s+", " ", str(v)).strip()


def is_junk(v) -> bool:
    return s(v).lower().strip(" .,;:-") in JUNK


def norm_yesno(v):
    """1/Yes -> 1, 0/No/junk-blank -> 0, unparseable -> None."""
    t = s(v).lower()
    if t in JUNK and t not in ("0", "1", "yes", "no"):
        return None
    return TRUE_FALSE.get(t)


def parse_date(v):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    t = s(v)[:10]
    for f in ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d", "%d/%m/%Y", "%m-%d-%Y"):
        try:
            return dt.datetime.strptime(t, f).date()
        except ValueError:
            continue
    return None


def norm_email(raw: str) -> tuple[str, bool]:
    e = s(raw).lower().replace(" ", "")
    if not e:
        return "", False
    # common typos: local@gmail.com -> local@gmail.com is handled below
    e = e.replace("@.com", ".com").replace("@gmail", "@gmail")
    m = re.match(r"^([A-Za-z0-9._%+-]+)(\.gmail\.com|\.yahoo\.com|\.outlook\.com|\.hotmail\.com)$", e)
    if m:
        e = m.group(1) + "@" + m.group(2)[1:]
    if EMAIL_RE.match(e):
        return e, True
    return s(raw), False


def norm_phone(raw: str) -> tuple[str, bool]:
    t = re.sub(r"[\s\-\(\)]", "", s(raw))
    if not t:
        return "", False
    if re.fullmatch(r"9\d{9}", t):
        t = "0" + t
    ok = bool(re.fullmatch(r"09\d{9}", t))
    return t, ok


def categorize_disability(raw: str) -> str:
    low = s(raw).lower()
    for cat, pat in PWD_CATEGORIES:
        if re.search(pat, low):
            return cat
    return "other"


def norm_program(raw: str) -> str:
    p = re.sub(r"\s+", " ", s(raw)).upper().strip(" .")
    p = p.replace("  ", " ")
    return p


def norm_city(raw: str) -> str:
    c = re.sub(r"\s+", " ", s(raw)).strip()
    if not c:
        return ""
    key = c.lower().replace("-", "").replace(" ", "")
    alias = {"iligan": "Iligan City", "iligancity": "Iligan City",
             "baloi": "Baloi", "baloii": "Baloi", "matungao": "Matungao",
             "linamon": "Linamon", "kauswagan": "Kauswagan", "lugait": "Lugait"}
    if key in alias:
        return alias[key]
    return c.title()


VALID_REGIONS = {
    "region i", "region ii", "region iii", "region iv-a", "region iv-b", "region v",
    "region vi", "region vii", "region viii", "region ix", "region x", "region xi",
    "region xii", "region xiii", "car", "ncr", "barmm", "bangsamoro autonomous" ,
}


def norm_region(raw: str) -> str:
    r = s(raw)
    if not r:
        return ""
    mapped = REGION_MAP.get(r.lower(), r.title())
    return mapped if mapped.lower() in VALID_REGIONS else ""


# phrases/words in the IP column that are NOT an indigenous group
IP_DENY = (
    "dont know", "don't know", "do not know", "i dont", "i don't", "not",
    "none", "nome", "n.a", "nope", "n/a", "solo", "fisher", "farmer",
    "poor", "income", "financial", "mindanao", "cebuana", "cebuano", "dili",
    "know", "non", "indigenous people?", "religion", "muslim", "christian",
    "catholic", "poverty", "yes,", "low income", "same", "nothing", "wala",
    "moro", "null", "noje", "no-ip", "no ip", "mother", "cebunao", "m/a",
)


def normalize_ip(raw: str) -> tuple[int, str]:
    t = s(raw).lower().strip(" .,;:-")
    if not t or t in JUNK:
        return 0, ""
    if t in IP_WHITELIST:
        return 1, IP_WHITELIST[t]
    if t in IP_VAGUE:
        return 1, "Unspecified"
    # free-form lists: "Maranao Or Muslim", "Maranao, Higaonon"
    parts = [p.strip() for p in re.split(r"[,;/]|\bor\b", t) if p.strip()]
    hits = [IP_WHITELIST[p] for p in parts if p in IP_WHITELIST]
    if hits:
        return 1, " / ".join(dict.fromkeys(hits))
    if t in NON_IP_WORDS or any(d in t for d in IP_DENY):
        return 0, ""
    # unknown free text: keep as IP ONLY when it looks like a group name
    # (short, alphabetic) - and mark it for admin review so nothing is lost.
    if len(t) <= 24 and re.fullmatch(r"[a-z\s'’\-/]+", t) and t not in JUNK_NO:
        return 1, f"Review: {s(raw).title()}"
    return 0, ""


def normalize_disability(raw: str):
    """Returns (flag, category, raw_note)."""
    t = s(raw)
    low = t.lower().strip(" .,;:-")
    if not t or low in JUNK:
        return 0, "", ""
    # "Yes" = PWD but no type given
    if low in ("yes", "y", "1"):
        return 1, "unspecified", t
    # blood-type / short non-answers ("AB", "O+", "ok")
    if re.fullmatch(r"[abo]{1,3}[+-]?|[a-z]{1,2}[+-]?", low):
        return 0, "", ""
    cat = categorize_disability(t)
    if cat != "other":
        return 1, cat, t
    # not a recognized disability category: check for non-disability answers
    if any(p in low for p in PWD_NOT_DISABILITY):
        return 0, "", ""
    if re.search(r"\d{6,}|street|brgy|barangay|gmail|@", low) or len(t) > 60:
        return 0, "", t if len(t) <= 40 else ""
    return 1, "other", t


# ---------------------------------------------------------------- main
def run(src: Path):
    ws = load_workbook(src, read_only=True, data_only=True).active
    rows = list(ws.iter_rows(values_only=True))
    hdr = [s(c) for c in rows[0]]
    body = rows[1:]
    n = len(body)
    fixes = Counter()
    flags = Counter()

    def H(part: str) -> int:
        for i, h in enumerate(hdr):
            if part.lower() in h.lower():
                return i
        raise KeyError(part)

    C = {
        "ts": H("Timestamp"), "sid": H("Student ID"), "lrn": H("LRN"),
        "philsys": H("PHILSYS"), "ps4": H("4PS"), "last": H("LAST NAME"),
        "given": H("GIVEN NAME"), "ext": H("EXTENSION"), "mid": H("MIDDLE NAME"),
        "sex": H("SEX"), "dob": H("BIRTHDATE"), "prog": H("COMPLETE PROGRAM"),
        "yr": H("YEAR LEVEL"), "fl": H("FATHER'S GIVEN"), "fmid": H("FATHER'S MIDDLE"),
        "flast": H("FATHER'S LAST"), "mlast": H("MOTHER'S MAIDEN NAME, LAST"),
        "mgiven": H("MOTHER'S MAIDEN NAME, GIVE"), "mmid": H("MOTHER'S MAIDEN NAME, MIDD"),
        "fst": H("STREET"),
        "city": H("CITY/MUNI"), "prov": H("PROVINCE"), "region": H("REGION"),
        "zip": H("ZIPCODE"), "phone": H("CONTACT"), "email": H("EMAIL"),
        "pwd": H("DISABILITY"), "solo": H("Solo Parent"),
        "fg": H("first-generation"), "ip": H("INDIGENOUS"),
    }

    out = []          # cleaned rows (dicts)
    invalid_regions = Counter()
    for r in body:
        g = lambda k: r[C[k]] if C[k] < len(r) else None
        rec = {}

        # --- text PII fields: trim/collapse only
        for k in ("sid", "lrn", "philsys", "last", "given", "ext", "mid",
                  "fl", "fmid", "flast", "mlast", "mgiven", "mmid", "fst"):
            rec[k] = s(g(k))
            if rec[k] != s(r[C[k]]):
                fixes["whitespace_trimmed"] += 1
        rec["sid"] = rec["sid"].upper()

        # --- timestamp
        ts = parse_date(g("ts"))
        rec["timestamp"] = ts.isoformat() if ts else ""
        if not ts:
            flags["missing_timestamp"] += 1

        # --- sex
        sx = s(g("sex"))
        rec["sex"] = GENDER_MAP.get(sx.lower(), "")
        if not rec["sex"]:
            flags["missing_sex"] += 1
            fixes["sex_normalized"] += 0

        # --- birthdate -> age
        d = parse_date(g("dob"))
        rec["birthdate"] = d.isoformat() if d else ""
        age = None
        if d:
            age = (dt.date.today() - d).days // 365
            if age < 0:
                fixes["future_birthdate_repaired_or_flagged"] += 1
            if not (AGE_MIN <= age <= AGE_MAX):
                flags["invalid_age"] += 1
                age = None
        else:
            flags["unparsable_birthdate"] += 1
        rec["age"] = age if age is not None else ""

        # --- program / year
        rec["program"] = norm_program(g("prog"))
        if not rec["program"]:
            flags["missing_program"] += 1
        m = YEAR_RE.match(s(g("yr")))
        rec["year_level"] = int(m.group(1)) if m else None
        if rec["year_level"] is None:
            flags["missing_year_level"] += 1

        # --- geo
        city = norm_city(g("city"))
        if city != s(g("city")):
            fixes["city_case_normalized"] += 1
        rec["city"] = city
        rec["province"] = re.sub(r"\s+", " ", s(g("prov"))).title()
        reg = norm_region(g("region"))
        if reg != s(g("region")):
            fixes["region_normalized"] += 1
        if s(g("region")) and not reg:
            flags["invalid_region_cleared"] += 1
            invalid_regions[s(g("region"))] += 1
        rec["region"] = reg
        z = re.sub(r"\D", "", s(g("zip")))
        rec["zip"] = z if len(z) == 4 else (z if z else "")
        if z and len(z) != 4:
            flags["invalid_zip"] += 1

        # --- phone / email
        ph, ph_ok = norm_phone(g("phone"))
        if ph and ph != s(g("phone")):
            fixes["phone_repaired"] += 1
        if ph and not ph_ok:
            flags["invalid_phone"] += 1
        rec["contact"] = ph
        em, em_ok = norm_email(g("email"))
        if em and em != s(g("email")):
            fixes["email_repaired"] += 1
        if em and not em_ok:
            flags["invalid_email"] += 1
        rec["email"] = em if em_ok else s(g("email"))

        # --- priority flags
        pwd_flag, pwd_cat, pwd_note = normalize_disability(g("pwd"))
        if pwd_flag:
            flags["pwd_yes"] += 1
        elif s(g("pwd")) and s(g("pwd")).lower() not in JUNK:
            fixes["disability_junk_cleared"] += 1
        rec["pwd_flag"], rec["disability_category"], rec["disability_note"] = pwd_flag, pwd_cat, pwd_note

        ip_flag, ip_group = normalize_ip(g("ip"))
        if ip_flag:
            flags["ip_yes"] += 1
        elif s(g("ip")):
            fixes["ip_junk_cleared"] += 1
        rec["ip_flag"], rec["ip_group"] = ip_flag, ip_group

        solo = norm_yesno(g("solo"))
        fg = norm_yesno(g("fg"))
        rec["solo_parent"] = solo if solo is not None else ""
        rec["first_gen"] = fg if fg is not None else ""
        if solo is None and s(g("solo")):
            flags["solo_parent_unparsed"] += 1
        if fg is None and s(g("fg")):
            flags["first_gen_unparsed"] += 1

        # 4PS membership: junk -> No, ID present -> Yes (ID itself is PII)
        raw4 = s(g("ps4"))
        if is_junk(raw4):
            rec["is_4ps"] = 0
        elif raw4:
            rec["is_4ps"] = 1
            fixes["4ps_flag_derived"] += 1
        else:
            rec["is_4ps"] = 0
        if rec["is_4ps"]:
            flags["4ps_yes"] += 1

        # QA flags per row
        rec["_qa"] = ";".join(
            k for k, bad in (
                ("no_sid", not rec["sid"]),
                ("bad_email", bool(rec["email"]) and not EMAIL_RE.match(rec["email"].lower())),
                ("bad_phone", bool(rec["contact"]) and not re.fullmatch(r"09\d{9}", rec["contact"])),
                ("no_age", rec["age"] == ""),
                ("no_year", rec["year_level"] is None),
            ) if bad
        )
        out.append(rec)

    # ------------------------------------------------------- dedupe
    seen: dict[str, int] = {}
    dedup = []
    dup_count = 0
    for rec in out:
        key = rec["sid"]
        if key:
            if key in seen:
                dup_count += 1
                # keep the row with the latest timestamp
                prev = dedup[seen[key]]
                if rec["timestamp"] >= prev["timestamp"]:
                    dedup[seen[key]] = rec
                continue
            seen[key] = len(dedup)
        dedup.append(rec)
    fixes["duplicate_rows_removed"] = dup_count

    # ------------------------------------------------------- export
    base = src.with_suffix("")
    cleaned_x = Path(str(base) + "_CLEANED.xlsx")
    ml_csv = Path(str(base) + "_ML_READY.csv")

    wb = Workbook()
    sh = wb.active
    sh.title = "CLEANED"
    cols = ["timestamp", "sid", "sex", "age", "birthdate", "year_level", "program",
            "pwd_flag", "disability_category", "ip_flag", "ip_group", "solo_parent",
            "first_gen", "is_4ps", "city", "province", "region", "zip",
            "contact", "email", "lrn", "philsys", "last", "given", "ext", "mid",
            "fst", "flast", "fl", "fmid", "mlast", "mgiven", "mmid", "_qa"]
    sh.append([c.upper() if c.startswith("_") else c for c in cols])
    for rec in dedup:
        sh.append([rec.get(c, "") for c in cols])
    wb.save(cleaned_x)

    ml_cols = ["year_level", "sex", "age", "program", "city", "region", "zip",
               "pwd_flag", "disability_category", "ip_flag", "ip_group",
               "solo_parent", "first_gen", "is_4ps"]
    with ml_csv.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=ml_cols, extrasaction="ignore")
        w.writeheader()
        for rec in dedup:
            row = {k: rec.get(k, "") for k in ml_cols}
            row["sex"] = {"Male": "Male", "Female": "Female"}.get(rec["sex"], "")
            w.writerow(row)

    # ------------------------------------------------------- report
    print("=" * 72)
    print("DATA PREPROCESSING REPORT")
    print(f"source      : {src.name}")
    print(f"raw rows    : {n}")
    print(f"after dedupe: {len(dedup)}  ({dup_count} duplicate student-id rows removed)")
    print("-" * 72)
    print("REPAIRS APPLIED")
    for k, v in sorted(fixes.items(), key=lambda x: -x[1]):
        if v:
            print(f"  {v:6d}  {k}")
    print("-" * 72)
    print("VALIDATION FLAGS (need review)")
    for k, v in sorted(flags.items(), key=lambda x: -x[1]):
        if v:
            print(f"  {v:6d}  {k}")
    print("-" * 72)
    dist = Counter(r["sex"] or "(blank)" for r in dedup)
    print("SEX      :", dict(dist))
    print("YEAR     :", dict(sorted(Counter(r["year_level"] for r in dedup).items(), key=lambda x: str(x[0]))))
    print("PWD      :", sum(r["pwd_flag"] for r in dedup), "| categories:",
          dict(Counter(r["disability_category"] for r in dedup if r["pwd_flag"])))
    print("IP       :", sum(r["ip_flag"] for r in dedup), "| groups:",
          dict(Counter(r["ip_group"] for r in dedup if r["ip_flag"]).most_common(12)))
    review = Counter(r["ip_group"] for r in dedup
                     if r["ip_flag"] and r["ip_group"].startswith("Review:"))
    if review:
        print("           needs-review IP labels:",
              dict(review.most_common(15)))
    pwd_other = [r["disability_note"] for r in dedup
                 if r["pwd_flag"] and r["disability_category"] == "other"]
    if pwd_other:
        print("PWD other-type notes:", pwd_other[:15])
    print("SOLO-PAR :", sum(1 for r in dedup if r["solo_parent"] == 1))
    print("FIRST-GEN:", sum(1 for r in dedup if r["first_gen"] == 1))
    print("4PS      :", sum(r["is_4ps"] for r in dedup))
    print("REGION   :", dict(Counter(r["region"] or "?" for r in dedup).most_common(6)))
    if invalid_regions:
        print("           cleared invalid regions:", dict(invalid_regions.most_common(10)))
    print("PROGRAMS :", len({r["program"] for r in dedup if r["program"]}))
    ages = [r["age"] for r in dedup if r["age"] != ""]
    print(f"AGE      : n={len(ages)} min={min(ages)} med={sorted(ages)[len(ages)//2]} max={max(ages)}")
    print("-" * 72)
    print(f"CLEANED FILE : {cleaned_x}")
    print(f"ML READY FILE: {ml_csv}")
    print("NOTE: this form has NO income / ITR / GWA column - the ML file")
    print("      carries demographics + PWD/IP/solo-parent/4Ps priority flags only.")
    print("=" * 72)


if __name__ == "__main__":
    src = Path(sys.argv[1] if len(sys.argv) > 1 else
               r"C:\Users\kolin\Downloads\St. Peter's College TES Application Form 1ST SE. AY2026-2027.xlsx")
    run(src)
