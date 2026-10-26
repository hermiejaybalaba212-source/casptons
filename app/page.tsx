"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

const ROLES = [
  { label: "Students", href: "/student", icon: "🎓", desc: "Apply, upload documents, track status, and get warned early.", color: "from-[#7B1113] to-[#540111]" },
  { label: "Administrators", href: "/admin", icon: "⚙️", desc: "Run the ranking model and manage the whole program end to end.", color: "from-[#7B1113] to-[#7B1113]" },
  { label: "Faculty", href: "/faculty", icon: "👨‍🏫", desc: "Catch at-risk scholars early and step in before it's too late.", color: "from-[#A52122] to-[#7B1113]" },
  { label: "CHED", href: "/ched", icon: "🏛️", desc: "Review the ranked list and decide who gets approved.", color: "from-[#7B1113] to-[#3E0009]" },
];

const STEPS = [
  { num: "01", title: "Register & Verify", desc: "Students register and their records are validated against the Registrar Information System." },
  { num: "02", title: "Apply for Scholarship", desc: "Submit application with CHED form, ITR, and supporting documents." },
  { num: "03", title: "ML Ranking", desc: "Random Forest Classifier ranks applicants by annual family income declared in the ITR automatically." },
  { num: "04", title: "CHED Review & Approve", desc: "CHED reviews ranked applicants and approves qualified beneficiaries." },
  { num: "05", title: "Early Warning Monitoring", desc: "Faculty monitor scholars and intervene when grades fall below 93%." },
];

const STATS = [
  { value: "4", label: "User Roles" },
  { value: "5", label: "Core Functions" },
  { value: "93%", label: "Maintaining Average" },
  { value: "25010", label: "ISO/IEC Standard" },
];

const CORE_FUNCTIONS = [
  { title: "Data Validation & Eligibility Screening", desc: "Student identity, enrollment, and academic records are checked against the registrar system before an application moves forward." },
  { title: "Machine Learning Ranking", desc: "A Random Forest Classifier ranks applicants by financial need, using only the annual family income declared in their submitted ITR." },
  { title: "Early-Warning Monitoring", desc: "Scholars whose grades fall below the required 93% maintaining average are flagged automatically for timely intervention." },
  { title: "Secure, Role-Based Storage", desc: "Profiles, applications, documents, rankings, and alerts are stored securely with access limited by role." },
  { title: "Feedback & Continuous Improvement", desc: "Academic standing, approval outcomes, and reapplication data feed back into future scholarship cycles." },
];

const QUALITY = ["Functional Suitability", "Reliability", "Usability", "Performance Efficiency", "Security"];

const STACK = ["Next.js", "React", "TypeScript", "Supabase", "Tailwind CSS", "PostgreSQL", "Random Forest ML"];

function useInView(ref: React.RefObject<HTMLElement | null>, threshold = 0.1) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setInView(true); }, { threshold });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [ref, threshold]);
  return inView;
}

function useTypewriterLoop(part1: string, part2: string, typeSpeed = 45, deleteSpeed = 20, holdTime = 3200, startDelay = 500) {
  const total = part1.length + part2.length;
  const [index, setIndex] = useState(0);
  const [completedOnce, setCompletedOnce] = useState(false);
  useEffect(() => {
    let dir: 1 | -1 = 1;
    let i = 0;
    let delay = startDelay;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      i = Math.max(0, Math.min(total, i + dir));
      setIndex(i);
      if (dir === 1 && i >= total) {
        setCompletedOnce(true);
        dir = -1;
        delay = holdTime;
      } else if (dir === -1 && i <= 0) {
        dir = 1;
        delay = startDelay;
      } else {
        delay = dir === 1 ? typeSpeed : deleteSpeed;
      }
      timer = setTimeout(step, delay);
    };
    timer = setTimeout(step, startDelay);
    return () => clearTimeout(timer);
  }, [part1, part2, typeSpeed, deleteSpeed, holdTime, startDelay, total]);
  const text1 = part1.slice(0, Math.min(index, part1.length));
  const text2 = part2.slice(0, Math.max(0, index - part1.length));
  return { text1, text2, completedOnce };
}

function AnimatedCounter({ target, label }: { target: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const [count, setCount] = useState(0);
  const num = parseInt(target);
  useEffect(() => {
    if (!inView || isNaN(num)) return;
    let current = 0;
    const step = Math.ceil(num / 30);
    const timer = setInterval(() => {
      current += step;
      if (current >= num) { setCount(num); clearInterval(timer); }
      else setCount(current);
    }, 30);
    return () => clearInterval(timer);
  }, [inView, num]);
  return (
    <div ref={ref} className="text-center">
      <p className="text-3xl font-bold text-white sm:text-4xl">{isNaN(num) ? target : count}</p>
      <p className="mt-1 text-xs text-white/60">{label}</p>
    </div>
  );
}

export default function LandingPage() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const heroRef = useRef<HTMLElement>(null);
  const stepsRef = useRef<HTMLElement>(null);
  const stepsInView = useInView(stepsRef, 0.2);
  const heroInView = useInView(heroRef, 0.15);
  const typed = useTypewriterLoop(
    "Intelligent Scholarship Application, Ranking, ",
    "and Early-Warning Monitoring System for HEIs"
  );
  const typingDone = typed.completedOnce;

  const scrollTo = (id: string) => {
    setMobileOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-screen bg-[#0f0506] font-sans text-white antialiased selection:bg-[#7B1113]/50">
      {/* NAVBAR */}
      <header className="fixed top-0 z-50 w-full border-b border-white/5 bg-[#0f0506]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <img src="/logo.jpg" alt="St. Peter's College logo" className="h-8 w-8 flex-none rounded-lg bg-white object-contain shadow" />
            <span className="text-sm font-semibold">Scholarship System</span>
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {["How It Works", "Roles", "Core Functions", "Quality", "Technology Stack", "About", "Contact"].map((item) => (
              <button key={item} onClick={() => scrollTo(item.toLowerCase().replace(/ /g, "-"))} className="rounded-lg px-3 py-2 text-sm text-white/60 transition hover:bg-white/5 hover:text-white">
                {item}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className="hidden rounded-lg px-4 py-2 text-sm font-medium text-white/80 transition hover:text-white sm:block">Log in</Link>
            <Link href="/register" className="rounded-lg bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110">Register</Link>
            <button onClick={() => setMobileOpen(!mobileOpen)} className="flex h-9 w-9 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 md:hidden">
              {mobileOpen ? "✕" : "☰"}
            </button>
          </div>
        </div>
        {mobileOpen && (
          <div className="border-t border-white/5 bg-[#0f0506]/95 backdrop-blur-xl md:hidden">
            <div className="space-y-1 px-4 py-4">
              {["How It Works", "Roles", "Core Functions", "Quality", "Technology Stack", "About", "Contact"].map((item) => (
                <button key={item} onClick={() => scrollTo(item.toLowerCase().replace(/ /g, "-"))} className="block w-full rounded-lg px-4 py-3 text-left text-sm text-white/70 transition hover:bg-white/5 hover:text-white">
                  {item}
                </button>
              ))}
              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/5 pt-4">
                <Link href="/login" className="rounded-lg border border-white/15 px-4 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/5">Log in</Link>
                <Link href="/register" className="rounded-lg bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-3 text-center text-sm font-semibold text-white transition hover:brightness-110">Register</Link>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* HERO */}
      <section ref={heroRef} className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-[#7B1113] via-[#5A0C0E] to-[#3E0009] px-4 pt-16 text-white">
        {/* Animated background */}
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(255,255,255,0.12),transparent)]" />
          <div className="absolute left-1/4 top-1/4 h-96 w-96 animate-pulse rounded-full bg-white/[0.06] blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 h-96 w-96 animate-pulse rounded-full bg-black/20 blur-3xl" style={{ animationDelay: "1s" }} />
          <div className="absolute left-1/2 top-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full bg-white/[0.04] blur-3xl" style={{ animationDelay: "2s" }} />
        </div>

        {/* Grid pattern */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />

        <div className="relative z-10 mx-auto max-w-5xl text-center">
          <div className={`mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs text-white/70 backdrop-blur transition-all duration-700 ${heroInView ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            St. Peter&rsquo;s College, Iligan City
          </div>

          <h1 className="mt-2 max-w-4xl mx-auto text-2xl font-bold leading-snug tracking-tight sm:text-3xl md:text-4xl lg:text-5xl" style={{ opacity: heroInView ? 1 : 0, transform: heroInView ? "none" : "translateY(16px)", transition: "opacity 800ms ease 150ms, transform 800ms ease 150ms" }}>
            <span className="block bg-gradient-to-r from-white via-white to-white/80 bg-clip-text text-transparent">
              {typed.text1}
            </span>
            <span className="mt-1 block min-h-[1.3em] bg-gradient-to-r from-[#F5D0D1] to-white bg-clip-text text-transparent">
              {typed.text2}
              <span className={`ml-1 inline-block h-[0.8em] w-[0.5em] translate-y-[0.08em] rounded-[2px] bg-white ${typingDone ? "animate-pulse" : ""}`} />
            </span>
          </h1>

          <p className={`mx-auto mt-7 max-w-3xl text-base leading-relaxed text-white/75 transition-all duration-700 sm:text-lg ${typingDone ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}>
            Students can apply for scholarships through online. They register and verify through the simulated Registrar database to check if the student is enrolled in the school, using their student ID and Name. The system ranks applicants to prioritize who needs financial assistance the most, using machine learning based on their ITR or annual family income. CHED can then see the ranking results, and select, filter, and approve scholars for the scholarship.
          </p>

          <div className={`mt-8 flex flex-col items-center gap-3 transition-all delay-200 duration-700 sm:flex-row sm:justify-center ${typingDone ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}>
            <Link href="/register" className="group relative overflow-hidden rounded-xl bg-white px-8 py-3.5 text-sm font-semibold text-[#7B1113] transition hover:shadow-lg hover:shadow-black/20">
              Start Your Application
            </Link>
            <button onClick={() => scrollTo("how-it-works")} className="rounded-xl border border-white/25 px-8 py-3.5 text-sm font-medium text-white/80 transition hover:border-white/50 hover:text-white">
              See How It Works &darr;
            </button>
          </div>

          {/* Stats */}
          <div className={`mx-auto mt-16 grid max-w-2xl grid-cols-2 gap-6 transition-all delay-500 duration-700 sm:grid-cols-4 ${typingDone ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}>
            {STATS.map((s) => <AnimatedCounter key={s.label} target={s.value} label={s.label} />)}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS - Process Flow */}
      <section id="how-it-works" ref={stepsRef} className="relative py-24 sm:py-32">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Process Flow</p>
            <h2 className="mt-3 text-3xl font-bold sm:text-4xl">How the system works</h2>
            <p className="mx-auto mt-4 max-w-lg text-sm text-white/40">Every scholarship follows the same automated pipeline from application to monitoring.</p>
          </div>

          <div className="relative mt-16">
            {/* Vertical line */}
            <div className="absolute left-8 top-0 bottom-0 w-px bg-gradient-to-b from-[#7B1113] via-[#A52122] to-[#540111] sm:left-1/2" />

            <div className="space-y-12">
              {STEPS.map((step, i) => {
                const isLeft = i % 2 === 0;
                return (
                  <div key={step.num} className={`relative flex items-center gap-8 ${isLeft ? "sm:flex-row" : "sm:flex-row-reverse"}`}>
                    {/* Dot on timeline */}
                    <div className="absolute left-8 z-10 -translate-x-1/2 sm:left-1/2">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-full border-2 border-[#A52122] bg-[#0f0506] text-xs font-bold text-white transition-all duration-500 ${stepsInView ? "scale-100 opacity-100" : "scale-75 opacity-0"}`} style={{ transitionDelay: `${i * 150}ms` }}>
                        {step.num}
                      </div>
                    </div>

                    {/* Content card */}
                    <div className={`ml-20 sm:ml-0 sm:w-[calc(50%-2rem)] ${isLeft ? "sm:pr-12 sm:text-right" : "sm:pl-12"}`}>
                      <div className={`rounded-2xl border border-white/5 bg-white p-6 text-[#241012] shadow-[0_10px_30px_-15px_rgba(0,0,0,0.6)] transition-all duration-500 hover:border-[#A52122]/50 hover:shadow-[0_18px_40px_-15px_rgba(123,17,19,0.5)] ${stepsInView ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`} style={{ transitionDelay: `${i * 150}ms` }}>
                        <h3 className="text-lg font-bold">{step.title}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-[#6B5458]">{step.desc}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ROLES */}
      <section id="roles" className="bg-white py-24 sm:py-32">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#7B1113]">Four Roles</p>
            <h2 className="mt-3 text-3xl font-bold text-[#241012] sm:text-4xl">One unified system</h2>
            <p className="mx-auto mt-4 max-w-lg text-sm text-[#6B5458]">Each role has its own dashboard with process-mapped navigation.</p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((role) => (
              <Link key={role.label} href={role.href} className="group relative block overflow-hidden rounded-2xl border border-[#241012]/[0.06] bg-[#FAF7F5] p-6 shadow-[0_10px_30px_-15px_rgba(36,16,18,0.12)] transition-all duration-300 hover:-translate-y-1 hover:border-[#7B1113]/25 hover:shadow-[0_18px_40px_-15px_rgba(123,17,19,0.25)]">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${role.color} text-2xl shadow-lg`}>
                  {role.icon}
                </div>
                <h3 className="mt-4 text-lg font-bold text-[#241012]">{role.label}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#6B5458]">{role.desc}</p>
                <div className="mt-4 flex items-center gap-2 text-xs font-medium text-[#7B1113] opacity-0 transition group-hover:opacity-100">
                  Explore dashboard &rarr;
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* CORE FUNCTIONS */}
      <section id="core-functions" className="scroll-mt-[90px] py-24 sm:py-32">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">What powers the system</p>
            <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Core System Functions</h2>
            <p className="mx-auto mt-4 max-w-lg text-sm text-white/40">The five functions that run underneath every role in the scholarship system.</p>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-2">
            {CORE_FUNCTIONS.map((fn, i) => (
              <div key={fn.title} className="group flex gap-4 rounded-2xl border border-white/5 bg-white p-5 text-[#241012] shadow-[0_10px_30px_-15px_rgba(0,0,0,0.6)] transition-all duration-300 hover:-translate-y-1 hover:border-[#A52122]/50 sm:p-6">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#7B1113] text-xs font-bold text-white">
                  {String(i + 1).padStart(2, "0")}
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-semibold leading-6">{fn.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[#6B5458]">{fn.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* QUALITY */}
      <section id="quality" className="scroll-mt-[90px] border-y border-white/5 py-24 sm:py-32">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Evaluated against ISO/IEC 25010</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Quality &amp; Standards</h2>
          <p className="mx-auto mt-4 max-w-lg text-sm text-white/40">The system is designed around essential software quality characteristics for a reliable scholarship platform.</p>
          <div className="mx-auto mt-8 flex max-w-2xl flex-wrap items-center justify-center gap-2.5 sm:gap-3">
            {QUALITY.map((q) => (
              <span key={q} className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white transition-all hover:border-[#A52122] hover:bg-[#7B1113] hover:text-white">
                {q}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* STACK */}
      <section id="technology-stack" className="scroll-mt-[90px] py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Built with</p>
            <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Technology Stack</h2>
          </div>
          <div className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-3">
            {STACK.map((tech) => (
              <span key={tech} className="rounded-full border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-medium text-white/70 backdrop-blur transition-all hover:border-[#A52122]/60 hover:bg-white/10 hover:text-white">
                {tech}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ABOUT */}
      <section id="about" className="scroll-mt-[90px] border-y border-white/5 py-24 sm:py-32">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">About the System</p>
              <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Built for St. Peter&rsquo;s College, Iligan City</h2>
              <p className="mt-6 text-base leading-relaxed text-white/50">
                This system brings scholarship applications, financial-need ranking, CHED approval, and academic monitoring into one place &mdash; replacing manual, paper-based tracking with a single, auditable flow.
              </p>
              <p className="mt-4 text-base leading-relaxed text-white/50">
                Applicants are ranked using a Random Forest Classifier based solely on the annual family income declared in their submitted ITR, verified against registrar records, and monitored afterward so scholars at risk of falling below the 93% maintaining grade get flagged early enough for faculty to step in.
              </p>
            </div>
            <div className="flex flex-col justify-center space-y-4">
              {[
                { icon: "🤖", title: "Random Forest Classifier", desc: "ML-powered ranking based on ITR annual family income" },
                { icon: "📋", title: "Registrar Integration", desc: "Automatic eligibility validation" },
                { icon: "⚠️", title: "Early Warning System", desc: "At-risk scholar monitoring" },
                { icon: "📄", title: "Document Verification", desc: "Secure document management" },
              ].map((item) => (
                <div key={item.title} className="flex items-start gap-4 rounded-xl border border-white/5 bg-white p-4 text-[#241012] shadow-[0_10px_30px_-15px_rgba(0,0,0,0.6)] transition-all hover:border-[#A52122]/50">
                  <span className="mt-0.5 flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-[#7B1113]/10 text-xl">{item.icon}</span>
                  <div>
                    <h3 className="text-sm font-semibold">{item.title}</h3>
                    <p className="mt-1 text-xs text-[#6B5458]">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CONTACT */}
      <section id="contact" className="scroll-mt-[90px] py-24 sm:py-32">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Get in Touch</p>
            <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Contact Information</h2>
            <p className="mx-auto mt-4 max-w-lg text-sm text-white/40">For questions about applications, requirements, or your scholarship status, reach the Scholarship Office directly.</p>
          </div>
          <div className="mx-auto mt-12 grid max-w-4xl gap-4 sm:grid-cols-3">
            {[
              { label: "Office", value: "Scholarship & Financial Aid Office", icon: "🏛️" },
              { label: "Email", value: "scholarship@spc.edu.ph", icon: "✉️" },
              { label: "Phone", value: "(063) 000-0000", icon: "📞" },
            ].map((c) => (
              <div key={c.label} className="rounded-2xl border border-white/5 bg-white p-6 text-center text-[#241012] shadow-[0_10px_30px_-15px_rgba(0,0,0,0.6)] transition-all hover:border-[#A52122]/50 hover:shadow-[0_18px_40px_-15px_rgba(123,17,19,0.5)]">
                <span className="text-3xl">{c.icon}</span>
                <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-[#7B1113]">{c.label}</p>
                <p className="mt-2 text-sm">{c.value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 sm:py-32">
        <div className="mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
          <div className="rounded-3xl bg-gradient-to-br from-[#7B1113] via-[#5A0C0E] to-[#3E0009] p-12 text-white shadow-[0_25px_60px_-20px_rgba(123,17,19,0.5)] sm:p-16">
            <h2 className="text-3xl font-bold sm:text-4xl">Ready to apply?</h2>
            <p className="mx-auto mt-4 max-w-md text-sm text-white/70">Create your account and start your scholarship application today.</p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <Link href="/register" className="rounded-xl bg-white px-8 py-3.5 text-sm font-semibold text-[#7B1113] transition hover:bg-white/90">
                Create Account
              </Link>
              <Link href="/login" className="rounded-xl border border-white/25 px-8 py-3.5 text-sm font-medium text-white/80 transition hover:border-white/50 hover:text-white">
                Log In
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-white/5 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-center text-xs text-white/30 sm:flex-row sm:px-6 lg:px-8">
          <span>&copy; {new Date().getFullYear()} St. Peter&rsquo;s College, Iligan City</span>
          <span>Intelligent Scholarship Application, Ranking &amp; Early-Warning Monitoring System for HEIs</span>
          <Link href="/terms" className="text-white/40 underline underline-offset-2 transition hover:text-white/70">
            Terms &amp; Conditions
          </Link>
        </div>
      </footer>
    </div>
  );
}