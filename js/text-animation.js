(function(){
'use strict';
var trigger=document.getElementById('textAnimationBtn');if(!trigger)return;
var root=function(){return cs.getSystemPath('extension');};
var M=require(root()+'/js/text-editor-model.js');
var state={rows:[],words:[],context:null,batchId:null,applied:false},active=0,selection=null,anchor=null,busy=false,job=null,history=[],animation=null,liveTimer=null,textTimer=null,liveFailed=false;
// Each opening starts a new transcription; never restore a previous draft.
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
var overlay=el('div','dm-editor');overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','Text Animation');var panel=el('div','dm-panel');overlay.appendChild(panel);document.body.appendChild(overlay);
var head=el('div','dm-head');head.appendChild(el('h3','','Text Animation'));var close=el('button','','×');close.setAttribute('aria-label','Close Text Animation');head.appendChild(close);panel.appendChild(head);
var entry=el('div','dm-entry');panel.appendChild(entry);
var transcribe=el('button','dm-primary dm-transcribe','Transcribe');entry.appendChild(transcribe);var useSelected=button(entry,'Use selected text',function(){startEditor('selected');});useSelected.hidden=true;useSelected.parentNode.removeChild(useSelected);var entryHint=el('p','dm-hint dm-entry-hint','Select a layer with speech to transcribe, or select a text layer to animate it.');entry.appendChild(entryHint);
var status=el('div','dm-status');status.setAttribute('role','status');panel.appendChild(status);var cancelJob=el('button','','Cancel transcription');cancelJob.hidden=true;panel.appendChild(cancelJob);
var editor=el('div','dm-editor-body');panel.appendChild(editor);var details=el('details','dm-full-transcript');details.open=false;details.appendChild(el('summary','','Edit full transcript'));var full=el('textarea');full.setAttribute('aria-label','Full transcript');details.appendChild(full);editor.appendChild(details);
var grouping=el('div','dm-grouping');var wordsView=el('div','dm-words');wordsView.setAttribute('aria-label','Select transcript words');grouping.appendChild(wordsView);grouping.appendChild(el('p','dm-hint','Click a word, then Split here. Use Join next to combine this text with the next one.'));
var toolsBar=el('div','dm-tools');grouping.appendChild(toolsBar);
function button(parent,text,fn){var b=el('button','',text);parent.appendChild(b);b.addEventListener('click',fn);return b;}
var make=button(toolsBar,'Make box',makeSelection),split=button(toolsBar,'Split here',splitSelection),merge=button(toolsBar,'Join next',mergeNext),undo=button(toolsBar,'Undo edit',function(){if(!history.length)return;state=history.pop();selection=null;draw();scheduleLive();});
var work=el('div','dm-work');editor.appendChild(work);var previewDetails=el('details','dm-preview-details');previewDetails.appendChild(el('summary','','Motion preview'));previewDetails.hidden=true;var preview=el('div','dm-stage-wrap');previewDetails.appendChild(preview);previewDetails.addEventListener('toggle',function(){if(previewDetails.open&&state.rows.length)drawPreview();});var stage=el('div','dm-stage');preview.appendChild(stage);stage.appendChild(el('div','dm-safe'));var previewText=el('div','dm-preview-text');previewText.tabIndex=0;previewText.setAttribute('aria-label','Drag text position, or use arrow keys');stage.appendChild(previewText);var stageActions=el('div','dm-stage-actions');preview.appendChild(stageActions);stageActions.appendChild(el('span','','Motion preview'));var play=button(stageActions,'▶ Play',playPreview);preview.appendChild(el('p','dm-hint','Drag text to position it. Preview is approximate.'));
var listPane=el('div','dm-text-list');work.appendChild(listPane);var listHead=el('div','dm-list-head');var listTitle=el('h4','','Texts');listHead.appendChild(listTitle);listPane.appendChild(listHead);var cards=el('div','dm-cards');listPane.appendChild(cards);var inspector=el('div','dm-inspector');work.appendChild(inspector);var contentTitle=el('h4','','Content');inspector.appendChild(contentTitle);var textLabel=el('label','','');var textInput=el('textarea');textInput.rows=2;textInput.maxLength=160;textInput.setAttribute('aria-label','Selected text');textLabel.appendChild(textInput);inspector.appendChild(textLabel);var controls=el('div','dm-controls');inspector.appendChild(controls);
function select(label,options){var s=el('select');s.setAttribute('aria-label',label);options.forEach(function(v){var o=el('option','',v[1]);o.value=v[0];s.appendChild(o);});controls.appendChild(s);return s;}
var size=select('Text size',[['small','Small'],['large','Large']]);
['#000000','#ffffff'].forEach(function(color){var b=button(controls,'',function(){change(function(r){r.color=color;});});b.className='dm-swatch';b.style.background=color;b.setAttribute('aria-label',color==='#000000'?'Black text':'White text');});
button(controls,'Choose',function(){if(busy)return;evalScript('$.colorPicker('+parseInt(state.rows[active].color.slice(1),16)+');',function(raw){var n=Number(raw);if(raw&&n>=0&&n<=16777215)change(function(r){r.color='#'+('000000'+Math.floor(n).toString(16)).slice(-6);});});});
var motion=select('Legacy animation',[['up','↑ Bottom to top'],['down','↓ Top to bottom'],['right','→ Left to right'],['left','← Right to left'],['fade','Fade']]);var position=select('Position',[['top','Top'],['middle','Middle'],['bottom','Bottom'],['custom','Custom']]);
motion.hidden=true;
var timingDetails=el('details','dm-timing-details');timingDetails.appendChild(el('summary','','Text timing'));inspector.appendChild(timingDetails);var timing=el('div','dm-text-timing');timingDetails.appendChild(timing);
function timeInput(label){var wrap=el('label','',label),input=el('input');input.type='number';input.min=0;input.step=.05;input.setAttribute('aria-label',label);wrap.appendChild(input);timing.appendChild(wrap);return input;}
var rowStart=timeInput('Start (s)'),rowDuration=timeInput('On screen (s)');
rowStart.addEventListener('change',function(){var value=Number(rowStart.value);change(function(r){r.start=value;manualWords(r);});});
rowDuration.addEventListener('change',function(){var value=Number(rowDuration.value);change(function(r){r.duration=value;manualWords(r);});});
var presetDetails=el('section','dm-preset-details'),presetSummary=el('h4','','Animation');presetDetails.appendChild(presetSummary);editor.appendChild(presetDetails);
var scopeBar=el('div','dm-animation-scope'),scopeLabel=el('label','','Apply animation to'),scope=el('select');scope.setAttribute('aria-label','Apply animation to');
[['all','All texts'],['selected','Selected text only']].forEach(function(item){var option=el('option','',item[1]);option.value=item[0];scope.appendChild(option);});scopeLabel.appendChild(scope);scopeBar.appendChild(scopeLabel);var scopeHint=el('span','dm-hint');scopeBar.appendChild(scopeHint);presetDetails.appendChild(scopeBar);
scope.addEventListener('change',function(){state.animationScope=scope.value;draw();});
var presetEditor=window.DmTextPresetEditor(presetDetails,function(value){commit(function(){if(state.animationScope==='selected'){state.rows[active].preset=M.clone(value);state.rows[active].motion='none';}else{state.animationPreset=M.clone(value);state.rows.forEach(function(r){r.preset=M.clone(value);r.motion='none';});}});});
editor.appendChild(details);
var sourceLabel=el('span');
function defaultPreset(){return {id:'1-1-0',duration:.35,delay:.04,amount:45,direction:0,mode:0,easing:3,spring:35,seed:1};}
function manualWords(r){var tokens=r.text.trim().split(/\s+/),step=r.duration/Math.max(1,tokens.length);r._words=tokens.map(function(word,i){return {word:word,start:r.start+i*step,end:r.start+(i+1)*step};});}
function startEditor(mode,liveEditing){
 if(busy||HOST!=='AEFT')return;clearTimeout(liveTimer);clearTimeout(textTimer);lock(true);cancelJob.hidden=true;message('Reading composition…');
 evalScript('$.evalFile('+JSON.stringify(root()+'/jsx/text-animation.jsx')+');dmTextEditorContext();',function(raw){
  try{if(!raw||/^Error|EvalScript error/.test(raw))throw new Error(raw||'Open a composition first.');var info=JSON.parse(raw),rows;
   if(mode==='selected'){rows=info.rows;if(!rows.length)throw new Error('Select text layers in the timeline first.');}
   else {var start=Math.max(0,info.playhead),duration=Math.min(3,info.duration-start);if(duration<info.frameDuration*4)throw new Error('Move the playhead earlier to leave room for text.');rows=[{text:'Your text',style:'small',color:'#ffffff',motion:'none',position:'middle',xy:[.5,.5],start:start,duration:duration,preset:defaultPreset()}];}
   rows.forEach(function(r){manualWords(r);});state={rows:rows,words:[],context:info,batchId:'text_'+Date.now()+'_'+Math.random().toString(36).slice(2,10),applied:!!liveEditing,manual:true};active=0;history=[];liveFailed=false;message(mode==='selected'?'Choose an animation for the selected text layers.':'Write your text, choose an animation, then Apply.');
  }catch(e){message(e.message,true);}finally{lock(false);draw();}
 });
}
var addTextButton=button(listHead,'+ Add',addText);addTextButton.setAttribute('aria-label','Add text');var rowTools=el('div','dm-tools');inspector.appendChild(rowTools);var removeTextButton=button(rowTools,'Remove text',function(){if(state.rows.length<2)return;commit(function(){state.rows.splice(active,1);active=Math.max(0,active-1);});});
var footer=el('div','dm-footer');panel.appendChild(footer);var syncHint=el('span','dm-hint');footer.appendChild(syncHint);var removeEffects=button(footer,'Remove effects',function(){if(busy||!state.rows.length)return;commit(function(){if(state.animationScope==='selected'){state.rows[active].preset=null;state.rows[active].motion='none';}else{state.animationPreset=null;state.rows.forEach(function(r){r.preset=null;r.motion='none';});}});applyText(false);});var apply=button(footer,'Apply',function(){applyText(false);});apply.className='dm-primary';
function message(text,error){status.hidden=!error&&!busy;status.textContent=text||'';status.className='dm-status'+(error?' error':'');if(error)status.scrollIntoView({block:'nearest'});}
function lock(value){busy=value;Array.prototype.forEach.call(panel.querySelectorAll('button,input,select,textarea'),function(e){e.disabled=value;});cancelJob.hidden=!value;cancelJob.disabled=false;cancelJob.hidden=!value;}
function snapshot(){history.push(M.clone(state));if(history.length>20)history.shift();}
function commit(fn){if(busy)return;var before=M.clone(state);try{fn();state.rows.forEach(function(r){if(!isFinite(r.start)||!isFinite(r.duration)||r.start<0||r.duration<state.context.frameDuration*4||r.start+r.duration>state.context.duration+.00001)throw new Error('Keep each text inside the composition and at least four frames long.');});if(state.rows.length>120)throw new Error('Maximum 120 boxes.');history.push(before);if(history.length>20)history.shift();selection=null;draw();scheduleLive();}catch(e){state=before;draw();message(e.message,true);}}
function change(fn){commit(function(){fn(state.rows[active]);});}
function draw(){
 status.hidden=!busy&&!status.classList.contains('error');
 var editing=document.activeElement===textInput,cursor=textInput.selectionStart;
 var ready=state.rows.length>0;editor.hidden=!ready;apply.hidden=!ready||state.applied;apply.textContent='Apply';entry.hidden=ready;footer.hidden=!ready;syncHint.textContent=state.applied?'Changes sync automatically.':'Ready to apply to After Effects.';undo.disabled=!history.length;removeEffects.disabled=!ready||(!state.applied&&!state.rows[active].sourceLayerId);if(!ready){presetEditor.stop();return;}
 var ids={};state.rows.forEach(function(r){if(!r.uid||ids[r.uid])r.uid='r_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);ids[r.uid]=true;});active=Math.max(0,Math.min(active,state.rows.length-1));state.rows=state.rows.map(function(r){r=M.defaults(r);if(r.preset===undefined)r.preset=defaultPreset();return r;});details.hidden=!!state.manual;state.animationScope=state.animationScope||'all';if(state.animationPreset===undefined)state.animationPreset=M.clone(state.rows[0].preset);scope.value=state.animationScope;listTitle.textContent='Texts ('+state.rows.length+')';var single=state.rows.length===1,existing=!!state.rows[active].sourceLayerId;inspector.hidden=existing;work.hidden=existing;listPane.hidden=single||existing;scopeBar.hidden=existing;if(existing){state.animationScope='all';scope.value='all';}work.classList.toggle('dm-single-text',single||existing);addTextButton.hidden=existing;removeTextButton.hidden=single||existing;if(single)rowTools.insertBefore(addTextButton,rowTools.firstChild);else listHead.appendChild(addTextButton);contentTitle.textContent=single?'Text':'Text '+(active+1)+' of '+state.rows.length;sourceLabel.textContent=existing?state.rows.length+' selected text layer'+(state.rows.length===1?'':'s'):'From transcription';scopeHint.textContent=state.animationScope==='all'?'Choose a preset for all '+state.rows.length+' texts.':'Editing animation for text '+(active+1)+'.';position.disabled=!!state.rows[active].sourceLayerId;full.value=state.rows.map(function(r){return r.text;}).join(' ');
 wordsView.textContent='';M.tokens(state.rows).forEach(function(t,i){if(t.row!==active)return;var b=el('button','dm-word',t.data.word);b.dataset.index=i;b.setAttribute('aria-label','Word '+(i+1)+': '+t.data.word);if(t.word===state.rows[t.row]._words.length-1)b.classList.add('group-end');wordsView.appendChild(b);});
 cards.textContent='';state.rows.forEach(function(r,i){var b=el('button','dm-card'+(i===active?' active':''));b.appendChild(el('small','',String(i+1).padStart(2,'0')+' · '+r.start.toFixed(1)+'–'+(r.start+r.duration).toFixed(1)+'s'));b.appendChild(el('span','',r.text));b.addEventListener('click',function(){active=i;selection=null;draw();selectInAE();});b.setAttribute('aria-pressed',i===active?'true':'false');cards.appendChild(b);});
 var r=state.rows[active];rowStart.value=r.start;rowDuration.value=r.duration;presetEditor.set(state.animationScope==='selected'?r.preset:state.animationPreset,r.text);textInput.value=r.text;size.value=r.style;motion.value=r.motion;position.value=r.position==='custom'?'custom':r.position;drawSelection();drawPreview();if(editing){textInput.focus();textInput.setSelectionRange(cursor,cursor);}
}
function drawSelection(){Array.prototype.forEach.call(wordsView.children,function(b){var i=Number(b.dataset.index);var selected=selection&&i>=selection[0]&&i<=selection[1];b.classList.toggle('selected',!!selected);b.setAttribute('aria-pressed',selected?'true':'false');});make.disabled=!selection;split.disabled=!selection;merge.disabled=active>=state.rows.length-1;}
var selecting=false;
wordsView.addEventListener('pointerdown',function(e){var b=e.target.closest('.dm-word');if(!b||busy)return;e.preventDefault();var i=Number(b.dataset.index);if(!e.shiftKey||anchor===null)anchor=i;selection=[Math.min(anchor,i),Math.max(anchor,i)];selecting=true;drawSelection();});
wordsView.addEventListener('pointerover',function(e){if(!selecting)return;var b=e.target.closest('.dm-word');if(!b)return;var i=Number(b.dataset.index);selection=[Math.min(anchor,i),Math.max(anchor,i)];drawSelection();});
document.addEventListener('pointerup',function(){selecting=false;});
wordsView.addEventListener('keydown',function(e){if(e.key!=='Enter'&&e.key!==' ')return;var i=Number(e.target.dataset.index);if(!isFinite(i))return;e.preventDefault();if(!e.shiftKey||anchor===null)anchor=i;selection=[Math.min(anchor,i),Math.max(anchor,i)];drawSelection();});
function makeSelection(){if(!selection)return;commit(function(){var result=M.makeBox(state.rows,selection[0],selection[1],state.context.frameDuration,state.context.duration);state.rows=result.rows;active=result.active;});}
function splitSelection(){if(!selection)return;commit(function(){var t=M.tokens(state.rows)[selection[1]];state.rows=M.split(state.rows,t.row,t.word,state.context.frameDuration,state.context.duration);active=t.row;});}
function mergeNext(){commit(function(){state.rows=M.merge(state.rows,active,state.context.frameDuration,state.context.duration);});}
function drawPreview(){if(!previewDetails.open)return;if(animation)animation.cancel();var r=state.rows[active],w=state.context.width||1080,h=state.context.height||1920,available=preview.clientWidth-22,sw=Math.min(available,260*w/h),sh=sw*h/w;stage.style.width=sw+'px';stage.style.height=sh+'px';previewText.textContent=r.text;previewText.style.fontWeight=r.style==='large'?'700':'400';previewText.style.fontSize=(sw*(r.style==='large'?.1:.058))+'px';previewText.style.color=r.color;previewText.style.opacity='1';previewText.style.left=r.xy[0]*100+'%';previewText.style.top=r.xy[1]*100+'%';var fit=Math.min(1,sw*.84/Math.max(1,previewText.scrollWidth),sh*.16/Math.max(1,previewText.scrollHeight));previewText.style.fontSize=(parseFloat(previewText.style.fontSize)*fit)+'px';previewText.style.transform='translate(-50%,-50%)';}
function playPreview(){if(!state.rows.length||!previewDetails.open)return;drawPreview();var r=state.rows[active],d=Math.min(stage.clientWidth,stage.clientHeight)*.055,delta={up:[0,d],down:[0,-d],right:[-d,0],left:[d,0],fade:[0,0]}[r.motion],duration=r.duration*1000,part=Math.min(.3,r.duration/3)/r.duration;function tr(x,y){return 'translate(calc(-50% + '+x+'px),calc(-50% + '+y+'px))';}animation=previewText.animate([{transform:tr(delta[0],delta[1]),opacity:0,offset:0},{transform:tr(0,0),opacity:1,offset:part},{transform:tr(0,0),opacity:1,offset:1-part},{transform:tr(-delta[0],-delta[1]),opacity:0,offset:1}],{duration:duration,easing:'ease-in-out'});animation.onfinish=function(){drawPreview();};}
var dragging=false,dragBefore=null;
previewText.addEventListener('pointerdown',function(e){if(busy)return;if(animation)animation.cancel();dragBefore=M.clone(state);dragging=true;previewText.setPointerCapture(e.pointerId);e.preventDefault();});
previewText.addEventListener('pointermove',function(e){if(!dragging)return;var bounds=stage.getBoundingClientRect(),r=state.rows[active];r.xy=[Math.max(0,Math.min(1,(e.clientX-bounds.left)/bounds.width)),Math.max(0,Math.min(1,(e.clientY-bounds.top)/bounds.height))];r.position='custom';previewText.style.left=r.xy[0]*100+'%';previewText.style.top=r.xy[1]*100+'%';position.value='custom';});
function endDrag(){if(!dragging)return;dragging=false;history.push(dragBefore);if(history.length>20)history.shift();undo.disabled=false;}
previewText.addEventListener('pointerup',endDrag);previewText.addEventListener('pointercancel',endDrag);
previewText.addEventListener('keydown',function(e){var move={ArrowLeft:[-.01,0],ArrowRight:[.01,0],ArrowUp:[0,-.01],ArrowDown:[0,.01]}[e.key];if(!move)return;e.preventDefault();change(function(r){r.xy=[Math.max(0,Math.min(1,r.xy[0]+move[0])),Math.max(0,Math.min(1,r.xy[1]+move[1]))];r.position='custom';});});
window.addEventListener('resize',function(){if(overlay.style.display==='flex'&&state.rows.length)drawPreview();});
motion.addEventListener('change',function(){var v=motion.value;change(function(r){r.motion=v;});});
position.addEventListener('change',function(){var v=position.value;change(function(r){r.position=v;if(v!=='custom')r.xy=[.5,{top:.25,middle:.5,bottom:.75}[v]];});});
size.addEventListener('change',function(){var value=size.value;commit(function(){var r=state.rows[active];r.style=value;r.motion='none';if(state.manual)return;var grouped=DmTranscribe.autoGroup(r._words,value,state.context.duration,state.context.frameDuration);grouped.forEach(function(v,i){if(i===0)v.uid=r.uid;v.color=r.color;v.xy=r.xy.slice();v.position=r.position;v.preset=M.clone(r.preset);});state.rows.splice.apply(state.rows,[active,1].concat(grouped));});});
function commitText(){clearTimeout(textTimer);if(!state.rows.length)return;var text=textInput.value;if(text===state.rows[active].text)return;commit(function(){state.rows[active].text=text;if(state.manual)manualWords(state.rows[active]);else state.rows=DmTranscribe.timeRows(state.rows,state.words,state.context.duration,state.context.frameDuration);});}
textInput.addEventListener('change',commitText);textInput.addEventListener('input',function(){clearTimeout(textTimer);textTimer=setTimeout(commitText,500);});
full.addEventListener('change',async function(){if(busy||!state.context)return;var original=M.clone(state);try{lock(true);message('Grouping phrases by meaning…');var edited=DmTranscribe.retimeWords(state.words,full.value);job=DmTranscribe.semanticJob(edited,root());var words=await job.promise;history.push(original);state.words=words;state.rows=DmTranscribe.autoGroup(words,'small',state.context.duration,state.context.frameDuration).map(function(r){var old=original.rows.filter(function(x){return r.start>=x.start&&r.start<x.start+x.duration;})[0];if(old){r.color=old.color;r.xy=old.xy;r.position=old.position;r.style=old.style;r.motion=old.motion;r.preset=M.clone(old.preset);}return r;}).reduce(function(out,r){var pieces=DmTranscribe.autoGroup(r._words,r.style,state.context.duration,state.context.frameDuration);pieces.forEach(function(p){p.color=r.color;p.xy=r.xy;p.position=r.position;p.motion=r.motion;p.preset=r.preset===undefined?defaultPreset():M.clone(r.preset);});return out.concat(pieces);},[]);message('Transcript updated.');}catch(e){state=original;message(e.message,true);}finally{job=null;lock(false);draw();scheduleLive();}});
function addText(){commit(function(){var previous=state.rows[state.rows.length-1],start=state.manual?Math.max(0,state.context.playhead||0):previous.start+previous.duration,end=Math.min(state.context.duration,start+(state.manual?3:1.5));if(end-start<state.context.frameDuration*4)throw new Error('No space after the last text. Shorten its duration in Text timing first.');state.rows.push({text:'Your text',style:'small',color:'#ffffff',motion:'none',preset:M.clone(state.rows[active].preset),position:'middle',xy:[.5,.5],start:start,duration:end-start,_words:[{word:'Your',start:start,end:start+(end-start)/2},{word:'text',start:start+(end-start)/2,end:end}]});active=state.rows.length-1;});}
transcribe.addEventListener('click',function(){if(busy||HOST!=='AEFT')return;var provider=localStorage.getItem('dm-transcription-provider')||'local',key;try{if(provider!=='local'){key=(DmSecureStore.get('ai-config')||{})[provider+'_transcription_key'];if(!key)throw new Error('Save your API key in Settings first.');}}catch(e){message(e.message,true);return;}lock(true);message('Reading selected layer…');var aborted=false;job={cancel:function(){aborted=true;}};
 evalScript('$.evalFile('+JSON.stringify(root()+'/jsx/transcribe.jsx')+');dmSelectedSpeech();',function(raw){try{if(aborted)throw new Error('Transcription cancelled.');if(/^Error/.test(raw))throw new Error(raw);var info=JSON.parse(raw);job=DmTranscribe.transcribe(info,key,root(),function(m){message(m);},provider);key=null;job.promise.then(function(words){history=[];state={rows:DmTranscribe.autoGroup(words,'small',info.duration,info.frameDuration),words:words,context:{compId:info.compId,timelineStart:info.timelineStart,duration:info.duration,frameDuration:info.frameDuration,width:info.width,height:info.height},batchId:'text_'+Date.now()+'_'+Math.random().toString(36).slice(2,10),applied:false};active=0;selection=null;message('Choose a text box to edit.');job=null;lock(false);draw();}).catch(function(e){job=null;lock(false);message(e.message,true);});}catch(e){job=null;lock(false);message(e.message,true);}});
});
cancelJob.addEventListener('click',function(){if(job)job.cancel();});
function scheduleLive(){clearTimeout(liveTimer);if(state.applied)liveTimer=setTimeout(function(){if(busy){scheduleLive();return;}applyText(true);},200);}
function selectInAE(){if(!state.applied||busy)return;evalScript('$.evalFile('+JSON.stringify(root()+'/jsx/text-animation.jsx')+');dmSelectManagedText('+JSON.stringify(state.context.compId)+','+JSON.stringify(state.batchId)+','+JSON.stringify(state.rows[active].uid)+');',function(r){if(/^Error/.test(r))message(r,true);});}
function applyText(live){clearTimeout(liveTimer);if(busy||!state.rows.length)return;try{presetEditor.get();}catch(presetError){message(presetError.message,true);return;}if(!state.rows[active].sourceLayerId&&textInput.value!==state.rows[active].text)commitText();clearTimeout(liveTimer);var scrollBefore=panel.scrollTop,editing=document.activeElement===textInput,cursor=textInput.selectionStart;lock(true);message(state.applied?'Updating text layers…':'Creating text layers…');var context={compId:state.context.compId,timelineStart:state.context.timelineStart,batchId:state.batchId,live:!!live,followSelection:!!state.rows[0].sourceLayerId};var values=state.rows.map(function(r){var row=M.clone(r);delete row._words;if(row.position==='custom')row.position='middle';return row;});
 evalScript('$.evalFile('+JSON.stringify(root()+'/js/text-presets-model.js')+');$.evalFile('+JSON.stringify(root()+'/jsx/text-presets.jsx')+');$.evalFile('+JSON.stringify(root()+'/jsx/text-animation.jsx')+');dmApplyTextTemplate('+JSON.stringify(root()+'/assets/text-animation/template.aep')+',"opening",'+JSON.stringify(values)+','+JSON.stringify(context)+');',function(result){lock(false);if(/^Error: Selection changed/.test(result||'')){startEditor('selected',state.applied);return;}if(!result||/^Error|EvalScript error/.test(result)){liveFailed=true;message((result||'Could not apply text.')+' Could not sync this change. Fix the issue and adjust the setting again.',true);return;}liveFailed=false;state.applied=true;draw();message('Texts updated.');setStatus(result,'success');panel.scrollTop=scrollBefore;if(editing){textInput.focus();textInput.setSelectionRange(cursor,cursor);}});}
var selectionEpoch=0;
function routeTextEditor(){
 var epoch=selectionEpoch;lock(true);entry.hidden=true;cancelJob.hidden=true;message('Reading selected layers…');
 var script='$.evalFile('+JSON.stringify(root()+'/jsx/text-animation.jsx')+');dmCountSelectedText();';
 evalScript(script,function(raw){
  lock(false);
  if(epoch!==selectionEpoch||overlay.style.display!=='flex')return;
  if(/^\d+$/.test(String(raw))&&Number(raw)>0){startEditor('selected');return;}
  entry.hidden=false;message('Select a layer with speech, then click Transcribe.');transcribe.focus();
 });
}
var selectionProbeBusy=false;
function followExistingSelection(){
 if(selectionProbeBusy||busy||overlay.style.display!=='flex'||document.hidden)return;
 var epoch=selectionEpoch,current=state.context&&state.rows.length?state.context.compId+':'+state.rows.map(function(r){return r.sourceLayerId;}).sort(function(a,b){return a-b;}).join(','):'';
 selectionProbeBusy=true;
 evalScript('if(typeof dmSelectedTextIdentity!=="function"){$.evalFile('+JSON.stringify(root()+'/jsx/text-animation.jsx')+');}dmSelectedTextIdentity();',function(identity){
  selectionProbeBusy=false;
  if(epoch!==selectionEpoch||busy||overlay.style.display!=='flex'||!identity||/^Error/.test(identity))return;
  if(identity!==current)startEditor('selected',state.applied);
 });
}
function followTimelineSelection(){
 if(HOST==='AEFT'&&(!state.rows.length||state.rows[0].sourceLayerId)){followExistingSelection();return;}
 if(HOST!=='AEFT'||busy||selectionProbeBusy||!state.applied||!state.context||overlay.style.display!=='flex'||document.hidden)return;
 // Do not replace an in-progress edit while the user is typing in the panel.
 if(document.hasFocus()&&/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))return;
 var batch=state.batchId,comp=state.context.compId,selectedBefore=active;
 selectionProbeBusy=true;
 var script='if(typeof dmGetSelectedManagedText!=="function"){$.evalFile('+JSON.stringify(root()+'/jsx/text-animation.jsx')+');}dmGetSelectedManagedText('+JSON.stringify(comp)+','+JSON.stringify(batch)+');';
 evalScript(script,function(uid){
  selectionProbeBusy=false;
  if(busy||state.batchId!==batch||active!==selectedBefore||overlay.style.display!=='flex'||!uid||/^Error|EvalScript error/.test(uid))return;
  if(document.hasFocus()&&/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))return;
  for(var i=0;i<state.rows.length;i++)if(state.rows[i].uid===uid){
   if(i!==active){active=i;selection=null;draw();var card=cards.querySelector('.dm-card.active');if(card)card.scrollIntoView({block:'nearest'});}
   break;
  }
 });
}
setInterval(followTimelineSelection,400);
function hide(){if(busy)return;selectionEpoch++;presetEditor.stop();if(animation)animation.cancel();overlay.style.display='none';trigger.focus();}close.addEventListener('click',hide);overlay.addEventListener('keydown',function(e){if(e.key==='Escape')hide();if(e.key==='Tab'){var focusable=Array.prototype.filter.call(panel.querySelectorAll('button,input,select,textarea,[tabindex]'),function(x){return !x.disabled&&x.offsetParent!==null;}),first=focusable[0],last=focusable[focusable.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
trigger.addEventListener('click',function(){
 if(HOST!=='AEFT'||busy)return;
 selectionEpoch++;
 clearTimeout(liveTimer);clearTimeout(textTimer);liveTimer=null;textTimer=null;
 if(animation){animation.cancel();animation=null;}
 state={rows:[],words:[],context:null,batchId:null,applied:false};
 active=0;selection=null;anchor=null;history=[];liveFailed=false;selecting=false;dragging=false;
 full.value='';textInput.value='';cards.textContent='';previewText.textContent='';
 previewDetails.open=false;timingDetails.open=false;details.open=false;presetEditor.stop();useSelected.hidden=true;message('');cancelJob.hidden=true;
 overlay.style.display='flex';draw();panel.scrollTop=0;
 routeTextEditor();
});
})();
