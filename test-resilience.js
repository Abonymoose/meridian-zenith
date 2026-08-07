/* A malformed AI plan must never leave the app unusable. */
const { JSDOM } = require('jsdom');
const fs=require('fs');
const html=fs.readFileSync(__dirname+'/index.html','utf8').replace('<script src="main.js"></script>','');

function boot(plan){
  const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://x.test'});
  const {window}=dom;
  window.localStorage.setItem('mz',JSON.stringify({name:'P',grade:'8',apiKey:'k',onboarded:true,plan}));
  window.fetch=()=>new Promise(()=>{});
  window.HTMLMediaElement&&(window.HTMLMediaElement.prototype.play=()=>Promise.resolve());
  const errs=[]; window.addEventListener('error',e=>errs.push(e.message));
  window.eval(fs.readFileSync(__dirname+'/main.js','utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return {window,d:window.document,errs};
}
let pass=0,fail=0;
const ck=(l,g,w)=>{ if(g===w)pass++; else{fail++;console.log(`FAIL ${l}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`)} };

const dow=new Date().getDay();
const good={summary:'s',days:{[dow]:{name:'T',subjects:[{name:'Physics',color:'#E0F0FF',tasks:[{text:'a',mins:5,detail:'d'}]}]}},roadmap:[]};

const broken={
  'day missing subjects': {summary:'s',days:{[dow]:{name:'T'}}},
  'subject missing tasks':{summary:'s',days:{[dow]:{name:'T',subjects:[{name:'P'}]}}},
  'days null':            {summary:'s',days:null},
  'no days key':          {summary:'s'},
  'day missing name':     {summary:'s',days:{[dow]:{subjects:[{name:'P',tasks:[{text:'a'}]}]}}},
  'days as array':        {summary:'s',days:[{name:'Sun',subjects:[{name:'P',tasks:[{text:'a'}]}]}]},
  'task as string':       {summary:'s',days:{[dow]:{name:'T',subjects:[{name:'P',tasks:['plain string']}]}}},
  'plan is a string':     'not a plan',
  'plan is an array':     [1,2,3],
  'plan is null':         null,
};

console.log('=== no malformed plan may brick the app ===');
for(const [label,plan] of Object.entries(broken)){
  const {d,errs}=boot(plan);
  const crashed=errs.length>0;
  const recovery=!!d.getElementById('rec-regen');
  const settingsBtn=d.querySelector('.sidebar-settings-btn');
  let settingsOpens=false;
  if(settingsBtn){ settingsBtn.click(); settingsOpens=d.getElementById('settings-drawer')?.style.display==='flex'; }
  const onboarding = d.getElementById('onboarding')?.style.display === 'flex' && !!d.getElementById('ob-n1');
  const escapable = recovery || settingsOpens || onboarding;
  if(crashed){ fail++; console.log(`FAIL ${label}: uncaught error ${errs[0]}`); }
  else pass++;
  if(!escapable){ fail++; console.log(`FAIL ${label}: no way out`); }
  else pass++;
  const route = recovery?'recovery screen':settingsOpens?'app + settings':onboarding?'onboarding':'NONE';
  console.log(`  ${label.padEnd(23)} crashed=${crashed?'YES':'no '}  route out: ${route}`);
}

console.log('\n=== valid plan still boots ===');
{
  const {d,errs}=boot(good);
  ck('no errors', errs.length, 0);
  ck('no recovery screen', !!d.getElementById('rec-regen'), false);
  ck('app shown', d.getElementById('app').style.display, 'grid');
  ck('tasks rendered', d.querySelectorAll('#task-list .task-item').length, 1);
  const sb=d.querySelector('.sidebar-settings-btn'); sb.click();
  ck('settings opens', d.getElementById('settings-drawer').style.display, 'flex');
}

console.log('\n=== model text cannot inject elements ===');
{
  const evil='<img src=x onerror="window.__pwned=1">';
  const p={summary:'s',days:{[dow]:{name:'T',subjects:[{name:evil,color:'#eee',tasks:[{text:evil,mins:5}]}]}},roadmap:[]};
  const {window,d}=boot(p);
  ck('no img injected', !!d.querySelector('#task-list img'), false);
  ck('not executed', window.__pwned, undefined);
  ck('shown as text', d.getElementById('task-list').textContent.includes('<img'), true);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
