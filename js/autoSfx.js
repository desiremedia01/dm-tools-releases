/* ── Auto SFX v2 — regras ditadas pelo Matheus (15/jul/2026) ───────────
   1. SEMPRE whoosh quando ha speed ramp de um clip para OUTRO;
      o PICO do whoosh (1.52s no arquivo) cai EXATAMENTE no meio entre os
      clips (fronteira dos layers no comp).
   2. SEMPRE day_to_night quando ha um NULL com Gradient Wipe;
      o PICO (1.56s) cai no MEIO da duracao do null (≈ meio do slider do
      wipe — validado nos 2 D2N do 18 York com erro de 1-2 frames).
   3. Ambience por CONTEUDO (minerado da timeline entregue): birds em cada
      regiao EXTERIOR ate o meio do D2N (ou fim do video); depois do D2N,
      pool.mp3 se ha piscina na tela, senao crickets, ate a regiao acabar.
   Posicoes sao FISICAS (fronteiras/meios) — beats sairam do modelo, o
   botao nao depende mais de analise de musica. Generico para QUALQUER
   projeto: contagens vem dos dados, multiplos .aep, zero hardcode.
   Fronteiras exatas de layer lidas DIRETO do binario .aep (formato ldta
   quebrado 15/jul, validado 54/54 vs AE) — sem probe, sem AE, qualquer
   projeto. Fallback raro: keyframes de time remap (~aprox no status).
   Gate: `node js/autoSfx.js validate` compara com a timeline entregue do
   18 York (dados cacheados no fixture — roda sem NAS).                  */
(function() {
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
    var CAL_DIR = dmRoot() + '/calibration';

    /* medidos nos arquivos da biblioteca (ffmpeg RMS) */
    var WHOOSH_PEAK = 1.52;         // pico do whoosh_long dentro do arquivo
    var D2N_PEAK = 1.56;            // pico do day_to_night_long
    var WHOOSH_LEN = 4.5;           // duracao aprox p/ empilhamento de tracks
    var D2N_LEN = 5.0;
    var AMB_MAX = 58.0;             // ambiences tem ~59s de arquivo
    var AMB_MIN_SPAN = 2.0;         // regiao menor que isso nao ganha ambience
    var AMB_JL = 0.5;               // J/L cut: audio entra antes e segura depois do corte
                                    // (16/jul: 1.0 parecia entrar cedo/sair tarde — metade)
    var AMB_FADE = 1.0;             // fade in/out padrao dos ambiences
    var XFADE = 1.0;                // crossfade birds<->crickets centrado no d2n (15/jul: 1s)
    var CRICKETS_GAIN = 0.1;        // -20dB (10^(-20/20)) — 16/jul: -12 ainda alto no ouvido
    var TR_DIV = 12800;             // keyframe time: 256 * 50fps (clips FX3)
    var SLIDER_DIV = 25600;         // sliders do Gradient Controller (validado)
    var EVENT_MERGE = 0.6;          // layer de cima + cauda = UM evento
    var TRANS_HALF = 0.42;          // pico = entrada do layer + 0.42s (meio da
                                    // transicao de ~0.85s — medido em 10 whooshes
                                    // do 18York, desvio ±0.04s)

    var EXTERIOR_CATS = { facade: 1, drone_aerial: 1, pool_bbq: 1, balcony: 1, exterior: 1, pool: 1 };

    /* ── parser RIFX do .aep: comps, time remap, sliders, sources ────── */
    function parseAep(aepPath) {
        var fs = require('fs');
        var buf = fs.readFileSync(aepPath);
        if (buf.slice(0, 4).toString('binary') !== 'RIFX') return { error: 'not a RIFX .aep' };
        var comps = {}, allNames = {};
        var TRM = Buffer.from('ADBE Time Remapping');
        var SLD = Buffer.from('ADBE Slider Control-0001');

        function walkItem(off, end, item) {
            while (off + 8 <= end) {
                var tag = buf.slice(off, off + 4).toString('binary');
                var size = buf.readUInt32BE(off + 4);
                var body = off + 8;
                if (tag === 'LIST') {
                    var ltype = buf.slice(body, body + 4).toString('binary');
                    if (ltype === 'Item') {
                        var child = { name: null, tr: [], sl: [], layers: [], a: body, b: body + size };
                        walkItem(body + 4, body + size, child);
                        if (child.name && child.id !== undefined) allNames[child.id] = child.name;
                        if (child.name && (child.tr.length || child.sl.length || child.layers.length))
                            comps[child.name] = child;
                    } else if (ltype === 'Layr' && item) {
                        // layer bounds direto do binario (formato quebrado
                        // 15/jul, validado 54/54 contra o probe do AE):
                        // ldta: st=i32@12/u32@16, in=st+u32@20/u32@24,
                        // out=st+u32@28/u32@32; flags u32@36: 0x01 enabled,
                        // 0x8000 null, 0x0200 adjustment
                        var lk = buf.indexOf('ldta', body, 'binary');
                        if (lk > 0 && lk < body + size) {
                            var lb = lk + 8;
                            var stD = buf.readUInt32BE(lb + 16) || 1;
                            var inD = buf.readUInt32BE(lb + 24) || 1;
                            var outD = buf.readUInt32BE(lb + 32) || 1;
                            var st0 = buf.readInt32BE(lb + 12) / stD;
                            var flags = buf.readUInt32BE(lb + 36);
                            var lslice = buf.slice(body, body + size).toString('binary');
                            item.layers.push({
                                st: st0,
                                inP: st0 + buf.readUInt32BE(lb + 20) / inD,
                                outP: st0 + buf.readUInt32BE(lb + 28) / outD,
                                enabled: (flags & 1) ? 1 : 0,
                                nul: (flags & 0x8000) ? 1 : 0,
                                adj: (flags & 0x200) ? 1 : 0,
                                gw: lslice.indexOf('ADBE Gradient Wipe') >= 0 ? 1 : 0,
                                slider: lslice.indexOf('ADBE Slider Control') >= 0 ? 1 : 0,
                                srcId: buf.readUInt32BE(lb + 40),
                                trs: []
                            });
                            item._curLayer = item.layers[item.layers.length - 1];
                        }
                        walkItem(body + 4, body + size, item);
                        item._curLayer = null;   // saiu do Layr
                    } else {
                        walkItem(body + 4, body + size, item);
                    }
                } else if (item) {
                    if (tag === 'Utf8' && item.name === null && size < 200)
                        item.name = buf.slice(body, body + size).toString('utf8');
                    else if (tag === 'idta' && item.id === undefined && size >= 20)
                        item.id = buf.readUInt32BE(body + 16);
                    else if (tag === 'tdmn') {
                        item._tr = buf.slice(body, body + TRM.length).equals(TRM);
                        item._sl = buf.slice(body, body + SLD.length).equals(SLD);
                    } else if (tag === 'lhd3' && (item._tr || item._sl)) {
                        item._lhd = { count: buf.readUInt32BE(body + 8), rec: buf.readUInt32BE(body + 16) };
                    } else if (tag === 'ldat' && (item._tr || item._sl) && item._lhd &&
                               item._lhd.rec === 48 && item._lhd.count * 48 <= size) {
                        var div = item._sl ? SLIDER_DIV : TR_DIV;
                        var keys = [];
                        for (var k = 0; k < item._lhd.count; k++) {
                            var o = body + k * 48;
                            keys.push([(buf.readUInt16BE(o) * 65536 + buf.readUInt16BE(o + 2)) / div,
                                       buf.readDoubleBE(o + 8)]);
                        }
                        (item._sl ? item.sl : item.tr).push(keys);
                        // associa ao layer corrente (o walk respeita o aninhamento)
                        if (item._tr && item._curLayer) item._curLayer.trs.push(keys);
                        item._tr = false; item._sl = false; item._lhd = null;
                    }
                }
                off = body + size + (size & 1);
            }
        }
        walkItem(12, buf.length, null);
        var byId = {};
        Object.keys(comps).forEach(function(n) { if (comps[n].id !== undefined) byId[comps[n].id] = comps[n]; });
        comps._byId = byId;
        comps._names = allNames;
        Object.keys(comps).forEach(function(n) {
            if (n === '_byId') return;
            var c = comps[n];
            var slice = buf.slice(c.a, c.b).toString('binary');
            c.d2n = slice.indexOf('Transition Completion') >= 0 || slice.indexOf('Gradient Controller') >= 0;
            delete c.a; delete c.b;
        });
        return comps;
    }

    /* ── eventos de transicao clip->clip (whoosh) ───────────────────────
       exato: fronteiras de layer decodificadas do proprio .aep.
       fallback: saltos de velocidade no time remap — APROXIMADO, o pico
       pode errar a fronteira por alguns decimos ate o probe rodar. */
    function transitionEvents(comp) {
        var layersInfo = comp.layers;
        if (layersInfo && layersInfo.length) {
            // corte real = entrada de layer VISIVEL (enabled; fatias de
            // musica vem desabilitadas) que nao seja null/adjustment nem
            // Gradient Wipe (esses sao revelados pelo wipe, nao por corte)
            function speedAt(L, t) {
                var lt = t - L.st;
                var best = null;
                (L.trs || []).forEach(function(ks) {
                    for (var q = 1; q < ks.length; q++)
                        if (ks[q - 1][0] <= lt && lt <= ks[q][0]) {
                            var dt = ks[q][0] - ks[q - 1][0];
                            if (dt > 0) best = (ks[q][1] - ks[q - 1][1]) / dt;
                        }
                });
                return best;
            }
            var vids2 = layersInfo.filter(function(L) {
                return L.enabled && !L.nul && !L.adj && !L.gw &&
                       L.inP > -60 && L.inP < 3600 && L.outP > L.inP;
            });
            var ins = [];
            vids2.forEach(function(L) {
                if (L.inP <= 0.05) return;
                // quem esta saindo nesse corte?
                var ramp = false;
                vids2.forEach(function(O) {
                    if (O === L || !(O.inP < L.inP - 0.02 && L.inP - 0.02 < O.outP)) return;
                    var s = speedAt(O, L.inP);
                    if (s === null && !(O.trs && O.trs.length)) ramp = true;   // precomp de drone: ramp vive dentro
                    else if (s !== null && s > 1.1) ramp = true;               // saida acelerada = speed ramp
                });
                if (!ramp) {
                    // ramp de PARTIDA: o clip que entra acelera logo apos o
                    // corte e fica rapido por um trecho VISIVEL (>=1.5s antes
                    // da proxima entrada) — o facade->living do 18York
                    var nextIn = 1e9;
                    vids2.forEach(function(N) { if (N.inP > L.inP + 0.02 && N.inP < nextIn) nextIn = N.inP; });
                    (L.trs || []).forEach(function(ks) {
                        for (var q = 1; q < ks.length; q++) {
                            var dt = ks[q][0] - ks[q - 1][0];
                            if (dt <= 0) continue;
                            var sp = (ks[q][1] - ks[q - 1][1]) / dt;
                            var segA = L.st + ks[q - 1][0], segB = L.st + ks[q][0];
                            if (sp > 1.25 && segA < L.inP + 1.0 &&
                                Math.min(segB, nextIn) - Math.max(segA, L.inP) >= 1.5) ramp = true;
                        }
                    });
                }
                if (ramp) ins.push(L.inP);
            });
            ins.sort(function(a, b) { return a - b; });
            var evs = [];
            ins.forEach(function(t) {
                if (evs.length && (t + TRANS_HALF) - evs[evs.length - 1].t < EVENT_MERGE) return;
                evs.push({ t: t + TRANS_HALF, exact: true });   // t = PICO
            });
            if (evs.length) return evs;
        }
        var cands = [];
        (comp.tr || []).forEach(function(keys) {
            for (var i = 1; i < keys.length - 1; i++) {
                var s1 = (keys[i][1] - keys[i - 1][1]) / Math.max(keys[i][0] - keys[i - 1][0], 1e-6);
                var s2 = (keys[i + 1][1] - keys[i][1]) / Math.max(keys[i + 1][0] - keys[i][0], 1e-6);
                if (s1 <= 0 || s2 <= 0) continue;
                if (Math.max(s1, s2) / Math.min(s1, s2) > 1.25 && Math.max(s1, s2) >= 2.5)
                    // o keyframe marca o FIM da transicao de ~0.85s: o pico
                    // fica meia transicao antes (C07 do 18York: -0.06s de erro)
                    cands.push({ t: keys[i][0] - TRANS_HALF, exact: false });
            }
        });
        cands.sort(function(a, b) { return a.t - b.t; });
        var events = [];
        cands.forEach(function(c) {
            if (events.length && c.t - events[events.length - 1].t < EVENT_MERGE) return;
            events.push(c);
        });
        // fronteira estrutural: os comps de ramp comecam ~1.44s antes do
        // primeiro corte interno (5/7 comps do 18York medem 1.32-1.52s).
        // SO no modo sem probe — com o probe, ausencia de fronteira cedo
        // e informacao real (ex: comp de layer unico do closing)
        if (!(layersInfo && layersInfo.length) && comp.tr && comp.tr.length && (!events.length || events[0].t > 2.2))
            events.unshift({ t: 1.44, exact: false });
        return events;
    }

    /* ── ramps no MEIO do clip (regra 15/jul: "ganha whoosh tambem") ────
       salto FORTE de aceleracao no remap do proprio layer (razao >=1.8 e
       destino >=1.5x; freeze <0.1x nunca conta) — inclusive DENTRO dos
       precomps de drone, resolvidos por srcId com recursao. */
    function midClipEvents(comp, byId, depth) {
        var evs = [];
        if (!comp || depth > 3) return evs;
        function scanKeys(trs, base, lo, hi) {
            (trs || []).forEach(function(ks) {
                for (var q = 1; q < ks.length - 1; q++) {
                    var dt1 = ks[q][0] - ks[q - 1][0], dt2 = ks[q + 1][0] - ks[q][0];
                    if (dt1 <= 0 || dt2 <= 0) continue;
                    var s1 = (ks[q][1] - ks[q - 1][1]) / dt1;
                    var s2 = (ks[q + 1][1] - ks[q][1]) / dt2;
                    if (s1 < 0.1 || s2 < 0.1) continue;              // freeze nunca e ramp
                    if (s2 >= s1 * 1.8 && s2 >= 1.5) {
                        // aceleracao logo na saida do layer = mecanica da
                        // TRANSICAO (ja whooshada na fronteira), nao conteudo
                        if (ks[q][0] < 1.0) continue;
                        var t = base + ks[q][0];
                        // peak do audio no PICO do ramp = meio do ease de
                        // aceleracao = key + TRANS_HALF (16/jul, validado no
                        // whoosh real do comp07: key 55.32 + 0.42 = 55.74 vs
                        // real 55.68). Antes era key - TRANS_HALF (0.84 cedo).
                        if (t > lo + 0.3 && t < hi - 0.1)
                            evs.push({ t: t + TRANS_HALF, exact: true, mid: true });
                    }
                }
            });
        }
        (comp.layers || []).forEach(function(L) {
            if (!L.enabled || L.nul || L.adj || L.gw) return;
            if (!(L.inP > -60 && L.inP < 3600 && L.outP > L.inP)) return;
            if (L.trs && L.trs.length) {
                scanKeys(L.trs, L.st, L.inP, L.outP);
            } else if (byId && L.srcId && byId[L.srcId]) {
                // precomp: ramps internos mapeados 1:1 pelo start do layer
                // (e.t ja e o peak = key+TRANS_HALF; filtra pelo KEY)
                midClipEvents(byId[L.srcId], byId, depth + 1).forEach(function(e) {
                    var key = L.st + e.t - TRANS_HALF;
                    if (key > L.inP + 0.3 && key < L.outP - 0.1)
                        evs.push({ t: key + TRANS_HALF, exact: true, mid: true });
                });
            }
        });
        // comps aninhados sem estrutura de layers capturada: usa o tr plano
        if (!(comp.layers && comp.layers.length) && comp.tr && comp.tr.length && depth > 0)
            scanKeys(comp.tr, 0, -1, 1e9);
        return evs;
    }

    /* meio do null do Gradient Wipe — exato pelo probe (in/out do null),
       senao ≈ meio da animacao do slider (validado: identicos no 18York) */
    function d2nMids(comp) {
        var mids = [];
        if (comp.layers) comp.layers.forEach(function(L) {
            if (L.nul && L.slider) mids.push({ mid: (L.inP + L.outP) / 2, end: L.outP });
        });
        if (mids.length) return mids;
        (comp.sl || []).forEach(function(keys) {
            if (keys.length >= 2) mids.push({ mid: (keys[0][0] + keys[keys.length - 1][0]) / 2,
                                              end: keys[keys.length - 1][0] });
        });
        return mids;
    }

    /* spans visiveis do comp com cat por SOURCE (16/jul, Cintra): um comp
       pode comecar interior e virar drone (comp04: 3.92s de quarto antes do
       drone entrar) — birds SO a partir do span exterior. catOf(nomeSource)
       -> cat ou null; span <2s (cutaway) ou sem cat herda o voto do comp. */
    function compSpans(ci, aepComps, catOf) {
        var comp = aepComps[ci.name];
        var fallback = [{ start: ci.start, end: ci.end, cat: ci.cat }];
        if (!comp || !comp.layers || !comp.layers.length) return fallback;
        var cands = [];
        comp.layers.forEach(function(L, idx) {
            if (!L.enabled || L.nul || L.adj || L.gw) return;
            if (!(L.inP > -60 && L.inP < 3600 && L.outP > L.inP)) return;
            var nm = String((aepComps._names || {})[L.srcId] || '');
            var m = nm.match(/^(.*\.(mp4|mov|mxf|m4v))/i);
            if (!m) return;
            cands.push({ inP: L.inP, outP: L.outP, order: idx, nm: m[1] });
        });
        if (!cands.length) return fallback;
        var pts = {};
        cands.forEach(function(c) { pts[c.inP] = 1; pts[c.outP] = 1; });
        var ts = Object.keys(pts).map(Number).sort(function(a, b) { return a - b; });
        var out = [];
        for (var i = 0; i < ts.length - 1; i++) {
            var mid = (ts[i] + ts[i + 1]) / 2;
            var vis = null;
            for (var c = 0; c < cands.length; c++) {
                var C = cands[c];
                if (C.inP <= mid && mid < C.outP && (vis === null || C.order < vis.order)) vis = C;
            }
            if (!vis) continue;
            var s = ci.start + (ts[i] - (ci.inPoint || 0));
            var e = ci.start + (ts[i + 1] - (ci.inPoint || 0));
            if (e <= ci.start || s >= ci.end) continue;
            s = Math.max(s, ci.start); e = Math.min(e, ci.end);
            if (e - s <= 0.05) continue;
            // usa SEMPRE a cat do source visivel (mais precisa que o voto do
            // comp inteiro); so cai pro voto do comp se o source nao resolve.
            // (16/jul: comp06 inst1 [45.88-47.88] e o quarto C6214, nao o
            // drone — o fallback por duracao <2s sobrescrevia errado e os
            // birds entravam cedo demais)
            var cat = catOf ? catOf(vis.nm) : null;
            if (!cat) cat = ci.cat;
            if (out.length && out[out.length - 1].cat === cat && Math.abs(out[out.length - 1].end - s) < 0.05)
                out[out.length - 1].end = e;
            else out.push({ start: s, end: e, cat: cat });
        }
        return out.length ? out : fallback;
    }

    /* ── regioes de conteudo p/ ambience ──────────────────────────────
       seqItems: [{start,end,cat}] em ordem — cat vem do visionCache
       (clips secos) ou do room do comp (maioria dos sources). */
    function buildRegions(seqItems) {
        var regions = [];
        seqItems.forEach(function(it) {
            var ext = EXTERIOR_CATS[it.cat] ? 1 : 0;
            var last = regions[regions.length - 1];
            if (last && last.ext === ext && it.start <= last.end + 0.5) {
                last.end = Math.max(last.end, it.end);
                if (it.cat === 'pool_bbq' || it.cat === 'pool') last.pool = 1;
            } else {
                regions.push({ start: it.start, end: it.end, ext: ext,
                               pool: (it.cat === 'pool_bbq' || it.cat === 'pool') ? 1 : 0 });
            }
        });
        return regions;
    }

    /* ── o plano completo ─────────────────────────────────────────────
       compItems: [{name,start,end,inPoint,cat}] — itens de comp na timeline
       seqItems:  todos os itens de video com cat (p/ regioes)
       aepComps:  parse dos .aep (inclui layers raw)                      */
    function sfxPlan(compItems, seqItems, aepComps) {
        var plan = [], approx = 0;
        var d2nAll = [], whooshes = [];
        compItems.forEach(function(ci) {
            var comp = aepComps[ci.name];
            if (!comp) return;
            var evAll = transitionEvents(comp).concat(midClipEvents(comp, aepComps._byId, 0));
            evAll.sort(function(x, y) { return x.t - y.t; });
            evAll = evAll.filter(function(ev, ix) {
                if (ev.exact) return true;
                for (var jx = 0; jx < evAll.length; jx++)
                    if (evAll[jx].exact && Math.abs(evAll[jx].t - ev.t) < 1.2) return false;
                return true;
            });
            // mid-clip ramp que desemboca num CORTE = UM movimento -> UM
            // whoosh, na FRONTEIRA (o corte, que o Matheus percebe como o
            // evento). O mid colado (<1.2s da fronteira) e a rampa de entrada
            // DESSE corte, nao um evento separado -> descartado. (Cintra
            // 16/jul: quarto acelera 30.18 e corta pro drone 31.22 = 1 whoosh
            // no corte; o whoosh SEPARADO que ele quer em 28 vem de outro
            // ramp, dentro do precomp, tratado a parte.)
            evAll = evAll.filter(function(ev) {
                if (!ev.mid) return true;
                for (var jx = 0; jx < evAll.length; jx++)
                    if (!evAll[jx].mid && evAll[jx].exact && Math.abs(evAll[jx].t - ev.t) < 1.2) return false;
                return true;
            });
            // eventos exatos colados (<EVENT_MERGE) = UM whoosh
            var evDedup = [];
            evAll.forEach(function(ev) {
                if (evDedup.length && ev.t - evDedup[evDedup.length - 1].t < EVENT_MERGE) return;
                evDedup.push(ev);
            });
            evAll = evDedup;
            evAll.forEach(function(ev) {
                var peak = ci.start - (ci.inPoint || 0) + ev.t;
                // +0.1 (era +0.55): evento no trecho TRIMADO fora do comp na
                // timeline nao toca (Cintra: ramp em 7.84 com comp de 7.6s
                // visiveis = whoosh fantasma @25)
                if (peak < ci.start - 0.05 || peak > ci.end + 0.1) return;
                if (!ev.exact) approx++;
                whooshes.push({ sfx: 'whoosh_long', t: r2(peak - WHOOSH_PEAK), dur: WHOOSH_LEN, peak: peak,
                            why: (ev.exact ? 'pico' : '~aprox') + ' @' + ev.t.toFixed(2) + ' ' + ci.name });
            });
            if (comp.d2n) d2nMids(comp).forEach(function(dz) {
                var tl = ci.start - (ci.inPoint || 0) + dz.mid;
                if (tl < ci.start - 0.5 || tl > ci.end + 0.5) return;
                var tlEnd = ci.start - (ci.inPoint || 0) + dz.end;
                d2nAll.push({ soundStart: tl - D2N_PEAK, nullEnd: tlEnd });
                plan.push({ sfx: 'day_to_night_long', t: r2(tl - D2N_PEAK), dur: D2N_LEN,
                            why: 'meio do null @' + dz.mid.toFixed(2) + ' ' + ci.name });
            });
        });
        // a transicao do d2n em si nao whoosha (layers com Gradient Wipe ja
        // nao geram fronteira) — cortes reais PROXIMOS do d2n whooshaam sim
        // (correcao 15/jul: 0:11 e 0:31 do 18York faltavam)
        whooshes.forEach(function(w) { plan.push(w); });
        // ambience por regiao exterior
        var vidEnd = 0;
        seqItems.forEach(function(it) { vidEnd = Math.max(vidEnd, it.end); });
        // itens ESTRUTURAIS (master nested/referencia/adjustment) cobrem ~toda
        // a timeline e nao sao UM shot — excluidos do ambience, senao viram
        // uma regiao gigante que blanketava birds sobre interiores (Cintra
        // 16/jul: "main video v2" [0-53] classificado balcony). vidEnd fica
        // dos itens todos (fim real do video).
        var _minS = 1e9, _maxE = 0;
        seqItems.forEach(function(it) { if (it.start < _minS) _minS = it.start; if (it.end > _maxE) _maxE = it.end; });
        var _total = _maxE - _minS;
        var nDropped = 0;
        var ambItems = seqItems.filter(function(it) {
            if (_total > 0 && (it.end - it.start) >= 0.85 * _total) { nDropped++; return false; }
            return true;
        });
        plan._structDropped = nDropped;
        var regions = buildRegions(ambItems);
        // INTRO (16/jul): o comeco do video costuma ser coberto so pelo item
        // estrutural excluido (master nested) ou por gaps — o 1o shot
        // classificavel (drone) entra depois. Se a 1a regiao EXTERIOR abre o
        // video (nenhum interior REAL >=2s antes), os birds vao desde 0
        // (abertura de drone e o padrao real estate).
        var firstExt = -1;
        for (var ri = 0; ri < regions.length; ri++) if (regions[ri].ext) { firstExt = ri; break; }
        var openFrom0 = firstExt >= 0 && regions[firstExt].start > 0.1;
        if (openFrom0) for (var ri = 0; ri < firstExt; ri++)
            if (!regions[ri].ext && (regions[ri].end - regions[ri].start) >= AMB_MIN_SPAN) { openFrom0 = false; break; }
        regions.forEach(function(R, rIdx) {
            if (!R.ext || (R.end - R.start) < AMB_MIN_SPAN) return;
            var endsAtVideoEnd = R.end > vidEnd - 0.5;
            var mids = d2nAll.map(function(z) { return z.soundStart + D2N_PEAK; })
                             .filter(function(m) { return m > R.start + 0.3 && m < R.end - 0.3; });
            mids.sort(function(a, b) { return a - b; });
            var rEnd = endsAtVideoEnd ? vidEnd : R.end;
            // J/L cut: o audio entra ANTES do corte visual e segura DEPOIS.
            // 1a regiao exterior de abertura -> birds desde 0 (intro drone).
            var jStart = (rIdx === firstExt && openFrom0) ? 0 : Math.max(0, R.start - AMB_JL);
            var lEnd = endsAtVideoEnd ? vidEnd : (rEnd + AMB_JL);
            // birds ate o d2n (crossfade cruzando o meio) ou ate o fim da regiao
            var birdsEnd = mids.length ? (mids[0] + XFADE / 2) : lEnd;
            if (birdsEnd - jStart >= AMB_MIN_SPAN)
                plan.push({ sfx: 'birds', t: r2(jStart), dur: r2(Math.min(birdsEnd - jStart, AMB_MAX)),
                            trim: 1, gain: 1.0, fadeIn: AMB_FADE,
                            fadeOut: mids.length ? XFADE : AMB_FADE,
                            why: 'exterior ' + jStart.toFixed(1) + '-' + birdsEnd.toFixed(1) });
            // pool entra junto com o INICIO do d2n da regiao (o edit original
            // dele: 31.36 ~ som de d2n; "desde o comeco" = comeco do d2n, nao
            // da regiao — em 24s ainda nao ha piscina na tela)
            if (R.pool) {
                var pStart = mids.length ? (mids[0] - D2N_PEAK) : jStart;
                if (lEnd - pStart >= AMB_MIN_SPAN)
                    plan.push({ sfx: 'pool', t: r2(pStart), dur: r2(Math.min(lEnd - pStart, AMB_MAX)),
                                trim: 1, gain: 1.0, fadeIn: AMB_FADE, fadeOut: AMB_FADE,
                                why: 'pool desde o d2n ' + pStart.toFixed(1) + '-' + lEnd.toFixed(1) });
            }
            // pos-D2N sem piscina: crickets (-12dB) entrando em crossfade
            if (mids.length && !R.pool) {
                var cStart = mids[0] - XFADE / 2;
                if (lEnd - cStart >= AMB_MIN_SPAN)
                    plan.push({ sfx: 'crickets', t: r2(cStart),
                                dur: r2(Math.min(lEnd - cStart, AMB_MAX)), trim: 1,
                                gain: CRICKETS_GAIN, fadeIn: XFADE, fadeOut: AMB_FADE,
                                why: 'pos-D2N ' + cStart.toFixed(1) + '-' + lEnd.toFixed(1) });
            }
        });
        plan.sort(function(a, b) { return a.t - b.t; });
        // whooshes que cairam no mesmo lugar = um so
        var out = [];
        plan.forEach(function(p) {
            if (p.sfx === 'whoosh_long' && out.length) {
                for (var i = out.length - 1; i >= 0; i--)
                    if (out[i].sfx === 'whoosh_long' && Math.abs(out[i].t - p.t) < 0.3) return;
            }
            out.push(p);
        });
        out._approx = approx;
        out._structDropped = plan._structDropped || 0;
        return out;
    }
    function r2(x) { return Math.round(x * 100) / 100; }

    /* ── gate offline vs a timeline entregue do 18 York ───────────────── */
    function validate() {
        var fs = require('fs');
        var fix = JSON.parse(fs.readFileSync(CAL_DIR + '/fixtures/18york_sfx_fixture.json', 'utf8'));
        var aepComps = null;
        try {
            aepComps = parseAep(fix.aepPath);
            if (aepComps.error) aepComps = null;
            else console.log('gate: .aep RAW parseado (SEM probe, SEM AE)');
        } catch (_) {}
        if (!aepComps) {
            console.log('gate: aep indisponivel — cache aproximado');
            aepComps = {};
            Object.keys(fix.aepCompsCache).forEach(function(n) {
                var c = fix.aepCompsCache[n];
                aepComps[n] = { tr: c.tr, sl: c.sl, d2n: c.d2n, sources: [] };
            });
        }
        var rooms2 = {};
        try {
            var vc2 = JSON.parse(fs.readFileSync(CAL_DIR + '/visionCache.json', 'utf8'));
            Object.keys(vc2).forEach(function(k) {
                var b2 = k.split('|')[0].split('/').pop();
                if (vc2[k] && vc2[k].cat) rooms2[b2] = vc2[k].cat;
            });
        } catch (_) {}
        function gateCompRoom(name) {
            var votes = {};
            function vl(comp, depth) {
                if (!comp || depth > 2) return;
                (comp.layers || []).forEach(function(L) {
                    if (!L.enabled || L.nul || L.adj || !L.srcId) return;
                    var nm = (aepComps._names || {})[L.srcId];
                    if (!nm) return;
                    var r = rooms2[nm.replace(/\s+$/, '')];
                    if (r) votes[r] = (votes[r] || 0) + 1;
                    else if (aepComps._byId && aepComps._byId[L.srcId]) vl(aepComps._byId[L.srcId], depth + 1);
                });
            }
            vl(aepComps[name], 0);
            var best = 'interior', bn = 0;
            Object.keys(votes).forEach(function(r) { if (votes[r] > bn) { bn = votes[r]; best = r; } });
            return best;
        }
        var compItems = fix.comps.map(function(c) {
            return { name: c.name, start: c.start, end: c.end, inPoint: c.inPoint,
                     cat: gateCompRoom(c.name) };
        });
        /* per-span: mesmo caminho do painel (rooms via visionCache basename) */
        var gateRooms = {};
        try {
            var gvc = JSON.parse(fs.readFileSync(CAL_DIR + '/visionCache.json', 'utf8'));
            Object.keys(gvc).forEach(function(k) {
                if (gvc[k] && gvc[k].cat)
                    gateRooms[k.split('|')[0].split('/').pop().replace(/\.[^.]+$/, '').toLowerCase()] = gvc[k].cat;
            });
        } catch (eV) {}
        var gateCatOf = function(nm) {
            return gateRooms[String(nm).split('/').pop().replace(/\.[^.]+$/, '').replace(/_proxy$/i, '').toLowerCase()] || null;
        };
        var seqItems = fix.dryItems.map(function(d) { return { start: d.start, end: d.end, cat: d.cat }; })
            .concat(compItems.reduce(function(acc, c) { return acc.concat(compSpans(c, aepComps, gateCatOf)); }, []));
        seqItems.sort(function(a, b) { return a.start - b.start; });
        var plan = sfxPlan(compItems, seqItems, aepComps);
        console.log('PLANO: ' + plan.length + ' sons (' + plan._approx + ' whooshes em modo ~aprox)');
        var byType = {};
        plan.forEach(function(p) { (byType[p.sfx] = byType[p.sfx] || []).push(p); });
        ['whoosh_long', 'day_to_night_long', 'birds', 'crickets', 'pool'].forEach(function(tp) {
            var real = fix.realSfx.filter(function(s) { return s.name.indexOf(tp.replace('_long', '')) === 0; });
            var gen = byType[tp] || [];
            console.log('\n' + tp + ': gerados ' + gen.length + ' | reais ' + real.length);
            real.forEach(function(r) {
                var best = null, bd = 1e9;
                gen.forEach(function(g) { var d = Math.abs(g.t - r.start); if (d < bd) { bd = d; best = g; } });
                console.log('  real @' + r.start.toFixed(2) +
                    (best ? ' -> gerado @' + best.t.toFixed(2) + ' (d=' + (best.t - r.start).toFixed(2) + 's)' : ' -> NADA'));
            });
        });
    }

    if (IS_NODE) {
        module.exports = { parseAep: parseAep, transitionEvents: transitionEvents,
            d2nMids: d2nMids, buildRegions: buildRegions, sfxPlan: sfxPlan, compSpans: compSpans };
        if (require.main === module) {
            if (process.argv[2] === 'validate') validate();
            else console.log('uso: node js/autoSfx.js validate');
        }
        return;
    }

    /* ── Panel wiring (CEP only) ─────────────────────────────────────── */
    /* Motores ES3 recem-abertos NAO tem JSON nativo — payloads carregam o
       proprio shim (o parse via eval e seguro: a string e nosso proprio
       payload serializado, nunca dado de usuario). */
    var JSON_SHIM =
        'if(typeof JSON==="undefined"){' +
        'var __sj=function(v){var i,s,t;' +
        'if(v===null||v===undefined)return "null";' +
        't=typeof v;' +
        'if(t==="number")return isFinite(v)?String(v):"null";' +
        'if(t==="boolean")return String(v);' +
        'if(t==="string"){s=v.split("\\\\").join("\\\\\\\\");s=s.split(String.fromCharCode(34)).join("\\\\"+String.fromCharCode(34));' +
        's=s.split(String.fromCharCode(10)).join("\\\\n");s=s.split(String.fromCharCode(13)).join("\\\\r");' +
        'return String.fromCharCode(34)+s+String.fromCharCode(34);}' +
        'if(v instanceof Array){s=[];for(i=0;i<v.length;i++)s.push(__sj(v[i]));return "["+s.join(",")+"]";}' +
        'if(t==="object"){s=[];for(i in v)if(v.hasOwnProperty(i))s.push(__sj(i)+":"+__sj(v[i]));return "{"+s.join(",")+"}";}' +
        'return "null";};' +
        'JSON={stringify:__sj,parse:function(s){return eval("("+s+")");}};}';
    window.DM_JSON_SHIM = JSON_SHIM;   // o Organize Reels (stagingSequence) usa tambem
    window.DM_parseAep = parseAep;     // o Auto Color Grade (colorGrade) le comps do .aep
    window.DM_d2nMids = d2nMids;       // ...e corta o grade no meio de cada day-to-night

    var SFX_FILES = {
        whoosh_long: 'assets/sounds/transitions/whoosh_long.mp3',
        day_to_night_long: 'assets/sounds/transitions/day_to_night_long.mp3',
        birds: 'assets/sounds/nature/birds.mp3',
        crickets: 'assets/sounds/nature/crickets.mp3',
        pool: 'assets/sounds/nature/pool.mp3'
    };
    /* radical do nome: sem pasta, sem extensao, sem sufixo _Proxy, minusculo —
       o Premiere devolve o path do PROXY quando ha proxy anexado */
    function normStem(s) {
        return String(s || '').split('/').pop().replace(/\.[^.]+$/, '')
            .replace(/_proxy$/i, '').replace(/\s+$/, '').toLowerCase();
    }
    function roomsMap() {
        var fs = require('fs');
        var map = {};
        try {
            var vc = JSON.parse(fs.readFileSync(CAL_DIR + '/visionCache.json', 'utf8'));
            Object.keys(vc).forEach(function(k) {
                if (vc[k] && vc[k].cat) map[normStem(k.split('|')[0])] = vc[k].cat;
            });
        } catch (_) {}
        return map;
    }
    function findFF() {
        var fs = require('fs');
        var cands = [];
        try { var b = (typeof window !== 'undefined' && window.DM_BUNDLED_FFMPEG) ? window.DM_BUNDLED_FFMPEG() : null; if (b) cands.push(b); } catch (_) {}
        cands.push(dmRoot() + '/bin/ffmpeg',
            '/Applications/Wavdrop.app/Contents/Resources/ffmpeg',
            (process.env.HOME || '') + '/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg');
        for (var i = 0; i < cands.length; i++)
            try { if (fs.existsSync(cands[i])) return cands[i]; } catch (_) {}
        return null;
    }
    /* fades/gain ASSADOS no proprio audio (ffmpeg) — o caminho de keyframes
       de Volume do Premiere aceitou 3 formatos de chamada sem nunca soar:
       API morta pra nos (licao 15/jul). Arquivo renderizado = fade FISICO,
       medivel offline; a colocacao segue no caminho sempre-provado. */
    function renderAmbiences(items, extRoot, projRoot, cb) {
        var fs = require('fs'), cp = require('child_process');
        var queue = items.filter(function(p) { return p.trim; });
        if (!queue.length) return cb(null);
        var ff = findFF();
        if (!ff) return cb('ffmpeg not found — reopen the panel to auto-download it');
        // renders moram na pasta ASSETS do PROJETO (a midia viaja com ele);
        // fallback: pasta do plugin quando a estrutura nao existir
        var dir = extRoot + '/assets/sounds/rendered';
        try {
            if (projRoot && fs.existsSync(projRoot + '/ASSETS')) {
                dir = projRoot + '/ASSETS/Auto SFX';
            }
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        } catch (_) {}
        (function next(i) {
            if (i >= queue.length) return cb(null);
            var p = queue[i];
            var out = dir + '/' + p.sfx + '_' + p.dur.toFixed(2) + '_' + (p.fadeIn || 0) + '_' +
                      (p.fadeOut || 0) + '_' + Math.round((p.gain || 1) * 1000) + '.wav';
            p.renderPath = out;
            if (fs.existsSync(out)) return next(i + 1);
            var srcFile = extRoot + '/' + SFX_FILES[p.sfx];
            var fo = p.fadeOut || 0;
            var af = 'afade=t=in:st=0:d=' + (p.fadeIn || 0.01) +
                     ',afade=t=out:st=' + Math.max(0, p.dur - fo).toFixed(3) + ':d=' + (fo || 0.01) +
                     ',volume=' + (p.gain || 1);
            cp.execFile(ff, ['-y', '-i', srcFile, '-af', af, '-t', String(p.dur), out],
                { timeout: 60000 }, function(err) {
                if (err) return cb('render ' + p.sfx + ': ' + err.message);
                next(i + 1);
            });
        })(0);
    }
    var sfxBtn = document.getElementById('prAutoSfx');
    if (sfxBtn) sfxBtn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { setStatus('Auto SFX only works in Premiere', 'error'); return; }
        sfxBtn.disabled = true;
        setStatus('Reading sequence...', 'busy');
        var jsxRead = '(function(){' + JSON_SHIM + 'try{' +
            'var seq=app.project.activeSequence;' +
            'if(!seq)return JSON.stringify({error:"open the edited sequence first"});' +
            'var S=function(x){try{return x.seconds;}catch(e){return -1;}};' +
            'var vids=[];' +
            'for(var t=0;t<seq.videoTracks.numTracks;t++){var tr=seq.videoTracks[t];' +
            'for(var c=0;c<tr.clips.numItems;c++){try{var cl=tr.clips[c];' +
            'var p2="";try{p2=cl.projectItem?cl.projectItem.getMediaPath():"";}catch(e1){}' +
            'var st=S(cl.start);var en=S(cl.end);if(en<0)en=st+S(cl.duration);' +
            'vids.push({name:String(cl.name||""),path:p2||"",start:st,end:en,inP:S(cl.inPoint)});' +
            '}catch(e2){}}}' +
            'return JSON.stringify({ok:1,vids:vids});' +
            '}catch(err){return JSON.stringify({error:"read: "+err});}}())';
        evalScript(jsxRead, function(res) {
            var sq;
            try { sq = JSON.parse(res); } catch (_) { sq = null; }
            if (!sq) {
                evalScript('(function(){return "P1";}())', function(r1) {
                    evalScript('(function(){return "J:"+(typeof JSON);}())', function(r2) {
                        evalScript('(function(){var s=app.project.activeSequence;return s?("S:"+s.name):"S:none";}())', function(r3) {
                            setStatus('Auto SFX diag — read:[' + String(res).slice(0, 40) + '] ping:[' + r1 +
                                '] json:[' + r2 + '] seq:[' + String(r3).slice(0, 40) + ']', 'error');
                            sfxBtn.disabled = false;
                        });
                    });
                });
                return;
            }
            if (sq.error) { setStatus(sq.error, 'error'); sfxBtn.disabled = false; return; }
            var comps = (sq.vids || []).filter(function(v) { return /\.aep$/i.test(v.path); });
            var fs = require('fs');
            // parse de cada .aep referenciado (com sources -> room do comp)
            var aepComps = {}, aepErr = null, seen = {};
            comps.forEach(function(c) {
                if (seen[c.path]) return;
                seen[c.path] = 1;
                try {
                    var cc = parseAep(c.path);
                    if (cc.error) { aepErr = cc.error; return; }
                    Object.keys(cc).forEach(function(n) { aepComps[n] = cc[n]; });
                } catch (e) { aepErr = String(e.message || e); }
            });

            // 16/jul: projetos novos nao tem cats (a classificacao vivia no
            // botao Staging Sequence, removido) -> classifica aqui mesmo os
            // clips sem categoria: diretos da timeline + sources dos comps
            // (nomes do .aep resolvidos por scan do <root>/VIDEO).
            var rooms0 = roomsMap();
            var toClassify = [];
            (sq.vids || []).forEach(function(v) {
                if (v.path && !/\.aep$/i.test(v.path) && /\.(mp4|mov|mxf|m4v)$/i.test(v.path) &&
                    !rooms0[normStem(v.path)]) toClassify.push(v.path);
            });
            try {
                var projRoot0 = comps.length ? comps[0].path.split('/').slice(0, -2).join('/') : null;
                if (projRoot0 && aepComps._names) {
                    var vmap = {};
                    (function scanV(dir, depth) {
                        if (depth > 3) return;
                        var es;
                        try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (eS) { return; }
                        es.forEach(function(en) {
                            var p = dir + '/' + en.name;
                            if (en.isDirectory()) scanV(p, depth + 1);
                            else if (/\.(mp4|mov|mxf|m4v)$/i.test(en.name) && !/_proxy\./i.test(en.name))
                                vmap[en.name.toLowerCase()] = p;
                        });
                    })(projRoot0 + '/VIDEO', 0);
                    Object.keys(aepComps._names).forEach(function(id) {
                        var m = String(aepComps._names[id]).match(/^(.*\.(mp4|mov|mxf|m4v))/i);
                        if (m && vmap[m[1].toLowerCase()] && !rooms0[normStem(m[1])])
                            toClassify.push(vmap[m[1].toLowerCase()]);
                    });
                }
            } catch (eCl) {}

            function proceedSfx() {
            var rooms = roomsMap();
            function compRoom(name) {
                var votes = {};
                function voteLayers(comp, depth) {
                    if (!comp || depth > 2) return;
                    (comp.layers || []).forEach(function(L) {
                        if (!L.enabled || L.nul || L.adj || !L.srcId) return;
                        var nm = (aepComps._names || {})[L.srcId];
                        if (!nm) return;
                        var r = rooms[normStem(nm)];
                        if (r) votes[r] = (votes[r] || 0) + 1;
                        else if (aepComps._byId && aepComps._byId[L.srcId])
                            voteLayers(aepComps._byId[L.srcId], depth + 1);   // precomp: desce
                    });
                }
                voteLayers(aepComps[name], 0);
                var best = 'interior', bn = 0;
                Object.keys(votes).forEach(function(r) { if (votes[r] > bn) { bn = votes[r]; best = r; } });
                return best;
            }
            function findComp(nm) {
                if (aepComps[nm]) return nm;
                var hit = null;
                Object.keys(aepComps).forEach(function(k) {
                    if (!hit && (nm.indexOf(k) >= 0 || k.indexOf(nm) >= 0)) hit = k;
                });
                return hit;
            }
            var compItems = [];
            comps.forEach(function(c) {
                var key = findComp(c.name);
                if (key) compItems.push({ name: key, start: c.start, end: c.end, inPoint: c.inP, cat: compRoom(key) });
            });
            var seqItems = [];
            (sq.vids || []).forEach(function(v) {
                if (!v.path || /\.aep$/i.test(v.path)) return;   // adjustment/graficos: fora
                var stem = normStem(v.path);
                var cat = rooms[stem];
                // sem classificacao = overlay/grafico/export de referencia:
                // transparente pras regioes (nao quebra nem estende)
                if (!cat) return;
                seqItems.push({ start: v.start, end: v.end, cat: cat, src: stem });
            });
            var catOfName = function(nm) { return rooms[normStem(nm)] || null; };
            compItems.forEach(function(c) {
                compSpans(c, aepComps, catOfName).forEach(function(sp) { seqItems.push(sp); });
            });
            seqItems.sort(function(a, b) { return a.start - b.start; });
            var plan = sfxPlan(compItems, seqItems, aepComps);
            if (!plan.length) {
                setStatus('Auto SFX: no events found' + (aepErr ? ' — .aep: ' + aepErr : ''), aepErr ? 'error' : 'success');
                sfxBtn.disabled = false; return;
            }
            if (plan.length > 40) plan = plan.slice(0, 40);
            try {
                fs.writeFileSync(CAL_DIR + '/lastSfxPlan.json', JSON.stringify({
                    at: Date.now(), plan: plan, seqItems: seqItems, compItems: compItems,
                    aepErr: aepErr || null }, null, 1));
            } catch (_) {}
            var extRoot = (typeof cs !== 'undefined' && cs) ? cs.getSystemPath('extension') : '.';
            setStatus('Rendering ambience fades + placing ' + plan.length + ' SFX...', 'busy');
            // raiz do projeto: <root>/AFTER EFFECTS/x.aep
            var projRoot = null;
            if (comps.length) {
                var parts = comps[0].path.split('/');
                if (parts.length > 2) projRoot = parts.slice(0, -2).join('/');
            }
            renderAmbiences(plan, extRoot, projRoot, function(rerr) {
            if (rerr) { setStatus('Auto SFX: ' + rerr, 'error'); sfxBtn.disabled = false; return; }
            var pathsSet = {};
            plan.forEach(function(p) {
                p._file = (p.renderPath || (extRoot + '/' + SFX_FILES[p.sfx])).replace(/\\/g, '/');
                pathsSet[p._file] = 1;
            });
            var paths = Object.keys(pathsSet);
            var escaped = JSON.stringify(paths).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            evalScript('$.evalFile(' + JSON.stringify(getPrJsxPath()) + '); preloadSounds(\'' + escaped + '\');', function() {
                var items = plan.map(function(p) {
                    return { path: p._file, t: p.t, dur: p.dur };
                });
                var payload = JSON.stringify(JSON.stringify({ items: items }));
                var jsxPlace = '(function(){' + JSON_SHIM +
                    'var d=' + payload + ';d=JSON.parse(d);' +
                    'var seq=app.project.activeSequence;' +
                    'if(!seq)return JSON.stringify({error:"no active sequence"});' +
                    'var byPath={};' +
                    'function walk(b){for(var i=0;i<b.children.numItems;i++){var it=b.children[i];' +
                    'if(it.type===ProjectItemType.BIN)walk(it);else{try{var p=it.getMediaPath();if(p)byPath[p]=it;}catch(e){}}}}' +
                    'walk(app.project.rootItem);' +
                    'function overlaps(tr,t0,t1){for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];' +
                    'try{if(c.start.seconds<t1-0.01&&c.end.seconds>t0+0.01)return true;}catch(e){}}return false;}' +
                    'var placed=0,skipped=0,added=0,musGuard=1;' +
                    'var skippedAt=[];' +
                    'var pending=d.items;' +
                    'for(var round=0;round<5&&pending.length;round++){' +
                    'var next=[];' +
                    'for(var k=0;k<pending.length;k++){var it2=pending[k];var pi=byPath[it2.path];' +
                    'if(!pi){skipped++;continue;}' +
                    'var done=false;' +
                    'for(var a=1;a<seq.audioTracks.numTracks&&!done;a++){' +
                    'if(!overlaps(seq.audioTracks[a],it2.t,it2.t+it2.dur)){' +
                    'try{seq.audioTracks[a].overwriteClip(pi,it2.t);placed++;done=true;' +
                    // fades + gain: keyframes de Volume>Level no clip recem-colocado
                    '}catch(e3){}}}' +
                    'if(!done)next.push(it2);}' +
                    'pending=next;' +
                    'if(pending.length&&round<4){' +
                    // faltou track: cria UMA no fim (1-based = numTracks+1, padrao do Nest)
                    'try{app.enableQE();var qs=qe.project.getActiveSequence();' +
                    'qs.addTracks(0,0,1,seq.audioTracks.numTracks+1,0,0,0);added++;' +
                    'seq=app.project.activeSequence;' +
                    // guarda: a musica tem que continuar em A1
                    'if(seq.audioTracks[0].clips.numItems===0){musGuard=0;break;}' +
                    '}catch(eq){break;}}}' +
                    'skipped+=pending.length;' +
                    'for(var sx=0;sx<pending.length&&sx<4;sx++)skippedAt.push(pending[sx].t);' +
                    'return JSON.stringify({ok:1,placed:placed,skipped:skipped,added:added,musGuard:musGuard,skippedAt:skippedAt});}())';
                evalScript(jsxPlace, function(res2) {
                    sfxBtn.disabled = false;
                    var r2p;
                    try { r2p = JSON.parse(res2); } catch (_) { r2p = { error: 'place parse failed: ' + res2 }; }
                    if (r2p.error) { setStatus(r2p.error, 'error'); return; }
                    if (r2p.musGuard === 0) {
                        setStatus('Auto SFX: track created in the wrong spot (music left A1) — Cmd+Z and report it', 'error');
                        return;
                    }
                    var nAmb = plan.filter(function(p) { return p.trim; }).length;
                    setStatus('Auto SFX: ' + r2p.placed + '/' + plan.length + ' placed on A2+' +
                        (nAmb ? ' — ' + nAmb + ' ambiences com fades assados' : '') +
                        (r2p.added ? ' (+' + r2p.added + ' audio tracks created)' : '') +
                        (r2p.skipped ? ' — ' + r2p.skipped + ' skipped @' + (r2p.skippedAt || []).join(',') : ''),
                        r2p.skipped ? 'error' : 'success');
                });
            });
            });
            }
            if (window.DM_classifyPaths && toClassify.length) {
                window.DM_classifyPaths(toClassify,
                    function(msg) { setStatus('Auto SFX: ' + msg, 'busy'); },
                    function(n) {
                        if (n) setStatus('Auto SFX: ' + n + ' clips classified — building the plan...', 'busy');
                        proceedSfx();
                    });
            } else proceedSfx();
        });
    });
})();
