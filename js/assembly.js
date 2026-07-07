/* ── Auto Assembly ────────────────────────────────── */
(function() {
    var ENV_PATH = '/Users/desiremedia/Documents/desire-music-finder/.env';
    var FFMPEG_PATHS = ['/Users/desiremedia/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg',
        '/Applications/Wavdrop.app/Contents/Resources/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];

    function getGeminiKey() {
        try {
            var env = require('fs').readFileSync(ENV_PATH, 'utf8');
            var m = env.match(/GEMINI_API_KEY=([^\s]+)/);
            return m ? m[1] : null;
        } catch (_) { return null; }
    }

    function findFfmpeg() {
        var fs = require('fs');
        for (var i = 0; i < FFMPEG_PATHS.length; i++) {
            try { if (fs.existsSync(FFMPEG_PATHS[i])) return FFMPEG_PATHS[i]; } catch (_) {}
        }
        return 'ffmpeg';
    }

    // Extract one middle frame as small JPEG base64
    function extractFrame(ff, srcPath, midSec) {
        var os = require('os'), fs = require('fs'), cp = require('child_process');
        var out = os.tmpdir() + '/dm_asm_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.jpg';
        cp.execFileSync(ff, ['-y', '-ss', String(midSec), '-i', srcPath, '-frames:v', '1',
            '-vf', 'scale=512:-2', '-q:v', '6', out], { timeout: 30000 });
        var b64 = fs.readFileSync(out).toString('base64');
        try { fs.unlinkSync(out); } catch (_) {}
        return b64;
    }

    function classifyFrames(key, frames, cb) {
        var CATS = 'drone_aerial, facade, living, kitchen, dining, pool_bbq, master_bedroom, ensuite, bathroom, bedroom, garage, study, hallway, other';
        var prompt = 'These are frames from real-estate video clips, in order. For EACH image return one JSON object: ' +
            '{"i": <image index starting 0>, "cat": "<one of: ' + CATS + '>", "shot": "wide" or "detail"}. ' +
            'drone_aerial = any aerial/drone shot. facade = ground-level exterior front of house. ' +
            'detail = close-up of a feature (tap, decor, texture); wide = shows the whole room/space. ' +
            'Return ONLY a JSON array, one object per image, same order.';
        var parts = [{ text: prompt }];
        frames.forEach(function(f) { parts.push({ inline_data: { mime_type: 'image/jpeg', data: f } }); });

        var body = JSON.stringify({
            contents: [{ parts: parts }],
            generationConfig: { response_mime_type: 'application/json', temperature: 0 }
        });

        var https = require('https');
        var req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: '/v1beta/models/gemini-2.5-flash:generateContent?key=' + key,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                try {
                    var j = JSON.parse(data);
                    if (j.error) return cb(new Error('Gemini: ' + j.error.message));
                    var txt = j.candidates[0].content.parts[0].text;
                    cb(null, JSON.parse(txt));
                } catch (e) { cb(new Error('Gemini parse: ' + e.message + ' | ' + data.slice(0, 150))); }
            });
        });
        req.on('error', function(e) { cb(new Error('Gemini request: ' + e.message)); });
        req.setTimeout(120000, function() { req.destroy(); cb(new Error('Gemini timeout')); });
        req.write(body); req.end();
    }

    // Build the Desire Media tour order from classified clips
    function buildOrder(clips) {
        var used = {};
        var order = [];
        function take(pred, max) {
            var got = 0;
            for (var i = 0; i < clips.length && got < (max || 999); i++) {
                if (!used[i] && pred(clips[i])) { used[i] = true; order.push(clips[i]); got++; }
            }
            return got;
        }
        var isW = function(c) { return c.shot === 'wide'; };
        var isD = function(c) { return c.shot === 'detail'; };

        take(function(c) { return c.cat === 'drone_aerial'; }, 2);                       // intro drones
        take(function(c) { return isD(c) && c.cat !== 'drone_aerial'; }, 2);             // intro details
        take(function(c) { return c.cat === 'facade'; }, 1);                             // facade
        take(function(c) { return c.cat === 'living' && isW(c); }, 1);                   // living wide
        take(function(c) { return (c.cat === 'living' || c.cat === 'dining') && isD(c); }, 3); // details
        take(function(c) { return c.cat === 'kitchen' && isW(c); }, 1);                  // kitchen wide
        take(function(c) { return c.cat === 'kitchen' && isD(c); }, 2);                  // kitchen details
        take(function(c) { return c.cat === 'pool_bbq' && isW(c); }, 1);                 // pool/bbq
        take(function(c) { return c.cat === 'master_bedroom' && isW(c); }, 1);           // master wide
        take(function(c) { return c.cat === 'master_bedroom' && isD(c); }, 2);           // master details
        take(function(c) { return c.cat === 'ensuite'; }, 1);                            // ensuite
        take(function(c) { return c.cat === 'bedroom' && isW(c); }, 4);                  // other bedrooms
        take(function(c) { return c.cat === 'bathroom'; }, 1);                           // bathroom
        take(function(c) { return c.cat === 'drone_aerial'; }, 1);                       // closing drone
        return order;
    }

    var asmBtn = document.getElementById('prAutoAssembly');
    if (!asmBtn) return;
    asmBtn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { setStatus('Auto Assembly only works in Premiere', 'error'); return; }
        var key = getGeminiKey();
        if (!key) { setStatus('Gemini API key not found in ' + ENV_PATH, 'error'); return; }
        asmBtn.disabled = true;
        setStatus('Reading selected clips...', 'busy');

        var jsxCollect = '(function(){' +
            'var sel;try{sel=app.getCurrentProjectViewSelection();}catch(e){sel=null;}' +
            'if(!sel||!sel.length)return JSON.stringify({error:"Select the shoot clips in the Project panel first"});' +
            'var out=[];' +
            'for(var i=0;i<sel.length;i++){var it=sel[i];' +
            'if(it.type===ProjectItemType.BIN){for(var j=0;j<it.children.numItems;j++){var ch=it.children[j];' +
            'try{var p=ch.getMediaPath();if(p)out.push({id:ch.nodeId,name:ch.name,path:p,dur:ch.getOutPoint(4).seconds});}catch(e){}}}' +
            'else{try{var p2=it.getMediaPath();if(p2)out.push({id:it.nodeId,name:it.name,path:p2,dur:it.getOutPoint(4).seconds});}catch(e){}}}' +
            'return JSON.stringify({clips:out});}())';

        evalScript(jsxCollect, function(res) {
            var info;
            try { info = JSON.parse(res); } catch (_) { info = { error: 'collect parse failed' }; }
            if (info.error) { setStatus(info.error, 'error'); asmBtn.disabled = false; return; }

            var vids = info.clips.filter(function(c) {
                return /\.(mp4|mov|mxf|m4v)$/i.test(c.path);
            });
            if (vids.length < 3) { setStatus('Need at least 3 video clips selected (' + vids.length + ' found)', 'error'); asmBtn.disabled = false; return; }
            if (vids.length > 60) vids = vids.slice(0, 60);

            var ff = findFfmpeg();
            setStatus('Extracting frames 0/' + vids.length + '...', 'busy');

            setTimeout(function() {
                var frames = [];
                for (var i = 0; i < vids.length; i++) {
                    try {
                        frames.push(extractFrame(ff, vids[i].path, Math.max(0.5, vids[i].dur / 2)));
                    } catch (e) {
                        frames.push(null);
                    }
                    if (i % 5 === 4) setStatus('Extracting frames ' + (i + 1) + '/' + vids.length + '...', 'busy');
                }
                var valid = [], validIdx = [];
                frames.forEach(function(f, ix) { if (f) { valid.push(f); validIdx.push(ix); } });
                if (valid.length < 3) { setStatus('Frame extraction failed on most clips', 'error'); asmBtn.disabled = false; return; }

                setStatus('Classifying ' + valid.length + ' clips with AI...', 'busy');
                classifyFrames(key, valid, function(err, cats) {
                    if (err) { setStatus(err.message, 'error'); asmBtn.disabled = false; return; }

                    var clips = [];
                    cats.forEach(function(c) {
                        var v = vids[validIdx[c.i]];
                        if (v) clips.push({ id: v.id, name: v.name, dur: v.dur, cat: c.cat, shot: c.shot });
                    });

                    var ordered = buildOrder(clips);
                    if (!ordered.length) { setStatus('Could not build an order from these clips', 'error'); asmBtn.disabled = false; return; }

                    var clipLen = parseFloat(document.getElementById('asmClipLen') ? document.getElementById('asmClipLen').value : '2') || 2;
                    setStatus('Assembling ' + ordered.length + ' clips on timeline...', 'busy');

                    var plan = ordered.map(function(c) {
                        var inP = Math.max(0, (c.dur - clipLen) / 2);
                        return { id: c.id, in : inP, out: Math.min(c.dur, inP + clipLen) };
                    });

                    var jsxAsm = '(function(){' +
                        'var plan=' + JSON.stringify(JSON.stringify(plan)) + ';plan=JSON.parse(plan);' +
                        'var seq=app.project.activeSequence;' +
                        'if(!seq)return JSON.stringify({error:"Open a sequence first"});' +
                        'var byId={};' +
                        'function walk(bin){for(var i=0;i<bin.children.numItems;i++){var it=bin.children[i];' +
                        'if(it.type===ProjectItemType.BIN)walk(it);else byId[it.nodeId]=it;}}' +
                        'walk(app.project.rootItem);' +
                        'var t=0,n=0,tr=seq.videoTracks[0];' +
                        'for(var k=0;k<plan.length;k++){var pi=byId[plan[k].id];if(!pi)continue;' +
                        'try{pi.setInPoint(plan[k]["in"],4);pi.setOutPoint(plan[k].out,4);' +
                        'tr.overwriteClip(pi,t);t+=(plan[k].out-plan[k]["in"]);n++;}catch(e){}}' +
                        'for(var k2=0;k2<plan.length;k2++){var pi2=byId[plan[k2].id];' +
                        'try{pi2.clearInPoint(4);pi2.clearOutPoint(4);}catch(e){}}' +
                        'return JSON.stringify({ok:n});}())';

                    evalScript(jsxAsm, function(res2) {
                        var r;
                        try { r = JSON.parse(res2); } catch (_) { r = { error: 'assembly parse failed: ' + res2 }; }
                        if (r.error) setStatus(r.error, 'error');
                        else setStatus('Assembled ' + r.ok + ' of ' + ordered.length + ' clips ✓', 'success');
                        asmBtn.disabled = false;
                    });
                });
            }, 50);
        });
    });
})();
