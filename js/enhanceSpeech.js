/* ── Send to Adobe Podcast (Enhance Speech) ───────────────────────────
   O1-Edit-style flow: extract the SELECTED audio clip(s) straight from the
   source file via FFmpeg (no render), save WAVs in "Enhanced Audio/" beside
   the source, reveal in Finder, and open Adobe Podcast Enhance for manual
   upload. Adobe Podcast has no public API, so upload/download stays manual. */
(function () {
    if (typeof document === 'undefined') return;

    // Wavdrop bundles ffmpeg 8.1 which opens cameras the static 7.0 build rejects
    // (e.g. 'infe: version < 2 not supported') — try newest first, fall back down.
    var FFMPEG_PATHS = ['/Applications/Wavdrop.app/Contents/Resources/ffmpeg',
        '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg',
        '/Users/desiremedia/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg'];
    var PODCAST_URL = 'https://podcast.adobe.com/enhance';

    function ffmpegCandidates() {
        var out = [];
        try { var b = window.DM_BUNDLED_FFMPEG && window.DM_BUNDLED_FFMPEG(); if (b) out.push(b); } catch (e) {}
        try {
            var fs = require('fs');
            for (var i = 0; i < FFMPEG_PATHS.length; i++) {
                if (fs.existsSync(FFMPEG_PATHS[i]) && out.indexOf(FFMPEG_PATHS[i]) === -1) out.push(FFMPEG_PATHS[i]);
            }
        } catch (e) {}
        return out;
    }

    function openInBrowser(url) {
        try { if (window.cep && window.cep.util) { window.cep.util.openURLInDefaultBrowser(url); return; } } catch (e) {}
        try { require('child_process').exec('open ' + JSON.stringify(url)); } catch (e2) {}
    }
    function revealInFinder(path) {
        try { require('child_process').exec('open -R ' + JSON.stringify(path)); } catch (e) {}
    }

    var btn = document.getElementById('prEnhanceSpeech');
    if (!btn) return;
    btn.addEventListener('click', function () {
        if (HOST !== 'PPRO') { setStatus('Enhance Speech only works in Premiere', 'error'); return; }
        var ffList = ffmpegCandidates();
        if (!ffList.length) { setStatus('FFmpeg not found on this machine', 'error'); return; }
        btn.disabled = true;
        setStatus('Reading selected audio...', 'busy');

        // Return one line per selected audio clip: "path\tinSec\toutSec\tname" (no JSON — ES3-safe)
        var jsxRead = '(function(){' +
            'var seq=app.project.activeSequence;' +
            'if(!seq)return "ERR:No active sequence";' +
            'function S(t){try{if(t==null)return 0;if(typeof t.seconds==="number"&&!isNaN(t.seconds))return t.seconds;if(t.ticks!=null)return parseFloat(t.ticks)/254016000000;var p=parseFloat(t);return isNaN(p)?0:p;}catch(e){return 0;}}' +
            'var lines=[];' +
            'for(var a=0;a<seq.audioTracks.numTracks;a++){var tr=seq.audioTracks[a];' +
            'for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];' +
            'try{if(!cl.isSelected())continue;var p="";try{p=cl.projectItem?cl.projectItem.getMediaPath():"";}catch(ep){}' +
            'if(!p)continue;lines.push(p+"\\t"+S(cl.inPoint)+"\\t"+S(cl.outPoint)+"\\t"+String(cl.name||""));}catch(e){}}}' +
            'if(!lines.length)return "ERR:Select the audio clip(s) on the timeline first";' +
            'return lines.join("\\n");}())';

        evalScript(jsxRead, function (res) {
            if (!res || res.indexOf('ERR:') === 0) {
                setStatus(res ? res.replace('ERR:', '') : 'Could not read selection', 'error');
                btn.disabled = false; return;
            }
            var clips = res.split('\n').map(function (l) {
                var p = l.split('\t');
                return { path: p[0], inSec: parseFloat(p[1]) || 0, outSec: parseFloat(p[2]) || 0, name: p[3] || '' };
            }).filter(function (c) { return c.path && c.outSec > c.inSec; });
            if (!clips.length) { setStatus('No valid audio clip selected', 'error'); btn.disabled = false; return; }

            var fs = require('fs'), path = require('path'), cp = require('child_process');
            var outPaths = [], failed = 0, done = 0;
            setStatus('Exporting audio 0/' + clips.length + '...', 'busy');

            function stamp(sec) { return sec.toFixed(2).replace('.', 's'); }

            clips.forEach(function (c, i) {
                var srcDir = path.dirname(c.path);
                var outDir = path.join(srcDir, 'Enhanced Audio');
                try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
                var base = path.basename(c.path).replace(/\.[^.]+$/, '');
                var outPath = path.join(outDir, base + '_' + stamp(c.inSec) + '-' + stamp(c.outSec) + '.wav');
                var tmpPath = path.join(outDir, '.tmp_' + base + '_' + i + '.wav');
                var dur = (c.outSec - c.inSec).toFixed(3);
                // 48kHz 16-bit mono WAV, audio only — clean input for Enhance Speech.
                // Try each ffmpeg until one opens the file (camera-container quirks).
                (function tryFf(fi) {
                    if (fi >= ffList.length) { done++; failed++; setStatus('Exporting audio ' + done + '/' + clips.length + '...', 'busy'); if (done === clips.length) finish(); return; }
                    var ff = ffList[fi];
                    var args = [ff, '-y', '-ss', c.inSec.toFixed(3), '-i', c.path, '-t', dur, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', tmpPath];
                    cp.execFile('/usr/bin/nice', ['-n', '10'].concat(args), { timeout: 300000 }, function (err) {
                        if (!err && fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) {
                            try { fs.renameSync(tmpPath, outPath); outPaths.push(outPath); }
                            catch (e2) { failed++; }
                            done++;
                            setStatus('Exporting audio ' + done + '/' + clips.length + '...', 'busy');
                            if (done === clips.length) finish();
                        } else {
                            try { fs.unlinkSync(tmpPath); } catch (e) {}
                            tryFf(fi + 1);   // next ffmpeg build
                        }
                    });
                })(0);
            });

            function finish() {
                if (!outPaths.length) { setStatus('Audio export failed', 'error'); btn.disabled = false; return; }
                revealInFinder(outPaths[0]);
                openInBrowser(PODCAST_URL);
                var msg = outPaths.length + ' file' + (outPaths.length > 1 ? 's' : '') + ' in "Enhanced Audio" → drag into Adobe Podcast';
                if (failed) msg += ' (' + failed + ' failed)';
                setStatus(msg, 'success');
                btn.disabled = false;
            }
        });
    });
})();
