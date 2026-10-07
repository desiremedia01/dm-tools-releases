/* ── Auto Assembly — Phase 4 of the auto-assembly roadmap ───────────────
   Marries the Cut Grid (calibration/lastCutGrid.json) with the staging
   segments (lastPlan.json + visionCache for room cats) and builds the real
   timeline: clips on the V-track staircase, dry cuts trimmed to their slot,
   ramped clips with the FULL usable part (leftover tail — the AE remap
   consumes it), music on A1, slot markers for review.
   The matcher is pure and Node-testable; validate the assignment offline
   (CLI `plan`) against a real shoot BEFORE any Premiere run.
   CLI:  node js/autoAssembly.js plan                                       */
(function() {
    var IS_NODE = (typeof document === 'undefined');

    var CAL_DIR = '/Users/desiremedia/Documents/DM_Tools_CEP/calibration';
    var HERO_CATS = ['living', 'kitchen', 'pool_bbq', 'master_bedroom', 'dining'];
    /* Intro teasers show the OUTSIDE of the house only (recipe) */
    var EXTERIOR_CATS = { facade: 1, pool_bbq: 1, drone_aerial: 1 };
    /* Ramp physics: the lower clip must keep enough source under the upper
       clip for the remap to work, and the ramped clip itself needs headroom */
    var MIN_RAMP_TAIL = 2.0;    // s of source left on the lower clip past the ramp anchor
    var MIN_RAMP_HEAD = 1.0;    // s of source beyond the visible span on the ramped clip

    /* ── staging entries (lastPlan + visionCache cat recovery) ──────── */
    function stagingEntries() {
        var fs = require('fs');
        var plan = JSON.parse(fs.readFileSync(CAL_DIR + '/lastPlan.json', 'utf8'));
        var byPath = {};
        try {
            var vc = JSON.parse(fs.readFileSync(CAL_DIR + '/visionCache.json', 'utf8'));
            Object.keys(vc).forEach(function(k) { byPath[k.split('|')[0]] = vc[k]; });
        } catch (_) {}
        return (plan.entries || []).map(function(e, i) {
            var cat = e.cat || (byPath[e.path] && byPath[e.path].cat) || 'other';
            return { idx: i, path: e.path, name: e.name, shot: e.shot, cat: cat,
                start: e.start, end: e.end, dur: e.end - e.start };
        });
    }

    /* ── motion typing (push vs orbit/curving) from the 10Hz run series ─
       div NEGATIVE = push-in / walking forward; |mx| dominant = lateral
       (orbit/curving). Ramps only pair like with like (recipe hard rule). */
    /* ── v4 take analysis — validated frame by frame against Matheus's
       verdicts on two shoots (18 York/Calvin + Birchwood/Matheus, 10/Jul):
       wides 5/5 window matches, tights rules fixed on his corrections.
       Model of a take: settle → accelerate → CRUISE → decelerate/adjust.
       The usable part is the cruise. Adjustment tells: jerk, whip, pull
       (div>0.12), against-dominant motion, and motion bursts that die into
       stillness (repositioning). Cruise trimmed at 30% of p70 speed, plus
       a 35° direction-core prune (take endings drift direction). */
    var V4 = { JERK: 1.2, WHIP: 5, PULL: 0.12, STILL: 0.08, BURST_STILL_SEC: 1.0,
        GAP_MERGE_SEC: 0.5, EDGE0_SEC: 1.0, EDGE1_SEC: 0.5, MARGIN_SEC: 0.6,
        TAIL_MARGIN_SEC: 0.4,   // adjustment residue bleeds AFTER the move (2:1 vs head, measured)
        CRUISE_FRac: 0.3, CRUISE_WIN_SEC: 0.3, DIR_DEV_DEG: 35,
        HOLD_MAG: 0.08, HOLD_RUN_SEC: 2.5, TIGHT_MX: 0.15 };

    /* Matheus's chat rejections — vetoed windows are treated as adjustment,
       vetoed clips never enter the pool. calibration/vetoes.json */
    var _vetoes = null;
    function vetoes() {
        if (_vetoes) return _vetoes;
        _vetoes = { win: {}, clip: {} };
        try {
            JSON.parse(require('fs').readFileSync(CAL_DIR + '/vetoes.json', 'utf8')).vetoes.forEach(function(v) {
                if (v.type === 'clip') _vetoes.clip[v.name] = v.reason || 1;
                else (_vetoes.win[v.name] = _vetoes.win[v.name] || []).push([v.t0, v.t1]);
            });
        } catch (_) {}
        return _vetoes;
    }

    function adjFlags(r) {
        var fps = r.fps, n = r.mx.length;
        var domSum = 0;
        for (var d = 0; d < n; d++) if (Math.abs(r.mx[d]) > 0.02) domSum += r.mx[d];
        var dom = domSum > 0 ? 1 : -1;
        var adj = new Array(n);
        for (var i = 0; i < n; i++) {
            var mx = r.mx[i], mag = r.mag[i], div = r.div[i];
            var jerk = Math.abs(mx - (i ? r.mx[i - 1] : mx)) * 10;
            var contra = Math.abs(mx) > 0.02 && (mx > 0 ? 1 : -1) !== dom;
            adj[i] = (jerk > V4.JERK || mag > V4.WHIP || div > V4.PULL || contra) ? 1 : 0;
        }
        // a motion burst that dies into stillness is the operator repositioning
        var i2 = 0;
        while (i2 < n) {
            if (r.mag[i2] > V4.STILL) {
                var j = i2;
                while (j < n && r.mag[j] > V4.STILL) j++;
                var k = j;
                while (k < n && r.mag[k] <= V4.STILL) k++;
                if (j < n && (k - j) >= Math.round(V4.BURST_STILL_SEC * fps))
                    for (var q = i2; q < j; q++) adj[q] = 1;
                i2 = j;
            } else i2++;
        }
        // his explicit rejections: vetoed windows read as adjustment — and
        // marked 2 so gates apply ZERO tolerance (no 15% slack for vetoes)
        var vname = (r.path || '').split('/').pop();
        (vetoes().win[vname] || []).forEach(function(w) {
            var a2 = Math.max(0, Math.floor(w[0] * fps)), b2 = Math.min(n, Math.ceil(w[1] * fps));
            for (var q2 = a2; q2 < b2; q2++) adj[q2] = 2;
        });
        // merge sub-0.5s clean holes inside adjustment stretches
        var i3 = 0;
        while (i3 < n) {
            if (adj[i3] === 1) {
                var j3 = i3;
                while (j3 < n && adj[j3] === 1) j3++;
                if ((j3 - i3) <= Math.round(V4.GAP_MERGE_SEC * fps) && i3 > 0 && j3 < n)
                    for (var q3 = i3; q3 < j3; q3++) adj[q3] = 0;
                i3 = j3;
            } else i3++;
        }
        return adj;
    }

    /* longest clean run trimmed to its cruise — the wide's usable part */
    function usableSpan(r) {
        var fps = r.fps, n = r.mx.length;
        var adj = adjFlags(r);
        var E0 = Math.round(V4.EDGE0_SEC * fps), E1 = Math.round(V4.EDGE1_SEC * fps),
            MG = Math.round(V4.MARGIN_SEC * fps), TM = Math.round(V4.TAIL_MARGIN_SEC * fps);
        var best = null, i = 0;
        while (i < n) {
            if (adj[i] === 0) {
                var j = i;
                while (j < n && adj[j] === 0) j++;
                var i0 = Math.max(i + (i > 0 ? MG : 0), E0), j0 = Math.min(j, n - E1);
                if (j0 > i0 && (!best || (j0 - i0) > (best[1] - best[0]))) best = [i0, j0];
                i = j;
            } else i++;
        }
        if (!best) return null;
        var a = best[0], b = best[1];
        var seg = [];
        for (var k = a; k < b; k++) seg.push(r.mag[k]);
        seg.sort(function(x, y) { return x - y; });
        var p70 = seg[Math.floor(seg.length * 0.7)] || 0;
        if (p70 > 0.12) {
            var thr = V4.CRUISE_FRac * p70, W3 = Math.round(V4.CRUISE_WIN_SEC * fps);
            function frac(from, to) {
                var c = 0;
                for (var k2 = from; k2 < to; k2++) if (r.mag[k2] >= thr) c++;
                return c / (to - from);
            }
            while (a < b - W3 && frac(a, a + W3) < 0.7) a++;
            while (b > a + W3 && frac(b - W3, b) < 0.7) b--;
            // direction-core prune: take endings rotate away from the move
            var core = [];
            for (var k3 = a; k3 < b; k3++) if (r.mag[k3] > 0.3) core.push(k3);
            if (core.length >= fps) {
                var mid = core.slice(Math.floor(core.length / 4), Math.floor(3 * core.length / 4));
                if (!mid.length) mid = core;
                var sx = 0, sy = 0;
                mid.forEach(function(k4) {
                    var ang = Math.atan2(r.my[k4], r.mx[k4]);
                    sx += Math.cos(ang); sy += Math.sin(ang);
                });
                var ca = Math.atan2(sy, sx);
                function dev(k5) {
                    if (r.mag[k5] <= 0.3) return 0;
                    var d2 = Math.atan2(r.my[k5], r.mx[k5]) - ca;
                    d2 = Math.abs(((d2 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
                    return d2 * 180 / Math.PI;
                }
                while (b > a + W3 && dev(b - 1) > V4.DIR_DEV_DEG) b--;
                while (a < b - W3 && dev(a) > V4.DIR_DEV_DEG) a++;
            }
        }
        return { start: a / fps, end: b / fps };
    }

    /* tight 1s-window pick: true hold (frozen inside a long still run) OR
       sustained real lateral; anything else is the operator fiddling */
    function tightWindow(r, winSec) {
        var fps = r.fps, n = r.mx.length;
        var adj = adjFlags(r);
        var W = Math.max(1, Math.round(winSec * fps)), G = Math.round(0.4 * fps);
        var E0 = Math.round(V4.EDGE0_SEC * fps), E1 = Math.round(V4.EDGE1_SEC * fps),
            MG = Math.round(V4.MARGIN_SEC * fps);
        if (W >= n) return null;
        // "parado não se usa, nunca" (Matheus 10/jul) — holds abolished;
        // every tight window must show real, sustained movement
        function holdOk(j) { return false; }
        function movingOk(j) {
            var sum = 0;
            for (var k = j; k < j + W; k++) sum += Math.abs(r.mx[k]);
            var m = sum / W;
            if (m < V4.TIGHT_MX) return false;
            var v0 = (Math.abs(r.mx[j]) + Math.abs(r.mx[j + 1]) + Math.abs(r.mx[j + 2])) / 3;
            var v1 = (Math.abs(r.mx[j + W - 1]) + Math.abs(r.mx[j + W - 2]) + Math.abs(r.mx[j + W - 3])) / 3;
            return Math.min(v0, v1) / Math.max(v0, v1, 0.01) >= 0.5;
        }
        function gateOk(j, edge) {
            if (edge && (j < E0 || j + W > n - E1)) return false;
            for (var k = Math.max(0, j - MG); k < j + G; k++) if (adj[k]) return false;
            var bad = 0;
            for (var k2 = j; k2 < j + W; k2++) {
                if (adj[k2] === 2) return false;    // vetoed frame: zero tolerance
                bad += adj[k2] ? 1 : 0;
            }
            // the LAID span (2x shown at 50%) must not touch a veto either
            for (var k3 = j + W; k3 < Math.min(n, j + 2 * W); k3++) if (adj[k3] === 2) return false;
            return bad / W <= 0.15;
        }
        var cands = [];
        for (var pass = 0; pass < 2 && !cands.length; pass++)
            for (var j = 0; j + W <= n; j++)
                if (gateOk(j, pass === 0) && (holdOk(j) || movingOk(j))) cands.push(j);
        if (!cands.length) return null;
        var best = cands[0], bestS = -1e9;
        cands.forEach(function(j2) {
            var s = 0;
            for (var k = j2; k < j2 + W; k++)
                s += 1.9 * Math.min(Math.abs(r.mx[k]), 1) - 1.534 * Math.abs(r.mx[k] - (k ? r.mx[k - 1] : r.mx[k])) * 10
                    - 1.611 * Math.abs(r.my[k]) + 0.111 * Math.max(0, -r.div[k]);
            if (s > bestS) { bestS = s; best = j2; }
        });
        return { start: best / fps };
    }

    /* movement family for ramp pairing: push vs lateral (pan/orbit/curving) */
    function movementFamily(r, t0, t1) {
        var fps = r.fps;
        var i0 = Math.round(t0 * fps), i1 = Math.max(i0 + 1, Math.round(t1 * fps));
        i1 = Math.min(i1, r.mx.length);
        var net = 0, divm = 0, nn = i1 - i0;
        for (var i = i0; i < i1; i++) { net += r.mx[i]; divm += r.div[i]; }
        net /= nn; divm /= nn;
        var ps = Math.max(0, -divm) / 0.03, ls = Math.abs(net) / 0.05;
        if (ps >= ls && ps > 0.3) return 'push';
        if (ls > 0.3) return 'lateral';
        return 'hold';
    }

    /* ── clip grammar: how every shot type behaves in his 84 delivered
       videos (calibration/clipGrammar.json — room|scale|position cells with
       movement-family shares and magnitude bands). Candidates matching the
       corpus signature for the slot's context score higher. */
    var _grammar = null;
    function grammar() {
        if (_grammar !== null) return _grammar;
        try { _grammar = JSON.parse(require('fs').readFileSync(CAL_DIR + '/clipGrammar.json', 'utf8')).atlas; }
        catch (_) { _grammar = false; }
        return _grammar;
    }
    function spanMagOf(x) {
        var r2 = runsMap()[x.path];
        if (!r2 || !r2.mag) return null;
        var f3 = r2.fps || 10, s3 = 0, n3 = 0;
        for (var k3 = Math.round(x.start * f3); k3 < Math.min(r2.mag.length, Math.round(x.end * f3)); k3++) { s3 += r2.mag[k3]; n3++; }
        return n3 ? s3 / n3 : null;
    }

    var _runsMap = null;
    function runsMap() {
        if (_runsMap) return _runsMap;
        _runsMap = {};
        try {
            var fs = require('fs');
            var plan = JSON.parse(fs.readFileSync(CAL_DIR + '/lastPlan.json', 'utf8'));
            var run = JSON.parse(fs.readFileSync(CAL_DIR + '/runs/' + plan.runId + '.json', 'utf8'));
            run.forEach(function(r) { _runsMap[r.path] = r; });
        } catch (_) {}
        return _runsMap;
    }
    function motionTypes() {
        var byPath = runsMap();
        return function(entry) {
            var r = byPath[entry.path];
            if (!r || !r.div || !r.mx) return 'mixed';
            var i0 = Math.max(0, Math.floor(entry.start * r.fps));
            var i1 = Math.min(r.div.length, Math.ceil(entry.end * r.fps));
            if (i1 <= i0) return 'mixed';
            var sDiv = 0, sMx = 0, n = i1 - i0;
            for (var i = i0; i < i1; i++) { sDiv += r.div[i]; sMx += Math.abs(r.mx[i]); }
            var meanDiv = sDiv / n, meanMx = sMx / n;
            var pushScore = Math.max(0, -meanDiv) / 0.03;   // divPush scale
            var latScore = meanMx / 0.05;                    // mxFloor scale
            if (pushScore < 0.5 && latScore < 0.5) return 'mixed';
            return pushScore >= latScore ? 'push' : 'lateral';
        };
    }
    /* the maximal veto-free interval around [lo,hi] for this clip — EVERY
       srcIn/srcOut mutation (stretch, shift, raw tail) must stay inside it.
       Zero tolerance: his rejections never reach the timeline, not even by
       a pass that "just covers a hole". */
    function vetoFree(name, lo, hi) {
        var ws = vetoes().win[name] || [];
        var out = { lo: 0, hi: Infinity };
        ws.forEach(function(w) {
            if (w[1] <= lo + 0.001) out.lo = Math.max(out.lo, w[1]);
            else if (w[0] >= hi - 0.001) out.hi = Math.min(out.hi, w[0]);
            else if (w[0] > lo) out.hi = Math.min(out.hi, w[0]);
            else out.lo = Math.max(out.lo, w[1]);
        });
        return out;
    }
    /* mean |motion| of a laid window — the on-screen "does it move" check */
    function winMag(path, a, b) {
        var r = runsMap()[path];
        if (!r || !r.mag) return 99;
        var f = r.fps || 10, s = 0, n = 0;
        for (var i = Math.max(0, Math.round(a * f)); i < Math.min(r.mag.length, Math.round(b * f)); i++) { s += r.mag[i]; n++; }
        return n ? s / n : 99;
    }
    /* fallback when the scorer's pick still reads static: the window with
       the MOST movement available inside [s0,s1] (frame-aligned) */
    function maxMagWindow(path, s0, s1, winLen) {
        var r = runsMap()[path];
        if (!r || !r.mag) return null;
        var f = r.fps || 10;
        var i0 = Math.max(0, Math.floor(s0 * f)), i1 = Math.min(r.mag.length, Math.ceil(s1 * f));
        var wN = Math.max(1, Math.round(winLen * f));
        if (i1 - i0 <= wN) return null;
        var sum = 0;
        for (var j = i0; j < i0 + wN; j++) sum += r.mag[j];
        var best = sum, bestI = i0;
        for (var k = i0 + wN; k < i1; k++) {
            sum += r.mag[k] - r.mag[k - wN];
            if (sum > best) { best = sum; bestI = k - wN + 1; }
        }
        var t = Math.min(bestI / f, s1 - winLen);
        return Math.floor(t * 25) / 25;
    }
    /* best sub-window of a segment: strongest intentional movement, sharp
       frames — never the segment edge where the operator is still settling */
    function bestWindow(entry, winLen) {
        var r = runsMap()[entry.path];
        var centered = Math.floor((entry.start + Math.max(0, (entry.dur - winLen) / 2)) * 25) / 25;
        if (!r || !r.mx || winLen >= entry.dur) return Math.max(0, Math.min(centered, Math.floor((entry.end - winLen) * 25) / 25));
        var fps = r.fps || 10;
        var wN = Math.max(1, Math.round(winLen * fps));
        var i0 = Math.max(0, Math.floor(entry.start * fps));
        var i1 = Math.min(r.mx.length, Math.ceil(entry.end * fps));
        if (i1 - i0 <= wN) return centered;
        // Learned scorer (fit on Matheus's 281 staging corrections, holdout-
        // validated 10/Jul/2026: wides 59%->74%, tights 28%->53% window
        // overlap). Keepers are SMOOTH (low jerk/variance) pushes; jitter =
        // operator adjusting the camera — "amount of movement" is NOT good.
        // weights: [push, |mx| capped, pull, jerk, mxStd, mag, |my|]
        var LW = (entry.shot === 'tight')
            ? { push: 0.111, mx: 1.9, mxCap: 1.0, pull: 0, jerk: 1.534, std: 0.011, mag: 0, my: 1.611 }
            : { push: 5.811, mx: 3.265, mxCap: 1.0, pull: 0.076, jerk: 1.567, std: 0.073, mag: 0.572, my: 0.719 };
        var domSum = 0;
        for (var d0 = i0; d0 < i1; d0++) if (Math.abs(r.mx[d0] || 0) > 0.02) domSum += r.mx[d0];
        var domSign = domSum > 0 ? 1 : domSum < 0 ? -1 : 0;
        var q = [];
        for (var i = i0; i < i1; i++) {
            var mx = r.mx[i] || 0, my = r.my[i] || 0, mag = r.mag[i] || 0, dv = r.div[i] || 0;
            var pmx = i > i0 ? (r.mx[i - 1] || 0) : mx;
            var lo = Math.max(0, i - 5), hi = Math.min(r.mx.length, i + 5);
            var mMean = 0;
            for (var g = lo; g < hi; g++) mMean += r.mx[g];
            mMean /= (hi - lo);
            var varSum = 0;
            for (var g2 = lo; g2 < hi; g2++) varSum += (r.mx[g2] - mMean) * (r.mx[g2] - mMean);
            var mxStd = Math.sqrt(varSum / (hi - lo));
            var v = LW.push * Math.max(0, -dv) + LW.mx * Math.min(Math.abs(mx), LW.mxCap)
                - LW.pull * Math.max(0, dv) - LW.jerk * Math.abs(mx - pmx) * 10
                - LW.std * mxStd - LW.mag * mag - LW.my * Math.abs(my);
            if (r.blurOk && r.blurOk[i] === 0) v -= 0.5;
            if (domSign && Math.abs(mx) > 0.02 && (mx > 0 ? 1 : -1) !== domSign) v -= 0.3;
            q.push(v);
        }
        var sum0 = 0;
        for (var j0 = 0; j0 < Math.min(wN, q.length); j0++) sum0 += q[j0];
        var best = sum0, bestJ = 0;
        for (var k = wN; k < q.length; k++) {
            sum0 += q[k] - q[k - wN];
            if (sum0 > best) { best = sum0; bestJ = k - wN + 1; }
        }
        // frame-align the source in-point (50fps source / 25fps timeline):
        // a sub-frame in-point shifts the clip duration by a frame -> gaps
        var t = (i0 + bestJ) / fps;
        t = Math.min(t, entry.end - winLen);
        return Math.floor(t * 25) / 25;
    }

    /* ── the matcher ─────────────────────────────────────────────────── */
    /* One staging segment per slot. Dry cut: src trimmed to the slot span
       (from the segment start — the motion is already vetted). Ramped clip
       (fullUsable) and the clip right before a ramp (fullUsableTail): the
       WHOLE segment goes in. Variety: avoid reusing a clip back-to-back,
       spread teaser cats, prefer unused clips and segments that fit. */
    function mulberry32(seed) {
        var s = seed >>> 0;
        return function() {
            s = (s + 0x6D2B79F5) >>> 0;
            var t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function matchSlots(grid, entries, seed) {
        var used = {};                       // entry idx -> true
        var clipUses = {};                   // path -> count
        var lastPath = null, lastTeaserCat = null;
        var t0 = grid.section.start;
        var out = [], missing = 0, fallbacks = 0, fatal = null;
        var rnd = mulberry32(seed || 1);

        // v4 preprocessing: a wide entry's window is its clip's CRUISE span
        // (validated 5/5 on Matheus's verdicts) — the old staging segment
        // bounds are replaced; clips without a usable cruise drop out.
        var spanCache = {}, seenWide = {};
        entries = entries.filter(function(e) {
            if (vetoes().clip[e.name]) return false;      // his explicit clip rejections
            var r = runsMap()[e.path];
            if (!r || !r.mx) return true;                 // no motion data: legacy behavior
            // drones keep their staging segments untouched: the v4 cruise +
            // static-wide rules model HANDHELD settle/adjust — a drone glides
            // slowly (7/9 of 18York's drone segs fail p70>0.12) and one file
            // holds several legit segments (dedup would drop them)
            if (e.cat === 'drone_aerial') return true;
            if (e.shot !== 'wide') return true;
            if (seenWide[e.path]) return false;           // one span per clip
            seenWide[e.path] = true;
            if (spanCache[e.path] === undefined) spanCache[e.path] = usableSpan(r);
            var u = spanCache[e.path];
            if (!u) return false;
            // "parado não se usa, nunca" (Matheus) — a wide span must MOVE
            var f2 = r.fps, mm = [];
            for (var k2 = Math.round(u.start * f2); k2 < Math.round(u.end * f2); k2++) mm.push(r.mag[k2]);
            mm.sort(function(x, y) { return x - y; });
            if ((mm[Math.floor(mm.length * 0.7)] || 0) <= 0.12) return false;   // static wide: out
            e.start = u.start; e.end = u.end; e.dur = u.end - u.start;
            return true;
        });
        var tightCache = {};
        // sub-second windows are too noisy for the sustained test — evaluate
        // on >=0.8s and cut the shorter slot from inside it
        function tightWinSec(shownSec) { return Math.max(0.8, shownSec); }
        function tightOk(e, shownSec) {
            var r = runsMap()[e.path];
            if (!r || !r.mx) return true;
            var key = e.path + '|' + tightWinSec(shownSec).toFixed(2);
            if (tightCache[key] === undefined) tightCache[key] = tightWindow(r, tightWinSec(shownSec));
            return !!tightCache[key];
        }
        function famOf(e) {
            var r = runsMap()[e.path];
            if (!r || !r.mx) return 'mixed';
            return movementFamily(r, e.start, e.end);
        }

        // reserve: teasers must not consume tights the tour needs later
        var tourTightNeed = {};
        grid.slots.forEach(function(s) { if (s.type === 'tight') tourTightNeed[s.area] = (tourTightNeed[s.area] || 0) + 1; });
        var tightStock = {};
        entries.forEach(function(e) { if (e.shot === 'tight') tightStock[e.cat] = (tightStock[e.cat] || 0) + 1; });
        function teaserSafe(e) {
            if (e.shot !== 'tight') return true;
            var need = tourTightNeed[e.cat] || 0;
            return (tightStock[e.cat] || 0) > need;
        }

        // consecutive file numbers within the SAME cat+shot = takes of the
        // same subject (retakes of the house number, etc.) — keep teasers
        // varied. Different cat next door (number -> garage) is fine.
        var usedNums = [];
        function clipNum(name) {
            var m = /(\d+)\.[A-Za-z0-9]+$/.exec(name || '');
            return m ? parseInt(m[1], 10) : null;
        }
        function nearUsedNum(e) {
            var n = clipNum(e.name);
            if (n == null) return false;
            for (var i = 0; i < usedNums.length; i++)
                if (Math.abs(usedNums[i].n - n) <= 2 && usedNums[i].cat === e.cat && usedNums[i].shot === e.shot) return true;
            return false;
        }
        var gramCell = null;   // set per-slot: the corpus signature to match
        function grammarScore(e) {
            if (!gramCell) return 0;
            var s = 0;
            var famTot = 0, k;
            for (k in gramCell.fam) famTot += gramCell.fam[k];
            if (famTot) s += 1.2 * ((gramCell.fam[famOf(e)] || 0) / famTot);
            var m = spanMagOf(e);
            if (m != null && gramCell.mag_p25 != null) {
                if (m >= gramCell.mag_p25 && m <= gramCell.mag_p75) s += 0.8;
                else if (m < gramCell.mag_p25 * 0.4 || m > gramCell.mag_p75 * 2.5) s -= 0.4;
            }
            return s;
        }
        function pick(filter, neededDur, varietyCat, avoidNeighbors) {
            var cands = [], bestScore = -1e9;
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                // HARD RULE: a clip appears ONCE per video — never repeat,
                // not even a different segment of the same file
                if (clipUses[e.path] || used[e.idx] || !filter(e)) continue;
                var s = 0;
                if (e.dur >= neededDur) s += 3; else s -= (neededDur - e.dur);
                if (e.path === lastPath) s -= 4;
                if (varietyCat && e.cat === varietyCat) s -= 1.5;
                if (avoidNeighbors && nearUsedNum(e)) s -= 3;
                s += Math.min(e.dur, 8) * 0.05;
                s += grammarScore(e);   // corpus signature for this slot's context
                cands.push({ e: e, s: s });
                if (s > bestScore) bestScore = s;
            }
            if (!cands.length) return null;
            // variety: draw among near-ties so every run builds a different
            // timeline without ever picking a clearly worse clip
            var pool = cands.filter(function(c) { return c.s >= bestScore - 1.5; });
            return pool[Math.floor(rnd() * pool.length)].e;
        }

        // slot boundaries snapped to the 25fps frame grid — beat times are
        // not frame-aligned and per-clip rounding left 1-frame gaps
        var FPS = 25;
        var qb = grid.slots.map(function(s) { return Math.round((s.tAbs - t0) * FPS) / FPS; });
        qb.push(Math.round((grid.slots[grid.slots.length - 1].tEnd - t0) * FPS) / FPS);

        // position label per slot for grammar-cell lookup
        var dropIdx = 0;
        grid.slots.forEach(function(s2, i2) { if (s2.type === 'drop-facade') dropIdx = i2; });
        function posOf(si2) {
            var slot2 = grid.slots[si2];
            if (si2 <= dropIdx) return 'intro';
            if (slot2.type === 'outro-drone' || slot2.type === 'closing-wide' || si2 >= grid.slots.length - 2) return 'closing';
            var frac = (si2 - dropIdx) / Math.max(1, grid.slots.length - 2 - dropIdx);
            return frac < 0.33 ? 'early' : (frac < 0.66 ? 'mid' : 'late');
        }
        var GAREA = { drone_aerial: 'drone', facade: 'facade', living: 'living', kitchen: 'kitchen',
            dining: 'dining', pool_bbq: 'pool', bedroom: 'bedroom', master_bedroom: 'bedroom',
            bathroom: 'bathroom', ensuite: 'bathroom', balcony: 'balcony', stairs: 'stairs', study: 'study' };

        var demoteNextRamp = false;
        grid.slots.forEach(function(slot, si) {
            var needed = Math.round((qb[si + 1] - qb[si]) * 1000) / 1000;
            // corpus signature for this slot's context
            gramCell = null;
            if (grammar()) {
                var gArea = slot.type === 'teaser' ? 'detail' :
                    (slot.type === 'intro-drone' || slot.type === 'outro-drone') ? 'drone' :
                    (slot.type === 'drop-facade' || slot.type === 'facade-night' || slot.type === 'closing-wide') ? 'facade' :
                    (GAREA[slot.area] || 'detail');
                var gScale = slot.shot === 'tight' ? 'tight' : 'wide';
                gramCell = grammar()[gArea + '|' + gScale + '|' + posOf(si)] || null;
            }
            // derive ramp roles from the slot chain itself — never trust
            // stale fullUsable fields in an older lastCutGrid.json
            var isTail = !!(grid.slots[si + 1] && grid.slots[si + 1].rampIn);
            // no usable tail below? the incoming ramp becomes a dry cut
            var demoted = slot.rampIn && demoteNextRamp;
            demoteNextRamp = false;
            var rampIn = slot.rampIn && !demoted;
            var full = rampIn || isTail;
            // pre-ramp clip must keep MIN_RAMP_TAIL of source under the next
            // clip; the ramped clip itself needs MIN_RAMP_HEAD past its span
            var minDur = needed;
            if (isTail) minDur = needed + MIN_RAMP_TAIL;
            if (rampIn) minDur = needed + MIN_RAMP_HEAD;
            var e = null, note = demoted ? 'ramp demoted to cut (not enough tail below)' : '';
            // ramps only join within a movement family: push>push, lateral>lateral
            // (pan/orbit/curving unified — see MONTAGE_RECIPE; holds never ramp)
            var prevA = out[si - 1];
            var rampMate = (rampIn && prevA && prevA.entry) ? famOf(prevA.entry) : null;
            if (rampMate === 'hold') { demoteHere('static clip below — never ramp from a hold'); rampMate = null; }
            function rampFits(x) {
                if (!rampMate || rampMate === 'mixed') return true;
                var f2 = famOf(x);
                return f2 === rampMate;
            }
            // "sempre vai ter push" (Matheus): ramp pairs default to push↔push —
            // the pre-ramp wide prefers a push candidate so the mate always exists
            function pushFirst(x) { return famOf(x) === 'push'; }
            function demoteHere(reason) {
                demoted = true; rampIn = false; rampMate = null;
                full = isTail; minDur = isTail ? needed + MIN_RAMP_TAIL : needed;
                note = (note ? note + '; ' : '') + 'ramp demoted to cut (' + reason + ')';
            }
            var shownT = needed * 0.5;   // tights run at 50%: the shown source
            if (slot.type === 'teaser') {
                e = pick(function(x) { return x.shot === 'tight' && EXTERIOR_CATS[x.cat] && teaserSafe(x) && tightOk(x, shownT); }, needed, lastTeaserCat, true) ||
                    pick(function(x) { return x.cat === 'drone_aerial'; }, needed, null, true) ||
                    pick(function(x) { return x.shot === 'tight' && EXTERIOR_CATS[x.cat] && tightOk(x, shownT); }, needed, lastTeaserCat, true);
                if (!e) {
                    e = pick(function(x) { return x.shot === 'wide' && EXTERIOR_CATS[x.cat]; }, needed, null, true);
                    if (e) { note = 'fallback: exterior wide as teaser'; fallbacks++; }
                }
                if (e && e.shot === 'tight') tightStock[e.cat]--;
                if (e && clipNum(e.name) != null) usedNums.push({ n: clipNum(e.name), cat: e.cat, shot: e.shot });
            } else if (slot.type === 'intro-drone') {
                // corpus grammar: the INTRO drone is a PUSH toward the house
                // (62% of 212 intro drones), strong movement — never the slow
                // drifting one (that's the closing's signature)
                e = pick(function(x) { return x.cat === 'drone_aerial' && famOf(x) === 'push' && x.dur >= minDur; }, needed, null) ||
                    pick(function(x) { return x.cat === 'drone_aerial' && famOf(x) === 'push'; }, needed, null) ||
                    pick(function(x) { return x.cat === 'drone_aerial' && x.dur >= minDur; }, needed, null) ||
                    pick(function(x) { return x.cat === 'drone_aerial'; }, needed, null);
                if (!e) {
                    demoteNextRamp = true;   // no drone: facade loses its ramp, stays ON the drop
                    note = 'no drone available — facade ramp demoted';
                }
            } else if (slot.type === 'drop-facade' || slot.type === 'facade-night') {
                // the DROP is ALWAYS a facade WIDE — a shoot always has one,
                // so coming up empty is a data bug, never something to paper over
                e = pick(function(x) { return x.cat === 'facade' && x.shot === 'wide' && x.dur >= minDur && rampFits(x); }, needed, null) ||
                    pick(function(x) { return x.cat === 'facade' && x.shot === 'wide' && x.dur >= minDur; }, needed, null) ||
                    pick(function(x) { return x.cat === 'facade' && x.shot === 'wide'; }, needed, null);
                if (e && rampIn && rampMate && rampMate !== 'mixed' && famOf(e) !== rampMate)
                    demoteHere('facade family mismatch: ' + rampMate + ' > ' + famOf(e));
                if (!e) fatal = 'no facade WIDE found in staging — check classification (drop slot must be a facade wide)';
            } else if (slot.type === 'closing-wide') {
                // pre-closing exterior wide — but material that COVERS the
                // slot outranks category: a moving interior wide beats a
                // static exterior stretched with settle ("parado NUNCA")
                e = pick(function(x) { return x.shot === 'wide' && EXTERIOR_CATS[x.cat] && x.dur >= minDur; }, needed, null) ||
                    pick(function(x) { return x.shot === 'wide' && EXTERIOR_CATS[x.cat] && x.dur >= minDur * 0.7; }, needed, null) ||
                    pick(function(x) { return x.shot === 'wide' && x.dur >= minDur; }, needed, null) ||
                    pick(function(x) { return x.shot === 'wide' && EXTERIOR_CATS[x.cat]; }, needed, null) ||
                    pick(function(x) { return x.shot === 'wide' && x.cat === 'balcony'; }, needed, null) ||
                    pick(function(x) { return x.shot === 'wide'; }, needed, null);
                if (e && !EXTERIOR_CATS[e.cat] && e.cat !== 'balcony') { note = 'fallback: interior wide pre-closing'; fallbacks++; }
            } else if (slot.type === 'outro-drone') {
                // corpus grammar: the CLOSING drone is the SLOW long one
                // (median 2.7 bars, weakest movement of all drone shots) —
                // gentle drift away, never the punchy approach
                function spanMag(x) {
                    var r2 = runsMap()[x.path];
                    if (!r2 || !r2.mag) return 99;
                    var f3 = r2.fps, s3 = 0, n3 = 0;
                    for (var k3 = Math.round(x.start * f3); k3 < Math.min(r2.mag.length, Math.round(x.end * f3)); k3++) { s3 += r2.mag[k3]; n3++; }
                    return n3 ? s3 / n3 : 99;
                }
                var droneCands = entries.filter(function(x) {
                    return !clipUses[x.path] && !used[x.idx] && x.cat === 'drone_aerial' && x.dur >= needed * 0.7;
                }).sort(function(a2, b2) { return spanMag(a2) - spanMag(b2); });   // calmest first
                e = droneCands[0] || pick(function(x) { return x.cat === 'drone_aerial'; }, needed, null);
                if (!e) {
                    // long-enough material first — the last shot stretched
                    // with raw settle is the worst possible ending
                    e = pick(function(x) { return x.cat === 'facade' && x.shot === 'wide' && x.dur >= minDur && rampFits(x); }, needed, null) ||
                        pick(function(x) { return x.cat === 'facade' && x.shot === 'wide' && x.dur >= minDur; }, needed, null) ||
                        pick(function(x) { return x.shot === 'wide' && EXTERIOR_CATS[x.cat] && x.dur >= minDur; }, needed, null) ||
                        pick(function(x) { return x.shot === 'wide' && x.dur >= minDur; }, needed, null) ||
                        pick(function(x) { return x.cat === 'facade' && x.shot === 'wide'; }, needed, null) ||
                        pick(function(x) { return x.shot === 'wide' && EXTERIOR_CATS[x.cat]; }, needed, null) ||
                        pick(function(x) { return x.shot === 'wide'; }, needed, null);   // the END never goes black
                    if (e) { note = 'fallback: ' + e.cat + ' (no drone in staging)'; fallbacks++; }
                }
                // ramp into the closing obeys the family rule like any other:
                // push>push / lateral>lateral, else it becomes a dry cut
                if (e && rampIn && rampMate && rampMate !== 'mixed' && famOf(e) !== rampMate)
                    demoteHere('closing family mismatch: ' + rampMate + ' > ' + famOf(e));
            } else {
                var baseF = function(x) {
                    if (x.cat !== slot.area || x.shot !== slot.shot) return false;
                    if (slot.shot === 'tight' && !tightOk(x, shownT)) return false;
                    return true;
                };
                if (isTail || rampIn)   // ramp sides: push first (recipe: push com push)
                    e = pick(function(x) { return baseF(x) && rampFits(x) && pushFirst(x) && x.dur >= minDur; }, needed, null) ||
                        pick(function(x) { return baseF(x) && rampFits(x) && pushFirst(x); }, needed, null);
                if (!e)
                    e = pick(function(x) { return baseF(x) && rampFits(x) && x.dur >= minDur; }, needed, null) ||
                        pick(function(x) { return baseF(x) && rampFits(x); }, needed, null);
                if (!e && rampIn && rampMate && rampMate !== 'mixed') {
                    // no same-motion mate exists: NEVER ramp push with orbit — cut instead
                    demoteHere('no ' + rampMate + ' ' + slot.shot + ' available for ' + slot.area);
                    e = pick(baseF, needed, null);
                }
                if (!e) {
                    // last resort inside the room — but NEVER an entry whose
                    // window search failed (laying its raw start is exactly
                    // the vetoed/adjusting material: the CALVIN7884 lesson),
                    // and never STEALING the area's last clips of a shot the
                    // grid still needs later (the s923 ensuite lesson: the
                    // borrowed wide left its own W slot with a hole)
                    function stillNeeded(shot2) {
                        var cnt = 0;
                        for (var sj = si + 1; sj < grid.slots.length; sj++)
                            if (grid.slots[sj].area === slot.area && grid.slots[sj].shot === shot2) cnt++;
                        return cnt;
                    }
                    function freshOf(shot2) {
                        var cnt = 0;
                        entries.forEach(function(x2) {
                            if (x2.cat === slot.area && x2.shot === shot2 && !used[x2.idx] && !clipUses[x2.path]) cnt++;
                        });
                        return cnt;
                    }
                    e = pick(function(x) {
                        if (x.cat !== slot.area) return false;
                        if (x.shot === 'tight' && !tightOk(x, shownT)) return false;
                        if (x.shot !== slot.shot && freshOf(x.shot) <= stillNeeded(x.shot)) return false;
                        return true;
                    }, needed, null);
                    if (e) { note = (note ? note + '; ' : '') + 'fallback: ' + e.shot + ' used as ' + slot.shot; fallbacks++; }
                }
            }
            var a = { slot: slot, t: qb[si], needed: needed, rampIn: rampIn, demoted: demoted };
            if (!e) {
                // out of fresh material: NEVER repeat a clip — stretch the
                // previous cut over this slot instead (one longer hold)
                var a2 = null;
                for (var bk = out.length - 1; bk >= 0; bk--) if (out[bk].entry) { a2 = out[bk]; break; }
                var coveredBy = null;
                if (a2) {
                    var rr2 = runsMap()[a2.entry.path];
                    var clipEnd2 = (rr2 && rr2.dur) ? Math.floor(rr2.dur * 25) / 25 : a2.srcOut;
                    clipEnd2 = Math.min(clipEnd2, vetoFree(a2.entry.name, a2.srcIn, a2.srcOut).hi);
                    // stretch from a2's CURRENT coverage to the REAL next
                    // boundary — a blind "+needed" compounds 1-frame drifts
                    // between the beat grid and needed-sums
                    var cov2 = a2.t + (a2.srcOut - a2.srcIn) / (a2.speed || 1);
                    var extraSrc = Math.max(0, qb[si + 1] - cov2) * (a2.speed || 1);
                    if (extraSrc <= 0.02) {
                        coveredBy = a2.entry.name;   // already reaches the boundary
                    } else if (clipEnd2 >= a2.srcOut + extraSrc - 0.02) {
                        a2.srcOut = Math.round((a2.srcOut + extraSrc) * 1000) / 1000;
                        a2.note = (a2.note ? a2.note + '; ' : '') + 'stretched +' + (extraSrc / (a2.speed || 1)).toFixed(2) + 's over next slot';
                        coveredBy = a2.entry.name;
                    }
                }
                a.entry = null;
                a.coveredBy = coveredBy;
                if (coveredBy) {
                    a.note = 'held: ' + coveredBy + ' stretched over this slot (no fresh ' +
                        (slot.type === 'teaser' ? 'exterior tight' : slot.area + ' ' + slot.shot) + ')';
                    fallbacks++;
                } else {
                    a.note = 'MISSING: no ' + (slot.type === 'teaser' ? 'exterior tight/drone' : slot.area + ' ' + slot.shot) +
                        ' left and previous clip cannot stretch';
                    missing++;
                }
                out.push(a);
                return;
            }
            if (e) {
                used[e.idx] = true;
                clipUses[e.path] = (clipUses[e.path] || 0) + 1;
                lastPath = e.path;
                if (slot.type === 'teaser') lastTeaserCat = e.cat;
                a.entry = e;
                a.motion = famOf(e);
                // tights run at 50% speed: the shown source is span/2 — pick
                // the best-motion window for what is actually seen
                a.speed = (e.shot === 'tight') ? 0.5 : 1;
                var shown = needed * a.speed;
                // v4 windows: the wide's span IS the cruise (settle/adjust
                // already excluded — never reach outside it, that's exactly
                // the operator-adjustment material). Tights use their own
                // validated 1-window pick (hold or sustained lateral).
                var extra = rampIn ? MIN_RAMP_HEAD : (isTail ? MIN_RAMP_TAIL : 0);
                var span = needed + extra;
                var segS = Math.floor(e.start * 25) / 25, segE = Math.floor(e.end * 25) / 25;
                var sIn, sOut;
                if (e.shot === 'tight') {
                    var tw = tightCache[e.path + '|' + tightWinSec(shownT).toFixed(2)];
                    sIn = Math.floor(((tw && tw.start != null) ? tw.start : e.start) * 25) / 25;
                    var rr = runsMap()[e.path];
                    // the v4 window lives on the WHOLE clip — old segment
                    // bounds don't cap it. Clip end = the longest credible
                    // source: stored dur OR the series length (dur fields
                    // have been seen corrupted in old runs files)
                    var clipE = sIn + needed;
                    if (rr) clipE = Math.max(rr.dur || 0, rr.mx.length / (rr.fps || 10));
                    clipE = Math.floor(clipE * 25) / 25;
                    // 50% clips EXPAND after setSpeed (timeline extent =
                    // source/speed — the 50x-warp lesson, confirmed by the
                    // Learn Finished in/out*speed conversion): lay HALF the
                    // slot of source so the expansion lands EXACTLY on it
                    sOut = Math.max(sIn + 0.2, Math.min(clipE, sIn + shown));
                } else if (full) {
                    sIn = segS; sOut = segE;                 // whole cruise (ramp material)
                } else {
                    // dry cut: when the cruise is longer than the slot, the
                    // learned scorer picks WHERE inside it (cruise start is
                    // often the calm half — "parado não se usa, nunca")
                    sIn = segS;
                    if (segE - segS > span + 0.1) {
                        sIn = bestWindow(e, span);
                        if (winMag(e.path, sIn, sIn + span) <= 0.12) {
                            var altIn = maxMagWindow(e.path, segS, segE, span);
                            if (altIn != null) sIn = altIn;
                        }
                    }
                    sOut = Math.min(segE, sIn + span);
                    // asymmetric tail margin (leak is 2:1 at the tail, measured):
                    // trim the end ONLY when there is slack — never make a hole
                    var TMq = Math.floor(V4.TAIL_MARGIN_SEC * 25) / 25;
                    if (segE - sIn >= span + TMq && sOut > segE - TMq)
                        sOut = Math.min(sOut, Math.floor((segE - TMq) * 25) / 25);
                }
                // zero tolerance: whatever path produced this window, it
                // never touches a vetoed range (degenerate windows go SHORT
                // and the hole machinery covers with clean material)
                var vf0 = vetoFree(e.name, sIn, sOut);
                if (sIn < vf0.lo) sIn = Math.ceil(vf0.lo * 25) / 25;
                if (sOut > vf0.hi) sOut = Math.floor(vf0.hi * 25) / 25;
                if (sOut < sIn + 0.04) sOut = sIn + 0.04;
                a.srcIn = sIn; a.srcOut = sOut;
                var laid = sOut - sIn;
                if (isTail && laid < needed + MIN_RAMP_TAIL - 0.05) {
                    demoteNextRamp = true;
                    note = (note ? note + '; ' : '') + 'tail <' + MIN_RAMP_TAIL + 's even with raw — next ramp demoted';
                }
                if (rampIn && laid < needed + MIN_RAMP_HEAD - 0.05)
                    note = (note ? note + '; ' : '') + 'RAMP HEAD SHORT: ' + laid.toFixed(1) + 's for ' + needed.toFixed(1) + 's span';
                if (laid < needed - 0.05)
                    note = (note ? note + '; ' : '') + 'SHORT by ' + (needed - laid).toFixed(2) + 's';
                a.note = note;
            }
            out.push(a);
        });
        // SHORT-gap pass: a clip whose laid material is shorter than its slot
        // leaves a visible hole. Cover it, best first: (1) INSERT AN EXTRA
        // TIGHT on the beat grid (Matheus's rule: a hole becomes one more
        // detail, not stretched material), (2) this clip's raw tail (warned),
        // (3) stretch the previous clip. Leftovers get flagged loudly.
        var beat = (grid.barDur || 1.95) / 4;
        var inserts = [];
        out.forEach(function(a, i) {
            if (!a.entry) return;
            var laid = (a.srcOut - a.srcIn) / (a.speed || 1);
            var gap = a.needed - laid;
            if (gap < 0.05) return;
            // (1) tight insert — only for plain dry cuts (never break a
            // ramp's material or the pre-ramp tail role)
            var slotIsPlain = !a.rampIn && !(out[i + 1] && out[i + 1].rampIn);   // FINAL ramp decisions
            var isLastSlot = (i === out.length - 1) || a.slot.type === 'outro-drone';   // nothing EVER after the closing
            if (slotIsPlain && !isLastSlot && gap >= beat * 0.9) {
                var keptBeats = Math.max(1, Math.floor(laid / beat + 1e-6));
                var fillStart = Math.floor((a.t + keptBeats * beat) * 25) / 25;
                var fillLen = Math.round((a.t + a.needed - fillStart) * 1000) / 1000;
                if (fillLen >= beat * 0.9) {
                    var shownF = fillLen * 0.5;
                    // fill ONLY with the same room's tights — a foreign-room
                    // detail mid-section reads as an editing mistake (Matheus)
                    var fe = pick(function(x) { return x.cat === a.slot.area && x.shot === 'tight' && tightOk(x, shownF); }, fillLen, null);
                    if (fe) {
                        used[fe.idx] = true;
                        clipUses[fe.path] = (clipUses[fe.path] || 0) + 1;
                        var twf = tightCache[fe.path + '|' + tightWinSec(shownF).toFixed(2)];
                        var fIn = Math.floor(((twf && twf.start != null) ? twf.start : fe.start) * 25) / 25;
                        var rrF = runsMap()[fe.path];
                        var fClipE = rrF ? Math.floor(Math.max(rrF.dur || 0, rrF.mx.length / (rrF.fps || 10)) * 25) / 25 : (fIn + fillLen);
                        // trim the short clip to whole beats; the tight covers the rest
                        a.srcOut = Math.round((a.srcIn + keptBeats * beat * (a.speed || 1)) * 1000) / 1000;
                        a.note = (a.note ? a.note + '; ' : '') + 'shortened to ' + keptBeats + ' beat(s); tight fills the rest';
                        inserts.push({ after: i, a: { slot: { area: fe.cat, label: 'T ' + fe.cat + ' (fill)', type: 'tight', track: a.slot.track },
                            t: fillStart, needed: fillLen, rampIn: false, entry: fe, motion: famOf(fe), speed: 0.5,
                            srcIn: fIn, srcOut: Math.max(fIn + 0.2, Math.min(fClipE, fIn + shownF)),
                            note: 'inserted to fill a short ' + a.slot.shot + ' slot' } });
                        return;   // hole solved editorially
                    }
                }
            }
            var r = runsMap()[a.entry.path];
            var clipE = r ? Math.floor(Math.max(r.dur || 0, r.mx.length / (r.fps || 10)) * 25) / 25 : a.srcOut;
            clipE = Math.min(clipE, vetoFree(a.entry.name, a.srcIn, a.srcOut).hi);   // raw never crosses a veto
            var extraSrc = Math.min(gap * (a.speed || 1), Math.max(0, clipE - a.srcOut));
            if (extraSrc > 0.02) {
                a.srcOut = Math.round((a.srcOut + extraSrc) * 1000) / 1000;
                a.note = (a.note ? a.note + '; ' : '') + 'raw tail +' + extraSrc.toFixed(2) + 's to avoid a hole (may show settle)';
                gap -= extraSrc / (a.speed || 1);
            }
            if (gap > 0.05) {
                var pv = null;
                for (var b2 = i - 1; b2 >= 0; b2--) if (out[b2].entry) { pv = out[b2]; break; }
                if (pv) {
                    var rp = runsMap()[pv.entry.path];
                    var pclipE = rp ? Math.floor(Math.max(rp.dur || 0, rp.mx.length / (rp.fps || 10)) * 25) / 25 : pv.srcOut;
                    pclipE = Math.min(pclipE, vetoFree(pv.entry.name, pv.srcIn, pv.srcOut).hi);
                    var pExtra = Math.min(gap * (pv.speed || 1), Math.max(0, pclipE - pv.srcOut));
                    if (pExtra > 0.02) {
                        pv.srcOut = Math.round((pv.srcOut + pExtra) * 1000) / 1000;
                        pv.note = (pv.note ? pv.note + '; ' : '') + 'stretched +' + (pExtra / (pv.speed || 1)).toFixed(2) + 's under a short neighbor';
                        gap -= pExtra / (pv.speed || 1);
                    }
                }
            }
            if (gap > 0.05) a.note = (a.note ? a.note + '; ' : '') + 'GAP ' + gap.toFixed(2) + 's UNCOVERED';
        });
        // splice the fill-tights into the chain (reverse: indices stay valid)
        inserts.reverse().forEach(function(ins) { out.splice(ins.after + 1, 0, ins.a); });
        // ramp physics: a ramp whose anchor has no tail material below it
        // cannot exist (the AE remap needs the clip underneath). Runs BEFORE
        // the coverage passes (demoted clip becomes movable) and AGAIN after
        // them (a mover may have re-shaped the coverage under an anchor).
        function runRampPhysics() {
            out.forEach(function(a, i) {
                if (!a.entry || !a.rampIn) return;
                var covered = 0;
                for (var j5 = 0; j5 < i; j5++) {
                    var o5 = out[j5];
                    if (!o5.entry) continue;
                    covered = Math.max(covered, o5.t + (o5.srcOut - o5.srcIn) / (o5.speed || 1));
                }
                if (covered < a.t + MIN_RAMP_TAIL - 0.15) {
                    a.rampIn = false;
                    a.note = (a.note ? a.note + '; ' : '') + 'ramp demoted: no tail material below the anchor';
                }
            });
        }
        runRampPhysics();
        // residual-gap pass: a hole the short clip/tight/raw/prev couldn't
        // cover, the NEXT clip absorbs by starting earlier ON THE BEAT —
        // never reaching before its cruise (that's the settle material)
        out.forEach(function(a, i) {
            if (!a.entry) return;
            var nx = null, nj = -1;
            for (var j = i + 1; j < out.length; j++) if (out[j].entry) { nx = out[j]; nj = j; break; }
            if (!nx || nx.rampIn) return;                              // a ramp anchor never moves
            if (nx.slot && nx.slot.type === 'drop-facade') return;     // facade never leaves the drop
            var isClosing = true;
            for (var j2 = nj + 1; j2 < out.length; j2++) if (out[j2].entry) { isClosing = false; break; }
            if (isClosing) return;                                     // the END guarantee owns the ending
            var covered = a.t + (a.srcOut - a.srcIn) / (a.speed || 1);
            var gap = nx.t - covered;
            if (gap <= 0.05) return;
            var spN = nx.speed || 1;
            var floorIn = (nx.entry.start != null) ? Math.max(0, Math.floor(nx.entry.start * 25) / 25) : 0;
            // moving nx earlier pulls its END back too — coverage until the
            // NEXT real cut must survive: spend cruise lead first (window
            // stays put), extend the srcOut inside the cruise for the rest
            var nxNext = null;
            for (var j3 = nj + 1; j3 < out.length; j3++) if (out[j3].entry) { nxNext = out[j3]; break; }
            // covering up to a RAMP anchor must OVERSHOOT by the tail the
            // remap needs — covering it exactly kills the ramp physics
            var mustCover = nxNext ? (nxNext.t + (nxNext.rampIn ? MIN_RAMP_TAIL : 0)) : (nx.t + (nx.needed || 0));
            var vfN = vetoFree(nx.entry.name, nx.srcIn, nx.srcOut);
            floorIn = Math.max(floorIn, Math.ceil(vfN.lo * 25) / 25);
            var leadAvail = Math.max(0, nx.srcIn - floorIn);
            var cruiseE = Math.min(Math.max(nx.srcOut, Math.floor(((nx.entry.end || nx.srcOut)) * 25) / 25), vfN.hi);
            for (var k4 = Math.ceil(gap / beat - 1e-6); k4 >= 1; k4--) {
                var newT = Math.floor((nx.t - k4 * beat) * 25) / 25;
                var shift = nx.t - newT;
                if (newT < a.t + 0.1) continue;                        // never erase the previous cut
                var inShift = Math.min(shift * spN, leadAvail);
                var newIn = nx.srcIn - inShift;
                var short2 = (mustCover - newT) - (nx.srcOut - newIn) / spN;
                var ext = Math.max(0, short2 * spN);
                var usesRawExt = nx.srcOut + ext > cruiseE + 0.02;
                if (usesRawExt) {
                    // beyond the cruise: raw as last resort — a hole is worse
                    var rnx = runsMap()[nx.entry.path];
                    var rawE2 = rnx ? Math.floor(Math.max(rnx.dur || 0, rnx.mx.length / (rnx.fps || 10)) * 25) / 25 : cruiseE;
                    rawE2 = Math.min(rawE2, vfN.hi);
                    if (nx.srcOut + ext > rawE2 + 0.02) continue;      // truly out of material
                }
                nx.srcIn = Math.round(newIn * 1000) / 1000;
                if (ext > 0.02) nx.srcOut = Math.round((nx.srcOut + ext) * 1000) / 1000;
                nx.t = newT;
                nx.note = (nx.note ? nx.note + '; ' : '') + 'starts ' + k4 + ' beat(s) early, absorbing the gap before' +
                    (usesRawExt ? ' (raw — may show settle)' : '');
                a.note = (a.note || '').replace(/;? ?GAP [\d.]+s UNCOVERED/, '');
                var rest = nx.t - covered;
                if (rest > 0.05) a.note = (a.note ? a.note + '; ' : '') + 'GAP ' + rest.toFixed(2) + 's UNCOVERED';
                break;
            }
        });
        // second-chance pass: a hole the previous clip couldn't cover can be
        // covered by the NEXT clip starting earlier (source before its window)
        out.forEach(function(a, i) {
            if (a.entry || a.coveredBy) return;
            var nx = null;
            for (var j = i + 1; j < out.length; j++) if (out[j].entry) { nx = out[j]; break; }
            if (!nx) return;
            if (nx.slot && nx.slot.type === 'drop-facade') return;   // the facade NEVER leaves the drop beat
            var extraSrc = (nx.t - a.t) * (nx.speed || 1);
            var vf2 = vetoFree(nx.entry.name, nx.srcIn, nx.srcOut);
            if (extraSrc <= 0) {
                // an earlier pass already pulled the next clip over this slot
                a.coveredBy = nx.entry.name;
                a.note = 'held: ' + nx.entry.name + ' already covers this slot';
                missing--;
                return;
            }
            if (nx.srcIn - extraSrc >= Math.max(0, vf2.lo) - 0.001) {
                nx.srcIn = Math.round((nx.srcIn - extraSrc) * 1000) / 1000;
                nx.t = a.t;
                nx.note = (nx.note ? nx.note + '; ' : '') + 'starts early, covering the empty slot before';
                a.coveredBy = nx.entry.name;
                a.note = 'held: ' + nx.entry.name + ' starts early over this slot';
                missing--;
            }
        });
        runRampPhysics();   // movers may have re-shaped coverage under anchors
        // END GUARANTEE: the video settles exactly when the music cuts.
        // Dry-cut closing: re-anchor on the beat grid (earlier absorbs a gap
        // a short pre-closing left behind — the closing has spare material;
        // later covers a closing that can't reach END) and trim srcOut so it
        // lands EXACTLY on END. Ramped closings are left alone: the AE remap
        // settles key 3 on END, the Premiere extent is deliberately longer.
        (function() {
            var END = Math.floor((grid.section.end - grid.section.start) * 25) / 25;
            var lastA = null, pv3 = null;
            for (var b3 = out.length - 1; b3 >= 0; b3--) if (out[b3].entry) { lastA = out[b3]; break; }
            if (!lastA || lastA.rampIn) return;
            for (var b4 = out.length - 1; b4 >= 0; b4--) if (out[b4].entry && out[b4] !== lastA) { pv3 = out[b4]; break; }
            var sp = lastA.speed || 1;
            // coverage before the closing = the UNION of everything laid
            // (a long tail can reach further than the last short cut)
            var covEnd = 0;
            out.forEach(function(o) {
                if (!o.entry || o === lastA) return;
                covEnd = Math.max(covEnd, o.t + (o.srcOut - o.srcIn) / (o.speed || 1));
            });
            if (!covEnd) covEnd = lastA.t;
            var end0 = lastA.t + (lastA.srcOut - lastA.srcIn) / sp;
            if (Math.abs(end0 - END) <= 0.05 && lastA.t <= covEnd + 0.02) return;   // already settles clean
            // closing material: cruise first, raw tail as last resort (warned);
            // cruise lead BEFORE the current window also counts
            var rl = runsMap()[lastA.entry.path];
            var cruiseOut = Math.max(lastA.srcOut, Math.floor((lastA.entry.end || lastA.srcOut) * 25) / 25);
            var rawOut = rl ? Math.floor(Math.max(rl.dur || 0, rl.mx.length / (rl.fps || 10)) * 25) / 25 : cruiseOut;
            rawOut = Math.max(rawOut, cruiseOut);
            var floorInL = (lastA.entry.start != null) ? Math.max(0, Math.floor(lastA.entry.start * 25) / 25) : lastA.srcIn;
            floorInL = Math.min(floorInL, lastA.srcIn);
            var vfL = vetoFree(lastA.entry.name, lastA.srcIn, lastA.srcOut);
            rawOut = Math.min(rawOut, vfL.hi);
            floorInL = Math.max(floorInL, Math.ceil(vfL.lo * 25) / 25);
            // anchor stays on the beat grid counted back from END; keep the
            // planned length when possible — grow earlier only to absorb a
            // gap, shrink later only when the closing runs out of material
            var k0 = Math.max(1, Math.round((END - lastA.t) / beat));
            function tkOf(k) { return Math.floor((END - k * beat) * 25) / 25; }
            function feasible(k) {
                var tk = tkOf(k);
                if (pv3 && tk <= pv3.t + 0.1) return false;            // never erase the previous cut
                return (END - tk) * sp <= (rawOut - floorInL) + 0.02;
            }
            var kSel = null;
            if (!feasible(k0)) {
                for (var kd = k0 - 1; kd >= 1; kd--) if (feasible(kd)) { kSel = kd; break; }
            } else {
                kSel = k0;
                while (tkOf(kSel) > covEnd + 0.02 && feasible(kSel + 1)) kSel++;
            }
            if (kSel == null) return;
            var bestT = tkOf(kSel);
            var needSrc = (END - bestT) * sp;
            // keep the chosen window start when the tail suffices; otherwise
            // slide back into the cruise lead for the remainder
            var newInL = (lastA.srcIn + needSrc <= rawOut + 0.02) ? lastA.srcIn
                : Math.max(floorInL, Math.floor((rawOut - needSrc) * 25) / 25);
            var usesRaw = newInL + needSrc > cruiseOut + 0.02;
            lastA.t = bestT;
            lastA.srcIn = Math.round(newInL * 1000) / 1000;
            lastA.srcOut = Math.round((newInL + needSrc) * 1000) / 1000;
            lastA.note = (lastA.note ? lastA.note + '; ' : '') + 'anchored to settle exactly on END' +
                (usesRaw ? ' (raw tail — may show settle)' : '');
            if (pv3) {
                var pvLaid = (pv3.srcOut - pv3.srcIn) / (pv3.speed || 1);
                if (pv3.t + pvLaid > lastA.t + 0.02)
                    // closing now starts inside the previous clip: dry-cut it there
                    pv3.srcOut = Math.round((pv3.srcIn + (lastA.t - pv3.t) * (pv3.speed || 1)) * 1000) / 1000;
            }
            if (lastA.t - covEnd > 0.05) {
                // residual gap the closing couldn't reach: stretch the raw of
                // whichever clip's coverage reaches furthest (often a tail)
                var owner = null, ownEnd = 0;
                out.forEach(function(o) {
                    if (!o.entry || o === lastA) return;
                    var oe = o.t + (o.srcOut - o.srcIn) / (o.speed || 1);
                    if (oe > ownEnd) { ownEnd = oe; owner = o; }
                });
                if (owner) {
                    var need3 = lastA.t - ownEnd;
                    var rp3 = runsMap()[owner.entry.path];
                    var pE3 = rp3 ? Math.floor(Math.max(rp3.dur || 0, rp3.mx.length / (rp3.fps || 10)) * 25) / 25 : owner.srcOut;
                    pE3 = Math.min(pE3, vetoFree(owner.entry.name, owner.srcIn, owner.srcOut).hi);
                    var ext3 = Math.min(need3 * (owner.speed || 1), Math.max(0, pE3 - owner.srcOut));
                    if (ext3 > 0.02) {
                        owner.srcOut = Math.round((owner.srcOut + ext3) * 1000) / 1000;
                        owner.note = (owner.note ? owner.note + '; ' : '') + 'stretched under re-anchored closing';
                    }
                }
            }
            // still uncovered? the hole becomes one more exterior detail on
            // the beat — Matheus's own fix ("por que não adiciona mais um
            // tight?"), and the ending stays an exterior sandwich
            var covEnd2 = 0;
            out.forEach(function(o) {
                if (!o.entry || o === lastA) return;
                covEnd2 = Math.max(covEnd2, o.t + (o.srcOut - o.srcIn) / (o.speed || 1));
            });
            if (lastA.t - covEnd2 > 0.05) {
                var kIns = Math.ceil((lastA.t - covEnd2) / beat - 1e-6);
                var tIns = Math.floor((lastA.t - kIns * beat) * 25) / 25;
                var lenIns = Math.round((lastA.t - tIns) * 1000) / 1000;
                var shownI = lenIns * 0.5;
                var fe2 = (tIns >= 0 && (pick(function(x) { return x.shot === 'tight' && EXTERIOR_CATS[x.cat] && tightOk(x, shownI); }, lenIns, null) ||
                          pick(function(x) { return x.shot === 'tight' && tightOk(x, shownI); }, lenIns, null))) || null;
                if (fe2) {
                    used[fe2.idx] = true;
                    clipUses[fe2.path] = (clipUses[fe2.path] || 0) + 1;
                    var twI = tightCache[fe2.path + '|' + tightWinSec(shownI).toFixed(2)];
                    var iIn = Math.floor(((twI && twI.start != null) ? twI.start : fe2.start) * 25) / 25;
                    var rI = runsMap()[fe2.path];
                    var iE = rI ? Math.floor(Math.max(rI.dur || 0, rI.mx.length / (rI.fps || 10)) * 25) / 25 : (iIn + shownI);
                    out.splice(out.indexOf(lastA), 0, {
                        slot: { area: fe2.cat, label: 'T ' + fe2.cat + ' (fill pre-closing)', type: 'tight', track: lastA.slot.track },
                        t: tIns, needed: lenIns, rampIn: false, entry: fe2, motion: famOf(fe2), speed: 0.5,
                        srcIn: iIn, srcOut: Math.max(iIn + 0.2, Math.min(iE, iIn + shownI)),
                        note: 'inserted: exterior detail covering the pre-closing hole' });
                } else {
                    lastA.note = (lastA.note ? lastA.note + '; ' : '') + 'GAP ' + (lastA.t - covEnd2).toFixed(2) + 's before closing UNCOVERED';
                }
            }
        })();
        return { assigns: out, missing: missing, fallbacks: fallbacks, fatal: fatal,
            segmentsUsed: Object.keys(used).length, clipsUsed: Object.keys(clipUses).length };
    }

    /* ── assembly artifact (consumed by the JSX build + phase review) ── */
    function buildAssembly(grid, match, musicMeta) {
        // tracks recomputed from FINAL ramp decisions (demotions flatten the
        // staircase — a demoted ramp must not keep climbing like a real one)
        var track = 1, prevRamp = false;
        match.assigns.forEach(function(a) {
            if (!a.entry) { a.trackFinal = track; return; }
            if (a.rampIn || prevRamp) track++;
            a.trackFinal = track;
            prevRamp = !!a.rampIn;
        });
        // final snap: a 50% clip EXPANDS to source/0.5 — trim so no
        // expansion crosses the next item on its FINAL track (kills every
        // 1-2 frame drift the passes can accumulate, deterministically)
        match.assigns.forEach(function(a) {
            if (!a.entry || a.speed !== 0.5) return;
            var nxtT = null;
            match.assigns.forEach(function(o) {
                if (o === a || !o.entry || o.trackFinal !== a.trackFinal) return;
                if (o.t > a.t + 0.02 && (nxtT == null || o.t < nxtT)) nxtT = o.t;
            });
            if (nxtT == null) return;
            var ext = (a.srcOut - a.srcIn) / 0.5;
            if (a.t + ext > nxtT + 0.02) {
                var maxSrc = Math.floor((nxtT - a.t) * 0.5 * 50) / 50;
                a.srcOut = Math.round((a.srcIn + Math.max(0.04, maxSrc)) * 1000) / 1000;
            }
        });
        var items = [];
        match.assigns.forEach(function(a) {
            if (!a.entry) return;
            items.push({ path: a.entry.path, name: a.entry.name, track: a.trackFinal,
                t: a.t, srcIn: a.srcIn, srcOut: a.srcOut, speed: a.speed || 1, needed: a.needed,
                // a demoted ramp is a dry cut — its label must not say RAMP
                label: (a.rampIn ? a.slot.label : a.slot.label.replace(/^RAMP > /, '')),
                type: a.slot.type, rampIn: !!a.rampIn });
        });
        var markers = match.assigns.map(function(a) {
            return { t: a.t, end: Math.round((a.t + a.needed) * 1000) / 1000,
                name: (a.rampIn ? 'RAMP>V' + a.trackFinal + ' ' : '') + a.slot.label.replace(/^RAMP > /, '') +
                    (a.entry ? '' : (a.coveredBy ? ' [HELD]' : ' [MISSING]')),
                comments: a.entry ? (a.entry.name + '  ' + a.srcIn.toFixed(2) + '-' + a.srcOut.toFixed(2) + 's' +
                    (a.speed === 0.5 ? '  50%' : '') + (a.note ? '  (' + a.note + ')' : '')) : a.note,
                color: a.entry ? (a.rampIn ? 3 : 6) : (a.coveredBy ? 5 : 1) };
        });
        return {
            sequenceName: 'Auto Assembly - ' + ((musicMeta.file || '').split('/').pop() || '').replace(/\.[^.]+$/, '') +
                ' ' + (grid.targetSec || '') + 's',
            builtAt: Date.now(), gridSeed: grid.seed,
            music: { path: musicMeta.file, inSec: grid.section.start, outSec: grid.section.end },
            tracksNeeded: Math.max.apply(null, items.map(function(i2) { return i2.track; }).concat([1])),
            stats: { slots: grid.slots.length, placed: items.length,
                missing: match.missing, fallbacks: match.fallbacks, clipsUsed: match.clipsUsed },
            items: items, markers: markers
        };
    }

    /* ── offline report ──────────────────────────────────────────────── */
    function renderAssemblyHtml(grid, match) {
        function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
        var rows = '';
        match.assigns.forEach(function(a, i) {
            var e = a.entry;
            var cls = e ? '' : ' style="color:#FF3B30"';
            rows += '<tr' + cls + '><td class="mono">' + (i + 1) + '</td><td class="mono">V' + a.slot.track + '</td>' +
                '<td class="mono">' + a.t.toFixed(2) + 's</td><td class="mono">' + a.slot.bars + '</td>' +
                '<td>' + esc(a.slot.label.replace(/^RAMP > /, (a.slot.rampIn ? '↗ ' : ''))) + '</td>' +
                '<td>' + (e ? esc(e.name) : '--') + '</td>' +
                '<td class="mono">' + (e ? a.srcIn.toFixed(2) + '-' + a.srcOut.toFixed(2) + 's' : '--') + '</td>' +
                '<td class="mono">' + (e ? ((a.srcOut - a.srcIn) >= a.needed - 0.05 ? 'ok' : '') : '') + ' ' + esc(a.note || '') + '</td></tr>';
        });
        return '<!doctype html><html><head><meta charset="utf-8"><title>Assembly - ' + esc((grid.file || '').split('/').pop()) + '</title>' +
            '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">' +
            '<style>body{background:#000;color:rgba(255,255,255,0.86);font-family:Inter,system-ui,sans-serif;font-size:14px;margin:0;padding:48px}' +
            'h1{font-weight:700;font-size:16px;text-transform:uppercase;letter-spacing:0.18em;margin:0 0 24px}' +
            'table{border-collapse:collapse}td,th{border-bottom:0.5px solid rgba(255,255,255,0.18);padding:5px 14px 5px 0;text-align:left;font-size:12px}' +
            'th{font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:rgba(255,255,255,0.55)}' +
            '.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}</style></head><body>' +
            '<h1>Auto Assembly plan</h1>' +
            '<div class="mono">' + match.assigns.length + ' slots / ' + (match.assigns.length - match.missing) + ' placed / ' +
            match.missing + ' missing / ' + match.fallbacks + ' fallbacks / ' + match.clipsUsed + ' clips</div>' +
            '<table><tr><th>#</th><th>Track</th><th>t</th><th>Bars</th><th>Slot</th><th>Clip</th><th>Src in-out</th><th>Notes</th></tr>' +
            rows + '</table></body></html>';
    }

    function runCli() {
        var fs = require('fs');
        if (process.argv[2] !== 'plan') {
            console.log('Usage: node js/autoAssembly.js plan');
            return;
        }
        var grid = JSON.parse(fs.readFileSync(CAL_DIR + '/lastCutGrid.json', 'utf8'));
        var music = JSON.parse(fs.readFileSync(CAL_DIR + '/lastMusic.json', 'utf8'));
        var entries = stagingEntries();
        var si2 = process.argv.indexOf('--seed');
        var seed = si2 > -1 ? parseInt(process.argv[si2 + 1], 10) : 1;
        var match = matchSlots(grid, entries, seed);
        if (match.fatal) { console.log('FATAL: ' + match.fatal); return; }
        var asm = buildAssembly(grid, match, music);
        asm.matchSeed = seed;
        fs.writeFileSync(CAL_DIR + '/lastAssembly.json', JSON.stringify(asm, null, 1));
        var repDir = CAL_DIR + '/musicReports';
        if (!fs.existsSync(repDir)) fs.mkdirSync(repDir, { recursive: true });
        var base = ((grid.file || 'track').split('/').pop()).replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '_');
        var rep = repDir + '/' + base + '.assembly.html';
        fs.writeFileSync(rep, renderAssemblyHtml(grid, match));
        match.assigns.forEach(function(a, i) {
            console.log('  ' + String(i + 1).padStart(2) + '  V' + (a.trackFinal || a.slot.track) + '  ' +
                ('    ' + a.t.toFixed(2)).slice(-6) + 's  ' +
                (a.rampIn ? 'RAMP> ' : '      ') + a.slot.label.replace(/^RAMP > /, '').padEnd(24).slice(0, 24) +
                (a.speed === 0.5 ? '50% ' : '    ') +
                (a.entry ? a.entry.name + '  ' + a.srcIn.toFixed(1) + '-' + a.srcOut.toFixed(1) + 's  ' +
                    (a.motion === 'push' ? 'PUSH' : a.motion === 'lateral' ? 'ORBT' : 'mix ') : '--') +
                (a.note ? '   [' + a.note + ']' : ''));
        });
        console.log('placed ' + asm.stats.placed + '/' + asm.stats.slots + ', missing ' + asm.stats.missing +
            ', fallbacks ' + asm.stats.fallbacks + ', clips ' + asm.stats.clipsUsed);
        console.log('Report: ' + rep);
    }

    if (IS_NODE) {
        module.exports = { stagingEntries: stagingEntries, matchSlots: matchSlots,
            buildAssembly: buildAssembly, renderAssemblyHtml: renderAssemblyHtml };
        if (require.main === module) runCli();
        return;
    }

    /* ── Panel wiring (CEP only) ─────────────────────────────────────── */
    /* ── Learn From Finished Project (pilot, v1) ────────────────────────
       With a FINISHED delivered project open and its final sequence active,
       extract every raw-clip trackItem's source window (in/out = the part
       of the clip that made the final cut). AE-linked ramp comps (.aep) are
       skipped — dry cuts are exactly where window-picking matters most.
       Labels accumulate in calibration/finishedLabels.json; the offline
       refit pipeline consumes them after motion analysis of those clips. */
    var finBtn = document.getElementById('prLearnFinished');
    if (finBtn) finBtn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { setStatus('Learn Finished only works in Premiere', 'error'); return; }
        finBtn.disabled = true;
        setStatus('Reading finished sequence...', 'busy');
        var jsx = '(function(){' +
            'var seq=app.project.activeSequence;' +
            'if(!seq)return JSON.stringify({error:"open the finished sequence first"});' +
            'var items=[],audio=[],skipped=0;' +
            // property clips live on V1 in delivered timelines — upper tracks
            // are graphics/adjustment layers/titles (Matheus, 10/jul)
            'if(seq.videoTracks.numTracks>0){var tr=seq.videoTracks[0];' +
            'for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];' +
            'try{var p=cl.projectItem?cl.projectItem.getMediaPath():"";' +
            'if(!p||!/\\.(mp4|mov|mxf|m4v)$/i.test(p)){skipped++;continue;}' +
            'items.push({path:p,name:cl.name,track:1,speed:1,' +
            'start:cl.start.seconds,srcIn:cl.inPoint.seconds,srcOut:cl.outPoint.seconds});' +
            '}catch(e){skipped++;}}}' +
            // in/out are TIMELINE-scaled on speed-changed clips (same gotcha
            // the O1-edit exporter handles): read the real QE speed multiplier
            // and convert both points back to true source seconds
            'try{app.enableQE();var qs=qe.project.getActiveSequence();var TPS=254016000000;' +
            'var qtr=qs.getVideoTrackAt(0);' +
            'if(qtr){for(var k=0;k<items.length;k++){' +
            'for(var qi=0;qi<qtr.numItems;qi++){var qc=qtr.getItemAt(qi);' +
            'try{if(qc&&qc.start&&Math.abs(qc.start.ticks/TPS-items[k].start)<0.021){' +
            'var sp=Math.abs(qc.speed);if(sp>0)items[k].speed=sp;break;}}catch(eq){}}' +
            'if(items[k].speed!==1){items[k].srcIn*=items[k].speed;items[k].srcOut*=items[k].speed;}}}' +
            '}catch(eqe){}' +
            // all audio items too: the longest file = the music (his section
            // choice + where cuts land on beats); short ones = SFX, kept for later
            'for(var at=0;at<seq.audioTracks.numTracks;at++){var atr=seq.audioTracks[at];' +
            'for(var ac=0;ac<atr.clips.numItems;ac++){var acl=atr.clips[ac];' +
            'try{var ap=acl.projectItem?acl.projectItem.getMediaPath():"";' +
            'if(!ap)continue;' +
            'audio.push({path:ap,name:acl.name,track:at+1,' +
            'start:acl.start.seconds,srcIn:acl.inPoint.seconds,srcOut:acl.outPoint.seconds});' +
            '}catch(ea){}}}' +
            'return JSON.stringify({ok:1,project:app.project.name,seq:seq.name,items:items,audio:audio,skipped:skipped});}())';
        evalScript(jsx, function(res) {
            finBtn.disabled = false;
            var r;
            try { r = JSON.parse(res); } catch (_) { r = { error: 'extract parse failed: ' + res }; }
            if (r.error) { setStatus(r.error, 'error'); return; }
            try {
                var fs = require('fs');
                var file = CAL_DIR + '/finishedLabels.json';
                var all = [];
                try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
                // one entry per project+sequence — re-extracting replaces it
                all = all.filter(function(x) { return !(x.project === r.project && x.seq === r.seq); });
                all.push({ project: r.project, seq: r.seq, extractedAt: Date.now(),
                    skippedLinked: r.skipped, items: r.items, audio: r.audio || [] });
                fs.writeFileSync(file, JSON.stringify(all, null, 1));
                setStatus('Learned ' + r.items.length + ' V1 windows + ' + (r.audio || []).length +
                    ' audio items from "' + r.seq + '" (' + r.skipped + ' skipped) — ' +
                    all.length + ' project(s) total', 'success');
            } catch (ew) { setStatus('could not save finishedLabels.json: ' + ew, 'error'); }
        });
    });

    var asmBtn = document.getElementById('prAutoAssemble');
    if (asmBtn) asmBtn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { setStatus('Auto Assemble only works in Premiere', 'error'); return; }
        var fs = require('fs');
        var grid, music, entries;
        try { music = JSON.parse(fs.readFileSync(CAL_DIR + '/lastMusic.json', 'utf8')); }
        catch (_) { setStatus('Run Analyze Music first', 'error'); return; }
        try { entries = stagingEntries(); }
        catch (_) { setStatus('Run Build Staging Sequence first (no lastPlan.json)', 'error'); return; }
        // the grid is rebuilt HERE on every click — it must be born from the
        // pool of THIS moment (stale grid = impossible slots = holes, the
        // 10/jul lesson), and a fresh grid seed = a new timeline variation
        if (typeof window !== 'undefined' && typeof window.dmBuildCutGrid === 'function') {
            grid = window.dmBuildCutGrid();
            if (grid && grid.error) { setStatus(grid.error, 'error'); return; }
        }
        if (!grid || !grid.slots) {
            try { grid = JSON.parse(fs.readFileSync(CAL_DIR + '/lastCutGrid.json', 'utf8')); }
            catch (_) { setStatus('Run Build Cut Grid first', 'error'); return; }
        }
        asmBtn.disabled = true;
        setStatus('Matching clips to the grid (grid seed ' + grid.seed + ')...', 'busy');
        var seed = Date.now() % 1000000;     // every click = a different edit
        var match = matchSlots(grid, entries, seed);
        if (match.fatal) { setStatus(match.fatal, 'error'); asmBtn.disabled = false; return; }
        var asm = buildAssembly(grid, match, music);
        asm.matchSeed = seed;
        asm.sequenceName += ' v' + seed;
        try { fs.writeFileSync(CAL_DIR + '/lastAssembly.json', JSON.stringify(asm, null, 1)); } catch (_) {}
        setStatus('Building timeline (' + asm.stats.placed + ' clips, V1-V' + asm.tracksNeeded + ')...', 'busy');

        var jsx = '(function(){' +
            'var d=' + JSON.stringify(JSON.stringify(asm)) + ';d=JSON.parse(d);' +
            'var byPath={};' +
            'function walk(bin){for(var i=0;i<bin.children.numItems;i++){var it=bin.children[i];' +
            'if(it.type===ProjectItemType.BIN)walk(it);else{try{var p=it.getMediaPath();if(p)byPath[p]=it;}catch(e){}}}}' +
            'walk(app.project.rootItem);' +
            'var firstPi=null;' +
            'for(var f=0;f<d.items.length;f++){if(byPath[d.items[f].path]){firstPi=byPath[d.items[f].path];break;}}' +
            'if(!firstPi)return JSON.stringify({error:"no assembly clips found in project"});' +
            'var seq=null;' +
            'try{seq=app.project.createNewSequenceFromClips(d.sequenceName,[firstPi]);}catch(e){return JSON.stringify({error:"createSeq: "+e});}' +
            'if(!seq)return JSON.stringify({error:"createSeq returned null"});' +
            // strip the seed clip
            'try{for(var vt=0;vt<seq.videoTracks.numTracks;vt++){var vTr=seq.videoTracks[vt];' +
            'for(var vc=vTr.clips.numItems-1;vc>=0;vc--){try{vTr.clips[vc].remove(false,false);}catch(e2){}}}}catch(e3){}' +
            'try{for(var at0=0;at0<seq.audioTracks.numTracks;at0++){var aTr0=seq.audioTracks[at0];' +
            'for(var ac0=aTr0.clips.numItems-1;ac0>=0;ac0--){try{aTr0.clips[ac0].remove(false,false);}catch(e4){}}}}catch(e5){}' +
            // grow the video track stack to the staircase height (QE)
            'var haveV=seq.videoTracks.numTracks;' +
            'if(haveV<d.tracksNeeded){try{app.enableQE();var qseq=qe.project.getActiveSequence();' +
            'qseq.addTracks(d.tracksNeeded-haveV,haveV,0,1,0,0,0);seq=app.project.activeSequence;}catch(eq){}}' +
            'var placed=0,failed=0,slowed=0;' +
            'try{app.enableQE();}catch(eq0){}' +
            'var TPS=254016000000;' +
            'for(var k=0;k<d.items.length;k++){var it2=d.items[k];var pi=byPath[it2.path];' +
            'if(!pi||it2.track>seq.videoTracks.numTracks){failed++;continue;}' +
            'try{pi.setInPoint(it2.srcIn,4);pi.setOutPoint(it2.srcOut,4);' +
            'seq.videoTracks[it2.track-1].overwriteClip(pi,it2.t);placed++;}catch(e6){failed++;}' +
            'try{pi.clearInPoint(4);pi.clearOutPoint(4);}catch(e7){}' +
            // slow THIS tight NOW, while the space to its right is still
            // empty — QE clamps the 2x expansion when the next clip already
            // sits on the boundary (13/jul comb timeline: isolated tights
            // expanded fine, run tights stayed at half). Expanding first and
            // letting the NEXT overwrite trim the boundary is deterministic.
            'if(it2.speed===0.5){try{var qs=qe.project.getActiveSequence();' +
            'var qtr=qs.getVideoTrackAt(it2.track-1);' +
            'if(qtr){for(var qi=0;qi<qtr.numItems;qi++){var qc=qtr.getItemAt(qi);' +
            'try{if(!qc||!qc.start)continue;' +
            'if(Math.abs(qc.start.ticks/TPS-it2.t)<0.021){' +
            // QE speed is a MULTIPLIER (0.5 = 50%) — same semantics the Warp
            // and O1-edit code rely on when READING qeClip.speed
            'try{qc.setSpeed(0.5,"",false,false,false);}catch(es1){try{qc.setSpeed(0.5);}catch(es2){}}' +
            'var okSp=false;try{okSp=Math.abs(Math.abs(qc.speed)-0.5)<0.01;}catch(es3){}' +
            'if(okSp)slowed++;' +
            'break;}}catch(eqi){}}}}catch(eqe){}}' +
            '}' +
            // clip audio drags along with overwriteClip: clear ALL audio, then lay the music
            'try{for(var at=0;at<seq.audioTracks.numTracks;at++){var aTr=seq.audioTracks[at];' +
            'for(var ac=aTr.clips.numItems-1;ac>=0;ac--){try{aTr.clips[ac].remove(false,false);}catch(e8){}}}}catch(e9){}' +
            'var mus=byPath[d.music.path],musOk=0,musErr="";' +
            'if(!mus){' +
            'var mbin=null;' +
            'for(var mb=0;mb<app.project.rootItem.children.numItems;mb++){var bb=app.project.rootItem.children[mb];' +
            'if(bb.type===ProjectItemType.BIN&&bb.name.toUpperCase().indexOf("04 MUSIC")===0){mbin=bb;break;}}' +
            'if(!mbin){try{mbin=app.project.rootItem.createBin("04 MUSIC");}catch(eb){mbin=app.project.rootItem;}}' +
            'try{app.project.importFiles([d.music.path],1,mbin,0);}catch(ei){musErr="import: "+ei;}' +
            'byPath={};walk(app.project.rootItem);mus=byPath[d.music.path];}' +
            'if(!mus&&!musErr)musErr="music item not found";' +
            'if(mus){try{mus.setInPoint(d.music.inSec,4);mus.setOutPoint(d.music.outSec,4);}catch(ep2){}' +
            'for(var atm=0;atm<seq.audioTracks.numTracks&&!musOk;atm++){' +
            'try{seq.audioTracks[atm].overwriteClip(mus,0);musOk=1;}catch(e10){musErr="A"+(atm+1)+": "+e10;}}' +
            'if(!musOk){try{app.enableQE();qe.project.getActiveSequence().addTracks(0,0,1,1,0,0,0);' +
            'seq=app.project.activeSequence;seq.audioTracks[0].overwriteClip(mus,0);musOk=1;}catch(e11){}}' +
            'try{mus.clearInPoint(4);mus.clearOutPoint(4);}catch(ecl2){}}' +
            'for(var m=0;m<d.markers.length;m++){var mm=d.markers[m];' +
            'try{var mo=seq.markers.createMarker(mm.t);' +
            'try{mo.name=mm.name;}catch(e11){}' +
            'if(mm.comments)try{mo.comments=mm.comments;}catch(e12){}' +
            'if(mm.end&&mm.end>mm.t)try{mo.end=mm.end;}catch(e13){}' +
            'if(typeof mo.setColorByIndex==="function")try{mo.setColorByIndex(mm.color);}catch(e14){}' +
            '}catch(e15){}}' +
            'return JSON.stringify({ok:1,placed:placed,failed:failed,music:musOk,musErr:musErr,slowed:slowed,tracks:seq.videoTracks.numTracks});}())';

        evalScript(jsx, function(res) {
            asmBtn.disabled = false;
            var r;
            try { r = JSON.parse(res); } catch (_) { r = { error: 'assembly parse failed: ' + res }; }
            if (r.error) { setStatus(r.error, 'error'); return; }
            var nT = asm.items.filter(function(x) { return x.speed === 0.5; }).length;
            var msg = 'Assembled v' + seed + ': ' + r.placed + ' clips on V1-V' + r.tracks +
                ', tights 50%: ' + (r.slowed || 0) + '/' + nT +
                (r.failed ? ', ' + r.failed + ' failed' : '') +
                (r.music ? ', music on A1' : ', MUSIC MISSING (' + (r.musErr || '?') + ')') +
                (asm.stats.missing ? ', ' + asm.stats.missing + ' slots empty (red markers)' : '');
            setStatus(msg, r.failed || !r.music ? 'error' : 'success');
        });
    });
})();
