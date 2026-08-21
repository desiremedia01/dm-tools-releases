/* ── Download Reference Track ──────────────────────────────────────────
   Reference/temp music. Paste a YouTube / SoundCloud / Spotify URL:
   - YouTube/SoundCloud → yt-dlp grabs the audio directly.
   - Spotify → reads title+artist from the public oEmbed/page (no DRM) and
     pulls the matching track from YouTube.
   Saves an mp3 into ~/Documents/Desire Music, renders its waveform in the
   panel, and lets you DRAG it straight onto the timeline/project panel
   (CEP native file drag) or click "Place at playhead". */
(function () {
    if (typeof document === 'undefined') return;

    var HOME = (typeof process !== 'undefined' ? process.env.HOME : '') || '';
    var MUSIC_DIR = HOME + '/Documents/Desire Music';
    var YTDLP_PATHS = [];
    try { YTDLP_PATHS.push(((typeof cs !== 'undefined' && cs) ? cs.getSystemPath('extension') : '.') + '/bin/yt-dlp'); } catch (e) {}
    YTDLP_PATHS = YTDLP_PATHS.concat(['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', HOME + '/Library/Python/3.9/bin/yt-dlp']);
    var FFDIRS = [HOME + '/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64', '/opt/homebrew/bin', '/usr/local/bin'];

    function which(list) { try { var fs = require('fs'); for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; } catch (e) {} return null; }
    function ytdlp() { return which(YTDLP_PATHS); }
    function ffdir() {
        // Prefer the bundled ffmpeg (shipped via DmBinSync) so it works on every
        // team machine, then fall back to system installs. --ffmpeg-location takes
        // either a directory or the binary path.
        try { var b = window.DM_BUNDLED_FFMPEG && window.DM_BUNDLED_FFMPEG(); if (b) return b; } catch (e) {}
        try { var fs = require('fs'); for (var i = 0; i < FFDIRS.length; i++) if (fs.existsSync(FFDIRS[i] + '/ffmpeg')) return FFDIRS[i]; } catch (e) {}
        return null;
    }
    function revealInFinder(p) { try { require('child_process').exec('open -R ' + JSON.stringify(p)); } catch (e) {} }

    function spotifyToQuery(url, cb) {
        var title = '', artist = '';
        fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { if (j && j.title) title = j.title; }).catch(function () {})
            .then(function () { return fetch(url).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; }); })
            .then(function (html) {
                var m = html.match(/<meta property="og:description" content="([^"]*)"/);
                if (m && m[1]) { var first = m[1].split('·')[0].trim(); if (first) artist = first; }
                cb((artist + ' ' + title).trim() || title || '');
            }).catch(function () { cb(title || ''); });
    }

    /* ── Result area (built in JS to avoid the index.html revert hook) ── */
    var resultEl = null;
    function ensureResultArea() {
        if (resultEl) return resultEl;
        var section = document.getElementById('downloadSection');
        var host = section || (btn.parentNode ? btn.parentNode.parentNode : null) || document.body;
        resultEl = document.createElement('div');
        resultEl.id = 'mdResult';
        resultEl.style.cssText = 'display:none;margin-top:10px;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px';
        resultEl.innerHTML =
            '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">' +
            '<div id="mdName" style="flex:1;font-size:11px;color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>' +
            '<span id="mdClose" title="Close" style="flex:0 0 auto;cursor:pointer;color:rgba(255,255,255,0.5);font-size:14px;line-height:1;padding:0 2px">&times;</span></div>' +
            '<div style="font-size:9px;color:rgba(255,255,255,0.4);margin-bottom:6px">Click = place at playhead · Drag = drop on the timeline ↗</div>' +
            '<canvas id="mdWave" width="300" height="56" title="Click to place at playhead, or drag to the timeline" ' +
            'style="width:100%;height:56px;display:block;background:rgba(0,0,0,0.25);border-radius:5px;cursor:grab"></canvas>';
        host.appendChild(resultEl);
        resultEl.querySelector('#mdClose').onclick = function () { resultEl.style.display = 'none'; };
        return resultEl;
    }

    function drawWaveform(canvas, audioBuffer) {
        var ctx = canvas.getContext('2d');
        var W = canvas.width, H = canvas.height, mid = H / 2;
        ctx.clearRect(0, 0, W, H);
        var data = audioBuffer.getChannelData(0);
        var step = Math.max(1, Math.floor(data.length / W));
        ctx.fillStyle = '#4a9eff';
        for (var x = 0; x < W; x++) {
            var min = 1, max = -1;
            for (var i = 0; i < step; i++) {
                var d = data[x * step + i] || 0;
                if (d < min) min = d; if (d > max) max = d;
            }
            var y1 = mid + min * mid, y2 = mid + max * mid;
            ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
        }
    }

    function showResult(mp3Path) {
        var fs = require('fs'), path = require('path');
        var el = ensureResultArea();
        var name = path.basename(mp3Path);
        document.getElementById('mdName').textContent = name;
        el.style.display = '';

        // Waveform via WebAudio
        try {
            var buf = fs.readFileSync(mp3Path);
            var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            var AC = window.AudioContext || window.webkitAudioContext;
            var actx = new AC();
            actx.decodeAudioData(ab, function (audioBuffer) {
                drawWaveform(document.getElementById('mdWave'), audioBuffer);
                try { actx.close(); } catch (e) {}
            }, function () { /* decode failed — leave blank canvas */ });
        } catch (e) {}

        // Waveform: drag → CEP native file drag; plain click → place at playhead.
        var wave = document.getElementById('mdWave');
        var dragged = false, placing = false;
        wave.setAttribute('draggable', 'true');
        wave.ondragstart = function (e) {
            dragged = true;
            try {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('com.adobe.cep.dnd.file.0', mp3Path);
            } catch (err) {}
        };
        wave.onclick = function () {
            if (dragged) { dragged = false; return; }   // click fired after a drag — ignore
            if (placing) return;
            if (HOST !== 'PPRO') { setStatus('Place only works in Premiere', 'error'); return; }
            placing = true;
            var safe = mp3Path.replace(/"/g, '\\"');
            var label = name.replace(/"/g, '\\"');
            evalScript('$.evalFile("' + getPrJsxPath() + '"); placeSoundAtPlayhead("' + safe + '", "' + label + '");', function (r) {
                placing = false;
                if (r === 'true' || (r && r.indexOf('Error') === -1)) setStatus('Placed ✓ ' + name, 'success');
                else setStatus('Place failed: ' + r, 'error');
            });
        };
    }

    var btn = document.getElementById('prMusicDownload');
    var urlInput = document.getElementById('mdUrlInput');
    if (!btn) return;

    function startDownload() {
        if (!ytdlp()) { setStatus('yt-dlp not found on this machine', 'error'); return; }
        var url = (urlInput && urlInput.value || '').trim();
        if (!url) { setStatus('Paste a link first', 'error'); if (urlInput) urlInput.focus(); return; }
        if (/open\.spotify\.com\/track/i.test(url)) {
            setStatus('Looking up track on Spotify...', 'busy');
            spotifyToQuery(url, function (q) {
                if (!q) { setStatus('Could not read the Spotify track', 'error'); return; }
                download('ytsearch1:' + q);
            });
        } else { download(url); }
    }

    btn.addEventListener('click', startDownload);
    if (urlInput) {
        urlInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); startDownload(); }
        });
    }

    // Resolve the target dir: the project's "assets" folder (a sibling of the
    // project folder, i.e. one level above where the .prproj lives). If none is
    // found within a couple of levels up, create assets beside the project folder.
    function resolveDir(cb) {
        if (HOST !== 'PPRO') { cb(MUSIC_DIR); return; }
        evalScript('(function(){try{return app.project.path||"";}catch(e){return "";}}())', function (projPath) {
            if (!projPath || projPath === 'EvalScript error.') { cb(MUSIC_DIR); return; }
            var fs = require('fs'), path = require('path');
            var projDir = path.dirname(projPath);           // folder holding the .prproj
            var parent = path.dirname(projDir);             // one level above the project folder
            // Prefer an existing assets folder above the project, then beside it.
            var candidates = [path.join(parent, 'assets'), path.join(projDir, 'assets')];
            for (var i = 0; i < candidates.length; i++) {
                try { if (fs.existsSync(candidates[i]) && fs.statSync(candidates[i]).isDirectory()) { cb(candidates[i]); return; } } catch (e) {}
            }
            cb(path.join(parent, 'assets'));   // default: create assets one level above the project folder
        });
    }

    function download(target) { resolveDir(function (dir) { downloadTo(target, dir); }); }

    function downloadTo(target, outDir) {
        var fs = require('fs'), cp = require('child_process');
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
        var yt = ytdlp(), fd = ffdir();
        btn.disabled = true;
        setStatus('Downloading reference track...', 'busy');

        var before = {};
        try { fs.readdirSync(outDir).forEach(function (f) { before[f] = 1; }); } catch (e) {}

        var args = ['--no-warnings', '--no-playlist', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
            '--print', 'after_move:filepath', '--no-simulate',
            '-o', outDir + '/%(title)s.%(ext)s'];
        if (fd) args.push('--ffmpeg-location', fd);
        args.push(target);

        var child = cp.spawn(yt, args);
        var lastPct = '', errLog = '', finalPath = '';
        function onData(d) {
            var s = String(d);
            errLog += s;
            if (errLog.length > 8000) errLog = errLog.slice(-8000);
            var fm = s.match(/(\/[^\n\r]*\.mp3)/);
            if (fm) finalPath = fm[1].trim();
            var m = s.match(/\[download\]\s+([0-9.]+)%/);
            if (m && m[1] !== lastPct) { lastPct = m[1]; setStatus('Downloading reference... ' + Math.round(parseFloat(m[1])) + '%', 'busy'); }
        }
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', function (e) { setStatus('Download failed: ' + e.message, 'error'); btn.disabled = false; });
        child.on('close', function (code) {
            btn.disabled = false;
            if (code !== 0) {
                try { require('fs').writeFileSync('/tmp/dm_md.log', errLog); } catch (e) {}
                var em = errLog.match(/ERROR:[^\n]*/);
                setStatus('Download failed: ' + (em ? em[0].slice(0, 110) : 'yt-dlp exit ' + code), 'error');
                return;
            }
            var mp3 = (finalPath && fs.existsSync(finalPath)) ? finalPath : null;
            if (!mp3) {
                var added = null;
                try { fs.readdirSync(outDir).forEach(function (f) { if (!before[f] && /\.mp3$/i.test(f)) added = f; }); } catch (e) {}
                if (added) mp3 = outDir + '/' + added;
            }
            if (mp3) { setStatus('Ready ✓ click to place or drag to the timeline', 'success'); showResult(mp3); }
            else { revealInFinder(outDir); setStatus('Download finished — check the project assets folder', 'success'); }
        });
    }
})();
