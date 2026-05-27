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

/* ── Groq ──────────────────────────────────────────────── */
const MODEL = 'llama-3.1-8b-instant';

async function groq(messages, max = 600) {
  if (!USER?.apiKey) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 28000);
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${USER.apiKey}` },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: max, temperature: 0.75 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) { const e = await r.json().catch(()=>{}); console.error('Groq', r.status, e); return null; }
    return (await r.json()).choices?.[0]?.message?.content || null;
  } catch(e) { console.error(e); return null; }
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
  if (!file || !USER?.apiKey) return '';
  if (!file.type.startsWith('image/')) return ''; // only images supported via vision
  try {
    const b64 = await toB64(file);
    const prompt = type === 'existing'
      ? 'Extract the complete study schedule from this image. List every day, subject, task, and time mentioned. Be thorough and structured.'
      : type === 'report'
      ? 'Extract all academic data from this report card. List every subject with its score, grade, and any teacher feedback or comments.'
      : 'Extract all academic content from this syllabus/course planner. List every subject with units, topics, subtopics, and dates/months.';

    const key = USER.apiKey;
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${file.type};base64,${b64}` } }
        ]}],
        max_tokens: 1200
      })
    });
    if (!r.ok) return '';
    return (await r.json()).choices?.[0]?.message?.content || '';
  } catch(e) { return ''; }
}

/* ── Plan generation ───────────────────────────────────── */
async function generatePlan(prefs, reportText, syllabusText, existingPlanText) {
  const { name, grade, hours, days, focus, style, coaching } = prefs;
  const DAY_MAP = { Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6, Sunday:0 };
  const dayNums = days.map(d => DAY_MAP[d]).filter(n => n !== undefined);

  let context = '';
  if (existingPlanText) context = `EXISTING STUDY SCHEDULE (build the app tasks around this):\n${existingPlanText}\n\n`;
  if (reportText) context += `REPORT CARD DATA:\n${reportText}\n\n`;
  if (syllabusText) context += `SYLLABUS:\n${syllabusText}\n\n`;

  const prompt = `You are an expert Cambridge educational coach. Build a personalised self-study plan.

STUDENT: ${name}, ${grade || 'Grade 8'}, Cambridge curriculum
DAILY STUDY TIME: ${hours || '1 hour'} — fit ALL tasks per day within this
STUDY DAYS: ONLY ${days.join(', ')} (day numbers ${dayNums.join(',')})
${focus?.length ? `PRIORITY SUBJECTS (most time/tasks): ${focus.join(', ')}` : ''}
${style ? `LEARNING STYLE: ${style}` : ''}
${coaching ? `ALREADY COACHED IN (do NOT include): ${coaching}` : ''}

${context || 'No documents provided — use standard Cambridge curriculum for this grade.'}

STRICT RULES:
1. ONLY include days: ${days.join(', ')} — day numbers ${dayNums.join(',')} — nothing else
2. Each day's total task mins MUST fit within ${hours || '1 hour'}
3. If report card provided: prioritise weak subjects (lower scores), reference actual teacher feedback
4. If syllabus provided: every task must reference a REAL topic from the syllabus — no generic tasks
5. If existing schedule provided: restructure the student's actual schedule into the app format
6. Skip subjects already covered by coaching
7. generateContent:true only for tasks needing fresh AI content each session (reading, problems, exercises)
8. Every task must have a "detail" field with specific HOW-TO advice
9. Use soft pastel colors (#FDE8D8, #E0F0FF, #DCF4E8, #E8E0F8, #FDE8EE, #E0F4EC, #F0E8D4, #E8F4DC, #E0EEF8)

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "summary": "2-3 sentences: strengths, weaknesses, key focus based on their actual data",
  "days": {
    "${dayNums[0]||1}": {
      "name": "${days[0]||'Monday'}",
      "subjects": [{
        "name": "Subject",
        "color": "#FDE8D8",
        "duration": "25 min",
        "tasks": [{ "text": "specific task referencing real syllabus topic", "mins": 15, "detail": "how to do this well", "generateContent": false }]
      }]
    }
  },
  "csRoadmap": [{ "month": "Month", "theme": "theme desc", "weeks": [{ "range": "Wk 1-2", "title": "title", "description": "what to do and why" }], "resources": ["resource 1"] }],
  "projects": [{ "month": "Month", "title": "Project title", "subjects": ["S1","S2"], "description": "what it involves", "steps": ["step1","step2","step3","step4"], "deliverable": "what they produce" }]
}

Include ALL ${days.length} study day(s): ${days.map((d,i)=>`${dayNums[i]}=${d}`).join(', ')}
Include exactly 4 months in csRoadmap, 4 projects.`;

  const reply = await groq([
    { role: 'system', content: 'Expert educational planner. Return valid JSON only. No markdown. No explanation.' },
    { role: 'user', content: prompt }
  ], 2800);

  if (!reply) return null;
  try {
    const clean = reply.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(clean);
  } catch(e) { console.error('Plan parse fail', e, reply?.slice(0,300)); return null; }
}

function defaultPlan(prefs) {
  const { name } = prefs;
  return {
    summary: `Welcome, ${name}! Your personalised plan covers core Cambridge subjects with focused daily self-study. Tasks are built around common challenge points — analytical writing, science depth, and mathematical reasoning.`,
    days: {
      1: { name:'Monday', subjects:[
        { name:'English', color:'#FDE8D8', duration:'25 min', tasks:[
          { text:'Read one literary text not in your curriculum', mins:15, detail:'Choose a short story, essay, or poem 1-2 levels above class. Read slowly and annotate. Ask: what technique is the writer using?', generateContent:true },
          { text:'Write 5-8 lines of analytical response', mins:10, detail:"What is this text really about beneath the surface? Don't summarise — analyse the craft." }
        ]},
        { name:'History', color:'#F0E8D4', duration:'35 min', tasks:[
          { text:'Find one primary source on this week\'s topic', mins:15, detail:'Wikisource has free primary documents. Read slowly. Ask: who wrote this, when, and why does their position matter?' },
          { text:'Write OPCVL analysis', mins:10, detail:'Origin, Purpose, Content, Value, Limitation. What does this source tell us? Why might it be limited?' },
          { text:'Connect source to the bigger argument', mins:10, detail:'How does this source fit the main historical narrative? Be specific — cite it.' }
        ]}
      ]},
      2: { name:'Tuesday', subjects:[
        { name:'Mathematics', color:'#E0F0FF', duration:'35 min', tasks:[
          { text:'Attempt 2-3 harder problems without examples', mins:15, detail:'Struggle productively — 5 minutes of genuine effort before any hint. The discomfort is the mechanism.', generateContent:true },
          { text:'Prove why one rule from this week works', mins:15, detail:"Don't accept rules without understanding. Example: why does a negative index give a reciprocal? Prove from the pattern." },
          { text:'Error journal: categorise any mistakes', mins:5, detail:'Categories: conceptual misunderstanding / careless arithmetic / question misread. Patterns across errors are more useful than individual corrections.' }
        ]},
        { name:'Physics', color:'#E8E0F8', duration:'25 min', tasks:[
          { text:'Read each question TWICE before touching a pen', detail:'Most careless errors come from misreading, not from not knowing. Two reads costs 10 seconds.' },
          { text:'Solve today\'s problems', mins:25, detail:'Explain the physical principle before calculating. Estimate the answer before working it out.', generateContent:true }
        ]}
      ]},
      3: { name:'Wednesday', subjects:[
        { name:'CS', color:'#DCF4E8', duration:'35 min', tasks:[
          { text:'3-sentence summary from memory, no notes', mins:5, detail:"Close everything. Write 3 sentences from memory. If you can't, go back before moving forward." },
          { text:'Work through this week\'s CS fundamentals topic', mins:20, detail:'Trace the algorithm on paper first. Then code. Never copy — type from understanding.', generateContent:true },
          { text:'Trace algorithm by hand on 5-6 elements', mins:10, detail:'No code. Paper only. Understanding logic before writing code is what makes debugging easy.' }
        ]},
        { name:'Chemistry', color:'#FDE8EE', duration:'25 min', tasks:[
          { text:'Work through today\'s Chemistry topic', mins:15, detail:'Read every question twice. Underline the command word. Answer only what it asks.', generateContent:true },
          { text:'Attempt one past paper question', mins:10, detail:'describe=what happens, explain=why, compare=similarities AND differences.' }
        ]}
      ]},
      4: { name:'Thursday', subjects:[
        { name:'Biology', color:'#E0F4EC', duration:'30 min', tasks:[
          { text:'Go one level deeper than the textbook', mins:15, detail:'A-level content is accessible at Grade 8 if explained well. For photosynthesis: what actually happens in the light-dependent stage?', generateContent:true },
          { text:'Draw and label full diagram from memory', mins:10, detail:'No looking. Draw from scratch. Mark every gap in red. Gaps = spend 5 min on precisely those parts.' },
          { text:'Find one real-world connection', mins:5, detail:'Science Daily or BBC Science. One article connected to this week\'s topic.' }
        ]},
        { name:'Geography', color:'#E8F4DC', duration:'30 min', tasks:[
          { text:'Find one current news story on this week\'s topic', mins:10, detail:'Write 3-4 sentences arguing a position — not just describing. Use geographical terminology.' },
          { text:'Draw key map features from memory', mins:10, detail:'No atlas. Outline + physical features relevant to this week. Check accuracy after.' },
          { text:'Connection journal: Biology ↔ Geography', mins:10, detail:'Push beyond the obvious. These cross-subject connections appear in top-grade responses.' }
        ]}
      ]},
      5: { name:'Friday', subjects:[
        { name:'French', color:'#E0EEF8', duration:'25 min', tasks:[
          { text:'Today\'s listening and immersion', mins:10, detail:'TV5Monde, Coffee Break French, or InnerFrench. Authentic exposure is irreplaceable.', generateContent:true },
          { text:'Write 6-8 original sentences using this week\'s tense', mins:10, detail:'Original sentences from your own thinking. One sophisticated sentence beats three simple ones.' },
          { text:'Go deep on one grammar rule — understand the logic', mins:5, detail:'The logic behind grammar rules is more memorable than rote learning. Why does it work this way?' }
        ]},
        { name:'CS', color:'#DCF4E8', duration:'35 min', tasks:[
          { text:'Build and time this week\'s CS implementation', mins:20, detail:'Implement, then time on arrays of 10/100/1000. Does timing match Big-O theory?', generateContent:true },
          { text:'Ask "why does this work?" one level deeper', mins:10, detail:"For binary search: why must the array be sorted? Understanding preconditions separates programmers." },
          { text:'Set 3 specific measurable goals for next week', mins:5, detail:'Not "do better" but "implement selection sort and time it on 3 array sizes."' }
        ]}
      ]},
      6: { name:'Saturday', subjects:[
        { name:'Project', color:'#EDF5E9', duration:'60 min', tasks:[
          { text:"Re-read project brief — what is today's specific deliverable?", mins:5, detail:'Answer in one sentence: "By the end of today I will have…"' },
          { text:'First 25-min block: substance only, no polishing', mins:25, detail:'Resist making it look good before it is good.' },
          { text:'5-min break', mins:5, detail:'Actually stop. The break is part of the method.' },
          { text:'Second 25-min block: continue building', mins:25, detail:'Push through to completion of today\'s deliverable.' },
          { text:'Write 2 sentences: what you did + next Saturday\'s step', mins:5, detail:'Prevents starting from zero each week. Be specific.' }
        ]}
      ]}
    },
    csRoadmap: [
      { month:'June', theme:'how computers actually work', weeks:[
        { range:'Wk 1-2', title:'Binary and data representation', description:'Number systems from first principles. How integers, text (ASCII), and colours (RGB) are stored as binary. Convert manually: decimal ↔ binary ↔ hex. Implement a converter in Python without built-in functions.' },
        { range:'Wk 3-4', title:'Logic gates and Boolean algebra', description:'AND, OR, NOT, NAND, NOR, XOR — understood as physical transistors, not just symbols. Build truth tables. Simplify using De Morgan\'s laws. Show how a half-adder is built from logic gates.' }
      ], resources:['CS50 Week 0 — Harvard (free)','Ben Eater on YouTube — 8-bit computer series','nand2tetris.org'] },
      { month:'July', theme:'algorithms: solving problems efficiently', weeks:[
        { range:'Wk 5-6', title:'Sorting algorithms', description:'Implement bubble sort, selection sort, and insertion sort from scratch — no built-in sort. For each: trace through 5 elements on paper first, then code, then count comparisons and swaps. Why is insertion sort better on nearly-sorted data?' },
        { range:'Wk 7-8', title:'Searching and Big-O notation', description:'Linear search vs binary search. Implement both, time them on 100/1000/10000 elements. Plot results. Big-O intuitively: O(n) vs O(log n). Prove why binary search requires a sorted array.' }
      ], resources:['"Grokking Algorithms" by Aditya Bhargava — Ch 1-4','CS50 Week 3 — Algorithms','Visualgo.net — algorithm animations'] },
      { month:'August', theme:'data structures: organising information', weeks:[
        { range:'Wk 9-10', title:'Arrays, linked lists, stacks, queues', description:'Why is array random access O(1) but insertion O(n)? Implement a stack (LIFO) and queue (FIFO) from scratch. Use your stack to check for balanced parentheses in an expression.' },
        { range:'Wk 11-12', title:'Hash tables and trees', description:'How does Python\'s dict achieve O(1) lookup? What is a hash function? What is a collision? Binary search trees: implement insert and search. Where do trees appear in real systems?' }
      ], resources:['"Grokking Algorithms" Ch 5 and 7','CS50 Week 5 — Data Structures','pythontutor.com — visualise memory'] },
      { month:'September', theme:'programming depth: recursion and dynamic programming', weeks:[
        { range:'Wk 13-14', title:'Recursion and the call stack', description:'What actually happens in memory when a function calls itself? Implement factorial and Fibonacci recursively. Use Python Tutor to watch the call stack. When is recursion elegant, when is it dangerous?' },
        { range:'Wk 15-16', title:'Dynamic programming introduction', description:'Memoization: add caching to recursive Fibonacci. Measure performance for n=40 vs naive. Tabulation vs memoization. Solve 3-5 Project Euler problems combining CS and Maths.' }
      ], resources:['CS50 Week 4 — Memory','"Grokking Algorithms" Ch 9 — DP','projecteuler.net','LeetCode — Easy problems'] }
    ],
    projects: [
      { month:'June', title:'Binary calculator', subjects:['CS','Mathematics'], description:'Build a binary calculator in Python using only bit manipulation — no arithmetic operators. Implement addition using AND, OR, XOR, and left shift. Forces you to understand how a CPU\'s ALU actually works.', steps:['Understand binary addition by hand. Research half-adder and full adder circuits.','Implement a half-adder in Python using only bitwise operators. Test all 4 input combinations.','Build a full-adder. Chain 8 full-adders to make an 8-bit adder. Test thoroughly.','Implement binary subtraction using two\'s complement. Write a 300-word explanation of why computers use it.'], deliverable:'Working Python implementation + 300-word technical explanation' },
      { month:'July', title:'The physics of music', subjects:['Physics','Mathematics','English'], description:'Investigate the science of a musical instrument of your choice — how strings or air columns produce specific notes, what determines pitch and loudness. Connect Physics, Maths, and technical writing.', steps:['Research: how does a vibrating string produce a standing wave? What are harmonics and overtones?','Mathematics: using f × 2^(n/12), calculate every note in one octave starting from A4=440Hz. Graph it.','Comparison: compare sound production in two different instruments. What physical differences explain different timbres?','Write a 400-word scientific report with labelled diagram and frequency graph.'], deliverable:'400-word scientific report + frequency graph' },
      { month:'August', title:'Home lab: photosynthesis', subjects:['Biology','Chemistry','Mathematics'], description:'Design and conduct a real experiment testing how light intensity affects photosynthesis rate. Use the floating leaf disk method with spinach and sodium bicarbonate — inexpensive and genuinely works at home.', steps:['Design: write hypothesis, identify variables, write a method specific enough to replicate.','Conduct: run at 3-4 light distances. At least 3 repeated trials per condition. Record data properly.','Analyse: calculate averages, create a line graph, identify trends and anomalies. Does data support hypothesis?','Write full lab report: hypothesis, method, results (table + graph), conclusion, evaluation.'], deliverable:'Full scientific lab report' },
      { month:'September', title:'A voice from history', subjects:['English','History'], description:'Write a 500-word realistic fiction piece from the perspective of a young person your age during a major historical event from your syllabus. Historically accurate, using at least 3 literary techniques.', steps:['Research: choose one specific event. Research daily life for ordinary people, not leaders.','Outline: character, setting, conflict (internal/external), resolution.','First draft: write the complete story beginning to end without stopping to perfect.','Revise + 150-word author\'s note: which historical facts did you include? Which techniques did you use deliberately?'], deliverable:"500-word story + 150-word author's note" }
    ]
  };
}

/* ── Onboarding ────────────────────────────────────────── */
let obData = { grade:'Grade 8', hours:'1 hour', days:[], focus:[], style:'', coaching:'' };
let obReportFile = null, obSyllabusFile = null, obExistingFile = null;
let obHasExisting = false;
let obCurrentStep = 1;
const OB_TOTAL = 12;

function obProgress(step) {
  document.getElementById('ob-progress-fill').style.width = `${((step-1)/(OB_TOTAL-1))*100}%`;
}

function obGo(id) {
  document.querySelectorAll('.ob-step').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) { el.classList.add('active'); obCurrentStep = parseInt(id.replace('ob-s','')) || obCurrentStep; }
  obProgress(obCurrentStep);
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
    obCurrentStep = 11; obGo('ob-s11');
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

  // Step 8: coaching
  document.getElementById('ob-n8').addEventListener('click', () => {
    obData.coaching = document.getElementById('ob-coaching').value.trim();
    obCurrentStep = 9; obGo('ob-s9');
  });
  document.getElementById('ob-skip8').addEventListener('click', () => { obCurrentStep = 9; obGo('ob-s9'); });

  // Step 9: report card
  document.getElementById('ob-report-file').addEventListener('change', e => {
    obReportFile = e.target.files[0];
    if (obReportFile) document.getElementById('ob-report-name').textContent = obReportFile.name;
  });
  document.getElementById('ob-n9').addEventListener('click', () => { obCurrentStep = 10; obGo('ob-s10'); });
  document.getElementById('ob-skip9').addEventListener('click', () => { obReportFile = null; obCurrentStep = 10; obGo('ob-s10'); });

  // Step 10: syllabus
  document.getElementById('ob-syllabus-file').addEventListener('change', e => {
    obSyllabusFile = e.target.files[0];
    if (obSyllabusFile) document.getElementById('ob-syllabus-name').textContent = obSyllabusFile.name;
  });
  document.getElementById('ob-n10').addEventListener('click', () => { obCurrentStep = 11; obGo('ob-s11'); });
  document.getElementById('ob-skip10').addEventListener('click', () => { obSyllabusFile = null; obCurrentStep = 11; obGo('ob-s11'); });

  // Step 11: API key
  document.getElementById('ob-n11').addEventListener('click', () => kickoffGeneration());
  document.getElementById('ob-skip11').addEventListener('click', () => kickoffGeneration(true));
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
  };

  applyTheme('light');
  obCurrentStep = 12;
  obGo('ob-s12');

  const STEPS = ['reading documents','analysing your data','generating your plan','building cs roadmap','finishing up'];
  genStep(STEPS, 0);

  let existingText = '', reportText = '', syllabusText = '';

  if (!skipAI && apiKey) {
    if (obHasExisting && obExistingFile) {
      genStep(STEPS, 0);
      existingText = await extractDoc(obExistingFile, 'existing');
    }
    if (obReportFile) {
      genStep(STEPS, 0);
      reportText = await extractDoc(obReportFile, 'report');
    }
    if (obSyllabusFile) {
      genStep(STEPS, 1);
      syllabusText = await extractDoc(obSyllabusFile, 'syllabus');
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
    } catch(e) { console.error(e); }
    genStep(STEPS, 4);
  }

  if (!plan) plan = defaultPlan({ name });

  USER.plan = plan;
  USER.reportText = reportText;
  USER.syllabusText = syllabusText;
  S.set('mz', USER);

  document.getElementById('ob-gen-h').textContent = 'all done!';
  document.getElementById('ob-gen-sub').textContent = '';
  genStep(STEPS, 5);
  await new Promise(r => setTimeout(r, 600));
  launchApp();
}

/* ── App ───────────────────────────────────────────────── */
function launchApp() {
  document.getElementById('onboarding').style.display = 'none';
  document.getElementById('app').style.display = 'grid';
  applyTheme(USER.theme || 'light');
  document.getElementById('sidebar-greeting').textContent = `hey, ${USER.name.toLowerCase()}`;
  initTabs();
  initSession();
  initPlan();
  initCS();
  initProjects();
  initSettings();
  renderStreak();
  initCountdown();
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
function initCountdown() {
  const START = new Date('2026-06-01'), END = new Date('2026-09-26'), NOW = new Date();
  const total = END - START, left = Math.max(0, END - NOW), elapsed = Math.max(0, NOW - START);
  const days = Math.ceil(left / 86400000), weeks = (left / (7*86400000)).toFixed(1), pct = Math.min(100, Math.round((elapsed/total)*100));
  document.getElementById('cd-days').textContent = days;
  document.getElementById('cd-weeks').textContent = weeks;
  document.getElementById('cd-pct').textContent = pct;
  document.getElementById('cd-bar').style.width = pct + '%';
  document.getElementById('cd-meta').textContent = NOW < START ? `starts ${START.toLocaleDateString('en-IN',{day:'numeric',month:'long'})}` : NOW > END ? 'term 1 ended' : `ends ${END.toLocaleDateString('en-IN',{day:'numeric',month:'long'})}`;
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
const CIRC = 2*Math.PI*52;

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

  startBtn.addEventListener('click',()=>{
    if(tLeft===0)return;
    if(tRunning){clearInterval(tInterval);tRunning=false;startBtn.textContent='resume';}
    else{
      tRunning=true;startBtn.textContent='pause';
      tInterval=setInterval(()=>{
        tLeft--;
        document.getElementById('ring-time').textContent=fmt(tLeft);
        ringUpdate();
        if(tLeft===0){clearInterval(tInterval);tRunning=false;startBtn.textContent='start';logSession();alarm();}
      },1000);
    }
  });
  resetBtn.addEventListener('click',()=>{
    clearInterval(tInterval);tRunning=false;tLeft=tTotal;
    document.getElementById('ring-time').textContent=fmt(tLeft);
    document.getElementById('timer-start').textContent='start';
    ringUpdate();
  });
}

function logSession() {
  const lbl=document.getElementById('timer-label').value.trim()||'study session';
  const mins=Math.round(tTotal/60);
  const time=new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
  const el=document.getElementById('session-log');
  el.querySelector('.empty-state')?.remove();
  const e=document.createElement('div');e.className='log-entry';
  e.innerHTML=`<span class="log-check">✓</span><span>${lbl} <em style="color:var(--tx-3);font-size:0.65rem">(${mins}m)</em></span><span class="log-time">${time}</span>`;
  el.prepend(e);
}

/* ── Checklist ─────────────────────────────────────────── */
function initChecklist(dow, day) {
  const el = document.getElementById('task-list');
  const key = `mz-tasks-${new Date().toDateString()}`;
  const saved = S.get(key) || {};
  const tasks = day.subjects.flatMap(s => s.tasks.map(t => ({...t,_subj:s.name,_color:s.color})));

  el.innerHTML='';
  tasks.forEach((t,i)=>{
    t._i=i;
    const done=!!saved[i];
    const item=document.createElement('div');
    item.className='task-item'+(done?' done':'');
    item.dataset.i=i;
    const pill=t.mins?`<span class="task-pill">${t.mins}m</span>`:'';
    const ai=t.generateContent?`<span class="task-ai">✦</span>`:'';
    item.innerHTML=`<input type="checkbox"${done?' checked':''}/>
      <span class="task-text">${t.text}${pill}${ai}</span>
      <button class="task-arrow">›</button>`;

    item.querySelector('input').addEventListener('change',e=>{
      saved[i]=e.target.checked;
      S.set(key,saved);
      item.classList.toggle('done',e.target.checked);
      updateTaskBar(tasks.length,saved);
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
  const r=await groq([{role:'system',content:sys},{role:'user',content:msg}],180);
  if(r){el.textContent=r;chatHistory=[{role:'system',content:sys},{role:'user',content:msg},{role:'assistant',content:r}];}
  else el.innerHTML='<span style="font-size:0.72rem;color:var(--tx-3)">couldn\'t load — check api key in settings</span>';
}

async function fetchGen(task) {
  const el=document.getElementById('detail-gen');
  el.innerHTML='<span style="font-size:0.72rem;color:var(--tx-3);font-style:italic">generating…</span>';
  const prompt=`Generate educational content for: "${task.text}" (${task._subj}, Cambridge ${USER.grade||'Grade 8'}).
Student: ${USER.name}. Context: ${task.detail||''}
Format with ---HEADING--- sections. 3-4 sections. Relevant to task.
Use spoiler format for answers: ---ANSWERS--- or ---MARK SCHEME---
150-250 words total. Specific and actionable.`;
  const r=await groq([{role:'system',content:'Generate structured educational content. Format exactly with ---HEADING--- sections. No preamble.'},{role:'user',content:prompt}],500);
  if(r) el.innerHTML=parseGen(r);
  else el.innerHTML='<span style="font-size:0.72rem;color:var(--tx-3)">couldn\'t generate — check api key</span>';
}

function parseGen(raw) {
  const parts=raw.split(/---([^-\n]+)---/).filter(s=>s.trim());
  if(parts.length<2)return`<div class="gen-block"><div class="gen-body">${raw}</div></div>`;
  let html='';
  for(let i=0;i<parts.length-1;i+=2){
    const h=parts[i].trim(),b=parts[i+1].trim().replace(/\n/g,'<br>');
    const spoiler=/ANSWER|MARK SCHEME/i.test(h);
    html+=spoiler
      ?`<details class="gen-block"><summary>${h} <span style="font-size:0.6rem;color:var(--tx-3)">(reveal)</span></summary><div class="gen-body">${b}</div></details>`
      :`<div class="gen-block"><div class="gen-heading">${h}</div><div class="gen-body">${b}</div></div>`;
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
  const r=await groq(chatHistory,280);
  if(r){chatHistory.push({role:'assistant',content:r});lb.textContent=r;}
  else lb.innerHTML='<span style="color:var(--tx-3)">error — check api key</span>';
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
  tabsEl.innerHTML=dayKeys.map(k=>`<button class="day-tab${k==activeDow?' active':''}" data-day="${k}">${plan.days[k].name.slice(0,3).toLowerCase()}</button>`).join('');

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
      if(plan){USER.plan=plan;S.set('mz',USER);initPlan();initCS();initProjects();alert('Plan regenerated!');}
    }catch(e){console.error(e);}
    document.getElementById('regen-plan-btn').textContent='↻ regenerate';
  });
}

/* ── CS tab ────────────────────────────────────────────── */
function initCS(){
  const el=document.getElementById('cs-content');
  el.innerHTML=(USER.plan.csRoadmap||[]).map(m=>`
    <div class="cs-card">
      <div class="cs-card-head"><span class="cs-month">${m.month}</span><span class="cs-theme">${m.theme}</span></div>
      <div class="cs-weeks">${(m.weeks||[]).map(w=>`
        <div class="cs-week">
          <div class="cs-wk-num">${w.range}</div>
          <div><h4>${w.title}</h4><p>${w.description}</p></div>
        </div>`).join('')}
      </div>
      ${m.resources?.length?`<div class="cs-resources">${m.resources.map(r=>`<div class="cs-res">${r}</div>`).join('')}</div>`:''}
    </div>`).join('');
}

/* ── Projects tab ──────────────────────────────────────── */
function initProjects(){
  const el=document.getElementById('projects-content');
  el.innerHTML=(USER.plan.projects||[]).map(p=>`
    <div class="project-card">
      <div class="project-month">${p.month} · ${(p.subjects||[]).join(' + ')}</div>
      <h3 class="project-title">${p.title}</h3>
      <div class="project-subj-tags">${(p.subjects||[]).map(s=>`<span class="subj-chip" style="background:var(--a-m);color:var(--a)">${s}</span>`).join('')}</div>
      <p class="project-desc">${p.description}</p>
      <ol class="project-steps">${(p.steps||[]).map(s=>`<li>${s}</li>`).join('')}</ol>
      <div class="project-deliverable"><strong>deliverable:</strong> ${p.deliverable}</div>
    </div>`).join('');
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
    if(sReport)rt=await extractDoc(sReport,'report');
    if(sSyllabus)st=await extractDoc(sSyllabus,'syllabus');
    const plan=await generatePlan({name:USER.name,grade:USER.grade,hours:USER.hours,days:USER.days,focus:USER.focus,style:USER.style,coaching:USER.coaching},rt,st,'');
    if(plan){USER.plan=plan;USER.reportText=rt;USER.syllabusText=st;S.set('mz',USER);initPlan();initCS();initProjects();alert('Plan regenerated!');}
  });

  document.getElementById('s-reset').addEventListener('click',()=>{
    if(confirm('Reset everything? This cannot be undone.')){localStorage.clear();location.reload();}
  });
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
  const r=await groq([
    {role:'system',content:`Study coach for ${USER.name}. Warm, brief, genuine.`},
    {role:'user',content:`${USER.name} just completed every task for ${day.name}. Streak: ${st.current} day${st.current!==1?'s':''}. One sentence — genuine, specific to what they did, not generic.`}
  ],80);
  ai.textContent=r||'full day done — that\'s the habit being built.';
  document.getElementById('reward-close').addEventListener('click',()=>scrim.style.display='none',{once:true});
}

/* ── Boot ──────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded',()=>{
  const saved=S.get('mz');
  if(saved?.plan){
    USER=saved;
    applyTheme(USER.theme||'light');
    launchApp();
  } else {
    document.getElementById('onboarding').style.display='flex';
    applyTheme('light');
    initOnboarding();
  }
});
