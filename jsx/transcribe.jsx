function dmSelectedSpeech(){
 try{
  var c=app.project.activeItem;if(!(c instanceof CompItem))throw new Error('Open a composition first.');
  if(c.selectedLayers.length!==1)throw new Error('Select one video, audio or precomp layer.');
  var l=c.selectedLayers[0],a=Math.max(0,l.inPoint),b=Math.min(c.duration,l.outPoint),segments=[],maps=null;
  if(b<=a)throw new Error('The selected layer has no visible duration.');
  if(b-a>120)throw new Error('Trim the selected layer to two minutes or less.');
  function visit(layer,base,scale,lo,hi,depth){
   if(depth>16)throw new Error('The precomp nesting is too deep.');
   if(!layer.hasAudio||!layer.audioEnabled)return;
   var s=layer.source;if(!s)return;
   if(s.useProxy)throw new Error('Disable the audio source proxy before transcribing.');
   var start=Math.max(lo,base+scale*layer.inPoint),end=Math.min(hi,base+scale*layer.outPoint);
   if(end<=start)return;
   var rate=100/layer.stretch,origin=base+scale*layer.startTime;
   if(layer.timeRemapEnabled){
    var remap=layer.property('ADBE Time Remapping'),t0=(start-base)/scale,t1=(end-base)/scale;
    if(!remap)throw new Error('Could not read the audio time remapping.');
    var v0=remap.valueAtTime(t0,false),v1=remap.valueAtTime(t1,false);rate=(v1-v0)/(t1-t0);
    if(!isFinite(rate)||rate<=0)throw new Error('Reversed or frozen audio is not supported for transcription.');
    var steps=Math.min(30000,Math.max(2,Math.ceil((t1-t0)/c.frameDuration)*2));
    for(var step=1;step<steps;step++){var t=t0+(t1-t0)*step/steps;if(Math.abs(remap.valueAtTime(t,false)-(v0+(t-t0)*rate))>0.002)throw new Error('Variable-speed audio needs to be rendered before transcription. Constant-speed time remapping is supported.');}
    origin=start-v0*scale/rate;
   }
   if(!isFinite(rate)||rate<=0)throw new Error('Reversed audio is not supported for transcription.');
   var sourceScale=scale/rate;
   start=Math.max(start,origin);end=Math.min(end,origin+s.duration*sourceScale);
   if(end<=start)return;
   if(s instanceof CompItem){
    var solo=false,i;for(i=1;i<=s.numLayers;i++)if(s.layer(i).solo)solo=true;
    for(i=1;i<=s.numLayers;i++)if(!solo||s.layer(i).solo)visit(s.layer(i),origin,sourceScale,start,end,depth+1);
   }else if(s instanceof FootageItem&&s.file&&s.file.exists){
    segments.push({file:s.file.fsName,sourceStart:(start-origin)/sourceScale,duration:end-start,rate:1/sourceScale,delay:start-a});
    if(segments.length>32)throw new Error('The selected precomp contains more than 32 audio clips.');
   }
  }
  try{visit(l,0,1,a,b,0);}catch(speedError){
   if(!/Variable-speed|Reversed|frozen/.test(speedError.message))throw speedError;
   segments=[];maps=[];
   var count=Math.ceil((b-a)/0.01),step=(b-a)/count;
   function collect(layer,chain,depth){
    if(depth>16)throw new Error('The precomp nesting is too deep.');
    if(!layer.hasAudio||!layer.audioEnabled||!layer.source)return;
    var source=layer.source;if(source.useProxy)throw new Error('Disable the audio source proxy before transcribing.');
    var next=chain.concat([layer]);
    if(source instanceof CompItem){var solo=false,k;for(k=1;k<=source.numLayers;k++)if(source.layer(k).solo)solo=true;for(k=1;k<=source.numLayers;k++)if(!solo||source.layer(k).solo)collect(source.layer(k),next,depth+1);}
    else if(source instanceof FootageItem&&source.file&&source.file.exists){
     var samples=[],valid=false;
     for(var n=0;n<=count;n++){
      var t=a+Math.min(n*step,b-a-0.000001),active=true;
      for(var d=0;d<next.length;d++){var node=next[d];if(t<node.inPoint||t>=node.outPoint){active=false;break;}
       t=node.timeRemapEnabled?node.property('ADBE Time Remapping').valueAtTime(t,false):(t-node.startTime)*100/node.stretch;
       if(!isFinite(t)||t<0||t>=node.source.duration){active=false;break;}
      }
      samples.push(active?Math.round(t*1000000)/1000000:-1);if(active)valid=true;
     }
     if(valid)maps.push({file:source.file.fsName,samples:samples});
     if(maps.length>32)throw new Error('The selected precomp contains more than 32 audio clips.');
    }
   }
   collect(l,[],0);
   if(maps.length)segments.push({file:maps[0].file,sourceStart:0,duration:b-a,rate:1,delay:0});
  }
  if(!segments.length)throw new Error('No enabled file-based audio was found inside the selected layer.');
  function q(t){return '"'+String(t).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n').replace(/\t/g,'\\t')+'"';}
  var parts=[];for(var i=0;i<segments.length;i++){var x=segments[i];parts.push('{"file":'+q(x.file)+',"sourceStart":'+x.sourceStart+',"duration":'+x.duration+',"rate":'+x.rate+',"delay":'+x.delay+'}');}
  var mapJson='';if(maps){var entries=[];for(var m=0;m<maps.length;m++)entries.push('{"file":'+q(maps[m].file)+',"samples":['+maps[m].samples.join(',')+']}');mapJson=',"audioMap":{"step":'+step+',"tracks":['+entries.join(',')+']}';}
  return '{"file":'+q(segments[0].file)+',"name":'+q(l.name)+',"compId":'+c.id+',"timelineStart":'+a+',"sourceStart":'+segments[0].sourceStart+',"duration":'+(b-a)+',"width":'+c.width+',"height":'+c.height+',"frameDuration":'+c.frameDuration+',"segments":['+parts.join(',')+']'+mapJson+'}';
 }catch(e){return 'Error: '+e.message;}
}
