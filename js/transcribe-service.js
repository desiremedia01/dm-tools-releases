/* No real audio is sent until the user clicks Transcribe in the panel. */
(function(){
'use strict';
var fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),https=require('https'),crypto=require('crypto');
function groupWords(words,count,duration,frame){
 if(!Array.isArray(words)||!words.length||words.length>5000)throw new Error('No timed speech was returned.');
 if([1,3,5,8].indexOf(count)<0)throw new Error('Invalid word grouping.');
 var clean=[],last=-1;
 words.forEach(function(w){if(!w||typeof w.word!=='string'||typeof w.start!=='number'||typeof w.end!=='number'||!isFinite(w.start)||!isFinite(w.end)||w.start<0||w.end<w.start||w.start<last||w.end>duration+0.5)throw new Error('The transcription contains invalid timestamps.');last=w.start;var text=w.word.trim();if(text)clean.push({word:text,start:w.start,end:Math.min(duration,w.end)});});
 var rows=[],i=0,min=Math.max(0.201,4*frame+0.001);
 while(i<clean.length){var begin=i,parts=[];do{parts.push(clean[i].word);i++;}while(i<clean.length&&(parts.length<count||clean[i-1].end-clean[begin].start<min));
  var end=Math.min(duration,Math.max(clean[i-1].end,clean[begin].start+min));
  if(end-clean[begin].start<min-0.00001){if(!rows.length)throw new Error('Speech is too short to animate.');rows[rows.length-1].text+=' '+parts.join(' ');rows[rows.length-1].duration=end-rows[rows.length-1].start;continue;}
  var text=parts.join(' ');if(text.length>160)throw new Error('A text group is too long. Choose fewer words per box.');
  rows.push({text:text,start:clean[begin].start,duration:end-clean[begin].start,style:'small',color:'#ffffff',motion:'up',position:'middle',sourceIndex:-1});
 }
 if(!rows.length)throw new Error('No speech found.');if(rows.length>120)throw new Error('More than 120 boxes. Choose more words per box.');return rows;
}
function captionText(text){
 // Keep internal apostrophes and numeric separators: don't change don't or 1/21.
 return text.replace(/[.,!?;:"“”()[\]{}…]/g,'').replace(/(^|\s)['‘’]|['‘’](?=\s|$)/g,'$1').replace(/[—–]/g,' ').replace(/\s+/g,' ').trim();
}
function autoGroup(words,style,duration,frame){
 if(style!=='large'&&style!=='small')throw new Error('Choose Small or Large.');
 // Reuse strict timing validation without changing the original transcript.
 groupWords(words,8,duration,frame);
 if(words.every(function(w){return typeof w._semanticSmall==='boolean'&&typeof w._semanticLarge==='boolean';})){
  var rows=[],first=0,min=Math.max(.201,frame*4+.001);
  for(var x=0;x<words.length;x++)if(words[x][style==='large'?'_semanticLarge':'_semanticSmall']||x===words.length-1){
   if(words[x].end-words[first].start<min&&x<words.length-1)continue;
   var text=captionText(words.slice(first,x+1).map(function(w){return w.word;}).join(' '));
   if(text.length>160)throw new Error('A phrase is too long. Edit the transcript.');
   var end=Math.min(duration,Math.max(words[x].end,words[first].start+min));
   if(end-words[first].start<min&&rows.length){var prev=rows[rows.length-1];prev.text+=' '+text;prev._words=prev._words.concat(words.slice(first,x+1));prev.duration=end-prev.start;}
   else rows.push({text:text,start:words[first].start,duration:end-words[first].start,style:style,color:'#ffffff',motion:style==='large'?'up':'right',position:'middle',sourceIndex:-1,_words:words.slice(first,x+1)});
   first=x+1;
  }if(rows.length>120)throw new Error('Maximum 120 text boxes.');return rows;
 }
 var clean=words.map(function(w){return {word:captionText(w.word),raw:w.word,start:w.start,end:Math.min(duration,w.end)};}).filter(function(w){return w.word&&w.start<duration;});
 var protect={},n=clean.length,i,j;
 var street=/^(street|st|avenue|ave|road|rd|drive|dr|court|ct|crescent|cres|lane|ln|place|pl|terrace|tce|way|boulevard|blvd|parade|pde|circuit|close|highway|hwy)$/i;
 // Protect numbered street addresses as a single unit, including unit/range numbers.
 for(i=0;i<n;i++)if(/^\d+[a-z]?(?:[-/]\d+[a-z]?)?$/i.test(clean[i].word)){
  for(j=i+1;j<Math.min(n,i+7);j++){
   if(j>i+1&&street.test(clean[j].word)){for(var k=i;k<j;k++)protect[k]=true;break;}
   if(/[!?;]/.test(clean[j].raw)||clean[j].start-clean[j-1].end>0.8)break;
  }
 }
 var connector=/^(a|an|the|this|that|these|those|i|you|we|he|she|they|it|my|your|our|its|at|in|on|to|of|with|from|and|or|for|o|a|os|as|um|uma|de|do|da|em|com|e)$/i;
 var transition=/^(now|next|finally|then|meanwhile|agora|então|finalmente)$/i;
 // A name pair should not be split just to meet the preferred word count.
 for(i=0;i<n-1;i++)if(/^[A-Z][a-z]/.test(clean[i].word)&&/^[A-Z][a-z]/.test(clean[i+1].word)&&!connector.test(clean[i].word)&&!connector.test(clean[i+1].word)&&!transition.test(clean[i].word)&&!transition.test(clean[i+1].word))protect[i]=true;
 // Keep proper names joined through particles: Isle of Capri, Surfers Paradise.
 for(i=0;i<n-2;i++)if(/^[A-Z][a-z]/.test(clean[i].word)&&/^(of|de|del|da|di|du|van|von)$/i.test(clean[i+1].word)&&/^[A-Z][a-z]/.test(clean[i+2].word)){protect[i]=true;protect[i+1]=true;}
 var rows=[],start=0,min=Math.max(.201,4*frame+.001),target=style==='large'?3:6;
 while(start<n){
  var end=start;
  while(end<n-1){
   var count=end-start+1,gap=clean[end+1].start-clean[end].end;
   if(!protect[end]&&!connector.test(clean[end].word)&&transition.test(clean[end+1].word)&&clean[end].end-clean[start].start>=min)break;
   if(style==='large'&&count>=2&&/^\d/.test(clean[end+1].word)&&protect[end+1]&&!protect[end])break;
   // End a complete address before the next clause, not after its opening words.
   if(end>start&&street.test(clean[end].word)&&clean.slice(start,end).some(function(w){return /^\d/.test(w.word);})&&!protect[end])break;
   // Prefer a clean boundary before a connector once near the target length.
   if(count>=target-1&&!protect[end]&&!connector.test(clean[end].word)&&connector.test(clean[end+1].word)&&clean[end].end-clean[start].start>=min)break;
   if(!protect[end]&&!connector.test(clean[end].word)&&clean[end].end-clean[start].start>=min){
    if(/[.!?;]$/.test(clean[end].raw)||gap>=.35||(count>=target)||(count>=2&&/[,：:]$/.test(clean[end].raw)))break;
   }
   end++;
  }
  var text=clean.slice(start,end+1).map(function(w){return w.word;}).join(' '),finish=Math.min(duration,Math.max(clean[end].end,clean[start].start+min));
  if(text.length>160)throw new Error('A phrase is too long. Shorten the selected audio range.');
  if(finish-clean[start].start<min-.00001){if(!rows.length)throw new Error('Speech is too short to animate.');var prev=rows[rows.length-1];prev.text+=' '+text;prev.duration=finish-prev.start;prev._words=prev._words.concat(clean.slice(start,end+1).map(function(w){return {word:w.raw,start:w.start,end:w.end};}));if(prev.text.length>160)throw new Error('A phrase is too long.');}
  else rows.push({text:text,start:clean[start].start,duration:finish-clean[start].start,style:style,color:'#ffffff',motion:style==='large'?'up':'right',position:'middle',sourceIndex:-1,_words:clean.slice(start,end+1).map(function(w){return {word:w.raw,start:w.start,end:w.end};})});
  start=end+1;
 }
 if(!rows.length)throw new Error('No speech found.');if(rows.length>120)throw new Error('More than 120 boxes. Use Small or a shorter selection.');return rows;
}

function retimeWords(original,text){
 var tokens=captionText(text).split(/\s+/).filter(Boolean);
 if(!tokens.length)throw new Error('Enter the transcript text.');
 if(tokens.length>1500||original.length>1500)throw new Error('Transcript is too long.');
 var n=original.length,m=tokens.length,dp=[],i,j;
 for(i=0;i<=n;i++){dp[i]=new Uint16Array(m+1);dp[i][0]=i;}for(j=0;j<=m;j++)dp[0][j]=j;
 function norm(t){return captionText(t).toLowerCase();}
 for(i=1;i<=n;i++)for(j=1;j<=m;j++)dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(norm(original[i-1].word)===norm(tokens[j-1])?0:1));
 var aligned=new Array(m);i=n;j=m;
 while(i||j){if(i&&j&&dp[i][j]===dp[i-1][j-1]+(norm(original[i-1].word)===norm(tokens[j-1])?0:1)){aligned[j-1]={word:tokens[j-1],start:original[i-1].start,end:original[i-1].end,_semanticSmall:original[i-1]._semanticSmall,_semanticLarge:original[i-1]._semanticLarge};i--;j--;}else if(j&&dp[i][j]===dp[i][j-1]+1){j--;}else i--;}
 for(j=0;j<m;j++)if(!aligned[j]){var begin=j;while(j<m&&!aligned[j])j++;var a=begin?aligned[begin-1].end:original[0].start,b=j<m?aligned[j].start:original[n-1].end;
  if(b<=a){if(j<m){b=aligned[j].end;aligned[j].start=a+(b-a)*(j-begin)/(j-begin+1);b=aligned[j].start;}else if(begin){a=aligned[begin-1].start;aligned[begin-1].end=a+(b-a)/(j-begin+1);a=aligned[begin-1].end;}}
  for(var k=begin;k<j;k++)aligned[k]={word:tokens[k],start:a+(b-a)*(k-begin)/(j-begin),end:a+(b-a)*(k-begin+1)/(j-begin)};
 }
 return aligned;
}

function timeRows(rows,words,duration,frame){
 var text=rows.map(function(r){return captionText(r.text);}).join(' '),aligned=retimeWords(words,text),offset=0,min=Math.max(.201,frame*4+.001);
 return rows.map(function(row){var result={};Object.keys(row).forEach(function(k){result[k]=row[k];});var count=captionText(row.text).split(/\s+/).filter(Boolean).length;if(!count)throw new Error('Fill in every text field.');var chunk=aligned.slice(offset,offset+count);offset+=count;
 result._words=chunk;result.start=chunk[0].start;var end=Math.min(duration,Math.max(chunk[chunk.length-1].end,result.start+min));if(end-result.start<min-.00001)throw new Error('This text is too short to animate. Merge it with the previous box.');result.duration=end-result.start;return result;});
}

function transcribe(info,key,root,progress,provider){
 provider=provider||'openai';
 var providers={openai:{label:'OpenAI',host:'api.openai.com',path:'/v1/audio/transcriptions',model:'whisper-1',pattern:/^sk-[A-Za-z0-9_-]{10,}$/},groq:{label:'Groq',host:'api.groq.com',path:'/openai/v1/audio/transcriptions',model:'whisper-large-v3-turbo',pattern:/^gsk_[A-Za-z0-9_-]{10,}$/}};
 var config=providers[provider];
 var child,request,dir,localJob,contextJob,rampJob,cancelled=false;
 function check(){if(cancelled)throw new Error('Transcription cancelled.');}
 function cleanup(){if(dir){try{fs.unlinkSync(path.join(dir,'speech.wav'));}catch(_){}try{fs.rmdirSync(dir);}catch(_){}}}
 var promise=Promise.resolve().then(function(){
  check();if(provider!=='local'&&!config)throw new Error('Invalid transcription provider.');if(provider!=='local'&&(typeof key!=='string'||!config.pattern.test(key)))throw new Error('Save your '+config.label+' API key in Settings first.');
  if(!info||typeof info.file!=='string'||!path.isAbsolute(info.file)||!fs.statSync(info.file).isFile()||!Number.isFinite(info.sourceStart)||info.sourceStart<0||!Number.isFinite(info.duration)||info.duration<=0||info.duration>120)throw new Error('Invalid selected audio range.');
  var segments=info.segments;
  if(segments){if(!Array.isArray(segments)||!segments.length||segments.length>32)throw new Error('Invalid precomp audio.');segments.forEach(function(s){if(s&&s.rate===undefined)s.rate=1;if(!s||typeof s.file!=='string'||!path.isAbsolute(s.file)||!fs.statSync(s.file).isFile()||!Number.isFinite(s.sourceStart)||s.sourceStart<0||!Number.isFinite(s.rate)||s.rate<0.0625||s.rate>16||!Number.isFinite(s.duration)||s.duration<=0||!Number.isFinite(s.delay)||s.delay<0||s.delay+s.duration>info.duration+.05)throw new Error('Invalid precomp audio range.');});}
  var binary=path.join(root,'bin','speech-ffmpeg');fs.accessSync(binary,fs.constants.X_OK);
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'dm-speech-'));fs.chmodSync(dir,0o700);progress('Extracting selected audio…');
  if(info.audioMap){rampJob=require(path.join(root,'js','transcribe-remap.js')).render(info.audioMap,info.duration,binary,path.join(dir,'speech.wav'),progress);return rampJob.promise;}
  return new Promise(function(resolve,reject){
   var args=['-nostdin','-hide_banner','-loglevel','error'];
   if(segments){var filters=[],labels=[];segments.forEach(function(s,i){args=args.concat(['-ss',String(s.sourceStart),'-t',String(s.duration*s.rate),'-i',s.file]);var tempos=[],speed=s.rate;while(speed>2){tempos.push('atempo=2');speed/=2;}while(speed<0.5){tempos.push('atempo=0.5');speed*=2;}tempos.push('atempo='+speed);filters.push('['+i+':a:0]aresample=16000,asetpts=PTS-STARTPTS,'+tempos.join(',')+',apad,atrim=duration='+s.duration+',adelay='+Math.round(s.delay*1000)+':all=1[a'+i+']');labels.push('[a'+i+']');});filters.push(labels.join('')+'amix=inputs='+segments.length+':normalize=0,apad[out]');args=args.concat(['-filter_complex',filters.join(';'),'-map','[out]','-t',String(info.duration)]);}
   else args=args.concat(['-ss',String(info.sourceStart),'-i',info.file,'-t',String(info.duration),'-map','0:a:0']);
   args=args.concat(['-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-y',path.join(dir,'speech.wav')]);
   child=cp.execFile(binary,args,{timeout:90000,maxBuffer:1024*1024},function(err){child=null;if(err)reject(new Error(cancelled?'Transcription cancelled.':'Could not extract audio from this layer.'));else resolve();});
  });
 }).then(function(){
  check();var file=path.join(dir,'speech.wav');fs.chmodSync(file,0o600);var bytes=fs.readFileSync(file);if(bytes.length<100||bytes.length>24*1024*1024)throw new Error('The extracted audio is empty or too large.');
  if(provider==='local'){localJob=require(path.join(root,'js','transcribe-local.js')).run(file,root,progress,info.duration);return localJob.promise.then(function(words){groupWords(words,8,info.duration,info.frameDuration);return words;});}
  var boundary='dm'+crypto.randomBytes(16).toString('hex'),parts=[];
  [['model',config.model],['response_format','verbose_json'],['timestamp_granularities[]','word']].forEach(function(f){parts.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="'+f[0]+'"\r\n\r\n'+f[1]+'\r\n'));});
  parts.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n'),bytes,Buffer.from('\r\n--'+boundary+'--\r\n'));var body=Buffer.concat(parts);progress('Transcribing with '+config.label+'…');
  return new Promise(function(resolve,reject){
   var timer=setTimeout(function(){if(request)request.destroy(new Error('Transcription timed out.'));},180000);
   request=https.request({hostname:config.host,path:config.path,method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':body.length}},function(res){var chunks=[],size=0;res.on('data',function(b){size+=b.length;if(size>4*1024*1024){request.destroy(new Error('Transcription response too large.'));return;}chunks.push(b);});res.on('error',function(){clearTimeout(timer);reject(new Error('Transcription connection failed.'));});res.on('end',function(){clearTimeout(timer);if(res.statusCode!==200){reject(new Error(res.statusCode===401?config.label+' rejected the API key.':res.statusCode===429?config.label+' usage limit reached. Check your account limits or try again later.':'Transcription failed (HTTP '+res.statusCode+').'));return;}try{check();var data=JSON.parse(Buffer.concat(chunks).toString('utf8'));groupWords(data.words,8,info.duration,info.frameDuration);resolve(data.words);}catch(e){reject(new Error(e.message||'Invalid transcription response.'));}});});
   request.on('error',function(){clearTimeout(timer);reject(new Error(cancelled?'Transcription cancelled.':'Transcription connection failed or timed out.'));});request.end(body);
  });
 });
 promise=promise.then(function(words){check();progress('Grouping phrases by meaning…');contextJob=require(path.join(root,'js','transcribe-context.js')).plan(words);return contextJob.promise;});
 promise=promise.then(function(v){cleanup();return v;},function(e){cleanup();throw e;});
 return {promise:promise,cancel:function(){cancelled=true;if(rampJob)rampJob.cancel();if(contextJob)contextJob.cancel();if(localJob)localJob.cancel();if(child)child.kill();if(request)request.destroy();}};
}
var api={transcribe:transcribe,groupWords:groupWords,autoGroup:autoGroup,captionText:captionText,retimeWords:retimeWords,timeRows:timeRows,semanticJob:function(words,root){return require(path.join(root,'js','transcribe-context.js')).plan(words);}};if(typeof window!=='undefined')window.DmTranscribe=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})();
