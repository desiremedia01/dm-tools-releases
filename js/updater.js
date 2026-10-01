var DmUpdater=(function(){
'use strict';
var VERSION='1.8.1',busy=false;
function newer(a,b){var x=a.split('.').map(Number),y=b.split('.').map(Number);for(var i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i];}return false;}
return {version:VERSION,check:function(updated,current,error){
 if(busy)return;busy=true;
 var fs=require('fs'),path=require('path'),root=new CSInterface().getSystemPath('extension'),engine=window.DmSecureUpdate;
 Promise.resolve().then(function(){return engine.download('https://raw.githubusercontent.com/desiremedia01/dm-tools-releases/main/signed-version.json',2*1024*1024);}).then(function(raw){
  var m=engine.validate(engine.verifyEnvelope(JSON.parse(raw.toString('utf8')),fs.readFileSync(path.join(root,'update-public.pem'),'utf8')));
  if(!newer(m.version,VERSION)){if(current)current();return;}
  var payloads=[];return m.files.reduce(function(p,f){return p.then(function(){engine.target(fs.realpathSync(root),f.path);return engine.download(f.url,f.size);}).then(function(b){payloads.push(b);});},Promise.resolve()).then(function(){engine.install(root,m,payloads);if(updated)updated(m.version,0,m.notes);});
 }).catch(function(e){if(e.status===404){if(current)current();}else if(error)error(e.message||'Secure update failed.');}).then(function(){busy=false;});
}};
})();
