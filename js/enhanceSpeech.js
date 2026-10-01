/* ── Send to Adobe Podcast (Enhance Speech) ───────────────────────────
   O1-Edit-style flow: pull the SELECTED audio clip(s) straight from their
   source files via FFmpeg (no render) and combine them into ONE mp3, each
   clip at its own timeline offset (silence in the gaps) — so the enhanced
   file drops back in sync at the first clip's start. Saved in
   "Enhanced Audio/" beside the source, revealed in Finder, and Adobe Podcast
   Enhance opens for manual upload (it has no public API). */
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
        try { require('child_process').execFile('/usr/bin/open', [url]); } catch (e2) {}
    }
    function revealInFinder(path) {
        try { require('child_process').execFile('/usr/bin/open', ['-R', path]); } catch (e) {}
    }

    var btn = document.getElementById('prEnhanceSpeech');
    if (!btn) return;
    btn.addEventListener('click', function () {
        if (HOST !== 'PPRO') { setStatus('Enhance Speech only works in Premiere', 'error'); return; }
        var ffList = ffmpegCandidates();
        if (!ffList.length) { setStatus('FFmpeg not found on this machine', 'error'); return; }
        btn.disabled = true;
        setStatus('Reading selected audio...', 'busy');

        // First line "SEQ\t<name>", then one line per selected audio clip:
        // "path\tinSec\toutSec\tname\tstartSec" (no JSON — ES3-safe)
        var jsxRead = '(function(){' +
            'var seq=app.project.activeSequence;' +
            'if(!seq)return "ERR:No active sequence";' +
            'function S(t){try{if(t==null)return 0;if(typeof t.seconds==="number"&&!isNaN(t.seconds))return t.seconds;if(t.ticks!=null)return parseFloat(t.ticks)/254016000000;var p=parseFloat(t);return isNaN(p)?0:p;}catch(e){return 0;}}' +
            'var lines=["SEQ\\t"+String(seq.name||"Sequence")];' +
            'for(var a=0;a<seq.audioTracks.numTracks;a++){var tr=seq.audioTracks[a];' +
            'for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];' +
            'try{if(!cl.isSelected())continue;var p="";try{p=cl.projectItem?cl.projectItem.getMediaPath():"";}catch(ep){}' +
            'if(!p)continue;lines.push(p+"\\t"+S(cl.inPoint)+"\\t"+S(cl.outPoint)+"\\t"+String(cl.name||"")+"\\t"+S(cl.start));}catch(e){}}}' +
            'if(lines.length<2)return "ERR:Select the audio clip(s) on the timeline first";' +
            'return lines.join("\\n");}())';

        evalScript(jsxRead, function (res) {
            if (!res || res.indexOf('ERR:') === 0) {
                setStatus(res ? res.replace('ERR:', '') : 'Could not read selection', 'error');
                btn.disabled = false; return;
            }
            var rows = res.split('\n');
            var seqName = (rows[0].split('\t')[1] || 'Sequence').replace(/[^A-Za-z0-9 _-]/g, '_').trim() || 'Sequence';
            var clips = rows.slice(1).map(function (l) {
                var p = l.split('\t');
                return { path: p[0], inSec: parseFloat(p[1]) || 0, outSec: parseFloat(p[2]) || 0, name: p[3] || '', start: parseFloat(p[4]) || 0 };
            }).filter(function (c) { return c.path && c.outSec > c.inSec; });

            // A linked camera clip often shows up on 2 audio tracks (ch1 + ch2) —
            // both read the same audio here, so keep one or it plays twice as loud.
            var uniq = [];
            clips.forEach(function (c) {
                var dup = uniq.some(function (u) { return u.path === c.path && Math.abs(u.inSec - c.inSec) < 0.02 && Math.abs(u.start - c.start) < 0.02; });
                if (!dup) uniq.push(c);
            });
            clips = uniq.sort(function (a, b) { return a.start - b.start; });
            if (!clips.length) { setStatus('No valid audio clip selected', 'error'); btn.disabled = false; return; }

            var fs = require('fs'), path = require('path'), cp = require('child_process');
            var t0 = clips[0].start;
            var span = 0;
            clips.forEach(function (c) { span = Math.max(span, (c.start - t0) + (c.outSec - c.inSec)); });

            function mmss(sec) { var m = Math.floor(sec / 60), s = Math.floor(sec - m * 60); return (m < 10 ? '0' : '') + m + 'm' + (s < 10 ? '0' : '') + s + 's'; }
            var outDir = path.join(path.dirname(clips[0].path), 'Enhanced Audio');
            try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
            var stem = seqName + '_speech_at_' + mmss(t0);
            var outPath = path.join(outDir, stem + '.mp3');
            for (var n = 2; fs.existsSync(outPath); n++) outPath = path.join(outDir, stem + '_' + n + '.mp3');
            var tmpPath = path.join(outDir, '.tmp_speech_' + Date.now() + '.mp3');

            // Inputs: each clip seeked in its own source. Filter: mono 48k, delayed
            // to its timeline offset, then mixed at unity gain (no level drop).
            var inArgs = [], chains = [], labels = '';
            clips.forEach(function (c, i) {
                inArgs.push('-ss', c.inSec.toFixed(3), '-t', (c.outSec - c.inSec).toFixed(3), '-i', c.path);
                var ms = Math.max(0, Math.round((c.start - t0) * 1000));
                chains.push('[' + i + ':a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono' +
                    (ms > 0 ? ',adelay=delays=' + ms + ':all=1' : '') + '[a' + i + ']');
                labels += '[a' + i + ']';
            });
            var graph = chains.join(';') + ';' + (clips.length > 1
                ? labels + 'amix=inputs=' + clips.length + ':duration=longest:normalize=0[out]'
                : '[a0]anull[out]');

            setStatus('Combining ' + clips.length + ' clip' + (clips.length > 1 ? 's' : '') + ' into one mp3...', 'busy');

            (function tryFf(fi) {
                if (fi >= ffList.length) { setStatus('Audio export failed (see /tmp/dm_enhance.log)', 'error'); btn.disabled = false; return; }
                var args = [ffList[fi], '-y'].concat(inArgs, ['-filter_complex', graph, '-map', '[out]', '-vn',
                    '-ac', '1', '-ar', '48000', '-c:a', 'libmp3lame', '-b:a', '320k', tmpPath]);
                cp.execFile('/usr/bin/nice', ['-n', '10'].concat(args), { timeout: 600000, maxBuffer: 16 * 1024 * 1024 }, function (err, so, se) {
                    if (!err && fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) {
                        try { fs.renameSync(tmpPath, outPath); }
                        catch (e2) { setStatus('Audio export failed (rename)', 'error'); btn.disabled = false; return; }
                        revealInFinder(outPath);
                        openInBrowser(PODCAST_URL);
                        var msg = '1 mp3 (' + clips.length + ' clip' + (clips.length > 1 ? 's' : '') + ', ' + mmss(span).replace('m', 'm ') +
                            ') → drag into Adobe Podcast · place the enhanced file back at ' + mmss(t0).replace('m', ':').replace('s', '');
                        if (span > 1800) msg += ' ⚠ over 30 min (Adobe Podcast free limit)';
                        setStatus(msg, 'success');
                        btn.disabled = false;
                    } else {
                        try { fs.writeFileSync('/tmp/dm_enhance.log', 'ffmpeg: ' + ffList[fi] + '\nargs: ' + JSON.stringify(args) + '\n\n' + String(se || (err && err.message) || '').slice(-4000)); } catch (e) {}
                        try { fs.unlinkSync(tmpPath); } catch (e) {}
                        tryFf(fi + 1);   // next ffmpeg build
                    }
                });
            })(0);
        });
    });
})();
