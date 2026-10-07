// Auditor de conformidade: regras do Matheus + estatisticas do corpus
var cp=require('child_process'), fs=require('fs');
var CAL='/Users/desiremedia/Documents/DM_Tools_CEP/calibration';
var music=JSON.parse(fs.readFileSync(CAL+'/lastMusic.json'));
var vet=JSON.parse(fs.readFileSync(CAL+'/vetoes.json')).vetoes;
var runsFile=(function(){var lp=JSON.parse(fs.readFileSync(CAL+'/lastPlan.json'));return CAL+'/runs/'+lp.runId+'.json';})();
var runs={};JSON.parse(fs.readFileSync(runsFile)).forEach(function(r){runs[r.path]=r;});
var vc=JSON.parse(fs.readFileSync(CAL+'/visionCache.json'));var catOf={};
Object.keys(vc).forEach(function(k){catOf[k.split('|')[0]]=vc[k].cat;});
var beats=music.beats;
var SEEDS=process.env.DM_SEEDS?process.env.DM_SEEDS.split(',').map(Number):[11,22,33,44,55,66,77,88];
var agg={durs:[],runsT:[],fails:{},acs:[]};
function fail(id,seed,msg){agg.fails[id]=agg.fails[id]||[];agg.fails[id].push('s'+seed+(msg?': '+msg:''));}
function famOf(path,a,b){var r=runs[path];if(!r)return'?';var f=r.fps,net=0,div=0,n=0;
 for(var i=Math.round(a*f);i<Math.min(r.mx.length,Math.round(b*f));i++){net+=r.mx[i];div+=r.div[i];n++;}
 if(!n)return'?';net/=n;div/=n;var ps=Math.max(0,-div)/0.03,ls=Math.abs(net)/0.05;
 return (ps>=ls&&ps>0.3)?'push':(ls>0.3?'lateral':'hold');}
function magOf(path,a,b){var r=runs[path];if(!r)return null;var f=r.fps,s=0,n=0;
 for(var i=Math.round(a*f);i<Math.min(r.mag.length,Math.round(b*f));i++){s+=r.mag[i];n++;}
 return n?s/n:null;}
SEEDS.forEach(function(seed){
 cp.execSync('node /Users/desiremedia/Documents/DM_Tools_CEP/js/cutGrid.js build --seed '+seed+' >/dev/null 2>&1');
 cp.execSync('node /Users/desiremedia/Documents/DM_Tools_CEP/js/autoAssembly.js plan --seed 4 >/dev/null 2>&1');
 var asm=JSON.parse(fs.readFileSync(CAL+'/lastAssembly.json'));
 var items=asm.items.slice().sort(function(a,b){return a.t-b.t;});
 var J=JSON.stringify(asm);
 // R10 gaps: geometrico (uniao de cobertura 0->fim da musica) / missing
 (function(){
  var mlen2=asm.music.outSec-asm.music.inSec,cur=0,gs=[];
  items.forEach(function(it){var a=it.t,b=it.t+(it.srcOut-it.srcIn)/(it.speed||1);
   if(a>cur+0.05)gs.push(cur.toFixed(1)+'-'+a.toFixed(1));cur=Math.max(cur,b);});
  if(cur<mlen2-0.05)gs.push(cur.toFixed(1)+'-fim');
  if(gs.length)fail('R10-gaps',seed,gs.join(','));
 })();
 if(/MISSING/.test(J))fail('R10-missing',seed);
 // R1 sem repeticao
 var seen={};items.forEach(function(it){if(seen[it.path])fail('R1-repete',seed,it.name);seen[it.path]=1;});
 // R2 nada depois do closing
 if(!/CLOSING|outro/.test(items[items.length-1].label))fail('R2-pos-closing',seed,items[items.length-1].label);
 // R9 fim = musica. Closing RAMPEADO: material alem do END eh intencional
 // (remap do AE assenta a key 3 no END) — checa so que o material ALCANCA.
 var last=items[items.length-1];var end=last.t+(last.srcOut-last.srcIn)/(last.speed||1);
 var mlen=asm.music.outSec-asm.music.inSec;
 if(last.rampIn?(end<mlen-0.05||last.t>=mlen):(Math.abs(end-mlen)>0.25))fail('R9-fim',seed,end.toFixed(1)+'/'+mlen.toFixed(1));
 // R3 facade no drop-beat
 var dropRel=music.section.drop-music.section.start;
 var dropIt=items.filter(function(it){return /DROP: FACADE/.test(it.label);})[0];
 if(!dropIt)fail('R3-facade',seed,'sem slot');
 else{if(Math.abs(dropIt.t-Math.floor(dropRel*25)/25)>0.05)fail('R3-facade-beat',seed,dropIt.t+' vs '+dropRel);
  if((catOf[dropIt.path]||'')!=='facade')fail('R3-facade-cat',seed,catOf[dropIt.path]||'?');}
 // R4 ramps: familia igual + sobra >=1.9s
 items.forEach(function(it,i){
  if(!it.rampIn||i===0)return;
  var pv=items[i-1];
  var f1=famOf(pv.path,pv.srcIn,pv.srcOut),f2=famOf(it.path,it.srcIn,it.srcOut);
  if(f1!=='?'&&f2!=='?'&&f1!==f2&&f1!=='hold')fail('R4-familia',seed,pv.name+'('+f1+')->'+it.name+'('+f2+')');
  var tail=(pv.t+(pv.srcOut-pv.srcIn)/(pv.speed||1))-it.t;
  if(tail<1.85)fail('R4-sobra',seed,it.name+' tail='+tail.toFixed(2));});
 // R5 wides estaticos — closing isento: gramatica do corpus manda o
 // fechamento ser o shot mais CALMO (mediana 0.28, drift lento e longo)
 items.forEach(function(it){if(it.speed===1&&!/CLOSING/.test(it.label)){var m=magOf(it.path,it.srcIn,it.srcOut);
  if(m!=null&&m<=0.10)fail('R5-estatico',seed,it.name+' mag='+m.toFixed(2));}});
 // R6 vetos
 items.forEach(function(it){vet.forEach(function(v){
  if(it.name!==v.name)return;
  if(v.type==='clip')fail('R6-veto-clip',seed,it.name);
  else if(it.srcIn<v.t1&&it.srcOut>v.t0)fail('R6-veto-janela',seed,it.name);});});
 // R7 speeds
 items.forEach(function(it){if(it.speed!==1&&it.speed!==0.5)fail('R7-speed',seed,it.name+' '+it.speed);});
 // R11 semantica REAL do Premiere: setSpeed(0.5) EXPANDE o clip pra
 // source/0.5 na timeline (licao do bug 50x + conversao do Learn Finished).
 // A extensao tem que caber no espaco LIVRE ate o proximo item da mesma
 // track (needed sozinho reprova stretch legitimo sobre slot held).
 items.forEach(function(it){
  if(it.speed!==0.5)return;
  var ext=(it.srcOut-it.srcIn)/0.5;
  var nxt=null;
  items.forEach(function(o){if(o!==it&&o.track===it.track&&o.t>it.t+0.02&&(nxt==null||o.t<nxt))nxt=o.t;});
  var room=(nxt!=null?nxt:1e9)-it.t;
  if(ext>room+0.05)fail('R11-tight-estoura',seed,it.name+' ext='+ext.toFixed(2)+'s espaco='+room.toFixed(2)+'s');
 });
 // R12 expansao do setSpeed nao pode colidir: nenhum item na MESMA track
 // pode comecar DENTRO da extensao final de um tight (QE vira loteria)
 items.forEach(function(it){
  if(it.speed!==0.5)return;
  var ext=(it.srcOut-it.srcIn)/0.5;
  items.forEach(function(o){
   if(o===it||o.track!==it.track)return;
   if(o.t>it.t+0.02&&o.t<it.t+ext-0.02)fail('R12-expansao-colide',seed,it.name+' x '+o.name+' @'+o.t.toFixed(2));
  });
 });
 // R8 corte no beat (0 a -1.5 frames, nunca depois)
 items.forEach(function(it){
  if(/fill|INTRO DRONE/.test(it.label))return;
  var t=it.t+ (music.section.start);
  var best=99;beats.forEach(function(b){var d=t-b;if(Math.abs(d)<Math.abs(best))best=d;});
  if(best>0.045)fail('R8-depois-do-beat',seed,it.label.slice(0,18)+' +'+(best/0.04).toFixed(1)+'f');});
 // stats
 var ds=[];for(var i=0;i<items.length-1;i++){var d=(items[i+1].t-items[i].t)/music.barDur;if(d>0.05&&d<6)ds.push(d);}
 agg.durs=agg.durs.concat(ds);
 var mu=ds.reduce(function(a,b){return a+b;},0)/ds.length,num=0,den=0;
 for(var i=0;i<ds.length-1;i++){num+=(ds[i]-mu)*(ds[i+1]-mu);}
 ds.forEach(function(x){den+=(x-mu)*(x-mu);});
 if(den>0)agg.acs.push(num/den);
 // tights-entre-wides como o corpus mede: run limitado por wides, pos-drop
 var dropT=dropIt?dropIt.t:0;var run=0,sawWide=false;
 items.forEach(function(it){
  if(it.t<dropT-0.01)return;
  if(it.speed===0.5){run++;}
  else{if(run&&sawWide)agg.runsT.push(Math.min(run,4));run=0;sawWide=true;}
 });
});
// relatorio
console.log('=== REGRAS (8 seeds) ===');
var IDs=['R1-repete','R2-pos-closing','R3-facade','R3-facade-beat','R3-facade-cat','R4-familia','R4-sobra','R5-estatico','R6-veto-clip','R6-veto-janela','R7-speed','R8-depois-do-beat','R9-fim','R10-gaps','R10-missing','R11-tight-estoura','R12-expansao-colide'];
IDs.forEach(function(id){
 var f=agg.fails[id];
 console.log((f?'✗':'✓')+' '+id+(f?'  ['+f.slice(0,3).join(' | ')+(f.length>3?' +'+(f.length-3):'')+']':''));});
console.log('\n=== ESTATISTICAS vs CORPUS ===');
function q(d){var S=[0.25,0.5,0.75,1.0,1.5,2.0,3.0,4.0];for(var i=0;i<S.length;i++)if(d<=S[i]*1.24)return S[i];return 4;}
var c={};agg.durs.forEach(function(d){var s=q(d);c[s]=(c[s]||0)+1;});
var tot=agg.durs.length;
console.log('duracoes geradas: 0.25:'+Math.round(100*(c[0.25]||0)/tot)+'% 0.5:'+Math.round(100*(c[0.5]||0)/tot)+'% 0.75:'+Math.round(100*(c[0.75]||0)/tot)+'% 1.0:'+Math.round(100*(c[1]||0)/tot)+'%  (corpus: 18/43/11/13)');
console.log('autocorr gerada: '+(agg.acs.reduce(function(a,b){return a+b;},0)/agg.acs.length).toFixed(2)+' (corpus real: 0.13; robotico: 0.00)');
var rc={};agg.runsT.forEach(function(r){rc[r]=(rc[r]||0)+1;});var rt=agg.runsT.length;
console.log('tights seguidos: 1:'+Math.round(100*(rc[1]||0)/rt)+'% 2:'+Math.round(100*(rc[2]||0)/rt)+'% 3:'+Math.round(100*(rc[3]||0)/rt)+'%  (corpus: 63/22/8)');
