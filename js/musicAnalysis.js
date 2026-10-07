/* ── Music Analysis — beat grid, drop detection, 60/90s section picker ──
   Phase 2 of the auto-assembly roadmap. Python (py/analyze_music.py,
   librosa) extracts DSP features only; every decision — downbeats, drops,
   sections, section selection — lives here so it is Node-testable offline
   against real tracks before anything touches Premiere.
   Panel flow: pick music file → analyze → best 60/90s cut → sequence with
   bar/DROP/section/FADE markers. Plan saved to calibration/lastMusic.json
   for the future auto-assembly step.
   CLI:  node js/musicAnalysis.js analyze <file> [--dur 90]
         node js/musicAnalysis.js analyze-folder <dir> [--dur 90]          */
(function() {
    var IS_NODE = (typeof document === 'undefined');

    var PYTHON_PATHS = ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'];
    var PY_SCRIPT_PATHS = ['/Users/desiremedia/Documents/DM_Tools_CEP/py/analyze_music.py',
        '/Users/desiremedia/Library/Application Support/Adobe/CEP/extensions/DM_Tools/py/analyze_music.py'];
    var FFMPEG_PATHS = ['/Users/desiremedia/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg',
        '/Applications/Wavdrop.app/Contents/Resources/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    var CAL_DIR = '/Users/desiremedia/Documents/DM_Tools_CEP/calibration';
    var MUSIC_DIR = '/Users/desiremedia/Documents/Desire Music';
    var CACHE_V = 'v1';
    var MARK_EVERY_BEAT = false;

    /* Selection tuning — iterate these against ear tests on real tracks */
    var SEL = {
        tolSec: 3, hardTolSec: 5,
        dropTargetSec: 12.5,     // Desire recipe: the drop lands 10-15s into the video
        dropMinSec: 8, dropFracMax: 0.42,       // hard window (soft-only fallback if empty)
        wDropPos: 6.0,           // penalty weight for drop position error
        phrase8: 1.5, phrase4: 0.7, phraseOff: -2.0,   // end N bars from the drop
        wResolve: 0.8,           // energy drops after the cut point (music resolves)
        wCrescendo: -1.0,        // never cut mid-crescendo
        wCliffhanger: -2.0,      // never end right before another drop (energy step-up after end)
        wHeadroom: 0.5,          // intro/build audibly quieter than the drop
        wBoundary: 0.4,          // start near a section boundary
        wDurAcc: -1.0,           // duration accuracy (per tolSec of error)
        wDropStrength: 0.3
    };
    var DROP = { minT: 8, maxFrac: 0.75, stepWin: 8, bassWin: 4, susWin: 15, susDb: 3, buildWin: 16, nmsBars: 8, keep: 3 };

    /* ── small numeric helpers (0.25s-grid arrays) ──────────────────── */
    function mean(a, i0, i1) {
        i0 = Math.max(0, Math.floor(i0)); i1 = Math.min(a.length, Math.ceil(i1));
        if (i1 <= i0) return 0;
        var s = 0; for (var i = i0; i < i1; i++) s += a[i];
        return s / (i1 - i0);
    }
    function slopePerSec(a, i0, i1, hop) {
        i0 = Math.max(0, Math.floor(i0)); i1 = Math.min(a.length, Math.ceil(i1));
        var n = i1 - i0;
        if (n < 2) return 0;
        var sx = 0, sy = 0, sxy = 0, sxx = 0;
        for (var i = 0; i < n; i++) { var y = a[i0 + i]; sx += i; sy += y; sxy += i * y; sxx += i * i; }
        var denom = n * sxx - sx * sx;
        if (!denom) return 0;
        return ((n * sxy - sx * sy) / denom) / hop;
    }
    function medianInterval(ts) {
        var d = [];
        for (var i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
        d.sort(function(a, b) { return a - b; });
        return d.length ? d[Math.floor(d.length / 2)] : 0.5;
    }
    function nearestIndex(arr, t) {
        var best = 0, bd = Infinity;
        for (var i = 0; i < arr.length; i++) { var d = Math.abs(arr[i] - t); if (d < bd) { bd = d; best = i; } }
        return best;
    }

    /* ── downbeats: assume 4/4, phase = strongest kick emphasis ─────── */
    function pickDownbeatPhase(beats, lowAtBeats) {
        var sum = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
        for (var i = 0; i < beats.length; i++) { sum[i % 4] += (lowAtBeats[i] || 0); cnt[i % 4]++; }
        var score = sum.map(function(s, p) { return cnt[p] ? s / cnt[p] : 0; });
        var best = 0;
        for (var p = 1; p < 4; p++) if (score[p] > score[best]) best = p;
        var others = 0;
        for (var q = 0; q < 4; q++) if (q !== best) others += score[q];
        others /= 3;
        return { phase: best, confidence: others > 0 ? score[best] / others : 1 };
    }

    /* ── drop detection: sustained energy step-up + bass arrival ────── */
    function detectDrops(raw, barDur) {
        var E = raw.energyDb, LR = raw.lowRatio, hop = raw.hopSec;
        var W = Math.round(DROP.stepWin / hop), B = Math.round(DROP.bassWin / hop);
        var SUS = Math.round(DROP.susWin / hop);
        var cands = [];
        for (var bi = 0; bi < raw.beats.length; bi++) {
            var t = raw.beats[bi];
            if (t < DROP.minT || t > raw.duration * DROP.maxFrac) continue;
            var b = Math.round(t / hop);
            if (b - W < 0 || b + W > E.length) continue;
            var pre = mean(E, b - W, b);
            var step = mean(E, b, b + W) - pre;
            var bassJump = mean(LR, b, b + B) - mean(LR, b - B, b);
            var above = 0, n = 0;
            for (var i = b; i < Math.min(E.length, b + SUS); i++) { n++; if (E[i] > pre + DROP.susDb) above++; }
            var sustain = n ? above / n : 0;
            var build = Math.max(0, slopePerSec(E, b - Math.round(DROP.buildWin / hop), b - Math.round(1 / hop), hop));
            cands.push({ t: t, beatIdx: bi, score: 1.0 * step + 25 * bassJump + 4 * sustain + 0.5 * build,
                step: step, bassJump: bassJump, sustain: sustain, build: build });
        }
        cands.sort(function(a, b2) { return b2.score - a.score; });
        var keep = [];
        for (var c = 0; c < cands.length && keep.length < DROP.keep; c++) {
            var clash = false;
            for (var k = 0; k < keep.length; k++) if (Math.abs(keep[k].t - cands[c].t) < DROP.nmsBars * barDur) { clash = true; break; }
            if (!clash) keep.push(cands[c]);
        }
        return keep;
    }

    /* ── sections: bar-energy steps, boundaries forced at drops ─────── */
    function detectSections(raw, downbeats, drops, barDur) {
        var E = raw.energyDb, hop = raw.hopSec;
        if (downbeats.length < 3) return [];
        var bars = [];
        for (var i = 0; i < downbeats.length - 1; i++) bars.push(mean(E, downbeats[i] / hop, downbeats[i + 1] / hop));
        var bounds = [0];
        for (var b = 4; b < bars.length - 1; b++) {
            var prev4 = (bars[b - 4] + bars[b - 3] + bars[b - 2] + bars[b - 1]) / 4;
            if (Math.abs(bars[b] - prev4) > 3 && Math.abs(bars[b + 1] - prev4) > 3 &&
                b - bounds[bounds.length - 1] >= 2) bounds.push(b);
        }
        drops.forEach(function(d) {
            var idx = nearestIndex(downbeats, d.t);
            var dup = false;
            for (var x = 0; x < bounds.length; x++) if (Math.abs(bounds[x] - idx) <= 1) { dup = true; break; }
            if (!dup && idx < bars.length) bounds.push(idx);
        });
        bounds.sort(function(a, b2) { return a - b2; });
        var sections = [], maxLevel = -Infinity;
        for (var s = 0; s < bounds.length; s++) {
            var i0 = bounds[s], i1 = (s + 1 < bounds.length) ? bounds[s + 1] : bars.length;
            if (i1 <= i0) continue;
            var lvl = 0;
            for (var j = i0; j < i1; j++) lvl += bars[j];
            lvl /= (i1 - i0);
            if (lvl > maxLevel) maxLevel = lvl;
            sections.push({ start: downbeats[i0], end: downbeats[Math.min(i1, downbeats.length - 1)], level: lvl });
        }
        var firstDrop = drops.length ? drops[0].t : Infinity;
        sections.forEach(function(sec, si) {
            var atDrop = drops.some(function(d) { return Math.abs(sec.start - d.t) < barDur; });
            var next = sections[si + 1];
            var nextIsDrop = next && drops.some(function(d) { return Math.abs(next.start - d.t) < barDur; });
            if (atDrop && sec.level > maxLevel - 3) sec.label = 'drop';
            else if (nextIsDrop) sec.label = 'build';
            else if (si === 0 || sec.end <= firstDrop) sec.label = 'intro';
            else if (si === sections.length - 1) sec.label = 'outro';
            else if (sec.level < maxLevel - 4) sec.label = 'breakdown';
            else sec.label = 'body';
        });
        return sections;
    }

    /* ── grid resolution: phase + drops (drop re-anchors the phase) ─── */
    function processAnalysis(raw) {
        var barDur = medianInterval(raw.beats) * 4;
        var ph = pickDownbeatPhase(raw.beats, raw.lowbandAtBeats || []);
        var drops = detectDrops(raw, barDur);
        var phase = ph.phase, rephased = false;
        if (drops.length && drops[0].beatIdx % 4 !== phase) {
            phase = drops[0].beatIdx % 4;   // drops land on beat 1 — they win over the global vote
            rephased = true;
        }
        var downbeats = [];
        for (var i = phase; i < raw.beats.length; i += 4) downbeats.push(raw.beats[i]);
        var sections = detectSections(raw, downbeats, drops, barDur);
        var altBpm = null;
        if (raw.bpm < 90) altBpm = raw.bpm * 2;
        else if (raw.bpm > 160) altBpm = raw.bpm / 2;
        return { raw: raw, file: raw.file, duration: raw.duration, bpm: raw.bpm, altBpm: altBpm,
            barDur: barDur, beats: raw.beats, downbeats: downbeats, phase: phase,
            downbeatConfidence: ph.confidence, lowDownbeatConfidence: ph.confidence < 1.2,
            rephased: rephased, drops: drops, sections: sections };
    }

    /* ── section selection: best 60/90s window on the downbeat grid ───
       Each drop candidate gets its own bar grid phased so the drop IS a
       downbeat (the drop defines bar 1) — guarantees a Bar marker lands
       exactly on the drop and phrase math counts from it. */
    function gridForPhase(beats, phase) {
        var out = [];
        for (var i = phase; i < beats.length; i += 4) out.push(beats[i]);
        return out;
    }
    function selectSection(a, targetSec) {
        var E = a.raw.energyDb, hop = a.raw.hopSec, barDur = a.barDur;
        if (!a.beats.length || !a.drops.length || !barDur) return null;
        function candidateBars(tol) {
            var out = [];
            for (var nb = Math.max(4, Math.floor((targetSec - tol) / barDur)); nb <= Math.ceil((targetSec + tol) / barDur); nb++)
                if (Math.abs(nb * barDur - targetSec) <= tol) out.push(nb);
            return out;
        }
        var nbs = candidateBars(SEL.tolSec);
        if (!nbs.length) nbs = candidateBars(SEL.hardTolSec);
        if (!nbs.length) return null;
        var bE = function(t) { return Math.round(t / hop); };
        var maxDropScore = a.drops[0].score || 1;
        var results = [];
        // strictOffset pass: drop must land 10-42% into the cut (a real intro/build,
        // then most of the cut riding the drop). Falls back to soft-only if nothing fits.
        function collect(strictOffset) {
        a.drops.forEach(function(drop) {
            var phase = drop.beatIdx % 4;
            var D = gridForPhase(a.beats, phase);
            var dropIdx = nearestIndex(D, drop.t);
            for (var si = 0; si < dropIdx; si++) {
                for (var ni = 0; ni < nbs.length; ni++) {
                    var nb = nbs[ni], ei = si + nb;
                    if (ei >= D.length) continue;
                    var start = D[si], end = D[ei];
                    if (drop.t <= start + 0.5 || drop.t >= end - 4) continue;
                    if (strictOffset) {
                        var off = drop.t - start;
                        if (off < SEL.dropMinSec || off > SEL.dropFracMax * targetSec) continue;
                    }
                    var br = {};
                    var dropOffset = drop.t - start;
                    br.dropPos = -SEL.wDropPos * Math.abs(dropOffset - SEL.dropTargetSec) / targetSec;
                    var barsFromDrop = ei - dropIdx;
                    br.phrase = (barsFromDrop % 8 === 0) ? SEL.phrase8 : (barsFromDrop % 4 === 0) ? SEL.phrase4 : SEL.phraseOff;
                    br.resolve = (mean(E, bE(end), bE(end) + 8) < mean(E, bE(end) - 8, bE(end)) - 2) ? SEL.wResolve : 0;
                    br.crescendo = (slopePerSec(E, bE(end) - 16, bE(end), hop) > 1.5) ? SEL.wCrescendo : 0;
                    var stepUpAfter = mean(E, bE(end), bE(end) + 8) > mean(E, bE(end) - 8, bE(end)) + 2;
                    var dropSoonAfter = a.drops.some(function(d2) { return d2.t > end && d2.t < end + 4 * barDur; });
                    br.cliffhanger = (stepUpAfter || dropSoonAfter) ? SEL.wCliffhanger : 0;
                    br.headroom = (mean(E, bE(start), bE(start) + 16) < mean(E, bE(drop.t), bE(drop.t) + 16) - 4) ? SEL.wHeadroom : 0;
                    br.boundary = a.sections.some(function(sec) { return Math.abs(sec.start - start) < barDur; }) ? SEL.wBoundary : 0;
                    br.durAcc = SEL.wDurAcc * Math.abs(nb * barDur - targetSec) / SEL.tolSec;
                    br.dropStrength = SEL.wDropStrength * (drop.score / maxDropScore);
                    var score = 0;
                    for (var kk in br) score += br[kk];
                    results.push({ start: start, end: end, bars: nb, drop: drop.t, dropOffset: dropOffset,
                        barsFromDrop: barsFromDrop, score: score, breakdown: br, phase: phase });
                }
            }
        });
        }
        collect(true);
        if (!results.length) collect(false);
        if (!results.length) return null;
        results.sort(function(x, y) { return y.score - x.score; });
        var best = results[0];
        best.fadeStart = best.end - barDur;
        best.downbeats = gridForPhase(a.beats, best.phase);   // bar grid anchored on the chosen drop
        best.alternatives = [];
        for (var r = 1; r < results.length && best.alternatives.length < 5; r++) {
            var cand = results[r], distinct = Math.abs(cand.start - best.start) > barDur;
            for (var v = 0; v < best.alternatives.length && distinct; v++)
                if (Math.abs(best.alternatives[v].start - cand.start) <= barDur) distinct = false;
            if (distinct) best.alternatives.push({ start: cand.start, end: cand.end, bars: cand.bars,
                drop: cand.drop, dropOffset: cand.dropOffset, score: cand.score });
        }
        return best;
    }

    /* ── marker plan (times relative to section start) ──────────────── */
    /* Premiere marker colors via setColorByIndex:
       0 Green, 1 Red, 2 Purple, 3 Orange, 4 Yellow, 5 White, 6 Blue, 7 Cyan */
    function buildMarkerPlan(a, sel) {
        var plan = [], len = sel.end - sel.start;
        function rel(t) { return Math.min(len, Math.max(0, Math.round((t - sel.start) * 1000) / 1000)); }
        var barN = 0;
        (sel.downbeats || a.downbeats).forEach(function(t) {
            if (t < sel.start - 0.01 || t > sel.end - 0.01) return;
            barN++;
            plan.push({ t: rel(t), name: 'Bar ' + barN, color: 5 });
        });
        if (MARK_EVERY_BEAT) a.beats.forEach(function(t) {
            if (t > sel.start + 0.01 && t < sel.end - 0.01) plan.push({ t: rel(t), name: '', color: 7 });
        });
        a.sections.forEach(function(sec) {
            if (sec.label === 'drop') return;   // the red DROP marker already covers it
            if (sec.start > sel.start + 0.01 && sec.start < sel.end - 0.01)
                plan.push({ t: rel(sec.start), name: sec.label.toUpperCase(), color: 0 });
        });
        plan.push({ t: rel(sel.drop), name: 'DROP', comments: 'drop at ' + sel.drop.toFixed(2) + 's (track time)',
            end: Math.min(len, rel(sel.drop) + 2), color: 1 });
        plan.push({ t: rel(sel.fadeStart), name: 'FADE', comments: 'drag a Constant Power fade from here', color: 3 });
        plan.push({ t: len, name: 'END', comments: 'music settles here -- video outro must land on this', color: 2 });
        plan.sort(function(x, y) { return x.t - y.t; });
        return plan;
    }

    /* ── python subprocess + per-track cache ────────────────────────── */
    function firstExisting(paths) {
        var fs = require('fs');
        for (var i = 0; i < paths.length; i++) { try { if (fs.existsSync(paths[i])) return paths[i]; } catch (_) {} }
        return null;
    }
    function cacheKey(path) {
        try {
            var st = require('fs').statSync(path);
            return path + '|' + st.size + '|' + Math.round(st.mtimeMs) + '|' + CACHE_V;
        } catch (_) { return path; }
    }
    function loadMusicCache() {
        try { return JSON.parse(require('fs').readFileSync(CAL_DIR + '/musicCache.json', 'utf8')); }
        catch (_) { return {}; }
    }
    function saveMusicCache(cache) {
        try {
            var fs = require('fs');
            if (!fs.existsSync(CAL_DIR)) fs.mkdirSync(CAL_DIR, { recursive: true });
            fs.writeFileSync(CAL_DIR + '/musicCache.json', JSON.stringify(cache));
        } catch (_) {}
    }
    function analyzeTrack(filePath, cb) {
        var key = cacheKey(filePath);
        var cache = loadMusicCache();
        if (cache[key]) { cb(null, cache[key]); return; }
        var py = firstExisting(PYTHON_PATHS), script = firstExisting(PY_SCRIPT_PATHS);
        if (!py) { cb(new Error('python3 not found')); return; }
        if (!script) { cb(new Error('analyze_music.py not found')); return; }
        require('child_process').execFile(py, [script, filePath],
            { maxBuffer: 16 * 1024 * 1024, timeout: 180000 }, function(err, stdout) {
            var raw = null;
            try { raw = JSON.parse(stdout); } catch (_) {}
            if (raw && raw.error) { cb(new Error(raw.error)); return; }
            if (!raw) { cb(err || new Error('analyzer produced no output')); return; }
            cache = loadMusicCache();
            cache[key] = raw;
            saveMusicCache(cache);
            cb(null, raw);
        });
    }

    function saveLastMusic(filePath, a, sel, targetSec, seqName) {
        try {
            var fs = require('fs');
            if (!fs.existsSync(CAL_DIR)) fs.mkdirSync(CAL_DIR, { recursive: true });
            fs.writeFileSync(CAL_DIR + '/lastMusic.json', JSON.stringify({
                file: filePath, analyzedAt: Date.now(), bpm: a.bpm, altBpm: a.altBpm,
                barDur: a.barDur, targetSec: targetSec,
                section: { start: sel.start, end: sel.end, bars: sel.bars, drop: sel.drop,
                    dropOffset: sel.dropOffset, fadeStart: sel.fadeStart },
                beats: a.beats, downbeats: sel.downbeats || a.downbeats,
                drops: a.drops.map(function(d) { return { t: d.t, score: d.score }; }),
                sections: a.sections,
                lowDownbeatConfidence: a.lowDownbeatConfidence, rephased: a.rephased,
                energyDb: a.raw.energyDb, hopSec: a.raw.hopSec,
                sequenceName: seqName || ''
            }, null, 1));
        } catch (_) {}
    }

    /* ── offline HTML report (Desire Media dark theme) ──────────────── */
    function renderReportHtml(a, sel, targetSec, previews) {
        var W = 1240, H = 240, dur = a.duration;
        function X(t) { return (t / dur * W).toFixed(1); }
        var E = a.raw.energyDb, hop = a.raw.hopSec;
        var eMin = Infinity, eMax = -Infinity;
        E.forEach(function(v) { if (v < eMin) eMin = v; if (v > eMax) eMax = v; });
        eMin = Math.max(eMin, eMax - 42);
        function Y(v) { return (H - 18 - Math.max(0, Math.min(1, (v - eMin) / (eMax - eMin))) * (H - 36)).toFixed(1); }
        var pts = [];
        for (var i = 0; i < E.length; i++) pts.push(X(i * hop) + ',' + Y(E[i]));
        var svg = '<svg viewBox="0 0 ' + W + ' ' + (H + 60) + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;background:#0E0E0E">';
        if (sel) svg += '<rect x="' + X(sel.start) + '" y="0" width="' + (sel.end - sel.start) / dur * W + '" height="' + H + '" fill="rgba(255,255,255,0.10)"/>';
        (sel && sel.alternatives ? sel.alternatives : []).forEach(function(alt) {
            svg += '<rect x="' + X(alt.start) + '" y="0" width="' + (alt.end - alt.start) / dur * W + '" height="' + H + '" fill="rgba(255,255,255,0.035)"/>';
        });
        a.sections.forEach(function(sec) {
            svg += '<line x1="' + X(sec.start) + '" y1="0" x2="' + X(sec.start) + '" y2="' + H + '" stroke="rgba(255,255,255,0.25)" stroke-width="0.5"/>' +
                '<text x="' + (parseFloat(X(sec.start)) + 3) + '" y="12" fill="rgba(255,255,255,0.55)" font-size="9" letter-spacing="0.18em">' + sec.label.toUpperCase() + '</text>';
        });
        svg += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="rgba(255,255,255,0.86)" stroke-width="1"/>';
        a.beats.forEach(function(t) { svg += '<line x1="' + X(t) + '" y1="' + (H + 4) + '" x2="' + X(t) + '" y2="' + (H + 10) + '" stroke="rgba(255,255,255,0.3)" stroke-width="0.5"/>'; });
        ((sel && sel.downbeats) || a.downbeats).forEach(function(t) { svg += '<line x1="' + X(t) + '" y1="' + (H + 4) + '" x2="' + X(t) + '" y2="' + (H + 18) + '" stroke="rgba(255,255,255,0.8)" stroke-width="1"/>'; });
        a.drops.forEach(function(d, di) {
            svg += '<line x1="' + X(d.t) + '" y1="0" x2="' + X(d.t) + '" y2="' + (H + 18) + '" stroke="#FF3B30" stroke-width="' + (di === 0 ? 2 : 1) + '"/>' +
                '<text x="' + (parseFloat(X(d.t)) + 3) + '" y="' + (H - 6) + '" fill="#FF3B30" font-size="10" letter-spacing="0.18em">DROP ' + d.t.toFixed(1) + 's</text>';
        });
        if (sel) {
            svg += '<line x1="' + X(sel.fadeStart) + '" y1="0" x2="' + X(sel.fadeStart) + '" y2="' + H + '" stroke="#FF9500" stroke-width="1"/>';
            svg += '<line x1="' + X(sel.end) + '" y1="0" x2="' + X(sel.end) + '" y2="' + H + '" stroke="rgba(255,255,255,0.9)" stroke-width="1.5" stroke-dasharray="4 3"/>';
        }
        // time axis every 20s
        for (var t20 = 0; t20 < dur; t20 += 20)
            svg += '<text x="' + X(t20) + '" y="' + (H + 34) + '" fill="rgba(255,255,255,0.55)" font-size="9">' + t20 + 's</text>';
        svg += '</svg>';

        function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
        var base = a.file.split('/').pop();
        var flags = [];
        if (a.lowDownbeatConfidence) flags.push('LOW DOWNBEAT CONFIDENCE (' + a.downbeatConfidence.toFixed(2) + ')');
        if (a.rephased) flags.push('GRID RE-PHASED FROM DROP');
        if (a.altBpm) flags.push('ALT TEMPO READING: ' + a.altBpm.toFixed(1) + ' BPM (half/double-time check)');
        var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(base) + '</title>' +
            '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">' +
            '<style>body{background:#000;color:rgba(255,255,255,0.86);font-family:Inter,system-ui,sans-serif;font-size:14px;margin:0;padding:48px}' +
            'h1{font-weight:700;font-size:16px;text-transform:uppercase;letter-spacing:0.18em;margin:0 0 24px}' +
            '.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:rgba(255,255,255,0.55);margin:32px 0 8px}' +
            'table{border-collapse:collapse;width:100%;max-width:900px}td,th{border-bottom:0.5px solid rgba(255,255,255,0.18);padding:6px 12px 6px 0;text-align:left;font-size:13px}' +
            'th{font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:rgba(255,255,255,0.55)}' +
            '.flag{color:#FF9500}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}audio{width:420px;margin:4px 0}</style></head><body>' +
            '<h1>' + esc(base) + '</h1>' +
            '<div class="mono">' + a.bpm.toFixed(2) + ' BPM / ' + a.duration.toFixed(1) + 's / bar ' + a.barDur.toFixed(3) + 's / phase ' + a.phase +
            (sel ? ' / cut ' + sel.start.toFixed(2) + ' -- ' + sel.end.toFixed(2) + 's (' + sel.bars + ' bars, target ' + targetSec + 's)' : ' / NO SECTION FOUND') + '</div>' +
            (flags.length ? '<div class="eyebrow flag">' + flags.join(' / ') + '</div>' : '') +
            '<div class="eyebrow">Energy / beat grid / drops / chosen cut (shaded)</div>' + svg;
        if (previews && previews.cut) html += '<div class="eyebrow">Listen: chosen cut</div><audio controls src="' + esc(previews.cut) + '"></audio>' +
            '<div class="eyebrow">Listen: last 2 bars (phrase resolution check)</div><audio controls src="' + esc(previews.tail) + '"></audio>';
        if (sel) {
            html += '<div class="eyebrow">Score breakdown</div><table><tr><th>Term</th><th>Value</th></tr>';
            Object.keys(sel.breakdown).forEach(function(k) { html += '<tr><td>' + k + '</td><td class="mono">' + sel.breakdown[k].toFixed(3) + '</td></tr>'; });
            html += '<tr><td><b>TOTAL</b></td><td class="mono"><b>' + sel.score.toFixed(3) + '</b></td></tr></table>';
            html += '<div class="eyebrow">Drop candidates</div><table><tr><th>t</th><th>score</th><th>step dB</th><th>bass jump</th><th>sustain</th></tr>';
            a.drops.forEach(function(d) { html += '<tr><td class="mono">' + d.t.toFixed(2) + 's</td><td class="mono">' + d.score.toFixed(2) + '</td><td class="mono">' + d.step.toFixed(2) + '</td><td class="mono">' + d.bassJump.toFixed(3) + '</td><td class="mono">' + d.sustain.toFixed(2) + '</td></tr>'; });
            html += '</table>';
            if (sel.alternatives && sel.alternatives.length) {
                html += '<div class="eyebrow">Alternatives</div><table><tr><th>start</th><th>end</th><th>bars</th><th>drop offset</th><th>score</th></tr>';
                sel.alternatives.forEach(function(alt) { html += '<tr><td class="mono">' + alt.start.toFixed(2) + '</td><td class="mono">' + alt.end.toFixed(2) + '</td><td class="mono">' + alt.bars + '</td><td class="mono">' + alt.dropOffset.toFixed(1) + 's</td><td class="mono">' + alt.score.toFixed(3) + '</td></tr>'; });
                html += '</table>';
            }
        }
        html += '</body></html>';
        return html;
    }

    /* ── Node CLI: offline validation on real tracks ────────────────── */
    function runCli() {
        var fs = require('fs'), pathMod = require('path');
        var args = process.argv.slice(2);
        var cmd = args[0];
        var dur = 90, di = args.indexOf('--dur');
        if (di > -1) dur = parseInt(args[di + 1], 10) || 90;
        var reportDir = CAL_DIR + '/musicReports';
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

        function makePreviews(a, sel, base, done) {
            var ff = firstExisting(FFMPEG_PATHS);
            if (!ff || !sel) { done(null); return; }
            var cutFile = reportDir + '/' + base + '.cut.m4a';
            var tailFile = reportDir + '/' + base + '.tail.m4a';
            var cp = require('child_process');
            cp.execFile(ff, ['-y', '-ss', String(sel.start), '-i', a.file, '-t', String(sel.end - sel.start),
                '-c:a', 'aac', '-b:a', '128k', cutFile], { timeout: 60000 }, function(e1) {
                var tailStart = sel.end - 2 * a.barDur;
                cp.execFile(ff, ['-y', '-ss', String(tailStart), '-i', a.file, '-t', String(2 * a.barDur + 1),
                    '-c:a', 'aac', '-b:a', '128k', tailFile], { timeout: 60000 }, function(e2) {
                    done((e1 || e2) ? null : { cut: pathMod.basename(cutFile), tail: pathMod.basename(tailFile) });
                });
            });
        }

        function one(file, done) {
            analyzeTrack(file, function(err, raw) {
                if (err) { console.log('FAIL  ' + pathMod.basename(file) + '  ' + err.message); done(); return; }
                var a = processAnalysis(raw);
                var sel = selectSection(a, dur);
                var base = pathMod.basename(file).replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '_');
                fs.writeFileSync(reportDir + '/' + base + '.json', JSON.stringify({
                    file: file, bpm: a.bpm, altBpm: a.altBpm, barDur: a.barDur, phase: a.phase,
                    downbeatConfidence: a.downbeatConfidence, rephased: a.rephased,
                    drops: a.drops, sections: a.sections, selection: sel, targetSec: dur
                }, null, 1));
                makePreviews(a, sel, base, function(previews) {
                    fs.writeFileSync(reportDir + '/' + base + '.html', renderReportHtml(a, sel, dur, previews));
                    var line = pathMod.basename(file).slice(0, 44);
                    while (line.length < 46) line += ' ';
                    console.log(line + '  bpm=' + a.bpm.toFixed(1) + (a.altBpm ? '(' + a.altBpm.toFixed(0) + '?)' : '') +
                        '  drop=' + (sel ? sel.drop.toFixed(1) + 's@' + Math.round(100 * sel.dropOffset / (sel.end - sel.start)) + '%' :
                            (a.drops[0] ? a.drops[0].t.toFixed(1) + 's' : '--')) +
                        (sel ? '  cut=' + sel.start.toFixed(1) + '-' + sel.end.toFixed(1) + 's (' + sel.bars + ' bars, ' +
                            (sel.barsFromDrop % 8 === 0 ? '8-bar end' : sel.barsFromDrop % 4 === 0 ? '4-bar end' : 'OFF-PHRASE') + ')'
                            : '  NO SECTION') +
                        (a.lowDownbeatConfidence ? '  [low-db-conf]' : '') + (a.rephased ? '  [rephased]' : ''));
                    done();
                });
            });
        }

        if (cmd === 'analyze' && args[1]) {
            one(args[1], function() { console.log('Report dir: ' + reportDir); });
        } else if (cmd === 'analyze-folder' && args[1]) {
            var files = fs.readdirSync(args[1]).filter(function(f) { return /\.(mp3|wav|m4a|aiff?|aac|flac)$/i.test(f); })
                .map(function(f) { return pathMod.join(args[1], f); });
            if (!files.length) { console.log('No audio files in ' + args[1]); return; }
            var qi = 0;
            (function next() {
                if (qi >= files.length) { console.log('\nReport dir: ' + reportDir); return; }
                one(files[qi++], next);
            })();
        } else {
            console.log('Usage:\n  node js/musicAnalysis.js analyze <file> [--dur 90]\n  node js/musicAnalysis.js analyze-folder <dir> [--dur 90]');
        }
    }

    if (IS_NODE) {
        module.exports = { pickDownbeatPhase: pickDownbeatPhase, detectDrops: detectDrops,
            detectSections: detectSections, processAnalysis: processAnalysis,
            selectSection: selectSection, buildMarkerPlan: buildMarkerPlan,
            analyzeTrack: analyzeTrack, renderReportHtml: renderReportHtml,
            SEL: SEL, DROP: DROP, CAL_DIR: CAL_DIR };
        if (require.main === module) runCli();
        return;
    }

    /* ── Panel wiring (CEP only from here down) ─────────────────────── */
    var pyOk = null;
    function probePython(cb) {
        if (pyOk === true) { cb(null); return; }
        var py = firstExisting(PYTHON_PATHS);
        if (!py) { cb(new Error('python3 not found')); return; }
        require('child_process').execFile(py, ['-c', 'import librosa'], { timeout: 30000 }, function(err) {
            pyOk = !err;
            cb(err ? new Error('librosa missing') : null);
        });
    }

    function jsxImportMusic(filePath, cb) {
        var jsx = '(function(){' +
            'var p=' + JSON.stringify(JSON.stringify(filePath)) + ';p=JSON.parse(p);' +
            'var found=null;' +
            'function walk(bin){for(var i=0;i<bin.children.numItems;i++){var it=bin.children[i];' +
            'if(it.type===ProjectItemType.BIN){walk(it);if(found)return;}' +
            'else{try{if(it.getMediaPath()===p){found=it;return;}}catch(e){}}}}' +
            'walk(app.project.rootItem);' +
            'if(!found){' +
            'var mbin=null;' +
            'for(var k=0;k<app.project.rootItem.children.numItems;k++){var b=app.project.rootItem.children[k];' +
            'if(b.type===ProjectItemType.BIN&&b.name.toUpperCase().indexOf("04 MUSIC")===0){mbin=b;break;}}' +
            'if(!mbin){try{mbin=app.project.rootItem.createBin("04 MUSIC");}catch(eb){mbin=app.project.rootItem;}}' +
            'try{app.project.importFiles([p],1,mbin,0);}catch(ei){return JSON.stringify({error:"import: "+ei});}' +
            'walk(app.project.rootItem);}' +
            'if(!found)return JSON.stringify({error:"music item not found after import"});' +
            'return JSON.stringify({ok:1,id:found.nodeId,name:found.name});}())';
        evalScript(jsx, function(res) {
            var r;
            try { r = JSON.parse(res); } catch (_) { r = { error: 'import parse failed: ' + res }; }
            cb(r.error ? new Error(r.error) : null, r);
        });
    }

    function jsxBuildMusicSequence(nodeId, seqName, sel, markers, cb) {
        var payload = { id: nodeId, name: seqName, inSec: sel.start, outSec: sel.end, markers: markers };
        var jsx = '(function(){' +
            'var d=' + JSON.stringify(JSON.stringify(payload)) + ';d=JSON.parse(d);' +
            'var item=null;' +
            'function walk(bin){for(var i=0;i<bin.children.numItems;i++){var it=bin.children[i];' +
            'if(it.type===ProjectItemType.BIN){walk(it);if(item)return;}' +
            'else if(it.nodeId===d.id){item=it;return;}}}' +
            'walk(app.project.rootItem);' +
            'if(!item)return JSON.stringify({error:"music item not found"});' +
            'try{item.setInPoint(d.inSec,4);item.setOutPoint(d.outSec,4);}catch(ep){}' +
            'var seq=null;' +
            'try{seq=app.project.createNewSequenceFromClips(d.name,[item]);}catch(e){}' +
            'if(!seq){try{app.project.createNewSequence(d.name,"dm-music-"+(new Date().getTime()));seq=app.project.activeSequence;}catch(e2){}}' +
            'if(!seq)return JSON.stringify({error:"sequence creation failed"});' +
            // strip whatever createNewSequenceFromClips placed, then re-place trimmed audio at 0
            'try{for(var vt=0;vt<seq.videoTracks.numTracks;vt++){var vTr=seq.videoTracks[vt];' +
            'for(var vc=vTr.clips.numItems-1;vc>=0;vc--){try{vTr.clips[vc].remove(false,false);}catch(ev){}}}}catch(ev2){}' +
            'try{for(var at=0;at<seq.audioTracks.numTracks;at++){var aTr=seq.audioTracks[at];' +
            'for(var ac=aTr.clips.numItems-1;ac>=0;ac--){try{aTr.clips[ac].remove(false,false);}catch(ea){}}}}catch(ea2){}' +
            'var placed=0;' +
            'try{seq.audioTracks[0].overwriteClip(item,0);placed=1;}catch(eo){return JSON.stringify({error:"overwriteClip: "+eo});}' +
            'try{item.clearInPoint(4);item.clearOutPoint(4);}catch(ecl){}' +
            'var nm=0;' +
            'for(var m=0;m<d.markers.length;m++){var mk=d.markers[m];' +
            'try{var mo=seq.markers.createMarker(mk.t);' +
            'try{mo.name=mk.name;}catch(en){}' +
            'if(mk.comments)try{mo.comments=mk.comments;}catch(ec){}' +
            'if(mk.end)try{mo.end=mk.end;}catch(ee){}' +
            'if(typeof mo.setColorByIndex==="function")try{mo.setColorByIndex(mk.color);}catch(eci){}' +
            'nm++;}catch(em){}}' +
            'return JSON.stringify({ok:1,markers:nm});}())';
        evalScript(jsx, function(res) {
            var r;
            try { r = JSON.parse(res); } catch (_) { r = { error: 'build parse failed: ' + res }; }
            cb(r.error ? new Error(r.error) : null, r);
        });
    }

    var musicBtn = document.getElementById('prAnalyzeMusic');
    if (musicBtn) musicBtn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { setStatus('Analyze Music only works in Premiere', 'error'); return; }
        var res;
        try {
            res = window.cep.fs.showOpenDialogEx(false, false, 'Choose music track', MUSIC_DIR,
                ['mp3', 'wav', 'm4a', 'aiff', 'aac', 'flac']);
        } catch (e) { setStatus('File dialog failed: ' + e, 'error'); return; }
        if (!res || !res.data || !res.data.length) return;
        var file = res.data[0];
        var durSel = document.getElementById('dmMusicDur');
        var target = durSel ? parseInt(durSel.value, 10) : 90;
        musicBtn.disabled = true;
        setStatus('Checking analyzer...', 'busy');
        probePython(function(perr) {
            if (perr) {
                setStatus('Python/librosa missing -- run: pip3 install librosa', 'error');
                musicBtn.disabled = false;
                return;
            }
            setStatus('Analyzing beat grid...', 'busy');
            analyzeTrack(file, function(err, raw) {
                if (err) { setStatus('Music analysis failed: ' + err.message, 'error'); musicBtn.disabled = false; return; }
                var a = processAnalysis(raw);
                var sel = selectSection(a, target);
                if (!sel) { setStatus('No usable ' + target + 's section found in this track', 'error'); musicBtn.disabled = false; return; }
                var seqName = 'Music ' + target + 's - ' + file.split('/').pop().replace(/\.[^.]+$/, '');
                saveLastMusic(file, a, sel, target, seqName);
                var markers = buildMarkerPlan(a, sel);
                setStatus('Importing music into project...', 'busy');
                jsxImportMusic(file, function(ierr, info) {
                    if (ierr) { setStatus(ierr.message, 'error'); musicBtn.disabled = false; return; }
                    setStatus('Building music sequence...', 'busy');
                    jsxBuildMusicSequence(info.id, seqName, sel, markers, function(berr, br) {
                        musicBtn.disabled = false;
                        if (berr) { setStatus(berr.message, 'error'); return; }
                        var warn = a.lowDownbeatConfidence ? ' (check bar markers by ear)' : '';
                        setStatus('Music cut ready: ' + sel.bars + ' bars, drop at ' + Math.round(sel.dropOffset) + 's ✓' + warn, 'success');
                    });
                });
            });
        });
    });
})();
