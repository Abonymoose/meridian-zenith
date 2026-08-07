/* ═══════════════════════════════════════════════════════════
   MERIDIAN — main.js
   AI-powered study planner for Cambridge middle school
═══════════════════════════════════════════════════════════ */

const S = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k,v) => localStorage.setItem(k, JSON.stringify(v)),
  del: k => localStorage.removeItem(k),
};

let USER = null;
let currentTask = null;
let chatHistory = [];

/* ── Notices ───────────────────────────────────────────── */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function notify(msg, kind = 'warn', ms = 9000) {
  let stack = document.getElementById('mz-notices');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'mz-notices';
    document.body.appendChild(stack);
  }
  const n = document.createElement('div');
  n.className = `mz-notice ${kind}`;
  n.innerHTML = `<span>${esc(msg)}</span><button aria-label="Dismiss">×</button>`;
  const kill = () => { n.classList.add('out'); setTimeout(() => n.remove(), 250); };
  n.querySelector('button').addEventListener('click', kill);
  stack.appendChild(n);
  if (ms) setTimeout(kill, ms);
}

/* ── Groq ──────────────────────────────────────────────── */
/* Model IDs get retired. Check https://console.groq.com/docs/deprecations
   before assuming a failure is your own fault.
     llama-3.1-8b-instant                        shut down 16 Aug 2026
     meta-llama/llama-4-scout-17b-16e-instruct   shut down 17 Jul 2026 */
const MODEL = 'openai/gpt-oss-20b';        // text
const VISION_MODEL = 'qwen/qwen3.6-27b';   // images — gpt-oss is text-only

class ApiError extends Error {}

function apiReason(status, body) {
  const detail = body?.error?.message || '';
  if (status === 401 || status === 403) return 'Groq rejected the API key. Check it in settings.';
  if (status === 429) return 'Rate limit reached. Wait a minute, then try again.';
  if (status === 413) return 'That file is too large for the model to read.';
  if (/decommissioned|deprecat|does not exist|not found/i.test(detail) || status === 404) {
    return 'This model is no longer available on Groq — the app needs its model IDs updated.';
  }
  if (status >= 500) return 'Groq is having problems right now. Try again shortly.';
  return detail || `Groq returned an error (${status}).`;
}

async function groqRaw(body, timeoutMs = 28000) {
  if (!USER?.apiKey) throw new ApiError('No API key set. Add one in settings.');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${USER.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError('Request timed out. Try again.');
    throw new ApiError('Could not reach Groq. Check your connection.');
  } finally {
    clearTimeout(t);
  }

  if (!r.ok) {
    const body = await r.json().catch(() => null);
    console.error('Groq', r.status, body);
    throw new ApiError(apiReason(r.status, body));
  }

  const text = (await r.json()).choices?.[0]?.message?.content;
  if (!text) throw new ApiError('Groq returned an empty response.');
  return text;
}

async function groq(messages, max = 600) {
  return groqRaw({ model: MODEL, messages, max_tokens: max, temperature: 0.75 });
}

async function toB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function extractDoc(file, type) {
  if (!file) return '';
  if (!file.type.startsWith('image/')) {
    throw new ApiError(`${file.name} was skipped — only images can be read. Screenshot the PDF and upload that instead.`);
  }

  const b64 = await toB64(file);
  const prompt = type === 'existing'
    ? 'Extract the complete study schedule from this image. List every day, subject, task, and time mentioned. Be thorough and structured.'
    : type === 'report'
    ? 'Extract all academic data from this report card. List every subject with its score, grade, and any teacher feedback or comments.'
    : 'Extract all academic content from this syllabus/course planner. List every subject with units, topics, subtopics, and dates/months.';

  const text = await groqRaw({
    model: VISION_MODEL,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${file.type};base64,${b64}` } }
    ]}],
    max_tokens: 1200
  });

  if (text.trim().length < 20) {
    throw new ApiError(`Nothing readable was found in ${file.name}. Try a clearer photo.`);
  }
  return text;
}

/* ── Plan validation ───────────────────────────────────── */
/* The model returns free-form JSON. Parsing succeeding does not mean the
   shape is usable — a missing `subjects` array used to throw inside
   launchApp and leave the app permanently unbootable. Everything the
   renderers touch is checked and coerced here, once, before it is saved. */

const PASTELS = ['#FDE8D8','#E0F0FF','#DCF4E8','#E8E0F8','#FDE8EE','#E0F4EC','#F0E8D4','#E8F4DC','#E0EEF8','#FEF8EC'];
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

class PlanError extends Error {}

const asText = v => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
const asInt = (v, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };

/** Coerce anything into a renderable plan, or throw if it's unsalvageable. */
function validatePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanError('The plan came back in the wrong format.');
  }

  const plan = { summary: asText(raw.summary), days: {} };

  // days may arrive as an object keyed by day number, or as an array.
  let entries = [];
  if (Array.isArray(raw.days)) {
    entries = raw.days.map((d, i) => [String(i), d]);
  } else if (raw.days && typeof raw.days === 'object') {
    entries = Object.entries(raw.days);
  }

  for (const [key, day] of entries) {
    const dow = asInt(key, null);
    if (dow === null || dow < 0 || dow > 6) continue;
    if (!day || typeof day !== 'object') continue;

    const subjects = (Array.isArray(day.subjects) ? day.subjects : [])
      .filter(s => s && typeof s === 'object')
      .map((s, si) => ({
        name: asText(s.name) || 'Study',
        color: /^#[0-9a-f]{3,8}$/i.test(asText(s.color)) ? s.color : PASTELS[si % PASTELS.length],
        duration: asText(s.duration),
        tasks: (Array.isArray(s.tasks) ? s.tasks : [])
          .map(t => (typeof t === 'string' ? { text: t } : t))
          .filter(t => t && typeof t === 'object' && asText(t.text))
          .map(t => ({
            text: asText(t.text),
            mins: asInt(t.mins, 0) > 0 ? asInt(t.mins, 0) : null,
            detail: asText(t.detail),
            generateContent: t.generateContent === true,
          })),
      }))
      .filter(s => s.tasks.length);

    if (!subjects.length) continue;
    plan.days[dow] = { name: asText(day.name) || DAY_NAMES[dow], subjects };
  }

  if (!Object.keys(plan.days).length) {
    throw new PlanError('The plan came back with no usable study days in it.');
  }

  plan.grades = (Array.isArray(raw.grades) ? raw.grades : [])
    .filter(g => g && typeof g === 'object' && asText(g.name))
    .map(g => ({ name: asText(g.name), score: asInt(g.score, null), grade: asText(g.grade) }))
    .filter(g => g.score !== null);

  plan.roadmap = (Array.isArray(raw.roadmap) ? raw.roadmap : Array.isArray(raw.csRoadmap) ? raw.csRoadmap : [])
    .filter(m => m && typeof m === 'object')
    .map(m => ({
      month: asText(m.month),
      theme: asText(m.theme),
      weeks: (Array.isArray(m.weeks) ? m.weeks : [])
        .filter(w => w && typeof w === 'object')
        .map(w => ({ range: asText(w.range), title: asText(w.title), description: asText(w.description) })),
      resources: (Array.isArray(m.resources) ? m.resources : []).map(asText).filter(Boolean),
    }));
  plan.roadmapSubject = asText(raw.roadmapSubject);

  plan.projects = (Array.isArray(raw.projects) ? raw.projects : [])
    .filter(p => p && typeof p === 'object' && asText(p.title))
    .map(p => ({
      month: asText(p.month),
      title: asText(p.title),
      subjects: (Array.isArray(p.subjects) ? p.subjects : []).map(asText).filter(Boolean),
      description: asText(p.description),
      steps: (Array.isArray(p.steps) ? p.steps : []).map(asText).filter(Boolean),
      deliverable: asText(p.deliverable),
    }));

  return plan;
}

/** Cheap check for a plan already sitting in storage. */
function planIsUsable(plan) {
  try { validatePlan(plan); return true; } catch { return false; }
}

/* ── Plan generation ───────────────────────────────────── */
async function generatePlan(prefs, reportText, syllabusText, existingPlanText) {
  const { name, grade, hours, days, focus, style, coaching, roadmapSubject } = prefs;
  const DAY_MAP = { Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6, Sunday:0 };
  const dayNums = days.map(d => DAY_MAP[d]).filter(n => n !== undefined);

  let context = '';
  if (existingPlanText) context = `EXISTING STUDY SCHEDULE (build the app tasks around this):\n${existingPlanText}\n\n`;
  if (reportText) context += `REPORT CARD DATA:\n${reportText}\n\n`;
  if (syllabusText) context += `SYLLABUS:\n${syllabusText}\n\n`;

  const prompt = `You are an expert Cambridge educational coach. Build a fully personalised self-study plan.

STUDENT: ${name}, ${grade || 'Grade 8'}, Cambridge curriculum
DAILY STUDY TIME: ${hours || '1 hour'} total per day — all tasks per day MUST fit within this
STUDY DAYS: ONLY these days: ${days.join(', ')} (day numbers: ${dayNums.join(',')})
${focus?.length ? `PRIORITY SUBJECTS (give these more tasks/time): ${focus.join(', ')}` : 'Balance across all subjects the student studies'}
${style ? `LEARNING STYLE: ${style}` : ''}
${coaching ? `SKIP these (already coached): ${coaching}` : ''}

${context || `No documents uploaded. Use standard Cambridge ${grade||'Grade 8'} curriculum subjects and topics.`}

CRITICAL RULES — follow exactly:
1. SUBJECTS: Extract subject names ONLY from the documents above. Do NOT use generic/assumed subjects. If no documents, use standard Cambridge ${grade||'Grade 8'} subjects appropriate for this grade.
2. TOPICS: Every single task must reference a REAL topic from the syllabus or existing schedule. No generic tasks like "study subject X" — be specific to actual content.
3. DAYS: ONLY generate day numbers ${dayNums.join(',')} — no others.
4. TIME: Total task mins per day must fit within ${hours||'1 hour'}. Task mins must be integers (5,10,15,20,25,30).
5. PROJECTS: Generate 4 unique projects tailored to THIS student's actual subjects — not generic projects. Each project should combine 2-3 of their real subjects in a creative way.
6. ROADMAP: ${roadmapSubject
  ? `Generate a 4-month, 16-week self-study deep-dive roadmap for ONE subject: ${roadmapSubject}. Pitch it for ${grade||'Grade 8'} but go well beyond school level. Build it fresh for this student — do not reuse a stock curriculum. Set "roadmapSubject" to "${roadmapSubject}".`
  : `The student wants NO roadmap. Return "roadmap": [] and "roadmapSubject": "".`}
7. No coaching overlap. generateContent:true only for reading/problem/exercise tasks.
8. Every task needs a "detail" field with specific, actionable advice.
8b. "grades": copy every subject and mark from the report card. "score" must be a number 0-100. Omit the field entirely if no report card was provided — never invent marks.
9. Colors: soft pastels — #FDE8D8, #E0F0FF, #DCF4E8, #E8E0F8, #FDE8EE, #E0F4EC, #F0E8D4, #E8F4DC, #E0EEF8, #FEF8EC

Respond ONLY with valid JSON:
{
  "summary": "2-3 sentences: student's strengths, weaknesses, key focus — based on their actual uploaded data",
  "grades": [{ "name": "Subject name exactly as written on the report card", "score": 76, "grade": "B+" }],
  "days": {
    "${dayNums[0]||1}": { "name": "${days[0]||'Monday'}", "subjects": [{ "name": "Real Subject Name from docs", "color": "#FDE8D8", "duration": "X min", "tasks": [{ "text": "specific task with real topic", "mins": 15, "detail": "actionable how-to", "generateContent": false }] }] }
  },
  "roadmapSubject": "${roadmapSubject || ''}",
  "roadmap": [{ "month": "Month name", "theme": "theme", "weeks": [{ "range": "Wk 1-2", "title": "topic", "description": "what to learn and do" }], "resources": ["resource"] }],
  "projects": [{ "month": "Month name", "title": "project title", "subjects": ["Real Subject 1","Real Subject 2"], "description": "what it involves and why it matters", "steps": ["concrete step 1","concrete step 2","concrete step 3","concrete step 4"], "deliverable": "specific thing they produce" }]
}

Generate ALL ${days.length} day(s): ${days.map((d,i)=>`${dayNums[i]}=${d}`).join(', ')}
${roadmapSubject ? `4 months in roadmap, all about ${roadmapSubject}.` : 'roadmap must be [].'} 4 projects using this student's REAL subjects.`;

  const reply = await groq([
    { role: 'system', content: 'Expert educational planner. Return valid JSON only. No markdown. No explanation.' },
    { role: 'user', content: prompt }
  ], 2800);

  let parsed;
  try {
    const clean = reply.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(clean);
  } catch(e) {
    console.error('Plan parse fail', e, reply?.slice(0,300));
    throw new ApiError('The model returned a plan that could not be read. Try generating again.');
  }
  // Never hand back an unvalidated plan — a missing array here becomes an
  // unbootable app once it is saved.
  return validatePlan(parsed);
}

/* defaultPlan removed. A generic hardcoded plan pretended the app had
   worked when it hadn't. Generation failure now offers retry or import
   instead of silently handing over someone else's curriculum. */

/* ── Plan import ───────────────────────────────────────── */
/* Accepts either a backup export or a photo/PDF of a schedule. The file
   type decides which path runs; both end in a validated plan. */

function looksLikeBackup(file) {
  return file.type === 'application/json' || /\.json$/i.test(file.name);
}

async function importPlanFromBackup(file) {
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { throw new Error('That JSON file could not be read.'); }

  // A full app backup…
  if (parsed && typeof parsed.data === 'object' && parsed.data?.mz) {
    const profile = JSON.parse(parsed.data.mz);
    if (!profile?.plan) throw new Error('That backup has no plan in it.');
    return { plan: validatePlan(profile.plan), profile, whole: parsed };
  }
  // …or a bare plan object.
  if (parsed && (parsed.days || parsed.plan)) {
    return { plan: validatePlan(parsed.plan || parsed), profile: null, whole: null };
  }
  throw new Error('That file is not a Meridian backup or plan.');
}

async function importPlanFromDocument(file, prefs) {
  const text = await extractDoc(file, 'existing');
  const plan = await generatePlan(
    { ...prefs, name: prefs.name || USER?.name || 'there' },
    '', '', text
  );
  return { plan, profile: null, whole: null };
}

/** Import from any supported file and persist. Returns the plan. */
async function importAnyPlan(file, prefs) {
  if (looksLikeBackup(file)) {
    const { plan, whole } = await importPlanFromBackup(file);
    if (whole) {
      // Full backup: restore everything, not just the plan.
      Object.keys(whole.data).filter(k => k.startsWith('mz')).forEach(k => localStorage.setItem(k, whole.data[k]));
      return plan;
    }
    USER = USER || {};
    USER.plan = plan;
    S.set('mz', USER);
    return plan;
  }
  const { plan } = await importPlanFromDocument(file, prefs || {
    name: USER?.name, grade: USER?.grade, hours: USER?.hours, days: USER?.days || [],
    focus: USER?.focus || [], style: USER?.style, coaching: USER?.coaching,
    roadmapSubject: USER?.roadmapSubject,
  });
  USER = USER || {};
  USER.plan = plan;
  S.set('mz', USER);
  return plan;
}

/* ── Onboarding ────────────────────────────────────────── */
let obData = { grade:'Grade 8', hours:'1 hour', days:[], focus:[], style:'', coaching:'', roadmapSubject:'' };
let obReportFile = null, obSyllabusFile = null, obExistingFile = null;
let obHasExisting = false;
let obCurrentStep = 1;
const OB_TOTAL = 12;

function obProgress(step) {
  document.getElementById('ob-progress-fill').style.width = `${((step-1)/(OB_TOTAL-1))*100}%`;
}

/* Every forward move is recorded, so back always retraces the real route
   rather than a hardcoded step order that forks (3a vs 3b) can break. */
let obHistory = [];

function obBack() {
  const prev = obHistory.pop();
  if (!prev) return;
  const el = document.getElementById(prev);
  if (!el) return;
  document.querySelectorAll('.ob-step').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  obCurrentStep = parseInt(prev.replace('ob-s', '')) || obCurrentStep;
  obProgress(obCurrentStep);
  renderObBack();
}

function renderObBack() {
  const btn = document.getElementById('ob-back');
  if (btn) btn.style.display = obHistory.length ? 'flex' : 'none';
}

function obGo(id) {
  const el = document.getElementById(id);
  if (!el) {
    // Never blank the screen over a bad id — that strands the user with
    // no visible step and no way forward.
    console.error(`obGo: no such step "${id}" — staying put`);
    notify('Something went wrong moving to the next step. Please report this.', 'warn');
    return;
  }
  const current = document.querySelector('.ob-step.active');
  if (current && current.id !== id) obHistory.push(current.id);
  document.querySelectorAll('.ob-step').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  obCurrentStep = parseInt(id.replace('ob-s', '')) || obCurrentStep;
  obProgress(obCurrentStep);
  renderObBack();
}

function obChipSingle(wrapperId, onPick) {
  document.querySelectorAll(`#${wrapperId} .ob-chip`).forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll(`#${wrapperId} .ob-chip`).forEach(x => x.classList.remove('sel'));
      c.classList.add('sel');
      if (onPick) onPick(c.dataset.val);
    });
  });
}

function obChipMulti(wrapperId) {
  document.querySelectorAll(`#${wrapperId} .ob-chip`).forEach(c => {
    c.addEventListener('click', () => c.classList.toggle('sel'));
  });
}

function obSelectedSingle(wrapperId) {
  return document.querySelector(`#${wrapperId} .ob-chip.sel`)?.dataset.val || null;
}

function obSelectedMulti(wrapperId) {
  return [...document.querySelectorAll(`#${wrapperId} .ob-chip.sel`)].map(c => c.dataset.val);
}

function initOnboarding() {
  document.getElementById('ob-back').addEventListener('click', obBack);
  renderObBack();

  // Step 1: name
  const nameIn = document.getElementById('ob-name');
  document.getElementById('ob-n1').addEventListener('click', () => {
    const v = nameIn.value.trim();
    if (!v) { nameIn.focus(); return; }
    obGo('ob-s2');
  });
  nameIn.addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('ob-n1').click(); });

  // Step 2: fork
  document.getElementById('ob-fork-yes').addEventListener('click', () => {
    obHasExisting = true;
    obCurrentStep = 3;
    obGo('ob-s3a');
  });
  document.getElementById('ob-fork-no').addEventListener('click', () => {
    obHasExisting = false;
    obCurrentStep = 3;
    obGo('ob-s3b');
  });

  // Step 3a: upload existing
  document.getElementById('ob-existing-file').addEventListener('change', e => {
    obExistingFile = e.target.files[0];
    if (obExistingFile) document.getElementById('ob-existing-name').textContent = obExistingFile.name;
  });
  document.getElementById('ob-n3a').addEventListener('click', () => {
    obCurrentStep = 11; obGo('ob-s11r');
  });

  // Step 3b: grade
  obChipSingle('ob-grade-chips', v => obData.grade = v);
  document.getElementById('ob-n3b').addEventListener('click', () => {
    obData.grade = obSelectedSingle('ob-grade-chips') || 'Grade 8';
    obCurrentStep = 4; obGo('ob-s4');
  });

  // Step 4: hours
  obChipSingle('ob-hours-chips');
  document.getElementById('ob-n4').addEventListener('click', () => {
    const custom = document.getElementById('ob-hours-custom').value.trim();
    obData.hours = custom || obSelectedSingle('ob-hours-chips') || '1 hour';
    obCurrentStep = 5; obGo('ob-s5');
  });

  // Step 5: days
  obChipMulti('ob-days-chips');
  document.getElementById('ob-n5').addEventListener('click', () => {
    const sel = obSelectedMulti('ob-days-chips');
    obData.days = sel.length ? sel : ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    obCurrentStep = 6; obGo('ob-s6');
  });

  // Step 6: focus
  obChipMulti('ob-focus-chips');
  document.getElementById('ob-n6').addEventListener('click', () => {
    obData.focus = obSelectedMulti('ob-focus-chips');
    obCurrentStep = 7; obGo('ob-s7');
  });
  document.getElementById('ob-skip6').addEventListener('click', () => { obCurrentStep = 7; obGo('ob-s7'); });

  // Step 7: style
  obChipSingle('ob-style-chips');
  document.getElementById('ob-n7').addEventListener('click', () => {
    obData.style = obSelectedSingle('ob-style-chips') || 'mixed';
    obCurrentStep = 8; obGo('ob-s8');
  });

  // Step 8: roadmap opt-in — one subject only
  obChipSingle('ob-roadmap-chips');
  document.getElementById('ob-n8').addEventListener('click', () => {
    const custom = document.getElementById('ob-roadmap-custom').value.trim();
    obData.roadmapSubject = custom || obSelectedSingle('ob-roadmap-chips') || '';
    obCurrentStep = 9; obGo('ob-s9c');
  });
  document.getElementById('ob-skip8r').addEventListener('click', () => {
    obData.roadmapSubject = '';
    obCurrentStep = 9; obGo('ob-s9c');
  });

  // Step 9a: coaching
  document.getElementById('ob-n9c').addEventListener('click', () => {
    obData.coaching = document.getElementById('ob-coaching').value.trim();
    obGo('ob-s9r');
  });
  document.getElementById('ob-skip9c').addEventListener('click', () => {
    obData.coaching = '';
    obGo('ob-s9r');
  });

  // Step 9b: report card
  document.getElementById('ob-n9r').addEventListener('click', () => { obGo('ob-s10r'); });
  document.getElementById('ob-skip9r').addEventListener('click', () => {
    obReportFile = null;
    document.getElementById('ob-report-name').textContent = '';
    obGo('ob-s10r');
  });

  // Report card file handler
  document.getElementById('ob-report-file').addEventListener('change', e => {
    obReportFile = e.target.files[0];
    if (obReportFile) document.getElementById('ob-report-name').textContent = obReportFile.name;
  });

  // Step 10: syllabus
  document.getElementById('ob-syllabus-file').addEventListener('change', e => {
    obSyllabusFile = e.target.files[0];
    if (obSyllabusFile) document.getElementById('ob-syllabus-name').textContent = obSyllabusFile.name;
  });
  document.getElementById('ob-n10r').addEventListener('click', () => { obCurrentStep = 11; obGo('ob-s11r'); });
  document.getElementById('ob-skip10r').addEventListener('click', () => { obSyllabusFile = null; obCurrentStep = 11; obGo('ob-s11r'); });

  // Step 11: API key
  document.getElementById('ob-n11r').addEventListener('click', () => kickoffGeneration());
  document.getElementById('ob-skip11r').addEventListener('click', () => kickoffGeneration(true));
}

function genStep(steps, idx) {
  const el = document.getElementById('ob-gen-list');
  if (!el) return;
  el.innerHTML = steps.map((s,i) => {
    const cls = i < idx ? 'done' : i === idx ? 'active' : '';
    return `<div class="ob-gen-row ${cls}"><div class="ob-gen-dot"></div>${s}</div>`;
  }).join('');
}

async function kickoffGeneration(skipAI = false) {
  const name = document.getElementById('ob-name').value.trim() || 'Student';
  const apiKey = document.getElementById('ob-apikey').value.trim();

  USER = {
    name, apiKey: skipAI ? '' : apiKey,
    theme: 'light',
    grade: obData.grade,
    hours: obData.hours,
    days: obData.days.length ? obData.days : ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
    focus: obData.focus,
    style: obData.style,
    coaching: obData.coaching,
    roadmapSubject: obData.roadmapSubject || '',
  };

  applyTheme('light');
  obCurrentStep = 12;
  obHistory = [];
  const backBtn = document.getElementById('ob-back');
  if (backBtn) backBtn.style.display = 'none';
  obGo('ob-s12r');

  const STEPS = ['reading documents','analysing your data','generating your plan','building your roadmap','finishing up'];
  genStep(STEPS, 0);

  let existingText = '', reportText = '', syllabusText = '';
  const problems = [];

  async function read(file, type, label) {
    if (!file) return '';
    try {
      return await extractDoc(file, type);
    } catch (e) {
      problems.push(`${label}: ${e.message}`);
      return '';
    }
  }

  if (!skipAI && apiKey) {
    if (obHasExisting && obExistingFile) {
      genStep(STEPS, 0);
      existingText = await read(obExistingFile, 'existing', 'Existing plan');
    }
    if (obReportFile) {
      genStep(STEPS, 0);
      reportText = await read(obReportFile, 'report', 'Report card');
    }
    if (obSyllabusFile) {
      genStep(STEPS, 1);
      syllabusText = await read(obSyllabusFile, 'syllabus', 'Syllabus');
    }
    genStep(STEPS, 2);
    document.getElementById('ob-gen-h').textContent = `building ${name}'s plan…`;
  }

  let plan = null;
  if (!skipAI && apiKey) {
    try {
      plan = await generatePlan(
        { name, grade: USER.grade, hours: USER.hours, days: USER.days, focus: USER.focus, style: USER.style, coaching: USER.coaching },
        reportText, syllabusText, existingText
      );
    } catch(e) {
      console.error(e);
      problems.push(`Plan: ${e.message}`);
    }
    genStep(STEPS, 4);
  }

  if (!plan) {
    // No fallback plan. Handing over a generic curriculum here would look
    // like success while being nobody's actual schedule.
    showGenFailure(problems, skipAI || !apiKey);
    return;
  }

  USER.plan = plan;
  USER.reportText = reportText;
  USER.syllabusText = syllabusText;
  S.set('mz', USER);

  document.getElementById('ob-gen-h').textContent = 'all done!';
  document.getElementById('ob-gen-sub').textContent = '';
  genStep(STEPS, 5);
  await new Promise(r => setTimeout(r, 600));
  launchApp();

  problems.forEach(p => notify(p, 'warn', 0));
}

/* Generation failed. Offer the two real ways forward. */
function showGenFailure(problems, noKey) {
  const h = document.getElementById('ob-gen-h');
  const sub = document.getElementById('ob-gen-sub');
  const wrap = document.querySelector('#ob-s12r .ob-generating');
  h.textContent = noKey ? 'a plan needs an API key' : "couldn't build your plan";
  sub.textContent = problems.length ? problems[0] : 'The model did not return a usable plan.';

  const spinner = document.querySelector('#ob-s12r .ob-spinner');
  if (spinner) spinner.style.display = 'none';

  const box = document.createElement('div');
  box.className = 'gen-fail';
  box.innerHTML = `
    <div class="rec-actions">
      <button class="ob-btn-primary" id="gen-retry">try again</button>
      <button class="ob-btn-ghost" id="gen-import">import a plan file instead</button>
    </div>
    <p class="settings-hint">Import accepts a Meridian backup (.json) or a photo of a schedule.</p>
    <input type="file" id="gen-file" accept="application/json,.json,image/*" style="display:none"/>`;
  wrap?.appendChild(box);

  document.getElementById('gen-retry').addEventListener('click', () => {
    box.remove();
    if (spinner) spinner.style.display = '';
    kickoffGeneration();
  });
  document.getElementById('gen-import').addEventListener('click', () => document.getElementById('gen-file').click());
  document.getElementById('gen-file').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    h.textContent = 'reading your plan…';
    try {
      await importAnyPlan(f, {
        name: USER.name, grade: USER.grade, hours: USER.hours, days: USER.days,
        focus: USER.focus, style: USER.style, coaching: USER.coaching, roadmapSubject: USER.roadmapSubject,
      });
      box.remove();
      launchApp();
    } catch (err) {
      h.textContent = "couldn't build your plan";
      sub.textContent = err.message;
    }
  });
}

/* ── App ───────────────────────────────────────────────── */
function launchApp() {
  document.getElementById('onboarding').style.display = 'none';
  document.getElementById('app').style.display = 'grid';
  applyTheme(USER.theme || 'light');
  document.getElementById('sidebar-greeting').textContent = `hey, ${USER.name.toLowerCase()}`;
  // Each step is isolated. Settings must survive whatever else fails —
  // it is the only route to regenerate, import or reset.
  const step = (label, fn) => {
    try { fn(); }
    catch (e) { console.error(`launchApp: ${label} failed`, e); failed.push(label); }
  };
  const failed = [];

  step('settings', initSettings);
  step('tabs', initTabs);
  step('session', initSession);
  step('plan', initPlan);
  step('overview', initOverview);
  step('review', () => { initReview(); initReviewControls(); });
  step('log', renderSessionLog);

  const hasRoadmap = (USER.plan?.roadmap?.length || 0) > 0;
  const subject = USER.plan?.roadmapSubject || 'roadmap';
  const csNav = document.querySelector('[data-tab="cs"]');
  const csMob = document.querySelector('.mob-nav[data-tab="cs"]');
  if (!hasRoadmap) {
    if(csNav)csNav.style.display='none';
    if(csMob)csMob.style.display='none';
  } else {
    if(csNav){ csNav.style.display=''; const lbl=csNav.querySelector('span'); if(lbl)lbl.textContent=subject.toLowerCase(); }
    if(csMob){ csMob.style.display=''; csMob.textContent=subject.toLowerCase(); }
    step('roadmap', initCS);
  }

  step('projects', initProjects);
  step('streak', renderStreak);
  step('countdown', initCountdown);

  if (failed.length) {
    notify(`Some parts of the app could not load (${failed.join(', ')}). Open settings to regenerate or restore a backup.`, 'warn', 0);
  } else if (!S.get('mz-tour-done')) {
    setTimeout(startTour, 600);
  }
}

function applyTheme(t) {
  document.body.setAttribute('data-theme', t);
  if (USER) { USER.theme = t; S.set('mz', USER); }
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
}

/* ── Tabs ──────────────────────────────────────────────── */
function initTabs() {
  function activate(tab) {
    document.querySelectorAll('.nav-item,.mob-nav').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
    // Rebuild on entry: task counts and the streak move while you're elsewhere.
    if (tab === 'overview') initOverview();
    if (tab === 'review') initReview();
  }
  document.querySelectorAll('.nav-item,.mob-nav').forEach(b => {
    b.addEventListener('click', () => activate(b.dataset.tab));
  });
}

/* ── Session ───────────────────────────────────────────── */
function initSession() {
  const now = new Date();
  let dow = now.getDay();
  if (dow === 0) dow = 1;
  const day = USER.plan.days[dow] || USER.plan.days[Object.keys(USER.plan.days)[0]];

  document.getElementById('today-day').textContent = day.name.toLowerCase();
  document.getElementById('today-date-str').textContent = now.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });

  const sl = document.getElementById('today-subjects-list');
  sl.innerHTML = day.subjects.map(s => `
    <div class="today-subject-row">
      <span class="subj-chip" style="background:${s.color};color:#333">${s.name}</span>
      <span style="font-size:0.68rem;color:var(--tx-3);font-family:'JetBrains Mono',monospace">${s.duration}</span>
    </div>`).join('');

  document.getElementById('go-today-btn').addEventListener('click', () => {
    document.querySelector('[data-tab="plan"]')?.click();
    setTimeout(() => document.querySelector(`.day-tab[data-day="${dow}"]`)?.click(), 100);
  });

  initTimer();
  initChecklist(dow, day);
  initDetail();
  initMusic();
}

/* ── Countdown ─────────────────────────────────────────── */
/* ── Term ──────────────────────────────────────────────── */
/* One source of truth — the countdown panel and the overview card
   both read from here. */
const TERM = { name: 'term 1', start: new Date('2026-06-01'), end: new Date('2026-09-26') };

function termProgress() {
  const now = new Date();
  const total = TERM.end - TERM.start;
  const left = Math.max(0, TERM.end - now);
  const elapsed = Math.max(0, now - TERM.start);
  const fmtDate = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
  return {
    days: Math.ceil(left / 86400000),
    weeks: (left / (7 * 86400000)).toFixed(1),
    pct: Math.min(100, Math.round((elapsed / total) * 100)),
    label: now < TERM.start ? `starts ${fmtDate(TERM.start)}`
         : now > TERM.end   ? `${TERM.name} ended`
         : `ends ${fmtDate(TERM.end)}`,
  };
}

function initCountdown() {
  const t = termProgress();
  document.getElementById('cd-days').textContent = t.days;
  document.getElementById('cd-weeks').textContent = t.weeks;
  document.getElementById('cd-pct').textContent = t.pct;
  document.getElementById('cd-bar').style.width = t.pct + '%';
  document.getElementById('cd-meta').textContent = t.label;
}

/* ── Streak ────────────────────────────────────────────── */
function getStreak() { return S.get('mz-streak') || { days:[], current:0, best:0 }; }
function markDay() {
  const st = getStreak(), today = new Date().toDateString();
  if (st.days.includes(today)) return;
  st.days.push(today);
  let c = 0; const d = new Date();
  while (st.days.includes(d.toDateString())) { c++; d.setDate(d.getDate()-1); }
  st.current = c; st.best = Math.max(st.best||0, c);
  S.set('mz-streak', st); renderStreak();
}
function renderStreak() {
  const el = document.getElementById('streak-widget'); if (!el) return;
  const st = getStreak(), lit = st.days.includes(new Date().toDateString());
  el.innerHTML = `<span class="flame ${lit?'lit':''}">🔥</span><span class="streak-n">${st.current}</span><span>streak</span>`;
}

/* ── Timer ─────────────────────────────────────────────── */
let tInterval=null, tTotal=15*60, tLeft=15*60, tRunning=false;
const CIRC = 2*Math.PI*52; // r=52, circ=327

function fmt(s) { return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }

function ringUpdate() {
  const p = document.getElementById('ring-prog'); if(!p) return;
  p.style.strokeDashoffset = CIRC*(1-tLeft/tTotal);
  p.classList.toggle('done', tLeft===0);
}

function setTimer(m, lbl) {
  clearInterval(tInterval); tRunning = false;
  tTotal = tLeft = m*60;
  document.getElementById('ring-time').textContent = fmt(tLeft);
  document.getElementById('timer-start').textContent = 'start';
  ringUpdate();
  document.querySelectorAll('.preset').forEach(b => b.classList.toggle('active', parseInt(b.dataset.m)===m));
  const ci = document.getElementById('custom-min');
  if (![15,25,30,60].includes(m)) {
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-m="0"]').classList.add('active');
    ci.style.display='block'; ci.value=m;
  } else ci.style.display='none';
  if (lbl) document.getElementById('timer-label').value = lbl;
  const p = document.querySelector('.timer-panel');
  if(p){p.style.boxShadow=`0 0 0 2px var(--a)`;setTimeout(()=>p.style.boxShadow='',500);}
}

function alarm() {
  try {
    const ctx = new(window.AudioContext||window.webkitAudioContext)();
    [0,0.3,0.6].forEach((t,i) => {
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.connect(g);g.connect(ctx.destination);
      o.type='sine';o.frequency.value=[660,880,1100][i];
      g.gain.setValueAtTime(0.35,ctx.currentTime+t);
      g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+t+0.28);
      o.start(ctx.currentTime+t);o.stop(ctx.currentTime+t+0.3);
    });
  } catch(e){}
}

function initTimer() {
  document.getElementById('ring-prog').style.strokeDasharray = CIRC;
  ringUpdate();
  const startBtn = document.getElementById('timer-start');
  const resetBtn = document.getElementById('timer-reset');
  const ci = document.getElementById('custom-min');

  document.querySelectorAll('.preset').forEach(b => b.addEventListener('click', () => {
    const m = parseInt(b.dataset.m);
    document.querySelectorAll('.preset').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    if(m===0){ci.style.display='block';ci.focus();}
    else{ci.style.display='none';setTimer(m);}
  }));
  ci.addEventListener('change',()=>{const v=parseInt(ci.value);if(v>0)setTimer(v);});

  function setStatus(s){const el=document.getElementById('ring-status');if(el)el.textContent=s;}
  const playIcon='<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
  const pauseIcon='<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  startBtn.innerHTML=playIcon+' start';
  startBtn.addEventListener('click',()=>{
    if(tLeft===0)return;
    if(tRunning){clearInterval(tInterval);tRunning=false;startBtn.textContent='resume';}
    else{
      tRunning=true;startBtn.innerHTML=pauseIcon+' pause';setStatus('running');
      tInterval=setInterval(()=>{
        tLeft--;
        document.getElementById('ring-time').textContent=fmt(tLeft);
        ringUpdate();
        if(tLeft===0){clearInterval(tInterval);tRunning=false;startBtn.innerHTML=playIcon+' start';setStatus('done!');logSession();alarm();}
      },1000);
    }
  });
  resetBtn.addEventListener('click',()=>{
    clearInterval(tInterval);tRunning=false;tLeft=tTotal;
    document.getElementById('ring-time').textContent=fmt(tLeft);
    startBtn.innerHTML=playIcon+' start';setStatus('ready');
    ringUpdate();
  });
}

function logSession() {
  const label = document.getElementById('timer-label').value.trim() || 'study session';
  const mins = Math.round(tTotal / 60);
  if (mins <= 0) return;
  addSession({ at: new Date().toISOString(), label, mins, subject: guessSubject(label) });
  renderSessionLog();
}

/* ── Checklist ─────────────────────────────────────────── */
function initChecklist(dow, day) {
  const el = document.getElementById('task-list');
  const key = `mz-tasks-${new Date().toDateString()}`;
  const saved = S.get(key) || {};
  const tasks = day.subjects.flatMap(s => s.tasks.map(t => ({...t,_subj:s.name,_color:s.color})));
  tasks.forEach((t,i)=>{ t._i=i; });

  // Exam mode: subjects with a nearer exam rise to the top. Stable, and
  // _i is fixed above so saved completion state follows the task.
  const examOrder = t => { const e = nextExam(t._subj); return e ? daysUntil(e.date) : 9999; };
  const ordered = [...tasks].sort((a,b) => examOrder(a) - examOrder(b) || a._i - b._i);

  el.innerHTML='';
  ordered.forEach(t=>{
    const i=t._i;
    const done=!!saved[i];
    const item=document.createElement('div');
    item.className='task-item'+(done?' done':'');
    item.dataset.i=i;
    if(nextExam(t._subj)&&daysUntil(nextExam(t._subj).date)<=EXAM_WINDOW) item.classList.add('exam-focus');
    const pill=t.mins?`<span class="task-pill">${t.mins}m</span>`:'';
    const ai=t.generateContent?`<span class="task-ai" title="has study content"></span>`:'';
    item.innerHTML=`<input type="checkbox"${done?' checked':''}/>
      <span class="task-text">${esc(t.text)}${pill}${ai}</span>
      <button class="task-arrow">›</button>`;

    item.querySelector('input').addEventListener('change',e=>{
      saved[i]=e.target.checked;
      S.set(key,saved);
      item.classList.toggle('done',e.target.checked);
      updateTaskBar(tasks.length,saved);
      if(e.target.checked) scheduleReview(t);
      const allDone=Object.values(saved).filter(Boolean).length===tasks.length;
      const shownKey=`mz-reward-${new Date().toDateString()}`;
      if(allDone&&!S.get(shownKey)){S.set(shownKey,true);markDay();showReward(day);}
    });

    item.querySelector('.task-text').addEventListener('click',()=>openDetail(t));
    item.querySelector('.task-arrow').addEventListener('click',()=>openDetail(t));
    el.appendChild(item);
  });

  updateTaskBar(tasks.length,saved);

  document.getElementById('reset-tasks').addEventListener('click',()=>{
    S.del(`mz-tasks-${new Date().toDateString()}`);
    initChecklist(dow,day);
    document.getElementById('detail-empty').style.display='flex';
    document.getElementById('detail-body-wrap').style.display='none';
  });
}

function updateTaskBar(total,saved){
  const done=Object.values(saved).filter(Boolean).length;
  document.getElementById('task-bar').style.width=`${total?(done/total)*100:0}%`;
  document.getElementById('task-count').textContent=`${done} / ${total}`;
}

/* ── Detail panel ──────────────────────────────────────── */
function initDetail() {
  document.getElementById('detail-set-timer').addEventListener('click',()=>{
    if(currentTask?.mins)setTimer(currentTask.mins,currentTask.text);
  });
  document.getElementById('detail-tip-refresh').addEventListener('click',()=>{if(currentTask)fetchTip(currentTask);});
  document.getElementById('detail-gen-refresh').addEventListener('click',()=>{if(currentTask)fetchGen(currentTask);});
  document.getElementById('detail-chat-send').addEventListener('click',sendChat);
  document.getElementById('detail-chat-in').addEventListener('keydown',e=>{if(e.key==='Enter')sendChat();});
  document.getElementById('detail-open-settings')?.addEventListener('click',openSettings);
}

function openDetail(task) {
  currentTask=task; chatHistory=[];
  document.querySelectorAll('.task-item').forEach(el=>el.classList.toggle('selected',parseInt(el.dataset.i)===task._i));
  document.getElementById('detail-empty').style.display='none';
  document.getElementById('detail-body-wrap').style.display='flex';

  const chip=document.getElementById('detail-chip');
  chip.textContent=task._subj||'';
  chip.style.background=task._color||'#E0E0E0';chip.style.color='#333';

  document.getElementById('detail-mins').textContent=task.mins?`⏱ ${task.mins} min`:'';
  document.getElementById('detail-title').textContent=task.text;

  const dd=document.getElementById('detail-desc');
  if(task.detail){dd.textContent=task.detail;dd.style.display='block';}else dd.style.display='none';

  const stBtn=document.getElementById('detail-set-timer');
  stBtn.style.display=task.mins?'block':'none';
  if(task.mins)stBtn.textContent=`▶ set ${task.mins} min timer & start`;

  const genWrap=document.getElementById('detail-gen-wrap');
  if(task.generateContent){
    genWrap.style.display='flex';
    document.getElementById('detail-gen').innerHTML='<span style="font-size:0.72rem;color:var(--tx-3);font-style:italic">tap ↻ to generate…</span>';
    if(USER.apiKey)fetchGen(task);
  } else genWrap.style.display='none';

  document.getElementById('detail-chat-log').innerHTML='';
  document.getElementById('detail-chat-in').value='';

  const aiWrap=document.getElementById('detail-ai-wrap');
  const noKey=document.getElementById('detail-no-key');
  if(USER.apiKey){aiWrap.style.display='flex';noKey.style.display='none';fetchTip(task);}
  else{aiWrap.style.display='none';noKey.style.display='flex';}

  if(window.innerWidth<720)document.getElementById('detail-panel').scrollIntoView({behavior:'smooth',block:'start'});
}

async function fetchTip(task) {
  const el=document.getElementById('detail-tip');
  el.innerHTML='<span style="font-size:0.72rem;color:var(--tx-3);font-style:italic">generating…</span>';
  chatHistory=[];
  const sys=`You are a concise study coach for ${USER.name}, a Cambridge ${USER.grade||'Grade 8'} student. Current task: "${task.text}" (${task._subj}, ${task.mins?task.mins+' min':'flexible'}). 2-3 sentences max. Specific. Actionable. No fluff.`;
  const msg=`One specific tip for: "${task.text}"`;
  try{
    const r=await groq([{role:'system',content:sys},{role:'user',content:msg}],180);
    el.textContent=r;
    chatHistory=[{role:'system',content:sys},{role:'user',content:msg},{role:'assistant',content:r}];
  }catch(e){
    el.innerHTML=`<span style="font-size:0.72rem;color:var(--tx-3)">${esc(e.message)}</span>`;
  }
}

async function fetchGen(task) {
  const el=document.getElementById('detail-gen');
  el.innerHTML='<span style="font-size:0.72rem;color:var(--tx-3);font-style:italic">generating…</span>';
  const prompt=`Generate educational content for: "${task.text}" (${task._subj}, Cambridge ${USER.grade||'Grade 8'}).
Student: ${USER.name}. Context: ${task.detail||''}
Format with ---HEADING--- sections. 3-4 sections. Relevant to task.
Use spoiler format for answers: ---ANSWERS--- or ---MARK SCHEME---
150-250 words total. Specific and actionable.`;
  try{
    const r=await groq([{role:'system',content:'You generate compact study content. Split your answer into 2-4 sections. Start each section with its own descriptive title wrapped in three dashes, like ---Core idea--- or ---Practice--- or ---Answers---. Use the actual topic as the title; never write the word HEADING. Keep each section under 90 words. Use markdown for emphasis and lists. No preamble, no closing remarks.'},{role:'user',content:prompt}],420);
    el.innerHTML=parseGen(r);
  }catch(e){
    el.innerHTML=`<span style="font-size:0.72rem;color:var(--tx-3)">${esc(e.message)}</span>`;
  }
}

/* Minimal markdown → HTML. Escapes first, so model output can never
   inject elements; only the tags produced below can appear. */
function mdToHtml(src) {
  const lines = esc(src).split('\n');
  let html = '', list = null;

  const inline = t => t
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*(?!\s)(.+?)(?<!\s)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }

    const ol = line.match(/^(\d+)[.)]\s+(.*)$/);
    const ul = line.match(/^[-*•]\s+(.*)$/);
    const hd = line.match(/^(#{1,4})\s+(.*)$/);

    if (hd) { closeList(); html += `<h4 class="gen-h">${inline(hd[2])}</h4>`; continue; }
    if (ol) {
      if (list !== 'ol') { closeList(); html += '<ol class="gen-list">'; list = 'ol'; }
      html += `<li>${inline(ol[2])}</li>`; continue;
    }
    if (ul) {
      if (list !== 'ul') { closeList(); html += '<ul class="gen-list">'; list = 'ul'; }
      html += `<li>${inline(ul[1])}</li>`; continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

function parseGen(raw) {
  const parts = raw.split(/---+\s*([^-\n]+?)\s*---+/).filter(s => s.trim());
  if (parts.length < 2) return `<div class="gen-block"><div class="gen-body">${mdToHtml(raw)}</div></div>`;

  let html = '';
  for (let i = 0; i < parts.length - 1; i += 2) {
    const heading = parts[i].trim().replace(/^\*+|\*+$/g, '');
    const body = mdToHtml(parts[i + 1].trim());
    const spoiler = /ANSWER|MARK SCHEME|SOLUTION/i.test(heading);
    // Everything is collapsible; only the first section starts open, so a
    // long answer doesn't bury the rest of the panel.
    const open = !spoiler && i === 0 ? ' open' : '';
    html += `<details class="gen-block"${open}><summary>${esc(heading.toLowerCase())}</summary><div class="gen-body">${body}</div></details>`;
  }
  return html;
}

async function sendChat() {
  const input=document.getElementById('detail-chat-in');
  const msg=input.value.trim();
  if(!msg||!currentTask||!USER.apiKey)return;
  input.value='';
  const log=document.getElementById('detail-chat-log');
  const ub=document.createElement('div');ub.className='chat-bubble user';ub.textContent=msg;log.appendChild(ub);
  const lb=document.createElement('div');lb.className='chat-bubble ai';lb.innerHTML='<span style="color:var(--tx-3)">…</span>';log.appendChild(lb);
  log.scrollTop=log.scrollHeight;
  chatHistory.push({role:'user',content:msg});
  try{
    const r=await groq(chatHistory,280);
    chatHistory.push({role:'assistant',content:r});
    lb.textContent=r;
  }catch(e){
    chatHistory.pop();
    lb.innerHTML=`<span style="color:var(--tx-3)">${esc(e.message)}</span>`;
  }
  log.scrollTop=log.scrollHeight;
}

/* ── Music ─────────────────────────────────────────────── */
let audioCtx=null, audioNodes=[], currentSnd='none';

function getCtx(){
  if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended')audioCtx.resume();
  return audioCtx;
}
function stopAudio(){audioNodes.forEach(n=>{try{n.stop?.();n.disconnect?.();}catch(e){}});audioNodes=[];}

function brownNoise(vol){
  const ctx=getCtx(), size=ctx.sampleRate*4;
  const buf=ctx.createBuffer(2,size,ctx.sampleRate);
  for(let c=0;c<2;c++){
    const d=buf.getChannelData(c);
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for(let i=0;i<size;i++){
      const w=Math.random()*2-1;
      b0=0.99886*b0+w*0.0555179;b1=0.99332*b1+w*0.0750759;
      b2=0.9690*b2+w*0.153852;b3=0.8665*b3+w*0.3104856;
      b4=0.55*b4+w*0.5329522;b5=-0.7616*b5-w*0.016898;
      d[i]=(b0+b1+b2+b3+b4+b5+b6+w*0.5362)/8;b6=w*0.115926;
    }
  }
  const src=ctx.createBufferSource();src.buffer=buf;src.loop=true;
  const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=700;lp.Q.value=0.4;
  const g=ctx.createGain();g.gain.value=vol*0.88;
  src.connect(lp);lp.connect(g);g.connect(ctx.destination);src.start();
  audioNodes=[src,lp,g];
}

function rainNoise(vol){
  const ctx=getCtx(),nodes=[],size=ctx.sampleRate*3;
  [[3200,0.7,1200,'highpass',vol*0.42],[700,0.3,0,'bandpass',vol*0.28],[150,0.2,0,'lowpass',vol*0.14]].forEach(([freq,_,hpFreq,type,gain])=>{
    const b=ctx.createBuffer(2,size,ctx.sampleRate);
    for(let c=0;c<2;c++){const d=b.getChannelData(c);for(let i=0;i<size;i++)d[i]=Math.random()*2-1;}
    const src=ctx.createBufferSource();src.buffer=b;src.loop=true;
    const f=ctx.createBiquadFilter();f.type=type;f.frequency.value=type==='highpass'?hpFreq:freq;
    if(type==='highpass'){const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=freq;bp.Q.value=0.7;const g=ctx.createGain();g.gain.value=gain;src.connect(f);f.connect(bp);bp.connect(g);g.connect(ctx.destination);src.start();nodes.push(src,f,bp,g);}
    else{const g=ctx.createGain();g.gain.value=gain;src.connect(f);f.connect(g);g.connect(ctx.destination);src.start();nodes.push(src,f,g);}
  });
  audioNodes=nodes;
}

function focusTones(vol){
  const ctx=getCtx(),nodes=[];
  [[200,240,vol*0.12],[100,110,vol*0.07]].forEach(([lf,rf,v])=>{
    const m=ctx.createChannelMerger(2),g=ctx.createGain();g.gain.value=v;
    const lo=ctx.createOscillator(),ro=ctx.createOscillator();
    lo.type=ro.type='sine';lo.frequency.value=lf;ro.frequency.value=rf;
    const lg=ctx.createGain(),rg=ctx.createGain();lg.gain.value=rg.gain.value=1;
    lo.connect(lg);lg.connect(m,0,0);ro.connect(rg);rg.connect(m,0,1);
    m.connect(g);g.connect(ctx.destination);lo.start();ro.start();
    nodes.push(lo,ro,lg,rg,m,g);
  });
  // soft noise bed
  const size=ctx.sampleRate*2,b=ctx.createBuffer(1,size,ctx.sampleRate),d=b.getChannelData(0);
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for(let i=0;i<size;i++){const w=Math.random()*2-1;b0=0.99886*b0+w*0.0555179;b1=0.99332*b1+w*0.0750759;b2=0.969*b2+w*0.153852;b3=0.8665*b3+w*0.3104856;b4=0.55*b4+w*0.5329522;b5=-0.7616*b5-w*0.016898;d[i]=(b0+b1+b2+b3+b4+b5+b6+w*0.5362)/8;b6=w*0.115926;}
  const ns=ctx.createBufferSource();ns.buffer=b;ns.loop=true;
  const ng=ctx.createGain();ng.gain.value=vol*0.03;
  ns.connect(ng);ng.connect(ctx.destination);ns.start();nodes.push(ns,ng);
  audioNodes=nodes;
}

function setMusic(snd,vol){
  stopAudio();currentSnd=snd;
  if(snd==='brown')brownNoise(vol);
  else if(snd==='rain')rainNoise(vol);
  else if(snd==='focus')focusTones(vol);
}

function initMusic(){
  const vol=()=>parseFloat(document.getElementById('vol-slider').value);
  document.querySelectorAll('.music-chip').forEach(b=>{
    b.addEventListener('click',()=>{
      document.querySelectorAll('.music-chip').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      setMusic(b.dataset.snd,vol());
    });
  });
  document.getElementById('vol-slider').addEventListener('input',()=>{
    if(currentSnd!=='none')setMusic(currentSnd,vol());
  });
}

/* ── Plan tab ──────────────────────────────────────────── */
function initPlan(){
  const plan=USER.plan;
  document.getElementById('plan-title').textContent=`${USER.name.toLowerCase()}'s plan`;
  document.getElementById('plan-sub').textContent=plan.summary||'';

  let activeDow=new Date().getDay();if(activeDow===0)activeDow=1;
  const dayKeys=Object.keys(plan.days);

  const tabsEl=document.getElementById('day-tabs');
  tabsEl.innerHTML=dayKeys.map(k=>`<button class="day-tab${k==activeDow?' active':''}" data-day="${k}">${esc(plan.days[k].name.slice(0,3).toLowerCase())}</button>`).join('');

  function renderDay(k){
    const day=plan.days[k];
    document.getElementById('plan-day-view').innerHTML=day.subjects.map(s=>`
      <div class="plan-card">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem">
          <span class="subj-chip" style="background:${s.color};color:#333">${s.name}</span>
        </div>
        <div class="plan-card-dur">${s.duration}</div>
        <ul class="plan-task-list">${s.tasks.map(t=>`<li>${t.text}${t.mins?`<span class="task-pill" style="margin-left:0.4rem">${t.mins}m</span>`:''}</li>`).join('')}</ul>
      </div>`).join('');
  }

  tabsEl.querySelectorAll('.day-tab').forEach(b=>{
    b.addEventListener('click',()=>{
      tabsEl.querySelectorAll('.day-tab').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      renderDay(b.dataset.day);
    });
  });

  renderDay(dayKeys.includes(String(activeDow))?String(activeDow):dayKeys[0]);

  document.getElementById('regen-plan-btn').addEventListener('click',async()=>{
    if(!USER.apiKey){alert('Add a Groq API key in settings first.');return;}
    if(!confirm('Regenerate your study plan?'))return;
    document.getElementById('regen-plan-btn').textContent='generating…';
    try{
      const plan=await generatePlan({name:USER.name,grade:USER.grade,hours:USER.hours,days:USER.days,focus:USER.focus,style:USER.style,coaching:USER.coaching},USER.reportText||'',USER.syllabusText||'','');
      USER.plan=plan;S.set('mz',USER);initPlan();initCS();initProjects();
      notify('Plan regenerated.','ok');
    }catch(e){
      console.error(e);
      notify(`Could not regenerate: ${e.message} Your old plan is untouched.`,'warn');
    }
    document.getElementById('regen-plan-btn').textContent='↻ regenerate';
  });
}

/* ══════════════════════════════════════════════════════════
   Sessions · Reviews · Exams · Backup
══════════════════════════════════════════════════════════ */

/* Dates are stored as local YYYY-MM-DD strings. Comparing them as
   strings sorts correctly, and it avoids new Date('2026-08-03')
   silently being parsed as UTC and landing on the wrong day. */
const dayKey = d => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
};
const parseDay = s => { const [y,m,d] = String(s).split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysUntil = s => Math.round((parseDay(s) - parseDay(dayKey(new Date()))) / 86400000);
const today = () => dayKey(new Date());
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ── Sessions ──────────────────────────────────────────── */
/* Previously the timer log was written straight to the DOM and lost on
   refresh. It is persisted now, which also makes time stats possible. */

function getSessions() { return S.get('mz-sessions') || []; }

function addSession(entry) {
  const list = getSessions();
  list.unshift(entry);
  S.set('mz-sessions', list.slice(0, 500));
}

function sessionStats(days = 7) {
  const from = dayKey(addDays(new Date(), -(days - 1)));
  const recent = getSessions().filter(s => dayKey(s.at) >= from);
  const bySubject = {};
  let total = 0;
  recent.forEach(s => {
    total += s.mins;
    const k = s.subject || 'unlabelled';
    bySubject[k] = (bySubject[k] || 0) + s.mins;
  });
  const byDay = {};
  recent.forEach(s => { const k = dayKey(s.at); byDay[k] = (byDay[k] || 0) + s.mins; });
  return { total, count: recent.length, bySubject, byDay, days };
}

/* Best guess at which subject a session belongs to: the open task wins,
   otherwise match the free-text label against the plan's subject names. */
function guessSubject(label) {
  if (currentTask?._subj) return currentTask._subj;
  const names = new Set();
  Object.values(USER?.plan?.days || {}).forEach(d => (d.subjects || []).forEach(s => names.add(s.name)));
  const l = (label || '').toLowerCase();
  for (const n of names) if (n && l.includes(n.toLowerCase())) return n;
  return null;
}

function renderSessionLog() {
  const el = document.getElementById('session-log');
  if (!el) return;
  const todays = getSessions().filter(s => dayKey(s.at) === today());
  if (!todays.length) { el.innerHTML = '<p class="empty-state">no sessions yet</p>'; return; }
  el.innerHTML = todays.map(s => {
    const time = new Date(s.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    return `<div class="log-entry"><span class="log-check">✓</span><span>${esc(s.label)} <em style="color:var(--tx-3);font-size:0.65rem">(${s.mins}m)</em></span><span class="log-time">${time}</span></div>`;
  }).join('');
}

/* ── Spaced repetition ─────────────────────────────────── */
/* An SM-2 variant. Completing a task creates a review item; recalling it
   well pushes it further out, forgetting resets it. Intervals are capped
   so nothing falls due after the exam it is meant to prepare for. */

const FIRST_GAP = 1, SECOND_GAP = 3, MIN_EASE = 1.3;

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

const reviewId = (text, subject) => 'r' + hashStr(`${subject || ''}::${text}`);

function getReviews() { return S.get('mz-reviews') || {}; }
function saveReviews(r) { S.set('mz-reviews', r); }

function scheduleReview(task) {
  if (!task?.text) return;
  const reviews = getReviews();
  const id = reviewId(task.text, task._subj);
  if (reviews[id]) return; // already tracked — don't reset its progress
  reviews[id] = {
    id, text: task.text, subject: task._subj || null,
    ease: 2.5, interval: FIRST_GAP, reps: 0, lapses: 0,
    created: today(), due: dayKey(addDays(new Date(), FIRST_GAP)),
  };
  saveReviews(reviews);
}

/** Next interval for a given answer, without saving. Used for previews. */
function nextInterval(r, quality) {
  let { ease, interval, reps } = r;
  if (quality === 'again') return { interval: FIRST_GAP, ease: Math.max(MIN_EASE, ease - 0.2), reps: 0 };
  reps++;
  if (quality === 'hard') {
    ease = Math.max(MIN_EASE, ease - 0.15);
    interval = Math.max(FIRST_GAP, Math.round(interval * 1.2));
  } else if (quality === 'good') {
    interval = reps === 1 ? FIRST_GAP : reps === 2 ? SECOND_GAP : Math.round(interval * ease);
  } else {
    ease = ease + 0.15;
    interval = reps === 1 ? SECOND_GAP : Math.round(interval * ease * 1.3);
  }
  return { interval: Math.max(1, interval), ease, reps };
}

/** Days until the next exam for a subject, minus one, or null. */
function examCap(subject) {
  const e = nextExam(subject);
  if (!e) return null;
  const d = daysUntil(e.date);
  return d > 1 ? d - 1 : 1;
}

function gradeReview(id, quality) {
  const reviews = getReviews();
  const r = reviews[id];
  if (!r) return null;

  const next = nextInterval(r, quality);
  r.ease = next.ease;
  r.reps = next.reps;
  r.interval = next.interval;
  if (quality === 'again') r.lapses++;

  const cap = examCap(r.subject);
  r.cappedByExam = cap !== null && r.interval > cap;
  if (r.cappedByExam) r.interval = Math.max(1, cap);

  r.due = dayKey(addDays(new Date(), r.interval));
  r.last = today();
  saveReviews(reviews);
  return r;
}

function dueReviews() {
  const t = today();
  return Object.values(getReviews())
    .filter(r => r.due <= t)
    .sort((a, b) => {
      // Subjects with a nearer exam come first.
      const ea = nextExam(a.subject), eb = nextExam(b.subject);
      const da = ea ? daysUntil(ea.date) : 9999;
      const db = eb ? daysUntil(eb.date) : 9999;
      if (da !== db) return da - db;
      return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    });
}

function upcomingReviewCount(days = 7) {
  const limit = dayKey(addDays(new Date(), days));
  const t = today();
  return Object.values(getReviews()).filter(r => r.due > t && r.due <= limit).length;
}

/* ── Exams ─────────────────────────────────────────────── */

function getExams() {
  return (S.get('mz-exams') || [])
    .filter(e => e && e.subject && e.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
function saveExams(list) { S.set('mz-exams', list); }

function upcomingExams() {
  const t = today();
  return getExams().filter(e => e.date >= t);
}

function nextExam(subject) {
  if (!subject) return null;
  const s = subject.toLowerCase();
  return upcomingExams().find(e => e.subject.toLowerCase() === s) || null;
}

/** Exam mode kicks in inside this window. */
const EXAM_WINDOW = 14;
function examsSoon() {
  return upcomingExams().filter(e => daysUntil(e.date) <= EXAM_WINDOW);
}

/** Read an exam timetable out of a photo/screenshot and merge it in. */
async function importExamsFromFile(file) {
  if (looksLikeBackup(file)) {
    const parsed = JSON.parse(await file.text());
    const list = Array.isArray(parsed) ? parsed : parsed?.data?.['mz-exams'] ? JSON.parse(parsed.data['mz-exams']) : null;
    if (!Array.isArray(list)) throw new Error('No exam list found in that file.');
    return mergeExams(list);
  }

  const text = await extractDoc(file, 'existing');
  const year = new Date().getFullYear();
  const reply = await groq([
    { role: 'system', content: 'You extract exam timetables. Return JSON only, no markdown, no commentary.' },
    { role: 'user', content: `From this timetable, list every exam with its subject and date.
Return exactly: {"exams":[{"subject":"Physics","date":"${year}-09-14","syllabus":"topics listed for this paper, or empty string"}]}
Dates must be YYYY-MM-DD. If a year is not written, assume ${year}. Include the syllabus/topic list for a paper if one is shown. Skip anything that is not an exam.

TIMETABLE:
${text}` }
  ], 900);

  let parsed;
  try {
    parsed = JSON.parse(reply.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim());
  } catch {
    throw new Error('Could not read an exam timetable out of that file.');
  }

  const found = (Array.isArray(parsed?.exams) ? parsed.exams : [])
    .filter(e => e && asText(e.subject) && /^\d{4}-\d{2}-\d{2}$/.test(asText(e.date)))
    .map(e => ({ subject: asText(e.subject), date: asText(e.date), syllabus: asText(e.syllabus) }));

  if (!found.length) throw new Error('No exams with readable dates were found in that file.');
  return mergeExams(found);
}

/** Add exams without creating duplicates. Returns how many were new. */
function mergeExams(incoming) {
  const list = getExams();
  let added = 0;
  incoming.forEach(e => {
    const dupe = list.find(x => x.subject.toLowerCase() === e.subject.toLowerCase() && x.date === e.date);
    if (dupe) { if (e.syllabus && !dupe.syllabus) dupe.syllabus = e.syllabus; return; }
    list.push(e);
    added++;
  });
  saveExams(list);
  return added;
}

/* ── Backup ────────────────────────────────────────────── */

function exportData() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('mz')) data[k] = localStorage.getItem(k);
  }
  const payload = { app: 'meridian-zenith', version: 1, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meridian-backup-${today()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || typeof parsed.data !== 'object' || parsed.data === null) {
    throw new Error('That does not look like a Meridian backup.');
  }
  if (!parsed.data.mz) {
    throw new Error('That backup has no profile in it — nothing to restore.');
  }
  const keys = Object.keys(parsed.data).filter(k => k.startsWith('mz'));
  if (!keys.length) throw new Error('That backup is empty.');
  keys.forEach(k => localStorage.setItem(k, parsed.data[k]));
  return keys.length;
}

/* ── Review tab ────────────────────────────────────────── */

let reviewQueue = [];

function fmtGap(days) {
  if (days < 1) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 30) return `in ${days}d`;
  return `in ${Math.round(days / 7)}w`;
}

function initReview() {
  reviewQueue = dueReviews();
  renderReview();
}

function renderReview() {
  const countEl = document.getElementById('review-count');
  const emptyEl = document.getElementById('review-empty');
  const cardEl = document.getElementById('review-card');
  const examEl = document.getElementById('review-exam');
  const upcomingEl = document.getElementById('review-upcoming');
  if (!countEl) return;

  countEl.textContent = reviewQueue.length;

  // Exam banner
  const soon = examsSoon();
  examEl.innerHTML = soon.length
    ? soon.slice(0, 3).map(e => {
        const d = daysUntil(e.date);
        return `<span class="exam-pill${d <= 3 ? ' urgent' : ''}">${esc(e.subject)} · ${d <= 0 ? 'today' : plural(d, 'day')}</span>`;
      }).join('')
    : '';

  const later = upcomingReviewCount(7);
  upcomingEl.textContent = later ? `${plural(later, 'card')} coming up in the next 7 days` : '';

  if (!reviewQueue.length) {
    cardEl.style.display = 'none';
    emptyEl.style.display = 'block';
    const total = Object.keys(getReviews()).length;
    emptyEl.innerHTML = total
      ? `<div class="review-done">✓</div><p>Nothing due today. ${later ? `${plural(later, 'card')} due this week.` : 'You are all caught up.'}</p>`
      : `<p>Tick off tasks in your plan and they will start appearing here for review — tomorrow, then three days later, then further apart each time you remember them.</p>`;
    return;
  }

  emptyEl.style.display = 'none';
  cardEl.style.display = 'flex';

  const r = reviewQueue[0];
  const exam = nextExam(r.subject);
  document.getElementById('review-subject').innerHTML = r.subject
    ? `<span class="review-subj-tag">${esc(r.subject)}</span>${exam ? `<span class="review-exam-note">exam ${fmtGap(daysUntil(exam.date))}</span>` : ''}`
    : '';
  document.getElementById('review-text').textContent = r.text;

  const meta = document.getElementById('review-meta');
  meta.textContent = r.reps
    ? `seen ${plural(r.reps, 'time')}${r.lapses ? ` · forgotten ${r.lapses}×` : ''}`
    : 'first review';

  // Each button previews where it sends the card.
  document.querySelectorAll('#review-actions .rev-btn').forEach(b => {
    const preview = nextInterval(r, b.dataset.q);
    const cap = examCap(r.subject);
    const gap = cap !== null && preview.interval > cap ? Math.max(1, cap) : preview.interval;
    b.querySelector('.rev-gap').textContent = fmtGap(gap);
  });
}

function answerReview(quality) {
  const r = reviewQueue.shift();
  if (!r) return;
  const updated = gradeReview(r.id, quality);
  if (updated?.cappedByExam) {
    notify(`Brought forward to ${fmtGap(updated.interval)} so it lands before your ${updated.subject} exam.`, 'ok', 5000);
  }
  renderReview();
}

function initReviewControls() {
  document.querySelectorAll('#review-actions .rev-btn').forEach(b => {
    b.addEventListener('click', () => answerReview(b.dataset.q));
  });
  document.addEventListener('keydown', e => {
    const tab = document.getElementById('tab-review');
    if (!tab?.classList.contains('active')) return;
    if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const map = { '1':'again', '2':'hard', '3':'good', '4':'easy' };
    if (map[e.key]) { e.preventDefault(); answerReview(map[e.key]); }
  });
}

/* ── Overview tab ──────────────────────────────────────── */

/* study-plan hardcoded one student's grades. Here they come from the
   report card the AI read, so every card degrades to an empty state
   rather than showing numbers that belong to nobody. */
function gradeColour(score) {
  return score >= 90 ? '#2D8A4E' : score >= 80 ? '#4A9E6A' : score >= 70 ? '#C45C1A' : '#991B1B';
}

function initOverview() {
  const el = document.getElementById('overview-grid');
  if (!el || !USER?.plan) return;

  const now = new Date();
  const streak = getStreak();
  const streakDays = streak.days || [];

  // Today's tasks
  const dow = now.getDay();
  const day = USER.plan.days?.[dow] || USER.plan.days?.[String(dow)];
  const saved = S.get(`mz-tasks-${now.toDateString()}`) || {};
  const tasks = day ? (day.subjects || []).flatMap(s => s.tasks || []) : [];
  const done = Object.values(saved).filter(Boolean).length;

  // 28-day habit grid
  const gridDays = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    gridDays.push({ date: d.toDateString(), isToday: i === 0 });
  }

  const grades = Array.isArray(USER.plan.grades) ? USER.plan.grades : [];
  const focus = (USER.focus || []).map(f => f.toLowerCase());
  const term = termProgress();
  const roadmap = USER.plan.roadmap || [];

  const cards = [];

  // Today
  cards.push(`
    <div class="ov-card">
      <div class="panel-row"><span class="eyebrow">today</span><span class="eyebrow">${now.toLocaleDateString('en-IN',{weekday:'long'})}</span></div>
      ${day ? `
        <div class="ov-stat">${done}<span style="font-size:1rem;color:var(--tx-3)"> / ${tasks.length}</span></div>
        <div class="ov-stat-lbl">tasks complete today</div>
        <div class="progress-track"><div class="progress-fill" style="width:${tasks.length ? (done/tasks.length)*100 : 0}%"></div></div>
        <div style="font-size:0.75rem;color:var(--tx-2)">${(day.subjects||[]).map(s=>`<span class="subj-chip" style="background:${s.color};color:#333;margin-right:4px">${esc(s.name)}</span>`).join('')}</div>
      ` : `<div class="ov-empty">Nothing scheduled today — it's a rest day.</div>`}
    </div>`);

  // Streak
  cards.push(`
    <div class="ov-card">
      <div class="panel-row"><span class="eyebrow">streak</span><span style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--a)">${streak.current} day${streak.current!==1?'s':''}</span></div>
      <div style="display:flex;align-items:baseline;gap:0.5rem">
        <div class="ov-stat">${streak.current}</div>
        <div>
          <div style="font-size:0.78rem;color:var(--tx-2)">current streak</div>
          <div style="font-size:0.72rem;color:var(--tx-3)">best: ${streak.best||0} days</div>
        </div>
      </div>
      <div class="ov-week-grid">
        ${gridDays.map(d=>`<div class="ov-week-day${streakDays.includes(d.date)?' done':''}${d.isToday?' today':''}" title="${d.date}"></div>`).join('')}
      </div>
      <div style="font-size:0.68rem;color:var(--tx-3)">last 28 days</div>
    </div>`);

  // Grades
  const focusNames = grades.filter(g => focus.includes((g.name||'').toLowerCase())).map(g => g.name);
  cards.push(`
    <div class="ov-card wide">
      <div class="panel-row">
        <span class="eyebrow">latest results</span>
        ${focusNames.length ? `<span class="ov-focus-badge">⚠ focus: ${focusNames.map(esc).join(' · ')}</span>` : ''}
      </div>
      ${grades.length ? `
        <div class="ov-subject-list">
          ${grades.map(g => {
            const score = Number(g.score);
            const pct = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
            const isFocus = focus.includes((g.name||'').toLowerCase());
            return `<div class="ov-subject-row">
              <span class="ov-subject-name">${esc(g.name||'—')}${isFocus?' <span style="font-size:0.6rem;color:var(--a)">↑ focus</span>':''}</span>
              <div class="ov-bar-row" style="flex:1;max-width:200px;margin:0 0.75rem">
                <div class="ov-bar-track"><div class="ov-bar-fill" style="width:${pct}%;background:${gradeColour(pct)}"></div></div>
              </div>
              <span class="ov-subject-grade" style="color:${gradeColour(pct)}">${Number.isFinite(score)?score:'—'}${g.grade?` (${esc(g.grade)})`:''}</span>
            </div>`;
          }).join('')}
        </div>
      ` : `<div class="ov-empty">No grades yet. Upload a report card in <button id="ov-to-settings">settings</button> and regenerate your plan to see them here.</div>`}
    </div>`);

  // Term countdown
  cards.push(`
    <div class="ov-card">
      <span class="eyebrow">${TERM.name} · ${TERM.start.toLocaleDateString('en-IN',{month:'long'})} → ${TERM.end.toLocaleDateString('en-IN',{month:'long'})}</span>
      <div class="ov-stat">${term.days}</div>
      <div class="ov-stat-lbl">days remaining</div>
      <div class="progress-track"><div class="progress-fill" style="width:${term.pct}%"></div></div>
      <div style="font-size:0.72rem;color:var(--tx-3)">${term.pct}% through · ${term.label}</div>
    </div>`);

  // CS roadmap — opt-in, so only show it when there is one
  if (roadmap.length) {
    cards.push(`
      <div class="ov-card">
        <span class="eyebrow">${esc((USER.plan.roadmapSubject||"roadmap").toLowerCase())} roadmap</span>
        <div class="ov-stat">${roadmap.length}</div>
        <div class="ov-stat-lbl">months · ${roadmap.reduce((n,m)=>n+(m.weeks?.length||0),0)} weeks</div>
        <div style="display:flex;flex-direction:column;gap:0.3rem;margin-top:0.25rem">
          ${roadmap.map(m=>`<div style="font-size:0.75rem;color:var(--tx-2)"><span style="color:var(--a);margin-right:0.35rem">·</span>${esc(m.month||'')} — ${esc(m.theme||'')}</div>`).join('')}
        </div>
      </div>`);
  }

  // Study time
  const stats = sessionStats(7);
  const topSubjects = Object.entries(stats.bySubject).sort((a,b)=>b[1]-a[1]).slice(0,4);
  const maxMins = topSubjects.length ? topSubjects[0][1] : 1;
  cards.push(`
    <div class="ov-card">
      <div class="panel-row"><span class="eyebrow">study time</span><span class="eyebrow">last 7 days</span></div>
      ${stats.total ? `
        <div class="ov-stat">${Math.floor(stats.total/60)}<span style="font-size:1rem;color:var(--tx-3)">h </span>${stats.total%60}<span style="font-size:1rem;color:var(--tx-3)">m</span></div>
        <div class="ov-stat-lbl">across ${plural(stats.count,'session')}</div>
        <div class="ov-subject-list">
          ${topSubjects.map(([name,mins])=>`
            <div class="ov-subject-row">
              <span class="ov-subject-name">${esc(name)}</span>
              <div class="ov-bar-row" style="flex:1;max-width:140px;margin:0 0.75rem">
                <div class="ov-bar-track"><div class="ov-bar-fill" style="width:${(mins/maxMins)*100}%;background:var(--a)"></div></div>
              </div>
              <span class="ov-subject-grade">${mins}m</span>
            </div>`).join('')}
        </div>
      ` : `<div class="ov-empty">No sessions logged yet. Run the timer on the session tab and it will show up here.</div>`}
    </div>`);

  // Reviews
  const due = dueReviews().length;
  const tracked = Object.keys(getReviews()).length;
  cards.push(`
    <div class="ov-card">
      <div class="panel-row"><span class="eyebrow">review</span><span class="eyebrow">${tracked ? plural(tracked,'card') : ''}</span></div>
      ${tracked ? `
        <div class="ov-stat">${due}</div>
        <div class="ov-stat-lbl">due today</div>
        <div style="font-size:0.75rem;color:var(--tx-2)">${upcomingReviewCount(7)} more in the next 7 days</div>
      ` : `<div class="ov-empty">Tick off tasks and they will come back here for spaced review.</div>`}
    </div>`);

  // Exams
  const exams = upcomingExams().slice(0, 5);
  if (exams.length) {
    const soonest = daysUntil(exams[0].date);
    cards.push(`
      <div class="ov-card">
        <div class="panel-row"><span class="eyebrow">exams</span>${soonest<=EXAM_WINDOW?'<span class="ov-focus-badge">exam mode on</span>':''}</div>
        <div class="ov-stat">${soonest<=0?'today':soonest}</div>
        <div class="ov-stat-lbl">${soonest<=0?`${exams[0].subject} exam`:`days to ${exams[0].subject}`}</div>
        <div class="ov-subject-list">
          ${exams.map(e=>{
            const d=daysUntil(e.date);
            return `<div class="ov-subject-row">
              <span class="ov-subject-name">${esc(e.subject)}</span>
              <span class="ov-subject-grade"${d<=EXAM_WINDOW?' style="color:#C45C1A"':''}>${d<=0?'today':plural(d,'day')}</span>
            </div>`;
          }).join('')}
        </div>
      </div>`);
  }

  el.innerHTML = cards.join('');
  document.getElementById('ov-to-settings')?.addEventListener('click', openSettings);
}

/* ── CS tab ────────────────────────────────────────────── */
function initCS(){
  const el=document.getElementById('cs-content');
  el.innerHTML=(USER.plan.roadmap||[]).map(m=>`
    <div class="cs-card">
      <div class="cs-card-head"><span class="cs-month">${m.month}</span><span class="cs-theme">${m.theme}</span></div>
      <div class="cs-weeks">${(m.weeks||[]).map(w=>`
        <div class="cs-week">
          <div class="cs-wk-num">${w.range}</div>
          <div><h4>${esc(w.title)}</h4><p>${esc(w.description)}</p></div>
        </div>`).join('')}
      </div>
      ${m.resources?.length?`<div class="cs-resources">${m.resources.map(r=>`<div class="cs-res">${r}</div>`).join('')}</div>`:''}
    </div>`).join('');
}

/* ── Projects tab ──────────────────────────────────────── */
/* ── Skill Tree ─────────────────────────────────────────── */
const SUBJ_COLORS2={'English':'#FDE8D8','Mathematics':'#E0F0FF','Physics':'#E8E0F8','Chemistry':'#FDE8EE','Biology':'#E0F4EC','History':'#F0E8D4','Geography':'#E8F4DC','CS':'#DCF4E8','Computer Science':'#DCF4E8','French':'#E0EEF8','Science':'#E0F4EC','Social Studies':'#F0E8D4'};
const SUBJ_EMOJIS2={'English':'📖','Mathematics':'📐','Physics':'⚡','Chemistry':'🧪','Biology':'🌿','History':'🏛','Geography':'🌍','CS':'💻','Computer Science':'💻','French':'🇫🇷','Science':'🔬','Social Studies':'🗺'};
function sc(s){return SUBJ_COLORS2[s]||'#E8E8E8';}
function se(s){return SUBJ_EMOJIS2[s]||'📚';}

function initProjects(){
  const projects=USER.plan?.projects||[];
  if(!projects.length)return;
  const startIdx=S.get('mz-proj-start');
  if(startIdx===null||startIdx===undefined){
    showPickModal(projects,i=>{S.set('mz-proj-start',i);renderTree(projects,i);});
  } else {
    renderTree(projects,startIdx);
  }
  document.getElementById('project-detail-close').addEventListener('click',()=>{
    document.getElementById('project-detail').style.display='none';
  });
}

function showPickModal(projects,onPick){
  document.getElementById('tree-pick-modal').style.display='flex';
  document.getElementById('tree-wrap').style.display='none';
  const list=document.getElementById('tree-pick-list');
  list.innerHTML=projects.map((p,i)=>`
    <button class="tree-pick-item" data-i="${i}">
      <span class="tree-pick-dot" style="background:${sc(p.subjects?.[0])}"></span>
      <div>
        <div class="tree-pick-name">${p.title}</div>
        <div class="tree-pick-meta">${p.month} · ${(p.subjects||[]).join(' + ')}</div>
      </div>
    </button>`).join('');
  list.querySelectorAll('.tree-pick-item').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.getElementById('tree-pick-modal').style.display='none';
      document.getElementById('tree-wrap').style.display='block';
      onPick(parseInt(btn.dataset.i));
    });
  });
}

function buildLayout(projects,centerIdx){
  const others=projects.map((p,i)=>({...p,_i:i})).filter((_,i)=>i!==centerIdx);
  const branches={};
  others.forEach(p=>{const s=p.subjects?.[0]||'General';if(!branches[s])branches[s]=[];branches[s].push(p);});
  const bKeys=Object.keys(branches);
  const nodes=[{idx:centerIdx,project:projects[centerIdx],type:'center',x:0.5,y:0.5,parentIdx:null}];
  const aStep=(2*Math.PI)/Math.max(bKeys.length,1);
  bKeys.forEach((subj,bi)=>{
    const base=bi*aStep-Math.PI/2;
    branches[subj].forEach((p,pi)=>{
      const r=pi===0?0.22:0.38;
      const off=pi===0?0:(pi%2===0?0.28:-0.28);
      const angle=base+off;
      nodes.push({idx:p._i,project:p,type:'branch',x:0.5+Math.cos(angle)*r,y:0.5+Math.sin(angle)*r,parentIdx:pi===0?centerIdx:branches[subj][0]._i,subject:subj,order:pi});
    });
  });
  return nodes;
}

function getNodeState(node,completed,centerIdx){
  if(node.type==='center')return completed.includes(node.idx)?'completed center':'center';
  if(completed.includes(node.idx))return'completed unlocked';
  if(node.parentIdx===null||node.parentIdx===centerIdx||completed.includes(node.parentIdx))return'available';
  return'locked';
}

function renderTree(projects,centerIdx){
  document.getElementById('tree-pick-modal').style.display='none';
  document.getElementById('tree-wrap').style.display='block';
  const completed=S.get('mz-proj-complete')||[];
  const wrap=document.getElementById('tree-wrap');
  const svg=document.getElementById('tree-svg');
  const nodesEl=document.getElementById('tree-nodes');
  const W=wrap.clientWidth||800, H=wrap.clientHeight||600;
  const layout=buildLayout(projects,centerIdx);

  // SVG lines
  svg.innerHTML='';
  layout.filter(n=>n.parentIdx!==null).forEach(n=>{
    const par=layout.find(p=>p.idx===n.parentIdx);
    if(!par)return;
    const state=getNodeState(n,completed,centerIdx);
    const lit=!state.includes('locked');
    const line=document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1',par.x*W);line.setAttribute('y1',par.y*H);
    line.setAttribute('x2',n.x*W);line.setAttribute('y2',n.y*H);
    line.setAttribute('class',`tree-line ${lit?'lit':'dashed'}`);
    // Animate line drawing
    const len=Math.hypot((n.x-par.x)*W,(n.y-par.y)*H);
    line.style.strokeDasharray=len;
    line.style.strokeDashoffset=lit?'0':len;
    if(lit){line.style.animation=`drawLine 0.6s ease forwards`;}
    svg.appendChild(line);
  });

  // CSS for line animation
  if(!document.getElementById('line-anim-style')){
    const s=document.createElement('style');s.id='line-anim-style';
    s.textContent='@keyframes drawLine{from{stroke-dashoffset:var(--len)}to{stroke-dashoffset:0}}';
    document.head.appendChild(s);
  }

  // Nodes
  nodesEl.innerHTML='';
  layout.forEach((n,ni)=>{
    const state=getNodeState(n,completed,centerIdx);
    const locked=state==='locked';
    const isCenter=state.includes('center');
    const isDone=state.includes('completed');
    const p=n.project;
    const color=sc(p.subjects?.[0]);
    const emoji=se(p.subjects?.[0]);

    const el=document.createElement('div');
    el.className='tree-node';
    el.style.left=(n.x*W)+'px';
    el.style.top=(n.y*H)+'px';
    el.style.animationDelay=(ni*60)+'ms';
    el.style.animation=`nodeIn 0.4s ease ${ni*60}ms both`;

    const circClass=isCenter?(isDone?'completed center':'center'):isDone?'completed unlocked':locked?'locked':'available unlocked';
    const bgStyle=isCenter?'':`background:${color}33;border-color:${color};`;

    el.innerHTML=`
      <div class="node-circle ${circClass}" style="${bgStyle}">
        <span class="node-icon">${locked?'🔒':emoji}</span>
        ${isDone?'<span style="position:absolute;bottom:-2px;right:-2px;font-size:0.6rem">✓</span>':''}
      </div>
      <span class="node-label">${locked?'???':p.title}</span>
      ${n.subject&&!locked?`<span class="node-subject-tag" style="background:${color};color:#333">${n.subject}</span>`:''}
    `;

    el.addEventListener('click',()=>openProjectDetail(n.idx,projects,centerIdx,layout,()=>renderTree(projects,centerIdx)));
    nodesEl.appendChild(el);
  });

  // Node entrance animation
  if(!document.getElementById('node-anim-style')){
    const s=document.createElement('style');s.id='node-anim-style';
    s.textContent='@keyframes nodeIn{from{opacity:0;transform:translate(-50%,-50%) scale(0.5)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}';
    document.head.appendChild(s);
  }

  // Pan
  let panning=false,ox=0,oy=0,lx=0,ly=0;
  wrap.onmousedown=e=>{panning=true;ox=e.clientX-lx;oy=e.clientY-ly;};
  wrap.onmousemove=e=>{if(!panning)return;const tx=e.clientX-ox,ty=e.clientY-oy;nodesEl.style.transform=`translate(${tx}px,${ty}px)`;svg.style.transform=`translate(${tx}px,${ty}px)`;lx=tx;ly=ty;};
  wrap.onmouseup=wrap.onmouseleave=()=>{panning=false;};
}

function openProjectDetail(idx,projects,centerIdx,layout,onComplete){
  const panel=document.getElementById('project-detail');
  const content=document.getElementById('project-detail-content');
  const p=projects[idx];
  const completed=S.get('mz-proj-complete')||[];
  panel.style.display='block';

  const node=layout.find(n=>n.idx===idx);
  const state=getNodeState(node,completed,centerIdx);

  if(state==='locked'){
    const prereq=projects[node.parentIdx];
    content.innerHTML=`<div class="project-detail-locked"><div class="lock-icon">🔒</div><div class="lock-title">${esc(p.title)}</div><div class="lock-sub">complete <strong>${esc(prereq?.title||'the previous project')}</strong> to unlock this branch</div></div>`;
    return;
  }

  const isDone=completed.includes(idx);
  content.innerHTML=`
    <div class="project-detail-node-header">
      <div class="project-detail-month">${p.month} · ${(p.subjects||[]).join(' + ')}</div>
      <h3 class="project-detail-title">${esc(p.title)}</h3>
      <div class="project-detail-tags">${(p.subjects||[]).map(s=>`<span class="subj-chip" style="background:${sc(s)};color:#333">${s}</span>`).join('')}</div>
    </div>
    <p class="project-detail-desc">${esc(p.description)}</p>
    <ol class="project-detail-steps">${(p.steps||[]).map(s=>`<li>${s}</li>`).join('')}</ol>
    <div class="project-detail-deliverable"><strong>deliverable:</strong> ${p.deliverable}</div>
    <button class="project-complete-btn ${isDone?'done':''}" id="proj-btn">${isDone?'✓ completed':'mark as complete'}</button>
  `;

  document.getElementById('proj-btn').addEventListener('click',()=>{
    if(isDone)return;
    const upd=[...(S.get('mz-proj-complete')||[]),idx];
    S.set('mz-proj-complete',upd);
    onComplete();
    openProjectDetail(idx,projects,centerIdx,buildLayout(projects,centerIdx),onComplete);
  });
}

/* ── Tour ───────────────────────────────────────────────── */
const TOUR=[
  {sel:'#today-panel',title:"today's overview",desc:"see today's subjects, streak, and jump straight to your plan.",pos:'right'},
  {sel:'.timer-panel',title:'session timer',desc:'pick a duration, type what you\'\2e working on, and start. alarm fires when done.',pos:'right'},
  {sel:'.checklist-panel',title:'task checklist',desc:'today\'\2 tasks auto-loaded. click any task to open the detail panel with ai tips and generated content.',pos:'left'},
  {sel:'.detail-panel',title:'detail panel',desc:'context, ai-generated content, and a chat box for any task.',pos:'left'},
  {sel:'.music-panel',title:'ambient sound',desc:'brown noise, rain, or binaural focus tones. plays while you study.',pos:'right'},
  {sel:'[data-tab="plan"]',title:'my plan',desc:'your full week day by day. ai-generated from your documents.',pos:'right'},
  {sel:'[data-tab="projects"]',title:'project tree',desc:'a visual skill tree. complete projects to unlock new branches.',pos:'right'},
  {sel:'[data-tab="cs"]',title:'your roadmap',desc:'a 16-week deep dive into the subject you picked, built just for you.',pos:'right'},
  {sel:'.sidebar-settings-btn',title:'settings',desc:'theme, api key, preferences, regenerate plan anytime.',pos:'right'},
];
let tourIdx=0;

function startTour(){
  const ov=document.getElementById('tour-overlay');
  ov.style.display='block';ov.classList.add('active');
  tourIdx=0;showTourStep(0);
  document.getElementById('tour-next').onclick=()=>{
    tourIdx++;
    if(tourIdx>=TOUR.length)endTour();else showTourStep(tourIdx);
  };
  document.getElementById('tour-skip').onclick=endTour;
}

function endTour(){
  document.getElementById('tour-overlay').style.display='none';
  document.getElementById('tour-overlay').classList.remove('active');
  S.set('mz-tour-done',true);
}

function showTourStep(i){
  const step=TOUR[i];
  const target=document.querySelector(step.sel);
  document.getElementById('tour-step-label').textContent=`step ${i+1} of ${TOUR.length}`;
  document.getElementById('tour-title').textContent=step.title;
  document.getElementById('tour-desc').textContent=step.desc;
  document.getElementById('tour-next').textContent=i===TOUR.length-1?'finish →':'next →';
  document.getElementById('tour-dots').innerHTML=TOUR.map((_,j)=>`<div class="tour-dot ${j===i?'active':''}"></div>`).join('');

  const spot=document.getElementById('tour-spotlight');
  const card=document.getElementById('tour-card');

  if(target){
    const r=target.getBoundingClientRect(),pad=8;
    spot.style.cssText=`left:${r.left-pad}px;top:${r.top-pad}px;width:${r.width+pad*2}px;height:${r.height+pad*2}px;`;
    const cw=300,ch=180;
    let cx=step.pos==='right'?r.right+16:r.left-cw-16;
    let cy=r.top+r.height/2-ch/2;
    cx=Math.max(8,Math.min(cx,window.innerWidth-cw-8));
    cy=Math.max(8,Math.min(cy,window.innerHeight-ch-8));
    card.style.cssText=`left:${cx}px;top:${cy}px;transform:none;`;
  } else {
    spot.style.cssText='left:50%;top:50%;width:0;height:0;';
    card.style.cssText='left:50%;top:50%;transform:translate(-50%,-50%);';
  }
}

/* ── Settings ──────────────────────────────────────────── */
function openSettings(){
  document.getElementById('settings-scrim').style.display='block';
  document.getElementById('settings-drawer').style.display='flex';
  document.getElementById('s-name').value=USER.name||'';
  document.getElementById('s-key').value=USER.apiKey||'';
  const h=document.getElementById('s-hours');if(h)h.value=USER.hours||'1 hour';
  const f=document.getElementById('s-focus');if(f)f.value=(USER.focus||[]).join(', ');
  const c=document.getElementById('s-coaching');if(c)c.value=USER.coaching||'';
  document.querySelectorAll('.theme-btn').forEach(b=>b.classList.toggle('active',b.dataset.theme===(USER.theme||'light')));
}

function closeSettings(){
  document.getElementById('settings-scrim').style.display='none';
  document.getElementById('settings-drawer').style.display='none';
}

function initSettings(){
  document.getElementById('settings-open-btn').addEventListener('click',openSettings);
  document.getElementById('mobile-settings-btn')?.addEventListener('click',openSettings);
  document.getElementById('settings-close').addEventListener('click',closeSettings);
  document.getElementById('settings-scrim').addEventListener('click',closeSettings);

  document.getElementById('s-save-name').addEventListener('click',()=>{
    const n=document.getElementById('s-name').value.trim();
    if(n){USER.name=n;S.set('mz',USER);document.getElementById('sidebar-greeting').textContent=`hey, ${n.toLowerCase()}`;}
  });
  document.getElementById('s-save-key').addEventListener('click',()=>{
    USER.apiKey=document.getElementById('s-key').value.trim();S.set('mz',USER);
    const ai=document.getElementById('detail-ai-wrap'),nk=document.getElementById('detail-no-key');
    if(ai)ai.style.display=USER.apiKey?'flex':'none';
    if(nk)nk.style.display=USER.apiKey?'none':'flex';
  });
  document.getElementById('s-save-prefs').addEventListener('click',()=>{
    USER.hours=document.getElementById('s-hours')?.value||USER.hours;
    USER.focus=(document.getElementById('s-focus')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
    USER.coaching=document.getElementById('s-coaching')?.value.trim()||'';
    S.set('mz',USER);
  });

  document.querySelectorAll('.theme-btn').forEach(b=>b.addEventListener('click',()=>applyTheme(b.dataset.theme)));

  let sReport=null,sSyllabus=null;
  document.getElementById('s-report').addEventListener('change',e=>{sReport=e.target.files[0];if(sReport)document.getElementById('s-report-name').textContent=sReport.name;});
  document.getElementById('s-syllabus').addEventListener('change',e=>{sSyllabus=e.target.files[0];if(sSyllabus)document.getElementById('s-syllabus-name').textContent=sSyllabus.name;});

  document.getElementById('s-regen').addEventListener('click',async()=>{
    if(!USER.apiKey){alert('Add a Groq API key first.');return;}
    closeSettings();
    let rt=USER.reportText||'',st=USER.syllabusText||'';

    // Keep whatever was already stored if a re-read fails — a failed
    // upload must never wipe good data.
    if(sReport){
      try{ rt=await extractDoc(sReport,'report'); }
      catch(e){ notify(`Report card: ${e.message} Keeping the previous one.`,'warn'); }
    }
    if(sSyllabus){
      try{ st=await extractDoc(sSyllabus,'syllabus'); }
      catch(e){ notify(`Syllabus: ${e.message} Keeping the previous one.`,'warn'); }
    }

    try{
      const plan=await generatePlan({name:USER.name,grade:USER.grade,hours:USER.hours,days:USER.days,focus:USER.focus,style:USER.style,coaching:USER.coaching},rt,st,'');
      USER.plan=plan;USER.reportText=rt;USER.syllabusText=st;S.set('mz',USER);
      initPlan();initCS();initProjects();
      notify('Plan regenerated.','ok');
    }catch(e){
      console.error(e);
      notify(`Could not regenerate: ${e.message} Your old plan is untouched.`,'warn');
    }
  });

  renderExamList();
  document.getElementById('s-exam-add').addEventListener('click',()=>{
    const subject=document.getElementById('s-exam-subject').value.trim();
    const date=document.getElementById('s-exam-date').value;
    if(!subject||!date){notify('Enter both a subject and a date.','warn',4000);return;}
    const list=getExams();
    if(list.some(e=>e.subject.toLowerCase()===subject.toLowerCase()&&e.date===date)){
      notify('That exam is already on the list.','warn',4000);return;
    }
    list.push({subject,date});
    saveExams(list);
    document.getElementById('s-exam-subject').value='';
    document.getElementById('s-exam-date').value='';
    renderExamList();
    refreshAfterDataChange();
  });

  document.getElementById('s-exam-import').addEventListener('click',()=>document.getElementById('s-exam-file').click());
  document.getElementById('s-exam-file').addEventListener('change',async e=>{
    const f=e.target.files[0]; e.target.value='';
    if(!f)return;
    const btn=document.getElementById('s-exam-import');
    btn.disabled=true; btn.textContent='reading…';
    try{
      const n=await importExamsFromFile(f);
      notify(n?`Added ${plural(n,'exam')}.`:'No new exams — they were already on the list.','ok',5000);
      renderExamList(); refreshAfterDataChange();
    }catch(err){ notify(`Could not import exams: ${err.message}`,'warn'); }
    btn.disabled=false; btn.textContent='import timetable from a file';
  });

  document.getElementById('s-import-plan').addEventListener('click',()=>document.getElementById('s-plan-file').click());
  document.getElementById('s-plan-file').addEventListener('change',async e=>{
    const f=e.target.files[0]; e.target.value='';
    if(!f)return;
    if(!confirm('Importing will replace your current plan. Continue?'))return;
    const btn=document.getElementById('s-import-plan');
    btn.disabled=true; btn.textContent='importing…';
    try{
      await importAnyPlan(f);
      notify('Plan imported.','ok',4000);
      location.reload();
    }catch(err){
      notify(`Could not import plan: ${err.message}`,'warn');
      btn.disabled=false; btn.textContent='import a plan';
    }
  });

  document.getElementById('s-export').addEventListener('click',()=>{
    try{ exportData(); notify('Backup downloaded.','ok',4000); }
    catch(e){ notify(`Export failed: ${e.message}`,'warn'); }
  });
  document.getElementById('s-import-btn').addEventListener('click',()=>document.getElementById('s-import').click());
  document.getElementById('s-import').addEventListener('change',async e=>{
    const file=e.target.files[0];
    e.target.value='';
    if(!file)return;
    if(!confirm('Restoring will replace everything currently in this browser. Continue?'))return;
    try{
      const n=await importData(file);
      alert(`Restored ${n} items. The page will reload.`);
      location.reload();
    }catch(err){
      notify(`Could not restore: ${err.message}`,'warn');
    }
  });

  document.getElementById('s-reset').addEventListener('click',()=>{
    if(confirm('Reset everything? This erases your plan, streak, sessions and review history. Export a backup first if you might want it back.')){localStorage.clear();location.reload();}
  });
}

function renderExamList(){
  const el=document.getElementById('s-exam-list');
  if(!el)return;
  const list=getExams();
  if(!list.length){el.innerHTML='<p class="settings-hint">no exams added yet.</p>';return;}
  el.innerHTML=list.map((e,i)=>{
    const d=daysUntil(e.date);
    const when=d<0?'passed':d===0?'today':plural(d,'day');
    return `<div class="exam-row${d>=0&&d<=EXAM_WINDOW?' soon':''}${d<0?' past':''}">
      <span class="exam-subject">${esc(e.subject)}</span>
      <span class="exam-when">${when}</span>
      <button class="exam-del" data-i="${i}" aria-label="Remove">×</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.exam-del').forEach(b=>b.addEventListener('click',()=>{
    const list=getExams();
    list.splice(Number(b.dataset.i),1);
    saveExams(list);
    renderExamList();
    refreshAfterDataChange();
  }));
}

/* Exam dates change task order, review caps and the overview at once. */
function refreshAfterDataChange(){
  initOverview();
  initReview();
  try{ initPlan(); }catch(e){ console.error(e); }
}

/* ── Reward ────────────────────────────────────────────── */
const EMOJIS=['🎉','🔥','⚡','🏆','✨','🎯','💪','🌟'];
async function showReward(day){
  const scrim=document.getElementById('reward-scrim');
  scrim.style.display='flex';
  document.getElementById('reward-emoji').textContent=EMOJIS[Math.floor(Math.random()*EMOJIS.length)];
  document.getElementById('reward-sub').textContent=`every task done for ${day.name.toLowerCase()}.`;
  const ai=document.getElementById('reward-ai');ai.textContent='…';
  const st=getStreak();
  let r=null;
  try{
    r=await groq([
      {role:'system',content:`Study coach for ${USER.name}. Warm, brief, genuine.`},
      {role:'user',content:`${USER.name} just completed every task for ${day.name}. Streak: ${st.current} day${st.current!==1?'s':''}. One sentence — genuine, specific to what they did, not generic.`}
    ],80);
  }catch(e){ console.error(e); }
  ai.textContent=r||'full day done — that\'s the habit being built.';
  document.getElementById('reward-close').addEventListener('click',()=>scrim.style.display='none',{once:true});
}

/* ── Boot ──────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded',()=>{
  const saved=S.get('mz');

  if(saved?.plan){
    USER=saved;
    applyTheme(USER.theme||'light');

    // A plan saved in a broken shape used to crash the boot and leave no
    // way to reach settings. Catch it here and offer a way out instead.
    try {
      USER.plan = validatePlan(USER.plan);
    } catch(e) {
      console.error('Stored plan is unusable', e);
      showRecovery(e.message);
      return;
    }
    launchApp();
    return;
  }

  document.getElementById('onboarding').style.display='flex';
  applyTheme('light');
  initOnboarding();
});

/* ── Recovery ──────────────────────────────────────────── */
/* Shown when the saved plan cannot be rendered. Deliberately standalone:
   it must work even if nothing else in the app has initialised. */
function showRecovery(reason){
  const ob=document.getElementById('onboarding');
  const app=document.getElementById('app');
  if(app)app.style.display='none';
  if(!ob)return;
  ob.style.display='flex';
  ob.innerHTML=`
    <div class="ob-card">
      <div class="ob-step active">
        <p class="ob-eyebrow">something went wrong</p>
        <h2 class="ob-h">your saved plan can't be opened</h2>
        <p class="ob-sub">${esc(reason)} Your streak, sessions and review history are all still here — only the plan itself is damaged.</p>
        <div class="rec-actions">
          <button class="ob-btn-primary" id="rec-regen">regenerate my plan</button>
          <button class="ob-btn-ghost" id="rec-import">import a plan file</button>
          <button class="ob-btn-ghost" id="rec-export">export a backup first</button>
        </div>
        <input type="file" id="rec-file" accept="application/json,.json,image/*" style="display:none"/>
      </div>
    </div>`;

  document.getElementById('rec-export').addEventListener('click',()=>{
    try{ exportData(); }catch(e){ alert('Export failed: '+e.message); }
  });
  document.getElementById('rec-import').addEventListener('click',()=>document.getElementById('rec-file').click());
  document.getElementById('rec-file').addEventListener('change',async e=>{
    const f=e.target.files[0]; e.target.value='';
    if(!f)return;
    try{
      await importAnyPlan(f);
      location.reload();
    }catch(err){ alert('Could not import: '+err.message); }
  });
  document.getElementById('rec-regen').addEventListener('click',async()=>{
    const btn=document.getElementById('rec-regen');
    btn.disabled=true; btn.textContent='generating…';
    try{
      const plan=await generatePlan(
        {name:USER.name,grade:USER.grade,hours:USER.hours,days:USER.days,focus:USER.focus,style:USER.style,coaching:USER.coaching,roadmapSubject:USER.roadmapSubject},
        USER.reportText||'',USER.syllabusText||'','');
      USER.plan=plan; S.set('mz',USER);
      location.reload();
    }catch(err){
      btn.disabled=false; btn.textContent='regenerate my plan';
      alert('Could not regenerate: '+err.message);
    }
  });
}
