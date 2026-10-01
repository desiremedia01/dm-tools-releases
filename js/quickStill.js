/* ── Quick Still ──────────────────────────────────────────────────────
   Same method as Quick Export, but grabs a SINGLE frame at the playhead
   straight from the clip's source file via FFmpeg (fast, no timeline render),
   optionally bakes in a conversion LUT, and saves a PNG into the project's
   "assets" folder (one level above the .prproj), then reveals it in Finder.
   Great for grabbing a reference still for Higgsfield jobs. */
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

    var btn = document.getElementById('prQuickStill');
    if (!btn) return;

    // JSX: resolve the clip under the PLAYHEAD — top track wins, and nested
    // sequences are drilled into until the real media file is reached.
    var NEST_RESOLVER = 'function S(t){try{if(t==null)return -1;if(typeof t.seconds==="number"&&!isNaN(t.seconds))return t.seconds;if(t.ticks!=null)return parseFloat(t.ticks)/254016000000;var p=parseFloat(t);return isNaN(p)?-1:p;}catch(e){return -1;}}function qeSeqFor(sq){try{app.enableQE();var n=qe.project.numSequences;for(var i=0;i<n;i++){var q=qe.project.getSequenceAt(i);if(q&&q.name===sq.name)return q;}}catch(e){}return null;}function spdAt(sq,t,cs){var spd=1;try{var qs=qeSeqFor(sq);if(!qs)return 1;var qt=qs.getVideoTrackAt(t);for(var i=0;i<qt.numItems;i++){var qc=qt.getItemAt(i);if(!qc||qc.type==="Empty")continue;var st=(qc.start&&!isNaN(qc.start.seconds))?qc.start.seconds:(qc.start?parseFloat(qc.start.ticks)/254016000000:NaN);if(!isNaN(st)&&Math.abs(st-cs)<0.02){var sp=Math.abs(qc.speed);if(sp>0)spd=sp;break;}}}catch(e){}return spd;}function subSeqOf(pi){var nid="";try{nid=pi.nodeId;}catch(e){}var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){try{if(nid&&ss[i].projectItem.nodeId===nid)return ss[i];}catch(e){}}var nm="";try{nm=pi.name;}catch(e){}if(nm){for(var j=0;j<ss.numSequences;j++){if(ss[j].name===nm)return ss[j];}}return null;}function resolve(sq,T,cum,depth){if(depth>6)return null;for(var t=sq.videoTracks.numTracks-1;t>=0;t--){var tr=sq.videoTracks[t];for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];var cs=S(cl.start),ce=S(cl.end);if(!(cs<=T&&ce>T))continue;var pi=cl.projectItem;var ms=0;try{ms=S(cl.inPoint);if(ms<0)ms=0;}catch(e){}var sp=spdAt(sq,t,cs);var inner=(ms+(T-cs))*sp;var mp="";try{mp=pi.getMediaPath();}catch(e){}if(mp){return {src:mp,seek:inner,spd:cum*sp,pi:pi};}var sub=subSeqOf(pi);if(sub){var r=resolve(sub,inner,cum*sp,depth+1);if(r)return r;}}}return null;}';
    var jsxRead = '(function(){' +
        'var seq=app.project.activeSequence;' +
        'if(!seq)return "ERR:No active sequence";' +
        NEST_RESOLVER +
        'var phS=-1;try{phS=S(seq.getPlayerPosition());}catch(e){}' +
        'if(phS<0)return "ERR:Could not read the playhead position";' +
        'var r=resolve(seq,phS,1,0);' +
        'if(!r)return "ERR:No clip under the playhead";' +
        'var projPath="";try{projPath=app.project.path||"";}catch(e){}' +
        'var nm=(seq.name||"Sequence").replace(/[^A-Za-z0-9 _-]/g,"_");' +
        'return "OK\\t"+r.src+"\\t"+r.seek+"\\t"+r.spd+"\\t"+projPath+"\\t"+nm;' +
        '}())';

    btn.addEventListener('click', function () {
        if (HOST !== 'PPRO') { setStatus('Quick Still only works in Premiere', 'error'); return; }
        var ffList = ffmpegCandidates();
        if (!ffList.length) { setStatus('FFmpeg not found on this machine', 'error'); return; }

        evalScript(jsxRead, function (res) {
            if (!res || res.indexOf('ERR:') === 0) { setStatus(res ? res.replace('ERR:', '') : 'Could not read timeline', 'error'); return; }
            var p = res.split('\t');
            var info = { src: p[1], seek: parseFloat(p[2]) || 0, speed: parseFloat(p[3]) || 1, projPath: p[4] || '', name: p[5] || 'Sequence' };
            try { require('fs').writeFileSync('/tmp/dm_still.log', 'RAW: ' + res + '\nparsed: ' + JSON.stringify(info)); } catch (e) {}
            if (!info.src) { setStatus('No clip under the playhead', 'error'); return; }
            showLutPicker(info);
        });
    });

    function showLutPicker(info) {
        var luts = listLuts();
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = '<div style="background:#1e1e1e;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:18px 20px;min-width:240px">' +
            '<div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:10px">Quick Still — LUT</div>' +
            '<select id="qsLutPick" style="width:100%;background:#2a2a2a;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:7px;font-size:12px;margin-bottom:14px">' +
            '<option value="" style="background:#2a2a2a;color:#fff">— No LUT —</option>' + luts.map(function (l) { var sel = /^slog3$/i.test(l) ? ' selected' : ''; return '<option value="' + l + '"' + sel + ' style="background:#2a2a2a;color:#fff">' + l + '</option>'; }).join('') + '</select>' +
            '<div style="display:flex;gap:8px"><button id="qsCancel" class="btn" style="flex:1">Cancel</button>' +
            '<button id="qsGo" class="btn btn--accent" style="flex:1">Grab Still</button></div></div>';
        document.body.appendChild(overlay);
        document.getElementById('qsCancel').onclick = function () { overlay.remove(); };
        document.getElementById('qsGo').onclick = function () {
            var lut = document.getElementById('qsLutPick').value;
            overlay.remove();
            runStill(info, lut, ffmpegCandidates());
        };
    }

    // Target dir: the project's "assets" folder — a sibling of the project folder
    // (one level above where the .prproj lives, matching the /job/assets convention).
    function assetsDir(projPath) {
        var path = require('path'), fs = require('fs');
        if (!projPath) return process.env.HOME + '/Desktop';
        var projDir = path.dirname(projPath);
        var parent = path.dirname(projDir);
        var candidates = [path.join(parent, 'assets'), path.join(projDir, 'assets')];
        for (var i = 0; i < candidates.length; i++) {
            try { if (fs.existsSync(candidates[i]) && fs.statSync(candidates[i]).isDirectory()) return candidates[i]; } catch (e) {}
        }
        return path.join(parent, 'assets');
    }

    function lutFile(lutName) {
        if (!lutName) return '';
        try { var tl = require('os').tmpdir() + '/dm_qs_lut.cube'; require('fs').copyFileSync(lutsPath() + lutName + '.cube', tl); return tl; } catch (e) { return ''; }
    }
    function finishStill(outPath) {
        revealInFinder(outPath);
        setStatus('Still saved ✓ ' + require('path').basename(outPath), 'success');
        btn.disabled = false;
    }

    // Next free integer name in the folder (max existing number + 1, else 1),
    // considering both .png and .jpg so numbers never collide.
    function nextNumber(outDir) {
        var max = 0;
        try {
            require('fs').readdirSync(outDir).forEach(function (f) {
                var m = f.match(/^(\d+)\.(png|jpe?g)$/i);
                if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
            });
        } catch (e) {}
        return max + 1;
    }

    function runStill(info, lutName, ffList) {
        var fs = require('fs'), path = require('path'), cp = require('child_process');
        var outDir = assetsDir(info.projPath);
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
        var num = nextNumber(outDir);
        var outPath = path.join(outDir, num + '.png');
        var tmpPath = path.join(outDir, '.tmp_still_' + Date.now() + '.png');
        var vf = ''; var lf = lutFile(lutName); if (lf) vf = 'lut3d=' + lf;

        setStatus('Grabbing still' + (lutName ? ' (' + lutName + ')' : '') + '...', 'busy');
        btn.disabled = true;

        // Dynamic-linked AE comps (.aep) have no flat media file — render via Premiere.
        if (/\.aep$/i.test(info.src)) { renderViaPremiere(lutName, vf, outDir, ffList, outPath); return; }

        (function tryFf(i) {
            if (i >= ffList.length) { renderViaPremiere(lutName, vf, outDir, ffList, outPath); return; }  // source unreadable → render fallback
            var ff = ffList[i];
            var args = [ff, '-y', '-ss', info.seek.toFixed(3), '-i', info.src, '-frames:v', '1'];
            if (vf) { args.push('-vf', vf); }
            args.push(tmpPath);
            cp.execFile('/usr/bin/nice', ['-n', '10'].concat(args), { timeout: 120000 }, function (err) {
                if (!err && fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) {
                    try { fs.renameSync(tmpPath, outPath); } catch (e2) { setStatus('Still rename failed', 'error'); btn.disabled = false; return; }
                    finishStill(outPath);
                } else {
                    try { fs.unlinkSync(tmpPath); } catch (e) {}
                    tryFf(i + 1);
                }
            });
        })(0);
    }

    // Fallback: render the frame at the playhead through Premiere (works for .aep,
    // nested sequences, mattes, etc.), then bake the LUT via ffmpeg if one was picked.
    function renderViaPremiere(lutName, vf, outDir, ffList, outPath) {
        var fs = require('fs'), path = require('path'), cp = require('child_process');
        setStatus('Rendering still from the timeline...', 'busy');
        // QE sequence export needs an HH:MM:SS:FF timecode string (the raw
        // Time/.timecode objects throw "Illegal Parameter") and writes async —
        // so compute the tc from the sequence fps, then wait + check the file.
        // Premiere's frame export via QE. Recipes differ between builds, so try them
        // in order (the one the Night Clip .aep path uses first), and for each WAIT
        // for the file — a Dynamic Link comp has to be rendered by AE first, so the
        // write is not instant. Also accept QE appending its own extension.
        var jsxFrame = '(function(){' +
            'var seq=app.project.activeSequence;if(!seq)return "ERR:No active sequence";' +
            'function pad(n){return (n<10?"0":"")+n;}' +
            'function tcCalc(secs,fps){var f=Math.round(secs*fps);var hh=Math.floor(f/(fps*3600));f-=hh*fps*3600;var mm=Math.floor(f/(fps*60));f-=mm*fps*60;var ss=Math.floor(f/fps);var ff=f-ss*fps;return pad(hh)+":"+pad(mm)+":"+pad(ss)+":"+pad(ff);}' +
            'var fps=25;try{var tb=parseFloat(seq.timebase);if(tb>1000)fps=Math.round(254016000000/tb);else if(tb>0&&tb<1)fps=Math.round(1/tb);}catch(e){}' +
            'var secs=0,tcRaw="";try{var pp=seq.getPlayerPosition();secs=(typeof pp.seconds==="number"&&!isNaN(pp.seconds))?pp.seconds:parseFloat(pp.ticks)/254016000000;try{tcRaw=String(pp.timecode||"");}catch(e0){}}catch(e){}' +
            'var base=Folder.temp.fsName+"/dm_qs_"+(new Date().getTime());var errs=[];' +
            'function found(q){var cands=[q,q+".png",q+".jpg",q+".jpeg"];for(var i=0;i<cands.length;i++){if(new File(cands[i]).exists)return cands[i];}return "";}' +
            'function waitFor(q){for(var i=0;i<20;i++){var f=found(q);if(f)return f;$.sleep(250);}return "";}' +
            'try{app.enableQE();var qs=qe.project.getActiveSequence();if(!qs)return "ERR:QE sequence not available";' +
            'var tcC=tcCalc(secs,fps);var tcs=[];if(tcRaw)tcs.push(tcRaw);if(tcC!==tcRaw)tcs.push(tcC);tcs.push(tcC.replace(/:(\\d\\d)$/,";$1"));' +
            'var fns=[["exportFrameAsPNG",".png"],["exportFrameJPEG",".jpg"],["exportFramePNG",".png"]];' +
            'for(var a=0;a<fns.length;a++){var fn=fns[a][0],ext=fns[a][1];' +
            'for(var t=0;t<tcs.length;t++){var out=base+"_"+a+""+t+ext;' +
            'try{qs[fn](tcs[t],out);}catch(e1){errs.push(fn+"("+tcs[t]+"):"+e1.message);continue;}' +
            'var got=waitFor(out);if(got)return "OK\\t"+got+"\\t"+fn+" "+tcs[t];' +
            'errs.push(fn+"("+tcs[t]+"):no file");}}' +
            '}catch(e){errs.push(e.message);}' +
            'return "ERR:Premiere could not export the frame ("+errs.join("; ")+")";' +
            '}())';
        evalScript(jsxFrame, function (res) {
            try { fs.appendFileSync('/tmp/dm_still.log', '\nQE frame: ' + String(res).slice(0, 400)); } catch (e) {}
            if (!res || res.indexOf('ERR:') === 0) { setStatus('Quick Still failed: ' + (res ? res.replace('ERR:', '') : 'could not render frame'), 'error'); btn.disabled = false; return; }
            var jpg = res.split('\t')[1];
            if (!jpg || !fs.existsSync(jpg)) { setStatus('Quick Still failed (no rendered frame)', 'error'); btn.disabled = false; return; }
            if (!ffList.length) {   // no ffmpeg — keep the exported frame as-is (png or jpg)
                var rawOut = /\.png$/i.test(jpg) ? outPath : outPath.replace(/\.png$/i, '.jpg');
                try { fs.renameSync(jpg, rawOut); finishStill(rawOut); } catch (e) { setStatus('Still save failed', 'error'); btn.disabled = false; }
                return;
            }
            (function tryFf(i) {
                if (i >= ffList.length) { setStatus('Quick Still failed (ffmpeg could not process the frame)', 'error'); btn.disabled = false; return; }
                var args = [ffList[i], '-y', '-i', jpg, '-frames:v', '1'];
                if (vf) { args.push('-vf', vf); }
                args.push(outPath);
                cp.execFile('/usr/bin/nice', ['-n', '10'].concat(args), { timeout: 120000 }, function (err) {
                    if (!err && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
                        try { fs.unlinkSync(jpg); } catch (e) {}
                        finishStill(outPath);
                    } else { tryFf(i + 1); }
                });
            })(0);
        });
    }
})();
