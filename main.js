/* ═══════════════════════════════════════════════════════════════════════════
   MERIDIAN ZENITH — main.js
   Generic AI-powered study planner for Cambridge Middle School students
═══════════════════════════════════════════════════════════════════════════ */

/* ── Storage helpers ──────────────────────────────────────────────────────── */
const S = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: k => localStorage.removeItem(k),
};

/* ── State ────────────────────────────────────────────────────────────────── */
let USER = null;   // { name, apiKey, plan, reportCardText, syllabusText, theme }
let currentDetailTask = null;
let detailChatHistory = [];

/* ── Groq ─────────────────────────────────────────────────────────────────── */
const GROQ_MODEL = 'llama-3.1-8b-instant';

async function groq(messages, maxTokens = 800) {
  const key = USER?.apiKey;
  if (!key) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000); // 25s timeout
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: maxTokens, temperature: 0.75 }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) { const e = await res.json().catch(()=>{}); console.error('Groq:', res.status, e); return null; }
    return (await res.json()).choices?.[0]?.message?.content || null;
  } catch(e) { console.error(e); return null; }
}

/* ── File → base64 ────────────────────────────────────────────────────────── */
async function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

/* ── Extract text from uploaded file ──────────────────────────────────────── */
async function extractFileText(file, docType) {
  if (!file) return '';

  // For images: send to Groq vision via llama-3.2-11b-vision
  if (file.type.startsWith('image/')) {
    const b64 = await fileToBase64(file);
    const prompt = docType === 'report'
      ? 'Extract all academic information from this report card image. List every subject with its score, grade, and any teacher comments.'
      : 'Extract all academic content from this syllabus/course planner image. List subjects, units, topics, and dates.';
    const key = USER?.apiKey;
    if (!key) return '';
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${file.type};base64,${b64}` } }
          ]}],
          max_tokens: 1200
        })
      });
      if (!res.ok) return '';
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    } catch(e) { return ''; }
  }

  // For PDFs: extract text using FileReader as text (works for text-based PDFs)
  // Fall back to asking user to describe their data
  return '';
}

/* ── Generate personalised study plan ────────────────────────────────────── */
async function generatePlan(name, reportText, syllabusText, prefs = {}) {
  const prompt = `You are an expert educational coach creating a personalised weekly self-study plan for a Cambridge middle school student.

STUDENT NAME: ${name}

${reportText ? `REPORT CARD DATA:\n${reportText}\n` : 'No report card provided — create a balanced general plan.'}

${syllabusText ? `SYLLABUS/COURSE PLANNER:\n${syllabusText}\n` : 'No syllabus provided — use standard Cambridge Grade 8 curriculum.'}

Create a detailed 6-day weekly self-study plan (Monday to Saturday, no Sunday). Each day should have 2-3 subjects with specific tasks.

Respond ONLY with valid JSON in this exact format:
{
  "summary": "2-3 sentence personalised summary of the student's strengths, weaknesses, and focus areas based on their data",
  "days": {
    "1": {
      "name": "Monday",
      "subjects": [
        {
          "name": "Subject Name",
          "color": "#hex color for chip background",
          "duration": "X min",
          "tasks": [
            {
              "text": "Specific task description",
              "mins": 15,
              "detail": "Detailed explanation of how to do this task well",
              "generateContent": true or false
            }
          ]
        }
      ]
    },
    "2": { ... },
    "3": { ... },
    "4": { ... },
    "5": { ... },
    "6": { "name": "Saturday", "subjects": [{ "name": "Project", ... }] }
  },
  "csRoadmap": [
    { "month": "Month Name", "theme": "theme description", "weeks": [
      { "range": "Wk 1-2", "title": "Topic title", "description": "What to learn and do" }
    ], "resources": ["resource 1", "resource 2"] }
  ],
  "projects": [
    { "month": "Month", "title": "Project title", "subjects": ["Subject1", "Subject2"], "description": "What the project involves", "steps": ["Step 1", "Step 2", "Step 3", "Step 4"], "deliverable": "What they produce" }
  ]
}

Rules:
- Base priorities on actual weak subjects (low scores) from the report card
- Reference actual topics from the syllabus where provided
- Make tasks specific and actionable, not vague
- generateContent: true for tasks where AI should generate fresh content each session (reading extracts, practice problems, exercises)
- Include 4 months in csRoadmap (the advanced self-study CS curriculum)
- Include 4 monthly projects
- Colors should be soft pastels that work on light backgrounds
- Every task should have a detail field with genuine pedagogical advice`;

  const reply = await groq([
    { role: 'system', content: 'You are an educational planning expert. Always respond with valid JSON only. No markdown, no explanation, just the JSON object.' },
    { role: 'user', content: prompt }
  ], 2500);

  if (!reply) return null;
  try {
    const clean = reply.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(clean);
  } catch(e) { console.error('Plan parse error:', e, reply?.slice(0, 200)); return null; }
}

/* ── Onboarding ───────────────────────────────────────────────────────────── */
let obStep = 1;
const TOTAL_OB_STEPS = 11;
let obReportFile = null;
let obSyllabusFile = null;
let obData = { grade: '', hours: '', days: [], focusAreas: [], studyStyle: '', coaching: '' };

function setObStep(n) {
  document.querySelectorAll('.ob-step').forEach(s => s.classList.remove('active'));
  document.getElementById(`ob-step-${n}`)?.classList.add('active');
  obStep = n;
  const prog = document.getElementById('ob-prog-bar');
  if (prog) prog.style.width = `${((n - 1) / (TOTAL_OB_STEPS - 1)) * 100}%`;
}

function initChipGroup(containerSelector, multiSelect, onSelect) {
  document.querySelectorAll(containerSelector).forEach(btn => {
    btn.addEventListener('click', () => {
      if (multiSelect) {
        btn.classList.toggle('selected');
      } else {
        document.querySelectorAll(containerSelector).forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      }
      if (onSelect) onSelect();
    });
  });
}

function getSelectedChips(containerSelector) {
  return [...document.querySelectorAll(`${containerSelector}.selected`)].map(b => b.dataset.val);
}

function initOnboarding() {
  // Step 1: name
  document.getElementById('ob-next-1').addEventListener('click', () => {
    const name = document.getElementById('ob-name').value.trim();
    if (!name) { document.getElementById('ob-name').focus(); return; }
    setObStep(2);
  });
  document.getElementById('ob-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('ob-next-1').click();
  });

  // Step 2: grade
  initChipGroup('#ob-grade-grid .ob-chip', false);
  document.getElementById('ob-next-2').addEventListener('click', () => {
    const sel = getSelectedChips('#ob-grade-grid .ob-chip');
    obData.grade = sel[0] || 'Grade 8';
    setObStep(3);
  });

  // Step 3: study hours
  initChipGroup('.ob-step#ob-step-3 .ob-chip', false);
  document.getElementById('ob-next-3').addEventListener('click', () => {
    const sel = getSelectedChips('.ob-step#ob-step-3 .ob-chip');
    const custom = document.getElementById('ob-hours-custom').value.trim();
    obData.hours = custom || sel[0] || '1 hour';
    setObStep(4);
  });

  // Step 4: study days (multi)
  initChipGroup('.ob-step#ob-step-4 .ob-chip-toggle', true);
  document.getElementById('ob-next-4').addEventListener('click', () => {
    const sel = getSelectedChips('.ob-step#ob-step-4 .ob-chip-toggle');
    obData.days = sel.length ? sel : ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    setObStep(5);
  });

  // Step 5: focus areas (multi)
  initChipGroup('.ob-step#ob-step-5 .ob-chip-toggle', true);
  document.getElementById('ob-next-5').addEventListener('click', () => {
    obData.focusAreas = getSelectedChips('.ob-step#ob-step-5 .ob-chip-toggle');
    setObStep(6);
  });

  // Step 6: study style
  initChipGroup('.ob-step#ob-step-6 .ob-chip', false);
  document.getElementById('ob-next-6').addEventListener('click', () => {
    const sel = getSelectedChips('.ob-step#ob-step-6 .ob-chip');
    obData.studyStyle = sel[0] || 'mixed';
    setObStep(7);
  });

  // Step 7: coaching
  document.getElementById('ob-next-7').addEventListener('click', () => {
    obData.coaching = document.getElementById('ob-coaching').value.trim();
    setObStep(8);
  });
  document.getElementById('ob-skip-7').addEventListener('click', () => { obData.coaching = ''; setObStep(8); });

  // Step 8: report card
  document.getElementById('ob-report').addEventListener('change', e => {
    obReportFile = e.target.files[0];
    if (obReportFile) document.getElementById('ob-report-name').textContent = obReportFile.name;
  });
  document.getElementById('ob-next-8').addEventListener('click', () => setObStep(9));
  document.getElementById('ob-skip-8').addEventListener('click', () => { obReportFile = null; setObStep(9); });

  // Step 9: syllabus
  document.getElementById('ob-syllabus').addEventListener('change', e => {
    obSyllabusFile = e.target.files[0];
    if (obSyllabusFile) document.getElementById('ob-syllabus-name').textContent = obSyllabusFile.name;
  });
  document.getElementById('ob-next-9').addEventListener('click', () => setObStep(10));
  document.getElementById('ob-skip-9').addEventListener('click', () => { obSyllabusFile = null; setObStep(10); });

  // Step 10: API key
  document.getElementById('ob-next-10').addEventListener('click', () => startGeneration());
  document.getElementById('ob-skip-10').addEventListener('click', () => startGeneration(true));
}

function showGenStep(steps, activeIdx) {
  const el = document.getElementById('ob-gen-steps');
  if (!el) return;
  el.innerHTML = steps.map((s, i) => {
    const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    return `<div class="ob-gen-step ${cls}"><div class="ob-gen-dot"></div>${s}</div>`;
  }).join('');
}

async function startGeneration(skipAI = false) {
  const name = document.getElementById('ob-name').value.trim() || 'Student';
  const apiKey = document.getElementById('ob-apikey').value.trim();

  USER = {
    name,
    apiKey: skipAI ? '' : apiKey,
    theme: 'light',
    grade: obData.grade || 'Grade 8',
    hoursPerDay: obData.hours || '1 hour',
    studyDays: obData.days.length ? obData.days : ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
    focusAreas: obData.focusAreas,
    studyStyle: obData.studyStyle || 'mixed',
    coaching: obData.coaching,
  };

  applyTheme('light');
  setObStep(11);

  const GEN_STEPS = [
    'reading report card',
    'reading syllabus',
    'analysing your data',
    'generating your plan',
    'building cs roadmap',
    'finalising',
  ];

  const updateGen = (title, sub) => {
    document.getElementById('ob-gen-title').textContent = title;
    document.getElementById('ob-gen-sub').textContent = sub;
  };

  showGenStep(GEN_STEPS, 0);
  let reportText = '';
  let syllabusText = '';

  if (!skipAI && apiKey && obReportFile) {
    reportText = await extractFileText(obReportFile, 'report');
  }
  showGenStep(GEN_STEPS, 1);

  if (!skipAI && apiKey && obSyllabusFile) {
    syllabusText = await extractFileText(obSyllabusFile, 'syllabus');
  }
  showGenStep(GEN_STEPS, 2);

  let plan = null;
  if (!skipAI && apiKey) {
    updateGen(`building ${name}'s plan…`, 'this takes about 15 seconds');
    showGenStep(GEN_STEPS, 3);
    try {
      plan = await generatePlan(name, reportText, syllabusText, USER);
    } catch(e) { console.error('Plan gen failed:', e); }
    showGenStep(GEN_STEPS, 5);
  }

  if (!plan) {
    updateGen('setting up your plan…', 'using our Cambridge template');
    plan = getDefaultPlan(name);
  }

  USER.plan = plan;
  USER.reportCardText = reportText;
  USER.syllabusText = syllabusText;
  S.set('mz-user', USER);

  updateGen('all done!', '');
  showGenStep(GEN_STEPS, 6);
  await new Promise(r => setTimeout(r, 700));
  launchApp();
}

/* ── Default plan (fallback if no AI / no key) ────────────────────────────── */
function getDefaultPlan(name) {
  return {
    summary: `Welcome, ${name}! Your personalised plan covers all core Cambridge subjects with daily 1-hour self-study sessions. Focus areas are built around common Grade 8 challenge points — analytical writing, science depth, and mathematical reasoning.`,
    days: {
      1: { name: 'Monday', subjects: [
        { name: 'English', color: '#FDE8D8', duration: '25 min', tasks: [
          { text: 'Read one literary text not in your curriculum', mins: 15, detail: 'Choose a short story, essay, or poem 1-2 levels above class. Read slowly, annotate, and ask: what technique is the writer using?', generateContent: true },
          { text: 'Write 5-8 lines of analytical response', mins: 10, detail: 'What is this text really about beneath the surface? Don\'t summarise — analyse the craft.' }
        ]},
        { name: 'History', color: '#F0E8D4', duration: '35 min', tasks: [
          { text: 'Find one primary source on this week\'s topic', mins: 15, detail: 'Wikisource has free primary documents. Read slowly. Ask: who wrote this, when, and why does their position matter?' },
          { text: 'Write OPCVL analysis', mins: 10, detail: 'Origin, Purpose, Content, Value, Limitation. What does this source tell us as evidence? Why might it be incomplete?' },
          { text: 'Connect source to the bigger historical argument', mins: 10, detail: 'How does this source fit the main historical narrative? Does it support or challenge the dominant explanation?' }
        ]}
      ]},
      2: { name: 'Tuesday', subjects: [
        { name: 'Mathematics', color: '#E0F0FF', duration: '35 min', tasks: [
          { text: 'Attempt 2-3 harder problems without examples', mins: 10, detail: 'Struggle productively — 5 minutes of real struggle before seeking a hint is how learning happens.', generateContent: true },
          { text: 'Prove why one rule from this week works', mins: 15, detail: 'Don\'t accept rules without understanding. Example: why does a negative index give a reciprocal? Prove it from the pattern.' },
          { text: 'Find a second more elegant solution', mins: 10, detail: 'After solving one way, ask: is there a shorter path? Finding a second method deepens understanding more than two new problems.' }
        ]},
        { name: 'Physics', color: '#E8E0F8', duration: '25 min', tasks: [
          { text: 'Solve today\'s physics problems', mins: 25, detail: 'Read every question TWICE before touching a pen. Explain the physical principle before calculating.', generateContent: true }
        ]}
      ]},
      3: { name: 'Wednesday', subjects: [
        { name: 'CS', color: '#DCF4E8', duration: '35 min', tasks: [
          { text: 'Write a 3-sentence summary from memory', mins: 5, detail: 'Close all notes. Write 3 sentences explaining last session\'s concept from memory. If you can\'t, go back before moving on.' },
          { text: 'Work through this week\'s CS topic', mins: 20, detail: 'Trace the algorithm on paper first, then code. Never copy — type from your understanding.', generateContent: true },
          { text: 'CS trace: algorithm by hand on paper', mins: 10, detail: 'No code. Paper, step by step, 5-6 elements. Understanding logic before code is what makes debugging easy.' }
        ]},
        { name: 'Chemistry', color: '#FDE8EE', duration: '25 min', tasks: [
          { text: 'Work through today\'s chemistry topic', mins: 15, detail: 'Read every question TWICE. Underline the command word. Answer only what it asks.', generateContent: true },
          { text: 'Attempt one past paper question', mins: 10, detail: 'Use command words: describe (what happens), explain (why), compare (both similarities AND differences).' }
        ]}
      ]},
      4: { name: 'Thursday', subjects: [
        { name: 'Biology', color: '#E0F4EC', duration: '30 min', tasks: [
          { text: 'Go one level deeper than the textbook', mins: 15, detail: 'For photosynthesis: what actually happens in the light-dependent stage? A-level content is accessible at Grade 8 if explained well.', generateContent: true },
          { text: 'Draw and label full diagram from memory', mins: 10, detail: 'No looking. Draw from scratch. Mark every gap in red. Gaps = spend 5 min on precisely those.' },
          { text: 'Find one real-world research connection', mins: 5, detail: 'Science Daily or BBC Science. Find one article connected to this week\'s topic. Write one sentence on what it adds.' }
        ]},
        { name: 'Geography', color: '#E8F4DC', duration: '30 min', tasks: [
          { text: 'Find one current news story on this week\'s topic', mins: 10, detail: 'Write 3-4 sentences arguing a position — not just describing. Use geographical terminology.' },
          { text: 'Draw country/region outline from memory', mins: 10, detail: 'No atlas. Draw the outline, mark physical features relevant to this week\'s topic. Check accuracy after.' },
          { text: 'Connection journal: link Biology to Geography', mins: 10, detail: 'Push beyond the obvious. These cross-subject connections appear in top-grade exam responses.' }
        ]}
      ]},
      5: { name: 'Friday', subjects: [
        { name: 'French', color: '#E0EEF8', duration: '25 min', tasks: [
          { text: 'Today\'s listening and immersion task', mins: 10, detail: 'TV5Monde, Coffee Break French, or InnerFrench podcast. Authentic exposure to real French is irreplaceable.', generateContent: true },
          { text: 'Write 6-8 original sentences using this week\'s tense', mins: 10, detail: 'Original sentences from your own thinking, not translations. One sophisticated sentence beats three simple ones.' },
          { text: 'Go deep on one grammar rule', mins: 5, detail: 'The logic behind grammar rules is more memorable than rote learning. Why does it work this way?' }
        ]},
        { name: 'CS', color: '#DCF4E8', duration: '35 min', tasks: [
          { text: 'Build and time this week\'s CS implementation', mins: 20, detail: 'Implement, then time on arrays of 10/100/1000. Does timing match Big-O theory?', generateContent: true },
          { text: 'Ask "why does this work?" one level deeper', mins: 10, detail: 'For binary search: why must the array be sorted? Understanding preconditions separates good programmers.' },
          { text: 'Set 3 specific measurable goals for next week', mins: 5, detail: 'Not "do better" but "implement selection sort and time it on 3 array sizes." Goals without specificity are wishes.' }
        ]}
      ]},
      6: { name: 'Saturday', subjects: [
        { name: 'Project', color: '#EDF5E9', duration: '60 min', tasks: [
          { text: 'Re-read project brief — what is today\'s specific deliverable?', mins: 5, detail: 'Don\'t start until you can answer in one sentence: "By the end of today I will have..."' },
          { text: 'First 25-min work block: substance only', mins: 25, detail: 'Resist polishing before it\'s good. First two Saturdays: build. Last two: refine.' },
          { text: '5-min break', mins: 5, detail: 'Actually stop. The break is part of the method.' },
          { text: 'Second 25-min work block: continue building', mins: 25, detail: 'Push through to completion of today\'s deliverable.' },
          { text: 'Write 2 sentences: what you did + next Saturday\'s step', mins: 5, detail: 'Prevents starting from zero each week. Be specific.' }
        ]}
      ]}
    },
    csRoadmap: [
      { month: 'June', theme: 'how computers actually work', weeks: [
        { range: 'Wk 1-2', title: 'Binary and data representation', description: 'Number systems from first principles — why binary? How integers, text (ASCII/Unicode), and colours (RGB) are stored. Convert manually: decimal ↔ binary ↔ hexadecimal. Implement a converter in Python.' },
        { range: 'Wk 3-4', title: 'Logic gates and Boolean algebra', description: 'AND, OR, NOT, NAND, NOR, XOR — understand as physical gates. Boolean algebra: simplify using De Morgan\'s laws. Build truth tables. Show how a half-adder is built from logic gates.' }
      ], resources: ['CS50 Week 0 by Harvard (free)', 'Ben Eater on YouTube — "Building an 8-bit computer"', 'nand2tetris.org'] },
      { month: 'July', theme: 'algorithms: the science of solving problems efficiently', weeks: [
        { range: 'Wk 5-6', title: 'Sorting algorithms', description: 'Implement bubble sort, selection sort, and insertion sort from scratch — no built-in sort. For each: trace on paper first, then code, then count comparisons and swaps.' },
        { range: 'Wk 7-8', title: 'Searching and Big-O', description: 'Linear search vs binary search. Implement both, time them on arrays of 100/1000/10000. Plot results. Introduce Big-O notation intuitively: O(n) vs O(log n).' }
      ], resources: ['"Grokking Algorithms" by Aditya Bhargava — Ch 1-4', 'CS50 Week 3 — Algorithms', 'Visualgo.net — algorithm animations'] },
      { month: 'August', theme: 'data structures: organising information', weeks: [
        { range: 'Wk 9-10', title: 'Arrays, linked lists, stacks, queues', description: 'Why is array random access O(1) but insertion O(n)? Implement a stack (LIFO) and queue (FIFO). Use your stack to check for balanced parentheses.' },
        { range: 'Wk 11-12', title: 'Hash tables and trees', description: 'How does Python\'s dictionary achieve O(1) lookup? What is a hash function? Binary search trees — implement insert and search.' }
      ], resources: ['"Grokking Algorithms" Ch 5 and 7', 'CS50 Week 5 — Data Structures', 'Python Tutor — pythontutor.com'] },
      { month: 'September', theme: 'programming depth: recursion and dynamic programming', weeks: [
        { range: 'Wk 13-14', title: 'Recursion and the call stack', description: 'What happens in memory when a function calls itself? Implement factorial and Fibonacci recursively. Use Python Tutor to watch the call stack grow and shrink.' },
        { range: 'Wk 15-16', title: 'Dynamic programming introduction', description: 'Memoization: add caching to recursive Fibonacci. Measure performance for n=40 vs naive. Solve 3-5 Project Euler problems.' }
      ], resources: ['CS50 Week 4 — Memory', '"Grokking Algorithms" Ch 9 — Dynamic Programming', 'projecteuler.net'] }
    ],
    projects: [
      { month: 'June', title: 'Binary calculator', subjects: ['CS', 'Mathematics'], description: 'Build a binary calculator in Python using only bit manipulation — no arithmetic operators. Implement addition using AND, OR, XOR, and left shift. Forces you to understand how a CPU\'s ALU actually works.', steps: ['Understand binary addition by hand. Research half-adder and full adder.', 'Implement a half-adder in Python using only bitwise operators. Test all 4 input combinations.', 'Build a full-adder. Chain 8 full-adders to make an 8-bit adder. Test.', 'Implement binary subtraction using two\'s complement. Write 300-word explanation.'], deliverable: 'Working Python implementation + 300-word technical explanation' },
      { month: 'July', title: 'The physics of music', subjects: ['Physics', 'Mathematics', 'English'], description: 'Investigate the science of a musical instrument — how strings/air columns produce specific notes, what determines pitch and loudness. Choose any instrument you know.', steps: ['Research: how does a vibrating string produce a standing wave? What are harmonics?', 'Mathematics: A4 = 440Hz. Calculate every note in one octave using f × 2^(n/12). Graph it.', 'Comparison: compare sound production in two different instruments.', 'Write a 400-word scientific report with labelled diagram and frequency graph.'], deliverable: '400-word scientific report + frequency graph' },
      { month: 'August', title: 'Home lab: photosynthesis and light', subjects: ['Biology', 'Chemistry', 'Mathematics'], description: 'Design and conduct a real experiment testing how light intensity affects photosynthesis rate. Use the floating leaf disk method with spinach and sodium bicarbonate.', steps: ['Design: write hypothesis, identify variables, write a replicable method.', 'Conduct: run at 3-4 light distances. At least 3 repeated trials per condition.', 'Analyse: calculate averages, create line graph, identify trends and anomalies.', 'Write full lab report: hypothesis, method, results, conclusion, evaluation.'], deliverable: 'Full scientific lab report' },
      { month: 'September', title: 'A voice from history', subjects: ['English', 'History'], description: 'Write a 500-word realistic fiction piece from the perspective of a young person your age during a major historical event from your syllabus. Historically accurate, using literary techniques.', steps: ['Research: choose one specific historical event. Research daily life for ordinary people, not leaders.', 'Outline: character, setting, conflict, resolution.', 'First draft: write complete story beginning to end without stopping to perfect.', 'Revise + 150-word author\'s note explaining historical facts and literary techniques used.'], deliverable: '500-word story + 150-word author\'s note' }
    ]
  };
}

/* ── App init ─────────────────────────────────────────────────────────────── */
function launchApp() {
  document.getElementById('onboarding').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  applyTheme(USER.theme || 'light');
  document.getElementById('header-greeting').textContent = `hey, ${USER.name.toLowerCase()}`;
  initTabs();
  initSession();
  initPlan();
  initCSRoadmap();
  initProjects();
  initSettings();
  renderStreak();
  initCountdown();
}

/* ── Theme ────────────────────────────────────────────────────────────────── */
function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  if (USER) { USER.theme = theme; S.set('mz-user', USER); }
  document.querySelectorAll('.theme-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.theme === theme);
  });
}

/* ── Tabs ─────────────────────────────────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');
      btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
  });
}

/* ── Session: Today card ─────────────────────────────────────────────────── */
function initSession() {
  const now = new Date();
  let dow = now.getDay();
  if (dow === 0) dow = 1; // Sunday → show Monday
  const day = USER.plan.days[dow] || USER.plan.days[1];

  document.getElementById('today-day-name').textContent = day.name.toLowerCase();
  document.getElementById('today-date').textContent = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  const subjEl = document.getElementById('today-subjects');
  subjEl.innerHTML = day.subjects.map(s => `
    <div class="today-subject-row">
      <span class="subject-chip" style="background:${s.color};color:#333">${s.name}</span>
      <span style="font-size:0.72rem;color:var(--text-muted);font-family:'DM Mono',monospace">${s.duration}</span>
    </div>
  `).join('');

  document.getElementById('go-today-btn').addEventListener('click', () => {
    document.querySelector('[data-tab="plan"]').click();
    setTimeout(() => {
      document.querySelector(`.day-tab[data-day="${dow}"]`)?.click();
    }, 100);
  });

  initTimer();
  initChecklist(dow, day);
  initDetailCard();
  initMusic();
}

/* ── Countdown ────────────────────────────────────────────────────────────── */
function initCountdown() {
  const TERM_START = new Date('2026-06-01');
  const TERM_END   = new Date('2026-09-26');
  const now        = new Date();
  const totalMs    = TERM_END - TERM_START;
  const leftMs     = Math.max(0, TERM_END - now);
  const elapsedMs  = Math.max(0, now - TERM_START);
  const daysLeft   = Math.ceil(leftMs / 86400000);
  const weeksLeft  = (leftMs / (7 * 86400000)).toFixed(1);
  const pct        = Math.min(100, Math.round((elapsedMs / totalMs) * 100));

  document.getElementById('cd-days').textContent  = daysLeft;
  document.getElementById('cd-weeks').textContent = weeksLeft;
  document.getElementById('cd-pct').textContent   = pct;
  document.getElementById('cd-bar').style.width   = pct + '%';
  document.getElementById('cd-meta').textContent  =
    now < TERM_START ? `starts ${TERM_START.toLocaleDateString('en-IN', { day:'numeric', month:'long' })}`
    : now > TERM_END ? 'term 1 ended'
    : `ends ${TERM_END.toLocaleDateString('en-IN', { day:'numeric', month:'long' })}`;
}

/* ── Streak ───────────────────────────────────────────────────────────────── */
function getStreak() { return S.get('mz-streak') || { days: [], current: 0, best: 0 }; }

function markDayComplete() {
  const streak = getStreak();
  const today  = new Date().toDateString();
  if (streak.days.includes(today)) return;
  streak.days.push(today);
  let count = 0;
  const d = new Date();
  while (streak.days.includes(d.toDateString())) { count++; d.setDate(d.getDate() - 1); }
  streak.current = count;
  streak.best = Math.max(streak.best || 0, count);
  S.set('mz-streak', streak);
  renderStreak();
}

function renderStreak() {
  const el = document.getElementById('streak-display');
  if (!el) return;
  const streak = getStreak();
  const lit = streak.days.includes(new Date().toDateString());
  el.innerHTML = `<span class="flame ${lit ? 'lit' : ''}">🔥</span><span class="streak-num-sm">${streak.current}</span><span style="font-size:0.7rem;color:var(--text-muted)">day streak</span>`;
}

/* ── Timer ────────────────────────────────────────────────────────────────── */
let timerInterval = null, timerTotal = 15*60, timerRemaining = 15*60, timerRunning = false;
const CIRC = 2 * Math.PI * 52;

function fmtTime(s) { return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`; }

function updateRing() {
  const prog = document.getElementById('timer-ring-prog');
  if (!prog) return;
  prog.style.strokeDashoffset = CIRC * (1 - timerRemaining / timerTotal);
  prog.classList.toggle('done', timerRemaining === 0);
}

function setTimer(mins, label) {
  clearInterval(timerInterval);
  timerRunning = false;
  timerTotal = timerRemaining = mins * 60;
  document.getElementById('timer-display').textContent = fmtTime(timerRemaining);
  document.getElementById('timer-start').textContent = 'start';
  updateRing();
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.mins) === mins));
  const ci = document.getElementById('custom-mins');
  if (![15,25,30,60].includes(mins)) {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-mins="0"]').classList.add('active');
    ci.style.display = 'block'; ci.value = mins;
  } else { ci.style.display = 'none'; }
  if (label) document.getElementById('timer-subject').value = label;
  const card = document.querySelector('.timer-card');
  if (card) { card.style.boxShadow = `0 0 0 2px var(--accent)`; setTimeout(() => { card.style.boxShadow = ''; }, 500); }
}

function playAlarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.3, 0.6].forEach((t, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = [660,880,1100][i];
      gain.gain.setValueAtTime(0.35, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.28);
      osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.3);
    });
  } catch(e) {}
}

function initTimer() {
  const startBtn = document.getElementById('timer-start');
  const resetBtn = document.getElementById('timer-reset');
  const display  = document.getElementById('timer-display');
  const ci       = document.getElementById('custom-mins');

  document.getElementById('timer-ring-prog').style.strokeDasharray = CIRC;
  updateRing();

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mins = parseInt(btn.dataset.mins);
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (mins === 0) { ci.style.display = 'block'; ci.focus(); }
      else { ci.style.display = 'none'; setTimer(mins); }
    });
  });
  ci.addEventListener('change', () => { const v = parseInt(ci.value); if (v > 0) setTimer(v); });

  startBtn.addEventListener('click', () => {
    if (timerRemaining === 0) return;
    if (timerRunning) {
      clearInterval(timerInterval); timerRunning = false; startBtn.textContent = 'resume';
    } else {
      timerRunning = true; startBtn.textContent = 'pause';
      timerInterval = setInterval(() => {
        timerRemaining--;
        display.textContent = fmtTime(timerRemaining);
        updateRing();
        if (timerRemaining === 0) {
          clearInterval(timerInterval); timerRunning = false;
          startBtn.textContent = 'start';
          logSession(); playAlarm();
        }
      }, 1000);
    }
  });

  resetBtn.addEventListener('click', () => {
    clearInterval(timerInterval); timerRunning = false;
    timerRemaining = timerTotal;
    display.textContent = fmtTime(timerRemaining);
    startBtn.textContent = 'start';
    updateRing();
  });
}

function logSession() {
  const subject = document.getElementById('timer-subject').value.trim() || 'study session';
  const mins = Math.round(timerTotal / 60);
  const time = new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
  const el = document.getElementById('session-log-entries');
  el.querySelector('.log-empty')?.remove();
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-check">✓</span><span>${subject} <em style="color:var(--text-muted);font-size:0.7rem">(${mins}m)</em></span><span class="log-time">${time}</span>`;
  el.prepend(entry);
}

/* ── Checklist ────────────────────────────────────────────────────────────── */
function initChecklist(dow, day) {
  const el = document.getElementById('task-checklist');
  const key = `mz-tasks-${new Date().toDateString()}`;
  const saved = S.get(key) || {};
  const allTasks = day.subjects.flatMap(s => s.tasks.map(t => ({ ...t, subject: s.name, color: s.color })));

  el.innerHTML = '';
  allTasks.forEach((task, i) => {
    task._idx = i;
    const checked = !!saved[i];
    const item = document.createElement('div');
    item.className = 'checklist-item' + (checked ? ' checked' : '');
    item.dataset.idx = i;

    const timePill = task.mins ? `<span class="task-time-pill">${task.mins}m</span>` : '';
    const aiDot    = task.generateContent ? `<span class="task-ai-dot">✦</span>` : '';

    item.innerHTML = `
      <input type="checkbox" ${checked ? 'checked' : ''} />
      <span class="checklist-text">${task.text}${timePill}${aiDot}</span>
      <button class="task-arrow">›</button>
    `;

    item.querySelector('input').addEventListener('change', e => {
      saved[i] = e.target.checked;
      S.set(key, saved);
      item.classList.toggle('checked', e.target.checked);
      updateProgress(allTasks.length, saved);
      if (Object.values(saved).filter(Boolean).length === allTasks.length) {
        const shownKey = `mz-reward-${new Date().toDateString()}`;
        if (!S.get(shownKey)) { S.set(shownKey, true); markDayComplete(); showReward(day); }
      }
    });

    item.querySelector('.checklist-text').addEventListener('click', () => openDetail(task));
    item.querySelector('.task-arrow').addEventListener('click', () => openDetail(task));
    el.appendChild(item);
  });

  updateProgress(allTasks.length, saved);

  document.getElementById('reset-tasks-btn').addEventListener('click', () => {
    S.del(`mz-tasks-${new Date().toDateString()}`);
    initChecklist(dow, day);
    document.getElementById('detail-content').style.display = 'none';
    document.getElementById('detail-empty').style.display = 'flex';
  });
}

function updateProgress(total, saved) {
  const done = Object.values(saved).filter(Boolean).length;
  document.getElementById('progress-bar-fill').style.width = `${total ? (done/total)*100 : 0}%`;
  document.getElementById('progress-summary').textContent = `${done} / ${total}`;
}

/* ── Detail card ──────────────────────────────────────────────────────────── */
function initDetailCard() {
  document.getElementById('detail-timer-btn').addEventListener('click', () => {
    if (currentDetailTask?.mins) setTimer(currentDetailTask.mins, currentDetailTask.text);
  });
  document.getElementById('detail-tip-refresh').addEventListener('click', () => {
    if (currentDetailTask) fetchTip(currentDetailTask);
  });
  document.getElementById('detail-gen-refresh').addEventListener('click', () => {
    if (currentDetailTask) fetchGeneratedContent(currentDetailTask);
  });
  document.getElementById('detail-chat-send').addEventListener('click', sendChat);
  document.getElementById('detail-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  document.getElementById('detail-goto-settings').addEventListener('click', () => openSettings());
}

function openDetail(task) {
  currentDetailTask = task;
  detailChatHistory = [];

  // Highlight selected
  document.querySelectorAll('.checklist-item').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.idx) === task._idx);
  });

  document.getElementById('detail-empty').style.display = 'none';
  document.getElementById('detail-content').style.display = 'flex';

  // Subject tag
  const tagEl = document.getElementById('detail-subject-tag');
  tagEl.textContent = task.subject || '';
  tagEl.style.background = task.color || '#E0E0E0';
  tagEl.style.color = '#333';

  document.getElementById('detail-time').textContent = task.mins ? `⏱ ${task.mins} min` : '';
  document.getElementById('detail-title').textContent = task.text;

  const bodyEl = document.getElementById('detail-body');
  if (task.detail) { bodyEl.textContent = task.detail; bodyEl.style.display = 'block'; }
  else { bodyEl.style.display = 'none'; }

  // Timer button
  const timerBtn = document.getElementById('detail-timer-btn');
  timerBtn.style.display = task.mins ? 'block' : 'none';
  if (task.mins) timerBtn.textContent = `▶ set ${task.mins} min timer & start`;

  // Generated content
  const genSection = document.getElementById('detail-gen-section');
  const genContent = document.getElementById('detail-gen-content');
  if (task.generateContent) {
    genSection.style.display = 'flex';
    genContent.innerHTML = '<span class="ai-loading">tap ↻ to generate content…</span>';
    if (USER.apiKey) fetchGeneratedContent(task);
  } else {
    genSection.style.display = 'none';
  }

  // AI tip
  const aiSection = document.getElementById('detail-ai-section');
  const keySection = document.getElementById('detail-key-section');
  const chatHistory = document.getElementById('detail-chat-history');
  const chatInput = document.getElementById('detail-chat-input');
  chatHistory.innerHTML = '';
  chatInput.value = '';

  if (USER.apiKey) {
    aiSection.style.display = 'flex';
    keySection.style.display = 'none';
    fetchTip(task);
  } else {
    aiSection.style.display = 'none';
    keySection.style.display = 'flex';
  }

  if (window.innerWidth < 768) {
    document.getElementById('detail-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function fetchTip(task) {
  const tipEl = document.getElementById('detail-ai-tip');
  tipEl.innerHTML = '<span class="ai-loading">generating tip…</span>';
  detailChatHistory = [];

  const sys = `You are a concise, direct study coach for ${USER.name}, a Cambridge middle school student. Current task: "${task.text}" (${task.subject}, ${task.mins ? task.mins + ' min' : 'flexible'}). Give 2-3 sentence max, specific, actionable advice. No fluff.`;
  const msg = `One specific tip for doing this well right now: "${task.text}"`;

  const reply = await groq([{ role: 'system', content: sys }, { role: 'user', content: msg }], 200);
  if (reply) {
    tipEl.textContent = reply;
    detailChatHistory = [{ role: 'system', content: sys }, { role: 'user', content: msg }, { role: 'assistant', content: reply }];
  } else {
    tipEl.innerHTML = '<span class="ai-loading">couldn\'t load tip — check api key in settings</span>';
  }
}

async function fetchGeneratedContent(task) {
  const el = document.getElementById('detail-gen-content');
  el.innerHTML = '<span class="ai-loading">generating…</span>';

  const prompt = `Generate educational content for: "${task.text}" (Subject: ${task.subject}).
Student: ${USER.name}, Cambridge middle school.
Context from their plan: ${task.detail || 'no additional context'}

Format EXACTLY with --- headings ---:
Pick 3-5 relevant sections from: CONCEPT, EXTRACT/TEXT, QUESTIONS, PROBLEMS, CHALLENGE, TRACE EXERCISE, TOPIC, THE WHY, DRAW IT, EXAM QUESTION, MARK SCHEME, WATCH/LISTEN, WORKED EXAMPLE, EXTENSION

Use ---SECTION NAME--- format. Put answers/mark schemes under spoiler sections.
Keep content specific, actionable, Cambridge-standard. 200-300 words total.`;

  const reply = await groq([
    { role: 'system', content: 'Generate structured educational content. Follow format exactly. No preamble.' },
    { role: 'user', content: prompt }
  ], 600);

  if (reply) el.innerHTML = parseGenContent(reply);
  else el.innerHTML = '<span class="ai-loading">couldn\'t generate — check api key</span>';
}

function parseGenContent(raw) {
  const parts = raw.split(/---([^-\n]+)---/).filter(s => s.trim());
  if (parts.length < 2) return `<div class="gen-block"><div class="gen-body">${raw}</div></div>`;
  let html = '';
  for (let i = 0; i < parts.length - 1; i += 2) {
    const heading = parts[i].trim();
    const body = parts[i+1].trim().replace(/\n/g, '<br>');
    const isSpoiler = /MARK SCHEME|ANSWERS|ANSWER/.test(heading.toUpperCase());
    if (isSpoiler) {
      html += `<details class="gen-block gen-spoiler"><summary><span class="gen-heading">${heading}</span> <span style="font-size:0.7rem;color:var(--text-muted)">(tap to reveal)</span></summary><div class="gen-body">${body}</div></details>`;
    } else {
      html += `<div class="gen-block"><div class="gen-heading">${heading}</div><div class="gen-body">${body}</div></div>`;
    }
  }
  return html;
}

async function sendChat() {
  const input = document.getElementById('detail-chat-input');
  const msg = input.value.trim();
  if (!msg || !currentDetailTask || !USER.apiKey) return;
  input.value = '';

  const histEl = document.getElementById('detail-chat-history');

  const userBubble = document.createElement('div');
  userBubble.className = 'chat-bubble user';
  userBubble.textContent = msg;
  histEl.appendChild(userBubble);

  const loadBubble = document.createElement('div');
  loadBubble.className = 'chat-bubble ai';
  loadBubble.innerHTML = '<span class="ai-loading">…</span>';
  histEl.appendChild(loadBubble);
  histEl.scrollTop = histEl.scrollHeight;

  detailChatHistory.push({ role: 'user', content: msg });
  const reply = await groq(detailChatHistory, 300);
  if (reply) { detailChatHistory.push({ role: 'assistant', content: reply }); loadBubble.textContent = reply; }
  else loadBubble.innerHTML = '<span class="ai-loading">error — check api key</span>';
  histEl.scrollTop = histEl.scrollHeight;
}

/* ── Music (Web Audio) ────────────────────────────────────────────────────── */
let audioCtx = null, musicNodes = [], currentSound = 'none';

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function stopMusic() {
  musicNodes.forEach(n => { try { n.stop?.(); n.disconnect?.(); } catch(e) {} });
  musicNodes = [];
}

function startBrownNoise(vol) {
  const ctx = getAudioCtx();
  const bufSize = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < bufSize; i++) {
    const white = Math.random() * 2 - 1;
    data[i] = last = (last + 0.02 * white) / 1.02;
  }
  data.forEach((_, i, arr) => arr[i] *= 3.5);

  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const gain = ctx.createGain(); gain.gain.value = vol;
  src.connect(gain); gain.connect(ctx.destination);
  src.start();
  musicNodes = [src, gain];
}

function startRain(vol) {
  const ctx = getAudioCtx();
  // White noise base
  const bufSize = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 400; filter.Q.value = 0.5;
  const gain = ctx.createGain(); gain.gain.value = vol * 0.6;
  src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  src.start();
  musicNodes = [src, filter, gain];
}

function startFocus(vol) {
  const ctx = getAudioCtx();
  const nodes = [];
  [40, 80].forEach(freq => {
    const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = freq;
    const gain = ctx.createGain(); gain.gain.value = vol * 0.15;
    osc.connect(gain); gain.connect(ctx.destination); osc.start();
    nodes.push(osc, gain);
  });
  musicNodes = nodes;
}

function setMusic(sound, vol) {
  stopMusic();
  currentSound = sound;
  if (sound === 'none') return;
  if (sound === 'brown') startBrownNoise(vol);
  if (sound === 'rain')  startRain(vol);
  if (sound === 'focus') startFocus(vol);
}

function initMusic() {
  const volSlider = document.getElementById('music-vol');
  document.querySelectorAll('.music-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.music-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setMusic(btn.dataset.sound, parseFloat(volSlider.value));
    });
  });
  volSlider.addEventListener('input', () => {
    if (currentSound !== 'none') setMusic(currentSound, parseFloat(volSlider.value));
  });
}

/* ── Plan tab ─────────────────────────────────────────────────────────────── */
function initPlan() {
  const plan = USER.plan;
  const subEl = document.getElementById('plan-sub');
  if (plan.summary) subEl.textContent = plan.summary;
  else subEl.textContent = `${USER.name}'s personalised weekly study plan`;

  let activeDow = new Date().getDay();
  if (activeDow === 0) activeDow = 1;

  document.querySelectorAll('.day-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.day-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderPlanDay(parseInt(btn.dataset.day));
    });
  });

  const activeTab = document.querySelector(`.day-tab[data-day="${activeDow}"]`);
  if (activeTab) { activeTab.classList.add('active'); renderPlanDay(activeDow); }
  else { document.querySelector('.day-tab').classList.add('active'); renderPlanDay(1); }

  document.getElementById('regenerate-plan-btn').addEventListener('click', async () => {
    if (!USER.apiKey) { alert('Add a Groq API key in settings first.'); return; }
    if (!confirm('This will regenerate your entire study plan. Continue?')) return;
    document.getElementById('regenerate-plan-btn').textContent = 'generating…';
    const plan = await generatePlan(USER.name, USER.reportCardText || '', USER.syllabusText || '');
    if (plan) { USER.plan = plan; S.set('mz-user', USER); initPlan(); initCSRoadmap(); initProjects(); }
    document.getElementById('regenerate-plan-btn').textContent = '↻ regenerate plan';
  });
}

function renderPlanDay(dow) {
  const day = USER.plan.days[dow];
  const el = document.getElementById('plan-day-content');
  if (!day) { el.innerHTML = '<p style="color:var(--text-muted)">no plan for this day</p>'; return; }
  el.innerHTML = day.subjects.map(s => `
    <div class="plan-subject-card">
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem">
        <span class="subject-chip" style="background:${s.color};color:#333">${s.name}</span>
      </div>
      <div class="duration">${s.duration}</div>
      <ul class="plan-task-list">
        ${s.tasks.map(t => `<li>${t.text}${t.mins ? `<span class="task-time-pill" style="margin-left:0.4rem">${t.mins}m</span>` : ''}</li>`).join('')}
      </ul>
    </div>
  `).join('');
}

/* ── CS Roadmap ───────────────────────────────────────────────────────────── */
function initCSRoadmap() {
  const el = document.getElementById('cs-roadmap-content');
  const roadmap = USER.plan.csRoadmap || [];
  el.innerHTML = roadmap.map(m => `
    <div class="cs-month-card">
      <div class="cs-month-header">
        <span class="cs-month-name">${m.month}</span>
        <span class="cs-month-theme">${m.theme}</span>
      </div>
      <div class="cs-weeks">
        ${(m.weeks || []).map(w => `
          <div class="cs-week">
            <div class="cs-week-num">${w.range}</div>
            <div>
              <h4>${w.title}</h4>
              <p>${w.description}</p>
            </div>
          </div>
        `).join('')}
        ${m.resources?.length ? `
          <div style="border-top:1px solid var(--border);padding-top:0.75rem;display:flex;flex-direction:column;gap:0.3rem">
            ${m.resources.map(r => `<span style="font-size:0.78rem;color:var(--text-muted);padding-left:1rem;position:relative">
              <span style="position:absolute;left:0;color:var(--accent)">·</span>${r}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

/* ── Projects ─────────────────────────────────────────────────────────────── */
function initProjects() {
  const el = document.getElementById('projects-content');
  const projects = USER.plan.projects || [];
  el.innerHTML = projects.map(p => `
    <div class="project-card">
      <div class="project-month">${p.month} · 4 Saturdays · ${(p.subjects || []).join(' + ')}</div>
      <h3 class="project-title">${p.title}</h3>
      <p class="project-desc">${p.description}</p>
      <ol class="project-steps">${(p.steps || []).map(s => `<li>${s}</li>`).join('')}</ol>
      <div class="project-deliverable"><strong>deliverable:</strong> ${p.deliverable}</div>
    </div>
  `).join('');
}

/* ── Settings ─────────────────────────────────────────────────────────────── */
function openSettings() {
  document.getElementById('settings-overlay').style.display = 'block';
  document.getElementById('settings-panel').style.display = 'flex';
  document.getElementById('settings-name').value = USER.name;
  document.getElementById('settings-apikey').value = USER.apiKey || '';
  const hoursEl = document.getElementById('settings-hours');
  if (hoursEl) hoursEl.value = USER.hoursPerDay || '1 hour';
  const focusEl = document.getElementById('settings-focus');
  if (focusEl) focusEl.value = (USER.focusAreas || []).join(', ');
  const coachEl = document.getElementById('settings-coaching');
  if (coachEl) coachEl.value = USER.coaching || '';
  document.querySelectorAll('.theme-swatch').forEach(s => s.classList.toggle('active', s.dataset.theme === (USER.theme || 'light')));
}

function closeSettings() {
  document.getElementById('settings-overlay').style.display = 'none';
  document.getElementById('settings-panel').style.display = 'none';
}

function initSettings() {
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-overlay').addEventListener('click', closeSettings);

  document.getElementById('settings-save-name').addEventListener('click', () => {
    const name = document.getElementById('settings-name').value.trim();
    if (name) {
      USER.name = name;
      USER.hoursPerDay = document.getElementById('settings-hours')?.value || USER.hoursPerDay;
      USER.focusAreas = (document.getElementById('settings-focus')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
      USER.coaching = document.getElementById('settings-coaching')?.value.trim() || '';
      S.set('mz-user', USER);
      document.getElementById('header-greeting').textContent = `hey, ${name.toLowerCase()}`;
    }
  });

  document.getElementById('settings-save-key').addEventListener('click', () => {
    const key = document.getElementById('settings-apikey').value.trim();
    USER.apiKey = key; S.set('mz-user', USER);
    document.getElementById('detail-ai-section').style.display = key ? 'flex' : 'none';
    document.getElementById('detail-key-section').style.display = key ? 'none' : 'flex';
  });

  document.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  let settingsReportFile = null, settingsSyllabusFile = null;
  document.getElementById('settings-report').addEventListener('change', e => {
    settingsReportFile = e.target.files[0];
    if (settingsReportFile) document.getElementById('settings-report-name').textContent = settingsReportFile.name;
  });
  document.getElementById('settings-syllabus').addEventListener('change', e => {
    settingsSyllabusFile = e.target.files[0];
    if (settingsSyllabusFile) document.getElementById('settings-syllabus-name').textContent = settingsSyllabusFile.name;
  });

  document.getElementById('settings-regenerate').addEventListener('click', async () => {
    if (!USER.apiKey) { alert('Add a Groq API key first.'); return; }
    closeSettings();
    let reportText = USER.reportCardText || '';
    let syllabusText = USER.syllabusText || '';
    if (settingsReportFile) reportText = await extractFileText(settingsReportFile, 'report');
    if (settingsSyllabusFile) syllabusText = await extractFileText(settingsSyllabusFile, 'syllabus');
    const plan = await generatePlan(USER.name, reportText, syllabusText);
    if (plan) {
      USER.plan = plan; USER.reportCardText = reportText; USER.syllabusText = syllabusText;
      S.set('mz-user', USER);
      initPlan(); initCSRoadmap(); initProjects();
      alert('Plan regenerated!');
    }
  });

  document.getElementById('settings-reset').addEventListener('click', () => {
    if (confirm('Reset everything? This cannot be undone.')) {
      localStorage.clear();
      location.reload();
    }
  });
}

/* ── Reward modal ─────────────────────────────────────────────────────────── */
const EMOJIS = ['🎉','🔥','⚡','🏆','✨','🎯','💪','🌟'];

async function showReward(day) {
  const overlay = document.getElementById('reward-overlay');
  overlay.style.display = 'flex';
  document.getElementById('reward-emoji').textContent = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  document.getElementById('reward-msg').textContent = `every task done for ${day.name.toLowerCase()}.`;

  const streak = getStreak();
  const aiEl = document.getElementById('reward-ai');
  aiEl.textContent = '…';

  const reply = await groq([
    { role: 'system', content: `You are a study coach for ${USER.name}. Be warm, brief, genuine.` },
    { role: 'user', content: `${USER.name} just completed every task for ${day.name}. Their current streak is ${streak.current} day${streak.current !== 1 ? 's' : ''}. One sentence — genuine, not generic.` }
  ], 100);

  aiEl.textContent = reply || `full day done — that\'s the habit being built.`;

  document.getElementById('reward-close').addEventListener('click', () => {
    overlay.style.display = 'none';
  }, { once: true });
}

/* ── Bootstrap ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const saved = S.get('mz-user');
  if (saved?.plan) {
    USER = saved;
    applyTheme(USER.theme || 'light');
    launchApp();
  } else {
    document.getElementById('onboarding').style.display = 'flex';
    applyTheme('light');
    initOnboarding();
  }
});
