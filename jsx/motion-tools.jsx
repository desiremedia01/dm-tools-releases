/* DM Tools motion helpers — original implementation, no external preset dependency. */
function dmMotionComp(){var c=app.project.activeItem;if(!(c instanceof CompItem))throw new Error('Open a composition first.');return c;}
function dmMotionQuote(s){return '"'+String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')+'"';}
function dmMotionEase(side,amount,kind){
 var started=false;try{
 var c=dmMotionComp(),props=c.selectedProperties,jobs=[],i,k;
 if(!/^(in|out|both)$/.test(side)||!/^(ease|linear|hold|bezier)$/.test(kind))throw new Error('Invalid easing command.');
 amount=Number(amount);if(!isFinite(amount)||amount<0||amount>100)throw new Error('Influence must be from 0 to 100.');
 for(i=0;i<props.length;i++){var p=props[i];if(!p.canVaryOverTime||!p.selectedKeys||!p.selectedKeys.length)continue;
  if(p.propertyDepth&&p.propertyGroup(p.propertyDepth).locked)throw new Error('Unlock selected layers first.');
  var interpolation=kind==='hold'?KeyframeInterpolationType.HOLD:kind==='linear'?KeyframeInterpolationType.LINEAR:KeyframeInterpolationType.BEZIER;
  if(!p.isInterpolationTypeValid(interpolation))continue;
  for(k=0;k<p.selectedKeys.length;k++)jobs.push({prop:p,key:p.selectedKeys[k]});
 }
 if(!jobs.length)throw new Error('Select keyframes in the timeline first.');
 app.beginUndoGroup('DM Keyframe Easing');started=true;var skipped=0;
 for(i=0;i<jobs.length;i++){
  var prop=jobs[i].prop,key=jobs[i].key,spatial=prop.isSpatial;
  if(spatial&&prop.keyRoving(key)){skipped++;continue;}
  var inside=side!=='out',outside=side!=='in';
  var inType=inside?interpolation:prop.keyInInterpolationType(key),outType=outside?interpolation:prop.keyOutInterpolationType(key);
  var inEase=prop.keyInTemporalEase(key),outEase=prop.keyOutTemporalEase(key);
  prop.setInterpolationTypeAtKey(key,inType,outType);
  if(kind==='ease'){
   if(prop.keyTemporalAutoBezier(key))prop.setTemporalAutoBezierAtKey(key,false);
   if(prop.keyTemporalContinuous(key))prop.setTemporalContinuousAtKey(key,false);
   var a=[],b=[];
   for(k=0;k<inEase.length;k++)a.push(inside?new KeyframeEase(0,Math.max(.1,amount)):new KeyframeEase(inEase[k].speed,inEase[k].influence));
   for(k=0;k<outEase.length;k++)b.push(outside?new KeyframeEase(0,Math.max(.1,amount)):new KeyframeEase(outEase[k].speed,outEase[k].influence));
   prop.setTemporalEaseAtKey(key,a,b);
  }else if(kind==='bezier'&&inside&&outside){prop.setTemporalContinuousAtKey(key,true);prop.setTemporalAutoBezierAtKey(key,true);}
 }
 return (jobs.length-skipped)+' keyframes updated.'+(skipped?' '+skipped+' roving keys left unchanged.':'');
 }catch(e){return 'Error: '+(e.message||e.toString());}finally{if(started)app.endUndoGroup();}
}
function dmMotionAnchorOffset2D(delta,scale,angle){
 var r=angle*Math.PI/180,x=delta[0]*scale[0]/100,y=delta[1]*scale[1]/100;
 return [x*Math.cos(r)-y*Math.sin(r),x*Math.sin(r)+y*Math.cos(r),0];
}
function dmMotionAnchorExpression(delta,original,axis,dimensions,local2D){
 var header='// DM_ANCHOR_V1:'+delta.join(',')+':'+encodeURIComponent(original)+'\n';
 var expr='var dmBase='+(original?'eval('+dmMotionQuote(original)+')':'value')+';\n';
 if(local2D)expr+='var dmScale=thisLayer.transform.scale;var dmAngle=thisLayer.transform.rotation*Math.PI/180;var dmX='+delta[0]+'*dmScale[0]/100;var dmY='+delta[1]+'*dmScale[1]/100;var dmOffset=[dmX*Math.cos(dmAngle)-dmY*Math.sin(dmAngle),dmX*Math.sin(dmAngle)+dmY*Math.cos(dmAngle),0];\n';
 else expr+='var dmWorld=thisLayer.toWorldVec(['+delta.join(',')+']);\nvar dmOffset=thisLayer.hasParent?thisLayer.parent.fromWorldVec(dmWorld):dmWorld;\n';
 // AE can expose a 3-component Anchor Point with a 2-component Position or vector.
 // Follow Position itself and treat absent vector components as zero.
 if(axis>=0)return header+expr+'dmBase+(dmOffset.length>'+axis+'?dmOffset['+axis+']:0);';
 return header+expr+'var dmResult=[];\nfor(var dmAxis=0;dmAxis<value.length;dmAxis++){dmResult[dmAxis]=dmBase[dmAxis]+(dmOffset.length>dmAxis?dmOffset[dmAxis]:0);}\ndmResult;';
}
function dmMotionAnchorState(p){
 var original=p.expressionEnabled?p.expression:'',delta=[0,0,0];
 if(original.indexOf('// DM_ANCHOR_V1:')===0){var line=original.split('\n')[0].substring(16),split=line.indexOf(':');if(split>=0){var parts=line.substring(0,split).split(',');for(var i=0;i<3;i++)delta[i]=Number(parts[i]);original=decodeURIComponent(line.substring(split+1));}}
 return {original:original,delta:delta};
}
function dmMotionAnchor(row,col){
 var started=false;try{
 var c=dmMotionComp(),layers=c.selectedLayers,plans=[],i,j;
 if(row<0||row>2||col<0||col>2||row%1||col%1)throw new Error('Invalid anchor position.');
 if(!layers.length)throw new Error('Select layers first.');
 for(i=0;i<layers.length;i++){
  var l=layers[i],tr=l.property('ADBE Transform Group'),ap=tr&&tr.property('ADBE Anchor Point'),pos=tr&&tr.property('ADBE Position');
  if(l.locked)throw new Error('Unlock selected layers first.');
  if(!ap||!pos||!l.sourceRectAtTime)throw new Error('Select footage, text or shape layers.');
  if(ap.expressionEnabled)throw new Error('The anchor point is controlled by an expression. Disable it before repositioning.');
  var old=ap.valueAtTime(c.time,true),rect=(l instanceof TextLayer||l instanceof ShapeLayer)?l.sourceRectAtTime(c.time,false):{left:0,top:0,width:l.width,height:l.height},delta=[rect.left+rect.width*col/2-old[0],rect.top+rect.height*row/2-old[1],0],positions=[];
  var dimensions=pos.value.length,scale=tr.property('ADBE Scale'),rotation=tr.property('ADBE Rotate Z');
  var local2D=!l.threeDLayer&&(typeof AutoOrientType==='undefined'||l.autoOrient===AutoOrientType.NO_AUTO_ORIENT);
  var static2D=local2D&&!scale.isTimeVarying&&!rotation.isTimeVarying;
  if(pos.dimensionsSeparated){for(j=0;j<(l.threeDLayer?3:2);j++)positions.push({p:pos.getSeparationFollower(j),axis:j});}else positions.push({p:pos,axis:-1});
  for(j=0;j<positions.length;j++){
   var target=positions[j],saved=dmMotionAnchorState(target.p);for(var n=0;n<3;n++)saved.delta[n]+=delta[n];
   target.bake=static2D&&!saved.original;
   if(target.bake)target.offset=dmMotionAnchorOffset2D(saved.delta,scale.value,rotation.value);
   else{if(!target.p.canSetExpression)throw new Error('Position cannot receive anchor compensation.');target.expression=dmMotionAnchorExpression(saved.delta,saved.original,target.axis,dimensions,local2D);}
  }
  plans.push({anchor:ap,delta:delta,positions:positions});
 }
 app.beginUndoGroup('DM Anchor Point');started=true;
 for(i=0;i<plans.length;i++){
  var plan=plans[i],anchor=plan.anchor;
  if(anchor.numKeys){for(j=1;j<=anchor.numKeys;j++){var v=anchor.keyValue(j);v[0]+=plan.delta[0];v[1]+=plan.delta[1];anchor.setValueAtKey(j,v);}}
  else{var value=anchor.value;value[0]+=plan.delta[0];value[1]+=plan.delta[1];anchor.setValue(value);}
  for(j=0;j<plan.positions.length;j++){
   var item=plan.positions[j];
   if(item.bake){
    if(item.p.expressionEnabled&&item.p.expression.indexOf('// DM_ANCHOR_V1:')===0)item.p.expression='';
    var count=item.p.numKeys;
    for(var key=0;key<(count||1);key++){
     var base=count?item.p.keyValue(key+1):item.p.value;
     if(item.axis>=0)base+=item.offset[item.axis]||0;
     else{var shifted=[];for(var dim=0;dim<base.length;dim++)shifted.push(base[dim]+(item.offset[dim]||0));base=shifted;}
     if(count)item.p.setValueAtKey(key+1,base);else item.p.setValue(base);
    }
   }else{item.p.expression=item.expression;item.p.expressionEnabled=true;if(item.p.expressionError)throw new Error(item.p.expressionError+' Use Edit > Undo to restore the anchor.');}
  }
 }
 return plans.length+' anchor points repositioned.';
 }catch(e){return 'Error: '+(e.message||e.toString());}finally{if(started)app.endUndoGroup();}
}
function dmMotionAddNull(){
 var started=false,created=[];try{
 var c=dmMotionComp(),layers=c.selectedLayers,roots=[],groups=[],i,j;
 if(!layers.length)throw new Error('Select layers to parent first.');
 function selected(l){for(var k=0;k<layers.length;k++)if(layers[k]===l)return true;return false;}
 for(i=0;i<layers.length;i++){
  if(layers[i].locked)throw new Error('Unlock selected layers first.');
  if(!layers[i].property('ADBE Transform Group').property('ADBE Anchor Point'))throw new Error('Select footage, text or shape layers.');
  var parent=layers[i].parent,hasSelectedAncestor=false;while(parent){if(selected(parent)){hasSelectedAncestor=true;break;}parent=parent.parent;}
  if(!hasSelectedAncestor)roots.push(layers[i]);
 }
 for(i=0;i<roots.length;i++){var found=null;for(j=0;j<groups.length;j++)if(groups[j].parent===roots[i].parent)found=groups[j];if(!found){found={parent:roots[i].parent,layers:[]};groups.push(found);}found.layers.push(roots[i]);}
 app.beginUndoGroup('DM Add Parent Null');started=true;
 for(i=0;i<groups.length;i++){
  var g=groups[i],control=c.layers.addNull(),is3D=!!(g.parent&&g.parent.threeDLayer),points=[],low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity],t0=c.duration,t1=0,first=g.layers[0];created.push(control);
  for(j=0;j<g.layers.length;j++){var layer=g.layers[j];if(layer.threeDLayer)is3D=true;t0=Math.min(t0,layer.inPoint);t1=Math.max(t1,layer.outPoint);if(layer.index<first.index)first=layer;}
  control.threeDLayer=is3D;control.name='DM Null'+(groups.length>1?' '+(i+1):'');control.label=9;
  var fx=control.property('ADBE Effect Parade').addProperty('ADBE Point3D Control'),index=fx.propertyIndex;
  for(j=0;j<g.layers.length;j++){
   var probe=control.property('ADBE Effect Parade').property(index).property(1);
   probe.expression='var l=thisComp.layer('+g.layers[j].index+');l.toWorld(l.anchorPoint);';
   if(probe.expressionError)throw new Error(probe.expressionError);
   var point=probe.value;for(var n=0;n<3;n++){var v=point[n]||0;low[n]=Math.min(low[n],v);high[n]=Math.max(high[n],v);}
  }
  control.property('ADBE Effect Parade').property(index).remove();
  var center=[(low[0]+high[0])/2,(low[1]+high[1])/2,(low[2]+high[2])/2];
  control.property('ADBE Transform Group').property('ADBE Position').setValue(is3D?center:[center[0],center[1]]);
  control.inPoint=t0;control.outPoint=t1;
  // Native parent assignment compensates transforms; preserve existing ancestry.
  if(g.parent)control.parent=g.parent;
  control.moveBefore(first);
  for(j=0;j<g.layers.length;j++)g.layers[j].parent=control;
 }
 for(i=0;i<c.numLayers;i++)c.layer(i+1).selected=false;for(i=0;i<created.length;i++)created[i].selected=true;
 return created.length+' parent Null'+(created.length===1?'':'s')+' created.';
 }catch(e){return 'Error: '+(e.message||e.toString())+(started?' Use Edit > Undo before retrying.':'');}finally{if(started)app.endUndoGroup();}
}
