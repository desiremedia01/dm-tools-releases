/* ── Reframe → Portrait (landscape→portrait via Nano Banana 2) ─────────────
   Pega o frame do playhead da sequence ativa, extrai do CLIP FONTE via ffmpeg
   com o LUT de CONVERSAO aplicado (esta versao do Premiere nao expoe export de
   frame por script), manda pro Higgsfield (nano_banana_2, aspect 9:16, 2k),
   que estende o cenario pra cima e pra baixo de forma foto-realista mantendo o
   grade. Preview (abre a imagem) -> confirma -> importa no projeto (bin REFRAME).

   Decisoes do Matheus (17/jul/2026): LUT = so conversao; modelo = Nano Banana 2
   (2k); saida = preview + importar no projeto. Caminho Higgsfield = o MESMO do
   video-gen.js (token proprio ~/.higgsfield_token) — provado ao vivo (o teste
   landscape->portrait com footage real ficou perfeito: piso e teto estendidos,
   grade preservado, sem objeto inventado).

   Gate offline: `node js/reframe.js selftest` valida a logica pura (mapa de LUT
   drone, prompt, parse de resposta). A geracao real so o teste live confirma. */
(function () {
    var IS_NODE = (typeof document === 'undefined');
    var DEV = '/Users/desiremedia/Documents/DM_Tools_CEP';
    var LUT_DIR = DEV + '/assets/luts/conversion/';
    var LUT_CAMERA = LUT_DIR + 'Slog3.cube';

    var MCP_URL    = 'https://mcp.higgsfield.ai/mcp';
    var OAUTH_BASE = 'https://mcp.higgsfield.ai';
    var CLIENT_ID  = 'dAAlutEqPrwM82io';
    var TOKEN_PATH = (function () { try { return nodeRequire('os').homedir() + '/.higgsfield_token'; } catch (e) { return ''; } })();

    var PORTRAIT_PROMPT =
        'Extend this real-estate photograph into a vertical 9:16 portrait. ' +
        'Naturally continue the scene above and below the original frame — same location, ' +
        'same architecture, same furniture, same sky and ground, same lighting and color grade ' +
        'and white balance. Photorealistic, seamless continuation, no new objects, no added ' +
        'people, no distortion, no text, no borders.';

    function nodeRequire(m) {
        return (typeof window !== 'undefined' && window.cep_node) ? window.cep_node.require(m) : require(m);
    }

    function ffPath() {
        var fs = nodeRequire('fs');
        var cands = [
            DEV + '/bin/ffmpeg',
            '/Applications/Wavdrop.app/Contents/Resources/ffmpeg',
            (process.env.HOME || '') + '/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg'
        ];
        for (var i = 0; i < cands.length; i++) { try { if (fs.existsSync(cands[i])) return cands[i]; } catch (e) {} }
        return 'ffmpeg';
    }

    /* ── LUT de conversao para o clip ─────────────────────────────────────
       camera (FX3) = Slog3 (certo). drone = tenta detectar o modelo DJI via
       exiftool; se nao souber, cai no Air 3 (mais comum) e AVISA no status. */
    function droneLutFor(modelText) {
        var t = String(modelText || '').toLowerCase();
        if (t.indexOf('avata') >= 0) return { file: 'DJI Avata 2.cube', sure: true };
        if (t.indexOf('mavic 4') >= 0 || t.indexOf('mavic4') >= 0) return { file: 'DJI Mavic 4 Pro.cube', sure: true };
        if (t.indexOf('mavic 3') >= 0 || t.indexOf('mavic') >= 0) return { file: 'DJI Mavic 3.cube', sure: true };
        if (t.indexOf('air 3') >= 0 || t.indexOf('air3') >= 0) return { file: 'DJI Air 3.cube', sure: true };
        return { file: 'DJI Air 3.cube', sure: false };
    }

    function exifModel(srcPath) {
        try {
            var cp = nodeRequire('child_process');
            var out = cp.execFileSync('/usr/bin/perl',
                [DEV + '/tools/exiftool/exiftool', '-s3', '-Model', '-CameraModelName', '-Software', '-HandlerDescription', srcPath],
                { maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
            return String(out || '');
        } catch (e) { return ''; }
    }

    /* devolve {path, label, sure} do LUT de conversao pra uma classe+fonte */
    function pickConversionLut(cls, srcPath) {
        var fs = nodeRequire('fs');
        if (cls === 'drone') {
            var d = droneLutFor(exifModel(srcPath));
            var p = LUT_DIR + d.file;
            if (fs.existsSync(p)) return { path: p, label: d.file.replace('.cube', ''), sure: d.sure };
            return { path: null, label: '(drone LUT nao achado)', sure: false };
        }
        if (fs.existsSync(LUT_CAMERA)) return { path: LUT_CAMERA, label: 'Slog3', sure: true };
        return { path: null, label: '(Slog3 nao achado)', sure: false };
    }

    /* extrai 1 frame do source no tempo tSec, aplica o LUT, salva 16:9 1920w */
    function extractFrame(srcPath, tSec, lutPath, outPath) {
        var cp = nodeRequire('child_process');
        var vf = (lutPath ? 'lut3d=' + lutPath + ',' : '') + 'scale=1920:-2';
        cp.execFileSync(ffPath(),
            ['-y', '-v', 'error', '-ss', String(Math.max(0, tSec)), '-i', srcPath,
                '-frames:v', '1', '-vf', vf, '-q:v', '2', outPath],
            { maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
        return outPath;
    }

    /* ── Higgsfield (mesmo caminho do video-gen.js, token proprio) ───────── */
    function loadToken() { return DmSecureStore.get('higgsfield'); }
    function saveToken(d) { d.expires_at = Date.now() / 1000 + (d.expires_in || 3600); DmSecureStore.set('higgsfield', d); }
    function refreshToken(rt) {
        return fetch(OAUTH_BASE + '/oauth2/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT_ID })
        }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (!d) return null; saveToken(d); return d.access_token; });
    }
    function getToken() {
        var t = loadToken(); if (!t) return Promise.resolve(null);
        if (Date.now() / 1000 < (t.expires_at || 0) - 300) return Promise.resolve(t.access_token);
        if (t.refresh_token) return refreshToken(t.refresh_token);
        return Promise.resolve(null);
    }
    function isAuthed() {
        var t = loadToken(); if (!t) return false;
        if (Date.now() / 1000 < (t.expires_at || 0) - 60) return true;
        return !!t.refresh_token;
    }

    function mcpCall(tool, args) {
        return getToken().then(function (token) {
            if (!token) throw new Error('Higgsfield: nao autenticado (use o AI Video pra logar 1x)');
            return fetch(MCP_URL, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: Date.now().toString(), method: 'tools/call', params: { name: tool, arguments: args } })
            });
        }).then(function (res) {
            if (!res.ok) throw new Error('MCP HTTP ' + res.status);
            var ct = res.headers.get('content-type') || '';
            if (ct.indexOf('text/event-stream') >= 0) {
                var reader = res.body.getReader(), dec = new TextDecoder(), buf = '', result = null;
                function pump() {
                    return reader.read().then(function (o) {
                        if (o.done) return result || {};
                        buf += dec.decode(o.value, { stream: true });
                        var lines = buf.split('\n'); buf = lines.pop();
                        for (var i = 0; i < lines.length; i++) {
                            var line = lines[i]; if (line.indexOf('data: ') !== 0) continue;
                            var chunk = line.slice(6).trim(); if (chunk === '[DONE]') continue;
                            try { var p = JSON.parse(chunk); if (p.result) result = p.result; if (p.error) throw new Error(JSON.stringify(p.error)); }
                            catch (e) { if (e.message.indexOf('{') >= 0) throw e; }
                        }
                        return pump();
                    });
                }
                return pump();
            }
            return res.json().then(function (data) { if (data.error) throw new Error(JSON.stringify(data.error)); return data.result || {}; });
        });
    }

    function extractText(result) {
        var c = result && result.content; if (!c) return JSON.stringify(result);
        for (var i = 0; i < c.length; i++) { if (c[i].type === 'text') return c[i].text; }
        return '';
    }

    function findUuid(text, keys) {
        var re = new RegExp('[\'"]?(?:' + keys + ')[\'"]?\\s*[=:]\\s*[\'"]?([0-9a-f-]{32,})[\'"]?', 'i');
        var m = text.match(re); if (m) return m[1];
        var uu = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return uu ? uu[0] : null;
    }

    function uploadImageFile(imgPath) {
        var fs = nodeRequire('fs');
        var bytes = fs.readFileSync(imgPath);
        return mcpCall('media_upload', { filename: 'reframe_src.jpg', content_type: 'image/jpeg' }).then(function (up) {
            var text = extractText(up), uploadUrl, mediaId;
            try { var b = JSON.parse(text); uploadUrl = b.upload_url || b.uploadUrl; mediaId = b.id || b.media_id; } catch (e) {}
            if (!uploadUrl) { var u = text.match(/https:\/\/\S+/); if (u) uploadUrl = u[0].replace(/[.,'"]+$/, ''); }
            if (!mediaId) mediaId = findUuid(text, 'media_id|id');
            if (!uploadUrl || !mediaId) throw new Error('upload: nao parseou url/id');
            var ab = new Uint8Array(bytes);
            return fetch(uploadUrl, { method: 'PUT', body: new Blob([ab], { type: 'image/jpeg' }), headers: { 'Content-Type': 'image/jpeg' } })
                .then(function () { return mcpCall('media_confirm', { media_id: mediaId, type: 'image' }); })
                .then(function () { return mediaId; });
        });
    }

    function pollImageJob(jobId, onTick) {
        var deadline = Date.now() + 150000;
        function step() {
            if (Date.now() > deadline) throw new Error('geracao expirou (timeout)');
            return mcpCall('job_status', { jobId: jobId }).then(function (r) {
                var text = extractText(r);
                if (r && r.content) { for (var i = 0; i < r.content.length; i++) { var it = r.content[i];
                    if (it.url) return it.url;
                    if (it.type === 'image' && it.source && it.source.url) return it.source.url; } }
                if (text) {
                    var m = text.match(/https:\/\/\S+\.(?:jpg|jpeg|png|webp)[^\s'"<>)]*/i);
                    if (m) return m[0].replace(/[.,'")\]>\s]+$/, '');
                    if (/\b(?:failed|cancelled|canceled|error)\b/i.test(text) && !/generating|processing|queued|running|submitted|pending/i.test(text))
                        throw new Error('geracao falhou: ' + text.slice(0, 160));
                }
                if (onTick) onTick();
                return new Promise(function (res) { setTimeout(res, 3000); }).then(step);
            });
        }
        return step();
    }

    function generatePortrait(mediaId, declinedPresetId) {
        var callArgs = { params: { model: 'nano_banana_2', prompt: PORTRAIT_PROMPT, aspect_ratio: '9:16', resolution: '2k', medias: [{ value: mediaId, role: 'image' }] } };
        if (declinedPresetId) callArgs.declined_preset_id = declinedPresetId;
        return mcpCall('generate_image', callArgs).then(function (res) {
            var text = extractText(res);
            var notice = /Ask the user whether to use that preset/i.test(text) || /retry with declined_preset_id/i.test(text);
            if (notice && !declinedPresetId) { var pm = text.match(/preset[_ ]id["']?\s*[=:]\s*["']?([0-9a-f-]{32,})/i); if (pm) return generatePortrait(mediaId, pm[1]); }
            var jobId = null; try { var b = JSON.parse(text); jobId = b.job_id || b.id || b.jobId; } catch (e) {}
            if (!jobId) jobId = findUuid(text, 'job_id|jobId|id');
            if (!jobId) throw new Error('nao parseou job id: ' + text.slice(0, 120));
            return jobId;
        });
    }

    function downloadFile(url, dest) {
        return new Promise(function (resolve, reject) {
            var proto = nodeRequire(url.indexOf('https') === 0 ? 'https' : 'http');
            var fs = nodeRequire('fs'); var tmp = dest + '.tmp'; var file = fs.createWriteStream(tmp);
            proto.get(url, function (res) {
                if (res.statusCode === 301 || res.statusCode === 302) { file.close(); try { fs.unlinkSync(tmp); } catch (e) {} downloadFile(res.headers.location, dest).then(resolve, reject); return; }
                if (res.statusCode !== 200) { file.close(); try { fs.unlinkSync(tmp); } catch (e) {} reject(new Error('download HTTP ' + res.statusCode)); return; }
                res.pipe(file);
                file.on('finish', function () { file.close(); try { fs.renameSync(tmp, dest); } catch (e) {} resolve(dest); });
                file.on('error', function (e) { try { fs.unlinkSync(tmp); } catch (x) {} reject(e); });
            }).on('error', function (e) { try { fs.unlinkSync(tmp); } catch (x) {} reject(e); });
        });
    }

    /* ── main handler (painel) ────────────────────────────────────────────── */
    function reframePortrait() {
        if (IS_NODE) return;
        var cs = new CSInterface();
        var shim = window.DM_JSON_SHIM || '';
        var fs; try { fs = nodeRequire('fs'); } catch (e) { setStatus('Reframe: Node indisponivel', 'error'); return; }

        if (!isAuthed()) { setStatus('Reframe: faca login no Higgsfield 1x pelo AI Video primeiro', 'error'); return; }

        setStatus('Reframe: pegando o frame no playhead...', 'busy');

        /* clip sob o playhead (topo, ignorando tracks [AG]) + tempo no source */
        var p1 = '(function(){' + shim + 'try{' +
            'var seq=app.project.activeSequence;if(!seq)return "ERR|sem sequence ativa";' +
            'function lc(s){return String(s).toLowerCase();}' +
            'var ph=seq.getPlayerPosition().seconds;' +
            'var best=null,bestTr=-1;' +
            'for(var t=0;t<seq.videoTracks.numTracks;t++){var tr=seq.videoTracks[t];var tn=lc(tr.name||"");' +
            'if(tn.indexOf("[ag]")>=0||tn.indexOf("grade")>=0||tn.indexOf("conversion")>=0||tn.indexOf("creative")>=0)continue;' +
            'for(var c=0;c<tr.clips.numItems;c++){var k=tr.clips[c];if(k.start.seconds<=ph&&k.end.seconds>ph){best=k;bestTr=t;}}}' +
            'if(!best)return "ERR|nenhum clip no playhead (coloque a agulha num clip de camera ou drone)";' +
            'var mp="";try{mp=String(best.projectItem.getMediaPath());}catch(e1){}' +
            'var ip=0;try{ip=best.inPoint.seconds;}catch(e2){}var srcT=ip+(ph-best.start.seconds);' +
            'var bn=lc(mp),cls="camera";if(bn.indexOf("dji")>=0)cls="drone";else if(bn.length>4&&bn.substr(bn.length-4)===".aep")cls="comp";' +
            'return JSON.stringify({src:mp,srcT:srcT,cls:cls,ph:ph});' +
            '}catch(e){return "ERR|"+e;}}())';

        cs.evalScript(p1, function (r1) {
            if (!r1 || r1.indexOf('ERR|') === 0) { setStatus('Reframe: ' + (r1 || 'sem resposta').replace('ERR|', ''), 'error'); return; }
            var info; try { info = JSON.parse(r1); } catch (e) { setStatus('Reframe: resposta invalida', 'error'); return; }

            if (info.cls === 'comp' || !info.src) { setStatus('Reframe: coloque o playhead num clip de camera/drone (comp .aep nao da pra extrair)', 'error'); return; }
            if (!/\.(mp4|mov|mxf|m4v|braw|mts)$/i.test(info.src) || !fs.existsSync(info.src)) { setStatus('Reframe: arquivo fonte nao encontrado (' + (info.src || '').split('/').pop() + ')', 'error'); return; }

            var lut = pickConversionLut(info.cls, info.src);
            var os = nodeRequire('os');
            var tmpDir = os.tmpdir(); var framePath = tmpDir + '/dm_reframe_src_' + Date.now() + '.jpg';

            setStatus('Reframe: extraindo frame (' + info.cls + ', LUT ' + lut.label + (lut.sure ? '' : ' — palpite') + ')...', 'busy');
            try { extractFrame(info.src, info.srcT, lut.path, framePath); }
            catch (e) { setStatus('Reframe: ffmpeg falhou — ' + String(e).slice(0, 80), 'error'); return; }
            if (!fs.existsSync(framePath)) { setStatus('Reframe: frame nao gerado', 'error'); return; }

            setStatus('Reframe: gerando portrait no Nano Banana (~15-25s)...', 'busy');
            var ticks = 0;
            uploadImageFile(framePath)
                .then(function (mediaId) { return generatePortrait(mediaId, null); })
                .then(function (jobId) { return pollImageJob(jobId, function () { ticks++; if (ticks % 3 === 0) setStatus('Reframe: gerando... (' + (ticks * 3) + 's)', 'busy'); }); })
                .then(function (url) {
                    return getProjectDir(cs).then(function (dir) {
                        var outDir = dir + '/REFRAME';
                        try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
                        var base = (info.src.split('/').pop() || 'frame').replace(/\.[^.]+$/, '');
                        var outPath = outDir + '/' + base + '_portrait_' + Date.now() + '.png';
                        return downloadFile(url, outPath);
                    });
                })
                .then(function (outPath) {
                    try { fs.unlinkSync(framePath); } catch (e) {}
                    /* preview: abre a imagem pro Matheus ver */
                    try { nodeRequire('child_process').execFile('/usr/bin/open', [outPath]); } catch (e) {}
                    var go = false;
                    try { go = confirm('Reframe pronto:\n' + outPath.split('/').pop() + '\n\n(abri a imagem pra voce ver)\n\nImportar no projeto? (Cancelar = so salvar, nao importar)'); } catch (e) { go = true; }
                    if (!go) { setStatus('Reframe: salvo em ' + outPath.replace(/^.*\/REFRAME\//, 'REFRAME/') + ' (nao importado)', 'success'); return; }
                    importToProject(cs, shim, outPath, function (ok) {
                        setStatus(ok ? 'Reframe: importado no bin REFRAME ✓' : 'Reframe: salvo, mas import falhou (' + ok + ')', ok === true ? 'success' : 'error');
                    });
                })
                .catch(function (e) { try { fs.unlinkSync(framePath); } catch (x) {} setStatus('Reframe: ' + String(e.message || e).slice(0, 140), 'error'); });
        });
    }

    function getProjectDir(cs) {
        return new Promise(function (resolve) {
            cs.evalScript('(function(){try{return new File(app.project.path).parent.fsName;}catch(e){return "";}}())',
                function (r) { var d = (r || '').trim(); if (!d) { try { d = nodeRequire('os').homedir() + '/Desktop'; } catch (e) { d = '.'; } } resolve(d); });
        });
    }

    function importToProject(cs, shim, imgPath, cb) {
        var safe = imgPath.replace(/\\/g, '/').replace(/'/g, "\\'");
        var jsx = '(function(){' + shim + 'try{' +
            'var root=app.project.rootItem,bin=null;' +
            'for(var i=0;i<root.children.numItems;i++){if(root.children[i].name==="REFRAME"){bin=root.children[i];break;}}' +
            'if(!bin)bin=root.createBin("REFRAME");' +
            'app.project.importFiles(["' + safe + '"],true,bin,false);' +
            'app.executeCommand(3);return "ok";}catch(e){return "err:"+e.message;}}())';
        cs.evalScript(jsx, function (r) { cb(r === 'ok' ? true : (r || 'sem resposta')); });
    }

    if (!IS_NODE) {
        /* personal button (like Grow Corpus): hidden by default, revealed
           only on Matheus's machine — not shipped in the release manifest */
        var btn = document.getElementById('prReframe');
        if (btn) {
            var mine = false;
            try { mine = nodeRequire('os').userInfo().username === 'desiremedia'; } catch (e) {}
            if (mine) { btn.style.display = ''; btn.addEventListener('click', reframePortrait); }
        }
    }

    /* ── CLI selftest (logica pura, offline) ──────────────────────────────── */
    if (IS_NODE && require.main === module) {
        var cmd = process.argv[2];
        if (cmd === 'selftest') {
            var fail = 0;
            function ok(name, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail++; }
            ok('drone Avata', droneLutFor('DJI Avata 2 whatever').file === 'DJI Avata 2.cube');
            ok('drone Mavic 4', droneLutFor('mavic 4 pro').file === 'DJI Mavic 4 Pro.cube');
            ok('drone Mavic 3', droneLutFor('DJI Mavic 3').file === 'DJI Mavic 3.cube');
            ok('drone Air 3', droneLutFor('Air 3').file === 'DJI Air 3.cube');
            ok('drone unknown->Air3 (guess)', (function () { var d = droneLutFor('FC8282'); return d.file === 'DJI Air 3.cube' && d.sure === false; })());
            ok('prompt tem 9:16 intent', /9:16/.test(PORTRAIT_PROMPT) && /portrait/i.test(PORTRAIT_PROMPT));
            ok('prompt proibe objeto novo', /no new objects/i.test(PORTRAIT_PROMPT));
            var fsx = require('fs');
            ok('LUT Slog3 existe', fsx.existsSync(LUT_CAMERA));
            ok('LUT DJI Air 3 existe', fsx.existsSync(LUT_DIR + 'DJI Air 3.cube'));
            ok('token path resolvido', TOKEN_PATH.indexOf('.higgsfield_token') >= 0);
            ok('findUuid job', findUuid('blah job_id: 17d2dd34-751e-4735-b493-fe93e755352f end', 'job_id|id') === '17d2dd34-751e-4735-b493-fe93e755352f');
            console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAIL');
            process.exit(fail === 0 ? 0 : 1);
        } else if (cmd === 'gen') {
            /* teste end-to-end do CODIGO REAL do modulo (node): sobe imagem ja
               pronta -> nano_banana_2 9:16 -> baixa. uso: node js/reframe.js gen <img> [out] */
            var img = process.argv[3], out = process.argv[4] || (img.replace(/\.[^.]+$/, '') + '_portrait.png');
            uploadImageFile(img)
                .then(function (id) { console.error('[gen] mediaId', id); return generatePortrait(id, null); })
                .then(function (job) { console.error('[gen] jobId', job); return pollImageJob(job, function () { process.stderr.write('.'); }); })
                .then(function (url) { console.error('\n[gen] url', url); return downloadFile(url, out); })
                .then(function (p) { console.log('OK ' + p); process.exit(0); })
                .catch(function (e) { console.error('ERR', e.message || e); process.exit(1); });
        } else {
            console.log('uso: node js/reframe.js selftest | gen <img> [out]');
        }
    }
})();
