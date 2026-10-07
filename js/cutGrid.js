/* ── Cut Grid — Phase 3 of the auto-assembly roadmap ────────────────────
   Consumes calibration/lastMusic.json (bar grid anchored on the drop) and
   the Desire montage recipe (MONTAGE_RECIPE.md) and produces the slot plan:
   which beats receive cuts, what goes in each slot (teaser tight, facade on
   the drop, wides/tights per area, ramps, outro drone) and the V-track
   staircase (each speed ramp bumps the clip to the track above).
   No clips are touched — the plan renders as colored markers on the music
   sequence (panel) and as an HTML strip (offline) for validation.
   All durations are in BEATS (4 per bar) on the real beat grid, so cuts
   stay locked to the music even when the tempo drifts.
   CLI:  node js/cutGrid.js build [--dur 60|90] [--d2n] [--seed 3]          */
(function() {
    var IS_NODE = (typeof document === 'undefined');

    var CAL_DIR = '/Users/desiremedia/Documents/DM_Tools_CEP/calibration';

    /* Recipe constants — see MONTAGE_RECIPE.md */
    var MAIN_AREAS = { living: 1, kitchen: 1, dining: 1, pool_bbq: 1, master_bedroom: 1, ensuite: 1 };
    var TOUR_ORDER = ['living', 'kitchen', 'dining', 'pool_bbq', 'balcony', 'master_bedroom',
        'ensuite', 'bedroom', 'bathroom', 'stairs', 'entertainment', 'study', 'garage'];
    var DEFAULT_AREAS = ['living', 'kitchen', 'dining', 'pool_bbq', 'master_bedroom', 'ensuite',
        'bedroom', 'bedroom', 'bedroom', 'bathroom', 'stairs'];
    var AREA_LABEL = { living: 'living', kitchen: 'kitchen', dining: 'dining', pool_bbq: 'pool',
        balcony: 'balcony', master_bedroom: 'master', ensuite: 'ensuite', bedroom: 'bedroom',
        bathroom: 'bathroom', stairs: 'stairs', entertainment: 'entertainment', study: 'study', garage: 'garage' };

    /* ── Learned pacing (calibration/pacingModel.json) ───────────────────
       Duration symbols sampled from Matheus's 84 delivered videos: buckets
       (section×energy) + order-2 Witten-Bell bigrams. Validated leave-one-
       out: perplexity 4.24 vs 8.60 of fixed rules, wins 84/84 videos. */
    var _pm = null;
    function pacing() {
        if (_pm !== null) return _pm;
        try { _pm = JSON.parse(require('fs').readFileSync(CAL_DIR + '/pacingModel.json', 'utf8')); }
        catch (_) { _pm = false; }
        return _pm;
    }
    var PACE_TEMP = 1.1;
    function sampleDur(rnd, sec, en, prev2, prev1, minS, maxS) {
        var pm = pacing();
        if (!pm) return null;
        var SYMS = pm.symbols;
        function cnt(tbl, key) { return (tbl && tbl[key]) || {}; }
        var uni = cnt(pm.unigrams, sec), un = 0, k;
        for (k in uni) un += uni[k];
        var bkt = cnt(pm.buckets, sec + '|' + en), bn = 0;
        for (k in bkt) bn += bkt[k];
        var big = cnt(pm.bigrams, sec + '|' + prev2 + '|' + prev1), gn = 0;
        for (k in big) gn += big[k];
        var probs = [], z = 0;
        SYMS.forEach(function(s) {
            if (s < minS || s > maxS) { probs.push(0); return; }
            var p0 = ((uni[s] || 0) + 0.5) / ((un || 1) + 0.5 * SYMS.length);
            var p1 = bn ? (bn / (bn + Object.keys(bkt).length)) * ((bkt[s] || 0) / bn) + (1 - bn / (bn + Object.keys(bkt).length)) * p0 : p0;
            var p2 = gn ? (gn / (gn + Object.keys(big).length)) * ((big[s] || 0) / gn) + (1 - gn / (gn + Object.keys(big).length)) * p1 : p1;
            var p = Math.pow(p2, 1 / PACE_TEMP);
            probs.push(p); z += p;
        });
        if (z <= 0) return null;
        var r = rnd() * z, acc = 0;
        for (var i = 0; i < SYMS.length; i++) {
            acc += probs[i];
            if (r <= acc) return SYMS[i];
        }
        return SYMS[SYMS.length - 1];
    }
    /* tights-run alternation from the corpus (63/22/8/3) — never fixed */
    function sampleTightRun(rnd) {
        var r = rnd();
        return r < 0.70 ? 1 : r < 0.90 ? 2 : r < 0.97 ? 3 : 4;
    }

    /* Deterministic PRNG — the "molho" must be reproducible per seed */
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
    function hashStr(s) {
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }

    /* ── beat grid inside the chosen section ────────────────────────── */
    /* Section start/end/drop are downbeats of the drop-anchored grid.
       beatsIn[k] = absolute time of beat k counted from section start. */
    function sectionBeats(music) {
        var beats = music.beats, sec = music.section;
        var startIdx = -1;
        for (var i = 0; i < beats.length; i++)
            if (Math.abs(beats[i] - sec.start) < 0.005) { startIdx = i; break; }
        if (startIdx < 0) return null;
        var out = [];
        for (var j = startIdx; j < beats.length && beats[j] <= sec.end + 0.005; j++) out.push(beats[j]);
        // make sure the section end itself is addressable as a boundary
        if (Math.abs(out[out.length - 1] - sec.end) > 0.005) out.push(sec.end);
        return out;
    }

    /* ── slot plan ───────────────────────────────────────────────────── */
    /* opts: { dayToNight, seed, areas } — areas = ordered cats present in
       the shoot (from staging lastPlan.json when available). */
    function buildCutGrid(music, opts) {
        opts = opts || {};
        var rnd = mulberry32(opts.seed != null ? opts.seed : hashStr(music.file || 'dm'));
        var beatsIn = sectionBeats(music);
        if (!beatsIn || beatsIn.length < 16) return { error: 'section beat grid too short' };
        var totalBeats = beatsIn.length - 1;
        var dropBeat = Math.round((music.section.drop - music.section.start) / (music.barDur / 4));
        // exact: find drop in beatsIn
        for (var di = 0; di < beatsIn.length; di++)
            if (Math.abs(beatsIn[di] - music.section.drop) < 0.005) { dropBeat = di; break; }

        var slots = [];
        function push(len, type, area, shot, rampIn, label) {
            if (shot === 'tight') usedT++; else if (shot === 'wide') usedW++;
            slots.push({ beatLen: len, type: type, area: area || '', shot: shot || '',
                rampIn: !!rampIn, label: label });
        }
        function tightsLeft() { return capT - usedT; }
        function widesLeft() { return capW - usedW; }

        /* learned-pacing chain state + energy terciles for conditioning */
        var chain = { p2: 0.5, p1: 0.5 };
        var terc = null;
        if (music.energyDb && music.energyDb.length) {
            var srt = music.energyDb.slice().sort(function(a, b) { return a - b; });
            terc = [srt[Math.floor(srt.length / 3)], srt[Math.floor(2 * srt.length / 3)]];
        }
        var cursorBeats = 0;
        function enAt() {
            if (!terc) return 1;
            var t = music.section.start + cursorBeats * music.barDur / 4;
            var e = music.energyDb[Math.min(music.energyDb.length - 1, Math.floor(t / music.hopSec))];
            return e < terc[0] ? 0 : (e < terc[1] ? 1 : 2);
        }
        function nextBeats(sec, minS, maxS, fallbackBeats) {
            var s = sampleDur(rnd, sec, enAt(), chain.p2, chain.p1, minS, maxS);
            if (s == null) return fallbackBeats;
            chain.p2 = chain.p1; chain.p1 = s;
            return Math.round(s * 4);
        }
        var _push = push;
        push = function(len, type, area, shot, rampIn, label) {
            cursorBeats += len;
            _push(len, type, area, shot, rampIn, label);
        };

        /* 1. INTRO (beats 0..dropBeat): teasers with LEARNED durations, then
           DRONE -> speed ramp -> FACADE landing exactly on the drop
           (recipe corrected 13/jul: the corpus showed the ramped drone's
           usable part crossing the drop; the facade settles ON it). */
        var hasDrone = true, poolW = 99, poolT = 99;
        try {
            var ents = stagingEntries();
            hasDrone = ents.some(function(e2) { return e2.cat === 'drone_aerial'; });
            var seenP = {};
            poolW = 0; poolT = 0;
            ents.forEach(function(e2) {
                if (seenP[e2.path]) return;
                seenP[e2.path] = 1;
                if (e2.shot === 'tight') poolT++; else poolW++;
            });
        } catch (_) {}
        // the grid never demands more clips than the pool can supply
        // (clips are never repeated) — leave review headroom at 80%
        var capW = Math.max(6, Math.floor(poolW * 0.8));
        var capT = Math.max(6, Math.floor(poolT * 0.8));
        var usedW = 0, usedT = 0;
        var droneBeats = 0;
        if (dropBeat >= 10 && hasDrone) droneBeats = (rnd() < 0.5 ? 4 : 8);
        var left = dropBeat - droneBeats;
        var introLens = [];
        while (left > 0) {
            var lenB = nextBeats('intro', 0.25, 1.0, left <= 2 ? left : 2);
            if (lenB > left) lenB = left;
            introLens.push(lenB);
            left -= lenB;
        }
        introLens.forEach(function(lenB, k) {
            push(lenB, 'teaser', '', 'tight', false,
                'TEASER ' + (k + 1) + ' (tight/drone)');
        });
        if (droneBeats > 0)
            push(droneBeats, 'intro-drone', 'drone_aerial', 'wide', false, 'INTRO DRONE');

        /* 2. DROP = front facade WIDE, ramped in from the intro drone.
           Day-to-night variant: day facade on the drop, night facade next. */
        var facadeRamp = droneBeats > 0;
        if (opts.dayToNight) {
            push(4, 'drop-facade', 'facade', 'wide', facadeRamp, (facadeRamp ? 'RAMP > ' : '') + 'DROP: FACADE (day)');
            push(4, 'facade-night', 'facade', 'wide', false, 'FACADE (night)');
        } else {
            push(4, 'drop-facade', 'facade', 'wide', facadeRamp, (facadeRamp ? 'RAMP > ' : '') + 'DROP: FACADE');
        }

        /* 3. OUTRO reserved: closing drone 2-3 bars, ramp in, settles on END */
        var outroBeats = 8 + (rnd() < 0.5 ? 4 : 0);        // 2 or 3 bars

        /* 4. TOUR fills what remains. First area enters via speed ramp
           (recipe: ramp from facade into the main part of the house). */
        var used = 0;
        slots.forEach(function(s) { used += s.beatLen; });
        var tourBeats = totalBeats - used - outroBeats;
        if (tourBeats < 8) return { error: 'not enough beats for a tour (section too short)' };

        var areas = (opts.areas && opts.areas.length ? opts.areas : DEFAULT_AREAS.slice());
        var ordered = [];
        TOUR_ORDER.forEach(function(cat) {
            areas.forEach(function(a) { if (a === cat) ordered.push(a); });
        });
        /* Recipe: ramps happen ONLY between two wides (adjacent). Tights
           live ONLY inside bridge transitions: W_A > T_A > T_B > W_B.
           Secondary rooms (no tights) join by plain cuts (or a ramp).
           Chain = one wide per area + the transitions between them. */
        var budget = tourBeats;
        // how many areas fit at minimum cost (1-bar wide each, ramp/cut joins)
        var nFit = Math.min(ordered.length, Math.floor(budget / 4));
        var tour = ordered.slice(0, nFit);
        if (!tour.length) return { error: 'no tour areas fit the budget' };
        budget -= tour.length * 4;
        // transitions between consecutive areas
        var trans = [];   // trans[i] joins tour[i] -> tour[i+1]
        for (var ti = 0; ti < tour.length - 1; ti++) trans.push({ type: null, tights: [] });
        function addTights(t2, sideArea, minOne) {
            // alternation from the corpus (1:63% 2:22% 3:8% 4:3%) — never fixed
            var n = sampleTightRun(rnd);
            if (minOne && n < 1) n = 1;
            for (var k = 0; k < n && budget >= 1; k++) {
                var lenT = Math.min(budget, nextBeats('tour', 0.25, 0.75, (budget >= 2 && rnd() < 0.5) ? 2 : 1));
                t2.tights.push({ area: sideArea, len: lenT });
                budget -= lenT;
            }
        }
        // guarantee pass: the hero areas ALWAYS show tights (recipe rule) —
        // force a bridge on an adjacent transition for each of them
        var MUST_TIGHT = { living: 1, kitchen: 1, pool_bbq: 1, master_bedroom: 1 };
        tour.forEach(function(area2, i4) {
            if (!MUST_TIGHT[area2] || budget < 1) return;
            var tIdx = (i4 < trans.length) ? i4 : i4 - 1;   // prefer outgoing, else incoming
            if (tIdx < 0) return;
            var t3 = trans[tIdx];
            var already = t3.tights.some(function(tg2) { return tg2.area === area2; });
            if (already) return;
            t3.type = 'bridge';
            addTights(t3, area2, true);
        });
        // variation pass: remaining transitions
        for (var tj = 0; tj < trans.length; tj++) {
            var t4 = trans[tj];
            var bothMain = MAIN_AREAS[tour[tj]] && MAIN_AREAS[tour[tj + 1]];
            if (t4.type === 'bridge') {
                // complete the bridge: the other side gets tights too when main
                [tour[tj], tour[tj + 1]].forEach(function(sideArea2) {
                    if (!MAIN_AREAS[sideArea2] || budget < 1) return;
                    if (t4.tights.some(function(tg3) { return tg3.area === sideArea2; })) return;
                    if (rnd() < 0.7) addTights(t4, sideArea2, false);
                });
                // keep W_A > T_A > T_B > W_B ordering
                t4.tights.sort(function(x2, y2) {
                    return (x2.area === tour[tj] ? 0 : 1) - (y2.area === tour[tj] ? 0 : 1);
                });
                continue;
            }
            if (tour[tj] === 'bedroom' && tour[tj + 1] === 'bedroom') {
                t4.type = 'ramp';   // recipe: the end-of-video bedroom run is a ramp chain
            } else if (bothMain && budget >= 2 && rnd() >= 0.35) {
                // bridge: ONE sampled tights-run (corpus 1:63% 2:22% 3:8%),
                // split A-side then B-side — alternation, never fixed counts
                t4.type = 'bridge';
                var nRun = sampleTightRun(rnd);
                for (var kr = 0; kr < nRun && budget >= 1; kr++) {
                    var sideA2 = kr < Math.ceil(nRun / 2) ? tour[tj] : tour[tj + 1];
                    var lenT2 = Math.min(budget, nextBeats('tour', 0.25, 0.75, 1));
                    t4.tights.push({ area: sideA2, len: lenT2 });
                    budget -= lenT2;
                }
            } else {
                t4.type = (bothMain || rnd() < 0.3) ? 'ramp' : 'cut';
            }
        }
        // wide durations from the learned model (>=0.75 bar symbols); the
        // base 4-beat reservation is adjusted by the sampled value
        var wideLen = tour.map(function() {
            var b = nextBeats('tour', 0.5, 2.0, 4);
            return b;
        });
        wideLen.forEach(function(b) { budget -= (b - 4); });
        if (budget < 0) {   // sampled long: shrink the longest wides back
            var order2 = wideLen.map(function(b, i5) { return [b, i5]; }).sort(function(x, y) { return y[0] - x[0]; });
            for (var oi = 0; oi < order2.length && budget < 0; oi++) {
                var give = Math.min(order2[oi][0] - 3, -budget);
                if (give > 0) { wideLen[order2[oi][1]] -= give; budget += give; }
            }
        }
        // leftover becomes CONTENT, not a bloated closing: (1) outro caps at
        // 4 bars total, (2) excess feeds extra tights into existing bridges
        var outroCap = 16;
        var toOutro = Math.min(Math.max(0, budget), Math.max(0, outroCap - outroBeats));
        outroBeats += toOutro; budget -= toOutro;
        // pool-aware leftovers: EXTRA AREAS then extra bridge tights, always
        // within what the (no-repeat) clip pool can actually supply
        var plannedW = tour.length + 2 + (droneBeats > 0 ? 1 : 0);   // wides so far (+facade+closing)
        var plannedT = introLens.length;
        trans.forEach(function(t6) { plannedT += t6.tights.length; });
        var unusedAreas = ordered.slice(tour.length);
        if (!unusedAreas.length) unusedAreas = ordered.slice(0, 6);   // revisit hero areas (different clips)
        while (budget >= 4 && unusedAreas.length && plannedW < capW) {
            var exArea = unusedAreas.shift();
            var exW = Math.min(budget, nextBeats('tour', 0.5, 2.0, 4));
            tour.push(exArea); wideLen.push(exW);
            trans.push({ type: 'cut', tights: [] });
            budget -= exW; plannedW++;
        }
        var guardX = 24;
        while (budget >= 1 && plannedT < capT && guardX-- > 0) {
            var fed = false;
            for (var bx = 0; bx < trans.length && budget >= 1 && plannedT < capT; bx++) {
                if (trans[bx].type !== 'bridge' || trans[bx].tights.length >= 5) continue;
                var lenX = Math.min(budget, nextBeats('tour', 0.25, 0.75, 1));
                trans[bx].tights.push({ area: tour[MAIN_AREAS[tour[bx]] ? bx : bx + 1], len: lenX });
                budget -= lenX; fed = true; plannedT++;
            }
            if (!fed) break;
        }
        outroBeats += Math.max(0, budget);   // truly indivisible remainder

        /* emit the chain — first area always enters on a ramp from the
           facade wide (wide > ramp > wide: legal by construction) */
        push(wideLen[0], 'wide', tour[0], 'wide', true, 'RAMP > W ' + (AREA_LABEL[tour[0]] || tour[0]));
        for (var ci = 1; ci < tour.length; ci++) {
            var tr = trans[ci - 1];
            if (tr.type === 'bridge') tr.tights.forEach(function(tg) {
                push(tg.len, 'tight', tg.area, 'tight', false, 'T ' + (AREA_LABEL[tg.area] || tg.area));
            });
            push(wideLen[ci], 'wide', tour[ci], 'wide', tr.type === 'ramp',
                (tr.type === 'ramp' ? 'RAMP > ' : '') + 'W ' + (AREA_LABEL[tour[ci]] || tour[ci]));
        }

        /* 5. OUTRO: closing drone rides a ramp and settles on END. Recipe
           says closing = 2-3 bars — bigger leftovers become pre-closing
           exterior wides instead of one unfillable mega-slot. */
        while (outroBeats > 10 && plannedW < capW) {
            var preB = Math.min(outroBeats - 8, 8);
            push(preB, 'closing-wide', 'facade', 'wide', false, 'PRE-CLOSING (exterior wide)');
            outroBeats -= preB; plannedW++;
        }
        push(outroBeats, 'outro-drone', 'drone_aerial', 'wide', true,
            'RAMP > CLOSING DRONE (settles on END)');

        /* materialize times + track staircase (validated on a real project):
           a ramped clip carries its FULL usable part (leftover tail past the
           musical slot), so it climbs one track AND the following chain
           climbs again to run on top of that tail. The clip BEFORE a ramp
           also keeps a tail underneath the incoming clip. */
        var beatCursor = 0, track = 1;
        slots.forEach(function(s, i2) {
            var prev = slots[i2 - 1];
            if (s.rampIn || (prev && prev.rampIn)) track++;
            s.track = track;
            s.fullUsable = !!s.rampIn;                     // place whole usable part in phase 4
            if (s.rampIn && prev) prev.fullUsableTail = true;   // predecessor keeps its tail under
            s.beatStart = beatCursor;
            s.tAbs = beatsIn[Math.min(beatCursor, beatsIn.length - 1)];
            beatCursor += s.beatLen;
            s.tEnd = beatsIn[Math.min(beatCursor, beatsIn.length - 1)];
            s.bars = s.beatLen / 4;
        });

        return {
            file: music.file, bpm: music.bpm, barDur: music.barDur,
            targetSec: music.targetSec, seed: opts.seed != null ? opts.seed : hashStr(music.file || 'dm'),
            dayToNight: !!opts.dayToNight,
            section: music.section, totalBeats: totalBeats, dropBeat: dropBeat,
            tracksUsed: track, slots: slots
        };
    }

    /* areas actually present in the shoot, from the staging plan.
       Older lastPlan.json runs lack `cat` — recover it from visionCache
       (keyed path|size|mtime, value {cat, shot}). bedroom/bathroom repeat
       once per distinct clip (distinct clip ≈ distinct room), capped. */
    function stagingEntries() {
        var fs = require('fs');
        var plan = JSON.parse(fs.readFileSync(CAL_DIR + '/lastPlan.json', 'utf8'));
        var byPath = {};
        try {
            var vc = JSON.parse(fs.readFileSync(CAL_DIR + '/visionCache.json', 'utf8'));
            Object.keys(vc).forEach(function(k) { byPath[k.split('|')[0]] = vc[k]; });
        } catch (_) {}
        return (plan.entries || []).map(function(e) {
            var cat = e.cat || (byPath[e.path] && byPath[e.path].cat) || 'other';
            return { path: e.path, name: e.name, shot: e.shot, cat: cat,
                start: e.start, end: e.end, dur: e.end - e.start };
        });
    }
    var REPEAT_CAP = { bedroom: 3, bathroom: 2 };
    function areasFromLastPlan() {
        try {
            var entries = stagingEntries();
            var clipsByCat = {};
            entries.forEach(function(e) {
                if (e.cat === 'facade' || e.cat === 'drone_aerial' || e.cat === 'other') return;
                if (!clipsByCat[e.cat]) clipsByCat[e.cat] = {};
                clipsByCat[e.cat][e.path] = 1;
            });
            var out = [];
            Object.keys(clipsByCat).forEach(function(cat) {
                var n = REPEAT_CAP[cat] ? Math.min(REPEAT_CAP[cat], Object.keys(clipsByCat[cat]).length) : 1;
                for (var i = 0; i < n; i++) out.push(cat);
            });
            return out.length ? out : null;
        } catch (_) { return null; }
    }

    /* ── HTML strip: slot lanes over the energy curve ────────────────── */
    var TYPE_COLOR = {
        'teaser': '#34C759', 'drop-facade': '#FF3B30', 'facade-night': '#FF6B60',
        'wide': '#4A90D9', 'tight': '#39C0C8', 'outro-drone': '#AF52DE'
    };
    function renderGridHtml(grid, music) {
        var W = 1240, laneH = 34, H = 150;
        var sec = grid.section, dur = sec.end - sec.start;
        function X(t) { return ((t - sec.start) / dur * W).toFixed(1); }
        var E = music.energyDb || [], hop = music.hopSec || 0.25;
        var i0 = Math.floor(sec.start / hop), i1 = Math.ceil(sec.end / hop);
        var eMin = Infinity, eMax = -Infinity;
        for (var i = i0; i < Math.min(i1, E.length); i++) { if (E[i] < eMin) eMin = E[i]; if (E[i] > eMax) eMax = E[i]; }
        var pts = [];
        for (var j = i0; j < Math.min(i1, E.length); j++)
            pts.push(X(j * hop) + ',' + (H - 8 - ((E[j] - eMin) / (eMax - eMin || 1)) * (H - 20)).toFixed(1));
        var lanes = grid.tracksUsed;
        var stripH = lanes * laneH + 16;
        // V1 at the BOTTOM, climbing up — matches the Premiere timeline
        function laneY(track) { return H + 8 + (lanes - track) * laneH; }
        var svg = '<svg viewBox="0 0 ' + W + ' ' + (H + stripH + 40) + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;background:#0E0E0E">';
        svg += '<defs><pattern id="tail" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
            '<line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"/></pattern></defs>';
        svg += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1"/>';
        svg += '<line x1="' + X(sec.drop) + '" y1="0" x2="' + X(sec.drop) + '" y2="' + (H + stripH) + '" stroke="#FF3B30" stroke-width="1.5"/>';
        svg += '<line x1="' + X(sec.fadeStart) + '" y1="0" x2="' + X(sec.fadeStart) + '" y2="' + (H + stripH) + '" stroke="#FF9500" stroke-width="1"/>';
        var secW = W / (sec.end - sec.start);
        grid.slots.forEach(function(s) {
            var y = laneY(s.track);
            var x = parseFloat(X(s.tAbs)), w = parseFloat(X(s.tEnd)) - x;
            var col = TYPE_COLOR[s.type] || '#888';
            // leftover tail: full usable part extends past the musical slot
            // (indicative length — real length depends on the clip, phase 4)
            var tailSec = s.fullUsable ? grid.barDur * 2 : (s.fullUsableTail ? grid.barDur * 0.75 : 0);
            if (tailSec) {
                var tw = Math.min(tailSec * secW, W - (x + w));
                svg += '<rect x="' + (x + w - 1) + '" y="' + y + '" width="' + Math.max(0, tw) + '" height="' + (laneH - 6) +
                    '" fill="url(#tail)" stroke="' + col + '" stroke-opacity="0.4" stroke-width="0.5" stroke-dasharray="3 2"/>';
            }
            svg += '<rect x="' + x + '" y="' + y + '" width="' + Math.max(1, w - 1) + '" height="' + (laneH - 6) +
                '" fill="' + col + '" fill-opacity="0.28" stroke="' + col + '" stroke-width="1"/>';
            if (s.rampIn) svg += '<text x="' + (x + 2) + '" y="' + (y + 12) + '" fill="#FF9500" font-size="10">&#8599;</text>';
            if (w > 26) svg += '<text x="' + (x + (s.rampIn ? 12 : 3)) + '" y="' + (y + laneH - 13) +
                '" fill="rgba(255,255,255,0.86)" font-size="9">' + s.label.replace(/RAMP > /, '') + '</text>';
        });
        for (var lt = 1; lt <= lanes; lt++)
            svg += '<text x="2" y="' + (laneY(lt) + 12) + '" fill="rgba(255,255,255,0.4)" font-size="9">V' + lt + '</text>';
        for (var b = 0; b <= grid.totalBeats; b += 4) {
            var bx = X(sec.start + b * grid.barDur / 4);
            svg += '<line x1="' + bx + '" y1="' + H + '" x2="' + bx + '" y2="' + (H + stripH) + '" stroke="rgba(255,255,255,0.08)" stroke-width="0.5"/>';
        }
        svg += '</svg>';
        function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
        var rows = '';
        grid.slots.forEach(function(s, si) {
            rows += '<tr><td class="mono">' + (si + 1) + '</td><td class="mono">V' + s.track + '</td>' +
                '<td class="mono">' + (s.tAbs - sec.start).toFixed(2) + 's</td><td class="mono">' + s.bars + ' bar' + (s.bars !== 1 ? 's' : '') + '</td>' +
                '<td>' + esc(s.label) + '</td><td>' + (s.rampIn ? 'RAMP' : 'cut') + '</td></tr>';
        });
        return '<!doctype html><html><head><meta charset="utf-8"><title>Cut Grid - ' + esc((grid.file || '').split('/').pop()) + '</title>' +
            '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">' +
            '<style>body{background:#000;color:rgba(255,255,255,0.86);font-family:Inter,system-ui,sans-serif;font-size:14px;margin:0;padding:48px}' +
            'h1{font-weight:700;font-size:16px;text-transform:uppercase;letter-spacing:0.18em;margin:0 0 24px}' +
            '.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:rgba(255,255,255,0.55);margin:32px 0 8px}' +
            'table{border-collapse:collapse}td,th{border-bottom:0.5px solid rgba(255,255,255,0.18);padding:5px 14px 5px 0;text-align:left;font-size:12px}' +
            'th{font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:rgba(255,255,255,0.55)}' +
            '.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}</style></head><body>' +
            '<h1>Cut Grid -- ' + esc((grid.file || '').split('/').pop()) + '</h1>' +
            '<div class="mono">' + grid.bpm.toFixed(1) + ' BPM / ' + grid.targetSec + 's / ' + (grid.totalBeats / 4) + ' bars / ' +
            grid.slots.length + ' slots / tracks V1-V' + grid.tracksUsed + ' / seed ' + grid.seed +
            (grid.dayToNight ? ' / DAY-TO-NIGHT' : '') + '</div>' +
            '<div class="eyebrow">Energy + slot lanes (V-track staircase) -- red line = DROP, orange = FADE</div>' + svg +
            '<div class="eyebrow">Slots</div><table><tr><th>#</th><th>Track</th><th>Start</th><th>Len</th><th>Slot</th><th>In</th></tr>' + rows + '</table>' +
            '</body></html>';
    }

    /* ── marker plan for the music sequence (panel, phase 3 deliverable) ─ */
    /* Premiere marker colors: 0 Green 1 Red 2 Purple 3 Orange 4 Yellow 5 White 6 Blue 7 Cyan */
    var TYPE_MARKER = { 'teaser': 0, 'drop-facade': 1, 'facade-night': 1, 'wide': 6, 'tight': 7, 'outro-drone': 2 };
    function buildGridMarkers(grid) {
        var sec = grid.section, out = [];
        grid.slots.forEach(function(s) {
            out.push({ t: Math.round((s.tAbs - sec.start) * 1000) / 1000,
                end: Math.round((s.tEnd - sec.start) * 1000) / 1000,
                name: (s.rampIn ? 'RAMP>V' + s.track + ' ' : '') + s.label.replace(/^RAMP > /, ''),
                comments: s.bars + ' bars / track V' + s.track,
                color: s.rampIn ? 3 : (TYPE_MARKER[s.type] != null ? TYPE_MARKER[s.type] : 5) });
        });
        return out;
    }

    function loadLastMusic() {
        return JSON.parse(require('fs').readFileSync(CAL_DIR + '/lastMusic.json', 'utf8'));
    }

    function runCli() {
        var fs = require('fs');
        var args = process.argv.slice(2);
        if (args[0] !== 'build') {
            console.log('Usage: node js/cutGrid.js build [--d2n] [--seed N] [--music <lastMusic.json>]');
            return;
        }
        var mi = args.indexOf('--music');
        var music = mi > -1 ? JSON.parse(fs.readFileSync(args[mi + 1], 'utf8')) : loadLastMusic();
        var si = args.indexOf('--seed');
        var grid = buildCutGrid(music, {
            dayToNight: args.indexOf('--d2n') > -1,
            seed: si > -1 ? parseInt(args[si + 1], 10) : undefined,
            areas: areasFromLastPlan()
        });
        if (grid.error) { console.log('ERROR: ' + grid.error); return; }
        fs.writeFileSync(CAL_DIR + '/lastCutGrid.json', JSON.stringify(grid, null, 1));
        var base = (grid.file.split('/').pop() || 'track').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '_');
        var repDir = CAL_DIR + '/musicReports';
        if (!fs.existsSync(repDir)) fs.mkdirSync(repDir, { recursive: true });
        var out = repDir + '/' + base + '.grid.html';
        fs.writeFileSync(out, renderGridHtml(grid, music));
        console.log(grid.slots.length + ' slots / ' + (grid.totalBeats / 4) + ' bars / tracks V1-V' + grid.tracksUsed + ' / seed ' + grid.seed);
        grid.slots.forEach(function(s, i2) {
            console.log('  ' + String(i2 + 1).padStart(2) + '  V' + s.track + '  ' +
                ('    ' + (s.tAbs - grid.section.start).toFixed(2)).slice(-6) + 's  ' +
                (s.bars + ' bar' + (s.bars !== 1 ? 's ' : '  ')) + ' ' + (s.rampIn ? 'RAMP> ' : '      ') + s.label);
        });
        console.log('Grid HTML: ' + out);
    }

    if (IS_NODE) {
        module.exports = { buildCutGrid: buildCutGrid, buildGridMarkers: buildGridMarkers,
            renderGridHtml: renderGridHtml, areasFromLastPlan: areasFromLastPlan,
            stagingEntries: stagingEntries, sectionBeats: sectionBeats };
        if (require.main === module) runCli();
        return;
    }

    /* ── Panel wiring (CEP only) ─────────────────────────────────────── */
    /* Compute half of the grid build, callable by Auto Assemble: fresh seed
       (= new "molho" variation) from the CURRENT pool, persisted to
       lastCutGrid.json. The markers-on-music-sequence half stays with the
       manual button — it is a preview tool, not part of assembling. */
    window.dmBuildCutGrid = function() {
        var fs = require('fs');
        var music;
        try { music = JSON.parse(fs.readFileSync(CAL_DIR + '/lastMusic.json', 'utf8')); }
        catch (_) { return { error: 'Run Analyze Music first (no lastMusic.json)' }; }
        var grid = buildCutGrid(music, { seed: Date.now() % 1000000, areas: areasFromLastPlan() });
        if (grid.error) return { error: 'Cut grid: ' + grid.error };
        try { fs.writeFileSync(CAL_DIR + '/lastCutGrid.json', JSON.stringify(grid, null, 1)); } catch (_) {}
        return grid;
    };
    var gridBtn = document.getElementById('prCutGrid');
    if (gridBtn) gridBtn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { setStatus('Cut Grid only works in Premiere', 'error'); return; }
        var fs = require('fs');
        var music;
        try { music = JSON.parse(fs.readFileSync(CAL_DIR + '/lastMusic.json', 'utf8')); }
        catch (_) { setStatus('Run Analyze Music first (no lastMusic.json)', 'error'); return; }
        gridBtn.disabled = true;
        setStatus('Building cut grid...', 'busy');
        var grid = window.dmBuildCutGrid();
        if (grid.error) { setStatus(grid.error, 'error'); gridBtn.disabled = false; return; }
        var payload = { seqName: music.sequenceName || '', markers: buildGridMarkers(grid) };
        var jsx = '(function(){' +
            'var d=' + JSON.stringify(JSON.stringify(payload)) + ';d=JSON.parse(d);' +
            'var seq=null;' +
            'if(d.seqName){for(var i=0;i<app.project.sequences.numSequences;i++){' +
            'if(app.project.sequences[i].name===d.seqName){seq=app.project.sequences[i];break;}}}' +
            'if(!seq)seq=app.project.activeSequence;' +
            'if(!seq)return JSON.stringify({error:"music sequence not found — open it or run Analyze Music"});' +
            // clear existing markers (the beat grid gives way to the slot plan)
            'try{var mk=seq.markers.getFirstMarker();while(mk){var nx=null;try{nx=seq.markers.getNextMarker(mk);}catch(en){}' +
            'try{seq.markers.deleteMarker(mk);}catch(ed){}mk=nx;}}catch(ec){}' +
            'var n=0;' +
            'for(var m=0;m<d.markers.length;m++){var mm=d.markers[m];' +
            'try{var mo=seq.markers.createMarker(mm.t);' +
            'try{mo.name=mm.name;}catch(e1){}' +
            'if(mm.comments)try{mo.comments=mm.comments;}catch(e2){}' +
            'if(mm.end&&mm.end>mm.t)try{mo.end=mm.end;}catch(e3){}' +
            'if(typeof mo.setColorByIndex==="function")try{mo.setColorByIndex(mm.color);}catch(e4){}' +
            'n++;}catch(e5){}}' +
            'return JSON.stringify({ok:1,markers:n,seq:seq.name});}())';
        evalScript(jsx, function(res) {
            gridBtn.disabled = false;
            var r;
            try { r = JSON.parse(res); } catch (_) { r = { error: 'cut grid parse failed: ' + res }; }
            if (r.error) { setStatus(r.error, 'error'); return; }
            setStatus('Cut grid on "' + r.seq + '": ' + grid.slots.length + ' slots, V1-V' + grid.tracksUsed +
                ', seed ' + grid.seed + ' — click again for a new variation', 'success');
        });
    });
})();
