/* ── Staging Sequence with correction-learning ─────────────────────────
   Pipeline: classify shot type (wide/tight) → motion-based segment picking
   (parameters loaded from calibration/params.json, refit from the editor's
   own corrections) → grouped, color-labeled staging sequence.
   Learning loop: editor trims/deletes clips in the staging sequence, clicks
   "Learn From My Edits" → diffs against the saved plan → grid-search refit. */
(function() {
    var IS_NODE = (typeof document === 'undefined');

    var ENV_PATH = '/Users/desiremedia/Documents/desire-music-finder/.env';
    var FFMPEG_PATHS = ['/Users/desiremedia/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg',
        '/Applications/Wavdrop.app/Contents/Resources/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    var CAL_DIR = '/Users/desiremedia/Documents/DM_Tools_CEP/calibration';
    var ANALYZE_W = 640;
    var WINDOW_SEC = 4;
    var MAX_SEGMENTS = 4;
    var MERGE_GAP_SEC = 0.5;
    var BLUR_FACTOR = 1.4;

    /* ── Parameters (learnable) ─────────────────────────────────────── */
    var DEFAULT_PARAMS = {
        wide: {
            mxFloor: 0.05, divPush: -0.03, divPull: 0.15, consist: 0.7, magCap: 5,
            edgeStart: 0.7, edgeEnd: 0.5, fastTailMag: 1.5, fastTailTrim: 0.4, minSeg: 2.5
        },
        tight: {
            // Tights are orbits/slider moves at close range: same motion patterns as
            // wides but parallax-amplified. Normalize the clip's scale, then apply
            // wide-style gates with tight-specific tuning.
            targetScale: 0.25, mxFloor: 0.05, divPush: -0.03, divPull: 0.15, consist: 0.6, magCap: 5,
            edgeStart: 0.4, edgeEnd: 0.3, fastTailMag: 1.5, fastTailTrim: 0.4, minSeg: 1.5
        }
    };

    // Errors also go to a log file so they can be read after the fact
    function failStatus(msg) {
        try {
            require('fs').appendFileSync('/tmp/dm_staging_error.log',
                new Date().toISOString() + '  ' + msg + String.fromCharCode(10));
        } catch (_) {}
        setStatus(msg, 'error');
    }

    function loadParams() {
        try {
            var fs = require('fs');
            var p = JSON.parse(fs.readFileSync(CAL_DIR + '/params.json', 'utf8'));
            var out = JSON.parse(JSON.stringify(DEFAULT_PARAMS));
            ['wide', 'tight'].forEach(function(m) {
                if (p[m]) Object.keys(p[m]).forEach(function(k) { out[m][k] = p[m][k]; });
            });
            return out;
        } catch (_) { return JSON.parse(JSON.stringify(DEFAULT_PARAMS)); }
    }

    /* ── Pure segmentation core (used live and by the optimizer) ─────── */
    function segmentSeries(S, fps, dur, mode, P) {
        var n = S.mag.length;
        if (n < 3) return [];
        if (mode === 'tight') {
            // Normalize the clip's motion scale so wide-style gates apply
            var sorted = S.mag.slice().sort(function(a, b) { return a - b; });
            var p50 = Math.max(0.05, sorted[Math.floor(n / 2)]);
            var k = (P.targetScale || 0.25) / p50;
            S = {
                mag: S.mag.map(function(v) { return v * k; }),
                mx: S.mx.map(function(v) { return v * k; }),
                my: S.my.map(function(v) { return v * k; }),
                div: S.div.map(function(v) { return v * k; }),
                blurOk: S.blurOk
            };
        }
        // The crew always pans/orbits ONE way per clip; opposite-direction lateral
        // motion is the operator walking back to redo — never content.
        var domSum = 0;
        for (var dd = 0; dd < n; dd++) {
            if (Math.abs(S.mx[dd]) > P.mxFloor && S.div[dd] >= P.divPush) domSum += S.mx[dd];
        }
        var domSign = domSum > 0 ? 1 : (domSum < 0 ? -1 : 0);

        function isGood(i) {
            if (S.blurOk && S.blurOk[i] === 0) return false;
            if (S.mag[i] >= P.magCap) return false;
            // Tights are always a one-direction pan/orbit: when vertical motion dominates
            // the lateral, the operator is repositioning (raising/lowering) — cut before it.
            if (mode === 'tight' && Math.abs(S.my[i]) > Math.max(Math.abs(S.mx[i]), P.mxFloor) * 1.3) return false;
            if (S.div[i] > P.divPull) return false;
            var lateral = Math.abs(S.mx[i]) > P.mxFloor;
            var push = S.div[i] < P.divPush;
            if (!lateral && !push) return false;
            if (lateral && !push) {
                if (domSign !== 0 && (S.mx[i] > 0 ? 1 : -1) !== domSign) return false; // going back
                var cons = S.mag[i] > 0.01 ? Math.sqrt(S.mx[i] * S.mx[i] + S.my[i] * S.my[i]) / S.mag[i] : 0;
                if (cons <= P.consist) return false;
            }
            return true;
        }

        var runs = [], rs = -1;
        for (var i = 0; i < n; i++) {
            if (isGood(i)) { if (rs < 0) rs = i; }
            else if (rs >= 0) { runs.push([rs, i - 1]); rs = -1; }
        }
        if (rs >= 0) runs.push([rs, n - 1]);

        var gapF = Math.round(MERGE_GAP_SEC * fps);
        var merged = [];
        runs.forEach(function(r) {
            if (merged.length && r[0] - merged[merged.length - 1][1] <= gapF) merged[merged.length - 1][1] = r[1];
            else merged.push([r[0], r[1]]);
        });

        var split = merged;

        var eS = Math.round(P.edgeStart * fps), eE = Math.round(P.edgeEnd * fps);
        var minF = Math.round(P.minSeg * fps);
        var segs = split.filter(function(r) { return (r[1] - r[0]) >= minF; }).map(function(r) {
            var fastExtra = 0;
            var tail = 0, tn = 0;
            for (var t2 = Math.max(r[0], r[1] - Math.round(fps)); t2 <= r[1]; t2++) { tail += S.mag[t2]; tn++; }
            if (tn > 0 && tail / tn > P.fastTailMag) fastExtra = Math.round(P.fastTailTrim * fps);
            return [r[0] + eS, r[1] - eE - fastExtra];
        }).filter(function(r) { return (r[1] - r[0]) >= Math.round(1.5 * fps); }).map(function(r) {
            var sm = 0, sx = 0, cnt2 = r[1] - r[0] + 1;
            for (var k2 = r[0]; k2 <= r[1]; k2++) { sm += S.mag[k2]; sx += S.mx[k2]; }
            return { start: r[0] / fps, end: Math.min(dur, r[1] / fps), mag: sm / cnt2, mx: sx / cnt2 };
        });

        if (!segs.length) {
            var winF = Math.round(WINDOW_SEC * fps);
            if (n > winF) {
                var bestS = 0, bestV = (mode === 'tight') ? Infinity : -1, acc = 0;
                for (var w = 0; w < n; w++) {
                    acc += (mode === 'tight') ? S.mag[w] : Math.abs(S.mx[w]);
                    if (w >= winF) acc -= (mode === 'tight') ? S.mag[w - winF] : Math.abs(S.mx[w - winF]);
                    if (w >= winF - 1 && (mode === 'tight' ? acc < bestV : acc > bestV)) { bestV = acc; bestS = w - winF + 1; }
                }
                return [{ start: bestS / fps, end: Math.min(dur, bestS / fps + WINDOW_SEC), mag: -1, mx: bestV / winF }];
            }
            return [{ start: 0, end: Math.min(WINDOW_SEC, dur), mag: -1, mx: 0 }];
        }
        segs.sort(function(a, b) { return (b.end - b.start) - (a.end - a.start); });
        segs = segs.slice(0, MAX_SEGMENTS);
        segs.sort(function(a, b) { return a.start - b.start; });
        return segs;
    }

    /* ── Optimizer ──────────────────────────────────────────────────── */
    function iou(a, b) {
        var inter = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
        var uni = (a[1] - a[0]) + (b[1] - b[0]) - inter;
        return uni > 0 ? inter / uni : 0;
    }
    function scoreParams(mode, P, examples) {
        var total = 0;
        examples.forEach(function(ex) {
            var segs = segmentSeries(ex.S, ex.fps, ex.dur, mode, P).map(function(s) { return [s.start, s.end]; });
            if (!ex.desired.length) {
                var cov = 0;
                segs.forEach(function(s) { cov += (s[1] - s[0]); });
                total += Math.max(0, 1 - cov / ex.dur);
                return;
            }
            var best = 0;
            ex.desired.forEach(function(d) {
                var bi = 0, bEdge = 999;
                segs.forEach(function(s) {
                    var v = iou(s, d);
                    if (v > bi) { bi = v; bEdge = (Math.abs(s[0] - d[0]) + Math.abs(s[1] - d[1])) / 2; }
                });
                // edge accuracy matters: every 0.5s of average boundary error costs ~5%
                best += Math.max(0, bi - Math.min(0.3, bEdge * 0.1));
            });
            var penalty = Math.max(0, segs.length - ex.desired.length) * 0.15;
            total += Math.max(0, best / ex.desired.length - penalty);
        });
        return examples.length ? total / examples.length : 0;
    }
    var GRIDS = {
        wide: {
            mxFloor: [0.03, 0.05, 0.08],
            divPush: [-0.02, -0.03, -0.05],
            divPull: [0.1, 0.15, 0.25],
            consist: [0.6, 0.7, 0.8],
            edgeStart: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1],
            edgeEnd: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
        },
        tight: {
            targetScale: [0.15, 0.2, 0.25, 0.35],
            mxFloor: [0.03, 0.05, 0.08],
            divPull: [0.1, 0.15, 0.25],
            edgeStart: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
            edgeEnd: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
        }
    };
    function gridSearch(mode, examples, baseP) {
        var keys = Object.keys(GRIDS[mode]);
        var best = { score: scoreParams(mode, baseP, examples), P: baseP };
        function rec(idx, cur) {
            if (idx === keys.length) {
                var sc = scoreParams(mode, cur, examples);
                if (sc > best.score) best = { score: sc, P: JSON.parse(JSON.stringify(cur)) };
                return;
            }
            GRIDS[mode][keys[idx]].forEach(function(v) {
                cur[keys[idx]] = v;
                rec(idx + 1, cur);
            });
            cur[keys[idx]] = baseP[keys[idx]];
        }
        rec(0, JSON.parse(JSON.stringify(baseP)));
        return best;
    }

    /* ── Calibration storage ────────────────────────────────────────── */
    function ensureCalDirs() {
        var fs = require('fs');
        [CAL_DIR, CAL_DIR + '/runs'].forEach(function(d) {
            try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
        });
    }
    function downsample(arr, factor) {
        var out = [];
        for (var i = 0; i < arr.length; i += factor) {
            var s = 0, c = 0;
            for (var k = i; k < Math.min(arr.length, i + factor); k++) { s += arr[k]; c++; }
            out.push(Math.round((s / c) * 10000) / 10000);
        }
        return out;
    }
    function saveRunFeatures(runId, records) {
        try {
            ensureCalDirs();
            require('fs').writeFileSync(CAL_DIR + '/runs/' + runId + '.json', JSON.stringify(records));
        } catch (_) {}
    }
    function saveLastPlan(runId, planEntries) {
        try {
            ensureCalDirs();
            require('fs').writeFileSync(CAL_DIR + '/lastPlan.json', JSON.stringify({ runId: runId, entries: planEntries }));
        } catch (_) {}
    }
    function appendLabels(newLabels) {
        var fs = require('fs');
        var all = [];
        try { all = JSON.parse(fs.readFileSync(CAL_DIR + '/labels.json', 'utf8')); } catch (_) {}
        all = all.concat(newLabels);
        ensureCalDirs();
        fs.writeFileSync(CAL_DIR + '/labels.json', JSON.stringify(all, null, 1));
        return all;
    }
    function loadAllExamples() {
        var fs = require('fs');
        var labels = [];
        try { labels = JSON.parse(fs.readFileSync(CAL_DIR + '/labels.json', 'utf8')); } catch (_) { return { wide: [], tight: [] }; }
        var runCache = {};
        var out = { wide: [], tight: [] };
        var byClip = {};
        labels.forEach(function(l) {
            var k = l.runId + '|' + l.path;
            if (!byClip[k]) byClip[k] = { runId: l.runId, path: l.path, shot: l.shot, desired: [] };
            if (l.desired) byClip[k].desired.push(l.desired);
        });
        var TIGHT_LABEL_ERA = 1783572657000; // tight engine rewritten (direction/vertical rules) — older tight labels don't fit it
        Object.keys(byClip).forEach(function(k) {
            var l = byClip[k];
            if (l.shot === 'tight' && parseInt(String(l.runId).replace(/\D/g, ''), 10) < TIGHT_LABEL_ERA) return;
            if (!runCache[l.runId]) {
                try { runCache[l.runId] = JSON.parse(fs.readFileSync(CAL_DIR + '/runs/' + l.runId + '.json', 'utf8')); }
                catch (_) { runCache[l.runId] = null; }
            }
            var recs = runCache[l.runId];
            if (!recs) return;
            var rec = null;
            recs.forEach(function(r) { if (r.path === l.path) rec = r; });
            if (!rec) return;
            var mode = l.shot === 'tight' ? 'tight' : 'wide';
            out[mode].push({
                S: { mag: rec.mag, mx: rec.mx, my: rec.my, div: rec.div, blurOk: rec.blurOk },
                fps: rec.fps, dur: rec.dur, desired: l.desired
            });
        });
        return out;
    }
    function refitParams() {
        var examples = loadAllExamples();
        var params = loadParams();
        var msgs = [];
        ['wide', 'tight'].forEach(function(mode) {
            if (examples[mode].length < 2) return;
            var before = scoreParams(mode, params[mode], examples[mode]);
            var best = gridSearch(mode, examples[mode], params[mode]);
            params[mode] = best.P;
            msgs.push(mode + ': ' + Math.round(before * 100) + '%→' + Math.round(best.score * 100) + '% (' + examples[mode].length + ' clips)');
        });
        try {
            ensureCalDirs();
            require('fs').writeFileSync(CAL_DIR + '/params.json', JSON.stringify(params, null, 2));
        } catch (_) {}
        return msgs.join('  |  ');
    }

    /* ── FFmpeg helpers ─────────────────────────────────────────────── */
    function getGeminiKey() {
        try {
            var env = require('fs').readFileSync(ENV_PATH, 'utf8');
            var m = env.match(/GEMINI_API_KEY=([^\s]+)/);
            return m ? m[1] : null;
        } catch (_) { return null; }
    }
    function findFfmpeg() {
        var fs = require('fs');
        for (var i = 0; i < FFMPEG_PATHS.length; i++) {
            try { if (fs.existsSync(FFMPEG_PATHS[i])) return FFMPEG_PATHS[i]; } catch (_) {}
        }
        return 'ffmpeg';
    }
    function findFfprobe() { return findFfmpeg().replace(/ffmpeg$/, 'ffprobe'); }

    /* Sony XAVC from some cameras (Calvin's) carries header boxes the static
       ffmpeg build can't parse ("infe: version < 2"). The Wavdrop ffmpeg is
       newer, reads them fine, and also ships vidstab+blurdetect+videotoolbox
       — so every ffmpeg/ffprobe call retries with it on failure. */
    var WAVDROP_FF = '/Applications/Wavdrop.app/Contents/Resources/ffmpeg';
    function hasWavdrop() {
        try { return require('fs').existsSync(WAVDROP_FF); } catch (_) { return false; }
    }

    /* ── Lens/orientation metadata via bundled exiftool ─────────────────
       wide/tight is DETERMINISTIC from the lens (Matheus's rule: focal
       ≤16mm = wide, >20mm = tight; his wide lens is manual/no-contacts so
       LensModelName comes back EMPTY on Sony bodies = wide). Rotation
       90/270 = vertical clip shot for the reel — excluded from the
       horizontal video pool. Validated on 18 York St: 20/20 finished-video
       tights matched the 28-70 lens; 40 vertical reel clips filtered. */
    var EXIFTOOL_PATHS = ['/Users/desiremedia/Documents/DM_Tools_CEP/tools/exiftool/exiftool',
        '/Users/desiremedia/Library/Application Support/Adobe/CEP/extensions/DM_Tools/tools/exiftool/exiftool'];
    function findExiftool() {
        var fs = require('fs');
        for (var i = 0; i < EXIFTOOL_PATHS.length; i++) {
            try { if (fs.existsSync(EXIFTOOL_PATHS[i])) return EXIFTOOL_PATHS[i]; } catch (_) {}
        }
        return null;
    }
    function shotFromLens(lens) {
        if (!lens) return 'wide';                       // manual wide lens: no contacts
        var m = String(lens).match(/(\d+)(?:-\d+)?mm/i);
        if (m && parseInt(m[1], 10) <= 16) return 'wide';   // 16mm / 16-35 = wide
        return 'tight';                                  // 20mm+ zooms/primes = tight
    }
    /* batch-read {lens, vertical} for many paths in ONE exiftool process */
    function readClipMeta(paths, cb) {
        var et = findExiftool();
        if (!et || !paths.length) { cb({}); return; }
        var cp = require('child_process');
        // no -fast: Sony writes lens/rotation at the END of the file
        var args = ['-j', '-LensModelName', '-Rotation', '-ImageWidth', '-ImageHeight'].concat(paths);
        cp.execFile('perl', [et].concat(args), { maxBuffer: 32 * 1024 * 1024, timeout: 600000 },
            function(err, stdout) {
            var map = {};
            try {
                JSON.parse(stdout || '[]').forEach(function(e) {
                    var rot = parseInt(e.Rotation, 10) || 0;
                    // portrait = the EFFECTIVE orientation Premiere shows in
                    // Video Info: coded dims swapped by 90/270 rotation.
                    // Covers Sony (landscape+rotation) AND natively-coded
                    // portrait files (2160x3840, rotation 0).
                    var w = parseInt(e.ImageWidth, 10) || 0, h = parseInt(e.ImageHeight, 10) || 0;
                    var swap = (rot === 90 || rot === 270);
                    var effW = swap ? h : w, effH = swap ? w : h;
                    map[e.SourceFile] = {
                        lens: e.LensModelName || '',
                        shot: shotFromLens(e.LensModelName),
                        vertical: (w && h) ? (effH > effW) : swap
                    };
                });
            } catch (_) {}
            cb(map);
        });
    }

    function getFps(ffprobe, srcPath) {
        var cp = require('child_process');
        try {
            var out = cp.execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', srcPath], { timeout: 15000 }).toString().trim();
            var parts = out.split('/');
            var fps = parts.length === 2 ? parseFloat(parts[0]) / parseFloat(parts[1]) : parseFloat(out);
            if (fps && fps > 0) return fps;
        } catch (_) {}
        // XAVC fallback: no ffprobe in Wavdrop — parse "NN fps" from ffmpeg -i
        try {
            if (hasWavdrop()) {
                var r = cp.spawnSync(WAVDROP_FF, ['-hide_banner', '-i', srcPath], { timeout: 15000 });
                var m = String(r.stderr).match(/(\d+(?:\.\d+)?)\s*fps/);
                if (m && parseFloat(m[1]) > 0) return parseFloat(m[1]);
            }
        } catch (_) {}
        return 25;
    }
    function extractFrame(ff, srcPath, midSec) {
        var os = require('os'), fs = require('fs'), cp = require('child_process');
        var out = os.tmpdir() + '/dm_stg_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.jpg';
        var args = ['-y', '-ss', String(midSec), '-i', srcPath, '-frames:v', '1',
            '-vf', 'scale=512:-2', '-q:v', '6', out];
        try { cp.execFileSync(ff, args, { timeout: 30000 }); }
        catch (e) {
            if (!hasWavdrop()) throw e;
            cp.execFileSync(WAVDROP_FF, args, { timeout: 30000 });
        }
        var b64 = fs.readFileSync(out).toString('base64');
        try { fs.unlinkSync(out); } catch (_) {}
        return b64;
    }
    function parseTrf(path, W, H) {
        var buf = require('fs').readFileSync(path);
        if (buf.toString('ascii', 0, 4) !== 'TRF1') throw new Error('bad TRF header');
        var off = 24, cx = W / 2, cy = H / 2;
        var frames = [];
        while (off + 8 <= buf.length) {
            off += 4;
            var count = buf.readInt32LE(off); off += 4;
            var mx = 0, my = 0, lms = [];
            for (var i = 0; i < count; i++) {
                var vx = buf.readInt16LE(off); off += 2;
                var vy = buf.readInt16LE(off); off += 2;
                var fx = buf.readInt16LE(off); off += 2;
                var fy = buf.readInt16LE(off); off += 2;
                off += 2 + 16;
                mx += vx; my += vy; lms.push([vx, vy, fx, fy]);
            }
            if (count > 0) { mx /= count; my /= count; }
            var div = 0, nd = 0;
            for (var j = 0; j < lms.length; j++) {
                var rx = lms[j][2] - cx, ry = lms[j][3] - cy;
                var r = Math.sqrt(rx * rx + ry * ry);
                if (r > 20) { div += ((lms[j][0] - mx) * rx + (lms[j][1] - my) * ry) / r; nd++; }
            }
            frames.push({ mx: mx, my: my, mag: Math.sqrt(mx * mx + my * my), div: nd ? div / nd : 0 });
        }
        return frames;
    }
    function parseBlurFile(path) {
        var txt = require('fs').readFileSync(path, 'utf8');
        var blur = [], re = /lavfi\.blur=([0-9.]+)/g, m;
        while ((m = re.exec(txt)) !== null) blur.push(parseFloat(m[1]));
        return blur;
    }
    function median(arr) {
        if (!arr.length) return 0;
        var s = arr.slice().sort(function(a, b) { return a - b; });
        return s[Math.floor(s.length / 2)];
    }
    function smooth1s(arr, fps) {
        var half = Math.max(1, Math.round(fps / 2));
        var out = new Array(arr.length);
        for (var i = 0; i < arr.length; i++) {
            var s = 0, n = 0;
            for (var k = Math.max(0, i - half); k <= Math.min(arr.length - 1, i + half); k++) { s += arr[k]; n++; }
            out[i] = s / n;
        }
        return out;
    }

    // Run up to `limit` workers concurrently over items
    function runPool(items, limit, worker, done) {
        var i = 0, active = 0, results = new Array(items.length), finished = false;
        function pump() {
            while (active < limit && i < items.length) {
                (function(idx) {
                    active++;
                    worker(items[idx], idx, function(res) {
                        results[idx] = res;
                        active--;
                        pump();
                    });
                })(i++);
            }
            if (!finished && active === 0 && i >= items.length) { finished = true; done(results); }
        }
        pump();
    }

    function extractFrameAsync(ff, srcPath, midSec, cb) {
        var os = require('os'), fs = require('fs'), cp = require('child_process');
        var out = os.tmpdir() + '/dm_stg_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.jpg';
        function attempt(ffPath, next) {
            cp.execFile('/usr/bin/nice', ['-n', '15', ffPath, '-y', '-hwaccel', 'videotoolbox', '-ss', String(midSec), '-i', srcPath, '-frames:v', '1',
                '-vf', 'scale=512:-2', '-q:v', '6', out], { timeout: 30000 }, function(err) {
                if (err) { next(); return; }
                try {
                    var b64 = fs.readFileSync(out).toString('base64');
                    try { fs.unlinkSync(out); } catch (_) {}
                    cb(b64);
                } catch (e) { next(); }
            });
        }
        attempt(ff, function() {
            if (hasWavdrop()) attempt(WAVDROP_FF, function() { cb(null); });
            else cb(null);
        });
    }

    function analyzeClipAsync(ff, ffprobe, srcPath, clipDurSec, mode, P, cb) {
        var os = require('os'), fs = require('fs'), cp = require('child_process');
        var uid = Date.now() + '_' + Math.floor(Math.random() * 1e6);
        var trfPath = os.tmpdir() + '/dm_stab_' + uid + '.trf';
        var blurPath = os.tmpdir() + '/dm_blur_' + uid + '.txt';
        var fallbackRes = { segs: [{ start: 0, end: Math.min(WINDOW_SEC, clipDurSec), mag: -1, mx: 0 }], store: null };
        var vfArgs = ['-y', '-hwaccel', 'videotoolbox', '-i', srcPath,
            '-vf', 'scale=' + ANALYZE_W + ':-2,vidstabdetect=stepsize=6:shakiness=8:result=' + trfPath + ',blurdetect,metadata=mode=print:file=' + blurPath,
            '-f', 'null', '-'];
        function runDetect(ffPath, onFail) {
            cp.execFile('/usr/bin/nice', ['-n', '15', ffPath].concat(vfArgs), { timeout: 300000 }, function(err) {
            if (err) { onFail(); return; }
            try {
                var fps = getFps(ffprobe, srcPath);
                var fr = [], blur = [];
                try { fr = parseTrf(trfPath, ANALYZE_W, Math.round(ANALYZE_W * 9 / 16)); } catch (e) {}
                try { blur = parseBlurFile(blurPath); } catch (e) {}
                try { fs.unlinkSync(trfPath); } catch (_) {}
                try { fs.unlinkSync(blurPath); } catch (_) {}
                if (fr.length < fps * 1.5) { cb(fallbackRes); return; }
                var blurMed = median(blur), blurLimit = blurMed * BLUR_FACTOR;
                var S = {
                    mag: smooth1s(fr.map(function(f) { return f.mag; }), fps),
                    mx: smooth1s(fr.map(function(f) { return f.mx; }), fps),
                    my: smooth1s(fr.map(function(f) { return f.my; }), fps),
                    div: smooth1s(fr.map(function(f) { return f.div; }), fps),
                    blurOk: fr.map(function(_, i) {
                        var b = blur[i + 1];
                        return (b !== undefined && blurMed > 0 && b > blurLimit) ? 0 : 1;
                    })
                };
                var segs = segmentSeries(S, fps, clipDurSec, mode, P);
                var factor = Math.max(1, Math.round(fps / 10));
                var store = {
                    fps: fps / factor, dur: clipDurSec,
                    mag: downsample(S.mag, factor), mx: downsample(S.mx, factor),
                    my: downsample(S.my, factor), div: downsample(S.div, factor),
                    blurOk: downsample(S.blurOk, factor).map(function(v) { return v > 0.5 ? 1 : 0; })
                };
                cb({ segs: segs, store: store });
            } catch (e) { cb(fallbackRes); }
            });
        }
        runDetect(ff, function() {
            // XAVC header the static build can't read — retry via Wavdrop
            if (hasWavdrop()) runDetect(WAVDROP_FF, function() { cb(fallbackRes); });
            else cb(fallbackRes);
        });
    }

    function analyzeClip(ff, ffprobe, srcPath, clipDurSec, mode, P) {
        var os = require('os'), fs = require('fs'), cp = require('child_process');
        var uid = Date.now() + '_' + Math.floor(Math.random() * 1e6);
        var trfPath = os.tmpdir() + '/dm_stab_' + uid + '.trf';
        var blurPath = os.tmpdir() + '/dm_blur_' + uid + '.txt';
        var syncArgs = ['-y', '-i', srcPath,
            '-vf', 'scale=' + ANALYZE_W + ':-2,vidstabdetect=stepsize=6:shakiness=8:result=' + trfPath + ',blurdetect,metadata=mode=print:file=' + blurPath,
            '-f', 'null', '-'];
        try {
            cp.execFileSync(ff, syncArgs, { timeout: 180000 });
        } catch (e) {
            try {
                if (!hasWavdrop()) throw e;
                cp.execFileSync(WAVDROP_FF, syncArgs, { timeout: 180000 });
            } catch (e2) { return { segs: [{ start: 0, end: Math.min(WINDOW_SEC, clipDurSec), mag: -1, mx: 0 }], store: null }; }
        }

        var fps = getFps(ffprobe, srcPath);
        var fr = [], blur = [];
        try { fr = parseTrf(trfPath, ANALYZE_W, Math.round(ANALYZE_W * 9 / 16)); } catch (e) {}
        try { blur = parseBlurFile(blurPath); } catch (e) {}
        try { fs.unlinkSync(trfPath); } catch (_) {}
        try { fs.unlinkSync(blurPath); } catch (_) {}
        if (fr.length < fps * 1.5) return { segs: [{ start: 0, end: Math.min(WINDOW_SEC, clipDurSec), mag: -1, mx: 0 }], store: null };

        var blurMed = median(blur), blurLimit = blurMed * BLUR_FACTOR;
        var S = {
            mag: smooth1s(fr.map(function(f) { return f.mag; }), fps),
            mx: smooth1s(fr.map(function(f) { return f.mx; }), fps),
            my: smooth1s(fr.map(function(f) { return f.my; }), fps),
            div: smooth1s(fr.map(function(f) { return f.div; }), fps),
            blurOk: fr.map(function(_, i) {
                var b = blur[i + 1];
                return (b !== undefined && blurMed > 0 && b > blurLimit) ? 0 : 1;
            })
        };
        var segs = segmentSeries(S, fps, clipDurSec, mode, P);
        var factor = Math.max(1, Math.round(fps / 10));
        var store = {
            fps: fps / factor, dur: clipDurSec,
            mag: downsample(S.mag, factor), mx: downsample(S.mx, factor),
            my: downsample(S.my, factor), div: downsample(S.div, factor),
            blurOk: downsample(S.blurOk, factor).map(function(v) { return v > 0.5 ? 1 : 0; })
        };
        return { segs: segs, store: store };
    }

    if (IS_NODE) {
        module.exports = { segmentSeries: segmentSeries, gridSearch: gridSearch, scoreParams: scoreParams,
            analyzeClip: analyzeClip, loadParams: loadParams, DEFAULT_PARAMS: DEFAULT_PARAMS,
            parseTrf: parseTrf, smooth1s: smooth1s, downsample: downsample, median: median,
            parseBlurFile: parseBlurFile, getFps: getFps, findFfmpeg: findFfmpeg, findFfprobe: findFfprobe,
            CAL_DIR: CAL_DIR, ANALYZE_W: ANALYZE_W };
        return;
    }

    /* ── Vision cache: classify each clip once ever ─────────────────── */
    function visionCacheKey(path) {
        try {
            var st = require('fs').statSync(path);
            return path + '|' + st.size + '|' + Math.round(st.mtimeMs) + '|v3';
        } catch (_) { return path; }
    }
    function loadVisionCache() {
        try { return JSON.parse(require('fs').readFileSync(CAL_DIR + '/visionCache.json', 'utf8')); }
        catch (_) { return {}; }
    }
    function saveVisionCache(cache) {
        try {
            ensureCalDirs();
            require('fs').writeFileSync(CAL_DIR + '/visionCache.json', JSON.stringify(cache));
        } catch (_) {}
    }

    /* ── Gemini classification ──────────────────────────────────────── */
    var ROOM_ORDER = ['drone_aerial', 'facade', 'living', 'kitchen', 'dining', 'pool_bbq', 'balcony',
        'master_bedroom', 'ensuite', 'bedroom', 'bathroom', 'stairs', 'hallway', 'entertainment', 'study',
        'garage', 'basement', 'presenter_lifestyle', 'other'];
    // Desire Media color system (Premiere default label palette indices):
    // Yellow=Front | Brown=Backyard/Pool | Iris=Main floor | Caribbean=Master+Ensuite+Balcony
    // Cerulean=Other bedrooms | Teal=Other bathrooms | Purple=Upper floors/Stairs
    // Blue=Entertainment/Office | Tan=Garage/Basement | Violet=Drones | Mango=Presenter/Lifestyle
    var AREA_NAME = {
        drone_aerial: 'DRONES', facade: 'FRONT',
        living: 'MAIN FLOOR', kitchen: 'MAIN FLOOR', dining: 'MAIN FLOOR',
        pool_bbq: 'BACKYARD / POOL', balcony: 'MASTER SUITE', master_bedroom: 'MASTER SUITE', ensuite: 'MASTER SUITE',
        bedroom: 'BEDROOMS', bathroom: 'BATHROOMS',
        stairs: 'STAIRS / UPPER FLOOR', hallway: 'STAIRS / UPPER FLOOR',
        entertainment: 'ENTERTAINMENT / OFFICE', study: 'ENTERTAINMENT / OFFICE',
        garage: 'GARAGE / BASEMENT', basement: 'GARAGE / BASEMENT',
        presenter_lifestyle: 'PRESENTER / LIFESTYLE', other: 'CHECK MANUALLY'
    };
    var GROUP_GAP_SEC = 15;

    var ROOM_COLOR = {
        drone_aerial: 0,        // Violet
        facade: 15,             // Yellow
        living: 1,              // Iris (main floor)
        kitchen: 1,
        dining: 1,
        pool_bbq: 14,           // Brown (backyard/pool)
        balcony: 2,             // Caribbean (goes with master suite)
        master_bedroom: 2,      // Caribbean
        ensuite: 2,             // Caribbean
        bedroom: 4,             // Cerulean (other bedrooms)
        bathroom: 10,           // Teal (other bathrooms/powder)
        stairs: 8,              // Purple (upper floors + stairs)
        hallway: 8,
        entertainment: 9,       // Blue
        study: 9,               // Blue (offices)
        garage: 12,             // Tan
        basement: 12,
        presenter_lifestyle: 7, // Mango
        other: 5                // Forest (stands out = check manually)
    };
    // canonical room for each color group (for learning room corrections from re-colored bins)
    var COLOR_ROOM = { 0: 'drone_aerial', 15: 'facade', 1: 'living', 14: 'pool_bbq', 2: 'master_bedroom',
        4: 'bedroom', 10: 'bathroom', 8: 'stairs', 9: 'entertainment', 12: 'garage', 7: 'presenter_lifestyle', 5: 'other' };

    var GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-3-flash-preview'];
    /* ── Local vision via Ollama (primary — never busy, free, offline) ── */
    var OLLAMA_MODEL = 'qwen3-vl:4b-instruct';
    function ollamaAvailable(cb) {
        var http = require('http');
        var req = http.get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 2000 }, function(res) {
            var d = '';
            res.on('data', function(x) { d += x; });
            res.on('end', function() {
                try { cb(JSON.stringify(JSON.parse(d)).indexOf(OLLAMA_MODEL.split(':')[0]) !== -1); }
                catch (_) { cb(false); }
            });
        });
        req.on('error', function() {
            // try to wake the app once, then re-check
            try { require('child_process').exec('open -a Ollama --hide --background 2>/dev/null'); } catch (_) {}
            setTimeout(function() {
                var r2 = require('http').get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 2000 },
                    function() { cb(true); });
                r2.on('error', function() { cb(false); });
                r2.on('timeout', function() { r2.destroy(); cb(false); });
            }, 4000);
        });
        req.on('timeout', function() { req.destroy(); cb(false); });
    }

    function classifyOllamaOne(frames, cb) {
        if (!Array.isArray(frames)) frames = [frames];
        var CATS = ROOM_ORDER.join(', ');
        var prompt = 'These are ' + frames.length + ' frames (start, middle, end) from ONE real-estate video shot. ' +
            'Consider ALL frames together to identify the room. Return ONLY a JSON object: ' +
            '{"cat": "<one of: ' + CATS + '>", "shot": "wide" or "tight", "usable": true or false}. ' +
            'shot=tight when the camera is CLOSE to a single feature (tap, benchtop, decor object, appliance, artwork, furniture piece) and it fills most of the frame; ' +
            'shot=wide when a substantial part of a room or exterior is visible. When in doubt lean tight if less than ~2 metres of scene is visible. ' +
            'drone_aerial = aerial/drone shot. facade = ground-level exterior front of house. ' +
            'pool_bbq = backyard/pool/outdoor entertaining. presenter_lifestyle = person presenting to camera or lifestyle b-roll. ' +
            'usable=false ONLY if clearly mid-setup: badly tilted horizon, pointing at floor/ceiling, badly out of focus, heavy motion smear. ' +
            'CRITICAL RULE: classify by the MAIN SUBJECT of the shot — the room/area the camera is IN or pointing AT up close. ' +
            'NEVER classify by background elements: stairs visible behind a kitchen = kitchen; a garage door seen from the driveway/street = facade; ' +
            'a bedroom glimpsed through a doorway = the room the camera is in. ' +
            'garage = camera INSIDE the garage only. stairs = the staircase itself fills the frame. ' +
            'pool_bbq = ANY outdoor backyard area: pool, spa, bbq, garden, lawn, courtyard, outdoor furniture. ' +
            'bathroom/ensuite = INDOOR room with toilet/vanity/shower — an outdoor pool or spa is NEVER bathroom. ' +
            'Disambiguation: hallway = a corridor/passage with no furniture — if sofas/dining/kitchen visible it is living/dining/kitchen. ' +
            'balcony = must show railing/balustrade and outdoor floor. master_bedroom = the largest bedroom, usually with ensuite or walk-in robe visible. ' +
            'living = lounge/sofa area. dining = dining table area.';
        var body = JSON.stringify({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: prompt, images: frames }],
            format: 'json', stream: false, options: { temperature: 0 }
        });
        var http = require('http');
        var req = http.request({ host: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function(res) {
            var d = '';
            res.on('data', function(x) { d += x; });
            res.on('end', function() {
                try {
                    var r = JSON.parse(JSON.parse(d).message.content);
                    cb(null, r);
                } catch (e) { cb(e); }
            });
        });
        req.on('error', cb);
        req.setTimeout(120000, function() { req.destroy(); cb(new Error('ollama timeout')); });
        req.write(body); req.end();
    }

    // Master vs secondary bedroom and ensuite vs bathroom are RELATIVE properties —
    // they need cross-clip comparison, impossible from one clip alone.
    function refineRooms(vids, frameOf, cb) {
        function clipNum(name) {
            var m = name.match(/(\d+)\.[^.]+$/);
            return m ? parseInt(m[1], 10) : 0;
        }
        function askIndex(frames, prompt, done) {
            var body = JSON.stringify({
                model: OLLAMA_MODEL,
                messages: [{ role: 'user', content: prompt, images: frames }],
                format: 'json', stream: false, options: { temperature: 0 }
            });
            var http = require('http');
            var req = http.request({ host: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function(res) {
                var d = '';
                res.on('data', function(x) { d += x; });
                res.on('end', function() {
                    try { done(JSON.parse(JSON.parse(d).message.content)); } catch (e) { done(null); }
                });
            });
            req.on('error', function() { done(null); });
            req.setTimeout(120000, function() { req.destroy(); done(null); });
            req.write(body); req.end();
        }

        var beds = vids.filter(function(v) { return v.cat === 'bedroom' || v.cat === 'master_bedroom'; });
        var baths = vids.filter(function(v) { return v.cat === 'bathroom' || v.cat === 'ensuite'; });

        // Tights aren't filmed in room order — match each detail shot VISUALLY against
        // one representative wide per room (materials/finishes identify the room).
        function inheritTights(done) {
            var wides = vids.filter(function(v) { return v.shot !== 'tight' && v.cat && frameOf(v); });
            var tights = vids.filter(function(v) { return v.shot === 'tight' && frameOf(v); });
            if (!wides.length || !tights.length) { done(); return; }
            // one representative wide per room
            var repByRoom = {};
            wides.forEach(function(w) { if (!repByRoom[w.cat]) repByRoom[w.cat] = w; });
            var rooms = Object.keys(repByRoom);
            if (rooms.length < 2) { done(); return; }
            var repFrames = rooms.map(function(r) { return frameOf(repByRoom[r]); });
            var doneN = 0;
            runPool(tights, 2, function(t, ti, next) {
                var prompt = 'Image 1 is a CLOSE-UP detail shot from a real-estate video. ' +
                    'Images 2-' + (rooms.length + 1) + ' are wide shots of different rooms of the SAME property, in this order: ' +
                    rooms.map(function(r, i) { return (i + 2) + '=' + r; }).join(', ') + '. ' +
                    'Match the detail to the room it was filmed in (same materials, benchtops, tiles, colors, fixtures). ' +
                    'Return ONLY JSON: {"room": "<one of: ' + rooms.join(', ') + '>"}';
                askIndex([frameOf(t)].concat(repFrames), prompt, function(r) {
                    doneN++;
                    setStatus('Matching detail shots ' + doneN + '/' + tights.length + '...', 'busy');
                    if (r && r.room && rooms.indexOf(r.room) !== -1) t.cat = r.room;
                    next(null);
                });
            }, function() { done(); });
        }

        function refineBaths(masterNums) {
            if (baths.length < 2 || !masterNums.length) { inheritTights(cb); return; }
            var bathFrames = baths.map(function(v) { return frameOf(v); }).filter(Boolean);
            if (bathFrames.length !== baths.length) { cb(); return; }
            setStatus('Identifying ensuite...', 'busy');
            askIndex(bathFrames,
                'These are ' + baths.length + ' bathroom shots from ONE property, in shooting order. ' +
                'The ensuite is the bathroom attached to the master bedroom — usually the most premium (double vanity, larger). ' +
                'Return ONLY JSON: {"ensuite_indices": [list of image indices (0-based) that show the ensuite, or empty list]}',
                function(r) {
                    var idxs = (r && r.ensuite_indices) || [];
                    baths.forEach(function(v, i) { v.cat = 'bathroom'; });
                    idxs.forEach(function(i) { if (baths[i]) baths[i].cat = 'ensuite'; });
                    // shooting-order tiebreak: bathrooms filmed inside the master cluster are ensuite
                    baths.forEach(function(v) {
                        var n = clipNum(v.name);
                        masterNums.forEach(function(mn) { if (Math.abs(n - mn) <= 3) v.cat = 'ensuite'; });
                    });
                    inheritTights(cb);
                });
        }

        if (beds.length < 2) { refineBaths(beds.filter(function(v) { return v.cat === 'master_bedroom'; }).map(function(v) { return clipNum(v.name); })); return; }
        var bedFrames = beds.map(function(v) { return frameOf(v); }).filter(Boolean);
        if (bedFrames.length !== beds.length) { inheritTights(cb); return; }
        setStatus('Identifying master bedroom...', 'busy');
        askIndex(bedFrames,
            'These are ' + beds.length + ' bedroom shots from ONE property, in shooting order. ' +
            'The master bedroom is the largest/most premium (king bed, walk-in robe, ensuite access). ' +
            'Several shots may show the SAME bedroom. Return ONLY JSON: {"master_indices": [list of image indices (0-based) that show the master bedroom]}',
            function(r) {
                var idxs = (r && r.master_indices) || [];
                beds.forEach(function(v) { v.cat = 'bedroom'; });
                idxs.forEach(function(i) { if (beds[i]) beds[i].cat = 'master_bedroom'; });
                // contiguity: bedroom clips shot between master shots are master too
                var masterNums = beds.filter(function(v) { return v.cat === 'master_bedroom'; }).map(function(v) { return clipNum(v.name); });
                if (masterNums.length) {
                    var lo = Math.min.apply(null, masterNums), hi = Math.max.apply(null, masterNums);
                    beds.forEach(function(v) {
                        var n = clipNum(v.name);
                        if (n >= lo && n <= hi) v.cat = 'master_bedroom';
                    });
                }
                refineBaths(masterNums);
            });
    }

    function classifyFramesOllama(frames, cb) {
        var doneN = 0;
        runPool(frames, 2, function(frame, idx, done) {
            classifyOllamaOne(frame, function(err, r) {
                doneN++;
                setStatus('Classifying ' + doneN + '/' + frames.length + ' (local AI)...', 'busy');
                done(err ? null : { i: idx, cat: r.cat, shot: r.shot === 'tight' ? 'tight' : 'wide', usable: r.usable !== false });
            });
        }, function(results) {
            cb(null, results.filter(Boolean));
        });
    }

    function classifyBatch(key, frames, cb) {
        classifyBatchModel(key, frames, GEMINI_MODELS[0], 0, cb);
    }
    function classifyBatchModel(key, frames, model, attempt, cb) {
        var CATS = ROOM_ORDER.join(', ');
        var prompt = 'These are frames from real-estate video shots, in order. For EACH image return one JSON object: ' +
            '{"i": <image index starting 0>, "cat": "<one of: ' + CATS + '>", "shot": "wide" or "tight", "usable": true or false}. ' +
            'shot=wide when the frame shows a whole room/space/exterior; shot=tight for close-up detail shots (taps, decor, textures, features). ' +
            'drone_aerial = any aerial/drone shot. facade = ground-level exterior FRONT of the house. ' +
            'pool_bbq = backyard/pool/outdoor entertaining. balcony = balcony/terrace. stairs = staircase or upper-floor hallway. ' +
            'entertainment = media/rumpus/entertainment room. study = office/study. basement = basement. ' +
            'presenter_lifestyle = a person presenting to camera or lifestyle b-roll with people. ' +
            'usable=false ONLY when the frame clearly looks like the operator was still setting up: badly tilted horizon, ' +
            'accidentally pointing at the floor/ceiling, badly out of focus, or heavy motion smear. ' +
            'usable=true for any intentional real-estate shot INCLUDING close-up detail shots. ' +
            'Return ONLY a JSON array, one object per image, same order.';
        var parts = [{ text: prompt }];
        frames.forEach(function(f) { parts.push({ inline_data: { mime_type: 'image/jpeg', data: f } }); });
        var body = JSON.stringify({
            contents: [{ parts: parts }],
            generationConfig: { response_mime_type: 'application/json', temperature: 0, maxOutputTokens: 8192 }
        });
        var https = require('https');
        var req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: '/v1beta/models/' + model + ':generateContent?key=' + key,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                try {
                    var j = JSON.parse(data);
                    if (j.error) {
                        var msg = j.error.message || '';
                        var overloaded = /high demand|overloaded|quota|unavailable|429|503|resource.?exhausted/i.test(msg) || j.error.code === 429 || j.error.code === 503;
                        // attempt counts total tries across the model cascade (2 full cycles)
                        if (overloaded && attempt < GEMINI_MODELS.length * 2) {
                            var nextModel = GEMINI_MODELS[(GEMINI_MODELS.indexOf(model) + 1) % GEMINI_MODELS.length];
                            var wait = attempt < GEMINI_MODELS.length ? 4000 : 20000;
                            setStatus('Gemini busy — trying ' + nextModel.replace('gemini-', '') + '...', 'busy');
                            setTimeout(function() { classifyBatchModel(key, frames, nextModel, attempt + 1, cb); }, wait);
                            return;
                        }
                        return cb(new Error('Gemini: ' + msg));
                    }
                    var txt = j.candidates[0].content.parts[0].text;
                    cb(null, JSON.parse(txt));
                } catch (e) { cb(new Error('Gemini parse: ' + e.message + ' | ' + data.slice(0, 150))); }
            });
        });
        req.on('error', function(e) {
            if (attempt < GEMINI_MODELS.length * 2) { setTimeout(function() { classifyBatchModel(key, frames, model, attempt + 1, cb); }, 5000); return; }
            cb(new Error('Gemini request: ' + e.message));
        });
        req.setTimeout(180000, function() {
            req.destroy();
            if (attempt < GEMINI_MODELS.length * 2) {
                var nextModel = GEMINI_MODELS[(GEMINI_MODELS.indexOf(model) + 1) % GEMINI_MODELS.length];
                setStatus('Gemini slow — trying ' + nextModel.replace('gemini-', '') + '...', 'busy');
                setTimeout(function() { classifyBatchModel(key, frames, nextModel, attempt + 1, cb); }, 3000);
                return;
            }
            cb(new Error('Gemini timeout'));
        });
        req.write(body); req.end();
    }
    function classifyFrames(key, frames, cb) {
        if (!frames.length) { cb(null, []); return; }
        ollamaAvailable(function(ok) {
            if (ok) { classifyFramesOllama(frames, cb); return; }
            classifyFramesGemini(key, frames, cb);
        });
    }

    function classifyFramesGemini(key, frames, cb) {
        // Gemini batch contract is one image per index — use the middle frame of each group
        frames = frames.map(function(f) { return Array.isArray(f) ? f[Math.floor(f.length / 2)] : f; });
        var BATCH = 20, PAUSE_MS = 5000, all = [], offset = 0;
        function next() {
            if (offset >= frames.length) { cb(null, all); return; }
            var slice = frames.slice(offset, offset + BATCH);
            var base = offset;
            classifyBatch(key, slice, function(err, cats) {
                if (err) { cb(err); return; }
                cats.forEach(function(x) {
                    all.push({ i: base + x.i, cat: x.cat, shot: x.shot === 'tight' ? 'tight' : 'wide', usable: x.usable !== false });
                });
                offset += BATCH;
                setStatus('Classifying ' + Math.min(offset, frames.length) + '/' + frames.length + '...', 'busy');
                // breathe between batches to stay under free-tier rate limits
                if (offset < frames.length) setTimeout(next, PAUSE_MS);
                else next();
            });
        }
        next();
    }

    /* ── Build button ───────────────────────────────────────────────── */
    var btn = document.getElementById('prStagingSequence');
    if (btn) btn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { failStatus('Staging Sequence only works in Premiere'); return; }
        var key = getGeminiKey();
        if (!key) { failStatus('Gemini API key not found'); return; }
        btn.disabled = true;
        // Kill any stray analysis processes from a previous crashed/aborted run
        try { require('child_process').exec('pkill -9 -f vidstabdetect 2>/dev/null'); } catch (_) {}
        // Warm up the local model now so it's loaded by the time frames are ready
        try {
            var wbody = JSON.stringify({ model: OLLAMA_MODEL, prompt: 'hi', stream: false, keep_alive: '60m' });
            var wreq = require('http').request({ host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wbody) } });
            wreq.on('error', function() {});
            wreq.write(wbody); wreq.end();
        } catch (_) {}
        var PARAMS = loadParams();
        setStatus('Reading clips from 02 MEDIA...', 'busy');

        var jsxCollect = '(function(){' +
            'var out=[];' +
            'function grab(it){try{var p=it.getMediaPath();if(!p)return;var px="";try{if(it.hasProxy&&it.hasProxy())px=it.getProxyPath();}catch(ep){}out.push({id:it.nodeId,name:it.name,path:p,proxy:px,dur:it.getOutPoint(4).seconds});}catch(e){}}' +
            'function grabBin(bin){for(var j=0;j<bin.children.numItems;j++){var ch=bin.children[j];' +
            'if(ch.type===ProjectItemType.BIN)grabBin(ch);else grab(ch);}}' +
            'var media=null;' +
            'function findBin(bin){for(var k=0;k<bin.children.numItems;k++){var b=bin.children[k];' +
            'if(b.type===ProjectItemType.BIN){if(b.name.toUpperCase().indexOf("02 MEDIA")===0){media=b;return;}findBin(b);if(media)return;}}}' +
            'findBin(app.project.rootItem);' +
            'if(!media)return JSON.stringify({error:"Bin 02 MEDIA not found"});' +
            'grabBin(media);' +
            'return JSON.stringify({clips:out});}())';

        evalScript(jsxCollect, function(res) {
            var info;
            try { info = JSON.parse(res); } catch (_) { info = { error: 'collect parse failed' }; }
            if (info.error) { failStatus(info.error); btn.disabled = false; return; }

            var vids = info.clips.filter(function(c) { return /\.(mp4|mov|mxf|m4v)$/i.test(c.path); });
            if (vids.length < 2) { failStatus('Need at least 2 video clips in 02 MEDIA'); btn.disabled = false; return; }
            if (vids.length > 400) vids = vids.slice(0, 400);

            var ff = findFfmpeg(), ffprobe = findFfprobe();

            setStatus('Reading lens/orientation metadata (' + vids.length + ' clips)...', 'busy');
            readClipMeta(vids.map(function(v) { return v.path; }), function(metaMap) {
                // per-shoot calibration: the lens rule only applies when the
                // shoot mixes a NAMED (electronic) lens with empty ones
                // (two-lens setup like Calvin's: empty = manual wide). When
                // ALL lenses are empty (Matheus: both lenses manual), the
                // metadata is uninformative — vision decides wide/tight.
                var anyNamed = vids.some(function(v) {
                    var m = metaMap[v.path];
                    return m && m.lens && !m.vertical;
                });
                // vertical clips are reel footage — out of the horizontal pool
                var nVert = 0;
                vids.forEach(function(v) {
                    var m = metaMap[v.path];
                    if (m) {
                        v.lensShot = anyNamed ? m.shot : null;
                        if (m.vertical) nVert++;
                        v.vertical = m.vertical;
                    }
                });
                vids = vids.filter(function(v) { return !v.vertical; });
                if (nVert) setStatus(nVert + ' vertical (reel) clips excluded — classifying ' + vids.length + '...', 'busy');
                if (vids.length < 2) { failStatus('No horizontal clips left after reel filter'); btn.disabled = false; return; }

            setTimeout(function() {
                setStatus('Extracting frames (parallel)...', 'busy');
                runPool(vids, 4, function(v, idx, done) {
                    var readPath = (v.proxy && require('fs').existsSync(v.proxy)) ? v.proxy : v.path;
                    // 3 frames across the shot: an orbit reveals the room over time
                    var times = [Math.max(0.5, v.dur * 0.25), Math.max(0.6, v.dur * 0.5), Math.max(0.7, v.dur * 0.75)];
                    runPool(times, 3, function(t, ti, fDone) {
                        extractFrameAsync(ff, readPath, t, fDone);
                    }, function(fr3) {
                        var group = fr3.filter(Boolean);
                        done(group.length ? group : null);
                    });
                }, function(frameResults) {
                var midFrames = [], midIdx = [];
                frameResults.forEach(function(f, mi2) { if (f) { midFrames.push(f); midIdx.push(mi2); } });
                if (midFrames.length < 2) { failStatus('Frame extraction failed'); btn.disabled = false; return; }

                // Cache hit = same file classified before: skip Gemini for it
                var vCache = loadVisionCache();
                vids.forEach(function(v) {
                    var hit = vCache[visionCacheKey(v.path)];
                    if (hit) { v.cat = hit.cat; v.shot = hit.shot; v.cached = true; }
                    // the lens is ground truth for wide/tight — vision only does rooms
                    if (v.lensShot) v.shot = v.lensShot;
                });
                var freshFrames = [], freshVids = [];
                midIdx.forEach(function(vi, fi) {
                    var v = vids[vi];
                    if (v && !v.cached) { freshFrames.push(midFrames[fi]); freshVids.push(v); }
                });
                setStatus(freshFrames.length ? ('Detecting shot types (' + freshFrames.length + ' new)...') : 'Clips already classified (cache) — analyzing...', 'busy');
                classifyFrames(key, freshFrames, function(errT, typeInfo) {
                    if (errT) { failStatus(errT.message); btn.disabled = false; return; }
                    typeInfo.forEach(function(t) {
                        var v = freshVids[t.i];
                        if (v) {
                            v.cat = t.cat;
                            v.shot = v.lensShot || t.shot;   // lens wins over vision
                            vCache[visionCacheKey(v.path)] = { cat: t.cat, shot: v.shot };
                        }
                    });
                    saveVisionCache(vCache);

                    // Cross-clip refinement: master vs bedrooms, ensuite vs bathrooms
                    var frameByVid = {};
                    midIdx.forEach(function(vi, fi) {
                        var g = midFrames[fi];
                        frameByVid[vids[vi].id] = Array.isArray(g) ? g[Math.floor(g.length / 2)] : g;
                    });
                    refineRooms(vids.filter(function(v) { return !!v.cat; }), function(v) { return frameByVid[v.id]; }, function() {
                        vids.forEach(function(v) {
                            if (v.cat) vCache[visionCacheKey(v.path)] = { cat: v.cat, shot: v.shot };
                        });
                        saveVisionCache(vCache);
                        proceed();
                    });

                    function proceed() {
                    var runId = String(Date.now());
                    var analyzable = vids.filter(function(v) { return !!v.cat; });
                    var doneCount = 0;
                    setStatus('Analyzing motion 0/' + analyzable.length + ' (parallel)...', 'busy');
                    runPool(analyzable, 3, function(v, idx, done) {
                        var mode = v.shot === 'tight' ? 'tight' : 'wide';
                        var readPath = (v.proxy && require('fs').existsSync(v.proxy)) ? v.proxy : v.path;
                        analyzeClipAsync(ff, ffprobe, readPath, v.dur, mode, PARAMS[mode], function(an) {
                            doneCount++;
                            setStatus('Analyzing motion ' + doneCount + '/' + analyzable.length + '...', 'busy');
                            done({ vid: v, an: an, segFrames: an.segs.map(function(seg) { return { seg: seg }; }) });
                        });
                    }, function(results) {
                    var featureRecords = [];
                    var segEntries = [];
                    results.forEach(function(r) {
                        if (!r) return;
                        if (r.an.store) featureRecords.push({ path: r.vid.path, name: r.vid.name, shot: r.vid.shot,
                            fps: r.an.store.fps, dur: r.an.store.dur, mag: r.an.store.mag, mx: r.an.store.mx, my: r.an.store.my, div: r.an.store.div, blurOk: r.an.store.blurOk });
                        r.segFrames.forEach(function(sf) {
                            segEntries.push({ vid: r.vid, seg: sf.seg, frame: sf.frame });
                        });
                    });
                    if (segEntries.length < 2) { failStatus('No usable segments found'); btn.disabled = false; return; }
                    saveRunFeatures(runId, featureRecords);

                    // Segment-level AI verification removed: it doubled classification cost
                    // for marginal gain — motion gates + Learn corrections cover it.
                    segEntries.forEach(function(e) { e.cat = e.vid.cat; e.usable = true; });
                    setStatus('Building staging sequence...', 'busy');
                    (function(err, cats) {
                        if (err) { failStatus(err.message); btn.disabled = false; return; }
                        var entries = segEntries;
                        try {
                            require('fs').writeFileSync('/tmp/dm_staging_report.json', JSON.stringify(
                                entries.map(function(e) { return { clip: e.vid.name, shot: e.vid.shot, start: e.seg.start, end: e.seg.end, mag: e.seg.mag, mx: e.seg.mx, cat: e.cat, usable: e.usable }; }), null, 2));
                        } catch (_) {}

                        var kept = entries.filter(function(e) { return e.usable; });
                        if (!kept.length) { failStatus('AI marked all segments as unusable — see /tmp/dm_staging_report.json'); btn.disabled = false; return; }

                        var clips = [], byClip = {};
                        kept.forEach(function(e) {
                            if (!byClip[e.vid.id]) { byClip[e.vid.id] = { id: e.vid.id, name: e.vid.name, path: e.vid.path, shot: e.vid.shot, cat: e.vid.cat, segs: [] }; clips.push(byClip[e.vid.id]); }
                            byClip[e.vid.id].segs.push(e.seg);
                        });

                        var ordered = [];
                        ROOM_ORDER.forEach(function(room) {
                            // wides first, then tights, within each room
                            clips.forEach(function(c) { if (c.cat === room && c.shot !== 'tight') ordered.push(c); });
                            clips.forEach(function(c) { if (c.cat === room && c.shot === 'tight') ordered.push(c); });
                        });
                        if (!ordered.length) { failStatus('No clips classified'); btn.disabled = false; return; }

                        setStatus('Building staging sequence...', 'busy');
                        var plan = [];
                        var planEntries = [];
                        var lastArea = null;
                        ordered.forEach(function(c) {
                            var area = AREA_NAME[c.cat] || 'OTHER';
                            c.segs.forEach(function(s, segIdx) {
                                var isNewArea = (segIdx === 0 && area !== lastArea);
                                plan.push({
                                    id: c.id, inSec: s.start, outSec: s.end,
                                    color: ROOM_COLOR[c.cat] != null ? ROOM_COLOR[c.cat] : 0,
                                    gap: isNewArea && lastArea !== null ? GROUP_GAP_SEC : 0,
                                    marker: isNewArea ? area : ''
                                });
                                planEntries.push({ path: c.path, name: c.name, shot: c.shot, cat: c.cat, start: s.start, end: s.end });
                                if (isNewArea) lastArea = area;
                            });
                        });
                        saveLastPlan(runId, planEntries);

                        var jsxBuild = '(function(){' +
                            'var plan=' + JSON.stringify(JSON.stringify(plan)) + ';plan=JSON.parse(plan);' +
                            'var byId={};' +
                            'function walk(bin){for(var i=0;i<bin.children.numItems;i++){var it=bin.children[i];' +
                            'if(it.type===ProjectItemType.BIN)walk(it);else byId[it.nodeId]=it;}}' +
                            'walk(app.project.rootItem);' +
                            'var firstPi=byId[plan[0].id];' +
                            'if(!firstPi)return JSON.stringify({error:"first clip not found"});' +
                            'var nest=null;' +
                            'try{nest=app.project.createNewSequenceFromClips("Staging Sequence",[firstPi]);}catch(e){return JSON.stringify({error:"createSeq: "+e});}' +
                            'if(!nest)return JSON.stringify({error:"createSeq returned null"});' +
                            'try{var vt0=nest.videoTracks[0];for(var rc=vt0.clips.numItems-1;rc>=0;rc--){try{vt0.clips[rc].remove(false,false);}catch(e2){}}}catch(e3){}' +
                            'var t=0,n=0;' +
                            'for(var k=0;k<plan.length;k++){var pi=byId[plan[k].id];if(!pi)continue;' +
                            'if(plan[k].gap)t+=plan[k].gap;' +
                            'if(plan[k].marker){try{var mk=nest.markers.createMarker(t);try{mk.name=plan[k].marker;}catch(en){}try{mk.comments=plan[k].marker;}catch(ec){}try{mk.end=t+2;}catch(ee){}}catch(emk){}}' +
                            'try{pi.setColorLabel(plan[k].color);}catch(ecl){}' +
                            'try{' +
                            'pi.setInPoint(plan[k].inSec,4);pi.setOutPoint(plan[k].outSec,4);' +
                            'nest.videoTracks[0].overwriteClip(pi,t);' +
                            't+=(plan[k].outSec-plan[k].inSec);n++;' +
                            '}catch(e4){}' +
                            'try{pi.clearInPoint(4);pi.clearOutPoint(4);}catch(e5){}}' +
                            'for(var at=0;at<nest.audioTracks.numTracks;at++){var aTr=nest.audioTracks[at];' +
                            'for(var ac=aTr.clips.numItems-1;ac>=0;ac--){try{aTr.clips[ac].remove(false,false);}catch(e6){}}}' +
                            'return JSON.stringify({ok:n});}())';

                        evalScript(jsxBuild, function(res2) {
                            var r;
                            try { r = JSON.parse(res2); } catch (_) { r = { error: 'build parse failed: ' + res2 }; }
                            if (r.error) failStatus(r.error);
                            else setStatus('Staging built: ' + r.ok + ' segments ✓ — trim it, then click Learn From My Edits', 'success');
                            btn.disabled = false;
                        });
                    })(null, []);
                    });
                    }
                });
                });
            }, 50);
            });   // readClipMeta
        });
    });

    /* ── Make Proxies button ────────────────────────────────────────── */
    var proxyBtn = document.getElementById('prMakeProxies');
    if (proxyBtn) proxyBtn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { failStatus('Make Proxies only works in Premiere'); return; }
        // clear, early message on Macs without any usable ffmpeg (the
        // fallback 'ffmpeg' string would ENOENT confusingly mid-loop)
        var ffOk = findFfmpeg() !== 'ffmpeg' || hasWavdrop();
        if (!ffOk) { try { require('child_process').execSync('command -v ffmpeg', { timeout: 3000 }); ffOk = true; } catch (_) {} }
        if (!ffOk) { failStatus('Make Proxies: ffmpeg not found on this Mac — install Wavdrop (or ffmpeg) and try again'); return; }
        proxyBtn.disabled = true;
        try { require('child_process').exec('pkill -9 -f vidstabdetect 2>/dev/null'); } catch (_) {}
        setStatus('Reading clips from 02 MEDIA...', 'busy');

        var jsxCollect = '(function(){' +
            'var out=[];' +
            'function grab(it){try{var p=it.getMediaPath();if(!p)return;var hp=false;try{hp=it.hasProxy&&it.hasProxy();}catch(ep){}out.push({id:it.nodeId,name:it.name,path:p,hasProxy:hp});}catch(e){}}' +
            'function grabBin(bin){for(var j=0;j<bin.children.numItems;j++){var ch=bin.children[j];' +
            'if(ch.type===ProjectItemType.BIN)grabBin(ch);else grab(ch);}}' +
            'var media=null;' +
            'function findBin(bin){for(var k=0;k<bin.children.numItems;k++){var b=bin.children[k];' +
            'if(b.type===ProjectItemType.BIN){if(b.name.toUpperCase().indexOf("02 MEDIA")===0){media=b;return;}findBin(b);if(media)return;}}}' +
            'findBin(app.project.rootItem);' +
            'if(!media)return JSON.stringify({error:"Bin 02 MEDIA not found"});' +
            'grabBin(media);' +
            'return JSON.stringify({clips:out});}())';

        evalScript(jsxCollect, function(res) {
            var info;
            try { info = JSON.parse(res); } catch (_) { info = { error: 'collect parse failed' }; }
            if (info.error) { failStatus(info.error); proxyBtn.disabled = false; return; }

            var fs = require('fs'), path = require('path'), cp = require('child_process');
            var todo = info.clips.filter(function(v) { return /\.(mp4|mov|mxf|m4v)$/i.test(v.path) && !v.hasProxy; });
            if (!todo.length) { setStatus('All clips already have proxies ✓', 'success'); proxyBtn.disabled = false; return; }

            var ff = findFfmpeg();
            var doneN = 0;
            setStatus('Making proxies 0/' + todo.length + '...', 'busy');

            runPool(todo, 3, function(v, idx, done) {
                var dir = path.join(path.dirname(v.path), 'Proxies');
                try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
                var base = path.basename(v.path).replace(/\.[^.]+$/, '');
                var proxyPath = path.join(dir, base + '_Proxy.mp4');
                function finish(ok) {
                    doneN++;
                    setStatus('Making proxies ' + doneN + '/' + todo.length + '...', 'busy');
                    done(ok ? { id: v.id, proxyPath: proxyPath } : null);
                }
                if (fs.existsSync(proxyPath)) { finish(true); return; }   // generated before, just attach
                // Atomic: write to temp name, validate, then rename — a killed job never
                // leaves a broken file with a valid proxy name (crashed Premiere once).
                var tmpPath = path.join(dir, '.tmp_' + base + '.mp4');
                var encArgs = ['-y', '-hwaccel', 'videotoolbox', '-i', v.path,
                    '-vf', 'scale=960:-2', '-c:v', 'h264_videotoolbox', '-b:v', '4M',
                    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmpPath];
                function encode(ffPath, onFail) {
                    cp.execFile('/usr/bin/nice', ['-n', '15', ffPath].concat(encArgs),
                        { timeout: 600000 }, function(err) {
                        if (err || !fs.existsSync(tmpPath)) {
                            try { fs.unlinkSync(tmpPath); } catch (_) {}
                            onFail(); return;
                        }
                        cp.execFile(findFfprobe(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmpPath],
                            { timeout: 30000 }, function(errP, stdout) {
                            if (errP || !parseFloat(stdout)) {
                                try { fs.unlinkSync(tmpPath); } catch (_) {}
                                onFail(); return;
                            }
                            try { fs.renameSync(tmpPath, proxyPath); finish(true); }
                            catch (eR) { finish(false); }
                        });
                    });
                }
                encode(ff, function() {
                    // Sony XAVC the static build can't read — retry via Wavdrop
                    if (hasWavdrop()) encode(WAVDROP_FF, function() { finish(false); });
                    else finish(false);
                });
            }, function(results) {
                var made = results.filter(Boolean);
                if (!made.length) { failStatus('Proxy generation failed for all clips'); proxyBtn.disabled = false; return; }

                setStatus('Attaching ' + made.length + ' proxies...', 'busy');
                var attachMap = {};
                made.forEach(function(m) { attachMap[m.id] = m.proxyPath; });
                var jsxAttach = '(function(){' +
                    'var map=' + JSON.stringify(JSON.stringify(attachMap)) + ';map=JSON.parse(map);' +
                    'var n=0,errs=[];' +
                    'function walk(bin){for(var i=0;i<bin.children.numItems;i++){var it=bin.children[i];' +
                    'if(it.type===ProjectItemType.BIN){walk(it);}' +
                    'else if(map[it.nodeId]){try{it.attachProxy(map[it.nodeId],0);n++;}catch(e){errs.push(String(e));}}}}' +
                    'walk(app.project.rootItem);' +
                    'return JSON.stringify({ok:n,errs:errs.slice(0,3)});}())';
                evalScript(jsxAttach, function(res2) {
                    var r;
                    try { r = JSON.parse(res2); } catch (_) { r = { ok: 0, errs: ['parse: ' + res2] }; }
                    if (r.ok > 0) setStatus('Proxies ready: ' + r.ok + ' attached ✓', 'success');
                    else failStatus('Attach failed: ' + (r.errs || []).join('; '));
                    proxyBtn.disabled = false;
                });
            });
        });
    });

    /* ── Learn From My Edits button ─────────────────────────────────── */
    var learnBtn = document.getElementById('prStagingLearn');
    if (learnBtn) learnBtn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { failStatus('Learn only works in Premiere'); return; }
        var fs = require('fs');
        var lastPlan;
        try { lastPlan = JSON.parse(fs.readFileSync(CAL_DIR + '/lastPlan.json', 'utf8')); }
        catch (_) { failStatus('No staging run to learn from — build a Staging Sequence first'); return; }
        learnBtn.disabled = true;
        setStatus('Reading your edits from the staging sequence...', 'busy');

        var jsxRead = '(function(){' +
            'var seq=app.project.activeSequence;' +
            'if(!seq)return JSON.stringify({error:"Open the Staging Sequence first"});' +
            'if(seq.name.indexOf("Staging")===-1)return JSON.stringify({error:"Active sequence is not a Staging Sequence"});' +
            'var out=[];' +
            'for(var t=0;t<seq.videoTracks.numTracks;t++){var tr=seq.videoTracks[t];' +
            'for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];' +
            'try{var col=-1;try{col=cl.projectItem.getColorLabel();}catch(ec){}' +
            'out.push({path:cl.projectItem.getMediaPath(),inSec:cl.inPoint.seconds,outSec:cl.outPoint.seconds,color:col});}catch(e){}}}' +
            'return JSON.stringify({clips:out});}())';

        evalScript(jsxRead, function(res) {
            var info;
            try { info = JSON.parse(res); } catch (_) { info = { error: 'read parse failed' }; }
            if (info.error) { failStatus(info.error); learnBtn.disabled = false; return; }

            var labels = [];
            lastPlan.entries.forEach(function(p) {
                var match = null, bestOv = 0;
                info.clips.forEach(function(c) {
                    if (c.path !== p.path) return;
                    var ov = Math.min(c.outSec, p.end) - Math.max(c.inSec, p.start);
                    if (ov > bestOv) { bestOv = ov; match = c; }
                });
                labels.push({
                    runId: lastPlan.runId, path: p.path, shot: p.shot,
                    algo: [p.start, p.end],
                    desired: match ? [Math.round(match.inSec * 100) / 100, Math.round(match.outSec * 100) / 100] : null
                });
            });

            // Room corrections: if the editor re-colored a clip in the bin to a different
            // color group, learn the corrected room into the vision cache.
            var roomFixes = 0;
            try {
                var vc = loadVisionCache();
                var seenPath = {};
                info.clips.forEach(function(cl) {
                    if (seenPath[cl.path] || cl.color == null || cl.color < 0) return;
                    seenPath[cl.path] = true;
                    var p = null;
                    lastPlan.entries.forEach(function(pe) { if (pe.path === cl.path && !p) p = pe; });
                    if (!p || !p.cat) return;
                    if (ROOM_COLOR[p.cat] === cl.color) return;             // unchanged
                    var newRoom = COLOR_ROOM[cl.color];
                    if (!newRoom) return;
                    var k2 = visionCacheKey(cl.path);
                    vc[k2] = { cat: newRoom, shot: (vc[k2] && vc[k2].shot) || p.shot };
                    roomFixes++;
                });
                if (roomFixes) saveVisionCache(vc);
            } catch (_) {}

            var changed = labels.filter(function(l) {
                return !l.desired || Math.abs(l.desired[0] - l.algo[0]) > 0.1 || Math.abs(l.desired[1] - l.algo[1]) > 0.1;
            }).length;
            appendLabels(labels);
            setStatus('Learning from ' + labels.length + ' segments (' + changed + ' trims, ' + roomFixes + ' room fixes)...', 'busy');

            setTimeout(function() {
                try {
                    var msg = refitParams();
                    setStatus('Learned ✓ ' + (msg || '(need 2+ labeled clips per shot type)'), 'success');
                } catch (e) { failStatus('Learn failed: ' + e.message); }
                learnBtn.disabled = false;
            }, 50);
        });
    });

    /* ── Organize Reels: no PREMIERE (Matheus 14/jul, 3a versao — a certa).
       Olha os clips DENTRO do bin CLIP do projeto aberto, le o Video Info
       (a mesma coluna do painel: "3840 x 2160"), e move os portrait
       (altura > largura) pro bin Reels DENTRO do CLIP. Um clique, sem
       dialogo, sem filesystem — e desfazivel com Cmd+Z. */
    var reelsBtn = document.getElementById('prReelsFolder');
    if (reelsBtn) reelsBtn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { setStatus('Organize Reels only works in Premiere', 'error'); return; }
        reelsBtn.disabled = true;
        setStatus('Reading Video Info of the CLIP bin...', 'busy');
        var jsx = '(function(){' +
            'function findBin(bin,name){' +
            'for(var i=0;i<bin.children.numItems;i++){var it=bin.children[i];' +
            'if(it.type===ProjectItemType.BIN){' +
            'if(it.name.toUpperCase()===name)return it;' +
            'var r=findBin(it,name);if(r)return r;}}' +
            'return null;}' +
            'var clip=findBin(app.project.rootItem,"CLIP");' +
            'if(!clip)return JSON.stringify({error:"bin CLIP not found in this project"});' +
            'var reels=null;' +
            'for(var i=0;i<clip.children.numItems;i++){var c=clip.children[i];' +
            'if(c.type===ProjectItemType.BIN&&c.name.toUpperCase()==="REELS"){reels=c;break;}}' +
            // coleta primeiro, move depois (mover muta a lista de children)
            'var toMove=[],checked=0;' +
            'for(var j=0;j<clip.children.numItems;j++){var it2=clip.children[j];' +
            'if(it2.type===ProjectItemType.BIN)continue;' +
            'var vi="";' +
            'try{var md=it2.getProjectMetadata();' +
            'var mm=md.match(/Column\\.Intrinsic\\.VideoInfo>([^<]*)</);' +
            'if(mm)vi=mm[1];}catch(e){}' +
            'var d=vi.match(/(\\d+)\\s*[xX]\\s*(\\d+)/);' +
            'if(d){checked++;' +
            'if(parseInt(d[2],10)>parseInt(d[1],10))toMove.push(it2);}}' +
            'if(!toMove.length)return JSON.stringify({ok:1,moved:0,checked:checked});' +
            'if(!reels){try{reels=clip.createBin("Reels");}catch(eb){return JSON.stringify({error:"cannot create Reels bin: "+eb});}}' +
            'var moved=0;' +
            'for(var k=0;k<toMove.length;k++){try{toMove[k].moveBin(reels);moved++;}catch(em){}}' +
            'return JSON.stringify({ok:1,moved:moved,found:toMove.length,checked:checked});}())';
        evalScript(jsx, function(res) {
            reelsBtn.disabled = false;
            var r;
            try { r = JSON.parse(res); } catch (_) { r = { error: 'Reels parse failed: ' + res }; }
            if (r.error) { setStatus(r.error, 'error'); return; }
            if (!r.moved && !r.found) { setStatus('Reels: 0 portrait among ' + r.checked + ' clips in CLIP', 'success'); return; }
            setStatus('Reels: ' + r.moved + '/' + r.found + ' portrait clips moved into CLIP/Reels' +
                (r.moved < r.found ? ' — ' + (r.found - r.moved) + ' FAILED' : ''),
                r.moved < r.found ? 'error' : 'success');
        });
    });
})();
