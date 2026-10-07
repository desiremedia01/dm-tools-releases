/* Quick Export renders sequence In/Out via Premiere. Source media is never substituted. */
(function () {
    if (typeof document === 'undefined') return;

    var FFMPEG_PATHS = ['/Applications/Wavdrop.app/Contents/Resources/ffmpeg',
        '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg',
        '/Users/desiremedia/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg'];

    function extRoot() { try { return (typeof cs !== 'undefined' && cs) ? cs.getSystemPath('extension') : '.'; } catch (e) { return '.'; } }
    function lutsPath() { return extRoot() + '/assets/luts/conversion/'; }
    function ffmpegCandidates() {
        var out = [];
        try { var b = window.DM_BUNDLED_FFMPEG && window.DM_BUNDLED_FFMPEG(); if (b) out.push(b); } catch (e) {}
        try { var fs = require('fs'); for (var i = 0; i < FFMPEG_PATHS.length; i++) { if (fs.existsSync(FFMPEG_PATHS[i]) && out.indexOf(FFMPEG_PATHS[i]) === -1) out.push(FFMPEG_PATHS[i]); } } catch (e) {}
        return out;
    }
    function listLuts() {
        try { return require('fs').readdirSync(lutsPath()).filter(function (f) { return /\.cube$/i.test(f); }).map(function (f) { return f.replace(/\.cube$/i, ''); }); }
        catch (e) { return []; }
    }
    function revealInFinder(p) { try { require('child_process').execFile('/usr/bin/open', ['-R', p]); } catch (e) {} }

    var btn = document.getElementById('prQuickExport');
    if (!btn) return;

    // Metadata from the sequence; no source clip resolution.
    var jsxRead='(function(){try{var s=app.project.activeSequence;if(!s)return "ERR:No active sequence";var a=s.getInPointAsTime().seconds,b=s.getOutPointAsTime().seconds;if(!isFinite(a)||!isFinite(b)||a<0||b<=a)return "ERR:Set in and out points on the timeline first";var name=(s.name||"Sequence").replace(/[^A-Za-z0-9 _-]/g,"_");return "OK\\t"+(app.project.path||"")+"\\t"+name+"\\t"+s.sequenceID+"\\t"+a+"\\t"+b;}catch(e){return "ERR:"+e;}}())';
    btn.addEventListener('click', function () {
        if (HOST !== 'PPRO') { setStatus('Quick Export only works in Premiere', 'error'); return; }
        var ffList = ffmpegCandidates();


        evalScript(jsxRead, function (res) {
            if (!res || res.indexOf('ERR:') === 0) { setStatus(res ? res.replace('ERR:', '') : 'Could not read timeline', 'error'); return; }
            var p = res.split('\t');
            var info={projPath:p[1],name:p[2],id:p[3],start:Number(p[4]),end:Number(p[5])};
            showLutPicker(info);
        });
    });

    function showLutPicker(info) {
        var luts = listLuts();
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = '<div style="background:#1e1e1e;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:18px 20px;min-width:240px">' +
            '<div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:10px">Quick Export — LUT</div>' +
            '<select id="qeLutPick" style="width:100%;background:#2a2a2a;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:7px;font-size:12px;margin-bottom:14px">' +
            '<option value="" style="background:#2a2a2a;color:#fff">— No LUT —</option>' + luts.map(function (l) { return '<option value="' + l + '" style="background:#2a2a2a;color:#fff">' + l + '</option>'; }).join('') + '</select>' +
            '<div style="display:flex;gap:8px"><button id="qeCancel" class="btn" style="flex:1">Cancel</button>' +
            '<button id="qeGo" class="btn btn--accent" style="flex:1">Export</button></div></div>';
        document.body.appendChild(overlay);
        document.getElementById('qeCancel').onclick = function () { overlay.remove(); };
        document.getElementById('qeGo').onclick = function () {
            var lut = document.getElementById('qeLutPick').value;
            overlay.remove();
            runExport(info, lut, ffmpegCandidates());
        };
    }

    function runExport(info,lutName,ffList){
        var fs=require('fs'),path=require('path'),cp=require('child_process');
        var dir=path.join(info.projPath?path.dirname(info.projPath):require('os').homedir()+'/Desktop','Quick Export');
        var preset=path.join(extRoot(),'presets','quick_export_match_sequence.epr'),work,rendered,out;
        function done(error){btn.disabled=false;if(work){try{fs.readdirSync(work).forEach(function(f){fs.unlinkSync(path.join(work,f));});fs.rmdirSync(work);}catch(e){}}if(error)setStatus(error,'error');else{revealInFinder(out);setStatus('Exported ✓ '+path.basename(out),'success');}}
        try{if(!fs.existsSync(preset))throw new Error('Timeline export preset is missing.');if(lutName&&!ffList.length)throw new Error('FFmpeg is needed for an additional LUT.');fs.mkdirSync(dir,{recursive:true});work=fs.mkdtempSync(path.join(dir,'.dm-export-'));rendered=path.join(work,'timeline.mp4');out=path.join(dir,info.name+'_'+Date.now()+'.mp4');}catch(e){done(e.message);return;}
        btn.disabled=true;setStatus('Rendering timeline In/Out in Premiere…','busy');
        var jsx='(function(){try{var s=app.project.activeSequence;if(!s||String(s.sequenceID)!=='+JSON.stringify(info.id)+')return "ERR:Active sequence changed. Try again.";if(Math.abs(s.getInPointAsTime().seconds-'+info.start+')>0.0001||Math.abs(s.getOutPointAsTime().seconds-'+info.end+')>0.0001)return "ERR:In/Out points changed. Try again.";var result=s.exportAsMediaDirect('+JSON.stringify(rendered)+','+JSON.stringify(preset)+',1);return "OK:"+result;}catch(e){return "ERR:"+e;}}())';
        evalScript(jsx,function(result){
            if(!result||result.indexOf('ERR:')===0){done('Timeline export failed: '+(result||'No response'));return;}
            if(!fs.existsSync(rendered)||fs.statSync(rendered).size<1000){done('Premiere did not finish the timeline export. '+result);return;}
            if(!lutName){try{if(fs.existsSync(out))throw new Error('Output already exists. Try again.');fs.renameSync(rendered,out);done();}catch(e){done(e.message);}return;}
            var lut=path.join(work,'conversion.cube');try{fs.copyFileSync(lutsPath()+lutName+'.cube',lut);}catch(e){done('Could not read the selected LUT.');return;}
            var filtered=path.join(work,'filtered.mp4');
            (function convert(i){if(i>=ffList.length){done('Could not apply the extra LUT to the timeline export.');return;}
                // Relative LUT path avoids spaces and filter escaping in project paths.
                cp.execFile(ffList[i],['-y','-i',rendered,'-vf','lut3d=conversion.cube','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',filtered],{cwd:work,timeout:600000},function(err){if(err){convert(i+1);return;}try{if(fs.existsSync(out))throw new Error('Output already exists.');fs.renameSync(filtered,out);done();}catch(e){done(e.message);}});
            })(0);
        });
    }
})();
