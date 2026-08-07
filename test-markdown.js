const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync('./main.js','utf8').replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*$/,'')+'\nglobalThis.__api={mdToHtml,parseGen,esc};';
const sb={document:{addEventListener(){},querySelectorAll:()=>[],getElementById:()=>null,createElement:()=>({}),body:{appendChild(){}}},window:{},console,setTimeout,clearTimeout,Date,Math,JSON,Object,Array,Number,String,Error,Boolean,Set,localStorage:{getItem:()=>null,setItem(){}},AbortController,fetch:null,FileReader:class{},parseInt,parseFloat,isNaN};
vm.createContext(sb);vm.runInContext(src,sb);
const {mdToHtml,parseGen}=sb.__api;
let pass=0,fail=0;
const ck=(l,g,w)=>{ if(g===w)pass++; else{fail++;console.log(`FAIL ${l}\n  got:  ${g}\n  want: ${w}`)} };

console.log('--- markdown ---');
ck('bold', mdToHtml('**Array**: a thing'), '<p><strong>Array</strong>: a thing</p>');
ck('italic', mdToHtml('this is *neat*'), '<p>this is <em>neat</em></p>');
ck('bold italic', mdToHtml('***wow***'), '<p><strong><em>wow</em></strong></p>');
ck('code', mdToHtml('use `arr[0]`'), '<p>use <code>arr[0]</code></p>');
ck('heading', mdToHtml('## Core Concepts'), '<h4 class="gen-h">Core Concepts</h4>');
ck('bullets', mdToHtml('- one\n- two'), '<ul class="gen-list"><li>one</li><li>two</li></ul>');
ck('numbered', mdToHtml('1. first\n2. second'), '<ol class="gen-list"><li>first</li><li>second</li></ol>');
ck('bold inside bullet', mdToHtml('- **Array**: fixed'), '<ul class="gen-list"><li><strong>Array</strong>: fixed</li></ul>');
ck('list then para', mdToHtml('- a\n\ntext'), '<ul class="gen-list"><li>a</li></ul><p>text</p>');

console.log('--- escaping happens before markdown ---');
ck('tags escaped', mdToHtml('<img src=x onerror=y>'), '<p>&lt;img src=x onerror=y&gt;</p>');
ck('bold cannot inject', mdToHtml('**<script>**').includes('<script>'), false);
ck('ampersand', mdToHtml('Tom & Jerry'), '<p>Tom &amp; Jerry</p>');

console.log('--- section parsing ---');
const sample=`---Topic Overview---
**1. Data Structures**
Arrays are contiguous.
---Core Concepts---
- **Array**: fixed length
- **List**: dynamic
---Answers---
The answer is 42.`;
const out=parseGen(sample);
ck('three sections', (out.match(/<details/g)||[]).length, 3);
ck('first open', out.indexOf('<details class="gen-block" open>'), 0);
ck('answers collapsed', /<details class="gen-block"><summary>answers/.test(out), true);
ck('no literal asterisks', out.includes('**'), false);
ck('real titles used', out.includes('topic overview'), true);
ck('bold rendered', out.includes('<strong>Array</strong>'), true);

console.log('--- no sections falls back ---');
ck('plain text still renders', parseGen('Just **some** text').includes('<strong>some</strong>'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
