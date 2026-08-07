const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync('./main.js','utf8')
  .replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*$/,'')
  + '\nglobalThis.__api={initOverview,termProgress,gradeColour,TERM,setUser:u=>{USER=u}};';

const store={};
const el={innerHTML:'',addEventListener(){},style:{},classList:{toggle(){},add(){}},textContent:''};
const grid={innerHTML:'',addEventListener(){},style:{}};
const sb={
  document:{addEventListener(){},querySelectorAll:()=>[],
    getElementById:id=>id==='overview-grid'?grid:(id==='ov-to-settings'?(grid.innerHTML.includes('ov-to-settings')?el:null):el),
    createElement:()=>el, body:{appendChild(){}}},
  window:{},console,setTimeout,clearTimeout,Date,Math,JSON,Object,Array,Number,String,Error,Boolean,isFinite,
  localStorage:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=v},removeItem:k=>{delete store[k]}},
  AbortController,fetch:null,FileReader:class{}
};
vm.createContext(sb); vm.runInContext(src,sb);
const A=sb.__api;

let pass=0,fail=0;
const ck=(l,g,w)=>{g===w?pass++:(fail++,console.log(`FAIL ${l}: got ${g}, want ${w}`))};

const dow=new Date().getDay();
const basePlan={days:{[dow]:{name:'Today',subjects:[{name:'Physics',color:'#E0F0FF',tasks:[{text:'a'},{text:'b'}]}]}},
  csRoadmap:[{month:'June',theme:'binary',weeks:[{},{}]},{month:'July',theme:'sorting',weeks:[{}]}]};

console.log('--- with grades ---');
A.setUser({name:'P',focus:['Physics','History'],plan:{...basePlan,
  grades:[{name:'Physics',score:76,grade:'B+'},{name:'CS',score:95,grade:'A+'},{name:'History',score:72,grade:'B+'}]}});
A.initOverview();
let h=grid.innerHTML;
ck('renders grade rows', (h.match(/ov-subject-row/g)||[]).length, 3);
ck('shows focus badge', h.includes('ov-focus-badge'), true);
ck('focus lists Physics', h.includes('Physics · History'), true);
ck('no empty state', h.includes('No grades yet'), false);
ck('cs card shown', h.includes('cs roadmap'), true);
ck('cs month count', h.includes('>2</div>'), true);
ck('cs week count', h.includes('months · 3 weeks'), true);
ck('today count 0/2', h.includes('> / 2<'), true);

console.log('--- no grades (no report card uploaded) ---');
A.setUser({name:'P',focus:[],plan:basePlan});
A.initOverview(); h=grid.innerHTML;
ck('empty state shown', h.includes('No grades yet'), true);
ck('no fake rows', h.includes('ov-subject-row'), false);
ck('no focus badge', h.includes('ov-focus-badge'), false);
ck('settings link', h.includes('ov-to-settings'), true);

console.log('--- no cs roadmap (opt-out) ---');
A.setUser({name:'P',focus:[],plan:{days:basePlan.days}});
A.initOverview(); h=grid.innerHTML;
ck('cs card hidden', h.includes('cs roadmap'), false);

console.log('--- rest day ---');
A.setUser({name:'P',focus:[],plan:{days:{}}});
A.initOverview(); h=grid.innerHTML;
ck('rest day message', h.includes('rest day'), true);

console.log('--- bad data does not crash ---');
A.setUser({name:'P',focus:[],plan:{days:{},grades:[{name:'X',score:'abc'},{score:200},{name:'<img onerror=x>',score:50}]}});
A.initOverview(); h=grid.innerHTML;
ck('non-numeric score shows dash', h.includes('—'), true);
ck('score clamped to 100', h.includes('width:100%'), true);
ck('name escaped', h.includes('&lt;img'), true);
ck('raw tag not injected', h.includes('<img onerror'), false);

console.log('--- habit grid ---');
store['mz-streak']=JSON.stringify({days:[new Date().toDateString()],current:1,best:4});
A.setUser({name:'P',focus:[],plan:basePlan});
A.initOverview(); h=grid.innerHTML;
ck('28 day cells', (h.match(/ov-week-day/g)||[]).length, 28);
ck('today marked', h.includes('today'), true);
ck('best streak shown', h.includes('best: 4 days'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
