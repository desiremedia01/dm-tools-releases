/* Lumetri overlay (Premiere Pro 27+): Basic Correction, RGB Curves and
   Sat vs Sat for the selected clips, driven through jsx/dm-lumetri.jsx.
   Premiere 27 removed the Lumetri Color panel; this brings the same controls back.
   One script call in flight at a time; each control keeps only its latest value.
   Nothing is polled while the overlay is closed. */
(function () {
    'use strict';
    var POLL_MS = 1000, DEFAULT_RANGE = 0.15;
    var BASIC = [
        { i: 14, label: 'Temperature', min: -100, max: 100, step: 1, def: 0 },
        { i: 15, label: 'Tint', min: -100, max: 100, step: 1, def: 0 },
        { i: 16, label: 'Saturation', min: 0, max: 200, step: 1, def: 100 },
        { i: 19, label: 'Exposure', min: -5, max: 5, step: 0.05, def: 0 },
        { i: 20, label: 'Contrast', min: -100, max: 100, step: 1, def: 0 },
        { i: 21, label: 'Highlights', min: -100, max: 100, step: 1, def: 0 },
        { i: 22, label: 'Shadows', min: -100, max: 100, step: 1, def: 0 },
        { i: 23, label: 'Whites', min: -100, max: 100, step: 1, def: 0 },
        { i: 24, label: 'Blacks', min: -100, max: 100, step: 1, def: 0 }
    ];
    var CREATIVE = [
        { i: 38, label: 'Intensity', min: 0, max: 200, step: 1, def: 100 },
        { i: 40, label: 'Faded Film', min: 0, max: 100, step: 1, def: 0 },
        { i: 41, label: 'Sharpen', min: -100, max: 100, step: 1, def: 0 },
        { i: 42, label: 'Vibrance', min: -100, max: 100, step: 1, def: 0 },
        { i: 43, label: 'Saturation', min: 0, max: 200, step: 1, def: 100 }
    ];
    var CHANNELS = [
        { tag: 'ToneCurvesLuma', label: 'Luma', color: '#e8e8e8' },
        { tag: 'ToneCurvesRed', label: 'Red', color: '#d9655f' },
        { tag: 'ToneCurvesGreen', label: 'Green', color: '#6fbf73' },
        { tag: 'ToneCurvesBlue', label: 'Blue', color: '#5b9be0' }
    ];

    function init() {
        var overlay = document.getElementById('lumetriOverlay');
        var openBtn = document.getElementById('prLumetri');
        if (!overlay || !openBtn || typeof HOST === 'undefined' || HOST !== 'PPRO' || !cs) return;
        var body = document.getElementById('lumBody');
        var status = document.getElementById('lumStatus');
        var addBtn = document.getElementById('lumAdd');
        var jsxPath = cs.getSystemPath('extension') + '/jsx/dm-lumetri.jsx';
        var busy = false, reading = false, interacting = 0, timer = null, ready = false;
        var queue = {}, order = [];
        var sliders = {};          /* index -> {input, value, cfg} */
        var curves = {};           /* tag -> [[pos, value], ...] */
        var channel = 0, satRange = DEFAULT_RANGE, satCustom = false;
        var canvas, ctx, satAmount, satAmountVal, satRangeInput, satRangeVal, satNote, satCanvas, satCtx, tabs = [];
        var undoBtn = document.getElementById('lumUndo');
        var past = [], clipKey = '', satRaw = 'non-over-const,value:0@0;0@1';
        var isMac = /Mac/i.test(navigator.platform);

        function script(args) {
            return 'if(typeof dmLumetri!=="function"||dmLumetri.dmVersion!==7){$.evalFile(' + JSON.stringify(jsxPath) + ');}dmLumetri(' + args + ');';
        }
        function fmt(n, step) { return step < 1 ? (Math.round(n * 100) / 100).toFixed(2) : String(Math.round(n)); }
        function num(n) { var s = String(Math.round(n * 10000) / 10000); return s === '-0' ? '0' : s; }
        function setStatusLine(text, showAdd) {
            status.textContent = text || ''; status.hidden = !text;
            addBtn.hidden = !showAdd;
        }
        function setReady(on) {
            ready = on;
            body.classList.toggle('is-disabled', !on);
            var inputs = body.querySelectorAll('input,button');
            for (var k = 0; k < inputs.length; k++) inputs[k].disabled = !on;
            if (undoBtn) undoBtn.disabled = !on || !past.length;
        }

        /* ── write queue: latest value per control, one call at a time ── */
        function enqueue(key, args, done, failed) {
            if (!(key in queue)) order.push(key);
            queue[key] = { args: args, done: done, failed: failed };
            pump();
        }
        function cancel(key) {
            if (!(key in queue)) return;
            delete queue[key];
            order = order.filter(function (k) { return k !== key; });
        }
        function pump() {
            if (busy || !order.length) return;
            var key = order.shift(), job = queue[key];
            delete queue[key];
            busy = true;
            evalScript(script(job.args), function (result) {
                busy = false;
                var parts = String(result || '').split('|');
                if (parts[0] !== 'OK' && job.failed) {
                    job.failed(parts[0] === 'ERR' ? parts.slice(1).join('|') : 'Premiere did not respond.');
                    if (order.length) pump();
                    return;
                }
                if (parts[0] !== 'OK') {
                    order = []; queue = {};
                    setStatusLine(parts[0] === 'ERR' ? parts.slice(1).join('|') : 'Premiere did not respond.', false);
                    setReady(false);
                    return;
                }
                if (job.done) job.done(parts);
                if (order.length) pump();
            });
        }

        /* ── undo ──
           Premiere records no Undo step for scripted parameter writes. Sliders therefore
           commit their final value through QE (one native step per adjustment). Curves and
           the two Creative controls QE cannot address are undone by this panel instead. */
        function remember(entry) { past.push(entry); if (past.length > 100) past.shift(); showUndo(); }
        function showUndo() { if (undoBtn) undoBtn.disabled = !past.length || !ready; }
        function undo() {
            if (!past.length) { evalScript('app.enableQE();qe.project.undo();', function () { setTimeout(refresh, 60); }); return; }
            var entry = past.pop(); showUndo();
            function after() { setTimeout(refresh, 60); }
            if (entry.kind === 'native') enqueue('undo', '"undo",' + entry.stack + ',' + entry.count, after, function (msg) { setStatusLine(msg, false); });
            else if (entry.kind === 'set') enqueue('set:' + entry.index, '"set",' + entry.index + ',' + entry.before, after);
            else enqueue('curve:' + entry.tag, '"curve",' + JSON.stringify(entry.tag) + ',' + JSON.stringify(entry.before), after);
        }
        function keyInterest(on) {
            if (typeof cs.registerKeyEventsInterest !== 'function') return;
            cs.registerKeyEventsInterest(on ? JSON.stringify([isMac ? { keyCode: 6, metaKey: true } : { keyCode: 90, ctrlKey: true }]) : '');
        }
        function idle() { return !busy && !order.length && !interacting && !reading; }

        /* ── curves ── */
        function parseCurve(text) {
            var m = /value:(.*)$/.exec(text || '');
            if (!m) return null;
            var pts = [], pairs = m[1].split(';');
            for (var k = 0; k < pairs.length; k++) {
                var pair = pairs[k].split('@');
                if (pair.length !== 2 || !isFinite(Number(pair[0])) || !isFinite(Number(pair[1]))) return null;
                pts.push([Number(pair[1]), Number(pair[0])]);
            }
            pts.sort(function (p, q) { return p[0] - q[0]; });
            return pts.length >= 2 ? pts : null;
        }
        function curveText(kind, pts) {
            return kind + ',value:' + pts.map(function (p) { return num(p[1]) + '@' + num(p[0]); }).join(';');
        }
        /* monotone cubic (Fritsch-Carlson), for drawing only */
        function sampler(pts) {
            var n = pts.length, dx = [], m = [], t = [], k;
            for (k = 0; k < n - 1; k++) { dx.push(pts[k + 1][0] - pts[k][0]); m.push((pts[k + 1][1] - pts[k][1]) / (dx[k] || 1e-6)); }
            t.push(m[0]);
            for (k = 1; k < n - 1; k++) t.push(m[k - 1] * m[k] <= 0 ? 0 : (m[k - 1] + m[k]) / 2);
            t.push(m[n - 2]);
            for (k = 0; k < n - 1; k++) {
                if (m[k] === 0) { t[k] = 0; t[k + 1] = 0; continue; }
                var a = t[k] / m[k], b = t[k + 1] / m[k], s = a * a + b * b;
                if (s > 9) { var f = 3 / Math.sqrt(s); t[k] = f * a * m[k]; t[k + 1] = f * b * m[k]; }
            }
            return function (x) {
                if (x <= pts[0][0]) return pts[0][1];
                if (x >= pts[n - 1][0]) return pts[n - 1][1];
                var j = 0; while (j < n - 2 && x > pts[j + 1][0]) j++;
                var h = dx[j] || 1e-6, u = (x - pts[j][0]) / h, u2 = u * u, u3 = u2 * u;
                return (2 * u3 - 3 * u2 + 1) * pts[j][1] + (u3 - 2 * u2 + u) * h * t[j] + (-2 * u3 + 3 * u2) * pts[j + 1][1] + (u3 - u2) * h * t[j + 1];
            };
        }
        function points() { return curves[CHANNELS[channel].tag] || [[0, 0], [1, 1]]; }
        function draw() {
            if (!ctx) return;
            var size = canvas.clientWidth; if (!size) return;
            var dpr = window.devicePixelRatio || 1;
            if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr); }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, size, size);
            ctx.lineWidth = 0.5; ctx.strokeStyle = '#353535';
            var k;
            for (k = 1; k < 4; k++) {
                var g = Math.round(size * k / 4) + 0.25;
                ctx.beginPath(); ctx.moveTo(g, 0); ctx.lineTo(g, size); ctx.moveTo(0, g); ctx.lineTo(size, g); ctx.stroke();
            }
            ctx.strokeStyle = '#505050';
            ctx.beginPath(); ctx.moveTo(0, size); ctx.lineTo(size, 0); ctx.stroke();
            var pts = points(), at = sampler(pts), color = ready ? CHANNELS[channel].color : '#929292';
            ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.beginPath();
            for (k = 0; k <= size; k += 2) {
                var y = Math.max(0, Math.min(1, at(k / size)));
                if (k === 0) ctx.moveTo(k, size - y * size); else ctx.lineTo(k, size - y * size);
            }
            ctx.stroke();
            ctx.fillStyle = color;
            for (k = 0; k < pts.length; k++) ctx.fillRect(pts[k][0] * size - 3, size - pts[k][1] * size - 3, 6, 6);
            drawSat();
        }
        function writeCurve() {
            var ch = CHANNELS[channel];
            enqueue('curve:' + ch.tag, '"curve",' + JSON.stringify(ch.tag) + ',' + JSON.stringify(curveText('cubic', points())));
        }
        function bindCanvas() {
            var drag = -1;
            function pos(event) {
                var r = canvas.getBoundingClientRect();
                return [Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (event.clientY - r.top) / r.height))];
            }
            function nearest(p) {
                var pts = points(), best = -1, bestD = 14 / canvas.clientWidth;
                for (var k = 0; k < pts.length; k++) {
                    var d = Math.sqrt(Math.pow(pts[k][0] - p[0], 2) + Math.pow(pts[k][1] - p[1], 2));
                    if (d < bestD) { bestD = d; best = k; }
                }
                return best;
            }
            function move(event) {
                if (drag < 0) return;
                var pts = points(), p = pos(event);
                if (drag === 0) p[0] = 0;
                else if (drag === pts.length - 1) p[0] = 1;
                else p[0] = Math.max(pts[drag - 1][0] + 0.01, Math.min(pts[drag + 1][0] - 0.01, p[0]));
                pts[drag] = p; draw(); writeCurve();
            }
            var startText = null, startTag = null;
            function end() {
                if (drag < 0) return;
                drag = -1; interacting = Math.max(0, interacting - 1);
                if (startText !== null && startTag === CHANNELS[channel].tag && curveText('cubic', points()) !== startText) remember({ kind: 'curve', tag: startTag, before: startText });
                startText = null;
                document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', end);
            }
            canvas.addEventListener('mousedown', function (event) {
                if (!ready || event.button !== 0) return;
                var tag = CHANNELS[channel].tag;
                if (!curves[tag]) curves[tag] = [[0, 0], [1, 1]];
                var pts = curves[tag], p = pos(event), hit = nearest(p);
                startTag = tag; startText = curveText('cubic', pts);
                if (hit < 0) {
                    if (pts.length >= 16) return;
                    var k = 0; while (k < pts.length && pts[k][0] < p[0]) k++;
                    if (k === 0 || k === pts.length) return;
                    if (p[0] - pts[k - 1][0] < 0.01 || pts[k][0] - p[0] < 0.01) return;
                    pts.splice(k, 0, p); hit = k;
                }
                drag = hit; interacting++;
                document.addEventListener('mousemove', move); document.addEventListener('mouseup', end);
                draw(); writeCurve(); event.preventDefault();
            });
            canvas.addEventListener('dblclick', function (event) {
                if (!ready) return;
                var pts = points(), hit = nearest(pos(event));
                if (hit <= 0 || hit === pts.length - 1) return;
                var beforeText = curveText('cubic', pts);
                pts.splice(hit, 1); draw(); writeCurve();
                remember({ kind: 'curve', tag: CHANNELS[channel].tag, before: beforeText });
            });
        }

        /* ── Sat vs Sat: first point moves, second stays on the line ── */
        function writeSat() {
            var amount = Number(satAmount.value) / 100, range = Number(satRangeInput.value) / 100;
            satRange = range; satCustom = false; satNote.hidden = true;
            satAmountVal.textContent = String(Math.round(amount * 100));
            satRangeVal.textContent = String(Math.round(range * 100));
            var text = amount < 0.005 ? 'non-over-const,value:0@0;0@1' : 'non-over-const,value:-' + num(amount) + '@0;0@' + num(range);
            satRaw = text;
            enqueue('curve:SatSatCurve', '"curve","SatSatCurve",' + JSON.stringify(text));
            drawSat();
        }
        var satStart = null;
        function satBegin() { if (satStart === null) satStart = satRaw; }
        function satEnd() { if (satStart !== null && satStart !== satRaw) remember({ kind: 'curve', tag: 'SatSatCurve', before: satStart }); satStart = null; }
        function showSat(text) {
            var pts = parseCurve(text);
            if (text) satRaw = text;
            var flat = pts && pts.length === 2 && Math.abs(pts[0][1]) < 0.0005 && Math.abs(pts[1][1]) < 0.0005;
            var shaped = pts && pts.length === 2 && Math.abs(pts[0][0]) < 0.0005 && pts[0][1] <= 0 && Math.abs(pts[1][1]) < 0.02;
            satCustom = !!text && !flat && !shaped;
            satNote.hidden = !satCustom;
            var amount = flat || !shaped ? 0 : -pts[0][1];
            if (shaped && !flat && pts[1][0] > 0) satRange = pts[1][0];
            satAmount.value = Math.round(amount * 100);
            satRangeInput.value = Math.round(satRange * 100);
            satAmountVal.textContent = satCustom ? '—' : String(Math.round(amount * 100));
            satRangeVal.textContent = String(Math.round(satRange * 100));
            drawSat();
        }
        /* Sat vs Sat graph. x = saturation 0..1; the mid line is "no change"; below it is
           less saturation. The line between the points is drawn as a smooth ease, which is
           an illustration: Lumetri does the real interpolation. */
        function satGeo() { var w = satCanvas.clientWidth, h = satCanvas.clientHeight; return { w: w, h: h, mid: Math.round(h * 0.2), depth: h - Math.round(h * 0.2) - 7 }; }
        function satPoints(g) { return { a: [5, g.mid + Number(satAmount.value) / 100 * g.depth], b: [Number(satRangeInput.value) / 100 * g.w, g.mid] }; }
        function drawSat() {
            if (!satCtx) return;
            var g = satGeo(); if (!g.w || !g.h) return;
            var dpr = window.devicePixelRatio || 1;
            if (satCanvas.width !== Math.round(g.w * dpr) || satCanvas.height !== Math.round(g.h * dpr)) { satCanvas.width = Math.round(g.w * dpr); satCanvas.height = Math.round(g.h * dpr); }
            satCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            satCtx.clearRect(0, 0, g.w, g.h);
            satCtx.lineWidth = 0.5; satCtx.strokeStyle = '#353535';
            var k;
            for (k = 1; k < 8; k++) { var x = Math.round(g.w * k / 8) + 0.25; satCtx.beginPath(); satCtx.moveTo(x, 0); satCtx.lineTo(x, g.h); satCtx.stroke(); }
            satCtx.strokeStyle = '#505050'; satCtx.lineWidth = 1;
            satCtx.beginPath(); satCtx.moveTo(0, g.mid + 0.5); satCtx.lineTo(g.w, g.mid + 0.5); satCtx.stroke();
            var p = satPoints(g), color = ready ? (satCustom ? '#929292' : '#e8e8e8') : '#929292';
            satCtx.strokeStyle = color; satCtx.lineWidth = 1.25; satCtx.beginPath();
            satCtx.moveTo(0, p.a[1]);
            var span = Math.max(1, p.b[0]);
            for (k = 0; k <= span; k += 2) { var t = k / span, e = t * t * (3 - 2 * t); satCtx.lineTo(k, p.a[1] + (p.b[1] - p.a[1]) * e); }
            satCtx.lineTo(p.b[0], p.b[1]); satCtx.lineTo(g.w, g.mid);
            satCtx.stroke();
            satCtx.fillStyle = color;
            satCtx.fillRect(p.a[0] - 4, p.a[1] - 4, 8, 8); satCtx.fillRect(p.b[0] - 4, p.b[1] - 4, 8, 8);
        }
        function bindSat() {
            var which = null;
            function local(event) { var r = satCanvas.getBoundingClientRect(); return [event.clientX - r.left, event.clientY - r.top]; }
            function move(event) {
                if (!which) return;
                var g = satGeo(), m = local(event);
                if (which === 'a') {
                    satAmount.value = Math.round(Math.max(0, Math.min(1, (m[1] - g.mid) / g.depth)) * 100);
                    writeSat();
                } else {
                    satRangeInput.value = Math.round(Math.max(0.03, Math.min(0.6, m[0] / g.w)) * 100);
                    if (Number(satAmount.value) > 0) writeSat();
                    else { satRange = Number(satRangeInput.value) / 100; satRangeVal.textContent = String(satRangeInput.value); drawSat(); }
                }
            }
            function end() {
                if (!which) return;
                which = null; interacting = Math.max(0, interacting - 1); satEnd();
                document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', end);
            }
            satCanvas.addEventListener('mousedown', function (event) {
                if (!ready || event.button !== 0) return;
                var g = satGeo(), p = satPoints(g), m = local(event);
                var da = Math.pow(m[0] - p.a[0], 2) + Math.pow(m[1] - p.a[1], 2), db = Math.pow(m[0] - p.b[0], 2) + Math.pow(m[1] - p.b[1], 2);
                which = da <= db ? 'a' : 'b';
                satBegin(); interacting++;
                document.addEventListener('mousemove', move); document.addEventListener('mouseup', end);
                event.preventDefault();
            });
            satCanvas.addEventListener('dblclick', function () {
                if (!ready) return;
                satBegin(); satAmount.value = 0; satRangeInput.value = Math.round(DEFAULT_RANGE * 100); writeSat(); satEnd();
            });
        }

        /* ── build ── */
        function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
        function track(input) {
            input.addEventListener('mousedown', function () { interacting++; });
            input.addEventListener('change', function () { interacting = Math.max(0, interacting - 1); input.blur(); });
        }
        function sliderRow(parent, label, min, max, step, value, help) {
            var row = el('div', 'lum-row');
            var name = el('span', 'lum-name', label);
            var input = el('input', 'lum-slider');
            input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
            input.setAttribute('aria-label', label);
            var val = el('span', 'lum-value', fmt(value, step));
            if (help) row.setAttribute('data-help', help);
            row.appendChild(name); row.appendChild(input); row.appendChild(val);
            parent.appendChild(row); track(input);
            return { row: row, name: name, input: input, value: val };
        }
        function group(title) {
            var wrap = el('div', 'lum-group');
            wrap.appendChild(el('div', 'pd-label', title));
            body.appendChild(wrap);
            return wrap;
        }
        function numeric(parent, list) {
            list.forEach(function (cfg) {
                var r = sliderRow(parent, cfg.label, cfg.min, cfg.max, cfg.step, cfg.def, 'Drag to adjust. Double-click to reset.');
                var state = sliders[cfg.i] = { input: r.input, value: r.value, cfg: cfg, last: cfg.def, open: false };
                var start = cfg.def;
                function begin() {
                    if (state.open) return;
                    state.open = true; start = state.last;
                    enqueue('begin:' + cfg.i, '"begin",' + cfg.i);
                }
                function send() {
                    begin();
                    r.value.textContent = fmt(Number(r.input.value), cfg.step);
                    enqueue('set:' + cfg.i, '"set",' + cfg.i + ',' + Number(r.input.value));
                }
                function commit() {
                    if (!state.open) return;
                    state.open = false;
                    var value = Number(r.input.value), from = start;
                    state.last = value;
                    cancel('set:' + cfg.i);   /* the commit writes the final value itself */
                    enqueue('commit:' + cfg.i, '"commit",' + cfg.i + ',' + value, function (parts) {
                        if (!Number(parts[2])) return;
                        if (Number(parts[3])) remember({ kind: 'native', stack: Number(parts[4]), count: Number(parts[3]) });
                        else remember({ kind: 'set', index: cfg.i, before: from });
                    });
                }
                r.input.addEventListener('mousedown', function () { if (ready) begin(); });
                r.input.addEventListener('input', send);
                r.input.addEventListener('change', commit);
                function reset() { if (!ready) return; r.input.value = cfg.def; send(); commit(); r.input.blur(); }
                r.name.addEventListener('dblclick', reset);
                r.input.addEventListener('dblclick', reset);
            });
        }
        function build() {
            numeric(group('Basic Correction'), BASIC);
            /* Creative was removed from the panel at Matheus's request (13 Nov 2026); the
               script side still supports it, so restoring it is this one line:
               numeric(group('Creative'), CREATIVE); */

            var cg = group('RGB Curves');
            var bar = el('div', 'lum-tabs');
            CHANNELS.forEach(function (ch, index) {
                var b = el('button', 'btn lum-tab', ch.label); b.type = 'button';
                b.addEventListener('click', function () { channel = index; tabs.forEach(function (t, k) { t.classList.toggle('is-active', k === index); }); draw(); b.blur(); });
                if (index === 0) b.classList.add('is-active');
                tabs.push(b); bar.appendChild(b);
            });
            var reset = el('button', 'btn lum-tab lum-reset', 'Reset'); reset.type = 'button';
            reset.setAttribute('data-help', 'Set this channel back to a straight line.');
            reset.addEventListener('click', function () {
                var tag = CHANNELS[channel].tag, beforeText = curveText('cubic', points());
                curves[tag] = [[0, 0], [1, 1]]; draw(); writeCurve(); reset.blur();
                if (beforeText !== 'cubic,value:0@0;1@1') remember({ kind: 'curve', tag: tag, before: beforeText });
            });
            bar.appendChild(reset); cg.appendChild(bar);
            canvas = el('canvas', 'lum-curve');
            canvas.setAttribute('aria-label', 'RGB curve editor');
            canvas.setAttribute('data-help', 'Click to add a point, drag to move it, double-click a point to remove it.');
            cg.appendChild(canvas); ctx = canvas.getContext('2d'); bindCanvas();

            var sg = group('Sat vs Sat');
            /* A small graph like the old Lumetri panel: the left point sets how much is pulled
               out, the right point sets how far up the saturation range it reaches. */
            satAmount = { value: 0 }; satRangeInput = { value: Math.round(DEFAULT_RANGE * 100) };
            satCanvas = el('canvas', 'lum-sat');
            satCanvas.setAttribute('aria-label', 'Sat vs Sat curve');
            satCanvas.setAttribute('data-help', 'Drag the left point down to pull saturation out of low-saturation areas such as yellow walls. Drag the right point sideways to set how far it reaches. Double-click to reset.');
            sg.appendChild(satCanvas); satCtx = satCanvas.getContext('2d');
            var readout = el('div', 'lum-sat-readout');
            var ra = el('span', '', 'Amount '), rr = el('span', '', 'Range ');
            satAmountVal = el('span', 'lum-sat-number', '0'); satRangeVal = el('span', 'lum-sat-number', String(Math.round(DEFAULT_RANGE * 100)));
            ra.appendChild(satAmountVal); rr.appendChild(satRangeVal); readout.appendChild(ra); readout.appendChild(rr); sg.appendChild(readout);
            bindSat();
            satNote = el('p', 'clip-position-note', 'This clip has a custom Sat vs Sat curve. Dragging a point replaces it.');
            satNote.hidden = true; sg.appendChild(satNote);
        }

        /* ── read ── */
        function apply(result) {
            var parts = String(result || '').split('|');
            if (parts[0] !== 'OK') { setReady(false); setStatusLine(parts[0] === 'ERR' ? parts.slice(1).join('|') : 'Premiere did not respond.', false); draw(); return; }
            var items = Number(parts[1]), lums = Number(parts[2]);
            if (!items) { setReady(false); setStatusLine('Select a clip or adjustment layer in the timeline.', false); draw(); return; }
            if (!lums) { setReady(false); setStatusLine('The selected clip has no Lumetri Color.', true); draw(); return; }
            setStatusLine(items > 1 ? items + ' clips selected. Showing the first; changes apply to all with Lumetri Color.' : '', false);
            setReady(true);
            (parts[3] || '').split(',').forEach(function (pair) {
                var kv = pair.split('='), s = sliders[Number(kv[0])];
                if (!s || !isFinite(Number(kv[1]))) return;
                s.input.value = Number(kv[1]); s.value.textContent = fmt(Number(kv[1]), s.cfg.step);
                s.last = Number(kv[1]); s.open = false;
            });
            if ((parts[9] || '') !== clipKey) { clipKey = parts[9] || ''; past = []; }
            showUndo();
            CHANNELS.forEach(function (ch, index) { curves[ch.tag] = parseCurve(parts[4 + index]) || [[0, 0], [1, 1]]; });
            showSat(parts[8] || '');
            draw();
        }
        function refresh() {
            if (!overlay.classList.contains('visible') || document.hidden || !idle()) return;
            reading = true;
            evalScript(script('"read"'), function (result) {
                reading = false;
                if (busy || order.length || interacting) return;
                apply(result);
            });
        }
        function open() {
            overlay.classList.add('visible');
            setReady(false); setStatusLine('Reading the selected clip…', false);
            refresh(); draw();
            if (!timer) timer = setInterval(refresh, POLL_MS);
            keyInterest(true);
        }
        function close() {
            overlay.classList.remove('visible');
            if (timer) { clearInterval(timer); timer = null; }
            keyInterest(false);
        }

        build();
        openBtn.addEventListener('click', function () { open(); openBtn.blur(); });
        document.getElementById('lumClose').addEventListener('click', close);
        if (undoBtn) undoBtn.addEventListener('click', function () { undo(); undoBtn.blur(); });
        /* With the overlay open, Cmd/Ctrl+Z inside the panel undoes the last Lumetri
           adjustment; with no panel history it falls through to Premiere's own Undo. */
        document.addEventListener('keydown', function (event) {
            if (!overlay.classList.contains('visible')) return;
            if (!(isMac ? event.metaKey : event.ctrlKey) || event.shiftKey || String(event.key).toLowerCase() !== 'z') return;
            event.preventDefault(); undo();
        });
        addBtn.addEventListener('click', function () {
            addBtn.disabled = true;
            evalScript(script('"add"'), function () { addBtn.disabled = false; refresh(); });
        });
        document.addEventListener('mouseup', function () { if (interacting && !order.length) setTimeout(function () { if (interacting > 0) interacting = 0; }, 400); });
        document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
        window.addEventListener('resize', draw);
        window.DmLumetri = { open: open, close: close, refresh: refresh };
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
