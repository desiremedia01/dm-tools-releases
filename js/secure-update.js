/* Verified update engine: signed manifest, pinned URLs, hashes, bounded paths,
   all downloads verified before writes, exclusive lock and rollback on failure. */
(function () {
'use strict';
var fs=require('fs'), path=require('path'), crypto=require('crypto'), https=require('https');
var MAX_FILE=180*1024*1024, MAX_TOTAL=450*1024*1024;
function fail(message){throw new Error(message);}
function validate(payload,current){
    if(!payload||!/^\d+\.\d+\.\d+$/.test(payload.version))fail('Invalid update version.');
    if(!Array.isArray(payload.files)||!payload.files.length||payload.files.length>400)fail('Invalid update file list.');
    if(!Array.isArray(payload.notes)||payload.notes.length>30||payload.notes.some(function(n){return typeof n!=='string'||n.length>2000;}))fail('Invalid update notes.');
    var seen={},total=0;
    payload.files.forEach(function(f){
        if(!f||typeof f.path!=='string'||f.path.length>240||!/^(?:index\.html|version\.json|oauth-client\.json|update-public\.pem|(?:js|jsx|css|assets|bin|brand|calibration|CSXS)\/[A-Za-z0-9 _./-]+)$/.test(f.path))fail('Invalid update path.');
        if(f.path.split('/').some(function(p){return !p||p==='.'||p==='..'||p[0]==='.';}))fail('Unsafe update path.');
        var key=f.path.toLowerCase();if(seen[key])fail('Duplicate update path.');seen[key]=true;
        if(!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.size)||f.size<0||f.size>MAX_FILE)fail('Invalid update checksum or size.');
        total+=f.size;if(total>MAX_TOTAL)fail('Update too large.');
        var u;try{u=new URL(f.url);}catch(_){fail('Invalid update URL.');}
        if(u.protocol!=='https:'||u.hostname!=='raw.githubusercontent.com'||u.port||u.username||u.password||u.search||u.hash)fail('Untrusted update URL.');
        var prefix='/desiremedia01/dm-tools-releases/';var rest=u.pathname.slice(prefix.length),commit=rest.split('/')[0];
        if(u.pathname.indexOf(prefix)!==0||!/^[a-f0-9]{40}$/.test(commit)||decodeURIComponent(rest.slice(41))!==f.path)fail('Update URL must reference a fixed repository commit.');
    });
    return payload;
}
function verifyEnvelope(envelope,key){
    if(!envelope||typeof envelope.payload!=='string'||typeof envelope.signature!=='string'||envelope.payload.length>2*1024*1024)fail('Invalid signed manifest.');
    var bytes=Buffer.from(envelope.payload,'base64'),sig=Buffer.from(envelope.signature,'base64');
    if(!crypto.verify('RSA-SHA256',bytes,key,sig))fail('Update signature verification failed.');
    return JSON.parse(bytes.toString('utf8'));
}
function target(root,rel){
    var absolute=path.resolve(root,rel),prefix=path.resolve(root)+path.sep;
    if(absolute.indexOf(prefix)!==0)fail('Update path escapes extension.');
    var current=path.resolve(root);
    rel.split('/').forEach(function(part){current=path.join(current,part);try{if(fs.lstatSync(current).isSymbolicLink())fail('Update path contains a symbolic link.');}catch(e){if(e.code!=='ENOENT')throw e;}});
    return absolute;
}
function download(url,limit){
    return new Promise(function(resolve,reject){
        var parts=[],size=0;var req=https.get(url,function(res){
            if(res.statusCode!==200){res.resume();var e=new Error('Update download failed ('+res.statusCode+').');e.status=res.statusCode;reject(e);return;}
            res.on('data',function(b){size+=b.length;if(size>limit){req.destroy(new Error('Update response too large.'));return;}parts.push(b);});
            res.on('error',reject);res.on('end',function(){resolve(Buffer.concat(parts));});
        });req.setTimeout(60000,function(){req.destroy(new Error('Update download timed out.'));});req.on('error',reject);
    });
}
function install(root,manifest,buffers,injectFailure){
    root=fs.realpathSync(root);validate(manifest);
    manifest.files.forEach(function(f,i){var b=buffers[i];if(!Buffer.isBuffer(b)||b.length!==f.size||crypto.createHash('sha256').update(b).digest('hex')!==f.sha256)fail('Update content mismatch.');target(root,f.path);});
    var lockPath=path.join(root,'.dm-update.lock'),lock=fs.openSync(lockPath,'wx',0o600),stage,changed=[];
    try{
        stage=fs.mkdtempSync(path.join(root,'.dm-update-'));fs.chmodSync(stage,0o700);
        // Install the updater last so partial failures never advance its version.
        var order=manifest.files.map(function(_,i){return i;}).sort(function(a,b){return Number(manifest.files[a].path==='js/updater.js')-Number(manifest.files[b].path==='js/updater.js');});
        order.forEach(function(i){
            var f=manifest.files[i],dest=target(root,f.path),previous=null,mode=f.path.indexOf('bin/')===0?0o700:0o600;
            if(fs.existsSync(dest)){var stat=fs.statSync(dest);if(!stat.isFile())fail('Update target is not a file.');mode=stat.mode&0o777;previous=path.join(stage,'old-'+i);fs.copyFileSync(dest,previous);}
            var incoming=path.join(stage,'new-'+i);fs.writeFileSync(incoming,buffers[i],{flag:'wx',mode:mode});
            fs.mkdirSync(path.dirname(dest),{recursive:true});target(root,f.path);
            if(injectFailure)injectFailure(i);
            fs.renameSync(incoming,dest);changed.push({dest:dest,old:previous,mode:mode});
        });
    }catch(e){
        var rollbackFailed=false;
        changed.reverse().forEach(function(c){try{if(c.old){fs.copyFileSync(c.old,c.dest);fs.chmodSync(c.dest,c.mode);}else fs.unlinkSync(c.dest);}catch(_){rollbackFailed=true;}});
        if(rollbackFailed){e=new Error('Update failed; recovery files were preserved at '+stage);stage=null;}
        throw e;
    }finally{if(stage)fs.rmSync(stage,{recursive:true,force:true});fs.closeSync(lock);fs.unlinkSync(lockPath);}
}
var api={validate:validate,verifyEnvelope:verifyEnvelope,target:target,download:download,install:install};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
if(typeof window!=='undefined')window.DmSecureUpdate=api;
})();
