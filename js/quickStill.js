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
    function revealInFinder(p) { try { require('child_process').exec('open -R ' + JSON.stringify(p)); } catch (e) {} }

    var btn = document.getElementById('prQuickStill');
    if (!btn) return;

    // JSX: read the clip under the PLAYHEAD (source path, speed-aware seek) — plain string, ES3-safe
    var jsxRead = '(function(){' +
        'var seq=app.project.activeSequence;' +
        'if(!seq)return "ERR:No active sequence";' +
        'function S(t){try{if(t==null)return -1;if(typeof t.seconds==="number"&&!isNaN(t.seconds))return t.seconds;if(t.ticks!=null)return parseFloat(t.ticks)/254016000000;var p=parseFloat(t);return isNaN(p)?-1:p;}catch(e){return -1;}}' +
        'var phS=-1;try{phS=S(seq.getPlayerPosition());}catch(e){}' +
        'if(phS<0)return "ERR:Could not read the playhead position";' +
        'var srcPath="",clipStart=0,mediaStart=0,spd=1;' +
        'outer:for(var t=seq.videoTracks.numTracks-1;t>=0;t--){var tr=seq.videoTracks[t];' +
        'for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];' +
        'var cs2=S(cl.start),ce=S(cl.end);' +
        'if(cs2<=phS&&ce>phS){try{srcPath=cl.projectItem.getMediaPath();}catch(e){}' +
        'clipStart=cs2;try{mediaStart=S(cl.inPoint);}catch(e){}' +
        'try{app.enableQE();var qs=qe.project.getActiveSequence();var qt=qs.getVideoTrackAt(t);' +
        'for(var qi=0;qi<qt.numItems;qi++){var qc=qt.getItemAt(qi);if(!qc||qc.type==="Empty")continue;' +
        'var qst=qc.start&&!isNaN(qc.start.seconds)?qc.start.seconds:(qc.start?parseFloat(qc.start.ticks)/254016000000:NaN);' +
        'if(!isNaN(qst)&&Math.abs(qst-clipStart)<0.02){var sp=Math.abs(qc.speed);if(sp>0)spd=sp;break;}}}catch(e){}' +
        'break outer;}}}' +
        'if(!srcPath)return "ERR:No clip under the playhead";' +
        'var seek=(mediaStart+(phS-clipStart))*spd;' +
        'var projPath="";try{projPath=app.project.path||"";}catch(e){}' +
        'var nm=(seq.name||"Sequence").replace(/[^A-Za-z0-9 _-]/g,"_");' +
        'return "OK\\t"+srcPath+"\\t"+seek+"\\t"+spd+"\\t"+projPath+"\\t"+nm;' +
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
        var jsxFrame = '(function(){var seq=app.project.activeSequence;if(!seq)return "ERR:No active sequence";' +
            'var pos=seq.getPlayerPosition();var tp=Folder.temp.fsName+"/dm_qs_"+(new Date().getTime())+".jpg";' +
            'try{seq.exportFrameJPEG(pos,tp);return "OK\\t"+tp;}catch(e){return "ERR:"+e.message;}}())';
        evalScript(jsxFrame, function (res) {
            if (!res || res.indexOf('ERR:') === 0) { setStatus('Quick Still failed: ' + (res ? res.replace('ERR:', '') : 'could not render frame'), 'error'); btn.disabled = false; return; }
            var jpg = res.split('\t')[1];
            if (!jpg || !fs.existsSync(jpg)) { setStatus('Quick Still failed (no rendered frame)', 'error'); btn.disabled = false; return; }
            if (!ffList.length) {   // no ffmpeg — keep the JPEG as-is
                var jpgOut = outPath.replace(/\.png$/i, '.jpg');
                try { fs.renameSync(jpg, jpgOut); finishStill(jpgOut); } catch (e) { setStatus('Still save failed', 'error'); btn.disabled = false; }
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
