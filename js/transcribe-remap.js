/* Reconstructs source audio against sampled AE time maps. No AE project mutation. */
'use strict';
var fs=require('fs'),path=require('path'),cp=require('child_process');
function render(map,duration,binary,out,progress){
 var child,cancelled=false,rate=16000;
 function check(){if(cancelled)throw new Error('Transcription cancelled.');}
 var promise=Promise.resolve().then(async function(){
  check();if(!Number.isFinite(duration)||duration<=0||duration>120||!map||!Number.isFinite(map.step)||map.step<=0||map.step>.011||!Array.isArray(map.tracks)||!map.tracks.length||map.tracks.length>32)throw new Error('Invalid audio time map.');
  var size=Math.round(duration*rate),mix=new Float32Array(size);
  for(var k=0;k<map.tracks.length;k++){
   check();var track=map.tracks[k],points=track.samples;
   if(typeof track.file!=='string'||!path.isAbsolute(track.file)||!fs.statSync(track.file).isFile()||!Array.isArray(points)||points.length!==Math.ceil(duration/map.step-0.00001)+1||points.length>12002)throw new Error('Invalid source audio map.');
   var low=Infinity,high=-Infinity;
   points.forEach(function(t){if(!Number.isFinite(t)||t< -1)throw new Error('Invalid source audio time.');if(t>=0){low=Math.min(low,t);high=Math.max(high,t);}});
   if(!Number.isFinite(low))continue;
   var span=high-low+.05;if(span>1800)throw new Error('The source audio range exceeds 30 minutes. Trim the precomp first.');
   progress('Preparing remapped audio '+(k+1)+' / '+map.tracks.length+'…');
   var pcm=await new Promise(function(resolve,reject){child=cp.execFile(binary,['-nostdin','-hide_banner','-loglevel','error','-ss',String(low),'-t',String(span),'-i',track.file,'-map','0:a:0','-vn','-ac','1','-ar',String(rate),'-f','f32le','pipe:1'],{encoding:null,maxBuffer:120*1024*1024,timeout:120000},function(err,stdout){child=null;if(err)reject(new Error(cancelled?'Transcription cancelled.':'Could not decode remapped audio.'));else resolve(stdout);});});
   check();if(!pcm.length||pcm.length%4)throw new Error('Invalid decoded audio.');
   for(var begin=0;begin<size;begin+=32000){check();var end=Math.min(size,begin+32000);
    for(var i=begin;i<end;i++){var point=i/rate/map.step,index=Math.min(points.length-2,Math.floor(point)),a=points[index],b=points[index+1];
     if(a<0||b<0||Math.abs(a-b)<0.0000001)continue; // Mutes inactive ranges and freeze frames.
     var source=(a+(b-a)*(point-index)-low)*rate,j=Math.floor(source),fraction=source-j;
     if(j<0||(j+1)*4>=pcm.length)continue;var sample=pcm.readFloatLE(j*4)*(1-fraction)+pcm.readFloatLE((j+1)*4)*fraction;if(Number.isFinite(sample))mix[i]+=sample;
    }
    await new Promise(function(resolve){setImmediate(resolve);});
   }
  }
  check();var wav=Buffer.alloc(44+size*2);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(size*2,40);
  var peak=1;for(var x=0;x<size;x++)peak=Math.max(peak,Math.abs(mix[x]));for(var y=0;y<size;y++)wav.writeInt16LE(Math.round(mix[y]/peak*32767),44+y*2);fs.writeFileSync(out,wav,{mode:0o600});
 });return {promise:promise,cancel:function(){cancelled=true;if(child)child.kill();}};
}
module.exports={render:render};
