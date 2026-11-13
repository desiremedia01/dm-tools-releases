/* DM Tools - Lumetri controls for Premiere Pro 27+
   Premiere 27 removed the Lumetri Color panel. This file lets the DM Tools panel
   drive the Lumetri Color effect of the selected clips directly.

   Numeric controls (Basic Correction, Creative) are ordinary effect parameters.
   Curves are opaque binary parameters that scripting cannot read or write, but the
   Lumetri "Blob" parameter (index 0) is UTF-8 XML with no null bytes: ExtendScript
   reads it whole (two bytes per UTF-16 unit) and setValue writes it back. Curves
   live there as text, value@position pairs:
     <ToneCurvesLuma>"cubic,value:0@0;1@1"</ToneCurvesLuma>      (also Red/Green/Blue)
     <SatSatCurve>"non-over-const,value:0@0;0@1"</SatSatCurve>
   Verified live on 27.0.0 by exporting frames before/after each write.

   dmLumetri('read')               -> state of the first selected clip that has Lumetri
   dmLumetri('set', index, value)  -> numeric parameter on every selected Lumetri
   dmLumetri('curve', tag, text)   -> curve text on every selected Lumetri
   dmLumetri('add')                -> add Lumetri Color to selected clips without one
   Returns "OK|..." or "ERR|message". */
function dmLumetri(cmd, a, b) {
    var NUMERIC = { 14: 'Temperature', 15: 'Tint', 16: 'Saturation', 19: 'Exposure', 20: 'Contrast',
        21: 'Highlights', 22: 'Shadows', 23: 'Whites', 24: 'Blacks',
        38: 'Intensity', 40: 'Faded Film', 41: 'Sharpen', 42: 'Vibrance', 43: 'Saturation' };
    var ORDER = [14, 15, 16, 19, 20, 21, 22, 23, 24, 38, 40, 41, 42, 43];
    /* QE addresses parameters by name and takes the FIRST match, so only controls whose
       first match is the right one can be committed natively (verified live). Creative
       Intensity (38) and Creative Saturation (43) are shadowed by earlier namesakes. */
    var QE_NAME = { 14: 'Temperature', 15: 'Tint', 16: 'Saturation', 19: 'Exposure', 20: 'Contrast',
        21: 'Highlights', 22: 'Shadows', 23: 'Whites', 24: 'Blacks', 40: 'Faded Film', 41: 'Sharpen', 42: 'Vibrance' };
    var CURVES = { ToneCurvesLuma: 1, ToneCurvesRed: 1, ToneCurvesGreen: 1, ToneCurvesBlue: 1, SatSatCurve: 1 };
    var CURVE_ORDER = ['ToneCurvesLuma', 'ToneCurvesRed', 'ToneCurvesGreen', 'ToneCurvesBlue', 'SatSatCurve'];

    function fail(msg) { return 'ERR|' + msg; }
    function num(n) {
        var s = (Math.round(n * 10000) / 10000).toString();
        return s === '-0' ? '0' : s;
    }
    function toBytes(v) {
        var out = [], i, c;
        for (i = 0; i < v.length; i++) { c = v.charCodeAt(i); out.push(String.fromCharCode(c & 255, c >> 8)); }
        return out.join('');
    }
    /* ExtendScript's regex engine is quadratic on /\s+$/ over a 14 KB string: trim by hand */
    function trimEnd(s) {
        var n = s.length, c;
        while (n > 0) { c = s.charCodeAt(n - 1); if (c !== 32 && c !== 10 && c !== 13 && c !== 9) break; n--; }
        return n === s.length ? s : s.substring(0, n);
    }
    /* XML tolerates the trailing newline used to pad an odd byte count */
    function toUnits(s) {
        s = trimEnd(s);
        if (s.length % 2) s += '\n';
        var parts = [], chunk = [], i;
        for (i = 0; i < s.length; i += 2) {
            chunk.push(s.charCodeAt(i) | (s.charCodeAt(i + 1) << 8));
            if (chunk.length === 400) { parts.push(String.fromCharCode.apply(null, chunk)); chunk = []; }
        }
        if (chunk.length) parts.push(String.fromCharCode.apply(null, chunk));
        return parts.join('');
    }
    function findLumetri(item) {
        var comps = item.components, i;
        if (!comps) return null;
        for (i = 0; i < comps.numItems; i++) if (comps[i].matchName === 'AE.ADBE Lumetri') return comps[i];
        return null;
    }
    /* A fresh Lumetri has an empty Blob and only serialises it when it renders, so it
       cannot be asked for one. Start from the default state Lumetri itself writes
       (assets/grade/lumetri-default.xml, captured from 27.0.0). Numeric parameters keep
       winning over the Blob's own copies of them: verified by frame comparison. */
    function template() {
        if (dmLumetri.template) return dmLumetri.template;
        var f = new File(new File($.fileName).parent.parent.fsName + '/assets/grade/lumetri-default.xml');
        if (!f.exists) return null;
        f.encoding = 'UTF-8';
        if (!f.open('r')) return null;
        var t = f.read(); f.close();
        if (t.indexOf('__DM_GUID__') < 0 || t.indexOf('</Lumetri>') < 0) return null;
        dmLumetri.template = trimEnd(t);
        return dmLumetri.template;
    }
    function guid() {
        function hex(n) { var s = ''; while (s.length < n) s += Math.floor(Math.random() * 16).toString(16); return s; }
        return hex(8) + '-' + hex(4) + '-11f1-' + hex(4) + '-' + hex(12);
    }
    function readBlob(lum, allowTemplate) {
        var p = lum.properties[0];
        if (!p || p.displayName !== 'Blob') return null;
        var v = p.getValue();
        if (typeof v === 'string' && v.length >= 50) {
            /* The Blob is usually exactly what this script read or wrote last: skip the decode */
            var c = dmLumetri.cache;
            if (c && c.units === v) return { param: p, text: c.text, fresh: false };
            var decoded = trimEnd(toBytes(v));
            dmLumetri.cache = { units: v, text: decoded };
            return { param: p, text: decoded, fresh: false };
        }
        if (!allowTemplate) return null;
        var t = template();
        if (!t) return null;
        return { param: p, text: t.replace('__DM_GUID__', guid()), fresh: true };
    }
    function tagValue(text, tag) {
        var open = '<' + tag + '>"', i = text.indexOf(open);
        if (i < 0) return null;
        var j = text.indexOf('"</' + tag + '>', i + open.length);
        return j < 0 ? null : text.substring(i + open.length, j);
    }
    function setTag(text, tag, value) {
        var open = '<' + tag + '>"', i = text.indexOf(open);
        if (i < 0) return null;
        var j = text.indexOf('"</' + tag + '>', i + open.length);
        if (j < 0) return null;
        return text.substring(0, i + open.length) + value + text.substring(j);
    }
    /* QE twin of a DOM track item: same track, same start (half-frame tolerance) */
    function qeClip(seq, item) {
        var tracks = seq.videoTracks, ti = -1, t, c;
        for (t = 0; t < tracks.numTracks && ti < 0; t++) {
            var clips = tracks[t].clips;
            for (c = 0; c < clips.numItems; c++) if (clips[c].nodeId === item.nodeId) { ti = t; break; }
        }
        if (ti < 0) return null;
        var qtrack = qe.project.getActiveSequence().getVideoTrackAt(ti), want = Number(item.start.ticks), q;
        for (q = 0; q < qtrack.numItems; q++) {
            var qi = qtrack.getItemAt(q);
            if (qi && qi.type === 'Clip' && Math.abs(Number(qi.start.ticks) - want) < 2000000000) return qi;
        }
        return null;
    }
    function qeLumetri(seq, item) {
        var qc = qeClip(seq, item), n;
        if (!qc) return null;
        for (n = 0; n < qc.numComponents; n++) { var comp = qc.getComponentAt(n); if (comp && comp.name === 'Lumetri Color') return comp; }
        return null;
    }
    function selection() {
        var seq = app.project.activeSequence;
        if (!seq) return null;
        var sel = seq.getSelection(), items = [], i;
        for (i = 0; sel && i < sel.length; i++) if (sel[i].mediaType === 'Video') items.push(sel[i]);
        return { seq: seq, items: items };
    }

    try {
        var s = selection();
        if (!s) return fail('No active sequence.');
        var items = s.items, lums = [], owners = [], missing = [], i, k;
        for (i = 0; i < items.length; i++) {
            var l = findLumetri(items[i]);
            if (l) { lums.push(l); owners.push(items[i]); } else missing.push(items[i]);
        }

        if (cmd === 'read') {
            if (!items.length) return 'OK|0|0';
            if (!lums.length) return 'OK|' + items.length + '|0';
            var P = lums[0].properties, nums = [];
            for (k = 0; k < ORDER.length; k++) {
                var np = P[ORDER[k]];
                if (!np || np.displayName !== NUMERIC[ORDER[k]]) return fail('Lumetri layout changed (' + ORDER[k] + ').');
                nums.push(ORDER[k] + '=' + num(Number(np.getValue())));
            }
            var out = ['OK', items.length, lums.length, nums.join(',')];
            var blob = readBlob(lums[0], false);
            for (k = 0; k < CURVE_ORDER.length; k++) {
                var cv = blob ? tagValue(blob.text, CURVE_ORDER[k]) : null;
                out.push(cv === null ? '' : cv);
            }
            /* identity of the selection, so the panel can drop its undo history on a new clip */
            var ids = []; for (k = 0; k < owners.length; k++) ids.push(owners[k].nodeId);
            out.push(ids.join(','));
            return out.join('|');
        }

        if (cmd === 'add') {
            if (!missing.length) return 'OK|0';
            app.enableQE();
            var qseq = qe.project.getActiveSequence();
            var fx = qe.project.getVideoEffectByName('Lumetri Color');
            if (!qseq || !fx) return fail('Lumetri Color effect was not found.');
            var added = 0;
            for (i = 0; i < missing.length; i++) {
                var target = qeClip(s.seq, missing[i]);
                if (target) { target.addVideoEffect(fx); added++; }
            }
            return 'OK|' + added;
        }

        if (!lums.length) return fail('Select a clip or adjustment layer that has Lumetri Color.');

        if (cmd === 'set') {
            var index = Number(a), value = Number(b);
            if (!NUMERIC[index] || isNaN(value)) return fail('Unknown control.');
            for (i = 0; i < lums.length; i++) {
                var param = lums[i].properties[index];
                if (!param || param.displayName !== NUMERIC[index]) return fail('Lumetri layout changed (' + index + ').');
                param.setValue(value, true);
            }
            return 'OK|' + lums.length;
        }

        /* A drag previews through 'set' (DOM writes create no Undo step in Premiere).
           'begin' remembers where each clip started; 'commit' puts each clip back there
           and writes the final value through QE, which creates one native Undo step. */
        if (cmd === 'begin') {
            var bi = Number(a), vals = [];
            if (!NUMERIC[bi]) return fail('Unknown control.');
            for (i = 0; i < lums.length; i++) vals.push(Number(lums[i].properties[bi].getValue()));
            dmLumetri.gesture = { index: bi, vals: vals };
            return 'OK|' + lums.length;
        }
        if (cmd === 'commit') {
            var ci = Number(a), after = Number(b), g = dmLumetri.gesture;
            if (!NUMERIC[ci] || isNaN(after)) return fail('Unknown control.');
            dmLumetri.gesture = null;
            var viaQE = 0, changed = 0;
            app.enableQE();
            for (i = 0; i < lums.length; i++) {
                var cp = lums[i].properties[ci];
                if (!cp || cp.displayName !== NUMERIC[ci]) return fail('Lumetri layout changed (' + ci + ').');
                var before = (g && g.index === ci && g.vals.length === lums.length) ? g.vals[i] : null;
                if (before !== null && Math.abs(before - after) < 0.00005) { cp.setValue(after, true); continue; }
                changed++;
                var qcomp = (QE_NAME[ci] && before !== null) ? qeLumetri(s.seq, owners[i]) : null;
                if (!qcomp) { cp.setValue(after, true); continue; }
                /* no UI refresh here: the frame must not flash back to the starting value */
                cp.setValue(before, false);
                var ok = false;
                try { ok = qcomp.setParamValue(QE_NAME[ci], String(after), '') !== false; } catch (eq) { ok = false; }
                if (ok && Math.abs(Number(cp.getValue()) - after) < 0.01) viaQE++;
                else cp.setValue(after, true);
            }
            return 'OK|' + lums.length + '|' + changed + '|' + viaQE + '|' + Number(qe.project.undoStackIndex());
        }
        /* Undo the native steps this panel created, only if nothing else sits above them */
        if (cmd === 'undo') {
            app.enableQE();
            var expect = Number(a), count = Number(b), u;
            if (Number(qe.project.undoStackIndex()) !== expect) return fail('Other Premiere edits came after this adjustment. Use Premiere Undo.');
            for (u = 0; u < count; u++) qe.project.undo();
            return 'OK|' + Number(qe.project.undoStackIndex());
        }

        if (cmd === 'curve') {
            var tag = String(a), text = String(b);
            if (!CURVES[tag]) return fail('Unknown curve.');
            if (!/^[a-z\-]+,value:[0-9eE@;.\-]+$/.test(text)) return fail('Invalid curve.');
            var done = 0;
            for (i = 0; i < lums.length; i++) {
                var bl = readBlob(lums[i], true);
                if (!bl) continue;
                var next = setTag(bl.text, tag, text);
                if (next === null) continue;
                if (tag === 'SatSatCurve') { var en = setTag(next, 'SatSatEnabled', '1'); if (en !== null) next = en; }
                /* Lumetri ignores the Blob's Sat vs Sat until the binary curve parameter has been
                   touched once. The write itself changes nothing on screen (scripting cannot
                   deliver the binary curve), but it arms the curve. Verified by frame comparison. */
                if (tag === 'SatSatCurve' && (bl.fresh || tagValue(bl.text, 'SatSatCurve') === 'non-over-const,value:0@0;0@1')) {
                    var arm = lums[i].properties[70];
                    if (arm && arm.displayName === 'Sat vs Sat') arm.setValue(String.fromCharCode(2, 0, 2, 0), true);
                }
                if (bl.fresh || next !== bl.text) {
                    var units = toUnits(next);
                    bl.param.setValue(units, true);
                    dmLumetri.cache = { units: units, text: trimEnd(next) };
                }
                done++;
            }
            if (!done) return fail('Could not read the Lumetri state of the selected clip.');
            return 'OK|' + done;
        }
        return fail('Unknown command.');
    } catch (e) {
        return fail(String(e) + (e && e.line ? ' (line ' + e.line + ')' : ''));
    }
}
dmLumetri.dmVersion = 7;
