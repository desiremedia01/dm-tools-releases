/* whisper.cpp v1.8.2, local audio only. Model downloads are SHA-256 verified. */
(function(){
'use strict';
var fs=require('fs'),path=require('path'),os=require('os'),https=require('https'),crypto=require('crypto'),cp=require('child_process');
var HASH='60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',SIZE=147951465;
var URL_MODEL='https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
function parse(data,duration){
 if(!data||!Array.isArray(data.transcription)||data.transcription.length>5000)throw new Error('Invalid local transcript.');
 var words=[],last=0;
 data.transcription.forEach(function(s){
  if(!s||typeof s.text!=='string'||!s.offsets)throw new Error('Invalid local transcript.');
  var text=s.text.trim(),a=s.offsets.from/1000,b=s.offsets.to/1000;
  if(!text||/^\[.*\]$/.test(text))return;
  if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<a||a<last||b>duration+0.5)throw new Error('Invalid local timestamps.');
  last=a;if(a>=duration)return;
  if(words.length&&!/^\s/.test(s.text)){words[words.length-1].word+=text;words[words.length-1].end=Math.min(duration,b);}
  else words.push({word:text,start:a,end:Math.min(duration,b)});
 });
 if(!words.length)throw new Error('No speech found.');return words;
}
function run(wav,root,progress,duration){
 var cancelled=false,req,stream,child,part,reader;
 var cache=path.join(os.homedir(),'Library','Application Support','DM Tools','speech');
 var model=path.join(cache,'ggml-base.bin'),output=path.join(path.dirname(wav),'transcript');
 function check(){if(cancelled)throw new Error('Transcription cancelled.');}
 function digest(file){return new Promise(function(resolve,reject){var h=crypto.createHash('sha256');reader=fs.createReadStream(file);reader.on('data',function(b){h.update(b);});reader.on('error',reject);reader.on('end',function(){reader=null;resolve(h.digest('hex'));});});}
 function download(url,hops){return new Promise(function(resolve,reject){
  check();var u=new (require('url').URL)(url);
  if(u.protocol!=='https:'||u.username||u.password||!(/(^|\.)(huggingface\.co|hf\.co)$/.test(u.hostname))||hops>6)return reject(new Error('Invalid model download location.'));
  req=https.get(url,function(res){
   if([301,302,303,307,308].indexOf(res.statusCode)>=0){res.resume();if(!res.headers.location)return reject(new Error('Model download redirect failed.'));download(new (require('url').URL)(res.headers.location,url).href,hops+1).then(resolve,reject);return;}
   if(res.statusCode!==200){res.resume();return reject(new Error('Could not download the speech model. Try again.'));}
   var count=0,last=-1,h=crypto.createHash('sha256');stream=fs.createWriteStream(part,{flags:'wx',mode:0o600});
   function fail(e){res.destroy();stream.destroy();reject(e);}
   stream.on('error',fail);res.on('error',function(){fail(new Error('Model download interrupted. Try again.'));});
   res.on('data',function(b){count+=b.length;if(count>SIZE){fail(new Error('Invalid model size.'));return;}h.update(b);var percent=Math.floor(count/SIZE*100);if(percent!==last){last=percent;progress('Downloading speech model: '+percent+'% (148 MB, once)…');}});
   stream.on('finish',function(){try{check();if(count!==SIZE||h.digest('hex')!==HASH)throw new Error('Speech model verification failed. Try again.');fs.renameSync(part,model);part=null;resolve(model);}catch(e){reject(e);}});res.pipe(stream);
  });req.setTimeout(30000,function(){req.destroy(new Error('Model download timed out.'));});req.on('error',reject);
 });}
 var promise=Promise.resolve().then(function(){
  check();if(process.platform!=='darwin')throw new Error('Local transcription currently supports macOS.');
  fs.accessSync(path.join(root,'bin','whisper-cli'),fs.constants.X_OK);fs.mkdirSync(cache,{recursive:true,mode:0o700});
  progress('Checking local speech model…');
  if(fs.existsSync(model)&&fs.statSync(model).size===SIZE)return digest(model).then(function(hash){check();return hash===HASH;});return false;
 }).then(function(valid){check();if(valid)return model;part=path.join(cache,'model-'+crypto.randomBytes(8).toString('hex')+'.part');return download(URL_MODEL,0);
 }).then(function(){check();progress('Transcribing locally…');return new Promise(function(resolve,reject){
  child=cp.execFile(path.join(root,'bin','whisper-cli'),['-m',model,'-f',wav,'-l','auto','-ml','1','-sow','-oj','-of',output,'-t','4','-np'],{timeout:600000,maxBuffer:4*1024*1024},function(err){child=null;try{check();if(err)throw new Error('Local transcription failed or timed out.');var file=output+'.json';if(fs.statSync(file).size>4*1024*1024)throw new Error('Local transcript is too large.');resolve(parse(JSON.parse(fs.readFileSync(file,'utf8')),duration));}catch(e){reject(e);}});
 });});
 function clean(){if(part)try{fs.unlinkSync(part);}catch(_){}try{fs.unlinkSync(output+'.json');}catch(_){}}
 return {promise:promise.then(function(v){clean();return v;},function(e){clean();throw new Error(cancelled?'Transcription cancelled.':e.message);}),cancel:function(){cancelled=true;if(req)req.destroy(new Error('Transcription cancelled.'));if(reader)reader.destroy(new Error('Transcription cancelled.'));if(child)child.kill();}};
}
module.exports={run:run,parse:parse};
})();
