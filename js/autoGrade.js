/* ── Auto Color Correction — motor hibrido (Fase C1) ───────────────────
   Decisao do Matheus (16/jul/2026): correcao por segmento = MEDIR a imagem
   (frame convertido, pos-LUT de conversao, pre-grade) e traduzir em
   parametros de Lumetri Basic Correction, ANCORADO no corpus dos 20
   projetos minerados (gradeMiner). Nunca extrapola alem da faixa [p10..p90]
   que ele realmente usa por tipo de footage.

   A "base" e o look da casa (Contrast +13, Whites +20, Blacks -9 ~fixos);
   a analise da imagem SO modula o que depende do conteudo: Exposure,
   Highlights, Shadows, Temperature. Aplicacao (adicionar Lumetri via QE +
   setValue) ja foi PROVADA ao vivo (16/jul) — ver project_dm_tools_cep.

   measureFrame usa ffmpeg (rawvideo rgb24) — roda em Node (CLI) e no painel
   (cep_node). predictCorrection e JS puro (testavel). Gate offline:
   `node js/autoGrade.js selftest` valida a LOGICA (monotonicidade + faixas);
   o resultado final de cor so o teste live confirma (preview-before-apply). */
(function () {
    var IS_NODE = (typeof document === 'undefined');
    function nodeRequire(m) {
        return (typeof window !== 'undefined' && window.cep_node) ? window.cep_node.require(m) : require(m);
    }
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

    /* alvos do "look" medidos nos exports entregues (0-255) */
    var TARGET_Y = 118;        // luminancia mediana alvo (export ~92-171, med ~118)
    var TARGET_WARMTH = 8;     // R-B alvo (levemente quente, real estate)
    var PARAMS = ['Exposure', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks', 'Temperature', 'Tint'];

    /* snapshot of calibration/gradeStats.json (mined from 20 delivered
       projects, 17/jul/2026) — fallback when the file hasn't synced yet on
       another editor's machine. The file, when present, always wins (it is
       what Grow Corpus updates). */
    var EMBEDDED_STATS = {"camera":{"Exposure":{"median":0.32,"p10":0.11,"p90":0.73,"n":196},"Contrast":{"median":13.12,"p10":7.3,"p90":21.17,"n":599},"Highlights":{"median":-9.82,"p10":-27.01,"p90":8.03,"n":610},"Shadows":{"median":10.41,"p10":-16.52,"p90":21.27,"n":547},"Whites":{"median":20.18,"p10":8.76,"p90":31.22,"n":596},"Blacks":{"median":-10.22,"p10":-32.58,"p90":-1.69,"n":123},"Temperature":{"median":2.73,"p10":-8.6,"p90":7.62,"n":374},"Tint":{"median":-0.45,"p10":-2,"p90":4.98,"n":48}},"comp":{"Exposure":{"median":0.36,"p10":0.09,"p90":0.64,"n":59},"Contrast":{"median":12.56,"p10":6.36,"p90":20.91,"n":156},"Highlights":{"median":-12.73,"p10":-29.09,"p90":-5.11,"n":155},"Shadows":{"median":9.96,"p10":-18.18,"p90":18.18,"n":152},"Whites":{"median":20.54,"p10":10.91,"p90":30,"n":154},"Temperature":{"median":2.73,"p10":-9.5,"p90":7.08,"n":85},"Tint":{"median":1.36,"p10":-2.26,"p90":6.91,"n":11}},"drone":{"Exposure":{"median":0.31,"p10":-1.52,"p90":1.06,"n":6},"Contrast":{"median":10.41,"p10":5.31,"p90":18.18,"n":17},"Highlights":{"median":-13.7,"p10":-25.28,"p90":-8.18,"n":15},"Shadows":{"median":9.09,"p10":-15.84,"p90":21.27,"n":15},"Whites":{"median":19.22,"p10":9.73,"p90":42.08,"n":15},"Temperature":{"median":5.23,"p10":3,"p90":8.85,"n":12}},"_all":{"Exposure":{"median":0.33,"p10":0.11,"p90":0.7,"n":264},"Contrast":{"median":13.12,"p10":7.21,"p90":20.91,"n":778},"Highlights":{"median":-10.74,"p10":-27.6,"p90":5.11,"n":788},"Shadows":{"median":10.21,"p10":-16.59,"p90":20.44,"n":719},"Whites":{"median":20.18,"p10":9.31,"p90":31.22,"n":773},"Blacks":{"median":-8.76,"p10":-32.58,"p90":-1.46,"n":125},"Temperature":{"median":2.73,"p10":-8.6,"p90":7.62,"n":472},"Tint":{"median":0.45,"p10":-2.24,"p90":5.88,"n":61}}};

    function loadStats() {
        try {
            var fs = nodeRequire('fs');
            return JSON.parse(fs.readFileSync(CAL_DIR + '/gradeStats.json', 'utf8'));
        } catch (e) { return EMBEDDED_STATS; }
    }

    /* classe do corpus a partir da categoria do clip embaixo (visionCache /
       compRoom): drone_aerial->drone, comps->comp, resto->camera */
    function corpusClass(cat) {
        var c = String(cat || '').toLowerCase();
        if (c.indexOf('drone') >= 0 || c.indexOf('aerial') >= 0) return 'drone';
        if (c.indexOf('comp') >= 0) return 'comp';
        return 'camera';
    }

    function ffPath() {
        var fs = nodeRequire('fs');
        var cands = [];
        try { var b = (typeof window !== 'undefined' && window.DM_BUNDLED_FFMPEG) ? window.DM_BUNDLED_FFMPEG() : null; if (b) cands.push(b); } catch (e) {}
        cands.push(dmRoot() + '/bin/ffmpeg',
            '/Applications/Wavdrop.app/Contents/Resources/ffmpeg',
            (process.env.HOME || '') + '/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg');
        for (var i = 0; i < cands.length; i++) { try { if (fs.existsSync(cands[i])) return cands[i]; } catch (e) {} }
        return 'ffmpeg';
    }

    /* mede um arquivo de imagem (JPG/PNG/PPM) -> metricas 0-255 */
    function measureFrame(imgPath) {
        var cp = nodeRequire('child_process');
        var W = 96, H = 54;
        var buf = cp.execFileSync(ffPath(),
            ['-v', 'error', '-i', imgPath, '-vf', 'scale=' + W + ':' + H, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
            { maxBuffer: 8 * 1024 * 1024 });
        return measureRGB(buf, W * H);
    }

    /* mede direto do CLIP FONTE (esta versao do Premiere nao expoe export
       de frame por script) — seek + LUT de conversao + downscale. tSec e o
       tempo NO SOURCE. lutPath opcional (SLog3 p/ camera FX3). */
    function measureSource(srcPath, tSec, lutPath) {
        var cp = nodeRequire('child_process');
        var W = 96, H = 54;
        var vf = (lutPath ? 'lut3d=' + lutPath + ',' : '') + 'scale=' + W + ':' + H;
        var buf = cp.execFileSync(ffPath(),
            ['-v', 'error', '-ss', String(Math.max(0, tSec)), '-i', srcPath, '-frames:v', '1',
                '-vf', vf, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
            { maxBuffer: 8 * 1024 * 1024 });
        return measureRGB(buf, W * H);
    }

    /* metricas "neutras" -> predictCorrection devolve a base do corpus
       (mediana da classe) sem modular por imagem (drone/comp/sem source) */
    var NEUTRAL = { Ymed: TARGET_Y, Yp5: 70, Yp95: 180, R: 128, G: 124, B: 120, hiClip: 0, shClip: 0, n: 1 };

    /* metricas a partir de um buffer rgb24 (n pixels) */
    function measureRGB(buf, n) {
        var ys = new Array(n), rS = 0, gS = 0, bS = 0, hi = 0, sh = 0;
        for (var i = 0; i < n; i++) {
            var r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
            var y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            ys[i] = y; rS += r; gS += g; bS += b;
            if (y >= 245) hi++;
            if (y <= 10) sh++;
        }
        ys.sort(function (a, b) { return a - b; });
        function q(p) { return ys[Math.min(n - 1, Math.max(0, Math.floor(p * n)))]; }
        return {
            Ymed: q(0.5), Yp5: q(0.05), Yp95: q(0.95),
            R: rS / n, G: gS / n, B: bS / n,
            hiClip: hi / n, shClip: sh / n, n: n
        };
    }

    /* ── o coracao: metricas + corpus -> correcao Lumetri ─────────────── */
    function predictCorrection(m, cls, stats) {
        var S = stats[cls] || stats['_all'] || {};
        var ALL = stats['_all'] || {};
        function band(k) { return S[k] || ALL[k] || { median: 0, p10: 0, p90: 0 }; }
        function clampR(v, b) { return Math.max(b.p10, Math.min(b.p90, v)); }
        function r2(v) { return Math.round(v * 100) / 100; }

        var out = {};

        /* Exposure: puxa Ymed pro alvo; ~1 stop a cada 60 niveis. Centrado
           na mediana dele, clampado na faixa dele. */
        var eb = band('Exposure');
        out.Exposure = r2(clampR(eb.median + 0.9 * (TARGET_Y - m.Ymed) / 60, eb));

        /* Highlights: recupera altas — e ANTECIPA o look (o grade soma
           Whites +20 e Exposure, que estouram ainda mais). Por isso o
           gatilho e o p95 ja a partir de ~200 (nao 235) e mais agressivo;
           fachadas com ceu brilhante caem sozinhas por Yp95/hiClip altos,
           sem precisar de label. Quando muito estourado, deixa ir alem do
           p10 (ate -40) — o Matheus pediu mais recuo nesses casos. */
        var hb = band('Highlights');
        var hiPush = 160 * m.hiClip + 0.6 * Math.max(0, m.Yp95 - 200);
        var hiFloor = (m.Yp95 > 220 || m.hiClip > 0.02) ? Math.min(hb.p10, -40) : hb.p10;
        out.Highlights = Math.round(Math.max(hiFloor, Math.min(hb.p90, hb.median - hiPush)));

        /* Shadows: quanto mais empastado (shClip) e mais baixo o p5, mais
           positivo (abre sombras). */
        var sb = band('Shadows');
        out.Shadows = Math.round(clampR(
            sb.median + 140 * m.shClip + 0.30 * Math.max(0, 45 - m.Yp5), sb));

        /* look ~fixo (o estilo da casa): mediana do corpus. WB (Temperature/
           Tint) NAO e automatico (decisao 16/jul: medir WB de 1 frame
           engana; o Matheus ajusta na mao) — fica na mediana do look. */
        out.Contrast = Math.round(band('Contrast').median);
        out.Whites = Math.round(band('Whites').median);
        out.Blacks = Math.round(band('Blacks').median);
        out.Temperature = r2(band('Temperature').median);
        out.Tint = r2(band('Tint').median);

        return out;
    }

    /* ── util p/ testes: gera um PPM de cor solida (ou gradiente) ─────── */
    function writeSolidPPM(path, W, H, r, g, b) {
        var fs = require('fs');
        var head = Buffer.from('P6\n' + W + ' ' + H + '\n255\n', 'binary');
        var body = Buffer.alloc(W * H * 3);
        for (var i = 0; i < W * H; i++) { body[i * 3] = r; body[i * 3 + 1] = g; body[i * 3 + 2] = b; }
        fs.writeFileSync(path, Buffer.concat([head, body]));
    }

    if (IS_NODE) {
        module.exports = { measureFrame: measureFrame, measureRGB: measureRGB,
            predictCorrection: predictCorrection, corpusClass: corpusClass, loadStats: loadStats };

        if (require.main === module) {
            var cmd = process.argv[2];
            var stats = loadStats();

            if (cmd === 'measure') {
                console.log(JSON.stringify(measureFrame(process.argv[3]), null, 1));

            } else if (cmd === 'predict') {
                var m = measureFrame(process.argv[3]);
                console.log('metricas:', JSON.stringify(m));
                console.log('correcao (' + (process.argv[4] || 'camera') + '):',
                    JSON.stringify(predictCorrection(m, process.argv[4] || 'camera', stats)));

            } else if (cmd === 'selftest') {
                var fs = require('fs');
                var tmp = require('os').tmpdir();
                function mk(name, r, g, b) {
                    var p = tmp + '/ag_' + name + '.ppm';
                    writeSolidPPM(p, 96, 54, r, g, b);
                    return measureFrame(p);
                }
                var neutro = mk('neutro', 118, 118, 118);
                var escuro = mk('escuro', 28, 28, 28);
                var claro = mk('claro', 240, 240, 240);
                var estour = mk('estour', 252, 252, 252);
                var frio = mk('frio', 60, 95, 150);
                var quente = mk('quente', 160, 100, 55);
                function P(m2, cls) { return predictCorrection(m2, cls || 'camera', stats); }
                var pn = P(neutro), pe = P(escuro), pc = P(claro), px = P(estour), pf = P(frio), pq = P(quente);
                var cam = stats.camera;
                var checks = [
                    ['escuro Exposure > neutro', pe.Exposure > pn.Exposure],
                    ['claro Exposure < neutro', pc.Exposure < pn.Exposure],
                    ['escuro Shadows > neutro', pe.Shadows > pn.Shadows],
                    ['estourado Highlights < neutro', px.Highlights < pn.Highlights],
                    ['estourado Highlights bem negativo (<=-30)', px.Highlights <= -30],
                    ['Exposure dentro faixa (escuro)', pe.Exposure <= cam.Exposure.p90 + 1e-6 && pe.Exposure >= cam.Exposure.p10 - 1e-6],
                    ['Shadows dentro faixa (escuro)', pe.Shadows <= cam.Shadows.p90 && pe.Shadows >= cam.Shadows.p10],
                    ['WB fixo: Temperature = mediana em todos', pe.Temperature === pn.Temperature && pf.Temperature === pq.Temperature && pn.Temperature === pc.Temperature],
                    ['look Contrast = mediana corpus', pn.Contrast === Math.round(cam.Contrast.median)],
                    ['look Whites = mediana corpus', pn.Whites === Math.round(cam.Whites.median)]
                ];
                var ok = 0;
                checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FALHA ') + c[0]); if (c[1]) ok++; });
                console.log('\nexemplos de correcao:');
                console.log('  neutro   ', JSON.stringify(pn));
                console.log('  escuro   ', JSON.stringify(pe));
                console.log('  claro    ', JSON.stringify(pc));
                console.log('  estourado', JSON.stringify(px));
                console.log('  frio     ', JSON.stringify(pf));
                console.log('  quente   ', JSON.stringify(pq));
                console.log('\nGATE selftest: ' + ok + '/' + checks.length);
                process.exit(ok === checks.length ? 0 : 1);

            } else {
                console.log('uso: node js/autoGrade.js measure <img> | predict <img> <class> | selftest');
            }
        }
        return;
    }

    /* painel: measure/predict expostos */
    window.DM_autoGrade = {
        measureRGB: measureRGB, predictCorrection: predictCorrection, corpusClass: corpusClass
    };

    /* ── Fase C2: fluxo live com preview-before-apply ──────────────────
       Esta versao do Premiere NAO expoe export de frame por script, entao
       Passo 1 (JSX) so COLETA, por segmento do [AG] Grade: o clip de
       conteudo embaixo (mediaPath + tempo no source + classe). Passo 2
       (painel): mede o frame direto do CLIP FONTE com ffmpeg (seek + LUT de
       conversao) p/ camera; drone/comp/sem-source usam a base do corpus.
       PREVIEW (confirm). Passo 3 (JSX): adiciona Lumetri (QE) + setValue.
       Reversivel (Cmd+Z). */
    var LUT_CAMERA = dmRoot() + '/assets/luts/conversion/Slog3.cube';

    function autoCorrect() {
        var cs = new CSInterface();
        var shim = window.DM_JSON_SHIM || '';
        if (typeof setStatus === 'function') setStatus('Auto Correct: measuring segments (may take ~30-60s)...', 'success');

        var p1 = '(function(){' + shim + 'try{' +
            'var seq=app.project.activeSequence;if(!seq)return "ERR|no active sequence";' +
            'function lc(s){return String(s).toLowerCase();}' +
            'var gTr=null;' +
            'for(var t=0;t<seq.videoTracks.numTracks;t++){var tr=seq.videoTracks[t];' +
            'if(lc(tr.name||"").indexOf("grade")>=0){gTr=tr;break;}}' +
            'if(!gTr||gTr.clips.numItems===0)return "ERR|[AG] Grade track is empty (run Color Grade first)";' +
            'var out=[];' +
            'for(var i=0;i<gTr.clips.numItems;i++){var gc=gTr.clips[i];var st=gc.start.seconds,en=gc.end.seconds;var mid=(st+en)/2;' +
            'var cls="comp",mp="",srcT=mid;' +
            'for(var vt=0;vt<seq.videoTracks.numTracks;vt++){var tr2=seq.videoTracks[vt];var tn=lc(tr2.name||"");' +
            'if(tn.indexOf("[ag]")>=0||tn.indexOf("grade")>=0||tn.indexOf("conversion")>=0||tn.indexOf("creative")>=0)continue;' +
            'for(var cc=0;cc<tr2.clips.numItems;cc++){var kk=tr2.clips[cc];if(kk.start.seconds<=mid&&kk.end.seconds>mid){' +
            'try{mp=String(kk.projectItem.getMediaPath());}catch(e1){}' +
            'var ip=0;try{ip=kk.inPoint.seconds;}catch(e2){}srcT=ip+(mid-kk.start.seconds);' +
            'var bn=lc(mp);if(bn.indexOf("dji")>=0)cls="drone";else if(bn.length>4&&bn.substr(bn.length-4)===".aep")cls="comp";else cls="camera";break;}}' +
            'if(mp)break;}' +
            'out.push({i:i,start:st,end:en,mid:mid,cls:cls,src:mp,srcT:srcT});}' +
            'return JSON.stringify(out);}catch(e){return "ERR|"+e;}}())';

        cs.evalScript(p1, function (r1) {
            if (!r1 || r1.indexOf('ERR|') === 0) {
                if (typeof setStatus === 'function') setStatus('Auto Correct: ' + (r1 || 'no response'), 'error');
                return;
            }
            var segs = [];
            try { segs = JSON.parse(r1); } catch (e) { if (typeof setStatus === 'function') setStatus('Auto Correct: invalid response', 'error'); return; }

            var stats, fsN;
            try { stats = loadStats(); } catch (e) { if (typeof setStatus === 'function') setStatus('Auto Correct: gradeStats.json missing', 'error'); return; }
            try { fsN = nodeRequire('fs'); } catch (e) { fsN = null; }
            var haveLut = false; try { haveLut = fsN && fsN.existsSync(LUT_CAMERA); } catch (e) {}

            var plan = [], measured = 0, based = 0, diag = [];
            for (var i = 0; i < segs.length; i++) {
                var sg = segs[i];
                var m = null;
                var isVideo = sg.src && /\.(mp4|mov|mxf|m4v)$/i.test(sg.src);
                if (sg.cls === 'camera' && isVideo && fsN && fsN.existsSync(sg.src)) {
                    try { m = measureSource(sg.src, sg.srcT, haveLut ? LUT_CAMERA : null); }
                    catch (e) { if (diag.length < 6) diag.push('seg' + sg.i + ' measure: ' + String(e).slice(0, 50)); }
                }
                var corr = predictCorrection(m || NEUTRAL, sg.cls, stats);
                if (m) measured++; else based++;
                plan.push({ start: sg.start, mid: Math.round(sg.mid * 100) / 100, cls: sg.cls, corr: corr, src: m ? 1 : 0 });
            }
            try { if (fsN) fsN.writeFileSync(CAL_DIR + '/autoGradeDiag.txt', 'medidos(imagem)=' + measured + ' base-corpus=' + based + '\n' + diag.join('\n') + '\n\nseg0=' + JSON.stringify(segs[0])); } catch (e) {}
            if (plan.length === 0) { if (typeof setStatus === 'function') setStatus('Auto Correct: 0 segments', 'error'); return; }
            /* forensic dump (applies directly — undo with Cmd+Z) */
            try { if (fsN) fsN.writeFileSync(CAL_DIR + '/lastAutoGrade.json', JSON.stringify({ at: new Date().toISOString(), plan: plan }, null, 1)); } catch (e) {}

            var planArg = JSON.stringify(JSON.stringify(plan));
            var p3 = '(function(){' + shim + 'try{app.enableQE();' +
                'var seq=app.project.activeSequence;if(!seq)return "ERR|no sequence";' +
                'var plan=JSON.parse(' + 'arguments.callee.PLAN' + ');' +
                'function lc(s){return String(s).toLowerCase();}' +
                'var gTr=null;for(var t=0;t<seq.videoTracks.numTracks;t++){if(lc(seq.videoTracks[t].name||"").indexOf("grade")>=0){gTr=seq.videoTracks[t];break;}}' +
                'if(!gTr)return "ERR|grade track not found";' +
                'var lumName=null;var fx=qe.project.getVideoEffectList();' +
                'for(var f=0;f<fx.length;f++){if(lc(fx[f]).indexOf("lumetri")>=0){lumName=fx[f];break;}}' +
                'var lumFx=lumName?qe.project.getVideoEffectByName(lumName):null;' +
                'var qseq=qe.project.getActiveSequence();var qTr=null;' +
                'for(var q=0;q<qseq.numVideoTracks;q++){var qt=qseq.getVideoTrackAt(q);if(qt&&lc(String(qt.name)).indexOf("grade")>=0){qTr=qt;break;}}' +
                'var applied=0,diag=[];' +
                'for(var p=0;p<plan.length;p++){var seg=plan[p];var corr=seg.corr;var dc=null;' +
                'for(var c=0;c<gTr.clips.numItems;c++){if(Math.abs(gTr.clips[c].start.seconds-seg.start)<0.15){dc=gTr.clips[c];break;}}' +
                'if(!dc){diag.push("seg@"+seg.start+" clip not found");continue;}' +
                'var lum=null;for(var k=0;k<dc.components.numItems;k++){if(lc(dc.components[k].displayName).indexOf("lumetri")>=0)lum=dc.components[k];}' +
                'if(!lum&&lumFx&&qTr){for(var ci=0;ci<qTr.numItems;ci++){var it=qTr.getItemAt(ci);if(!it)continue;var qs=-1;' +
                'try{qs=it.start.secs;}catch(e3){}if(qs<0){try{qs=parseFloat(it.start.ticks)/254016000000;}catch(e3b){}}' +
                'if(qs>=0&&Math.abs(qs-seg.start)<0.15){try{it.addVideoEffect(lumFx);}catch(e4){}break;}}' +
                'for(var k2=0;k2<dc.components.numItems;k2++){if(lc(dc.components[k2].displayName).indexOf("lumetri")>=0)lum=dc.components[k2];}}' +
                'if(!lum){diag.push("seg@"+seg.start+" no Lumetri");continue;}' +
                'var setc=0;for(var pk in corr){if(!corr.hasOwnProperty(pk))continue;' +
                'for(var pp=0;pp<lum.properties.numItems;pp++){if(lum.properties[pp].displayName===pk){try{lum.properties[pp].setValue(corr[pk],true);setc++;}catch(e5){}break;}}}' +
                'if(setc>0)applied++;else diag.push("seg@"+seg.start+" 0 params");}' +
                'return "OK|"+applied+"/"+plan.length+(diag.length?" | "+diag.slice(0,4).join("; "):"");' +
                '}catch(e){return "ERR|"+e;}}())';
            /* injeta o plano como literal seguro (arguments.callee.PLAN vira o JSON) */
            p3 = p3.replace('arguments.callee.PLAN', planArg);

            if (typeof setStatus === 'function') setStatus('Auto Correct: applying to ' + plan.length + ' segments...', 'success');
            cs.evalScript(p3, function (r3) {
                if (r3 && r3.indexOf('OK|') === 0) {
                    if (typeof setStatus === 'function') setStatus('Auto Correct applied — ' + r3.slice(3) + ' (undo with Cmd+Z)', 'success');
                } else {
                    if (typeof setStatus === 'function') setStatus('Auto Correct: ' + (r3 || 'failed'), 'error');
                }
            });
        });
    }
    var _btnAC = document.getElementById('prAutoCorrect');
    if (_btnAC) _btnAC.addEventListener('click', autoCorrect);

    /* ── Corpus Auto-Grower (PESSOAL — só aparece pro usuário 'desiremedia') ─
       minera o projeto ABERTO e adiciona ao corpus (junta com os cacheados),
       re-agrega e regenera o gradeStats.json que o Auto Correct usa. Assim o
       "look da casa" cresce a cada projeto que VOCÊ aprova. */
    function growCorpus() {
        var cs = new CSInterface();
        cs.evalScript('(function(){try{var p=app.project.path;return p?String(p):"NONE";}catch(e){return "ERR|"+e;}}())', function (pp) {
            if (!pp || pp === 'NONE' || pp.indexOf('ERR|') === 0 || !/\.prproj$/i.test(pp)) {
                if (typeof setStatus === 'function') setStatus('Corpus: open and save a project (.prproj) first', 'error');
                return;
            }
            if (typeof setStatus === 'function') setStatus('Corpus: mining ' + pp.split('/').pop() + '... (a few seconds)', 'busy');
            var cp, fs2;
            try { cp = nodeRequire('child_process'); fs2 = nodeRequire('fs'); }
            catch (e) { if (typeof setStatus === 'function') setStatus('Corpus: Node runtime unavailable', 'error'); return; }
            var NODE = ['/usr/local/bin/node', '/opt/homebrew/bin/node'].filter(function (n) { try { return fs2.existsSync(n); } catch (e) { return false; } })[0] || 'node';
            var DEV = '/Users/desiremedia/Documents/DM_Tools_CEP';
            cp.execFile(NODE, [DEV + '/js/gradeMiner.js', 'grow', '--file', pp],
                { cwd: DEV, maxBuffer: 16 * 1024 * 1024, timeout: 180000 }, function (err, stdout, stderr) {
                    var out = String(stdout || '') + '\n' + String(stderr || '');
                    var okLine = (out.match(/OK\|[^\n]*/) || [])[0];
                    if (!okLine) { if (typeof setStatus === 'function') setStatus('Corpus: error — ' + String(stderr || err || 'no OK').slice(0, 80), 'error'); return; }
                    if (typeof setStatus === 'function') setStatus('Corpus grown — ' + okLine.slice(3), 'success');
                });
        });
    }
    var _btnGC = document.getElementById('prGrowCorpus');
    if (_btnGC) {
        var _isMatheus = false;
        try { _isMatheus = nodeRequire('os').userInfo().username === 'desiremedia'; } catch (e) {}
        if (_isMatheus) { _btnGC.style.display = ''; _btnGC.addEventListener('click', growCorpus); }
        /* outros editores: fica escondido (default display:none no HTML) */
    }
}());
