'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// INDOOR WORKFLOW, END TO END
// ═══════════════════════════════════════════════════════════════════════════
// Everything else in the suite tests one seam. This walks the whole job a crew actually does —
// switch to PlotIn, trace a room, save it, capture a fixture inside it, link the two, park one
// mid-capture, resume it, re-open the room and read its contents back — against a project whose
// schema uses a real 'feature_ref' field.
//
// It exists because the failures that survive per-seam testing are the ones that only appear in
// sequence. Two were found writing it, and both were invisible in isolation:
//
//   1. resetCollectEnvironmentFields() ran unconditionally after every save, so finishing one
//      fixture dropped the crew back to PlotOut with Building and Floor blank. Correct for an
//      explicit "clear this form", wrong for a save — and a building visit is four fixtures on one
//      floor, so it meant retyping the same address four times. Every retype is a chance to type
//      Level 1.
//   2. The dock's level chip cleared #cdDot from the DOM instead of hiding it, so the very next
//      call resolved it to null, hit the guard at the top of updateCollectDockStatus() and returned
//      early. The dock then silently froze on whatever it last showed, and nothing threw.
//
// Neither is reachable by testing the save path, the dock, or the link field on their own.
const fs=require('fs'),path=require('path'),{JSDOM}=require('jsdom');
const ROOT=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const jsOrder=[...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m=>m[1]);
const errs=[];
function stubs(w){
  const chain=()=>new Proxy(function(){},{get:(t,p)=>(p==='then'?undefined:chain()),apply:()=>chain(),construct:()=>chain()});
  w.L=chain();w.JSZip=chain();
  w.matchMedia=q=>({matches:false,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
  w.scrollTo=()=>{};w.HTMLElement.prototype.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.Element.prototype.animate=()=>({finished:Promise.resolve(),cancel(){},addEventListener(){}});
  w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}takeRecords(){return[]}};
  w.navigator.geolocation={getCurrentPosition(){},watchPosition(){return 1},clearWatch(){}};
  w.createImageBitmap=async()=>({width:10,height:10,close(){}});
  w.URL.createObjectURL=()=>'blob:x';w.URL.revokeObjectURL=()=>{};
  w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){},clearRect(){},beginPath(){},arc(){},fill(){},stroke(){},moveTo(){},lineTo(){},closePath(){},save(){},restore(){},translate(){},rotate(){},setTransform(){},measureText:()=>({width:10}),fillText(){},strokeText(){},createLinearGradient:()=>({addColorStop(){}}),putImageData(){},getImageData:()=>({data:new Uint8ClampedArray(4)}),createImageData:()=>({data:new Uint8ClampedArray(4)}),set fillStyle(v){},set font(v){}});
  w.HTMLCanvasElement.prototype.toDataURL=()=>'data:image/jpeg;base64,AA';
  w.onerror=m=>{errs.push('onerror: '+m);return true;};
}
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://example.test/',beforeParse:stubs});
const w=dom.window,d=w.document;
w.addEventListener('error',e=>errs.push('err: '+(e.message||e.error)));
for(const f of jsOrder){const el=d.createElement('script');el.textContent=fs.readFileSync(path.join(ROOT,'js',f),'utf8');d.head.appendChild(el);}
try{d.dispatchEvent(new w.Event('DOMContentLoaded',{bubbles:true}));}catch(e){}
const run=c=>w.eval(c);
const out=[];const t=(n,c,det)=>out.push([n,!!c,det]);

// ── build a realistic indoor project ──
run(`
  projects=[{id:'sw1',name:'Sweep',createdAt:new Date().toISOString()}];
  projectData={sw1:{savedFeatures:[],currentVertices:[],featureTypes:[
    {id:'room',name:'Room',geometryType:'polygon',fields:[
      {id:'use',label:'Use',type:'single_select',options:['Bathroom','Kitchen']}
    ]},
    {id:'fix',name:'Fixture',geometryType:'point',fields:[
      {id:'kind',label:'Kind',type:'single_select',options:['Sink','Toilet']},
      {id:'in_room',label:'In room',type:'feature_ref',refTargetFtId:'room'}
    ]}
  ]}};
  openProject('sw1');
`);

// 1. env toggle collapse state is driven by data-val
run("setCollectEnvironment('PlotOut')");
t('toggle carries PlotOut state for the collapsed CSS', d.getElementById('collectEnvToggle').dataset.val==='PlotOut');
run("setCollectEnvironment('PlotIn')");
t('toggle carries PlotIn state for the expanded CSS', d.getElementById('collectEnvToggle').dataset.val==='PlotIn');
t('both options stay in the DOM when collapsed', d.querySelectorAll('#collectEnvToggle .geo-opt').length===2);
t('both sublabels stay in the DOM (never display:none)', d.querySelectorAll('#collectEnvToggle .env-opt-sub').length===2);

// 2. PlotIn save validation still fires
run("blankCollectForm(); setCollectEnvironment('PlotIn');");
d.getElementById('featureTypeSelect').value='room'; w.onFeatureTypeChange();
d.getElementById('featureName').value='Bath 1';
run("currentVertices=[{lat:-17.8,lon:31,attrs:{},photos:[]},{lat:-17.81,lon:31.01,attrs:{},photos:[]},{lat:-17.82,lon:31.0,attrs:{},photos:[]}];");
const n0=run('savedFeatures.length');
run('saveFeature()');
t('PlotIn still refuses a save with no building', run('savedFeatures.length')===n0, d.getElementById('toast').textContent);
d.getElementById('collectBuildingId').value='NORTH-A';
d.getElementById('collectFloorLevel').value='Level 2';
run('saveFeature()');
t('PlotIn saves once building+floor are set', run('savedFeatures.length')===n0+1, d.getElementById('toast').textContent);
const room=run("savedFeatures[savedFeatures.length-1]");
t('the room got an autofilled ref', !!(room.ref||'').trim(), room.ref);
t('indoor address persisted onto the feature', room.building_id==='NORTH-A'&&room.floor_level==='Level 2');

// 3. after an indoor save the crew is still indoors, still on the same floor
t('saving indoors does not drop back to PlotOut', run('currentEnvironment')==='PlotIn');
t('the building survives a save', d.getElementById('collectBuildingId').value==='NORTH-A');
t('the floor survives a save', d.getElementById('collectFloorLevel').value==='Level 2');
run('updateCollectDockStatus()');
t('dock still shows the level chip after saving indoors', d.getElementById('cdStatusMain').classList.contains('is-level'));
t('#cdDot survived the chip render', !!d.getElementById('cdDot'));
// but an explicit clear still clears
run('blankCollectForm();');
t('an explicit clear still resets to PlotOut', run('currentEnvironment')==='PlotOut');
t('an explicit clear still blanks the address', d.getElementById('collectBuildingId').value==='');
run("setCollectEnvironment('PlotIn');");

// 4. link picker offers the room
run('blankCollectForm();');
d.getElementById('featureTypeSelect').value='fix'; w.onFeatureTypeChange();
const pick=d.getElementById('attr_in_room');
t('link picker rendered as a select', pick&&pick.tagName==='SELECT');
t('link picker offers the saved room', Array.from(pick.options).some(o=>o.value===room.ref), Array.from(pick.options).map(o=>o.value).join('|'));

// 5. save a linked fixture indoors
d.getElementById('featureName').value='Sink 1';
d.getElementById('collectBuildingId').value='NORTH-A';
d.getElementById('collectFloorLevel').value='Level 2';
d.getElementById('attr_in_room').value=room.ref;
run("currentVertices=[{lat:-17.8,lon:31,attrs:{},photos:[]}];");
const n1=run('savedFeatures.length');
run('saveFeature()');
t('the linked fixture saved', run('savedFeatures.length')===n1+1, d.getElementById('toast').textContent);
const sink=run("savedFeatures.find(f=>f.name==='Sink 1')");
t('the link stored as the room ref', sink&&sink.attrs.in_room===room.ref);

// 6. back-reference
const back=run(`featuresLinkingTo(savedFeatures.find(f=>f.id===${JSON.stringify(room.id)}))`);
t('the room sees the sink', back.length===1&&back[0].feature.name==='Sink 1');
run(`openInspect(${JSON.stringify(room.id)})`);
t('inspector renders the linked row', d.querySelectorAll('#inspectBody .fi-linked-row').length===1);
run('closeInspect()');

// 7. round-trip through the capture stack with a link + indoor address
run('blankCollectForm();');
d.getElementById('featureTypeSelect').value='fix'; w.onFeatureTypeChange();
d.getElementById('featureName').value='Toilet 1';
d.getElementById('attr_in_room').value=room.ref;
run("currentVertices=[{lat:-17.8,lon:31,attrs:{},photos:[]}];");
const parkedFloor = d.getElementById('collectFloorLevel').value;
run('suspendCurrentCapture()');
t('a linked capture can be parked', run('suspendedCaptures.length')===1);
run('resumeCapture(suspendedCaptures[0].id)');
t('the link survives park+resume', d.getElementById('attr_in_room').value===room.ref, d.getElementById('attr_in_room').value);
t('the indoor address survives park+resume', d.getElementById('collectFloorLevel').value===parkedFloor,
  `parked "${parkedFloor}", got "${d.getElementById('collectFloorLevel').value}"`);

// 8. editing the room must not accuse itself, and must not offer itself as its own target
run(`blankCollectForm(); editFeature(${JSON.stringify(room.id)});`);
const n2=run('savedFeatures.length');
run('saveFeature()');
t('re-saving the room updates rather than duplicating', run('savedFeatures.length')===n2);
t('no self-collision prompt on re-save', !d.getElementById('confirmModal').classList.contains('show'), d.getElementById('confirmModalMsg').textContent);
run('blankCollectForm(); editingFeatureId=null;');

// 9. review column + query engine
const cols=run('attrTableColumns(savedFeatures).map(c=>c.label)');
t('the link is a Review column', cols.indexOf('In room')!==-1, cols.join(','));

// 10. restore sheet still healthy alongside all of this
run("openRestoreSheet(null,{source:'scan'})");
t('restore sheet still opens', d.getElementById('restoreModal').classList.contains('show'));
run('closeRestoreModal()');
t('restore sheet still closes', !d.getElementById('restoreModal').classList.contains('show'));

t('no errors across the whole sweep', errs.length===0, errs.join(' | '));

let bad=0;
out.forEach(([n,v,det])=>{if(!v)bad++;console.log((v?'  PASS  ':'  FAIL  ')+n+(v||!det?'':'\n        '+det));});
console.log(`\n  indoor-flow: ${out.length-bad}/${out.length} passed`);
process.exit(bad?1:0);
