/* Tests for sessions, spaced repetition, exams and backup. */
const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync(__dirname+'/main.js','utf8')
  .replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*$/,'')
  + `\nglobalThis.__api={dayKey,parseDay,addDays,daysUntil,today,plural,
   getSessions,addSession,sessionStats,guessSubject,
   getReviews,saveReviews,scheduleReview,gradeReview,dueReviews,nextInterval,reviewId,upcomingReviewCount,
   getExams,saveExams,nextExam,upcomingExams,examsSoon,examCap,EXAM_WINDOW,
   exportData,importData,
   setUser:u=>{USER=u},setTask:t=>{currentTask=t}};`;

const store={};
const el={innerHTML:'',textContent:'',style:{},addEventListener(){},classList:{add(){},toggle(){},contains:()=>false},
  querySelector:()=>el,querySelectorAll:()=>[],appendChild(){},remove(){},click(){},value:''};
const sb={document:{addEventListener(){},querySelectorAll:()=>[],getElementById:()=>el,createElement:()=>el,body:{appendChild(){}}},
  window:{},console,setTimeout,clearTimeout,Date,Math,JSON,Object,Array,Number,String,Error,Boolean,Set,
  localStorage:{get length(){return Object.keys(store).length},key:i=>Object.keys(store)[i],
    getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=v},removeItem:k=>{delete store[k]},clear:()=>{for(const k in store)delete store[k]}},
  AbortController,fetch:null,FileReader:class{},Blob:class{constructor(p){this.p=p}},URL:{createObjectURL:()=>'blob:x',revokeObjectURL(){}}};
vm.createContext(sb); vm.runInContext(src,sb);
const A=sb.__api;

let pass=0,fail=0;
const ck=(l,g,w)=>{ if(JSON.stringify(g)===JSON.stringify(w))pass++; else {fail++;console.log(`FAIL ${l}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`)} };
const reset=()=>{ for(const k in store) delete store[k]; };
const shift=n=>A.dayKey(A.addDays(new Date(),n));

/* ── dates ── */
console.log('--- dates ---');
ck('today round-trips', A.dayKey(A.parseDay(A.today())), A.today());
ck('daysUntil tomorrow', A.daysUntil(shift(1)), 1);
ck('daysUntil yesterday', A.daysUntil(shift(-1)), -1);
ck('daysUntil today', A.daysUntil(A.today()), 0);
ck('dayKey is zero padded', /^\d{4}-\d{2}-\d{2}$/.test(A.today()), true);

/* ── sessions ── */
console.log('--- sessions ---');
reset();
A.setUser({plan:{days:{1:{subjects:[{name:'Physics',tasks:[]}]}}}});
A.setTask(null);
A.addSession({at:new Date().toISOString(),label:'physics revision',mins:25,subject:'Physics'});
A.addSession({at:new Date().toISOString(),label:'maths',mins:50,subject:'Maths'});
A.addSession({at:A.addDays(new Date(),-9).toISOString(),label:'old',mins:99,subject:'Maths'});
ck('sessions persist', A.getSessions().length, 3);
let st=A.sessionStats(7);
ck('7d total excludes old', st.total, 75);
ck('7d session count', st.count, 2);
ck('per-subject split', Object.entries(st.bySubject).sort(), [['Maths',50],['Physics',25]]);
ck('subject guessed from label', A.guessSubject('did some physics today'), 'Physics');
A.setTask({_subj:'Chemistry'});
ck('open task wins over label', A.guessSubject('physics'), 'Chemistry');
A.setTask(null);
ck('no match returns null', A.guessSubject('random words'), null);

/* ── spaced repetition ── */
console.log('--- spaced repetition ---');
reset();
const task={text:'Ohm law practice',_subj:'Physics'};
A.scheduleReview(task);
let rs=A.getReviews(); let id=Object.keys(rs)[0];
ck('review created', Object.keys(rs).length, 1);
ck('first due tomorrow', rs[id].due, shift(1));
ck('not due today', A.dueReviews().length, 0);

A.scheduleReview(task);
ck('rescheduling does not duplicate', Object.keys(A.getReviews()).length, 1);
ck('same text+subject same id', A.reviewId('Ohm law practice','Physics'), id);
ck('different subject different id', A.reviewId('Ohm law practice','Maths')===id, false);

// Intervals expand when remembered
rs=A.getReviews(); rs[id].due=A.today(); A.saveReviews(rs);
ck('now due', A.dueReviews().length, 1);
let r=A.gradeReview(id,'good');
ck('rep 1 good -> 1 day', r.interval, 1);
r.due=A.today(); A.saveReviews({[id]:r});
r=A.gradeReview(id,'good');
ck('rep 2 good -> 3 days', r.interval, 3);
r.due=A.today(); A.saveReviews({[id]:r});
r=A.gradeReview(id,'good');
ck('rep 3 good -> interval * ease', r.interval, Math.round(3*2.5));
ck('due matches interval', r.due, shift(r.interval));

// Forgetting resets
r.due=A.today(); A.saveReviews({[id]:r});
const easeBefore=r.ease;
r=A.gradeReview(id,'again');
ck('forgot resets interval', r.interval, 1);
ck('forgot drops ease', r.ease < easeBefore, true);
ck('lapse counted', r.lapses, 1);
ck('reps reset', r.reps, 0);

// Ease floor
reset(); A.scheduleReview(task);
id=Object.keys(A.getReviews())[0];
for(let i=0;i<20;i++){ const x=A.getReviews(); x[id].due=A.today(); A.saveReviews(x); A.gradeReview(id,'again'); }
ck('ease never below 1.3', A.getReviews()[id].ease >= 1.3, true);

// Easy beats good beats hard
reset(); A.scheduleReview(task);
id=Object.keys(A.getReviews())[0];
const base=A.getReviews()[id];
const gaps=['again','hard','good','easy'].map(q=>A.nextInterval({...base,reps:3,interval:10},q).interval);
ck('again is shortest', gaps[0], 1);
ck('hard < good', gaps[1] < gaps[2], true);
ck('good < easy', gaps[2] < gaps[3], true);

/* ── exams ── */
console.log('--- exams ---');
reset();
A.saveExams([{subject:'Physics',date:shift(5)},{subject:'History',date:shift(40)},{subject:'Maths',date:shift(-3)}]);
ck('sorted by date', A.getExams().map(e=>e.subject), ['Maths','Physics','History']);
ck('past exams excluded', A.upcomingExams().map(e=>e.subject), ['Physics','History']);
ck('exams soon within window', A.examsSoon().map(e=>e.subject), ['Physics']);
ck('nextExam matches case-insensitively', A.nextExam('physics').subject, 'Physics');
ck('nextExam ignores past', A.nextExam('Maths'), null);
ck('no exam -> no cap', A.examCap('Geography'), null);
ck('cap lands before exam', A.examCap('Physics'), 4);

// Cap actually applied
A.scheduleReview({text:'Circuits',_subj:'Physics'});
id=Object.keys(A.getReviews())[0];
let x=A.getReviews(); x[id]={...x[id],reps:5,interval:30,ease:2.5,due:A.today()}; A.saveReviews(x);
r=A.gradeReview(id,'good');
ck('interval capped by exam', r.interval, 4);
ck('cap flagged', r.cappedByExam, true);
ck('due before exam', A.daysUntil(r.due) < A.daysUntil(shift(5)), true);

// No cap when exam is distant
A.saveExams([{subject:'Physics',date:shift(300)}]);
x=A.getReviews(); x[id]={...x[id],reps:5,interval:30,ease:2.5,due:A.today()}; A.saveReviews(x);
r=A.gradeReview(id,'good');
ck('distant exam does not cap', r.cappedByExam, false);

// Due ordering prioritises nearer exams
reset();
A.saveExams([{subject:'Physics',date:shift(2)},{subject:'History',date:shift(30)}]);
A.scheduleReview({text:'a',_subj:'History'});
A.scheduleReview({text:'b',_subj:'Physics'});
x=A.getReviews(); Object.values(x).forEach(v=>v.due=A.today()); A.saveReviews(x);
ck('nearer exam first', A.dueReviews().map(v=>v.subject), ['Physics','History']);

/* ── backup ── */
console.log('--- backup ---');
reset();
store['mz']=JSON.stringify({name:'P'});
store['mz-streak']=JSON.stringify({current:3});
store['unrelated']='keep out';
let captured=null;
sb.Blob=class{constructor(p){captured=p[0]}};
A.exportData();
let dump=JSON.parse(captured);
ck('export includes mz keys', Object.keys(dump.data).sort(), ['mz','mz-streak']);
ck('export excludes others', 'unrelated' in dump.data, false);
ck('export tagged', dump.app, 'meridian-zenith');

(async()=>{
  const file=t=>({text:async()=>t});
  const expectThrow=async(l,t,frag)=>{
    try{ await A.importData(file(t)); fail++; console.log(`FAIL ${l}: no error thrown`); }
    catch(e){ if(e.message.includes(frag))pass++; else {fail++;console.log(`FAIL ${l}: "${e.message}"`)} }
  };
  await expectThrow('rejects bad json','not json','valid JSON');
  await expectThrow('rejects wrong shape','{"hello":1}','Meridian backup');
  await expectThrow('rejects no profile','{"data":{"mz-streak":"x"}}','no profile');
  await expectThrow('rejects null data','{"data":null}','Meridian backup');

  reset();
  const n=await A.importData(file(JSON.stringify({data:{mz:'{"name":"R"}','mz-streak':'{"current":9}',junk:'no'}})));
  ck('imports mz keys only', n, 2);
  ck('restored profile', store['mz'], '{"name":"R"}');
  ck('junk not restored', 'junk' in store, false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
