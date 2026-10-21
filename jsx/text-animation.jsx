/* Private ES3 JSON codec: ExtendScript does not guarantee a global JSON object. */
var dmTextJSON=(function(){
 function quote(s){return '"'+s.replace(/[\\"\x00-\x1f]/g,function(c){var codes={'"':'\\"','\\':'\\\\','\b':'\\b','\f':'\\f','\n':'\\n','\r':'\\r','\t':'\\t'};return codes[c]||'\\u'+('0000'+c.charCodeAt(0).toString(16)).slice(-4);})+'"';}
 function stringify(v){var a=[],k,t=typeof v;if(v===null)return 'null';if(t==='string')return quote(v);if(t==='number')return isFinite(v)?String(v):'null';if(t==='boolean')return String(v);if(t!=='object')return undefined;if(Object.prototype.toString.call(v)==='[object Array]'){for(k=0;k<v.length;k++)a.push(stringify(v[k])||'null');return '['+a.join(',')+']';}for(k in v)if(Object.prototype.hasOwnProperty.call(v,k)){var value=stringify(v[k]);if(value!==undefined)a.push(quote(k)+':'+value);}return '{'+a.join(',')+'}';}
 function parse(s){var i=0,depth=0;s=String(s);function fail(){throw new Error('Invalid text metadata.');}function ws(){while(/[\x20\t\r\n]/.test(s.charAt(i))&&i<s.length)i++;}
 function str(){var out='';i++;while(i<s.length){var c=s.charAt(i++);if(c==='"')return out;if(c==='\\'){c=s.charAt(i++);if(c==='u'){var hex=s.substr(i,4);if(!/^[0-9a-fA-F]{4}$/.test(hex))fail();out+=String.fromCharCode(parseInt(hex,16));i+=4;}else{var escapes={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!Object.prototype.hasOwnProperty.call(escapes,c))fail();out+=escapes[c];}}else{if(c.charCodeAt(0)<32)fail();out+=c;}}fail();}
 function value(){ws();if(++depth>40)fail();var c=s.charAt(i),v,k,m;if(c==='"')v=str();else if(c==='{'||c==='['){var obj=c==='{',end=obj?'}':']';v=obj?{}:[];i++;ws();if(s.charAt(i)!==end){while(true){if(obj){if(s.charAt(i)!=='"')fail();k=str();if(k==='__proto__'||k==='constructor'||k==='prototype')fail();ws();if(s.charAt(i++)!==':')fail();v[k]=value();}else v.push(value());ws();if(s.charAt(i)===end)break;if(s.charAt(i++)!==',')fail();ws();}}if(s.charAt(i++)!==end)fail();}else if(s.substr(i,4)==='true'){v=true;i+=4;}else if(s.substr(i,5)==='false'){v=false;i+=5;}else if(s.substr(i,4)==='null'){v=null;i+=4;}else{m=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(s.substring(i));if(!m)fail();i+=m[0].length;v=Number(m[0]);if(!isFinite(v))fail();}depth--;return v;}
 var result=value();ws();if(i!==s.length)fail();return result;}
 return {parse:parse,stringify:stringify};
})();
/* Editable 2D text. Fonts from the template; deterministic layout and native keyframes. */
function dmRegularTextFont(style){
 var family=style.fontFamily;
 // Resolve an installed regular face from the same template font family.
 if(family&&app.fonts){var families=app.fonts.allFonts;for(var f=0;f<families.length;f++)for(var v=0;v<families[f].length;v++){
  var face=families[f][v];if(face.familyName===family&&/^(regular|normal|roman|book)$/i.test(face.styleName))return face.postScriptName;
 }}
 var name=style.font;
 if(/^Helvetica-/.test(name))return 'Helvetica';
 return name.replace(/[- ]?(SemiBold|DemiBold|ExtraBold|Bold|Black|Heavy|Medium)(Italic)?$/i,'-Regular');
}
function dmApplyTextTemplate(templatePath,model,values,context){
 var groups={opening:['Before 2','I reveal 2','Let 2','me 3','show you 3'],property:['why this 2','three-level 2','residence 2','is 2','so 2','special. 2'],closing:['Now 3','it’s','over to you']};
 var target=app.project.activeItem,names=groups[model],file=new File(templatePath),i,j;
 if(!(target instanceof CompItem))return 'Error: Open the destination composition first.';
 if(!names||!values||values.length<1||values.length>120)return 'Error: Choose 1–120 text boxes.';
 if(!file.exists&&!values[0].sourceLayerId)return 'Error: The text template is missing.';
 if(context && (context.compId!==target.id || typeof context.timelineStart!=='number' || !isFinite(context.timelineStart)))return 'Error: Open the composition used for transcription.';
 if(context&&context.previewTime!==undefined&&(typeof context.previewTime!=='number'||!isFinite(context.previewTime)||context.previewTime<0||context.previewTime>=target.duration))return 'Error: Invalid preview time.';
 var start=context?context.timelineStart:target.time,frame=target.frameDuration;
 var batch=context&&context.batchId?String(context.batchId):null,previous=[],managed={},meta={},seen={},changed=0;
 if(batch&&!/^[A-Za-z0-9_-]{8,80}$/.test(batch))return 'Error: Invalid text session.';
 if(batch)for(var z=1;z<=target.numLayers;z++){
 var candidate=target.layer(z),comment=candidate.comment||'';
 if(comment==='DM_TEXT_BATCH:'+batch)previous.push(candidate);
 if(comment.indexOf('DM_TEXT_V3:')===0){try{var m=dmTextJSON.parse(comment.substring(11));if(m.batch===batch){if(managed[m.row.uid])return 'Error: Duplicate managed text. Remove the duplicate first.';managed[m.row.uid]=candidate;meta[m.row.uid]=m;}}catch(e){}}
 }
 for(i=0;i<values.length;i++){
  var r=values[i];if(!r.uid)r.uid='row_'+i;if(!/^[A-Za-z0-9_-]{1,80}$/.test(r.uid)||seen[r.uid])return 'Error: Invalid text identifier.';seen[r.uid]=true;
  if(r.preset){try{DMTextPresets.validate(r.preset);}catch(presetError){return 'Error: '+presetError.message;}}
  if(r.sourceLayerId){var sourceFound=null;for(var si=1;si<=target.numLayers;si++)if(target.layer(si).id===r.sourceLayerId)sourceFound=target.layer(si);if(!sourceFound||!sourceFound.property('ADBE Text Properties'))return 'Error: An original text layer is missing. Reopen Text Animation and select it again.';if(sourceFound.locked)return 'Error: Unlock the selected text layers first.';}
  if(!r||typeof r.text!=='string'||!r.text.replace(/\s/g,'')||r.text.length>160||!/^(large|small)$/.test(r.style)||!/^#[0-9a-fA-F]{6}$/.test(r.color)||!/^(up|down|left|right|fade|none)$/.test(r.motion)||!/^(top|middle|bottom)$/.test(r.position))return 'Error: Check text settings.';
  if(r.xy&&(!(r.xy instanceof Array)||r.xy.length!==2||!isFinite(r.xy[0])||!isFinite(r.xy[1])||r.xy[0]<0||r.xy[0]>1||r.xy[1]<0||r.xy[1]>1))return 'Error: Invalid text position.';
  if(typeof r.start!=='number'||typeof r.duration!=='number'||!isFinite(r.start)||!isFinite(r.duration)||r.start<0||r.duration<frame*4)return 'Error: Each text needs a valid start and at least four frames of duration.';
  if(start+r.start<0||start+r.start+r.duration>target.duration+0.00001)return 'Error: Text '+(i+1)+' extends beyond the composition. Shorten its duration or move the playhead earlier.';
 }
 if(context&&context.followSelection){var expectedIds=[];for(i=0;i<values.length;i++)expectedIds.push(values[i].sourceLayerId);expectedIds.sort(function(a,b){return a-b;});if(dmSelectedTextIdentity()!==target.id+':'+expectedIds.join(','))return 'Error: Selection changed. Choose the animation for the newly selected text.';}
 var replacing=false,folder=null,created=[],before=[],templates=[],large=null,small=null;
 for(i=1;i<=app.project.numItems;i++)before.push(app.project.item(i).id);
 app.beginUndoGroup('DM Text Animation');
 try{
  for(var existingId in meta){large={font:meta[existingId].large};small={font:meta[existingId].small};break;}
  if((!large||!small)&&values[0].sourceLayerId){for(var fontIndex=1;fontIndex<=target.numLayers;fontIndex++)if(target.layer(fontIndex).id===values[0].sourceLayerId){var sourceDoc=target.layer(fontIndex).property('ADBE Text Properties').property('ADBE Text Document').value;large={font:sourceDoc.font};small={font:sourceDoc.font};break;}}
  if(!large||!small){
  folder=app.project.importFile(new ImportOptions(file));
  for(i=1;i<=app.project.numItems;i++){
   var item=app.project.item(i),known=false;for(j=0;j<before.length;j++)if(before[j]===item.id)known=true;
   if(known||!(item instanceof CompItem))continue;
   var count=0;for(j=0;j<names.length;j++)for(var k=1;k<=item.numLayers;k++)if(item.layer(k).name===names[j]){count++;break;}
   if(count===names.length)templates.push(item);
  }
  if(templates.length!==1)throw new Error('Could not identify the template.');
  var source=templates[0];
  // Use the named headline and supporting text fonts, regardless of saved transform scale.
  var headline=names[model==='property'?1:0],support=names[model==='property'?0:1];
  for(i=1;i<=source.numLayers;i++){
   var l=source.layer(i);
   if(l.name===headline)large=l.property('ADBE Text Properties').property('ADBE Text Document').value;
   if(l.name===support)small=l.property('ADBE Text Properties').property('ADBE Text Document').value;
  }
  if(!large||!small)throw new Error('Template font styles are missing.');
 small={font:dmRegularTextFont(small)};
 }
  for(i=values.length-1;i>=0;i--){
   var row=values[i],t0=start+row.start,t1=t0+row.duration;
   var layer=managed[row.uid],old=meta[row.uid]?meta[row.uid].row:null;
   if(!layer&&row.sourceLayerId){for(var sourceIndex=1;sourceIndex<=target.numLayers;sourceIndex++)if(target.layer(sourceIndex).id===row.sourceLayerId)layer=target.layer(sourceIndex);old=row.sourceBaseline||null;}
   function same(key){return old&&dmTextJSON.stringify(old[key])===dmTextJSON.stringify(row[key]);}
   var migrate=old&&meta[row.uid]&&meta[row.uid].edgeMotion!==1;
   if(old&&meta[row.uid]&&!migrate&&same('text')&&same('style')&&same('color')&&same('motion')&&same('position')&&same('xy')&&same('start')&&same('duration')&&same('preset'))continue;
   if(layer&&(layer.locked||(!row.sourceLayerId&&(layer.parent||layer.threeDLayer))))throw new Error('Unlock and unparent this 2D text layer before editing.');
   var fresh=!layer;if(fresh){layer=target.layers.addText(row.text);created.push(layer);}changed++;
   if(!row.sourceLayerId)layer.name='DM Text '+(i+1)+' — '+row.text.substring(0,35);
   if(fresh){layer.threeDLayer=false;layer.startTime=t0;layer.motionBlur=true;}
   var timing=fresh||!same('start')||!same('duration'),layout=fresh||!same('text')||!same('style'),movement=migrate||timing||!same('motion')||!same('position')||!same('xy');
   if(timing){layer.inPoint=t0;layer.outPoint=t1;}
   if(layout||!same('color')){
   var prop=layer.property('ADBE Text Properties').property('ADBE Text Document'),doc=prop.value,style=row.style==='large'?large:small;
   if(layout){if(!row.sourceLayerId||!same('style')){doc.font=style.font;doc.fauxBold=false;doc.fauxItalic=false;doc.fontSize=target.width*(row.style==='large'?0.10:0.058);doc.justification=ParagraphJustification.CENTER_JUSTIFY;doc.applyFill=true;doc.applyStroke=false;doc.tracking=-28;}doc.text=row.text;} 
   doc.fillColor=[parseInt(row.color.substr(1,2),16)/255,parseInt(row.color.substr(3,2),16)/255,parseInt(row.color.substr(5,2),16)/255];prop.setValue(doc);
   if(layout&&!row.sourceLayerId){var measureTime=(layer.inPoint+layer.outPoint)/2,rect=layer.sourceRectAtTime(measureTime,false),fit=Math.min(1,target.width*0.84/Math.max(1,rect.width),target.height*0.16/Math.max(1,rect.height));
   if(fit<1){doc.fontSize*=fit;prop.setValue(doc);rect=layer.sourceRectAtTime(measureTime,false);}
   var tr=layer.property('ADBE Transform Group');tr.property('ADBE Anchor Point').setValue([rect.left+rect.width/2,rect.top+rect.height/2]);
   if(fresh)tr.property('ADBE Scale').setValue([100,100]);}}
   var presetChanged=fresh||!same('preset');
   if(movement||presetChanged){var tr=layer.property('ADBE Transform Group');
   var pos=tr.property('ADBE Position'),opacity=tr.property('ADBE Opacity'),rest=[target.width/2,target.height*({top:0.25,middle:0.5,bottom:0.75}[row.position])];
   if(row.xy)rest=[target.width*row.xy[0],target.height*row.xy[1]];
   var distance=Math.min(target.width,target.height)*0.055,delta={up:[0,distance],down:[0,-distance],left:[distance,0],right:[-distance,0],fade:[0,0],none:[0,0]}[row.motion];
   // Keep a manually positioned layer when only converting old animation.
   if(migrate&&same('position')&&same('xy'))rest=pos.valueAtTime((layer.inPoint+layer.outPoint)/2,false);
   if(!row.sourceLayerId){
   pos.expression='';opacity.expression='';
   while(pos.numKeys)pos.removeKey(pos.numKeys);while(opacity.numKeys)opacity.removeKey(opacity.numKeys);
   pos.setValue(rest);opacity.setValue(100);
   if(!row.preset&&row.motion!=='none'){
   var edge="var d=Math.max(0.0001,Math.min(0.3,(outPoint-inPoint)/3));\nfunction sm(x){x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);}\nvar a=sm((time-inPoint)/d),b=sm((outPoint-time)/d);\n";
   pos.expression=edge+"var q=b-a;[value[0]+("+delta[0]+")*q,value[1]+("+delta[1]+")*q];";
   opacity.expression=edge+"value*a*b;";
   if(pos.expressionError||opacity.expressionError)throw new Error('Could not set text animation expressions.');
   }
   }else if(!same('position')||!same('xy')){
    if(pos.numKeys||pos.expressionEnabled)throw new Error('This text has animated position. Adjust its position in the timeline.');
    pos.setValue(rest);
   }
   }
   if(row.sourceLayerId&&row.sourceOwnedMotion&&presetChanged&&row.preset){var ownedTr=layer.property('ADBE Transform Group'),ownedPos=ownedTr.property('ADBE Position'),ownedOpacity=ownedTr.property('ADBE Opacity');if(ownedPos.expression.indexOf('var d=Math.max(0.0001,Math.min(0.3,')===0)ownedPos.expression='';if(ownedOpacity.expression.indexOf('var d=Math.max(0.0001,Math.min(0.3,')===0)ownedOpacity.expression='';}
   if(presetChanged){var presetResult=dmTextPresetsRun(row.preset||{},!row.preset,[layer],true);if(presetResult.indexOf('Error:')===0)throw new Error(presetResult.replace(/^(Error:\s*)+/, ''));}
   layer.comment='DM_TEXT_V3:'+dmTextJSON.stringify({batch:batch,row:row,large:large.font,small:small.font,edgeMotion:1});
  }
  if(folder){folder.remove();folder=null;}
  // Replace only this editor session after every new layer was built successfully.
  replacing=true;
  for(i=0;i<previous.length;i++){previous[i].locked=false;previous[i].remove();}
  for(var obsolete in managed)if(!seen[obsolete]){if(managed[obsolete].locked)throw new Error('Unlock the removed text layer first.');managed[obsolete].remove();}
  if(context&&context.previewTime!==undefined)target.time=context.previewTime;
  if(!context||!context.live){target.openInViewer();}
  return changed+' text layers updated.';
 }catch(e){
  if(!replacing)for(i=created.length-1;i>=0;i--)try{created[i].remove();}catch(_){}
  try{if(folder)folder.remove();}catch(_){}
  try{target.openInViewer();}catch(_){}
  return 'Error: '+(e.message||e.toString())+(/Use (Edit > )?Undo/.test(e.message||'')?'':' Use Undo before retrying.');
 }finally{app.endUndoGroup();}
}

function dmSelectManagedText(compId,batch,uid){
 var c=app.project.activeItem;if(!(c instanceof CompItem)||c.id!==compId)return 'Error: Open the composition used for transcription.';
 var found=null;for(var i=1;i<=c.numLayers;i++){var l=c.layer(i);if((l.comment||'').indexOf('DM_TEXT_V3:')!==0)continue;try{var m=dmTextJSON.parse(l.comment.substring(11));if(m.batch===batch&&m.row.uid===uid)found=l;}catch(e){}}
 if(!found)return 'Error: Text layer not found. Apply the texts first.';
 for(i=1;i<=c.numLayers;i++)c.layer(i).selected=false;found.selected=true;c.time=(found.inPoint+found.outPoint)/2;return 'Text selected.';
}

// Read-only selection probe. No timeline movement, layer edits or undo entries.
function dmGetSelectedManagedText(compId,batch){
 var c=app.project.activeItem;if(!(c instanceof CompItem)||c.id!==compId)return '';
 var selected=c.selectedLayers;if(!selected||selected.length!==1)return '';
 var comment=selected[0].comment||'';if(comment.indexOf('DM_TEXT_V3:')!==0)return '';
 try{var m=dmTextJSON.parse(comment.substring(11));if(m.batch===batch&&m.row&&typeof m.row.uid==='string')return m.row.uid;}catch(e){}
 return '';
}

// Read-only editor entry point: never modify selection, timeline or project.
function dmTextEditorContext() {
 var c=app.project.activeItem;if(!(c instanceof CompItem))return 'Error: Open a composition first.';
 var selected=c.selectedLayers,rows=[],i;
 for(i=0;i<selected.length;i++){
  var l=selected[i],text=l.property('ADBE Text Properties');if(!text)continue;
  var doc=text.property('ADBE Text Document').value,pos=l.property('ADBE Transform Group').property('ADBE Position').value;
  var color=doc.fillColor||[1,1,1],hex='#';for(var n=0;n<3;n++)hex+=('0'+Math.max(0,Math.min(255,Math.round(color[n]*255))).toString(16)).slice(-2);
  var start=Math.max(0,l.inPoint),end=Math.min(c.duration,l.outPoint);if(end-start<c.frameDuration*4)continue;
  var r={uid:'existing_'+l.id,sourceLayerId:l.id,text:String(doc.text),style:'small',color:hex,motion:'none',position:'middle',xy:[Math.max(0,Math.min(1,pos[0]/c.width)),Math.max(0,Math.min(1,pos[1]/c.height))],start:start,duration:end-start};
  if((l.comment||'').indexOf('DM_TEXT_V3:')===0){try{var saved=dmTextJSON.parse(l.comment.substring(11));if(saved.row){r.sourceOwnedMotion=saved.edgeMotion===1;r.preset=saved.row.preset===undefined?null:saved.row.preset;r.style=saved.row.style;}}catch(ignore){}}
  r.sourceBaseline=dmTextJSON.parse(dmTextJSON.stringify(r));rows.push(r);
 }
 rows.sort(function(a,b){return a.start-b.start;});
 return dmTextJSON.stringify({compId:c.id,timelineStart:0,duration:c.duration,frameDuration:c.frameDuration,width:c.width,height:c.height,playhead:c.time,rows:rows});
}

// Lightweight read-only probe for the editor entry button; no full text payload.
function dmCountSelectedText(){
 var c=app.project.activeItem;if(!(c instanceof CompItem))return '0';
 var selected=c.selectedLayers,count=0;
 for(var i=0;i<selected.length;i++){
  var l=selected[i];if(!l.property('ADBE Text Properties'))continue;
  if(Math.min(c.duration,l.outPoint)-Math.max(0,l.inPoint)>=c.frameDuration*4)count++;
 }
 return String(count);
}

function dmSelectedTextIdentity(){
 var c=app.project.activeItem;if(!(c instanceof CompItem))return '';
 var selected=c.selectedLayers,ids=[];
 for(var i=0;i<selected.length;i++){var l=selected[i];if(l.property('ADBE Text Properties')&&Math.min(c.duration,l.outPoint)-Math.max(0,l.inPoint)>=c.frameDuration*4)ids.push(l.id);}
 if(!ids.length)return '';ids.sort(function(a,b){return a-b;});return c.id+':'+ids.join(',');
}
