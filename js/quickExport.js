/* ── Quick Export ─────────────────────────────────────────────────────
   Same method as the Kling O1 Edit export: pulls the clip under the timeline
   in/out straight from its SOURCE file via FFmpeg (fast, no timeline render),
   optionally bakes in a conversion LUT, saves to "Quick Export/" beside the
   project at native resolution, then reveals it in Finder. */
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

    var btn = document.getElementById('prQuickExport');
    if (!btn) return;

    // JSX: read the clip under the timeline in-point (source path, speed-aware seek, duration) — plain string, ES3-safe
    var jsxRead = '(function(){' +
        'var seq=app.project.activeSequence;' +
        'if(!seq)return "ERR:No active sequence";' +
        'function S(t){try{if(t==null)return -1;if(typeof t.seconds==="number"&&!isNaN(t.seconds))return t.seconds;if(t.ticks!=null)return parseFloat(t.ticks)/254016000000;var p=parseFloat(t);return isNaN(p)?-1:p;}catch(e){return -1;}}' +
        'var inS=-1,outS=-1;' +
        'try{inS=S(seq.getInPointAsTime());}catch(e){}' +
        'try{outS=S(seq.getOutPointAsTime());}catch(e){}' +
        'if(inS<0||outS<=inS)return "ERR:Set in and out points on the timeline first";' +
        'var srcPath="",clipStart=0,mediaStart=0,spd=1;' +
        'outer:for(var t=0;t<seq.videoTracks.numTracks;t++){var tr=seq.videoTracks[t];' +
        'for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];' +
        'var cs2=S(cl.start),ce=S(cl.end);' +
        'if(cs2<=inS&&ce>=inS){try{srcPath=cl.projectItem.getMediaPath();}catch(e){}' +
        'clipStart=cs2;try{mediaStart=S(cl.inPoint);}catch(e){}' +
        'try{app.enableQE();var qs=qe.project.getActiveSequence();var qt=qs.getVideoTrackAt(t);' +
        'for(var qi=0;qi<qt.numItems;qi++){var qc=qt.getItemAt(qi);if(!qc||qc.type==="Empty")continue;' +
        'var qst=qc.start&&!isNaN(qc.start.seconds)?qc.start.seconds:(qc.start?parseFloat(qc.start.ticks)/254016000000:NaN);' +
        'if(!isNaN(qst)&&Math.abs(qst-clipStart)<0.02){var sp=Math.abs(qc.speed);if(sp>0)spd=sp;break;}}}catch(e){}' +
        'break outer;}}}' +
        'if(!srcPath)return "ERR:No clip under the in point";' +
        'var seek=(mediaStart+(inS-clipStart))*spd;' +
        'var projPath="";try{projPath=app.project.path||"";}catch(e){}' +
        'var nm=(seq.name||"Sequence").replace(/[^A-Za-z0-9 _-]/g,"_");' +
        'var fw=0,fh=0;try{fw=seq.frameSizeHorizontal;fh=seq.frameSizeVertical;}catch(e){}' +
        'return "OK\\t"+srcPath+"\\t"+seek+"\\t"+(outS-inS)+"\\t"+spd+"\\t"+projPath+"\\t"+nm+"\\t"+fw+"\\t"+fh;' +
        '}())';

    btn.addEventListener('click', function () {
        if (HOST !== 'PPRO') { setStatus('Quick Export only works in Premiere', 'error'); return; }
        var ffList = ffmpegCandidates();
        if (!ffList.length) { setStatus('FFmpeg not found on this machine', 'error'); return; }

        evalScript(jsxRead, function (res) {
            if (!res || res.indexOf('ERR:') === 0) { setStatus(res ? res.replace('ERR:', '') : 'Could not read timeline', 'error'); return; }
            var p = res.split('\t');
            var info = { src: p[1], seek: parseFloat(p[2]) || 0, dur: parseFloat(p[3]) || 0, speed: parseFloat(p[4]) || 1, projPath: p[5] || '', name: p[6] || 'Sequence', fw: parseFloat(p[7]) || 0, fh: parseFloat(p[8]) || 0 };
            try { require('fs').writeFileSync('/tmp/dm_qe.log', 'RAW: ' + res + '\nparsed: ' + JSON.stringify(info)); } catch(e) {}
            if (!info.src || info.dur <= 0) { setStatus('Invalid in/out range — RAW: ' + String(res).slice(0, 90), 'error'); return; }
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

    function runExport(info, lutName, ffList) {
        var fs = require('fs'), path = require('path'), cp = require('child_process');
        var root = info.projPath ? path.dirname(info.projPath) : (process.env.HOME + '/Desktop');
        var outDir = path.join(root, 'Quick Export');
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
        var outPath = path.join(outDir, info.name + '_' + Date.now() + '.mp4');
        var tmpPath = path.join(outDir, '.tmp_qe_' + Date.now() + '.mp4');

        // LUT copied to /tmp so spaces in the path don't break the filtergraph
        var lutArg = '';
        if (lutName) {
            try { var tl = require('os').tmpdir() + '/dm_qe_lut.cube'; fs.copyFileSync(lutsPath() + lutName + '.cube', tl); lutArg = tl; } catch (e) { lutArg = ''; }
        }
        var speed = (info.speed && info.speed > 0) ? info.speed : 1;
        var srcDur = (info.dur * speed).toFixed(3);
        var setpts = speed !== 1 ? 'setpts=' + (1 / speed).toFixed(6) + '*(PTS-STARTPTS)' : '';
        // 1080-class canvas matching sequence orientation — same as O1 Edit export
        var tW = 1920, tH = 1080;
        if (info.fw && info.fh) {
            var r = info.fw / info.fh;
            if (r <= 0.65)      { tW = 1080; tH = 1920; }
            else if (r < 0.95)  { tW = 1080; tH = 1350; }
            else if (r <= 1.05) { tW = 1080; tH = 1080; }
            else if (r < 1.5)   { tW = 1440; tH = 1080; }
            else                { tW = 1920; tH = 1080; }
        }
        var scale = 'scale=' + tW + ':' + tH + ':force_original_aspect_ratio=decrease,pad=' + tW + ':' + tH + ':-1:-1:color=black';
        var vf = [lutArg ? 'lut3d=' + lutArg : '', scale, setpts].filter(Boolean).join(',');

        setStatus('Exporting in/out range' + (lutName ? ' (' + lutName + ')' : '') + '...', 'busy');
        btn.disabled = true;

        (function tryFf(i) {
            if (i >= ffList.length) { setStatus('Quick Export failed (ffmpeg could not open the source)', 'error'); btn.disabled = false; return; }
            var ff = ffList[i];
            var args = [ff, '-y', '-ss', info.seek.toFixed(3), '-i', info.src, '-t', info.dur.toFixed(3)];
            if (vf) { args.push('-vf', vf); }
            args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmpPath);
            cp.execFile('/usr/bin/nice', ['-n', '10'].concat(args), { timeout: 600000 }, function (err) {
                if (!err && fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) {
                    try { fs.renameSync(tmpPath, outPath); } catch (e2) { setStatus('Export rename failed', 'error'); btn.disabled = false; return; }
                    revealInFinder(outPath);
                    setStatus('Exported ✓ ' + path.basename(outPath), 'success');
                    btn.disabled = false;
                } else {
                    try { fs.unlinkSync(tmpPath); } catch (e) {}
                    tryFf(i + 1);
                }
            });
        })(0);
    }
})();
