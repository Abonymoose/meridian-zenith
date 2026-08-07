/* Walks every path through onboarding and fails on any dead end. */
const { JSDOM } = require('jsdom');
const fs = require('fs');

function boot() {
  const html = fs.readFileSync(__dirname+'/index.html','utf8').replace('<script src="main.js"></script>','');
  const dom = new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://x.test'});
  const { window } = dom;
  window.fetch = () => new Promise(()=>{});          // never resolves: stay on the gen screen
  window.HTMLMediaElement && (window.HTMLMediaElement.prototype.play = ()=>Promise.resolve());
  const errs=[];
  window.addEventListener('error',e=>errs.push(e.message));
  window.eval(fs.readFileSync(__dirname+'/main.js','utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { window, d: window.document, errs };
}

const active = d => { const a=d.querySelector('.ob-step.active'); return a?a.id:null; };

let pass=0,fail=0;
const ck=(l,g,w)=>{ if(g===w)pass++; else{fail++;console.log(`FAIL ${l}\n  got ${g}, want ${w}`)} };

function click(d,id){ const b=d.getElementById(id); if(!b){throw new Error(`no button #${id}`);} b.click(); }

/* ── duplicate ids ── */
const raw=fs.readFileSync(__dirname+'/index.html','utf8');
const ids=raw.match(/id="([^"]+)"/g).map(s=>s.slice(4,-1));
const dupes=[...new Set(ids.filter((v,i)=>ids.indexOf(v)!==i))];
ck('no duplicate element ids', dupes.length?dupes.join(','):'none', 'none');

/* ── every obGo target exists ── */
const js=fs.readFileSync(__dirname+'/main.js','utf8');
const targets=[...new Set([...js.matchAll(/obGo\('([^']+)'\)/g)].map(m=>m[1]))];
const missing=targets.filter(t=>!ids.includes(t));
ck('all obGo targets exist', missing.length?missing.join(','):'none', 'none');

/* ── main path: every continue button ── */
console.log('--- main path ---');
{
  const {d}=boot();
  ck('starts at name', active(d), 'ob-s1');
  d.getElementById('ob-name').value='Parshv';
  const steps=[
    ['ob-n1','ob-s2'],
  ];
  click(d,'ob-n1'); ck('name -> schedule?', active(d), 'ob-s2');
  click(d,'ob-fork-no');
  ck('schedule? -> grade', active(d), 'ob-s3b');
  const path=[['ob-n3b','ob-s4'],['ob-n4','ob-s5'],['ob-n5','ob-s6'],['ob-n6','ob-s7'],
              ['ob-n7','ob-s8'],['ob-n8','ob-s9c'],['ob-n9c','ob-s9r'],['ob-n9r','ob-s10r'],
              ['ob-n10r','ob-s11r'],['ob-n11r','ob-s12r']];
  for(const [btn,expect] of path){
    click(d,btn);
    ck(`${btn} -> ${expect}`, active(d), expect);
  }
}

/* ── skip path ── */
console.log('--- skip buttons ---');
{
  const {d}=boot();
  d.getElementById('ob-name').value='P';
  click(d,'ob-n1');
  click(d,'ob-fork-no');
  ['ob-n3b','ob-n4','ob-n5'].forEach(b=>click(d,b));
  click(d,'ob-skip6'); ck('skip6 -> style', active(d), 'ob-s7');
  click(d,'ob-n7');
  click(d,'ob-skip8r'); ck('skip roadmap -> tutoring', active(d), 'ob-s9c');
  click(d,'ob-skip9c'); ck('skip tutoring -> report card', active(d), 'ob-s9r');
  click(d,'ob-skip9r'); ck('skip report -> syllabus', active(d), 'ob-s10r');
  click(d,'ob-skip10r'); ck('skip syllabus -> api key', active(d), 'ob-s11r');
  click(d,'ob-skip11r'); ck('skip key -> generating', active(d), 'ob-s12r');
}

/* ── "I already have a schedule" path ── */
console.log('--- existing schedule path ---');
{
  const {d}=boot();
  d.getElementById('ob-name').value='P';
  click(d,'ob-n1');
  click(d,'ob-fork-yes');
  ck('yes -> upload schedule', active(d), 'ob-s3a');
  click(d,'ob-n3a');
  ck('upload -> api key (not blank)', active(d), 'ob-s11r');
}

/* ── no screen is a dead end ── */
console.log('--- dead end sweep ---');
{
  const {d}=boot();
  const screens=[...d.querySelectorAll('.ob-step')].map(s=>s.id);
  const unreachable=[];
  for(const sid of screens){
    if(sid==='ob-s12r') continue;                       // terminal
    const btns=[...d.querySelectorAll(`#${sid} button`)];
    const nav=btns.filter(b=>/^ob-(n|skip)/.test(b.id));
    if(sid!=='ob-s2' && !nav.length) unreachable.push(`${sid} (no nav buttons)`);
  }
  ck('every screen has a way forward', unreachable.length?unreachable.join(','):'none','none');

  // each nav button must actually change the active screen
  const dead=[];
  for(const sid of screens){
    if(sid==='ob-s12r') continue;
    for(const b of [...d.querySelectorAll(`#${sid} button`)].filter(x=>/^ob-(n|skip)/.test(x.id))){
      const {d:fresh}=boot();
      const el=fresh.getElementById(sid);
      fresh.querySelectorAll('.ob-step').forEach(s=>s.classList.remove('active'));
      el.classList.add('active');
      const nm=fresh.getElementById('ob-name'); if(nm) nm.value='Test';
      const before=active(fresh);
      fresh.getElementById(b.id).click();
      if(active(fresh)===before) dead.push(`#${b.id} on ${sid}`);
    }
  }
  ck('no button is a no-op', dead.length?dead.join(', '):'none','none');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
