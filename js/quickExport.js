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
    function revealInFinder(p) { try { require('child_process').execFile('/usr/bin/open', ['-R', p]); } catch (e) {} }

    var btn = document.getElementById('prQuickExport');
    if (!btn) return;

    // JSX: resolve the clip under the in-point — top track wins, and nested
    // sequences are drilled into until the real media file is reached.
    var NEST_RESOLVER = 'function S(t){try{if(t==null)return -1;if(typeof t.seconds==="number"&&!isNaN(t.seconds))return t.seconds;if(t.ticks!=null)return parseFloat(t.ticks)/254016000000;var p=parseFloat(t);return isNaN(p)?-1:p;}catch(e){return -1;}}function qeSeqFor(sq){try{app.enableQE();var n=qe.project.numSequences;for(var i=0;i<n;i++){var q=qe.project.getSequenceAt(i);if(q&&q.name===sq.name)return q;}}catch(e){}return null;}function spdAt(sq,t,cs){var spd=1;try{var qs=qeSeqFor(sq);if(!qs)return 1;var qt=qs.getVideoTrackAt(t);for(var i=0;i<qt.numItems;i++){var qc=qt.getItemAt(i);if(!qc||qc.type==="Empty")continue;var st=(qc.start&&!isNaN(qc.start.seconds))?qc.start.seconds:(qc.start?parseFloat(qc.start.ticks)/254016000000:NaN);if(!isNaN(st)&&Math.abs(st-cs)<0.02){var sp=Math.abs(qc.speed);if(sp>0)spd=sp;break;}}}catch(e){}return spd;}function subSeqOf(pi){var nid="";try{nid=pi.nodeId;}catch(e){}var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){try{if(nid&&ss[i].projectItem.nodeId===nid)return ss[i];}catch(e){}}var nm="";try{nm=pi.name;}catch(e){}if(nm){for(var j=0;j<ss.numSequences;j++){if(ss[j].name===nm)return ss[j];}}return null;}function resolve(sq,T,cum,depth){if(depth>6)return null;for(var t=sq.videoTracks.numTracks-1;t>=0;t--){var tr=sq.videoTracks[t];for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];var cs=S(cl.start),ce=S(cl.end);if(!(cs<=T&&ce>T))continue;var pi=cl.projectItem;var ms=0;try{ms=S(cl.inPoint);if(ms<0)ms=0;}catch(e){}var sp=spdAt(sq,t,cs);var inner=(ms+(T-cs))*sp;var mp="";try{mp=pi.getMediaPath();}catch(e){}if(mp){return {src:mp,seek:inner,spd:cum*sp,pi:pi};}var sub=subSeqOf(pi);if(sub){var r=resolve(sub,inner,cum*sp,depth+1);if(r)return r;}}}return null;}';
    var jsxRead = '(function(){' +
        'var seq=app.project.activeSequence;' +
        'if(!seq)return "ERR:No active sequence";' +
        NEST_RESOLVER +
        'var inS=-1,outS=-1;' +
        'try{inS=S(seq.getInPointAsTime());}catch(e){}' +
        'try{outS=S(seq.getOutPointAsTime());}catch(e){}' +
        'if(inS<0||outS<=inS)return "ERR:Set in and out points on the timeline first";' +
        'var r=resolve(seq,inS,1,0);' +
        'if(!r)return "ERR:No clip under the in point";' +
        'var projPath="";try{projPath=app.project.path||"";}catch(e){}' +
        'var nm=(seq.name||"Sequence").replace(/[^A-Za-z0-9 _-]/g,"_");' +
        'var fw=0,fh=0;try{fw=seq.frameSizeHorizontal;fh=seq.frameSizeVertical;}catch(e){}' +
        'return "OK\\t"+r.src+"\\t"+r.seek+"\\t"+(outS-inS)+"\\t"+r.spd+"\\t"+projPath+"\\t"+nm+"\\t"+fw+"\\t"+fh;' +
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
