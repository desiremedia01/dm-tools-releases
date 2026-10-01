/* ── Grade Miner — Fase A do Auto Color Grade (16/jul/2026) ────────────
   Mineracao 100% offline dos .prproj entregues (gzip XML) para aprender
   "o que sempre fazemos" no color grade da Desire:
     - itens AG_* do template (masterclips adjustment com Lumetri + LUT)
     - tracks [AG] Conversion / Grade / Creative: cortes por segmento
     - POR INSTANCIA do AG_Grade: valores do Lumetri do track item
       (Temperature/Contrast/Highlights/... — numeros legiveis no XML;
       verificado no 18York: chain da instancia = Motion + Lumetri)
     - opacidade das instancias do Creative (drone/night)
     - clip de conteudo sob cada segmento -> tabela fonte→LUT real
   Estruturas (verificadas 16/jul no 18York entregue):
     Sequence(UID) → TrackGroups/Second(ObjectRef) → VideoTrackGroup
       → Tracks/Track(ObjectURef) → VideoClipTrack {MZ.TrackName,
       ClipItems/TrackItems(ObjectRef)} → VideoClipTrackItem
       {TrackItem Start/End ticks÷254016000000, SubClip(ObjectRef),
       ComponentOwner/Components(ObjectRef)}
     SubClip {Name, MasterClip(ObjectURef), Clip(ObjectRef)}
     MasterClip(UID) {Name, IsAdjustmentLayer, VideoComponentChain}
     VideoFilterComponent {MatchName AE.ADBE Lumetri, Params ObjectRef}
       → VideoComponentParam {Name, StartKeyframe "t,valor,..."}
       → ArbVideoComponentParam blob base64 = XML claro (<LUT>"...",
         BasicCorrection3, <embeddedlut>)
   Uso:
     node js/gradeMiner.js discover [--limit 20]
     node js/gradeMiner.js mine [--limit 20] [--no-cache]
     node js/gradeMiner.js mine --file "<caminho>.prproj"   (gate 18York)
   Saida: calibration/gradeCorpus.json + calibration/gradeReport.html   */
(function () {
    var IS_NODE = (typeof document === 'undefined');
    if (!IS_NODE) return; /* CLI puro por enquanto; o painel usa o corpus gerado */

    var fs = require('fs');
    var path = require('path');
    var zlib = require('zlib');

    var CAL_DIR = (function () {
        try { return require('path').resolve(__dirname, '..', 'calibration'); } catch (e) {}
        return '/Users/desiremedia/Documents/DM_Tools_CEP/calibration';
    })();
    var CACHE_DIR = path.join(CAL_DIR, 'gradeCache');
    var TICKS = 254016000000;           /* ticks por segundo (prproj) */

    var ROOTS = [
        { dir: '/Volumes/NAS- Desire Group 2/REAL ESTATE', depth: 4 },
        { dir: '/Users/desiremedia/Documents', depth: 3 }
    ];

    /* ── descoberta ──────────────────────────────────────────────────── */
    function newestPrproj(premiereDir) {
        var best = null;
        var names;
        try { names = fs.readdirSync(premiereDir); } catch (e) { return null; }
        for (var i = 0; i < names.length; i++) {
            var n = names[i];
            if (!/\.prproj$/i.test(n)) continue;
            if (/copy|template|backup/i.test(n)) continue;
            var full = path.join(premiereDir, n);
            var st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if (!st.isFile() || st.size < 200000) continue;   /* projetos reais tem MBs */
            if (!best || st.mtimeMs > best.mtime) best = { prproj: full, mtime: st.mtimeMs, size: st.size };
        }
        return best;
    }

    function findProjects() {
        var found = [];
        function walk(dir, depthLeft) {
            var names;
            try { names = fs.readdirSync(dir); } catch (e) { return; }
            for (var i = 0; i < names.length; i++) {
                var n = names[i];
                if (n.charAt(0) === '.' || n.charAt(0) === '@') continue;
                var full = path.join(dir, n);
                var st;
                try { st = fs.statSync(full); } catch (e) { continue; }
                if (!st.isDirectory()) continue;
                if (/^PREMIERE$/i.test(n)) {
                    var best = newestPrproj(full);
                    if (best) found.push({
                        project: path.basename(dir),
                        dir: dir, prproj: best.prproj, mtime: best.mtime, size: best.size
                    });
                } else if (depthLeft > 0 && !/adobe|auto-save|previews|assets|audio|exports|photos|video$/i.test(n)) {
                    walk(full, depthLeft - 1);
                }
            }
        }
        for (var r = 0; r < ROOTS.length; r++) walk(ROOTS[r].dir, ROOTS[r].depth);
        /* 1 por pasta de projeto, mais recentes primeiro; dedupe por nome
           (18York existe local E no NAS — mesma entrega) */
        found.sort(function (a, b) { return b.mtime - a.mtime; });
        var seen = {}, uniq = [];
        for (var u = 0; u < found.length; u++) {
            if (seen[found[u].project]) continue;
            seen[found[u].project] = 1;
            uniq.push(found[u]);
        }
        return uniq;
    }

    /* ── parser do prproj ────────────────────────────────────────────── */
    function parsePrproj(file) {
        var xml = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');

        /* indice de objetos: id → {tag, start} (ObjectID numerico e ObjectUID uuid) */
        var idx = {};
        var re = /<(\w+) Object(?:ID|UID)="([^"]+)"/g, m;
        while ((m = re.exec(xml)) !== null) idx[m[2]] = { tag: m[1], at: m.index };

        function block(id) {
            var e = idx[id];
            if (!e) return '';
            var close = '</' + e.tag + '>';
            var end = xml.indexOf(close, e.at);
            return end < 0 ? '' : xml.slice(e.at, end);
        }
        function tagOf(id) { return idx[id] ? idx[id].tag : ''; }
        function one(rx, s) { var mm = rx.exec(s); return mm ? mm[1] : null; }

        /* media: id → FilePath */
        function mediaPath(mediaUid) {
            var b = block(mediaUid);
            return one(/<FilePath>([^<]*)<\/FilePath>/, b);
        }

        /* componente: {match, display, params{nome:valor}, lut} */
        function parseComponent(ref) {
            var b = block(ref);
            var comp = {
                match: one(/<MatchName>([^<]*)<\/MatchName>/, b),
                display: one(/<DisplayName>([^<]*)<\/DisplayName>/, b),
                params: {}, lut: null
            };
            var prefs = [], pr = /<Param Index="\d+" ObjectRef="(\d+)"\/>/g, pm;
            while ((pm = pr.exec(b)) !== null) prefs.push(pm[1]);
            for (var i = 0; i < prefs.length; i++) {
                var pb = block(prefs[i]);
                var name = one(/<Name>([^<]*)<\/Name>/, pb);
                var kf = one(/<StartKeyframe>([^<]*)<\/StartKeyframe>/, pb);
                /* nomes repetem entre secoes do Lumetri (Basic vem primeiro,
                   Secondary/Preset depois) — o PRIMEIRO vence, senao o
                   Temperature=0 da secondary sobrescreve o Basic real */
                if (name && name.replace(/\s/g, '') && kf && !(name in comp.params)) {
                    var parts = kf.split(',');
                    if (parts.length >= 2) {
                        var v = parts[1];
                        if (v === 'true' || v === 'false') comp.params[name] = (v === 'true');
                        else {
                            var f = parseFloat(v);
                            /* numeros gigantes = cores empacotadas — irrelevantes aqui */
                            if (isFinite(f) && Math.abs(f) < 1e12) comp.params[name] = f;
                        }
                    }
                }
                var blob = one(/<StartKeyframeValue Encoding="base64"[^>]*>([A-Za-z0-9+\/=\s]*?)<\/StartKeyframeValue>/, pb);
                if (blob && blob.replace(/\s/g, '').length > 40) {
                    var txt;
                    try { txt = Buffer.from(blob.replace(/\s/g, ''), 'base64').toString('utf8'); } catch (e) { txt = ''; }
                    if (txt.indexOf('<Lumetri>') >= 0) {
                        var lm = /<LUT>"([^"]+)"<\/LUT>/.exec(txt) || /<__Preset>"([^"]+)"<\/__Preset>/.exec(txt) ||
                                 /<filename>([^<]+)<\/filename>/.exec(txt);
                        if (lm && !comp.lut) comp.lut = lm[1];
                    }
                }
            }
            return comp;
        }

        function parseChain(chainRef) {
            var b = block(chainRef);
            var out = [], cr = /<Component Index="\d+" ObjectRef="(\d+)"\/>/g, cm;
            while ((cm = cr.exec(b)) !== null) out.push(parseComponent(cm[1]));
            return out;
        }

        /* masterclips (itens AG do template + clips normais) */
        var masters = {};                       /* uid → {name, isAdj, lut, mediaPath} */
        var mre = /<MasterClip ObjectUID="([^"]+)"/g, mm2;
        while ((mm2 = mre.exec(xml)) !== null) {
            var uid = mm2[1];
            var b = block(uid);
            var name = one(/<Name>([^<]*)<\/Name>/, b);
            var isAdj = /<IsAdjustmentLayer>true<\/IsAdjustmentLayer>/.test(b);
            var rec = { name: name, isAdj: isAdj, lut: null, mediaPath: null };
            if (isAdj) {
                var chainRef = one(/<VideoComponentChain ObjectRef="(\d+)"\/>/, b);
                if (chainRef) {
                    var comps = parseChain(chainRef);
                    for (var c = 0; c < comps.length; c++)
                        if (comps[c].lut) { rec.lut = comps[c].lut; break; }
                }
            } else {
                /* MasterClip → Clips/Clip[0] → VideoClip → Source → *MediaSource → Media URef */
                var clipRef = one(/<Clip Index="0" ObjectRef="(\d+)"\/>/, b);
                if (clipRef) {
                    var srcRef = one(/<Source ObjectRef="(\d+)"\/>/, block(clipRef));
                    if (srcRef) {
                        var medUid = one(/<Media ObjectURef="([^"]+)"\/>/, block(srcRef));
                        if (medUid) rec.mediaPath = mediaPath(medUid);
                    }
                }
            }
            masters[uid] = rec;
        }

        /* track item */
        function parseTrackItem(ref) {
            var b = block(ref);
            var ti = one(/<TrackItem Version[^>]*>([\s\S]*?)<\/TrackItem>/, b) || '';
            var start = one(/<Start>(-?\d+)<\/Start>/, ti);
            var end = one(/<End>(-?\d+)<\/End>/, ti);
            var sub = one(/<SubClip ObjectRef="(\d+)"\/>/, b);
            var chainRef = one(/<ComponentOwner Version[^>]*>\s*<Components ObjectRef="(\d+)"\/>/, b);
            var name = null, masterUid = null;
            if (sub) {
                var sb = block(sub);
                name = one(/<Name>([^<]*)<\/Name>/, sb);
                masterUid = one(/<MasterClip ObjectURef="([^"]+)"\/>/, sb);
            }
            return {
                start: start ? parseInt(start, 10) / TICKS : 0,
                end: end ? parseInt(end, 10) / TICKS : 0,
                name: name, masterUid: masterUid, chainRef: chainRef
            };
        }

        /* sequences → tracks ordenadas → itens */
        var seqs = [];
        var sre = /<Sequence ObjectUID="([^"]+)"/g, sm;
        while ((sm = sre.exec(xml)) !== null) {
            var sb = block(sm[1]);
            var seq = { name: one(/<Name>([^<]*)<\/Name>/, sb), tracks: [] };
            var tgr = /<Second Object(?:URef|Ref)="([^"]+)"\/>/g, tgm;
            while ((tgm = tgr.exec(sb)) !== null) {
                if (tagOf(tgm[1]) !== 'VideoTrackGroup') continue;
                var gb = block(tgm[1]);
                var trr = /<Track Index="(\d+)" Object(?:URef|Ref)="([^"]+)"\/>/g, trm;
                var ordered = [];
                while ((trm = trr.exec(gb)) !== null) ordered.push({ i: parseInt(trm[1], 10), id: trm[2] });
                ordered.sort(function (a, b2) { return a.i - b2.i; });
                for (var t = 0; t < ordered.length; t++) {
                    var tb = block(ordered[t].id);
                    if (!tb) continue;
                    var tname = one(/<MZ\.TrackName>([^<]*)<\/MZ\.TrackName>/, tb) || ('V' + (t + 1));
                    var clipSec = one(/<ClipItems Version[^>]*>([\s\S]*?)<\/ClipItems>/, tb) || '';
                    var items = [], ir = /<TrackItem Index="\d+" ObjectRef="(\d+)"\/>/g, im;
                    while ((im = ir.exec(clipSec)) !== null) items.push(parseTrackItem(im[1]));
                    seq.tracks.push({ index: t, name: tname, items: items });
                }
            }
            seqs.push(seq);
        }
        return { xml: null, masters: masters, sequences: seqs, parseChainByRef: parseChain };
    }

    /* ── classificacao de fonte ──────────────────────────────────────── */
    var STILL_RE = /\.(png|jpe?g|gif|psd|ai|mogrt|tiff?)$/i;
    function classify(name, mediaP) {
        var base = (mediaP ? path.basename(mediaP) : (name || ''));
        if (STILL_RE.test(base) || STILL_RE.test(name || '')) return 'graphic';
        if (/\.aep$/i.test(base) || /\bcomp\b/i.test(name || '')) return 'comp';
        if (/^DJI/i.test(name || '') || /^DJI/i.test(base)) return 'drone';
        return 'camera';
    }

    /* ── mineracao de um projeto ─────────────────────────────────────── */
    function mineProject(file, projectName) {
        var P = parsePrproj(file);
        var out = {
            project: projectName || path.basename(path.dirname(path.dirname(file))),
            file: file,
            agItems: {}, sequences: [], mainSequence: null,
            gradeSegments: [], conversionSegments: [], creativeSegments: [],
            contentItems: [], compCoverage: null, warnings: []
        };
        for (var uid in P.masters) {
            var mc = P.masters[uid];
            if (mc.isAdj && mc.name && /^AG_/.test(mc.name))
                /* template veio do Windows: caminhos R:\ usam backslash */
                out.agItems[mc.name] = mc.lut ? path.basename(mc.lut.replace(/\\/g, '/')) : null;
        }

        /* sequence principal = mais instancias AG_Grade */
        var best = null, bestCount = -1;
        for (var s = 0; s < P.sequences.length; s++) {
            var seq = P.sequences[s], count = 0;
            for (var t = 0; t < seq.tracks.length; t++)
                for (var i = 0; i < seq.tracks[t].items.length; i++)
                    if (/^AG_Grade/.test(seq.tracks[t].items[i].name || '')) count++;
            out.sequences.push({ name: seq.name, agGradeItems: count });
            if (count > bestCount) { bestCount = count; best = seq; }
        }
        if (!best || bestCount <= 0) { out.warnings.push('nenhuma sequence com AG_Grade'); return out; }
        out.mainSequence = best.name;

        /* itens de conteudo (nao-AG) para mapear o que esta sob cada segmento */
        var content = [];
        for (var t2 = 0; t2 < best.tracks.length; t2++) {
            var trk = best.tracks[t2];
            if (/^\[AG\]/.test(trk.name)) continue;
            for (var i2 = 0; i2 < trk.items.length; i2++) {
                var it = trk.items[i2];
                if (!it.name || /^AG_/.test(it.name)) continue;
                var mp = it.masterUid && P.masters[it.masterUid] ? P.masters[it.masterUid].mediaPath : null;
                var cls = classify(it.name, mp);
                if (cls === 'graphic') continue;
                content.push({ start: it.start, end: it.end, name: it.name, mediaPath: mp, cls: cls, track: trk.name });
            }
        }
        content.sort(function (a, b2) { return a.start - b2.start; });
        out.contentItems = content;

        function under(seg) {
            var hits = [], mid = (seg.start + seg.end) / 2;
            for (var c = 0; c < content.length; c++) {
                var o = Math.min(seg.end, content[c].end) - Math.max(seg.start, content[c].start);
                if (o > 0.2) hits.push({ name: content[c].name, cls: content[c].cls, overlap: Math.round(o * 100) / 100 });
            }
            hits.sort(function (a, b2) { return b2.overlap - a.overlap; });
            return hits.slice(0, 3);
        }

        /* segmentos AG por track */
        for (var t3 = 0; t3 < best.tracks.length; t3++) {
            var trk2 = best.tracks[t3];
            if (!/^\[AG\]/.test(trk2.name)) continue;
            for (var i3 = 0; i3 < trk2.items.length; i3++) {
                var it2 = trk2.items[i3];
                if (!it2.name) continue;
                var seg = {
                    start: Math.round(it2.start * 100) / 100,
                    end: Math.round(it2.end * 100) / 100,
                    item: it2.name, track: trk2.name
                };
                var comps = it2.chainRef ? P.parseChainByRef(it2.chainRef) : [];
                if (/^AG_Grade/.test(it2.name)) {
                    for (var c2 = 0; c2 < comps.length; c2++)
                        if (/Lumetri/.test(comps[c2].match || '')) seg.lumetri = comps[c2].params;
                    seg.under = under(seg);
                    out.gradeSegments.push(seg);
                } else if (/^AG_Conversion/.test(it2.name)) {
                    seg.lut = out.agItems[it2.name] || null;
                    seg.under = under(seg);
                    out.conversionSegments.push(seg);
                } else if (/^AG_Creative/.test(it2.name)) {
                    for (var c3 = 0; c3 < comps.length; c3++) {
                        var mn = comps[c3].match || '';
                        if (/Opacity/.test(mn) && comps[c3].params.Opacity !== undefined)
                            seg.opacity = comps[c3].params.Opacity;
                    }
                    seg.lut = out.agItems[it2.name] || null;
                    seg.under = under(seg);
                    out.creativeSegments.push(seg);
                }
            }
        }

        /* cobertura dos comps: trechos de comp na timeline com conversao em cima? */
        var compSegs = 0, covered = 0;
        for (var c4 = 0; c4 < content.length; c4++) {
            if (content[c4].cls !== 'comp') continue;
            compSegs++;
            for (var v = 0; v < out.conversionSegments.length; v++) {
                var cs = out.conversionSegments[v];
                var o2 = Math.min(content[c4].end, cs.end) - Math.max(content[c4].start, cs.start);
                if (o2 > (content[c4].end - content[c4].start) * 0.5) { covered++; break; }
            }
        }
        out.compCoverage = { compItems: compSegs, comConversao: covered };
        return out;
    }

    /* ── agregacao (defaults = moda por parametro) ───────────────────── */
    var GRADE_KEYS = ['Exposure', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks',
                      'Temperature', 'Tint', 'Saturation', 'Vibrance'];
    function aggregate(projects) {
        var agg = {
            projects: projects.length,
            gradeInstances: 0, gradeCorrected: 0,
            paramStats: {},                      /* nome → {mode, deviations:[{v,project,at,under}]} */
            fonteLut: {},                        /* classe/prefixo → {lut: count} */
            creativeFreq: {}, creativeOpacityDev: [],
            compCoverage: { compItems: 0, comConversao: 0 }
        };
        /* moda por parametro */
        var values = {};
        projects.forEach(function (p) {
            p.gradeSegments.forEach(function (g) {
                if (!g.lumetri) return;
                GRADE_KEYS.forEach(function (k) {
                    if (g.lumetri[k] === undefined) return;
                    (values[k] = values[k] || {})[g.lumetri[k]] = (values[k][g.lumetri[k]] || 0) + 1;
                });
            });
        });
        var mode = {};
        for (var k in values) {
            var bestV = null, bestC = -1;
            for (var v in values[k]) if (values[k][v] > bestC) { bestC = values[k][v]; bestV = parseFloat(v); }
            mode[k] = bestV;
        }
        projects.forEach(function (p) {
            agg.compCoverage.compItems += (p.compCoverage ? p.compCoverage.compItems : 0);
            agg.compCoverage.comConversao += (p.compCoverage ? p.compCoverage.comConversao : 0);
            p.gradeSegments.forEach(function (g) {
                agg.gradeInstances++;
                if (!g.lumetri) return;
                var touched = false;
                GRADE_KEYS.forEach(function (k) {
                    if (g.lumetri[k] === undefined || mode[k] === null) return;
                    if (Math.abs(g.lumetri[k] - mode[k]) > 0.01) {
                        touched = true;
                        (agg.paramStats[k] = agg.paramStats[k] || { mode: mode[k], deviations: [] })
                            .deviations.push({
                                v: Math.round(g.lumetri[k] * 100) / 100, project: p.project,
                                at: g.start, under: (g.under && g.under[0]) ? g.under[0].cls + ':' + g.under[0].name : null
                            });
                    }
                });
                if (touched) agg.gradeCorrected++;
            });
            p.conversionSegments.forEach(function (cs) {
                if (!cs.lut || !cs.under || !cs.under.length) return;
                var key = cs.under[0].cls === 'drone' ? ('drone:' + (cs.under[0].name.split('_')[0] || 'DJI')) : cs.under[0].cls;
                (agg.fonteLut[key] = agg.fonteLut[key] || {})[cs.lut] = (agg.fonteLut[key][cs.lut] || 0) + 1;
            });
            var seen = {};
            p.creativeSegments.forEach(function (cr) {
                if (cr.item && !seen[cr.item]) { seen[cr.item] = 1; agg.creativeFreq[cr.item] = (agg.creativeFreq[cr.item] || 0) + 1; }
                if (cr.opacity !== undefined && Math.abs(cr.opacity - 100) > 0.5)
                    agg.creativeOpacityDev.push({
                        project: p.project, at: cr.start, opacity: cr.opacity,
                        under: (cr.under && cr.under[0]) ? cr.under[0].cls + ':' + cr.under[0].name : null
                    });
            });
        });
        agg.gradeMode = mode;
        return agg;
    }

    /* ── report HTML ─────────────────────────────────────────────────── */
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
    function fmtT(sec) {
        var mn = Math.floor(sec / 60), ss = sec - mn * 60;
        return mn + ':' + (ss < 10 ? '0' : '') + ss.toFixed(1);
    }
    function report(projects, agg) {
        var h = ['<!doctype html><meta charset="utf-8"><title>Desire — Grade Corpus</title><style>',
            'body{font:13px -apple-system,sans-serif;background:#111;color:#ddd;margin:24px}',
            'h1,h2{color:#fff} table{border-collapse:collapse;margin:8px 0 20px}',
            'td,th{border:1px solid #333;padding:3px 8px;text-align:left} th{background:#222}',
            '.dev{color:#ffb347} .ok{color:#7c7} .proj{background:#1a1a1a;border:1px solid #333;',
            'border-radius:8px;padding:10px 14px;margin:10px 0}</style>'];
        h.push('<h1>Grade Corpus — ' + projects.length + ' projetos</h1>');
        h.push('<h2>Correções no AG_Grade (por segmento)</h2>');
        h.push('<p>' + agg.gradeInstances + ' instâncias AG_Grade; <b>' + agg.gradeCorrected +
               '</b> com correção (≠ moda).</p><table><tr><th>Parâmetro</th><th>Moda (default)</th><th># desvios</th><th>Exemplos</th></tr>');
        for (var k in agg.paramStats) {
            var st = agg.paramStats[k];
            var ex = st.deviations.slice(0, 6).map(function (d) {
                return esc(d.project) + '@' + fmtT(d.at) + '→<b class="dev">' + d.v + '</b>' + (d.under ? ' <i>(' + esc(d.under) + ')</i>' : '');
            }).join('; ');
            h.push('<tr><td>' + esc(k) + '</td><td>' + st.mode + '</td><td>' + st.deviations.length + '</td><td>' + ex + '</td></tr>');
        }
        h.push('</table><h2>Fonte → LUT de conversão (uso real nas timelines)</h2><table><tr><th>Fonte</th><th>LUT</th><th>Segmentos</th></tr>');
        for (var f in agg.fonteLut) for (var l in agg.fonteLut[f])
            h.push('<tr><td>' + esc(f) + '</td><td>' + esc(l) + '</td><td>' + agg.fonteLut[f][l] + '</td></tr>');
        h.push('</table><h2>Creative</h2><table><tr><th>Item</th><th>Projetos</th></tr>');
        for (var cr in agg.creativeFreq) h.push('<tr><td>' + esc(cr) + '</td><td>' + agg.creativeFreq[cr] + '</td></tr>');
        h.push('</table><p>Opacidade do Creative alterada em ' + agg.creativeOpacityDev.length + ' segmentos: ' +
            agg.creativeOpacityDev.slice(0, 10).map(function (d) {
                return esc(d.project) + '@' + fmtT(d.at) + '→' + d.opacity + '%' + (d.under ? ' (' + esc(d.under) + ')' : '');
            }).join('; ') + '</p>');
        h.push('<h2>Cobertura de comps .aep pela conversão</h2><p>' + agg.compCoverage.comConversao + '/' +
               agg.compCoverage.compItems + ' trechos de comp têm conversão em cima nos entregues.</p>');
        h.push('<h2>Projetos</h2>');
        projects.forEach(function (p) {
            h.push('<div class="proj"><b>' + esc(p.project) + '</b> — seq "' + esc(p.mainSequence) + '" — ' +
                p.gradeSegments.length + ' grade segs, ' + p.conversionSegments.length + ' conversion segs, ' +
                p.creativeSegments.length + ' creative segs' +
                (p.compCoverage ? ' — comps ' + p.compCoverage.comConversao + '/' + p.compCoverage.compItems + ' cobertos' : '') +
                (p.warnings.length ? ' <span class="dev">[' + esc(p.warnings.join('; ')) + ']</span>' : '') +
                '<br><small>' + esc(p.file) + '</small></div>');
        });
        return h.join('\n');
    }

    /* gradeStats.json = o que o Auto Correct (autoGrade.js) le: por classe de
       footage (camera/comp/drone/_all), mediana + p10/p90 de cada param, a
       partir dos desvios do corpus. (portado do script de calibracao 16/jul) */
    var STAT_PARAMS = ['Exposure', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks', 'Temperature', 'Tint'];
    function writeGradeStats(agg) {
        var byclass = {};
        function push(cls, p, v) { (byclass[cls] = byclass[cls] || {}); (byclass[cls][p] = byclass[cls][p] || []).push(v); }
        STAT_PARAMS.forEach(function (p) {
            var st = agg.paramStats && agg.paramStats[p];
            if (!st || !st.deviations) return;
            st.deviations.forEach(function (d) {
                var v = parseFloat(d.v); if (isNaN(v)) return;
                var cls = String(d.under || '?').split(':')[0].split('|')[0].trim().toLowerCase() || '?';
                push(cls, p, v); push('_all', p, v);
            });
        });
        function stats(vals) {
            if (!vals || vals.length < 3) return null;
            var s = vals.slice().sort(function (a, b) { return a - b; });
            function r2(x) { return Math.round(x * 100) / 100; }
            function pc(q) { return r2(s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]); }
            var mid = Math.floor(s.length / 2);
            var med = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
            return { median: r2(med), p10: pc(0.1), p90: pc(0.9), n: vals.length };
        }
        var out = {};
        ['camera', 'comp', 'drone', '_all'].forEach(function (cls) {
            out[cls] = {};
            STAT_PARAMS.forEach(function (p) {
                var s = byclass[cls] && byclass[cls][p] ? stats(byclass[cls][p]) : null;
                if (s) out[cls][p] = s;
            });
        });
        fs.writeFileSync(path.join(CAL_DIR, 'gradeStats.json'), JSON.stringify(out, null, 1));
        return out;
    }

    /* carrega TODOS os projetos cacheados, deduplicando por nome (o mais recente) */
    function loadAllCached() {
        var byProj = {};
        try {
            fs.readdirSync(CACHE_DIR).forEach(function (f) {
                if (!/\.json$/.test(f)) return;
                try {
                    var full = path.join(CACHE_DIR, f);
                    var j = JSON.parse(fs.readFileSync(full, 'utf8'));
                    var m = fs.statSync(full).mtimeMs;
                    if (!byProj[j.project] || m > byProj[j.project].m) byProj[j.project] = { j: j, m: m };
                } catch (e) {}
            });
        } catch (e) {}
        return Object.keys(byProj).map(function (k) { return byProj[k].j; });
    }

    function writeCorpus(results) {
        var agg = aggregate(results);
        fs.writeFileSync(path.join(CAL_DIR, 'gradeCorpus.json'),
            JSON.stringify({ minedAt: new Date().toISOString(), aggregate: agg, projects: results }, null, 1));
        fs.writeFileSync(path.join(CAL_DIR, 'gradeReport.html'), report(results, agg));
        writeGradeStats(agg);
        return agg;
    }

    /* ── CLI ─────────────────────────────────────────────────────────── */
    function arg(name, dflt) {
        var i = process.argv.indexOf(name);
        return i >= 0 ? (process.argv[i + 1]) : dflt;
    }
    var cmd = process.argv[2];

    if (cmd === 'discover') {
        var limit = parseInt(arg('--limit', '20'), 10);
        var list = findProjects().slice(0, limit);
        list.forEach(function (p) {
            console.log(new Date(p.mtime).toISOString().slice(0, 10) + '  ' +
                (p.size / 1048576).toFixed(1) + 'MB  ' + p.project + '  →  ' + p.prproj);
        });
        console.log('\n' + list.length + ' projetos (mais recentes primeiro).');

    } else if (cmd === 'mine') {
        var file = arg('--file', null);
        var noCache = process.argv.indexOf('--no-cache') >= 0;
        var targets;
        if (file) targets = [{ project: path.basename(path.dirname(path.dirname(file))), prproj: file, mtime: 0 }];
        else targets = findProjects().slice(0, parseInt(arg('--limit', '20'), 10));

        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        var results = [];
        targets.forEach(function (t, n) {
            var st; try { st = fs.statSync(t.prproj); } catch (e) { console.log('SKIP (stat): ' + t.prproj); return; }
            var key = t.project.replace(/[^\w]+/g, '_') + '_' + Math.round(st.mtimeMs) + '.json';
            var cf = path.join(CACHE_DIR, key);
            if (!noCache && fs.existsSync(cf)) {
                results.push(JSON.parse(fs.readFileSync(cf, 'utf8')));
                console.log((n + 1) + '/' + targets.length + '  (cache) ' + t.project);
                return;
            }
            try {
                var r = mineProject(t.prproj, t.project);
                fs.writeFileSync(cf, JSON.stringify(r));
                results.push(r);
                console.log((n + 1) + '/' + targets.length + '  ' + t.project + ' — grade segs: ' +
                    r.gradeSegments.length + ', conv: ' + r.conversionSegments.length +
                    (r.warnings.length ? '  [' + r.warnings.join('; ') + ']' : ''));
            } catch (e) {
                console.log((n + 1) + '/' + targets.length + '  ERRO ' + t.project + ': ' + e.message);
            }
        });
        var agg = aggregate(results);
        fs.writeFileSync(path.join(CAL_DIR, 'gradeCorpus.json'),
            JSON.stringify({ minedAt: new Date().toISOString(), aggregate: agg, projects: results }, null, 1));
        fs.writeFileSync(path.join(CAL_DIR, 'gradeReport.html'), report(results, agg));
        console.log('\nCorpus: ' + results.length + ' projetos → calibration/gradeCorpus.json + gradeReport.html');
        console.log('AG_Grade: ' + agg.gradeInstances + ' instâncias, ' + agg.gradeCorrected + ' corrigidas.');

    } else if (cmd === 'grow') {
        /* Corpus Auto-Grower: minera o projeto atual e ADICIONA ao corpus
           (junta com todos os cacheados), re-agrega e regenera gradeStats. */
        var gfile = arg('--file', null);
        if (!gfile) { console.log('ERR|grow needs --file <x.prproj>'); process.exit(1); }
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        var pname = path.basename(path.dirname(path.dirname(gfile)));
        var r;
        try {
            var st = fs.statSync(gfile);
            r = mineProject(gfile, pname);
            var key = pname.replace(/[^\w]+/g, '_') + '_' + Math.round(st.mtimeMs) + '.json';
            fs.writeFileSync(path.join(CACHE_DIR, key), JSON.stringify(r));
            console.log('minerado: ' + pname + ' — grade segs ' + r.gradeSegments.length +
                (r.warnings.length ? ' [' + r.warnings.join('; ') + ']' : ''));
        } catch (e) { console.log('ERR|mining: ' + e.message); process.exit(1); }
        /* parte do CORPUS existente (autoritativo — nunca perde projeto),
           substitui/adiciona ESTE projeto por nome, re-agrega. */
        var existing = [];
        try { existing = JSON.parse(fs.readFileSync(path.join(CAL_DIR, 'gradeCorpus.json'), 'utf8')).projects || []; } catch (e) {}
        var had = false;
        existing = existing.map(function (p) { if (p.project === r.project) { had = true; return r; } return p; });
        if (!had) existing.push(r);
        var agg = writeCorpus(existing);
        console.log('OK|corpus: ' + existing.length + ' projects (' + (had ? 'updated' : 'ADDED') + ' "' +
            r.project + '"), ' + agg.gradeInstances + ' AG_Grade instances. gradeStats.json regenerated.');

    } else if (cmd === 'stats') {
        /* regenera so o gradeStats.json a partir do corpus atual (sem minerar) */
        var corpus = JSON.parse(fs.readFileSync(path.join(CAL_DIR, 'gradeCorpus.json'), 'utf8'));
        writeGradeStats(corpus.aggregate);
        console.log('gradeStats.json regenerado do corpus (' + corpus.projects.length + ' projetos).');

    } else {
        console.log('uso: node js/gradeMiner.js discover | mine [--file x] | grow --file x | stats');
    }
}());
