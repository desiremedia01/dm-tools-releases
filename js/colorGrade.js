/* ── Auto Color Grade — Fase B: conversao sobre os comps .aep (16/jul/2026)
   O prColorGrade sempre PULOU os segmentos de comp .aep na track
   [AG] Conversion (nao sabia o que ha dentro do comp). Agora o painel le
   o .aep cru (parseAep do autoSfx — fronteiras ldta validadas 54/54),
   classifica cada layer por fonte (DJI* = drone, video = camera, precomp
   desce por srcId) e entrega ao JSX janelas tipadas em tempo de sequence:
   [{s, e, k}] com k=1 drone / k=0 camera. O JSX subdivide os segmentos de
   comp nessas janelas e coloca o item de conversao QUE O USUARIO ESCOLHEU
   (drone ou camera) em cada trecho — LUTs continuam 100% escolha dele.
   Fronteira drone↔camera dentro do comp = meio da sobreposicao dos layers
   (mesma lei do meio da transicao do Auto SFX).
   Corpus (20 entregues, gradeMiner): ele cobre os comps NA MAO em 100/128
   trechos — este modulo automatiza exatamente isso.
   Gate offline: `node js/colorGrade.js gate` compara o plano gerado com a
   cobertura REAL do 18York entregue (minerada do .prproj).               */
(function () {
    var IS_NODE = (typeof document === 'undefined');
    /* extension root on ANY machine (panel); dev path as node-CLI fallback */
    function dmRoot() {
        try {
            if (typeof CSInterface !== 'undefined') {
                var p = new CSInterface().getSystemPath('extension');
                if (p) return p;
            }
        } catch (e) {}
        return '/Users/desiremedia/Documents/DM_Tools_CEP';
    }

    /* ── nucleo puro ─────────────────────────────────────────────────── */

    var VIDEO_EXT = /\.(mp4|mov|mxf|m4v|avi|crm|braw)\s*$/i;

    /* fonte de um layer: 'drone' | 'camera' | null (ignorar) */
    function srcKind(srcId, aep, depth) {
        if (!srcId || depth > 3) return null;
        var nm = (aep._names || {})[srcId];
        if (nm) {
            nm = nm.replace(/\s+$/, '');
            if (/solid|adjustment|null|controller/i.test(nm)) return null;
            if (/^DJI/i.test(nm)) return 'drone';
            if (VIDEO_EXT.test(nm)) return 'camera';
        }
        var sub = aep._byId && aep._byId[srcId];
        if (sub) {
            /* precomp: desce e vota (drones ficam em precomps de ramp) */
            var votes = { drone: 0, camera: 0 };
            (sub.layers || []).forEach(function (L) {
                if (!L.enabled || L.nul || L.adj || !L.srcId) return;
                var k = srcKind(L.srcId, aep, depth + 1);
                if (k) votes[k]++;
            });
            if (votes.drone || votes.camera)
                return votes.drone >= votes.camera ? 'drone' : 'camera';
        }
        return null;
    }

    /* regioes tipadas de um comp, em tempo do comp — sweep de VISIBILIDADE:
       em cada instante o layer visivel eh o mais ALTO do stack que cobre o
       tempo (layers do parseAep vem em ordem de documento = stack do AE,
       topo primeiro — validado empiricamente no gate do 18York: a entrada
       do layer de cima e a saida do layer de cima batem com os cortes que
       o Matheus fez na mao). Layers com Gradient Wipe ficam de fora (o
       wipe revela a mesma cena — mesmo tipo de fonte). */
    function visSweep(comp, aep) {
        var cands = [];
        (comp.layers || []).forEach(function (L, idx) {
            if (!L.enabled || L.nul || L.adj || L.gw) return;
            if (!(L.inP > -60 && L.inP < 3600 && L.outP > L.inP)) return;
            var k = srcKind(L.srcId, aep, 0);
            if (k) cands.push({ inP: L.inP, outP: L.outP, kind: k, order: idx });
        });
        if (!cands.length) return [];
        var pts = {};
        cands.forEach(function (c) { pts[c.inP] = 1; pts[c.outP] = 1; });
        var ts = Object.keys(pts).map(Number).sort(function (a, b) { return a - b; });
        var spans = [];
        for (var i = 0; i < ts.length - 1; i++) {
            var mid = (ts[i] + ts[i + 1]) / 2;
            var vis = null;
            for (var c = 0; c < cands.length; c++) {
                var C = cands[c];
                if (C.inP <= mid && mid < C.outP && (vis === null || C.order < vis.order)) vis = C;
            }
            if (!vis) continue;
            spans.push({ from: ts[i], to: ts[i + 1], kind: vis.kind, layer: vis.order });
        }
        return spans;
    }

    function compRegions(comp, aep) {
        var spans = visSweep(comp, aep);
        var regs = [];
        spans.forEach(function (sp) {
            if (regs.length && regs[regs.length - 1].kind === sp.kind &&
                Math.abs(regs[regs.length - 1].to - sp.from) < 0.05)
                regs[regs.length - 1].to = sp.to;
            else
                regs.push({ from: sp.from, to: sp.to, kind: sp.kind });
        });
        return regs;
    }

    /* cortes de Grade/Creative dentro do comp (regra dele, validada 15/16
       no 18York entregue com 0 falsos): toda TROCA de layer visivel
       (mesmo tipo igual — cada clip ganha correcao propria) + o MEIO de
       cada day-to-night (a noite pede grade diferente — os 2 D2N do
       18York cairam exatos: 13.52 e 32.96). Precisa do d2nMids do
       autoSfx quando disponivel (painel/Node). */
    function compCutList(comp, aep, d2nMidsFn) {
        var spans = visSweep(comp, aep);
        var cuts = [];
        for (var i = 1; i < spans.length; i++) {
            if (spans[i].layer !== spans[i - 1].layer &&
                Math.abs(spans[i].from - spans[i - 1].to) < 0.05)
                cuts.push(spans[i].from);
            else if (spans[i].from - spans[i - 1].to >= 0.05) {
                cuts.push(spans[i - 1].to);
                cuts.push(spans[i].from);
            }
        }
        if (comp.d2n && d2nMidsFn) {
            (d2nMidsFn(comp) || []).forEach(function (m) { if (m && isFinite(m.mid)) cuts.push(m.mid); });
        }
        cuts.sort(function (a, b) { return a - b; });
        var out = [];
        /* 0.25 >= piso de 0.2s das pecas no JSX — dois cortes proximos
           nunca geram peca que seria pulada (buraco no grade) */
        cuts.forEach(function (t) { if (!out.length || t - out[out.length - 1] >= 0.25) out.push(t); });
        return out;
    }

    /* duracao de um array de keyframes de slider, se for uma varredura
       de wipe (>=2 keys, tempo crescente, valor caindo 100->0) */
    function sliderSpan(keys) {
        if (!keys || keys.length < 2) return null;
        var t0 = keys[0][0], t1 = keys[keys.length - 1][0];
        var v0 = keys[0][1], v1 = keys[keys.length - 1][1];
        if (!(t1 > t0) || t1 - t0 > 30) return null;
        if (!(v0 > v1)) return null;           // wipe = Transition Completion 100 -> 0
        return { from: t0, to: t1, dur: t1 - t0 };
    }

    /* spans do day-to-night p/ crossfade Grade/Creative (regra 16/jul,
       refinada 16/jul): a duracao do crossfade = duracao dos KEYFRAMES do
       SLIDER do Gradient Wipe (a varredura visivel 100->0), NAO a extensao
       do null layer inteiro (que pode ser maior que a animacao). Casa o
       slider ao null por sobreposicao temporal; centro = meio do null
       (== ponto do corte, p/ o crossfade cair na edicao certa). 18York:
       null e slider coincidem (1.48s), centros 13.52/32.96 — batem com os
       crossfades manuais dele (13.54/32.98). */
    function d2nSpans(comp) {
        if (!comp.d2n) return [];
        var spans = [];
        var sliders = [];
        (comp.sl || []).forEach(function (keys) {
            var sp = sliderSpan(keys);
            if (sp) sliders.push(sp);
        });
        (comp.layers || []).forEach(function (L) {
            if (!(L.nul && L.slider && L.enabled && L.outP > L.inP)) return;
            var mid = (L.inP + L.outP) / 2;
            /* slider cuja varredura cai dentro (ou toca) o null layer */
            var best = null;
            for (var i = 0; i < sliders.length; i++) {
                var s = sliders[i];
                if (s.to >= L.inP - 0.1 && s.from <= L.outP + 0.1) {
                    if (!best || s.dur < best.dur) best = s;   // a mais justa
                }
            }
            var dur = best ? best.dur : (L.outP - L.inP);
            if (dur > 0 && dur < 30) spans.push({ mid: mid, dur: dur });
        });
        if (spans.length) return spans;
        /* sem null+slider legivel: usa os keyframes do slider direto */
        sliders.forEach(function (s) {
            spans.push({ mid: (s.from + s.to) / 2, dur: s.dur });
        });
        return spans;
    }

    function nodeRequire(m) {
        return (typeof window !== 'undefined' && window.cep_node) ? window.cep_node.require(m) : require(m);
    }

    /* direcao do wipe (16/jul): a versao night e um clip NORMAL gravado
       mais tarde — keyframes identicos, direcao NAO esta na estrutura.
       Detecta comparando creation_time dos sources (FX3 grava no MP4):
       layer REVELADO (o que tem o Gradient Wipe) gravado DEPOIS do layer
       de baixo = d2n; ANTES = n2d. Validado 18York: 7894@19:25 sobre
       7770@17:19 e 7896@19:27 sobre 7788@18:07 -> d2n. Gap minimo 10min;
       sem metadados/ambiguo -> assume d2n (comportamento atual). */
    function wipeDir(comp, aep, mid, srcTimeFn) {
        if (!srcTimeFn) return null;
        var gwL = null;
        (comp.layers || []).forEach(function (L, idx) {
            if (L.gw && L.enabled && L.inP <= mid && mid < L.outP && gwL === null) gwL = idx;
        });
        if (gwL === null) return null;
        /* "de baixo" = primeiro layer de video ABAIXO do revelado cobrindo o
           mid — INCLUI layers com gw (no d2n2d o de baixo do 2o wipe e o
           proprio layer night do 1o wipe) */
        var fromL = null;
        for (var idx = gwL + 1; idx < (comp.layers || []).length; idx++) {
            var L = comp.layers[idx];
            if (!L || L.nul || L.adj || !L.enabled) continue;
            if (!(L.inP <= mid && mid < L.outP)) continue;
            if (!srcKind(L.srcId, aep, 0)) continue;
            fromL = idx; break;
        }
        if (fromL === null) return null;
        function vidName(idx) {
            var nm = (aep._names || {})[comp.layers[idx].srcId] || '';
            var m = String(nm).match(/^(.*\.(mp4|mov|mxf|m4v))/i);
            return m ? m[1] : null;
        }
        var a = vidName(gwL), b = vidName(fromL);
        if (!a || !b) return null;
        var ta = srcTimeFn(a), tb = srcTimeFn(b);
        if (ta === null || tb === null || Math.abs(ta - tb) < 600) return null;
        return ta > tb ? 'd2n' : 'n2d';
    }

    /* le creation_time dos sources do projeto (<root>/VIDEO/**), cacheado */
    function makeSrcTimeFn(projRoot) {
        var fs, cp;
        try { fs = nodeRequire('fs'); cp = nodeRequire('child_process'); } catch (e) { return null; }
        var FF = 'ffmpeg';
        try {
            var ffc = [];
            try { var bff = (typeof window !== 'undefined' && window.DM_BUNDLED_FFMPEG) ? window.DM_BUNDLED_FFMPEG() : null; if (bff) ffc.push(bff); } catch (eb) {}
            ffc.push(dmRoot() + '/bin/ffmpeg',
                '/Applications/Wavdrop.app/Contents/Resources/ffmpeg',
                (process.env.HOME || '') + '/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg');
            for (var fi = 0; fi < ffc.length; fi++) { if (fs.existsSync(ffc[fi])) { FF = ffc[fi]; break; } }
        } catch (e) {}
        var map = null, times = {};
        function scan(dir, depth) {
            if (depth > 3) return;
            var ents;
            try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            ents.forEach(function (en) {
                var p = dir + '/' + en.name;
                if (en.isDirectory()) scan(p, depth + 1);
                else if (/\.(mp4|mov|mxf|m4v)$/i.test(en.name) && !/_proxy\./i.test(en.name))
                    map[en.name.toLowerCase()] = p;
            });
        }
        return function (name) {
            var key = String(name).toLowerCase();
            if (times[key] !== undefined) return times[key];
            if (map === null) { map = {}; scan(projRoot + '/VIDEO', 0); }
            var t = null, p = map[key];
            if (p) {
                var errOut = '';
                try { cp.execFileSync(FF, ['-i', p], { stdio: ['ignore', 'pipe', 'pipe'] }); }
                catch (e) { errOut = String(e.stderr || ''); }
                var m = errOut.match(/creation_time\s*:\s*([0-9][0-9T:\-\.]+Z?)/);
                if (m) { var d = Date.parse(m[1]); if (!isNaN(d)) t = d / 1000; }
            }
            times[key] = t;
            return t;
        };
    }

    /* janelas tipadas + cortes de grade/creative em tempo de SEQUENCE.
       items: [{name, path, start, end, inPoint}]; aeps: path → parseAep();
       d2nMidsFn: autoSfx.d2nMids (window.DM_d2nMids no painel);
       srcTimeFn: makeSrcTimeFn(projRoot) p/ direcao dos wipes (opcional) */
    function compWindows(items, aeps, d2nMidsFn, srcTimeFn) {
        var windows = [];
        var cuts = [];
        var xfades = [];
        var nights = [];
        var misses = [];
        items.forEach(function (it) {
            var aep = aeps[it.path];
            if (!aep || aep.error) { misses.push(it.name + ' (aep ilegivel)'); return; }
            var comp = aep[it.name] || aep[String(it.name).split('/')[0]];
            if (!comp) { misses.push(it.name + ' (comp not found)'); return; }
            /* cortes e crossfades nao dependem da tipagem drone/camera —
               saem ANTES do early-return das janelas (D2N vale mesmo em
               comp cujos sources nao classificam) */
            compCutList(comp, aep, d2nMidsFn).forEach(function (t) {
                var st = it.start + (t - it.inPoint);
                if (st > it.start + 0.25 && st < it.end - 0.25)
                    cuts.push(Math.round(st * 100) / 100);
            });
            /* night windows por DIRECAO de cada wipe (16/jul): d2n abre a
               night no mid, n2d fecha; d2n2d = night entre os dois mids;
               n2d sem d2n antes = night desde o inicio do clip. Creative
               cai pra 70% nessas janelas (drone tb). */
            var wipeEvs = [];
            d2nSpans(comp).forEach(function (sp) {
                var st = it.start + (sp.mid - it.inPoint);
                if (st > it.start + 0.25 && st < it.end - 0.25) {
                    xfades.push({ t: Math.round(st * 100) / 100,
                                  d: Math.round(Math.min(6, Math.max(0.5, sp.dur)) * 100) / 100 });
                    wipeEvs.push({ t: Math.round(st * 100) / 100,
                                   dir: wipeDir(comp, aep, sp.mid, srcTimeFn) || 'd2n' });
                }
            });
            wipeEvs.sort(function (a, b) { return a.t - b.t; });
            var nOpen = null;
            wipeEvs.forEach(function (ev) {
                if (ev.dir === 'd2n') { if (nOpen === null) nOpen = ev.t; }
                else if (nOpen === null) nights.push({ s: Math.round(it.start * 100) / 100, e: ev.t });
                else { nights.push({ s: nOpen, e: ev.t }); nOpen = null; }
            });
            if (nOpen !== null) nights.push({ s: nOpen, e: Math.round(it.end * 100) / 100 });
            var regs = compRegions(comp, aep);
            if (!regs.length) { misses.push(it.name + ' (no video layers)'); return; }
            var segs = [];
            regs.forEach(function (r) {
                var s = it.start + (r.from - it.inPoint);
                var e = it.start + (r.to - it.inPoint);
                if (e < it.start || s > it.end) return;
                segs.push({ s: s, e: e, kind: r.kind });
            });
            if (!segs.length) return;
            /* ancora no clip: cobre do inicio ao fim, sem buracos */
            segs[0].s = it.start;
            segs[segs.length - 1].e = it.end;
            for (var i = 1; i < segs.length; i++) segs[i].s = segs[i - 1].e;
            segs.forEach(function (g) {
                if (g.e - g.s < 0.08) return;
                windows.push({ s: Math.round(g.s * 100) / 100,
                               e: Math.round(g.e * 100) / 100,
                               k: g.kind === 'drone' ? 1 : 0 });
            });
        });
        windows.sort(function (a, b) { return a.s - b.s; });
        cuts.sort(function (a, b) { return a - b; });
        xfades.sort(function (a, b) { return a.t - b.t; });
        var xdedup = [];
        xfades.forEach(function (x) {
            if (!xdedup.length || x.t - xdedup[xdedup.length - 1].t >= 0.25) xdedup.push(x);
        });
        return { windows: windows, cuts: cuts, xfades: xdedup, nights: nights, misses: misses };
    }

    /* ── Node: exports + gate offline ────────────────────────────────── */
    if (IS_NODE) {
        module.exports = { srcKind: srcKind, compRegions: compRegions,
                           compCutList: compCutList, sliderSpan: sliderSpan,
                           d2nSpans: d2nSpans, wipeDir: wipeDir,
                           makeSrcTimeFn: makeSrcTimeFn, compWindows: compWindows };
        if (require.main === module && process.argv[2] === 'gate') {
            var fs = require('fs');
            var autoSfx = require('./autoSfx.js');
            var parseAep = autoSfx.parseAep;
            var CAL = '/Users/desiremedia/Documents/DM_Tools_CEP/calibration';
            var fix = JSON.parse(fs.readFileSync(CAL + '/fixtures/18york_sfx_fixture.json', 'utf8'));
            var aep = parseAep(fix.aepPath);
            var items = fix.comps.map(function (c) {
                return { name: c.name, path: fix.aepPath, start: c.start, end: c.end, inPoint: c.inPoint };
            });
            var aeps = {}; aeps[fix.aepPath] = aep;
            var got = compWindows(items, aeps, autoSfx.d2nMids);
            console.log('janelas geradas: ' + got.windows.length +
                (got.misses.length ? '  misses: ' + got.misses.join('; ') : ''));

            /* ground truth: cobertura REAL do 18York entregue (minerada) */
            var cacheDir = CAL + '/gradeCache';
            var truth = null;
            fs.readdirSync(cacheDir).forEach(function (f) {
                if (/^18_York/.test(f)) truth = JSON.parse(fs.readFileSync(cacheDir + '/' + f, 'utf8'));
            });
            if (!truth) { console.log('GATE ERRO: cache do 18York nao encontrado (rode o miner)'); process.exit(1); }
            var LUT_KIND = { AG_Conversion_Slog3: 0, AG_Conversion_Air3: 1, AG_Conversion_Avata: 1,
                             AG_Conversion_Mavic3: 1, AG_Conversion_Mavic4: 1, AG_Conversion_Dlog: 1 };
            function deliveredKind(t) {
                for (var i = 0; i < truth.conversionSegments.length; i++) {
                    var cs = truth.conversionSegments[i];
                    if (cs.start <= t && t < cs.end && LUT_KIND[cs.item] !== undefined) return LUT_KIND[cs.item];
                }
                return -1;
            }
            function predictedKind(t) {
                for (var i = 0; i < got.windows.length; i++)
                    if (got.windows[i].s <= t && t < got.windows[i].e) return got.windows[i].k;
                return -1;
            }
            var ok = 0, bad = 0, noTruth = 0, badAt = [];
            items.forEach(function (it) {
                for (var t = it.start + 0.1; t < it.end - 0.1; t += 0.25) {
                    var d = deliveredKind(t), p = predictedKind(t);
                    if (d === -1) { noTruth++; continue; }   /* ele nao cobriu esse trecho na mao */
                    if (p === d) ok++;
                    else { bad++; if (badAt.length < 12) badAt.push(t.toFixed(2) + ' (real=' + d + ' plano=' + p + ')'); }
                }
            });
            var pct = ok + bad ? Math.round(100 * ok / (ok + bad)) : 0;
            console.log('GATE 18York (conversao): ' + ok + '/' + (ok + bad) + ' amostras batem (' + pct + '%)' +
                ' — sem ground truth em ' + noTruth + ' amostras (trechos que ele nao cobriu na mao)');
            if (badAt.length) console.log('divergencias: ' + badAt.join(', '));
            items.forEach(function (it) {
                var ws = got.windows.filter(function (w) { return w.s < it.end && w.e > it.start; });
                console.log('  ' + it.name.slice(-14) + ' [' + it.start + '-' + it.end + ']: ' +
                    ws.map(function (w) { return (w.k ? 'drone' : 'camera') + ' ' + w.s + '-' + w.e; }).join(' | '));
            });

            /* cortes de grade/creative: comparar com os cortes REAIS dele
               dentro dos comps (bordas dos gradeSegments minerados) */
            var realCuts = [];
            var bounds = {};
            truth.gradeSegments.forEach(function (g) { bounds[g.start.toFixed(2)] = 1; bounds[g.end.toFixed(2)] = 1; });
            items.forEach(function (it) {
                Object.keys(bounds).forEach(function (b) {
                    var t = parseFloat(b);
                    if (t > it.start + 0.3 && t < it.end - 0.3) realCuts.push(t);
                });
            });
            realCuts.sort(function (a, b) { return a - b; });
            var hits = 0, extras = [];
            var missedCuts = [];
            realCuts.forEach(function (rc) {
                if (got.cuts.some(function (p) { return Math.abs(p - rc) <= 0.1; })) hits++;
                else missedCuts.push(rc);
            });
            got.cuts.forEach(function (p) {
                if (!realCuts.some(function (rc) { return Math.abs(p - rc) <= 0.1; })) extras.push(p);
            });
            console.log('GATE 18York (cortes grade/creative em comps): ' + hits + '/' + realCuts.length +
                ' cortes reais previstos, ' + extras.length + ' extras' +
                (missedCuts.length ? ' — nao previstos (manuais/artisticos): ' + missedCuts.join(', ') : '') +
                (extras.length ? ' — extras: ' + extras.join(', ') : ''));
            var cutsOk = (hits >= realCuts.length - 1) && extras.length === 0;

            /* crossfades D2N: centros das transicoes manuais dele no
               prproj entregue = 13.54 e 32.98 (duracao dele era o default
               1.0s; a regra ditada 16/jul usa a duracao do wipe = 1.48s) */
            var xfTruth = [13.54, 32.98];
            var xfHits = 0;
            xfTruth.forEach(function (rt) {
                if ((got.xfades || []).some(function (x) { return Math.abs(x.t - rt) <= 0.1; })) xfHits++;
            });
            var xfSane = (got.xfades || []).every(function (x) { return x.d >= 0.5 && x.d <= 6; });
            console.log('GATE 18York (crossfades D2N): ' + xfHits + '/' + xfTruth.length +
                ' posicoes batem com os manuais dele, duracoes: ' +
                (got.xfades || []).map(function (x) { return x.t + 's/' + x.d + 's'; }).join(', ') +
                (xfSane ? '' : ' — DURACAO FORA DE FAIXA'));
            var xfOk = xfHits === xfTruth.length && (got.xfades || []).length === xfTruth.length && xfSane;

            /* direcao dos wipes: com creation_time REAL dos clips do 18York
               os 2 wipes tem que sair d2n e as nights = mid->fim do comp */
            var timeFn = makeSrcTimeFn(fix.aepPath.split('/').slice(0, -2).join('/'));
            var gotDir = compWindows(items, aeps, autoSfx.d2nMids, timeFn);
            var nWant = [[13.52, 17.44], [32.96, 33.88]];
            var nOk = (gotDir.nights || []).length === 2 && nWant.every(function (w, i) {
                return Math.abs(gotDir.nights[i].s - w[0]) < 0.05 && Math.abs(gotDir.nights[i].e - w[1]) < 0.05;
            });
            console.log('GATE 18York (direcao wipes via creation_time): nights=' +
                JSON.stringify(gotDir.nights) + (nOk ? ' ✓ (2x d2n)' : ' ✗'));

            /* sinteticos: n2d (revelado gravado ANTES) e d2n2d */
            var synAep = { _names: { 10: 'NIGHT.MP4', 11: 'DAY.MP4' } };
            function mkComp(wipes) {   /* wipes: [{mid, gwSrc, baseSrc}] */
                var layers = [];
                wipes.forEach(function (w) {
                    layers.push({ nul: 1, slider: 1, enabled: 1, inP: w.mid - 0.74, outP: w.mid + 0.74 });
                    layers.push({ gw: 1, enabled: 1, inP: w.mid - 2, outP: w.mid + 4, srcId: w.gwSrc, nul: 0, adj: 0 });
                });
                layers.push({ enabled: 1, inP: 0, outP: 20, srcId: wipes[0].baseSrc, nul: 0, adj: 0, gw: 0 });
                return { d2n: 1, layers: layers, sl: [] };
            }
            var synTime = function (nm) { return nm === 'NIGHT.MP4' ? 2000000 : 1000000; };
            var cN2d = mkComp([{ mid: 5, gwSrc: 11, baseSrc: 10 }]);       // revela DAY sobre NIGHT
            var itN = [{ name: 'S', path: 'x', start: 0, end: 12, inPoint: 0 }];
            synAep['S'] = cN2d;
            var gN = compWindows(itN, { x: synAep }, autoSfx.d2nMids, synTime);
            var n2dOk = gN.nights.length === 1 && gN.nights[0].s === 0 && Math.abs(gN.nights[0].e - 5) < 0.05;
            /* d2n2d realista (top-first): wipe2 revela DAY por cima do
               layer NIGHT do wipe1 (que tem gw e segue na tela) */
            var cD2n2d = { d2n: 1, sl: [], layers: [
                { nul: 1, slider: 1, enabled: 1, inP: 8.26, outP: 9.74 },
                { gw: 1, enabled: 1, inP: 7, outP: 13, srcId: 11, nul: 0, adj: 0 },
                { nul: 1, slider: 1, enabled: 1, inP: 3.26, outP: 4.74 },
                { gw: 1, enabled: 1, inP: 2, outP: 11, srcId: 10, nul: 0, adj: 0 },
                { gw: 0, enabled: 1, inP: 0, outP: 20, srcId: 11, nul: 0, adj: 0 }
            ] };
            synAep['S'] = cD2n2d;
            var gD = compWindows(itN, { x: synAep }, autoSfx.d2nMids, synTime);
            var d2n2dOk = gD.nights.length === 1 && Math.abs(gD.nights[0].s - 4) < 0.05 && Math.abs(gD.nights[0].e - 9) < 0.05;
            console.log('GATE sinteticos: n2d (night 0->5) ' + (n2dOk ? '✓' : '✗ ' + JSON.stringify(gN.nights)) +
                ' | d2n2d (night 4->9) ' + (d2n2dOk ? '✓' : '✗ ' + JSON.stringify(gD.nights)));

            process.exit(pct >= 95 && cutsOk && xfOk && nOk && n2dOk && d2n2dOk ? 0 : 1);
        }
        return;
    }

    /* ── painel ──────────────────────────────────────────────────────── */
    /* chamado pelo cgApplyBtn (main.js delega quando DM_applyColorGrade existe) */
    function applyColorGrade(droneName, cameraName, creativeName) {
        var cs = new CSInterface();
        var shim = window.DM_JSON_SHIM || '';
        var read = '(function(){' + shim +
            'try{var seq=app.project.activeSequence;if(!seq)return "ERR|no active sequence";' +
            'var out=[];' +
            'for(var t=0;t<seq.videoTracks.numTracks;t++){var tr=seq.videoTracks[t];' +
            'for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];if(!cl)continue;' +
            'var p="";try{p=cl.projectItem.getMediaPath();}catch(e1){}' +
            'if(!p)continue;' +
            'if(String(p).split(".").pop().toLowerCase()!=="aep")continue;' +
            'out.push({name:String(cl.name),path:String(p),start:cl.start.seconds,end:cl.end.seconds,inPoint:cl.inPoint.seconds});}}' +
            'return JSON.stringify(out);}catch(e){return "ERR|"+e;}}())';
        cs.evalScript(read, function (res) {
            var items = [];
            if (res && res.indexOf('ERR|') !== 0) {
                try { items = JSON.parse(res); } catch (e) { items = []; }
            }
            var aeps = {}, planInfo = { windows: [], cuts: [], xfades: [], misses: [] };
            try {
                items.forEach(function (it) {
                    if (aeps[it.path] !== undefined) return;
                    try { aeps[it.path] = window.DM_parseAep(it.path); }
                    catch (e) { aeps[it.path] = { error: String(e) }; }
                });
                var projRoot = items.length ? items[0].path.split('/').slice(0, -2).join('/') : null;
                var srcTimeFn = projRoot ? makeSrcTimeFn(projRoot) : null;
                planInfo = compWindows(items, aeps, window.DM_d2nMids, srcTimeFn);
            } catch (e) { planInfo = { windows: [], cuts: [], xfades: [], misses: ['plan: ' + e] }; }

            /* diagnostico por clique (mesmo padrao do Auto SFX) */
            try {
                var fsN = window.cep_node ? window.cep_node.require('fs') : require('fs');
                fsN.writeFileSync(dmRoot() + '/calibration/lastGradePlan.json',
                    JSON.stringify({ at: new Date().toISOString(), items: items, plan: planInfo }, null, 1));
            } catch (eDump) {}

            var planArg = JSON.stringify(JSON.stringify({ w: planInfo.windows, c: planInfo.cuts,
                                                          x: planInfo.xfades || [],
                                                          n: planInfo.nights || [] }));
            var call = '$.evalFile(' + JSON.stringify(getPrJsxPath()) + '); prColorGrade(' +
                JSON.stringify(droneName) + ', ' + JSON.stringify(cameraName) + ', ' +
                JSON.stringify(creativeName) + ', ' + planArg + ');';
            evalScript(call, function (r2) {
                if (r2 && /^error/i.test(r2)) handleResult(r2);
                else setStatus('Color grade applied.', 'success');
            });
        });
    }
    window.DM_applyColorGrade = applyColorGrade;

}());
