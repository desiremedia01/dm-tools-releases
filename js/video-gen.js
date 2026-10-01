/* ── Video Generator ─────────────────────────────────────────────────────────
   Calls Anthropic (vision) + Higgsfield MCP directly from the CEP panel.
   Credentials stored in macOS Keychain
   ──────────────────────────────────────────────────────────────────────────── */

(function () {
    'use strict';

    // ── Node.js modules (available via --enable-nodejs) ───────────────────────
    const fs   = require('fs');
    const os   = require('os');
    const http = require('http');
    const cp   = require('child_process');
    const cr   = require('crypto');
    const https = require('https');

    function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

    // ── Constants ─────────────────────────────────────────────────────────────
    const MCP_URL      = 'https://mcp.higgsfield.ai/mcp';
    const OAUTH_BASE   = 'https://mcp.higgsfield.ai';
    const CLIENT_ID    = 'dAAlutEqPrwM82io';
    const REDIRECT_URI = 'http://localhost:54042/callback';
    const ANTH_KEY     = 'vg_anthropic_key';

    // ── Config file (persists API keys across panel reloads) ──────────────────
    function loadConfig() { DmSecureStore.migrateLegacy();return DmSecureStore.get('ai-config') || {}; }
    function saveConfig(patch) { const cfg=loadConfig();Object.assign(cfg,patch);DmSecureStore.set('ai-config',cfg); }
    function getStoredAnthropicKey() { return loadConfig().anthropic_key || ''; }
    function getStoredGeminiKey() { return loadConfig().gemini_key || ''; }
    function persistAnthropicKey(key) { if(key){saveConfig({anthropic_key:key});localStorage.removeItem(ANTH_KEY);} }

    // ── Camera movements (Start → End mode) ──────────────────────────────────
    const CAMERA_SWAP = {
        push_in:   'push_out',
        push_out:  'push_in',
        pan_left:  'pan_right',
        pan_right: 'pan_left',
        tilt_up:   'tilt_down',
        tilt_down: 'tilt_up',
        static:    'static',
        drone:     'drone',
        handheld:  'handheld',
    };

    const CAMERA_MOVEMENTS = {
        static:    'Locked-off camera on a tripod. No camera movement whatsoever.',
        push_in:   'Slow, smooth push in toward the subject throughout the duration.',
        push_out:  'Slow, smooth pull back away from the subject throughout the duration.',
        pan_left:  'Slow, smooth horizontal pan from right to left.',
        pan_right: 'Slow, smooth horizontal pan from left to right.',
        tilt_up:   'Slow, smooth tilt upward throughout the duration.',
        tilt_down: 'Slow, smooth tilt downward throughout the duration.',
        drone:     'Smooth aerial drone movement, maintaining consistent altitude and trajectory.',
        handheld:  'Gentle, organic handheld camera movement throughout.',
    };

    // ── Start → End presets ───────────────────────────────────────────────────
    const SE_PRESETS = {
        renovation: 'The same property fully renovated: fresh modern facade, new render or paint, updated windows and front door, clean neat garden. Maintain the exact same camera angle, lighting conditions, and framing as the start frame.',
        day_night:  'The same scene at night: warm amber light glowing from inside the home, subtle exterior pathway and garden lighting, deep blue twilight sky. Same camera angle and framing as the start frame.',
        weather:    'The same scene under a dramatic overcast sky: heavy dark clouds, diffused flat lighting, moody atmosphere. Same camera angle and framing as the start frame.',
    };

    // ── Templates ─────────────────────────────────────────────────────────────
    const TEMPLATES = {
        weather: {
            label: 'Weather Change',
            prompt: [
                'Analyze this image and return ONLY a JSON object:',
                '{',
                '  "current_weather": "current weather/lighting (e.g. overcast, rainy, foggy, nighttime, clear blue sky)",',
                '  "new_weather": "contrasting weather to replace it with",',
                '  "camera_type": "camera setup (e.g. drone, static, handheld, panning)",',
                '  "preserve_elements": "key permanent elements to preserve",',
                '  "lighting_description": "lighting that matches new_weather",',
                '  "sun_position": "sun position matching new_weather"',
                '}'
            ].join('\n'),
            subject(a) {
                return a.preserve_elements || a.current_weather || '';
            },
            fallback: 'Replace the current weather in this video with a clear blue midday sky.\n\nBright, natural midday sunlight with neutral color temperature.\n\nPreserve original camera movement, framing, and exposure.\n\nDo not alter, regenerate, distort, or enhance any buildings or structures.',
            fill(a) {
                return [
                    `Replace the ${a.current_weather || 'current weather'} in this video with ${a.new_weather || 'a clear blue midday sky'}.`,
                    '',
                    `${a.lighting_description || 'Bright, natural midday sunlight with neutral color temperature'}.`,
                    '',
                    `${a.sun_position || 'High sun angle with short, realistic shadows'}.`,
                    '',
                    'Clean, crisp visibility with minimal atmospheric haze.',
                    '',
                    `Preserve original ${a.camera_type || 'camera movement'}, framing, and exposure.`,
                    '',
                    `Do not alter, regenerate, distort, or enhance any ${a.preserve_elements || 'buildings or structures'}, including distant background elements.`
                ].join('\n');
            }
        },
        shadow: {
            label: 'Shadow Timelapse',
            prompt: [
                'Analyze this real estate image. Return ONLY a JSON object with concise values (max 8 words each):',
                '{',
                '  "scene_description": "subject being lit, e.g. \'modern house front facade\'",',
                '  "sun_start": "e.g. \'low on eastern horizon\'",',
                '  "shadow_direction": "e.g. \'left to right across facade\'",',
                '  "camera_position": "e.g. \'static wide shot from street level\'",',
                '  "preserve_elements": "e.g. \'house exterior, driveway, landscaping\'"',
                '}'
            ].join('\n'),
            subject(a) {
                return a.scene_description || '';
            },
            fallback: 'Create a shadow timelapse showing sunlight sweeping across the scene as the sun moves across the sky during the day.\n\nThe sun travels across the sky so the shadows sweep gradually from one side to the other. Keep the color temperature constant throughout — the same neutral daylight white balance from the first frame to the last. Do not warm up, yellow, or shift the colours toward golden hour or sunset at any point.\n\nShadows sweep from left to right across the facade in a smooth, continuous motion.\n\nCamera remains locked on tripod. No camera movement — only the sun and shadows move.\n\nPreserve all architectural details and structural elements exactly. Keep the exposure and colour grade identical throughout.',
            fill(a) {
                return [
                    `Create a shadow timelapse showing sunlight sweeping across ${a.scene_description || 'the scene'} as the sun moves across the sky during the day.`,
                    '',
                    `The sun travels across the sky and the front of the building stays evenly lit as the shadows move. Keep the color temperature constant throughout — the same neutral daylight white balance from the first frame to the last. Do not warm up, yellow, or shift the colours toward golden hour or sunset at any point.`,
                    '',
                    `Shadows sweep ${a.shadow_direction || 'from left to right across the facade'} in a smooth, continuous motion. Shadow movement is gradual and natural.`,
                    '',
                    `${a.camera_position || 'Camera remains locked on tripod'}. No camera movement — only the sun and shadows move.`,
                    '',
                    `Preserve all ${a.preserve_elements || 'architectural details and structural elements'} exactly. Keep the exposure and colour grade identical from start to finish. Do not alter, regenerate, or distort any structural elements.`
                ].join('\n');
            }
        },
        construction: {
            label: 'Construction Timelapse',
            prompt: [
                'Analyze this image and return ONLY a JSON object:',
                '{',
                '  "starting_state": "empty starting state description",',
                '  "environment": "surrounding environment",',
                '  "structure_type": "type of structure",',
                '  "camera_type": "MOVING or STATIC",',
                '  "camera_detail": "camera movement or angle description",',
                '  "lighting": "lighting conditions",',
                '  "construction_phases": "comma-separated build phases",',
                '  "final_state": "completed structure description"',
                '}'
            ].join('\n'),
            subject(a) {
                return a.structure_type || a.environment || '';
            },
            fallback: 'No cuts. No transitions. No subtitles. No captions.\n\nThe entire scene is a continuous timelapse capturing the full construction from start to finish.\n\nThe camera remains locked on a tripod in a wide static shot.\n\nPreserve all structural and environmental details exactly.',
            fill(a) {
                const structure = a.structure_type || 'structure';
                const moving    = (a.camera_type || '').toUpperCase().includes('MOVING');
                const camBlock  = moving
                    ? `A steady ${a.camera_detail || 'forward tracking shot'} moves at a natural walking pace, maintaining one uninterrupted take from beginning to end.`
                    : `The camera remains locked on a tripod in a ${a.camera_detail || 'wide static shot'}, maintaining one uninterrupted frame from beginning to end.`;
                const camBehav  = moving
                    ? `the ${(a.camera_detail || 'forward tracking shot').split(' along')[0].toLowerCase()} remains smooth and continuous`
                    : 'the camera remains perfectly static';
                return [
                    'No cuts. No transitions. No subtitles. No captions.',
                    '',
                    'The entire scene is a continuous timelapse capturing the full construction from start to finish.',
                    '',
                    `The scene opens on ${a.starting_state || 'an empty foundation site'} surrounded by ${a.environment || 'a clean paved area'}.`,
                    '',
                    camBlock,
                    '',
                    'From the very first moment, the construction process unfolds entirely in timelapse. Workers in bright safety vests appear and move rapidly across the site, carrying lumber, tools, and materials. Their movements are accelerated, clearly indicating the passage of time.',
                    '',
                    `The ${structure} rises progressively in visible stages: ${a.construction_phases || 'foundation poured, framing assembled, exterior walls installed, roofing completed, windows fitted, architectural details added'}.`,
                    '',
                    'Scaffolding appears and disappears. Building materials accumulate and diminish.',
                    '',
                    `Lighting remains ${a.lighting || 'consistent with natural light'}, with subtle shifts in shadows and activity reinforcing the sense of time passing.`,
                    '',
                    `The timelapse continues uninterrupted until the structure is fully complete. The final frame reveals ${a.final_state || `the completed ${structure} standing finished`}. Workers quickly clear the site in timelapse, leaving the completed ${structure} standing still and finished.`,
                    '',
                    `Throughout, ${camBehav}, while all construction activity happens in clear, visible timelapse -- showing the entire transformation in one seamless shot.`
                ].join('\n');
            }
        }
    };

    // ── Anthropic API queue (serialises calls to avoid 529 overload) ──────────
    let _anthropicQueue = Promise.resolve();
    function queuedAnalyse(fn) {
        const result = _anthropicQueue.then(fn);
        _anthropicQueue = result.catch(() => {});
        return result;
    }

    // ── State ─────────────────────────────────────────────────────────────────
    const state = {
        step: 1,
        file: null,
        base64: null,
        width: 0,
        height: 0,
        aspectRatio: '16:9',
        template: null,
        analysis: null,
        prompt: '',
        jobId: null,
        videoUrl: null,
        importedPath: null,
        analysing: false,
        mode: null,
        duration: 12,
        startMediaId: null,
        endImageJobId: null,
        endMediaId: null,
        swapped: false,
        cameraType: null,
        cameraDetail: '',
        // O1 Edit
        o1InPoint: 0,
        o1OutPoint: 0,
        o1Duration: 0,
        o1SourceFile: null,
        o1ExportPath: null,
        o1VideoMediaId: null,
        o1Preset: null,
        o1TwilightMode: null,
        o1RefFrameBase64: null,
        o1RefImageUrl: null,
        o1RefMediaId: null,
        o1SubStep: 'preset',
    };

    // ── Token management ──────────────────────────────────────────────────────
    // Higgsfield's MCP/OAuth endpoints reject any request carrying an Origin
    // header ("403 Forbidden origin"). CEP's Chromium fetch() always attaches
    // Origin (a forbidden header we cannot strip), so all Higgsfield-host calls
    // go through Node's https client, which sends no Origin.
    function nodeRequest(method, urlStr, headers, bodyBuf) {
        return new Promise((resolve, reject) => {
            let u;
            try { u = new URL(urlStr); if(u.protocol !== 'https:' || u.username || u.password) throw new Error('Only HTTPS requests are allowed.'); } catch (e) { return reject(e); }
            const opts = { method: method, hostname: u.hostname, port: u.port || 443, path: u.pathname + (u.search || ''), headers: Object.assign({}, headers || {}) };
            if (bodyBuf && bodyBuf.length != null) opts.headers['Content-Length'] = bodyBuf.length;
            const req = https.request(opts, (res) => {
                const chunks = [];
                let size=0;res.on('data', (x) => {size+=x.length;if(size>8*1024*1024){req.destroy(new Error('Response too large.'));return;}chunks.push(x);});res.on('error',reject);
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
            });
            req.setTimeout(120000,()=>req.destroy(new Error('Request timed out.')));req.on('error', reject);
            if (bodyBuf) req.write(bodyBuf);
            req.end();
        });
    }

    function loadToken() { DmSecureStore.migrateLegacy();return DmSecureStore.get('higgsfield'); }
    function saveToken(data) {
        if(!data || typeof data.access_token!=='string') throw new Error('Invalid sign-in response.');
        if(!data.refresh_token){const old=loadToken();if(old&&old.refresh_token)data.refresh_token=old.refresh_token;}
        data.expires_at=Date.now()/1000+(Number(data.expires_in)||3600);
        DmSecureStore.set('higgsfield',data);
    }

    async function refreshToken(rt) {
        const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT_ID }).toString();
        const res = await nodeRequest('POST', `${OAUTH_BASE}/oauth2/token`, { 'Content-Type': 'application/x-www-form-urlencoded' }, Buffer.from(body, 'utf8'));
        if (res.status < 200 || res.status >= 300) return null;
        let data; try { data = JSON.parse(res.text); } catch (e) { return null; }
        saveToken(data);
        return data.access_token;
    }

    async function getToken() {
        const tok = loadToken();
        if (!tok) return null;
        if (Date.now() / 1000 < (tok.expires_at || 0) - 300) return tok.access_token;
        if (tok.refresh_token) return refreshToken(tok.refresh_token);
        return null;
    }

    function isAuthenticated() {
        const tok = loadToken();
        if (!tok) return false;
        if (Date.now() / 1000 < (tok.expires_at || 0) - 60) return true;
        return !!tok.refresh_token;
    }

    // ── OAuth PKCE flow ───────────────────────────────────────────────────────
    function doOAuth() {
        return new Promise((resolve, reject) => {
            const verifier   = cr.randomBytes(48).toString('base64url');
            const challenge  = cr.createHash('sha256').update(verifier).digest('base64url');
            const stateParam = cr.randomBytes(24).toString('base64url');

            const authUrl = `${OAUTH_BASE}/oauth2/authorize?` + new URLSearchParams({
                response_type: 'code',
                client_id: CLIENT_ID,
                code_challenge: challenge,
                code_challenge_method: 'S256',
                redirect_uri: REDIRECT_URI,
                state: stateParam,
                scope: 'openid email offline_access',
                prompt: 'consent',
                resource: `${OAUTH_BASE}/`,
            });

            let processing=false, settled=false;
            const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);server.close();if(err)reject(err);else resolve(value);};
            const server = http.createServer(async (req, res) => {
                const url  = new URL(req.url, 'http://localhost');
                if(req.method!=='GET'||url.pathname!=='/callback'||url.searchParams.get('state')!==stateParam||processing){res.writeHead(400);res.end('Invalid callback.');return;}
                const code = url.searchParams.get('code');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>Authorised -- return to DM Tools.</h2></body></html>');
                if (!code) {finish(new Error('Sign-in cancelled.'));return;}
                processing=true;
                try {
                    const form = new URLSearchParams({
                        grant_type: 'authorization_code',
                        code,
                        redirect_uri: REDIRECT_URI,
                        client_id: CLIENT_ID,
                        code_verifier: verifier,
                    }).toString();
                    const tr = await nodeRequest('POST', `${OAUTH_BASE}/oauth2/token`, { 'Content-Type': 'application/x-www-form-urlencoded' }, Buffer.from(form, 'utf8'));
                    const data = JSON.parse(tr.text);
                    if(tr.status!==200)throw new Error('Sign-in could not be verified.');
                    if(settled)return;saveToken(data);
                    finish(null,data.access_token);
                } catch (e) { finish(e); }
            });
            server.on('error',()=>finish(new Error('Local sign-in port unavailable.')));
            const timer=setTimeout(()=>finish(new Error('Auth timed out.')),120000);
            server.listen(54042,'127.0.0.1',()=>cp.execFile('/usr/bin/open',[authUrl],e=>{if(e)finish(new Error('Could not open sign-in.'));}));
        });
    }

    // ── MCP call ──────────────────────────────────────────────────────────────
    async function mcpCall(tool, args, _retried) {
        const token = await getToken();
        if (!token) throw new Error('Not authenticated with Higgsfield.');

        const bodyStr = JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now().toString(),
            method: 'tools/call',
            params: { name: tool, arguments: args },
        });
        const res = await nodeRequest('POST', MCP_URL, {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
        }, Buffer.from(bodyStr, 'utf8'));

        if (res.status < 200 || res.status >= 300) {
            // Stale/revoked token → 401/403 even though the token looks unexpired
            // locally. Force one refresh and retry once.
            if ((res.status === 401 || res.status === 403) && !_retried) {
                const tk = loadToken();
                const refreshed = (tk && tk.refresh_token) ? await refreshToken(tk.refresh_token) : null;
                if (refreshed) return mcpCall(tool, args, true);
                try { DmSecureStore.remove('higgsfield'); } catch (_) {}   // dead session → force the Connect button back
                try { updateAuthUI(); } catch (_) {}
                throw new Error('Higgsfield session expired — click Connect to sign in again (HTTP ' + res.status + ').');
            }
            throw new Error(`MCP HTTP ${res.status}`);
        }

        const ct = (res.headers['content-type'] || '');
        if (ct.includes('text/event-stream')) {
            let result = null;
            const lines = res.text.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const chunk = line.slice(6).trim();
                if (chunk === '[DONE]') break;
                try {
                    const p = JSON.parse(chunk);
                    if (p.result) result = p.result;
                    if (p.error) throw new Error(JSON.stringify(p.error));
                } catch (e) { if (e.message.includes('{')) throw e; }
            }
            return result || {};
        }

        let data; try { data = JSON.parse(res.text); } catch (e) { return {}; }
        if (data.error) throw new Error(JSON.stringify(data.error));
        return data.result || {};
    }

    function extractText(result) {
        const content = result && result.content;
        if (!content) return JSON.stringify(result);
        for (const item of content) { if (item.type === 'text') return item.text; }
        return '';
    }

    // ── Aspect ratio ──────────────────────────────────────────────────────────
    function detectRatio(w, h) {
        const r = w / h;
        if (r >= 1.2) return '16:9';
        if (r <= 0.8) return '9:16';
        return '1:1';
    }

    // ── Conversion LUT ────────────────────────────────────────────────────────
    function getLutsPath() {
        try { return cs.getSystemPath(SystemPath.EXTENSION) + '/assets/luts/conversion/'; }
        catch (_) { return ''; }
    }

    function parseCubeLut(text) {
        const lines = text.split('\n');
        let size = 0;
        const table = [];
        for (const line of lines) {
            const t = line.trim();
            if (!t || t.startsWith('#') || t.startsWith('TITLE') || t.startsWith('DOMAIN_')) continue;
            if (t.startsWith('LUT_3D_SIZE')) { size = parseInt(t.split(/\s+/)[1]); continue; }
            const parts = t.split(/\s+/);
            if (parts.length >= 3) {
                const r = parseFloat(parts[0]), g = parseFloat(parts[1]), b = parseFloat(parts[2]);
                if (!isNaN(r)) table.push([r, g, b]);
            }
        }
        return (size > 0 && table.length === size * size * size) ? { size, table } : null;
    }

    function applyLutToCanvas(canvas, lut) {
        const ctx = canvas.getContext('2d');
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d   = img.data;
        const { size, table } = lut;
        const max = size - 1;
        const sz2 = size * size;

        for (let i = 0; i < d.length; i += 4) {
            const ri = (d[i]     / 255) * max;
            const gi = (d[i + 1] / 255) * max;
            const bi = (d[i + 2] / 255) * max;

            const r0 = ri | 0, r1 = Math.min(r0 + 1, max);
            const g0 = gi | 0, g1 = Math.min(g0 + 1, max);
            const b0 = bi | 0, b1 = Math.min(b0 + 1, max);

            const rf = ri - r0, gf = gi - g0, bf = bi - b0;
            const nrf = 1 - rf, ngf = 1 - gf, nbf = 1 - bf;

            const c000 = table[r0 + g0*size + b0*sz2];
            const c100 = table[r1 + g0*size + b0*sz2];
            const c010 = table[r0 + g1*size + b0*sz2];
            const c110 = table[r1 + g1*size + b0*sz2];
            const c001 = table[r0 + g0*size + b1*sz2];
            const c101 = table[r1 + g0*size + b1*sz2];
            const c011 = table[r0 + g1*size + b1*sz2];
            const c111 = table[r1 + g1*size + b1*sz2];

            for (let ch = 0; ch < 3; ch++) {
                d[i+ch] = Math.round(Math.max(0, Math.min(1,
                    c000[ch]*nrf*ngf*nbf + c100[ch]*rf*ngf*nbf +
                    c010[ch]*nrf*gf*nbf  + c110[ch]*rf*gf*nbf  +
                    c001[ch]*nrf*ngf*bf  + c101[ch]*rf*ngf*bf  +
                    c011[ch]*nrf*gf*bf   + c111[ch]*rf*gf*bf
                )) * 255);
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    function applySelectedLut(canvas) {
        const _lutId  = state.mode === 'o1_edit' ? 'vgLutSelectO1' : 'vgLutSelect';
        const lutName = (document.getElementById(_lutId) || {}).value || '';
        if (!lutName) return;
        const lutsPath = getLutsPath();
        if (!lutsPath) return;
        try {
            const lut = parseCubeLut(fs.readFileSync(lutsPath + lutName + '.cube', 'utf8'));
            if (lut) applyLutToCanvas(canvas, lut);
        } catch (e) { console.warn('[VG] LUT apply failed:', e.message); }
    }

    // ── Image -> base64 JPEG ──────────────────────────────────────────────────
    function fileToBase64Jpeg(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const MAX = 1280;
                let { naturalWidth: w, naturalHeight: h } = img;
                if (w > MAX || h > MAX) {
                    if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                    else       { w = Math.round(w * MAX / h); h = MAX; }
                }
                state.width  = img.naturalWidth;
                state.height = img.naturalHeight;
                state.aspectRatio = detectRatio(state.width, state.height);
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
            };
            img.onerror = reject;
            img.src = URL.createObjectURL(file);
        });
    }

    // ── Claude vision analysis ────────────────────────────────────────────────
    function ollamaUp() {
        return new Promise(function (resolve) {
            try {
                var http = require('http');
                var req = http.get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 2000 }, function (res) {
                    var d = ''; res.on('data', function (x) { d += x; });
                    res.on('end', function () { resolve(d.indexOf('qwen3-vl') !== -1); });
                });
                req.on('error', function () { resolve(false); });
                req.on('timeout', function () { req.destroy(); resolve(false); });
            } catch (e) { resolve(false); }
        });
    }

    function analyseImageOllama(tmplKey) {
        return new Promise(function (resolve, reject) {
            var raw = String(state.base64 || '').replace(/^data:image\/[^;]+;base64,/, '');
            var body = JSON.stringify({
                model: 'qwen3-vl:4b-instruct',
                messages: [{ role: 'user', content: TEMPLATES[tmplKey].prompt, images: [raw] }],
                format: 'json', stream: false, options: { temperature: 0 }
            });
            var http = require('http');
            var req = http.request({ host: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function (res) {
                var d = ''; res.on('data', function (x) { d += x; });
                res.on('end', function () {
                    try { resolve(JSON.parse(JSON.parse(d).message.content)); }
                    catch (e) { reject(new Error('Ollama parse: ' + e.message)); }
                });
            });
            req.on('error', function (e) { reject(e); });
            req.setTimeout(120000, function () { req.destroy(); reject(new Error('Ollama timeout')); });
            req.write(body); req.end();
        });
    }

    async function analyseImage(tmplKey) {
        // Local vision first (unlimited, never rate-limited) — falls back to Gemini
        try {
            if (await ollamaUp()) {
                setStatus('Analysing image (local AI)...', 'busy');
                return await analyseImageOllama(tmplKey);
            }
        } catch (_eo) { /* fall through to Gemini */ }

        const apiKey = getStoredGeminiKey();
        if (!apiKey) throw new Error('Gemini API key is not configured in the secure store.');

        const body = JSON.stringify({
            contents: [{
                parts: [
                    { inline_data: { mime_type: 'image/jpeg', data: state.base64 } },
                    { text: TEMPLATES[tmplKey].prompt },
                ],
            }],
            generationConfig: { maxOutputTokens: 1024 },
        });

        const MAX_RETRIES = 6;
        const DELAYS = [0, 5000, 10000, 15000, 20000, 25000];
        let lastErr = '';

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const wait = DELAYS[attempt] + Math.floor(Math.random() * 3000);
                setStatus(`Overloaded — retrying in ${Math.round(wait / 1000)}s... (${attempt}/${MAX_RETRIES - 1})`, 'busy');
                await new Promise(r => setTimeout(r, wait));
            }

            let res;
            try {
                const _ac = new AbortController();
                const _to = setTimeout(function () { _ac.abort(); }, 30000);
                try {
                    res = await fetch(
                        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
                        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: _ac.signal }
                    );
                } finally { clearTimeout(_to); }
            } catch (netErr) {
                lastErr = netErr.message;
                continue;
            }

            if (res.status === 429 || res.status === 503) {
                const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
                if (retryAfter > 0) DELAYS[attempt + 1] = Math.max(DELAYS[attempt + 1] || 0, retryAfter * 1000);
                // Gemini puts the real wait in the BODY ("Please retry in 6.7s")
                try {
                    const eb = await res.text();
                    const m = eb.match(/retry in ([\d.]+)\s*s/i);
                    if (m) DELAYS[attempt + 1] = Math.max(DELAYS[attempt + 1] || 0, Math.ceil(parseFloat(m[1]) * 1000) + 2000);
                } catch (_) {}
                lastErr = 'rate limited (free tier: 20/min)';
                continue;
            }

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error((err.error && err.error.message) || `Gemini API ${res.status}`);
            }

            const data = await res.json();
            let text = ((data.candidates[0].content.parts[0].text) || '').trim();
            // Strip code fences
            text = text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
            // Try direct parse first
            try { return JSON.parse(text); } catch(_) {}
            // Extract first {...} block if there's surrounding text
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
            throw new Error('Could not parse Gemini response as JSON: ' + text.slice(0, 120));
        }
        throw new Error('Gemini API still overloaded after ' + MAX_RETRIES + ' retries — wait a moment and try again.');
    }

    // ── Higgsfield upload ─────────────────────────────────────────────────────
    async function uploadImage() {
        const uploadRes = await mcpCall('media_upload', {
            filename: state.file.name,
            content_type: 'image/jpeg',
        });
        const text = extractText(uploadRes);

        let uploadUrl, mediaId;
        try {
            const blob = JSON.parse(text);
            uploadUrl = blob.upload_url || blob.uploadUrl;
            mediaId   = blob.id || blob.media_id;
        } catch (_) {}

        if (!uploadUrl) {
            // Extract presigned URL
            const uMatch = text.match(/https:\/\/\S+/);
            if (uMatch) uploadUrl = uMatch[0].replace(/[.,'"]+$/, '');

            // Extract media UUID — try keyed match first, then any standalone UUID
            if (!mediaId) {
                const iMatch = text.match(/['"]?(?:media_id|id)['"]?\s*[=:]\s*['"]?([0-9a-f-]{32,})['"]?/i);
                if (iMatch) mediaId = iMatch[1];
            }
            if (!mediaId) {
                // Standalone UUID (e.g. "- 22bb44ff-4f75-46ff-902d-dc400442fc36:")
                const uuids = [...text.matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)];
                if (uuids.length > 0) mediaId = uuids[0][1];
            }

            if (!uploadUrl || !mediaId) throw new Error(`Cannot parse upload response:\n${text}`);
        }

        // PUT image bytes to presigned URL
        const ab  = Uint8Array.from(atob(state.base64), c => c.charCodeAt(0));
        await nodeRequest('PUT', uploadUrl, { 'Content-Type': 'image/jpeg' }, Buffer.from(ab));

        await mcpCall('media_confirm', { media_id: mediaId, type: 'image' });
        return mediaId;
    }

    // ── Higgsfield generate ───────────────────────────────────────────────────
    async function generateVideo(mediaId) {
        let medias;
        if (state.mode === 'o1_edit') {
            medias = [
                { value: state.o1VideoMediaId, role: 'video' },
                { value: state.o1RefMediaId,   role: 'image' },
            ];
            async function callVideoGen(declinedPresetId) {
                const isPresetDecline = !!declinedPresetId;
                const callArgs = { params: {
                    model: 'seedance_2_0',
                    prompt: state.prompt,
                    duration: Math.min(Math.max(Math.round(state.o1Duration), 4), 15),
                    resolution: '720p',
                    sound: 'off',
                    aspect_ratio: state.aspectRatio,
                    medias,
                }};
                if (isPresetDecline) callArgs.params.declined_preset_id = declinedPresetId;
                const r = await mcpCall('generate_video', callArgs);
                const t = extractText(r);
                const isPresetNotice = /Ask the user whether to use that preset/i.test(t)
                    || /To generate literally, retry with declined_preset_id/i.test(t);
                if (isPresetNotice && !isPresetDecline) {
                    const m = t.match(/preset[_ ]id["']?\s*[=:]\s*["']?([0-9a-f-]{32,})/i);
                    if (m) return callVideoGen(m[1]);
                    throw new Error('Preset intercept but no preset_id found: ' + t.slice(0, 200));
                }
                if (isPresetNotice && isPresetDecline) throw new Error('Still intercepted after decline. Response: ' + t.slice(0, 200));
                throw new Error('Video generation not supported via API for O1 Edit. Use Higgsfield website.');
            }
            return await callVideoGen(null);
        } else if (state.mode === 'start_end') {
            const capturedId  = state.startMediaId;
            const generatedId = state.endMediaId;
            medias = state.swapped
                ? [{ value: generatedId, role: 'start_image' }, { value: capturedId, role: 'end_image' }]
                : [{ value: capturedId,  role: 'start_image' }, { value: generatedId, role: 'end_image' }];
        } else {
            medias = [{ value: mediaId, role: 'start_image' }];
        }
        /* Marketplace preset intercept: for some prompts (e.g. "timelapse")
           generate_video answers with a preset suggestion INSTEAD of creating
           a job — and its preset_id used to be mistaken for a jobId (polled
           forever, no job on the site). Same decline-and-retry as O1 Edit. */
        async function callKling(declinedPresetId) {
            const callArgs = { params: {
                model: 'kling2_6',
                prompt: state.prompt,
                duration: (state.duration >= 8 ? 10 : 5),   // Kling 2.6 accepts only 5 or 10s
                sound: false,
                aspect_ratio: state.aspectRatio,
                medias,
            }};
            if (declinedPresetId) callArgs.params.declined_preset_id = declinedPresetId;
            const res = await mcpCall('generate_video', callArgs);

            // A REAL job always carries structuredContent.results[].id. If it is
            // missing, Higgsfield answered with a preset suggestion instead of
            // creating a job (common for prompts containing "timelapse") — never
            // poll that (there is no job on the site), decline once and retry.
            const results = res && res.structuredContent && res.structuredContent.results;
            if (results && results.length && (results[0].id || results[0].job_id || results[0].jobId)) {
                return results[0].id || results[0].job_id || results[0].jobId;
            }

            const text = extractText(res);
            let presetId = (res && res.structuredContent && res.structuredContent.preset_id) || null;
            if (!presetId) { const m = text.match(/preset[_ ]id["']?\s*[=:]\s*["']?([0-9a-f-]{32,})/i); if (m) presetId = m[1]; }
            if (!declinedPresetId && presetId) return callKling(presetId);
            throw new Error('Higgsfield returned a preset instead of a job — no video was created. Try again, or generate on the website. (' + text.slice(0, 140) + ')');
        }
        return await callKling(null);
    }

    // ── Poll job ──────────────────────────────────────────────────────────────
    function extractVideoUrl(text) {
        const clean = u => u.replace(/[.,'")\]>\s]+$/, '');
        // .mp4 direct link
        let m = text.match(/https:\/\/\S+\.mp4[^\s'",)\]>]*/i);
        if (m) return clean(m[0]);
        // .mov direct link
        m = text.match(/https:\/\/\S+\.mov[^\s'",)\]>]*/i);
        if (m) return clean(m[0]);
        // .webm direct link
        m = text.match(/https:\/\/\S+\.webm[^\s'",)\]>]*/i);
        if (m) return clean(m[0]);
        // CloudFront CDN (Higgsfield uses cloudfront.net for output)
        m = text.match(/https:\/\/[\w-]+\.cloudfront\.net\/\S+/i);
        if (m) return clean(m[0]);
        // Any higgsfield-branded URL
        m = text.match(/https:\/\/[\w.-]*higgsfield\S+/i);
        if (m) return clean(m[0]);
        // Generic CDN subdomain that looks like a video
        m = text.match(/https:\/\/(?:cdn|storage|output|media|render|assets|video|videos)\.\S+/i);
        if (m && /video|\.mp4|\.mov|\.webm/i.test(m[0])) return clean(m[0]);
        // Any https URL with a long path that looks like a generated file
        // (fallback — catches presigned S3/GCS/etc URLs)
        const allUrls = [...text.matchAll(/https:\/\/[^\s'"<>)]+/gi)];
        for (const u of allUrls) {
            const url = clean(u[0]);
            // Skip short URLs (likely auth/API endpoints), keep long paths
            if (url.length > 60 && /\/[0-9a-f-]{8,}/.test(url)) return url;
        }
        return null;
    }

    // Extract URL from raw job_status JSON payload
    function extractUrlFromRaw(raw) {
        if (!raw) return null;
        // raw may be a parsed object or a JSON string
        let obj = raw;
        if (typeof raw === 'string') {
            try { obj = JSON.parse(raw); } catch (_) { return null; }
        }
        // Walk the object tree looking for any string value that looks like a video URL
        function walk(node, depth) {
            if (depth > 6 || !node) return null;
            if (typeof node === 'string') {
                if (/https?:\/\/.+/.test(node) && node.length > 20) return node;
                return null;
            }
            if (Array.isArray(node)) {
                for (const v of node) { const r = walk(v, depth + 1); if (r) return r; }
            } else if (typeof node === 'object') {
                // Prefer known video URL keys
                for (const k of ['url', 'video_url', 'output_url', 'download_url', 'src', 'href', 'link']) {
                    if (node[k] && typeof node[k] === 'string' && /https?:\/\//.test(node[k])) return node[k];
                }
                for (const v of Object.values(node)) { const r = walk(v, depth + 1); if (r) return r; }
            }
            return null;
        }
        return walk(obj, 0);
    }

    /* Fallback for MCP job_status flakiness ("Something went wrong" for some
       video models even though the generation completes): list the account's
       recent generations and take the newest completed VIDEO created after
       this job was submitted. */
    async function findRecentVideoSince(sinceEpoch) {
        try {
            const r = await mcpCall('show_generations', { limit: 12 });
            const t = extractText(r);
            for (const ln of t.split('\n')) {
                const m = ln.match(/([0-9a-f-]{36}),video,(\w+),([\w-]+),"([^"]*)",([\d.]+)/i);
                if (!m) continue;
                if (parseFloat(m[5]) >= sinceEpoch - 90 && m[2] === 'completed' && m[4]) return m[4];
            }
        } catch (_) {}
        return null;
    }

    async function pollJob(jobId, onProgress) {
        const deadline = Date.now() + 600000;
        const submitEpoch = Date.now() / 1000;
        let attempt = 0;
        let wentWrong = 0;
        let notFound = 0;
        while (Date.now() < deadline) {
            let text = '';
            let rawUrl = null;

            // Strategy 1: job_status (plain text)
            try {
                const r = await mcpCall('job_status', { jobId: jobId });
                text = extractText(r);
                // Also check raw content items for image/video URLs
                if (r && r.content) {
                    for (const item of r.content) {
                        if (item.url) { rawUrl = item.url; break; }
                        if (item.type === 'image' && item.source?.url) { rawUrl = item.source.url; break; }
                    }
                }
            } catch (_) {}

            // Strategy 2: job_status with raw_data
            if (!text && !rawUrl) {
                try {
                    const r = await mcpCall('job_status', { jobId: jobId, raw_data: true });
                    const t = extractText(r);
                    rawUrl = rawUrl || extractUrlFromRaw(t) || extractUrlFromRaw(r);
                    text = text || t;
                } catch (_) {}
            }

            // Strategy 3: job_display
            if (!text && !rawUrl) {
                try {
                    const r = await mcpCall('job_display', { ids: [jobId] });
                    text = extractText(r);
                } catch (_) {}
            }

            console.log('[VG] poll attempt', attempt, '| rawUrl:', rawUrl, '| text:', text && text.slice(0, 200));

            if (rawUrl) return rawUrl;

            if (text) {
                const url = extractVideoUrl(text);
                if (url) return url;

                // No such job on the server → we were handed a bad id (e.g. a
                // preset id). Bail fast instead of polling to the 10-min timeout.
                if (/not found|no such job|invalid job|does not exist|unknown job/i.test(text)) {
                    notFound++;
                    if (notFound >= 3) throw new Error('Higgsfield has no such job — it was never created (preset intercept). Try again.');
                } else { notFound = 0; }

                // MCP flakiness: job_status errors while the job completes fine.
                // After 3 consecutive errors, look the result up in the account.
                if (/Something went wrong/i.test(text)) {
                    wentWrong++;
                    if (wentWrong >= 3) {
                        const u = await findRecentVideoSince(submitEpoch);
                        if (u) return u;
                    }
                } else { wentWrong = 0; }

                // Show live status in panel footer
                const firstLine = text.split('\n').find(l => l.trim()) || '';
                setStatus(firstLine.slice(0, 90) || 'Generating...', 'busy');

                // Treat as failed only if no in-progress keywords present
                if (/\b(?:failed|cancelled|canceled|error)\b/i.test(text) &&
                    !/generating|processing|queued|running|submitted|pending/i.test(text)) {
                    throw new Error(`Job failed:\n${text.slice(0, 400)}`);
                }
            }

            attempt++;
            const elapsed = attempt * 8;
            onProgress(Math.min(elapsed / 300, 0.95), `Generating... (${elapsed}s)`);
            await new Promise(r => setTimeout(r, 8000));
        }
        throw new Error('Job timed out after 10 minutes.');
    }

    // ── UI helpers ────────────────────────────────────────────────────────────
function setStatus(msg, dot) {
        const bar = document.getElementById('statusBar');
        const d   = document.getElementById('statusDot');
        const m   = document.getElementById('statusMsg');
        if (!bar) return;
        m.textContent = msg;
        d.className   = dot ? `status-dot status-dot--${dot}` : 'status-dot';
    }

    function showStep(n) {
        state.step = n;
        const isStartEnd = state.mode === 'start_end';
        const isO1       = state.mode === 'o1_edit';

        ['vgStep1', 'vgStep2', 'vgStep2End', 'vgStep3', 'vgStep1O1', 'vgStep2O1'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        if (isO1) {
            if (n === 1) { const el = document.getElementById('vgStep1O1'); if (el) el.style.display = 'flex'; }
            else if (n === 2) { const el = document.getElementById('vgStep2O1'); if (el) el.style.display = 'flex'; }
            else if (n === 3) {
                document.getElementById('vgStep3').style.display = 'flex';
                // Hide duration slider in O1 mode — duration is fixed to clip length
                const durRow = document.querySelector('.vg-duration-row');
                if (durRow) durRow.style.display = 'none';
            }
        } else if (n === 1) {
            document.getElementById('vgStep1').style.display = 'flex';
        } else if (n === 2) {
            const el = document.getElementById(isStartEnd ? 'vgStep2End' : 'vgStep2');
            if (el) el.style.display = 'flex';
        } else if (n === 3) {
            document.getElementById('vgStep3').style.display = 'flex';
            const durRow2 = document.querySelector('.vg-duration-row');
            if (durRow2) durRow2.style.display = '';
        }

        const back     = document.getElementById('vgActionBack');
        const next     = document.getElementById('vgActionNext');
        const generate = document.getElementById('vgActionGenerate');

        back.style.display     = n > 1 ? '' : 'none';
        next.style.display     = (n === 2 && !isO1) ? '' : 'none';
        generate.style.display = n === 3 ? '' : 'none';

        if (n === 2 && !isO1) {
            next.disabled = isStartEnd ? !state.endMediaId : (!state.template || state.analysing);
        }
        if (n === 3) generate.disabled = false;
    }

    // ── Video Jobs Panel ──────────────────────────────────────────────────────
    let _jobCounter = 0;

    function addVideoJob(label) {
        const id    = ++_jobCounter;
        const panel = document.getElementById('vgJobsPanel');
        const list  = document.getElementById('vgJobsList');
        panel.style.display = '';

        const card = document.createElement('div');
        card.className = 'vg-job-card';
        card.id = `vg-job-${id}`;
        card.innerHTML =
            `<div class="vg-job-top">` +
                `<span class="vg-job-label">${escapeHtml(label)}</span>` +
                `<span class="vg-job-status" id="vg-job-status-${id}">Starting...</span>` +
                `<button class="vg-job-dismiss" id="vg-job-dismiss-${id}" style="display:none" title="Dismiss">&#10005;</button>` +
            `</div>` +
            `<div class="vg-job-bar"><div class="vg-job-fill" id="vg-job-fill-${id}" style="width:0%"></div></div>`;
        list.appendChild(card);

        document.getElementById(`vg-job-dismiss-${id}`).addEventListener('click', () => {
            card.remove();
            if (!list.children.length) panel.style.display = 'none';
        });

        return id;
    }

    function updateVideoJob(id, percent, msg) {
        const fill   = document.getElementById(`vg-job-fill-${id}`);
        const status = document.getElementById(`vg-job-status-${id}`);
        if (fill)   fill.style.width     = percent + '%';
        if (status) status.textContent   = msg;
    }

    function finishVideoJob(id, success, msg, videoPath, snap) {
        const fill    = document.getElementById(`vg-job-fill-${id}`);
        const status  = document.getElementById(`vg-job-status-${id}`);
        const dismiss = document.getElementById(`vg-job-dismiss-${id}`);
        const card    = document.getElementById(`vg-job-${id}`);
        if (fill) {
            if (success) fill.style.width = '100%';
            fill.style.background = success ? 'var(--success)' : 'var(--error)';
        }
        if (status) {
            status.textContent = msg;
            status.className   = 'vg-job-status ' + (success ? 'vg-job-status--success' : 'vg-job-status--error');
        }
        if (dismiss) dismiss.style.display = '';
        if (card) {
            if (success && videoPath) {
                const vid = document.createElement('video');
                vid.src      = 'file://' + videoPath;
                vid.controls = true;
                vid.className = 'vg-job-preview';
                card.appendChild(vid);
            }
            const retryBtn = document.createElement('button');
            retryBtn.textContent = 'Retry';
            retryBtn.className   = 'btn vg-job-retry';
            retryBtn.style.cssText = 'margin-top:6px;width:100%';
            retryBtn.addEventListener('click', async () => {
                retryBtn.disabled    = true;
                retryBtn.textContent = 'Starting...';
                try { await runGenerate(snap); } catch(e) {}
                retryBtn.disabled    = false;
                retryBtn.textContent = 'Retry';
            });
            card.appendChild(retryBtn);
        }
    }

    function updateAuthUI() {
        const status  = document.getElementById('vgAuthStatus');
        const btn     = document.getElementById('vgAuthBtn');
        const hdrBtn  = document.getElementById('vgHfAuthBtn');
        const authed  = isAuthenticated();
        const disc    = document.getElementById('vgDisconnectBtn');
        if (authed) {
            status.textContent    = 'Higgsfield authenticated';
            status.className      = 'vg-auth-status ok';
            btn.style.display     = 'none';
            hdrBtn.style.display  = 'none';
            if (disc) disc.style.display = '';
        } else {
            status.textContent    = 'Higgsfield: not authenticated';
            status.className      = 'vg-auth-status err';
            btn.style.display     = '';
            hdrBtn.style.display  = '';
            if (disc) disc.style.display = 'none';
        }
        const o1Status = document.getElementById('vgO1AuthStatus');
        const o1Btn    = document.getElementById('vgO1AuthBtn');
        if (o1Status) { o1Status.textContent = authed ? 'Higgsfield authenticated' : 'Not authenticated'; o1Status.className = 'vg-auth-status ' + (authed ? 'ok' : 'err'); }
        if (o1Btn)    o1Btn.style.display = authed ? 'none' : '';
    }

    // ── Show / hide overlay ───────────────────────────────────────────────────
    function openOverlay() {
        document.getElementById('vgOverlay').classList.add('visible');
        showStep(1);
        updateAuthUI();
    }

    function closeOverlay() {
        document.getElementById('vgOverlay').classList.remove('visible');
        setStatus('Ready', null);
    }

    // ── Template selection + analyse ──────────────────────────────────────────
    async function selectTemplate(key) {
        state.template  = key;
        state.analysis  = null;
        state.prompt    = '';
        state.analysing = false;

        document.querySelectorAll('.vg-tmpl-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tmpl === key);
        });
        document.getElementById('vgActionNext').disabled = true;

        const statusEl = document.getElementById('vgAnalyseStatus');
        statusEl.style.display = 'flex';
        state.analysing = true;
        setStatus('Analysing image...', 'busy');

        try {
            state.analysis = await queuedAnalyse(() => analyseImage(key));
            state.prompt   = TEMPLATES[key].fill(state.analysis);
            statusEl.style.display = 'none';
            state.analysing = false;
            document.getElementById('vgActionNext').disabled = false;
            setStatus('Analysis complete', 'success');
        } catch (e) {
            statusEl.style.display = 'none';
            state.analysing = false;
            // Use a basic fallback prompt so user can still proceed and edit manually
            if (!state.prompt) state.prompt = TEMPLATES[key] ? TEMPLATES[key].fallback || '' : '';
            document.getElementById('vgActionNext').disabled = false;
            setStatus(`Analysis failed — edit prompt manually: ${e.message}`, 'error');
        }
    }

    // ── Download + import helpers ─────────────────────────────────────────────
    function getProjectDir() {
        return new Promise((resolve) => {
            if (!cs) { resolve(os.homedir() + '/Downloads'); return; }
            cs.evalScript(
                '(function(){ try { return new File(app.project.path).parent.fsName; } catch(e) { return ""; } }())',
                (r) => resolve((r || '').trim() || os.homedir() + '/Downloads')
            );
        });
    }

    function downloadFile(url, dest) {
        return new Promise((resolve, reject) => {
            const proto = url.startsWith('https') ? require('https') : require('http');
            const tmp   = dest + '.tmp';
            const file  = fs.createWriteStream(tmp);
            const req   = proto.get(url, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    file.close();
                    try { fs.unlinkSync(tmp); } catch (_) {}
                    downloadFile(res.headers.location, dest).then(resolve).catch(reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    file.close();
                    try { fs.unlinkSync(tmp); } catch (_) {}
                    reject(new Error(`Download HTTP ${res.statusCode}`));
                    return;
                }
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    try { fs.renameSync(tmp, dest); } catch (_) {}
                    resolve(dest);
                });
                file.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
            });
            req.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
        });
    }

    async function downloadAndImport(videoUrl) {
        setStatus('Downloading video...', 'busy');

        const ext      = (videoUrl.match(/\.(mp4|mov|webm)/i) || ['', 'mp4'])[1].toLowerCase();
        const filename = 'AI_Video_' + Date.now() + '.' + ext;
        const projDir  = await getProjectDir();
        const aiDir    = projDir + '/AI VIDEO';
        try { fs.mkdirSync(aiDir, { recursive: true }); } catch (_) {}
        const savePath = aiDir + '/' + filename;

        await downloadFile(videoUrl, savePath);
        state.importedPath = savePath;

        setStatus('Importing to Premiere...', 'busy');

        // Import into Premiere bin "AI VIDEO" and open Project panel
        const safeP = savePath.replace(/\\/g, '/').replace(/'/g, "\\'");
        const jsx = `(function(){
            ${window.DM_JSON_SHIM || ''}
            try {
                var binName = 'AI VIDEO', bin = null, root = app.project.rootItem;
                for (var i = 0; i < root.children.numItems; i++) {
                    if (root.children[i].name === binName) { bin = root.children[i]; break; }
                }
                if (!bin) bin = root.createBin(binName);
                app.project.importFiles(['${safeP}'], true, bin, false);
                app.executeCommand(3);
                return 'ok';
            } catch(e) { return 'err:' + e.message; }
        }())`;

        await new Promise((res) => cs.evalScript(jsx, res));
    }

    // ── Full generate flow ────────────────────────────────────────────────────
    async function runGenerate(snapshot) {
        if (snapshot) {
            /* Retry of a specific job: restore that job's inputs — the global
               state may already belong to a NEWER job the user set up since. */
            Object.assign(state, snapshot);
        } else {
            state.prompt = document.getElementById('vgPrompt').value;
        }
        const snap = {
            prompt: state.prompt, mode: state.mode, template: state.template,
            analysis: state.analysis, duration: state.duration, aspectRatio: state.aspectRatio,
            base64: state.base64, file: state.file,
            startMediaId: state.startMediaId, endMediaId: state.endMediaId, swapped: state.swapped,
            o1ExportPath: state.o1ExportPath, o1RefMediaId: state.o1RefMediaId,
            o1Duration: state.o1Duration, o1Preset: state.o1Preset
        };

        let jobLabel;
        if (state.mode === 'o1_edit') {
            const preset = state.o1Preset === 'twilight' ? 'Twilight' : state.o1Preset === 'weather' ? 'Clear Sky' : 'Add Cars';
            jobLabel = `O1 Edit — ${preset}`;
        } else if (state.mode === 'start_end') {
            const preview = (document.getElementById('vgEndPrompt').value || '').trim().slice(0, 22);
            jobLabel = preview ? `${preview}... — Start→End` : 'Start→End';
        } else {
            const tmpl = TEMPLATES[state.template];
            const tmplLabel = (tmpl && tmpl.label) || 'AI Video';
            let subject = '';
            if (tmpl && tmpl.subject && state.analysis) {
                try { subject = tmpl.subject(state.analysis) || ''; } catch (_) {}
            }
            if (subject) {
                subject = subject.replace(/^the\s+/i, '').replace(/[.,;:]+$/, '').trim();
                const words = subject.split(/\s+/).slice(0, 3);
                subject = words.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
            }
            jobLabel = subject ? `${subject} — ${tmplLabel}` : tmplLabel;
        }

        closeOverlay();
        const jobId = addVideoJob(jobLabel);

        try {
            let mediaId;
            if (state.mode === 'o1_edit') {
                updateVideoJob(jobId, 5, 'Uploading video...');
                setStatus('Uploading video...', 'busy');
                state.o1VideoMediaId = await uploadVideo(state.o1ExportPath);
                updateVideoJob(jobId, 20, 'Starting generation...');
            } else if (state.mode === 'start_end') {
                updateVideoJob(jobId, 15, 'Starting generation...');
            } else {
                updateVideoJob(jobId, 5, 'Uploading image...');
                setStatus('Uploading image...', 'busy');
                mediaId = await uploadImage();
                updateVideoJob(jobId, 25, 'Starting generation...');
            }
            setStatus(state.mode === 'o1_edit' ? 'Starting Seedance 2.0...' : 'Starting Kling 2.6...', 'busy');
            const genJobId = await generateVideo(mediaId);
            state.jobId = genJobId;

            updateVideoJob(jobId, 35, 'Generating video...');
            setStatus('Generating video...', 'busy');

            const videoUrl = await pollJob(genJobId, (p, msg) => {
                updateVideoJob(jobId, 35 + Math.round(p * 60), msg);
                setStatus(msg, 'busy');
            });

            state.videoUrl = videoUrl;
            await downloadAndImport(videoUrl);

            finishVideoJob(jobId, true, 'Done — in AI VIDEO bin', state.importedPath, snap);
            setStatus('Imported to AI VIDEO ✓', 'success');

        } catch (e) {
            finishVideoJob(jobId, false, 'Error: ' + e.message, null, snap);
            setStatus('Error: ' + e.message, 'error');
        }
    }

    // ── Load a frame file path into the Video Generator overlay ─────────────
    function loadFramePath(filePath, timecode, renderedSequence) {
        try {
            const buf = fs.readFileSync(filePath);
            const mime = /\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg';
            const blob = new Blob([buf], { type: mime });
            state.file = new File([blob], 'frame_' + Math.round(timecode) + 's' + (mime === 'image/png' ? '.png' : '.jpg'), { type: mime });

            document.getElementById('vgOverlay').classList.add('visible');
            updateAuthUI();

            const img = new Image();
            img.onload = function () {
                state.width       = img.naturalWidth;
                state.height      = img.naturalHeight;
                state.aspectRatio = detectRatio(state.width, state.height);

                const MAX = 1280;
                let w = state.width, h = state.height;
                if (w > MAX || h > MAX) {
                    if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                    else       { w = Math.round(w * MAX / h); h = MAX; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                if (!renderedSequence) applySelectedLut(canvas);
                state.base64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];

                const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
                document.getElementById('vgPreviewImg').src     = dataUrl;
                document.getElementById('vgPreviewMeta').textContent =
                    state.width + ' x ' + state.height + '  --  ' + state.aspectRatio;
                document.getElementById('vgMeta').textContent   = state.aspectRatio;

                if (state.mode === 'start_end') {
                    document.getElementById('vgSeStartPreview').src = dataUrl;
                    document.getElementById('vgSeStartMeta').textContent =
                        state.width + ' x ' + state.height + '  --  ' + state.aspectRatio;
                    state.startMediaId  = null;
                    state.endImageJobId = null;
                    state.endMediaId    = null;
                    state.swapped       = false;
                    state.cameraType    = null;
                    state.cameraDetail  = '';
                    state.prompt        = '';
                    document.getElementById('vgEndPrompt').value         = '';
                    document.querySelectorAll('.vg-preset-btn').forEach(function (b) { b.classList.remove('active'); });
                    document.getElementById('vgEndPreviewWrap').style.display  = 'none';
                    document.getElementById('vgEndFrameStatus').style.display  = 'none';
                    document.getElementById('vgActionNext').disabled = true;
                    showStep(2);
                    setStatus('Frame captured — describe the end frame', 'success');
                } else {
                    state.template = null; state.analysis = null; state.prompt = '';
                    document.querySelectorAll('.vg-tmpl-btn').forEach(b => b.classList.remove('active'));
                    document.getElementById('vgAnalyseStatus').style.display = 'none';
                    document.getElementById('vgActionNext').disabled = true;
                    showStep(2);
                    setStatus('Frame captured -- choose a template', 'success');
                }
            };
            img.onerror = function () { setStatus('Captured file is not a readable image: ' + filePath.split('/').pop(), 'error'); };
            img.src = URL.createObjectURL(new Blob([buf], { type: mime }));
        } catch (e) {
            setStatus('Failed to read frame: ' + e.message, 'error');
        }
    }

    // ── Capture current frame from Premiere timeline ──────────────────────────
    function captureFrame() {
        if (!cs) { setStatus('CSInterface not available.', 'error'); return; }
        const btn = document.getElementById('vgCaptureBtn');
        const label = btn.textContent;
        btn.textContent = 'Capturing...'; btn.disabled = true;
        setStatus('Capturing sequence frame...', 'busy');
        // Export the rendered sequence, never substitute the original source clip.
        // QE expects a timecode string and an output filename without extension.
        const jsx = `
            (function () {
                ${window.DM_JSON_SHIM || ''}
                try {
                    var seq = app.project.activeSequence;
                    if (!seq) return JSON.stringify({error:'No active sequence.'});
                    var pos = seq.getPlayerPosition();
                    app.enableQE();
                    var qseq = qe.project.getActiveSequence();
                    if (!qseq) return JSON.stringify({error:'Activate the sequence in the Program Monitor and try again.'});
                    var base = Folder.temp.fsName + '/dm_sequence_frame_' + (new Date()).getTime();
                    qseq.exportFramePNG(qseq.CTI.timecode, base);
                    return JSON.stringify({path:base + '.png', timecode:pos.seconds});
                } catch(e) { return JSON.stringify({error:'Sequence frame export failed: ' + e}); }
            }());
        `;
        function done() { btn.textContent = label; btn.disabled = false; }
        cs.evalScript(jsx, function (result) {
            let data;
            try { data = JSON.parse(result); }
            catch(e) { done(); setStatus('Invalid response from Premiere.', 'error'); return; }
            if (!data || data.error || !data.path) {
                done(); setStatus(data && data.error || 'No sequence frame returned.', 'error'); return;
            }
            // Premiere can finish writing after evalScript returns.
            const deadline = Date.now() + 15000;
            let lastSize = -1;
            (function waitForFrame() {
                try {
                    const size = fs.statSync(data.path).size;
                    if (size > 0 && size === lastSize) {
                        done(); loadFramePath(data.path, data.timecode, true); return;
                    }
                    lastSize = size;
                } catch(e) {}
                if (Date.now() >= deadline) {
                    done();
                    setStatus('Premiere did not export the sequence frame. Use Export Frame in the Program Monitor and load that image here.', 'error');
                    return;
                }
                setTimeout(waitForFrame, 250);
            })();
        });
    }

    // ── Capture from Source Monitor ───────────────────────────────────────────
    function captureFromSource() {
        if (!cs) { setStatus('CSInterface not available.', 'error'); return; }

        const btn = document.getElementById('vgCaptureSrcBtn');
        btn.textContent = 'Capturing...';
        btn.disabled    = true;
        setStatus('Capturing from source monitor...', 'busy');

        const markerPath = '/tmp/dm_vg_marker_src';
        try { fs.closeSync(fs.openSync(markerPath, 'w', 0o600)); } catch (_) {}

        const jsx = `
            (function() {
                ${window.DM_JSON_SHIM || ''}
                try {
                    app.enableQE();

                    var p    = Folder.temp.fsName + '/dm_vg_frame_src_' + Date.now() + '.jpg';
                    var tc   = 0;
                    var errs = [];
                    var dbg  = [];

                    var pad = function(n) { return (n < 10 ? '0' : '') + n; };
                    function secsToTc(secs, fps) {
                        var f  = Math.round(secs * fps);
                        var hh = Math.floor(f / (fps * 3600)); f -= hh * fps * 3600;
                        var mm = Math.floor(f / (fps * 60));   f -= mm * fps * 60;
                        var ss = Math.floor(f / fps);
                        var ff = f - ss * fps;
                        return pad(hh)+':'+pad(mm)+':'+pad(ss)+':'+pad(ff);
                    }

                    var fps = 25;
                    try {
                        var seq = app.project.activeSequence;
                        if (seq) fps = Math.round(1 / parseFloat(seq.timebase)) || 25;
                    } catch(e) {}

                    // ── 1. qe.source: try CTI and getPlayerPosition ───────
                    if (typeof qe !== 'undefined' && qe &&
                        typeof qe.source !== 'undefined' && qe.source) {

                        var qeSrc = qe.source;

                        try {
                            var cti = qeSrc.CTI;
                            if (cti && typeof cti.seconds !== 'undefined') {
                                tc = cti.seconds; dbg.push('CTI.s=' + tc);
                            }
                        } catch(e) { dbg.push('CTI.ERR=' + e.message.slice(0,40)); }

                        if (!tc) {
                            try {
                                var pos = qeSrc.getPlayerPosition();
                                if (pos && typeof pos.seconds !== 'undefined') {
                                    tc = pos.seconds; dbg.push('qSrc.gPP=' + tc);
                                }
                            } catch(e) { dbg.push('qSrc.gPP.ERR=' + e.message.slice(0,40)); }
                        }

                        try {
                            qeSrc.exportFrameJPEG(secsToTc(tc, fps), p);
                            $.sleep(1500);
                            if (new File(p).exists)          return JSON.stringify({ path: p,         timecode: tc });
                            if (new File(p+'.jpg').exists)   return JSON.stringify({ path: p+'.jpg',  timecode: tc });
                            if (new File(p+'.jpeg').exists)  return JSON.stringify({ path: p+'.jpeg', timecode: tc });
                            return JSON.stringify({ qeExported: true, timecode: tc, debug: dbg.join('|') });
                        } catch(e) { errs.push('qe.source.exportFrameJPEG: ' + e.message); }

                    } else { dbg.push('qe.source=undef'); }

                    // ── 2. app.sourceMonitor property probe ───────────────
                    try {
                        var sm   = app.sourceMonitor;
                        var clip = typeof sm.getSourceClip === 'function' ? sm.getSourceClip() : null;
                        dbg.push('getSourceClip=' + (clip ? 'ok' : 'null'));

                        if (clip) {
                            // in-point as proxy for current frame
                            try {
                                var ip = typeof clip.getInPoint === 'function' ? clip.getInPoint() : null;
                                if (ip && typeof ip.seconds !== 'undefined' && ip.seconds > 0) {
                                    tc = ip.seconds; dbg.push('inPt=' + tc);
                                }
                            } catch(e) { dbg.push('inPt.ERR='+e.message.slice(0,30)); }
                        }

                        // Enumerate sm keys for diagnosis
                        var smk = [];
                        for (var k in sm) { try { smk.push(k+':'+typeof sm[k]); } catch(e) {} }
                        dbg.push('sm=[' + smk.slice(0, 12).join(',') + ']');

                    } catch(e) { dbg.push('sm.ERR='+e.message.slice(0,40)); }

                    return JSON.stringify({
                        error: 'Source capture failed: ' + errs.join(' | '),
                        debug: dbg.join(' | ')
                    });

                } catch(e) {
                    return JSON.stringify({ error: e.message });
                }
            }())
        `;

        cs.evalScript(jsx, function (result) {
            btn.textContent = 'From Source';
            btn.disabled    = false;

            let data;
            try { data = JSON.parse(result); }
            catch (_) { setStatus('Invalid response from Premiere.', 'error'); return; }

            // Log debug info to console so we can inspect what APIs are available
            if (data.debug) console.log('[VG source]', data.debug);

            if (data.error) { setStatus(data.error, 'error'); return; }

            if (data.path) { loadFramePath(data.path, data.timecode); return; }

            if (data.qeExported) {
                try {
                    const found = ''; // Do not scan the user's home directory for unrelated images.
                    if (found) {
                        loadFramePath(found, data.timecode);
                    } else {
                        setStatus('Frame exported but file not found. Check ~/Desktop.', 'error');
                    }
                } catch (e) {
                    setStatus('find error: ' + e.message, 'error');
                }
                return;
            }

            setStatus('Unexpected response from Premiere.', 'error');
        });
    }

    // ── Start→End helpers ────────────────────────────────────────────────────
    function imageUrlToBase64(url) {
        if (url.startsWith('data:')) return Promise.resolve(url.split(',')[1]);
        return new Promise((resolve, reject) => {
            const proto = url.startsWith('https') ? require('https') : require('http');
            const chunks = [];
            const req = proto.get(url, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    imageUrlToBase64(res.headers.location).then(resolve).catch(reject);
                    return;
                }
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                res.on('data', c => chunks.push(c));
                res.on('end',  () => resolve(Buffer.concat(chunks).toString('base64')));
                res.on('error', reject);
            });
            req.setTimeout(120000,()=>req.destroy(new Error('Request timed out.')));req.on('error', reject);
        });
    }

    async function analyseStartEndFrames(startBase64, endBase64) {
        const apiKey = getStoredGeminiKey();
        if (!apiKey) return null;
        const body = JSON.stringify({
            contents: [{
                parts: [
                    { inline_data: { mime_type: 'image/jpeg', data: startBase64 } },
                    { inline_data: { mime_type: 'image/jpeg', data: endBase64 } },
                    { text: 'These are the start frame and end frame of a video clip. Compare the two images and determine the implied camera movement to get from the first to the second.\nReturn ONLY a JSON object:\n{\n  "camera_movement": "static | push_in | push_out | pan_left | pan_right | tilt_up | tilt_down | drone | handheld",\n  "camera_detail": "brief natural description e.g. \'slow push toward the kitchen counter\'"\n}' },
                ],
            }],
            generationConfig: { maxOutputTokens: 256 },
        });
        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
            );
            if (!res.ok) return null;
            const data = await res.json();
            let text = ((data.candidates[0].content.parts[0].text) || '').trim()
                .replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
            return JSON.parse(text);
        } catch (_) { return null; }
    }

    function buildStartEndPrompt(cameraMovement, cameraDetail) {
        const camDesc = cameraDetail
            ? cameraDetail.charAt(0).toUpperCase() + cameraDetail.slice(1).replace(/\.?\s*$/, '.')
            : (CAMERA_MOVEMENTS[cameraMovement] || CAMERA_MOVEMENTS.static);
        return [
            camDesc,
            '',
            'The scene transitions smoothly and continuously from the start frame to the end frame.',
            'No cuts. The change unfolds gradually and naturally over the full duration.',
            'Every element morphs or transforms seamlessly between the two states.',
            'Preserve all structural geometry and proportions throughout.',
        ].join('\n');
    }

    // ── Swap start/end frames ─────────────────────────────────────────────────
    function swapFrames() {
        state.swapped = !state.swapped;

        const startImg = document.getElementById('vgSeStart');
        const endImg   = document.getElementById('vgSeEnd');
        const tmpSrc   = startImg.src;
        startImg.src   = endImg.src;
        endImg.src     = tmpSrc;

        document.getElementById('vgSwapFramesBtn').classList.toggle('active', state.swapped);

        if (state.cameraType) {
            state.cameraType   = CAMERA_SWAP[state.cameraType] || state.cameraType;
            state.cameraDetail = '';
        }

        if (state.step === 3 && state.mode === 'start_end') {
            state.prompt = buildStartEndPrompt(state.cameraType || 'static', state.cameraDetail);
            document.getElementById('vgPrompt').value = state.prompt;
            const camSel = document.getElementById('vgCameraSelect');
            if (camSel) camSel.value = state.cameraType || 'static';
        }
    }

    // ── Mode toggle (Timelapse / Start→End) ───────────────────────────────────
    function selectMode(mode) {
        state.mode = mode;
        document.getElementById('vgModeTimelapse').classList.toggle('active', mode === 'timelapse');
        const _seBtn = document.getElementById('vgModeStartEnd');
        if (_seBtn) _seBtn.classList.toggle('active', mode === 'start_end');
        const _o1Btn = document.getElementById('vgModeO1Edit');
        if (_o1Btn) _o1Btn.classList.toggle('active', mode === 'o1_edit');
        openOverlay();
    }

    // ── Poll image job ────────────────────────────────────────────────────────
    async function pollImageJob(jobId) {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            try {
                const r = await mcpCall('job_status', { jobId });
                const text = extractText(r);

                if (r && r.content) {
                    for (const item of r.content) {
                        if (item.url) return item.url;
                        if (item.type === 'image' && item.source) {
                            if (item.source.url) return item.source.url;
                            if (item.source.data) return `data:${item.source.media_type || 'image/jpeg'};base64,${item.source.data}`;
                        }
                    }
                }

                if (text) {
                    const imgM = text.match(/https:\/\/\S+\.(?:jpg|jpeg|png|webp)[^\s'"<>)]*/i);
                    if (imgM) return imgM[0].replace(/[.,'")\]>\s]+$/, '');

                    const rawUrl = extractUrlFromRaw(text);
                    if (rawUrl) return rawUrl;

                    const url = extractVideoUrl(text);
                    if (url) return url;

                    if (/\b(?:failed|cancelled|canceled|error)\b/i.test(text) &&
                        !/generating|processing|queued|running|submitted|pending/i.test(text)) {
                        throw new Error('Image generation failed: ' + text.slice(0, 200));
                    }
                }
            } catch (e) {
                if (e.message.includes('failed')) throw e;
            }
            await new Promise(r => setTimeout(r, 3000));
        }
        throw new Error('Image generation timed out.');
    }

    // ── Generate end frame image ──────────────────────────────────────────────
    async function generateEndImage() {
        const prompt = (document.getElementById('vgEndPrompt').value || '').trim();
        if (!prompt) { setStatus('Enter a prompt for the end frame.', 'error'); return; }

        const genBtn   = document.getElementById('vgGenerateEndBtn');
        const regenBtn = document.getElementById('vgRegenerateEndBtn');
        const statusEl = document.getElementById('vgEndFrameStatus');

        genBtn.disabled  = true;
        if (regenBtn) regenBtn.disabled = true;
        statusEl.style.display = 'flex';
        document.getElementById('vgEndPreviewWrap').style.display = 'none';
        document.getElementById('vgActionNext').disabled = true;
        setStatus('Generating end frame...', 'busy');
        state.endImageJobId = null;
        state.endMediaId    = null;
        state.swapped       = false;
        const swapBtn = document.getElementById('vgSwapFramesBtn');
        if (swapBtn) swapBtn.classList.remove('active');

        try {
            // Upload start frame once — reused as reference here and in generateVideo
            if (!state.startMediaId) {
                setStatus('Uploading start frame...', 'busy');
                state.startMediaId = await uploadImage();
            }

            setStatus('Generating end frame...', 'busy');
            const res  = await mcpCall('generate_image', {
                params: {
                    model: 'nano_banana_2',
                    prompt,
                    aspect_ratio: state.aspectRatio,
                    medias: [{ value: state.startMediaId, role: 'image' }],
                },
            });
            const text = extractText(res);
            console.log('[VG] generate_image response:', text && text.slice(0, 400));

            let jobId;
            try { const b = JSON.parse(text); jobId = b.job_id || b.id || b.jobId; } catch (_) {}
            if (!jobId) {
                const m = (text || '').match(/['"]?(?:job_id|jobId|id)['"]?\s*[=:]\s*['"]?([0-9a-f-]{32,})['"]?/i);
                if (m) jobId = m[1];
            }
            if (!jobId) {
                const uuids = [...(text || '').matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)];
                if (uuids.length > 0) jobId = uuids[0][1];
            }
            if (!jobId) throw new Error('Cannot parse image job ID:\n' + (text || '').slice(0, 200));

            setStatus('Waiting for end frame...', 'busy');
            const imageUrl = await pollImageJob(jobId);

            state.endImageJobId = jobId;
            state.endMediaId    = jobId;
            state.cameraType    = null;
            state.cameraDetail  = '';

            document.getElementById('vgSeStart').src = document.getElementById('vgPreviewImg').src;
            document.getElementById('vgSeEnd').src   = imageUrl;
            document.getElementById('vgEndPreviewWrap').style.display = '';
            statusEl.style.display = 'none';
            document.getElementById('vgActionNext').disabled = false;
            setStatus('End frame ready', 'success');

            // Analyse both frames in background to detect camera movement
            imageUrlToBase64(imageUrl).then(endBase64 => analyseStartEndFrames(state.base64, endBase64)).then(result => {
                if (!result) return;
                state.cameraType   = result.camera_movement || 'static';
                state.cameraDetail = result.camera_detail   || '';
                console.log('[VG] camera detected:', state.cameraType, state.cameraDetail);
                // If user already reached Step 3, update the select + prompt live
                if (state.step === 3 && state.mode === 'start_end') {
                    const camSel = document.getElementById('vgCameraSelect');
                    if (camSel) camSel.value = state.cameraType;
                    state.prompt = buildStartEndPrompt(state.cameraType, state.cameraDetail);
                    document.getElementById('vgPrompt').value = state.prompt;
                }
            }).catch(() => {});

        } catch (e) {
            statusEl.style.display = 'none';
            setStatus('End frame failed: ' + e.message, 'error');
            console.error('[VG] generateEndImage error:', e);
        }

        genBtn.disabled = false;
        if (regenBtn) regenBtn.disabled = false;
    }


    // ══════════════════════════════════════════════════════════════════════════
    // O1 EDIT — Video export, reference image generation, pipeline
    // ══════════════════════════════════════════════════════════════════════════

    // Get sequence in/out points + source clip path via JSX
    function getClipInfo() {
        return new Promise((resolve, reject) => {
            if (!cs) { reject(new Error('CSInterface not available')); return; }
            const jsx = `(function(){
                if(typeof JSON==="undefined"){var __sj=function(v){var i,s,t;if(v===null||v===undefined)return "null";t=typeof v;if(t==="number")return isFinite(v)?String(v):"null";if(t==="boolean")return String(v);if(t==="string")return '"'+v.replace(/\\\\/g,"\\\\\\\\").replace(/"/g,'\\\\"').replace(/[\\n]/g,"\\\\n").replace(/[\\r]/g,"\\\\r").replace(/[\\t]/g,"\\\\t")+'"';if(v instanceof Array){s=[];for(i=0;i<v.length;i++)s.push(__sj(v[i]));return "["+s.join(",")+"]";}if(t==="object"){s=[];for(i in v)if(v.hasOwnProperty(i))s.push(__sj(i)+":"+__sj(v[i]));return "{"+s.join(",")+"}";}return "null";};JSON={stringify:__sj,parse:function(s){return eval("("+s+")");}};}
                var seq = app.project.activeSequence;
                if (!seq) return JSON.stringify({error:'No active sequence'});
                function toSec(t) {
                    if (t === null || t === undefined) return 0;
                    if (typeof t === 'object' && t !== null && typeof t.seconds === 'number') return t.seconds;
                    if (typeof t === 'object' && t !== null && t.ticks !== undefined) return parseInt(t.ticks) / 254016000000;
                    var s = String(t);
                    var n = parseFloat(s);
                    if (!isNaN(n) && !/[;:]/.test(s)) return n;
                    var fps = 25;
                    try { fps = Math.round(1 / parseFloat(seq.timebase)) || 25; } catch(_e) {}
                    var p = s.replace(/;/g, ':').split(':');
                    if (p.length >= 3) return parseInt(p[0])*3600 + parseInt(p[1])*60 + parseFloat(p[2]) + (p[3] ? parseInt(p[3])/fps : 0);
                    return 0;
                }
                var inRaw = null, outRaw = null;
                try { inRaw  = seq.getInPoint();  } catch(e) {}
                try { outRaw = seq.getOutPoint(); } catch(e) {}
                var inSec  = toSec(inRaw);
                var outSec = toSec(outRaw);
                if (!outSec || outSec <= inSec) {
                    return JSON.stringify({error:'Set in/out points on the timeline first. [raw in=' + JSON.stringify(String(inRaw)) + ' out=' + JSON.stringify(String(outRaw)) + ']'});
                }
                var sourcePath = '', fileSeekTime = inSec, clipSpeedOut = 1, interpFpsOut = 0;
                function S(t){try{if(t==null)return -1;if(typeof t.seconds==="number"&&!isNaN(t.seconds))return t.seconds;if(t.ticks!=null)return parseFloat(t.ticks)/254016000000;var p=parseFloat(t);return isNaN(p)?-1:p;}catch(e){return -1;}}function qeSeqFor(sq){try{app.enableQE();var n=qe.project.numSequences;for(var i=0;i<n;i++){var q=qe.project.getSequenceAt(i);if(q&&q.name===sq.name)return q;}}catch(e){}return null;}function spdAt(sq,t,cs){var spd=1;try{var qs=qeSeqFor(sq);if(!qs)return 1;var qt=qs.getVideoTrackAt(t);for(var i=0;i<qt.numItems;i++){var qc=qt.getItemAt(i);if(!qc||qc.type==="Empty")continue;var st=(qc.start&&!isNaN(qc.start.seconds))?qc.start.seconds:(qc.start?parseFloat(qc.start.ticks)/254016000000:NaN);if(!isNaN(st)&&Math.abs(st-cs)<0.02){var sp=Math.abs(qc.speed);if(sp>0)spd=sp;break;}}}catch(e){}return spd;}function subSeqOf(pi){var nid="";try{nid=pi.nodeId;}catch(e){}var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){try{if(nid&&ss[i].projectItem.nodeId===nid)return ss[i];}catch(e){}}var nm="";try{nm=pi.name;}catch(e){}if(nm){for(var j=0;j<ss.numSequences;j++){if(ss[j].name===nm)return ss[j];}}return null;}function resolve(sq,T,cum,depth){if(depth>6)return null;for(var t=sq.videoTracks.numTracks-1;t>=0;t--){var tr=sq.videoTracks[t];for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];var cs=S(cl.start),ce=S(cl.end);if(!(cs<=T&&ce>T))continue;var pi=cl.projectItem;var ms=0;try{ms=S(cl.inPoint);if(ms<0)ms=0;}catch(e){}var sp=spdAt(sq,t,cs);var inner=(ms+(T-cs))*sp;var mp="";try{mp=pi.getMediaPath();}catch(e){}if(mp){return {src:mp,seek:inner,spd:cum*sp,pi:pi};}var sub=subSeqOf(pi);if(sub){var r=resolve(sub,inner,cum*sp,depth+1);if(r)return r;}}}return null;}
                var __r = resolve(seq, inSec, 1, 0);
                if (__r) {
                    sourcePath   = __r.src;
                    fileSeekTime = __r.seek;
                    clipSpeedOut = __r.spd;
                    try { var interp = __r.pi.getFootageInterpretation(); if (interp && interp.frameRate > 0) interpFpsOut = interp.frameRate; } catch(e) {}
                }
                var fw = 0, fh = 0;
                try { fw = seq.frameSizeHorizontal; fh = seq.frameSizeVertical; } catch(e) {}
                var ratio = (fw && fh) ? (fw / fh) : 1;
                var ar = ratio >= 1.2 ? '16:9' : (ratio <= 0.8 ? '9:16' : '1:1');
                var projPath = '';
                try { projPath = app.project.path || ''; } catch(e) {}
                return JSON.stringify({
                    sourcePath: sourcePath,
                    inPoint: inSec,
                    outPoint: outSec,
                    duration: outSec - inSec,
                    fileSeekTime: fileSeekTime,
                    clipSpeed: clipSpeedOut,
                    interpretedFps: interpFpsOut,
                    aspectRatio: ar,
                    frameW: fw,
                    frameH: fh,
                    projectPath: projPath
                });
            }())`;
            cs.evalScript(jsx, (r) => {
                try {
                    const data = JSON.parse(r || '{}');
                    if (data._debug2) { reject(new Error('DEBUG: ' + JSON.stringify(data))); return; }
                    if (data.error) reject(new Error(data.error));
                    else resolve(data);
                } catch(e) { reject(new Error('Failed to read sequence info')); }
            });
        });
    }

    // Extract frame at in point via JSX (returns base64 JPEG)
    function captureFrameAtInPoint(inPoint, sourcePath) {
        return new Promise((resolve, reject) => {
            if (!sourcePath) { reject(new Error('No source path — cannot extract frame')); return; }
            const outPath = os.tmpdir() + '/dm_o1_frame_' + Date.now() + '.jpg';
            const tryPaths = ((window.DM_BUNDLED_FFMPEG && window.DM_BUNDLED_FFMPEG()) ? [window.DM_BUNDLED_FFMPEG()] : []).concat(['/Applications/Wavdrop.app/Contents/Resources/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/Users/desiremedia/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg', 'ffmpeg', '/usr/bin/ffmpeg']);
            const errors = [];
            let tried = 0;
            function tryNext() {
                if (tried >= tryPaths.length) {
                    reject(new Error('FFmpeg capture failed. seek=' + parseFloat(inPoint).toFixed(3) + 's src=' + sourcePath + ' errors: ' + errors.join(' | ')));
                    return;
                }
                const ff = tryPaths[tried++];
                if (!fs.existsSync(ff) && ff !== 'ffmpeg') { tryNext(); return; }
                const args = ['-y', '-ignore_editlist', '1', '-ss', parseFloat(inPoint).toFixed(3), '-i', sourcePath,
                    '-vframes', '1', '-q:v', '2', '-pix_fmt', 'yuvj420p', outPath];
                cp.execFile(ff, args, { timeout: 20000 }, (err, stdout, stderr) => {
                    if (fs.existsSync(outPath)) {
                        const canvas = document.createElement('canvas');
                        const img = new Image();
                        img.onload = () => {
                            canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0);
                            applySelectedLut(canvas);
                            resolve(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
                        };
                        img.onerror = () => reject(new Error('Failed to load captured frame'));
                        img.src = 'file://' + outPath;
                    } else {
                        errors.push(require('path').basename(ff) + ':' + (err ? err.message.slice(0,60) : 'no output') + '|' + (stderr || '').slice(-80));
                        tryNext();
                    }
                });
            }
            tryNext();
        });
    }

    // Export clip segment via FFmpeg (trim + scale to 1080p)
    function getExportDir(projectPath, clipName) {
        try {
            const nodePath = require('path');
            if (!projectPath) return os.tmpdir();
            const premiereDir = nodePath.dirname(projectPath);
            const projectRoot = nodePath.dirname(premiereDir);
            const assetsDir   = nodePath.join(projectRoot, 'Assets');
            const now = new Date();
            const stamp = now.getFullYear() + '' +
                String(now.getMonth()+1).padStart(2,'0') +
                String(now.getDate()).padStart(2,'0') + '_' +
                String(now.getHours()).padStart(2,'0') +
                String(now.getMinutes()).padStart(2,'0');
            const base = clipName ? clipName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30) : 'clip';
            const jobDir = nodePath.join(assetsDir, 'O1_' + base + '_' + stamp);
            if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
            return jobDir;
        } catch(e) { return os.tmpdir(); }
    }

    function exportClipPremiere(exportDir) {
        return new Promise((resolve, reject) => {
            const outPath = require('path').join(exportDir, 'dm_o1_export_' + Date.now() + '.mp4');
            const presetPath = '/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets/3F3F3F3F_4D6F6F56/H264 Match Source - High bitrate.epr';
            const jsx = `(function(){
                ${window.DM_JSON_SHIM || ''}
                try {
                    var seq = app.project.activeSequence;
                    if (!seq) return JSON.stringify({error: 'No active sequence'});
                    app.encoder.launchEncoder();
                    var job = app.encoder.encodeSequence(seq, ${JSON.stringify(outPath)}, ${JSON.stringify(presetPath)}, 0, 1);
                    return JSON.stringify({ok: true, path: ${JSON.stringify(outPath)}});
                } catch(e) { return JSON.stringify({error: e.message}); }
            }())`;
            cs.evalScript(jsx, (r) => {
                try {
                    const d = JSON.parse(r || '{}');
                    if (d.error) { reject(new Error(d.error)); return; }
                    // Poll until the file exists and is stable
                    const start = Date.now();
                    let lastSize = -1, stableCount = 0;
                    const poll = setInterval(() => {
                        if (Date.now() - start > 300000) { clearInterval(poll); reject(new Error('Export timed out after 5 minutes')); return; }
                        try {
                            if (fs.existsSync(outPath)) {
                                const size = fs.statSync(outPath).size;
                                if (size > 10000 && size === lastSize) {
                                    stableCount++;
                                    if (stableCount >= 3) { clearInterval(poll); resolve(outPath); }
                                } else { lastSize = size; stableCount = 0; }
                            }
                        } catch(_e) {}
                    }, 2000);
                } catch(e) { reject(new Error('Export failed: ' + e.message)); }
            });
        });
    }

    function getNativeFps(sourcePath) {
        return new Promise((resolve) => {
            const tryPaths = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/Users/desiremedia/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffprobe', 'ffprobe'];
            const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'default=noprint_wrappers=1', sourcePath];
            let i = 0;
            function tryNext() {
                if (i >= tryPaths.length) { resolve(0); return; }
                cp.execFile(tryPaths[i++], args, { timeout: 10000 }, (err, stdout) => {
                    if (!err && stdout) {
                        const m = stdout.match(/r_frame_rate=(\d+)\/(\d+)/);
                        if (m) { resolve(parseInt(m[1]) / parseInt(m[2])); return; }
                    }
                    tryNext();
                });
            }
            tryNext();
        });
    }

    function exportClipFFmpeg(sourcePath, inPoint, duration, lutCubePath, exportDir, clipSpeed, frameW, frameH) {
        return new Promise((resolve, reject) => {
            const dir = exportDir || os.tmpdir();
            const outPath = require('path').join(dir, 'dm_o1_export_' + Date.now() + '.mp4');
            const speed = (clipSpeed && clipSpeed > 0) ? clipSpeed : 1;
            // Source duration to read: timeline duration × speed (e.g. 5s at 50% = 2.5s source)
            const srcDuration = duration * speed;
            // Copy LUT to /tmp to avoid spaces in path breaking FFmpeg filtergraph
            let lutArg = '';
            if (lutCubePath) {
                try {
                    const tmpLut = os.tmpdir() + '/dm_o1_lut.cube';
                    fs.writeFileSync(tmpLut, fs.readFileSync(lutCubePath));
                    lutArg = tmpLut;
                } catch(_e) { lutArg = ''; }
            }
            // setpts stretches/compresses playback to match timeline speed
            const setPts = speed !== 1 ? (',setpts=' + (1 / speed).toFixed(6) + '*(PTS-STARTPTS)') : '';
            // Always export at 1080-class (Higgsfield doesn't run 4K), matching the
            // sequence orientation so a portrait timeline exports portrait (no black bars).
            let tW = 1920, tH = 1080;
            if (frameW && frameH) {
                const r = frameW / frameH;
                if (r <= 0.65)      { tW = 1080; tH = 1920; }   // portrait 9:16
                else if (r < 0.95)  { tW = 1080; tH = 1350; }   // portrait 4:5
                else if (r <= 1.05) { tW = 1080; tH = 1080; }   // square
                else if (r < 1.5)   { tW = 1440; tH = 1080; }   // 4:3
                else                { tW = 1920; tH = 1080; }   // 16:9
            }
            const vfFilter = 'scale=' + tW + ':' + tH + ':force_original_aspect_ratio=decrease,pad=' + tW + ':' + tH + ':-1:-1:color=black' +
                (lutArg ? ',lut3d=' + lutArg : '') + setPts;
            // -ss before -i for fast seek; -t as OUTPUT option using timeline duration
            // setpts handles the speed stretch so output naturally fills the timeline duration
            const args = [
                '-y', '-ss', inPoint.toFixed(3), '-i', sourcePath,
                '-t', duration.toFixed(3),
                '-vf', vfFilter,
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart',
                outPath
            ];
            const tryPaths = ((window.DM_BUNDLED_FFMPEG && window.DM_BUNDLED_FFMPEG()) ? [window.DM_BUNDLED_FFMPEG()] : []).concat(['/Applications/Wavdrop.app/Contents/Resources/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/Users/desiremedia/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg', 'ffmpeg', '/usr/bin/ffmpeg']);
            const exportErrors = [];
            let tried = 0;
            function tryNext() {
                if (tried >= tryPaths.length) {
                    reject(new Error('FFmpeg failed on all paths. seek=' + inPoint.toFixed(3) + 's dur=' + duration.toFixed(3) + 's spd=' + speed.toFixed(2) + ' errors: ' + exportErrors.join(' | ')));
                    return;
                }
                const ffPath = tryPaths[tried++];
                if (!fs.existsSync(ffPath) && ffPath !== 'ffmpeg') { exportErrors.push(ffPath + ':not found'); tryNext(); return; }
                cp.execFile(ffPath, args, { timeout: 300000 }, (err, stdout, stderr) => {
                    if (err) {
                        exportErrors.push(require('path').basename(ffPath) + ':' + err.message.slice(0,80));
                        tryNext();
                    } else if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
                        resolve(outPath);
                    } else {
                        exportErrors.push(require('path').basename(ffPath) + ':empty output|' + (stderr || '').slice(-120));
                        tryNext();
                    }
                });
            }
            tryNext();
        });
    }

    // Upload a video file to Higgsfield
    async function uploadVideo(videoPath) {
        const uploadRes = await mcpCall('media_upload', {
            filename: 'clip_export.mp4',
            content_type: 'video/mp4',
        });
        const text = extractText(uploadRes);
        let uploadUrl, mediaId;
        try { const blob = JSON.parse(text); uploadUrl = blob.upload_url || blob.uploadUrl; mediaId = blob.id || blob.media_id; } catch (_) {}
        if (!uploadUrl) {
            const uMatch = text.match(/https:\/\/\S+/); if (uMatch) uploadUrl = uMatch[0].replace(/[.,'"]+$/, '');
            if (!mediaId) { const iMatch = text.match(/['"]?(?:media_id|id)['"]?\s*[=:]\s*['"]?([0-9a-f-]{32,})['"]?/i); if (iMatch) mediaId = iMatch[1]; }
            if (!mediaId) { const uuids = [...text.matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)]; if (uuids.length) mediaId = uuids[0][1]; }
            if (!uploadUrl || !mediaId) throw new Error(`Cannot parse upload response:\n${text}`);
        }
        const videoBytes = fs.readFileSync(videoPath);
        await nodeRequest('PUT', uploadUrl, { 'Content-Type': 'video/mp4' }, Buffer.from(videoBytes));
        await mcpCall('media_confirm', { media_id: mediaId, type: 'video' });
        return mediaId;
    }

    // Upload a base64 image and return its Higgsfield mediaId
    async function uploadBase64Image(base64) {
        const uploadRes = await mcpCall('media_upload', { filename: 'ref_frame.jpg', content_type: 'image/jpeg' });
        const text = extractText(uploadRes);
        let uploadUrl, mediaId;
        try { const blob = JSON.parse(text); uploadUrl = blob.upload_url || blob.uploadUrl; mediaId = blob.id || blob.media_id; } catch (_) {}
        if (!uploadUrl) {
            const uMatch = text.match(/https:\/\/\S+/); if (uMatch) uploadUrl = uMatch[0].replace(/[.,'"]+$/, '');
            if (!mediaId) { const iMatch = text.match(/['"]?(?:media_id|id)['"]?\s*[=:]\s*['"]?([0-9a-f-]{32,})['"]?/i); if (iMatch) mediaId = iMatch[1]; }
            if (!mediaId) { const uuids = [...text.matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)]; if (uuids.length) mediaId = uuids[0][1]; }
        }
        const ab = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        await nodeRequest('PUT', uploadUrl, { 'Content-Type': 'image/jpeg' }, Buffer.from(ab));
        await mcpCall('media_confirm', { media_id: mediaId, type: 'image' });
        return mediaId;
    }

    // Generate reference image via Nano Banana 2
    async function generateRefImage(prompt, base64Frame, aspectRatio) {
        const frameMediaId = await uploadBase64Image(base64Frame);
        async function callGenerate(declinedPresetId) {
            const callArgs = {
                params: {
                    model: 'nano_banana_2',
                    prompt,
                    aspect_ratio: aspectRatio || '16:9',
                    resolution: '1k',
                    medias: [{ value: frameMediaId, role: 'image' }],
                }
            };
            if (declinedPresetId) callArgs.params.declined_preset_id = declinedPresetId;
            const res = await mcpCall('generate_image', callArgs);
            const text = extractText(res);
            const isImgPresetNotice = /Ask the user whether to use that preset/i.test(text)
                || /To generate literally, retry with declined_preset_id/i.test(text);
            if (isImgPresetNotice && !declinedPresetId) {
                const pm = text.match(/preset[_ ]id["']?\s*[=:]\s*["']?([0-9a-f-]{32,})/i);
                if (pm) return callGenerate(pm[1]);
            }
            if (isImgPresetNotice && declinedPresetId) throw new Error('Still intercepted after decline (image): ' + text.slice(0, 150));
            let jobId;
            try { const blob = JSON.parse(text); jobId = blob.job_id || blob.id || blob.jobId; } catch(_) {}
            if (!jobId) { const m = text.match(/['"]?(?:job_id|jobId|id)['"]?\s*[=:]\s*['"]?([0-9a-f-]{32,})['"]?/i); if (m) jobId = m[1]; }
            if (!jobId) { const uuids = [...text.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)]; if (uuids.length) jobId = uuids[0][1]; }
            if (!jobId) throw new Error('Cannot parse image job ID from: ' + text.slice(0, 120));
            return await pollImageJob(jobId);
        }
        return callGenerate({});
    }

    // O1 EDIT UI HELPERS ──────────────────────────────────────────────────────

    function o1SetSubStep(sub) {
        state.o1SubStep = sub;
        ['vgO1PresetSelect','vgO1WeatherOpts','vgO1TwilightOpts','vgO1CarsOpts','vgO1ApproveWrap','vgO1ReadyWrap'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        if (sub === 'preset')   { const el = document.getElementById('vgO1PresetSelect'); if (el) el.style.display = ''; }
        if (sub === 'twilight') { const el = document.getElementById('vgO1TwilightOpts'); if (el) el.style.display = ''; }
        if (sub === 'cars')     { const el = document.getElementById('vgO1CarsOpts');     if (el) el.style.display = ''; }
        if (sub === 'weather')  { const el = document.getElementById('vgO1WeatherOpts');  if (el) el.style.display = ''; }
        if (sub === 'approve')  { const el = document.getElementById('vgO1ApproveWrap');  if (el) el.style.display = ''; }
    }

    function o1OpenLightbox(url) {
        if (!url) return;
        let ov = document.getElementById('vgO1Lightbox');
        if (!ov) {
            ov = document.createElement('div');
            ov.id = 'vgO1Lightbox';
            ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:16px';
            const big = document.createElement('img');
            big.id = 'vgO1LightboxImg';
            big.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 8px 40px rgba(0,0,0,0.6);border-radius:6px';
            ov.appendChild(big);
            ov.addEventListener('click', () => { ov.style.display = 'none'; });
            document.body.appendChild(ov);
        }
        document.getElementById('vgO1LightboxImg').src = url;
        ov.style.display = 'flex';
    }

    function o1ShowRefImage(url) {
        const img = document.getElementById('vgO1RefPreview');
        if (img) {
            img.src = url;
            img.style.cursor = 'zoom-in';
            img.title = 'Click to enlarge';
            img.onclick = () => o1OpenLightbox(img.src);
        }
        o1SetSubStep('approve');
    }

    // Handle O1 twilight or cars reference generation
    // Loading overlay over the reference preview
    function o1SetRefLoading(on) {
        const wrap = document.querySelector('#vgO1ApproveWrap .vg-preview-wrap');
        if (!wrap) return;
        let ov = document.getElementById('vgO1RefLoading');
        if (on) {
            if (!ov) {
                ov = document.createElement('div');
                ov.id = 'vgO1RefLoading';
                ov.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;border-radius:6px;z-index:5';
                ov.innerHTML = '<span style="display:inline-block"><span style="display:inline-block;animation:vgspin 1s linear infinite">\u25dc</span> Generating\u2026</span>';
                if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
                if (!document.getElementById('vgSpinKf')) {
                    const st = document.createElement('style'); st.id = 'vgSpinKf';
                    st.textContent = '@keyframes vgspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
                    document.head.appendChild(st);
                }
                wrap.appendChild(ov);
            }
            ov.style.display = 'flex';
        } else if (ov) { ov.style.display = 'none'; }
    }

    // Merge the user's own words into the base prompt (Gemini refine, like Timelapse)
    async function o1RefinePrompt(basePrompt, userWords) {
        userWords = (userWords || '').trim();
        if (!userWords) return basePrompt;
        try {
            const apiKey = (typeof getStoredGeminiKey === 'function' ? getStoredGeminiKey() : (loadConfig().gemini_key || ''));
            if (!apiKey) return basePrompt + ', ' + userWords;
            const body = JSON.stringify({
                contents: [{ parts: [{ text:
                    'You are refining a short image-edit prompt for a real-estate photo.\n' +
                    'BASE PROMPT: "' + basePrompt + '"\n' +
                    'USER TWEAKS (their own words): "' + userWords + '"\n' +
                    'Rewrite into ONE clean, concise image-edit prompt that keeps the base intent and folds in the user tweaks. ' +
                    'Keep camera angle/composition unchanged. Return ONLY the prompt text, no quotes, no explanation.' }] }],
                generationConfig: { maxOutputTokens: 200, temperature: 0.4 }
            });
            const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + apiKey,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
            if (!res.ok) return basePrompt + ', ' + userWords;
            const data = await res.json();
            let t = ((data.candidates && data.candidates[0].content.parts[0].text) || '').trim().replace(/^["'`]+|["'`]+$/g, '');
            return t || (basePrompt + ', ' + userWords);
        } catch (_) { return basePrompt + ', ' + userWords; }
    }

    var O1_BASE_PROMPTS = {
        weather:  'make this property photo look like a bright clear sunny day, same camera angle and composition',
        twilight: 'make this property photo look like twilight time, house lights on, warm light from windows, deep blue sky',
        cars:     'A luxury car in the driveway, rear of the car facing the camera'
    };
    function o1PromptFieldId(preset) {
        return preset === 'weather' ? 'vgO1WeatherPrompt' : (preset === 'twilight' ? 'vgO1TwilightPrompt' : 'vgO1CarsPrompt');
    }
    // Prefill the visible prompt field with the base prompt (only if empty / on entering preset)
    function o1PrefillPrompt(preset, force) {
        const el = document.getElementById(o1PromptFieldId(preset));
        if (el && (force || !el.value.trim())) el.value = O1_BASE_PROMPTS[preset] || '';
    }

    // Detect where the driveway sits in the original frame so the car is placed there
    async function o1DetectDriveway(frameB64) {
        try {
            const apiKey = (typeof getStoredGeminiKey === 'function' ? getStoredGeminiKey() : (loadConfig().gemini_key || ''));
            if (!apiKey || !frameB64) return null;
            const raw = String(frameB64).replace(/^data:image\/[^;]+;base64,/, '');
            const body = JSON.stringify({
                contents: [{ parts: [
                    { inline_data: { mime_type: 'image/jpeg', data: raw } },
                    { text: 'This is a real-estate property photo. Where is the driveway (or the paved area/path where a car would sit) relative to the frame? ' +
                            'Return ONLY JSON: {"pos":"left|centre|right|none"}. Use "none" if there is no driveway visible.' }
                ] }],
                generationConfig: { maxOutputTokens: 40, temperature: 0 }
            });
            const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + apiKey,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
            if (!res.ok) return null;
            const data = await res.json();
            let t = ((data.candidates && data.candidates[0].content.parts[0].text) || '').trim().replace(/^```(?:json)?/, '').replace(/```$/, '');
            const pos = (JSON.parse(t).pos || '').toLowerCase();
            return ['left', 'centre', 'center', 'right'].indexOf(pos) !== -1 ? pos.replace('center', 'centre') : null;
        } catch (_) { return null; }
    }

    // Build the cars prompt with the detected driveway side, updating the visible field
    async function o1PrefillCarsWithDriveway() {
        const field = document.getElementById('vgO1CarsPrompt');
        if (!field) return;
        const st = document.getElementById('vgO1CarsStatus');
        if (st) { st.style.display = ''; st.innerHTML = '<span class="vg-spin">&#9696;</span> Analysing driveway...'; }
        const pos = await o1DetectDriveway(state.o1RefFrameBase64);
        if (st) st.style.display = 'none';
        const where = (pos && pos !== 'none') ? (' on the ' + pos + ' side of the frame') : '';
        field.value = 'A luxury car in the driveway' + where + ', rear of the car facing the camera';
    }

    async function o1GenerateRef(preset, customPrompt) {
        const statusEl = document.getElementById(preset === 'twilight' ? 'vgO1TwilightStatus' : (preset === 'weather' ? 'vgO1WeatherStatus' : 'vgO1CarsStatus'));
        if (statusEl) statusEl.style.display = '';
        o1SetRefLoading(true);
        setStatus('Generating reference image...', 'busy');
        try {
            const fieldEl = document.getElementById(o1PromptFieldId(preset));
            const prompt = (fieldEl && fieldEl.value.trim()) || O1_BASE_PROMPTS[preset];
            const url = await generateRefImage(prompt, state.o1RefFrameBase64, state.aspectRatio);
            state.o1RefImageUrl = url;
            if (statusEl) statusEl.style.display = 'none';
            o1SetRefLoading(false);
            setStatus('Reference image ready', 'success');
            o1ShowRefImage(url);
        } catch(e) {
            if (statusEl) statusEl.style.display = 'none';
            o1SetRefLoading(false);
            setStatus('Reference failed: ' + e.message, 'error');
        }
    }

    // Approve reference image: upload it and advance to prompt step
    async function o1ApproveRef() {
        setStatus('Uploading reference...', 'busy');
        const approveBtn = document.getElementById('vgO1Approve');
        if (approveBtn) approveBtn.disabled = true;
        try {
            let refImageB64 = '';
            if (state.o1TwilightMode === 'night_ref') {
                refImageB64 = state.o1RefFrameBase64.replace(/^data:image\/[^;]+;base64,/, '');
            } else {
                const resp = await fetch(state.o1RefImageUrl);
                if (!resp.ok) throw new Error('Fetch image failed: ' + resp.status);
                const ab    = await resp.arrayBuffer();
                const bytes = new Uint8Array(ab);
                let b64str = '';
                for (let i = 0; i < bytes.length; i += 8192) {
                    b64str += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                }
                refImageB64 = btoa(b64str);
            }
            // Upload to Higgsfield in the BACKGROUND (only needed for in-plugin generation).
            // The manual drag-to-Higgsfield flow doesn't wait on it.
            state.o1RefMediaId = null;
            (async () => {
                try { state.o1RefMediaId = await uploadBase64Image(state.o1TwilightMode === 'night_ref' ? state.o1RefFrameBase64 : refImageB64); } catch(_eu) {}
            })();
            const _refDir = state.o1ExportDir || getExportDir(state.o1ProjectPath || '');
            const refPath = require('path').join(_refDir, 'dm_o1_ref_' + Date.now() + '.jpg');
            fs.writeFileSync(refPath, Buffer.from(refImageB64, 'base64'));
            state.o1RefFramePath = refPath;

            // Show ready panel
            const folderPathEl = document.getElementById('vgO1ReadyFolderPath');
            const readyWrap    = document.getElementById('vgO1ReadyWrap');
            const appWrap      = document.getElementById('vgO1ApproveWrap');
            const preset = state.o1Preset;
            const WEATHER_VIDEO_PROMPT  = 'make @video1 looks like it is a bright clear sunny day using @image1 as reference';
            const TWILIGHT_VIDEO_PROMPT = 'make @video1 looks like it twilight time using @image1 as reference';
            const CARS_VIDEO_PROMPT     = 'add a luxury car to @video1 using @image1 as reference, car driving through the driveway, rear of the car facing the camera';
            const readyPrompt = preset === 'weather' ? WEATHER_VIDEO_PROMPT : preset === 'twilight' ? TWILIGHT_VIDEO_PROMPT : CARS_VIDEO_PROMPT;
            const promptEl = document.getElementById('vgO1ReadyPrompt');
            if (promptEl) promptEl.value = readyPrompt;
            if (folderPathEl) folderPathEl.textContent = _refDir;
            if (appWrap)      appWrap.style.display    = 'none';
            if (readyWrap)    readyWrap.style.display  = '';
            // Auto: copy prompt, reveal exported clip in Finder, open Higgsfield
            let _copied = false;
            try {
                const _cp = require('child_process');
                const _child = _cp.spawn('pbcopy'); _child.stdin.write(readyPrompt || ''); _child.stdin.end();
                _copied = true;
            } catch(_ec) {}
            try {
                const _cp2 = require('child_process');
                if (state.o1ExportPath) { _cp2.execFile('/usr/bin/open', ['-R', state.o1ExportPath]); }
                else if (_refDir) { _cp2.execFile('/usr/bin/open', [_refDir]); }
            } catch(_er) {}
            try { window.cep.util.openURLInDefaultBrowser('https://higgsfield.ai/ai/video/edit'); }
            catch(_eb) { try { require('child_process').execFile('/usr/bin/open', ['https://higgsfield.ai/ai/video/edit']); } catch(_eb2) {} }
            setStatus(_copied ? 'Ready ✓ Prompt copied + Higgsfield opened — paste (Cmd+V) & drag clip/image' : 'Ready — upload to Higgsfield', 'success');
        } catch(e) {
            setStatus('Approve failed: ' + e.message, 'error');
            const errEl = document.getElementById('vgO1Error');
            if (errEl) { errEl.textContent = 'Approve: ' + e.message; errEl.style.display = ''; }
        } finally {
            if (approveBtn) approveBtn.disabled = false;
        }
    }

    // Wire all O1 Edit buttons
    function wireO1Buttons() {
        const lutSelO1 = document.getElementById('vgLutSelectO1');
        if (lutSelO1) {
            const savedO1 = localStorage.getItem('vg_lut_o1');
            if (savedO1) lutSelO1.value = savedO1;
            lutSelO1.addEventListener('change', () => localStorage.setItem('vg_lut_o1', lutSelO1.value));
        }
        // Step 1: Read In/Out
        const exportBtn = document.getElementById('vgO1ReadBtn');
        if (exportBtn) exportBtn.addEventListener('click', async () => {
            exportBtn.disabled = true;
            exportBtn.textContent = 'Reading...';
            setStatus('Reading timeline...', 'busy');
            try {
                const info = await getClipInfo();
                state.o1InPoint    = info.inPoint;
                state.o1OutPoint   = info.outPoint;
                state.o1Duration   = info.duration;
                state.o1SourceFile = info.sourcePath;
                state.aspectRatio  = info.aspectRatio;

                // Capture frame at in point for reference generation
                state.o1RefFrameBase64 = await captureFrameAtInPoint(info.fileSeekTime != null ? info.fileSeekTime : info.inPoint, info.sourcePath);

                const durEl  = document.getElementById('vgO1Duration');
                const srcEl  = document.getElementById('vgO1Source');
                const infoEl = document.getElementById('vgO1ClipInfo');
                if (durEl) durEl.textContent = info.duration.toFixed(1) + 's';
                if (srcEl) { const parts = info.sourcePath.split('/'); srcEl.textContent = parts[parts.length-1] || info.sourcePath; }
                if (infoEl) infoEl.style.display = '';

                // Export the clip via FFmpeg (no Media Encoder)
                if (!info.duration || info.duration < 3) {
                    exportBtn.textContent = 'Read In/Out Points';
                    exportBtn.disabled = false;
                    const _m = 'Clip is ' + (info.duration ? info.duration.toFixed(1) : '0') + 's — Higgsfield needs at least 3s. Set a longer in/out range.';
                    setStatus(_m, 'error');
                    const _e = document.getElementById('vgO1Error');
                    if (_e) { _e.textContent = _m; _e.style.display = ''; }
                    return;
                }
                exportBtn.textContent = 'Exporting...';
                setStatus('Exporting clip... speed=' + (info.clipSpeed||1).toFixed(2) + ' dur=' + info.duration.toFixed(2) + 's', 'busy');
                state.o1ProjectPath = info.projectPath || '';
                const _clipName = info.sourcePath ? require('path').basename(info.sourcePath) : '';
                const _exportDir = getExportDir(state.o1ProjectPath, _clipName);
                state.o1ExportDir = _exportDir;
                const _lutName = (document.getElementById('vgLutSelectO1') || {}).value || '';
                const _lutPath = _lutName ? (getLutsPath() + _lutName + '.cube') : null;
                const _seekTime = info.fileSeekTime != null ? info.fileSeekTime : info.inPoint;
                setStatus('Exporting... seek=' + _seekTime.toFixed(2) + 's dur=' + info.duration.toFixed(2) + 's', 'busy');
                state.o1ExportPath = await exportClipFFmpeg(info.sourcePath, _seekTime, info.duration, _lutPath, _exportDir, (info.clipSpeed && info.clipSpeed > 0) ? info.clipSpeed : 1, info.frameW, info.frameH);

                setStatus('Clip ready — choose an effect and generate the reference', 'success');
                const errEl2 = document.getElementById('vgO1Error');
                if (errEl2) errEl2.style.display = 'none';
                exportBtn.textContent = 'Re-export';
                exportBtn.disabled = false;
                // Advance to step 2 (preset + ref image generation)
                state.o1SubStep = 'preset';
                showStep(2);
                o1SetSubStep('preset');
            } catch(e) {
                exportBtn.textContent = 'Read In/Out Points';
                exportBtn.disabled = false;
                setStatus('Error: ' + e.message, 'error');
                const errEl = document.getElementById('vgO1Error');
                if (errEl) { errEl.textContent = e.message; errEl.style.display = ''; }
            }
        });

        // O1 action buttons — Open Higgsfield + Reveal in Finder
        // Ready panel buttons (step 2)
        function copyToClipboard(text) {
            try {
                const cp = require('child_process');
                const child = cp.spawn('pbcopy');
                child.stdin.write(text || '');
                child.stdin.end();
                return true;
            } catch(_e) { return false; }
        }
        const readyOpenBtn = document.getElementById('vgO1ReadyOpen');
        if (readyOpenBtn) readyOpenBtn.addEventListener('click', () => {
            const promptEl = document.getElementById('vgO1ReadyPrompt');
            const copied = promptEl ? copyToClipboard(promptEl.value) : false;
            try { window.cep.util.openURLInDefaultBrowser('https://higgsfield.ai/ai/video/edit'); } catch(_e) {
                try { const cp = require('child_process'); cp.execFile('/usr/bin/open', ['https://higgsfield.ai/ai/video/edit']); } catch(_e2) {}
            }
            if (copied) setStatus('Prompt copied to clipboard — paste (Cmd+V) in Higgsfield', 'success');
        });
        const newGenBtn = document.getElementById('vgO1NewGeneration');
        if (newGenBtn) newGenBtn.addEventListener('click', () => {
            const readyWrap = document.getElementById('vgO1ReadyWrap');
            if (readyWrap) readyWrap.style.display = 'none';
            o1SetSubStep('preset');
        });
        const readyRevealBtn = document.getElementById('vgO1ReadyReveal');
        if (readyRevealBtn) readyRevealBtn.addEventListener('click', () => {
            const dir = state.o1ExportDir || state.o1RefFramePath && require('path').dirname(state.o1RefFramePath);
            if (!dir) return;
            try { const cp = require('child_process'); cp.execFile('/usr/bin/open', [dir]); } catch(_e) {}
        });

        // Step 2: Preset buttons
        const twilightBtn = document.getElementById('vgO1PresetTwilight');
        if (twilightBtn) twilightBtn.addEventListener('click', () => {
            state.o1Preset = 'twilight';
            o1PrefillPrompt('twilight');
            o1SetSubStep('twilight');
        });

        const carsBtn = document.getElementById('vgO1PresetCars');
        if (carsBtn) carsBtn.addEventListener('click', async () => {
            state.o1Preset = 'cars';
            o1PrefillPrompt('cars');
            o1SetSubStep('cars');
            try { await o1PrefillCarsWithDriveway(); } catch(_e) {}
        });

        const weatherBtn = document.getElementById('vgO1PresetWeather');
        if (weatherBtn) weatherBtn.addEventListener('click', () => {
            state.o1Preset = 'weather';
            o1PrefillPrompt('weather');
            o1SetSubStep('weather');
        });

        // Adjust-prompt buttons (rewrite the visible prompt with the user's words)
        function wireO1Adjust(preset, adjustId, btnId) {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', async () => {
                const inp = document.getElementById(adjustId);
                const field = document.getElementById(o1PromptFieldId(preset));
                const instruction = (inp && inp.value.trim()) || '';
                if (!instruction || !field) return;
                const _lbl = btn.textContent; btn.textContent = 'Applying...'; btn.disabled = true;
                setStatus('Adjusting prompt...', 'busy');
                try {
                    const refined = await o1RefinePrompt(field.value.trim() || O1_BASE_PROMPTS[preset], instruction);
                    field.value = refined;
                    if (inp) inp.value = '';
                    setStatus('Prompt updated', 'success');
                } catch(e) { setStatus('Adjust failed: ' + e.message, 'error'); }
                btn.textContent = _lbl; btn.disabled = false;
            });
        }
        wireO1Adjust('weather', 'vgO1WeatherAdjust', 'vgO1WeatherAdjustBtn');
        wireO1Adjust('twilight', 'vgO1TwilightAdjust', 'vgO1TwilightAdjustBtn');
        wireO1Adjust('cars', 'vgO1CarsAdjust', 'vgO1CarsAdjustBtn');
        const weatherGenBtn = document.getElementById('vgO1WeatherGenerate');
        if (weatherGenBtn) weatherGenBtn.addEventListener('click', async () => {
            weatherGenBtn.disabled = true;
            weatherGenBtn.textContent = 'Generating...';
            const wSt = document.getElementById('vgO1WeatherStatus');
            if (wSt) wSt.style.display = '';
            try { await o1GenerateRef('weather'); }
            finally {
                if (wSt) wSt.style.display = 'none';
                weatherGenBtn.disabled = false;
                weatherGenBtn.textContent = 'Create Reference Image';
            }
        });

        // Twilight: Use Night Reference
        const nightRefBtn = document.getElementById('vgO1TwilightNightRef');
        if (nightRefBtn) nightRefBtn.addEventListener('click', () => {
            // Show LUT selector overlay before capturing
            const lutsPath = getLutsPath();
            const lutFiles = lutsPath ? (() => { try { return require('fs').readdirSync(lutsPath).filter(f => f.endsWith('.cube')).map(f => f.replace('.cube','')); } catch(_) { return []; } })() : [];
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center';
            overlay.innerHTML = `<div style="background:#1e1e1e;border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:18px;width:240px">
                <div style="font-size:12px;font-weight:600;color:#fff;margin-bottom:12px">Select LUT for night clip</div>
                <select id="vgNightLutPick" style="width:100%;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:5px;color:#fff;padding:5px 8px;font-size:12px;margin-bottom:12px">
                    <option value="">— No LUT —</option>
                    ${lutFiles.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('')}
                </select>
                <div style="display:flex;gap:8px">
                    <button id="vgNightLutCancel" class="btn" style="flex:1">Cancel</button>
                    <button id="vgNightLutCapture" class="btn btn--accent" style="flex:1">Capture</button>
                </div>
            </div>`;
            document.body.appendChild(overlay);
            document.getElementById('vgNightLutCancel').onclick = () => overlay.remove();
            document.getElementById('vgNightLutCapture').onclick = async () => {
                const selectedLut = document.getElementById('vgNightLutPick').value;
                overlay.remove();
                state.o1TwilightMode = 'night_ref';
                nightRefBtn.disabled = true;
                nightRefBtn.textContent = 'Capturing...';
                setStatus('Reading playhead position...', 'busy');
                try {
                    const info = await new Promise((resolve, reject) => {
                        if (!cs) { reject(new Error('CSInterface not available')); return; }
                        const jsx = `(function(){
                            ${window.DM_JSON_SHIM || ''}
                            var seq = app.project.activeSequence;
                            if (!seq) return JSON.stringify({error:'No active sequence'});
                            function toSec(t) {
                                if (t === null || t === undefined) return 0;
                                if (typeof t === 'object' && t !== null && typeof t.seconds === 'number') return t.seconds;
                                if (typeof t === 'object' && t !== null && t.ticks !== undefined) return parseInt(t.ticks) / 254016000000;
                                var s = String(t); var n = parseFloat(s);
                                if (!isNaN(n) && !/[;:]/.test(s)) return n;
                                var fps = 25;
                                try { fps = Math.round(1 / parseFloat(seq.timebase)) || 25; } catch(_e) {}
                                var p = s.replace(/;/g, ':').split(':');
                                if (p.length >= 3) return parseInt(p[0])*3600 + parseInt(p[1])*60 + parseFloat(p[2]) + (p[3] ? parseInt(p[3])/fps : 0);
                                return 0;
                            }
                            var posSec = 0;
                            try { posSec = toSec(seq.getPlayerPosition()); } catch(e) {}
                            var sourcePath = '', fileSeekTime = posSec;
                            try {
                                outer: for (var t = 0; t < seq.videoTracks.numTracks; t++) {
                                    var track = seq.videoTracks[t];
                                    for (var c = 0; c < track.clips.numItems; c++) {
                                        var cl = track.clips[c];
                                        var clipStart = toSec(cl.start), clipEnd = toSec(cl.end);
                                        if (clipStart <= posSec && clipEnd > posSec) {
                                            try { sourcePath = cl.projectItem.getMediaPath(); } catch(e2) {}
                                            var mediaStart = 0;
                                            try { mediaStart = toSec(cl.inPoint); } catch(e3) {}
                                            var nSpeed = 1;
                                            try {
                                                app.enableQE();
                                                var nQs = qe.project.getActiveSequence();
                                                var nQt = nQs.getVideoTrackAt(t);
                                                for (var nQc = 0; nQc < nQt.numItems; nQc++) {
                                                    var nQi = nQt.getItemAt(nQc);
                                                    if (!nQi || nQi.type === 'Empty') continue;
                                                    var nSt = nQi.start && !isNaN(nQi.start.seconds) ? nQi.start.seconds : (nQi.start ? parseFloat(nQi.start.ticks) / 254016000000 : NaN);
                                                    if (!isNaN(nSt) && Math.abs(nSt - clipStart) < 0.02) {
                                                        var nSp = Math.abs(nQi.speed);
                                                        if (nSp > 0) nSpeed = nSp;
                                                        break;
                                                    }
                                                }
                                            } catch(_nq) {}
                                            fileSeekTime = (mediaStart + (posSec - clipStart)) * nSpeed;
                                            break outer;
                                        }
                                    }
                                }
                            } catch(e) {}
                            return JSON.stringify({ sourcePath: sourcePath, fileSeekTime: fileSeekTime });
                        }())`;
                        cs.evalScript(jsx, (r) => {
                            try {
                                const d = JSON.parse(r || '{}');
                                if (d.error) reject(new Error(d.error));
                                else if (!d.sourcePath) reject(new Error('No clip found at playhead — move playhead onto the night clip'));
                                else resolve(d);
                            } catch(e) { reject(new Error('JSX parse failed')); }
                        });
                    });

                    setStatus('Extracting frame...', 'busy');
                    const ext = require('path').extname(info.sourcePath).toLowerCase();
                    const isNonVideo = ['.aep','.prproj','.mogrt','.aepx'].includes(ext);
                    // Temporarily set LUT selector to chosen LUT for applySelectedLut
                    const lutSel = document.getElementById('vgLutSelectO1');
                    const prevLut = lutSel ? lutSel.value : '';
                    if (lutSel && selectedLut) lutSel.value = selectedLut;
                    let b64;
                    if (isNonVideo) {
                        // AEP/Dynamic Link: use Premiere's sequence frame export via JSX
                        b64 = await new Promise((resolve, reject) => {
                            const tmpPath = require('os').tmpdir() + '/dm_o1_night_' + Date.now() + '.png';
                            const jsx2 = `(function(){
                                try {
                                    app.enableQE();
                                    var seq = app.project.activeSequence;
                                    if (!seq) return 'error:No active sequence';
                                    var qeSeq = qe.project.getActiveSequence();
                                    if (!qeSeq) return 'error:QE sequence not available';
                                    var tc = seq.getPlayerPosition().timecode;
                                    qeSeq.exportFrameAsPNG(tc, ${JSON.stringify(tmpPath)});
                                    return 'ok:' + ${JSON.stringify(tmpPath)};
                                } catch(e) { return 'error:' + e.message; }
                            }())`;
                            cs.evalScript(jsx2, (r) => {
                                if (!r || r.startsWith('error:')) { reject(new Error(r ? r.replace('error:','') : 'Frame export failed')); return; }
                                const p = r.replace('ok:','').trim();
                                // Convert PNG to base64 JPEG via canvas
                                try {
                                    const imgData = require('fs').readFileSync(p);
                                    const canvas = document.createElement('canvas');
                                    const img = new Image();
                                    img.onload = () => {
                                        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                                        canvas.getContext('2d').drawImage(img, 0, 0);
                                        applySelectedLut(canvas);
                                        resolve(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
                                    };
                                    img.onerror = () => reject(new Error('Failed to load exported frame'));
                                    img.src = 'data:image/png;base64,' + imgData.toString('base64');
                                } catch(e2) { reject(new Error('Read frame failed: ' + e2.message)); }
                            });
                        });
                    } else {
                        b64 = await captureFrameAtInPoint(info.fileSeekTime, info.sourcePath);
                    }
                    if (lutSel) lutSel.value = prevLut;

                    // Save image to disk next to source file
                    try {
                        const srcDir = require('path').dirname(info.sourcePath);
                        const savePath = require('path').join(srcDir, 'dm_night_ref_' + Date.now() + '.jpg');
                        require('fs').writeFileSync(savePath, Buffer.from(b64, 'base64'));
                        setStatus('Night frame saved: ' + require('path').basename(savePath), 'success');
                    } catch(_e) {
                        setStatus('Frame captured ✓ (could not save to disk: ' + _e.message + ')', 'success');
                    }

                    state.o1RefFrameBase64 = b64;
                    state.o1RefImageUrl    = null;
                    o1ShowRefImage('data:image/jpeg;base64,' + b64);
                } catch(e) {
                    alert('Night Clip Error: ' + e.message);
                    setStatus('Error: ' + e.message, 'error');
                } finally {
                    nightRefBtn.disabled = false;
                    nightRefBtn.textContent = 'Use Night Clip';
                }
            };
        });

        // Twilight: Generate
        const twilightGenBtn = document.getElementById('vgO1TwilightGenerate');
        if (twilightGenBtn) twilightGenBtn.addEventListener('click', async () => {
            state.o1TwilightMode = 'generate';
            twilightGenBtn.disabled = true;
            await o1GenerateRef('twilight');
            twilightGenBtn.disabled = false;
        });

        // Cars: Generate
        const carsGenBtn = document.getElementById('vgO1CarsGenerate');
        if (carsGenBtn) carsGenBtn.addEventListener('click', async () => {
            carsGenBtn.disabled = true;
            await o1GenerateRef('cars');
            carsGenBtn.disabled = false;
        });

        // Approve
        const approveBtn = document.getElementById('vgO1Approve');
        if (approveBtn) approveBtn.addEventListener('click', () => o1ApproveRef());

        // Regenerate
        const regenBtn = document.getElementById('vgO1Regenerate');
        if (regenBtn) regenBtn.addEventListener('click', async () => {
            regenBtn.disabled = true;
            const _lbl = regenBtn.textContent;
            regenBtn.textContent = 'Generating\u2026';
            o1SetRefLoading(true);
            try {
                if (state.o1TwilightMode === 'night_ref') {
                    const nightRef = document.getElementById('vgO1TwilightNightRef');
                    if (nightRef) nightRef.click();
                } else {
                    await o1GenerateRef(state.o1Preset);
                }
            } finally {
                regenBtn.disabled = false;
                regenBtn.textContent = _lbl;
            }
        });

        // O1 auth button (mirrors sidebar auth)
        const o1AuthBtn = document.getElementById('vgO1AuthBtn');
        if (o1AuthBtn) o1AuthBtn.addEventListener('click', async () => {
            o1AuthBtn.disabled = true; o1AuthBtn.textContent = 'Opening...';
            try { await doOAuth(); updateAuthUI(); } catch(e) { setStatus(e.message, 'error'); }
            o1AuthBtn.disabled = false; o1AuthBtn.textContent = 'Authenticate';
        });
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function init() {

        // Show AI section only when host is Premiere Pro
        function revealAiSection() {
            try {
                const env     = cs && cs.getHostEnvironment ? cs.getHostEnvironment() : null;
                const appName = env ? env.appName : (typeof HOST !== 'undefined' ? HOST : 'unknown');
                if (appName === 'PPRO') {
                    const sec = document.getElementById('aiSection');
                    if (sec) sec.style.display = '';
                }
            } catch (_) {}
        }
        setTimeout(revealAiSection, 100);
        setTimeout(revealAiSection, 500);

        // LUT selector — restore last choice and persist on change
        const lutSel = document.getElementById('vgLutSelect');
        if (lutSel) {
            const saved = localStorage.getItem('vg_lut');
            if (saved) lutSel.value = saved;
            lutSel.addEventListener('change', () => localStorage.setItem('vg_lut', lutSel.value));
        }

        // Duration slider — restore and persist
        const durSlider = document.getElementById('vgDuration');
        const durVal    = document.getElementById('vgDurationVal');
        const savedDur  = parseInt(localStorage.getItem('vg_duration') || '12', 10);
        state.duration  = savedDur;
        durSlider.value = savedDur;
        durVal.textContent = savedDur + 's';
        durSlider.addEventListener('input', function () {
            state.duration = parseInt(this.value, 10);
            durVal.textContent = this.value + 's';
            localStorage.setItem('vg_duration', this.value);
        });

        // Mode buttons
        document.getElementById('vgModeTimelapse').addEventListener('click', () => selectMode('timelapse'));
        const _seBtn2 = document.getElementById('vgModeStartEnd');
        if (_seBtn2) _seBtn2.addEventListener('click', () => selectMode('start_end'));
        const _o1ModeBtn = document.getElementById('vgModeO1Edit');
        if (_o1ModeBtn) _o1ModeBtn.addEventListener('click', () => selectMode('o1_edit'));

        // Capture Frame buttons
        document.getElementById('vgCaptureBtn').addEventListener('click', captureFrame);
        const _srcBtn = document.getElementById('vgCaptureSrcBtn');
        if (_srcBtn) _srcBtn.addEventListener('click', captureFromSource);

        // O1 Edit buttons
        wireO1Buttons();

        // Back button in header
        document.getElementById('vgBack').addEventListener('click', () => {
            if (state.step === 1 || (state.mode === 'start_end' && state.step === 2)) {
                closeOverlay();
                return;
            }
            showStep(state.step - 1);
            if (state.step === 2 && state.mode !== 'start_end') {
                document.getElementById('vgPrompt').value  = state.prompt;
                document.getElementById('vgTmplName').textContent = TEMPLATES[state.template]?.label || '';
            }
        });

        // Dropzone drag + click
        const dropzone = document.getElementById('vgDropzone');
        dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
        dropzone.addEventListener('drop', async e => {
            e.preventDefault();
            dropzone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file) await handleFile(file);
        });
        document.getElementById('vgBrowseBtn').addEventListener('click', () => {
            document.getElementById('vgFileInput').click();
        });
        document.getElementById('vgFileInput').addEventListener('change', async e => {
            if (e.target.files[0]) await handleFile(e.target.files[0]);
        });

        // Template buttons
        document.querySelectorAll('.vg-tmpl-btn').forEach(btn => {
            btn.addEventListener('click', () => selectTemplate(btn.dataset.tmpl));
        });

        // Footer actions
        document.getElementById('vgActionBack').addEventListener('click', () => {
            showStep(state.step - 1);
            if (state.step === 3) {
                document.getElementById('vgPrompt').value = state.prompt;
                document.getElementById('vgTmplName').textContent = TEMPLATES[state.template]?.label || '';
            }
        });
        document.getElementById('vgActionNext').addEventListener('click', () => {
            if (state.mode === 'start_end') {
                if (!state.endMediaId) return;
                const camType = state.cameraType || 'static';
                state.prompt  = buildStartEndPrompt(camType, state.cameraDetail);
                document.getElementById('vgPrompt').value = state.prompt;
                document.getElementById('vgTmplName').textContent = '';
                document.getElementById('vgReanalyseBtn').style.display = 'none';
                document.getElementById('vgAdjustWrap').style.display = 'none';
                document.getElementById('vgCameraRow').style.display = '';
                const camSel = document.getElementById('vgCameraSelect');
                if (camSel) camSel.value = camType;
                showStep(3);
            } else {
                if (!state.template) return;
                document.getElementById('vgPrompt').value = state.prompt || '';
                document.getElementById('vgTmplName').textContent = (TEMPLATES[state.template] && TEMPLATES[state.template].label) || '';
                document.getElementById('vgAdjustWrap').style.display = state.template === 'shadow' ? '' : 'none';
                document.getElementById('vgAdjustInput').value = '';
                document.getElementById('vgReanalyseBtn').style.display = '';
                document.getElementById('vgCameraRow').style.display = 'none';
                showStep(3);
            }
        });
        // ── Adjust prompt in plain language ──────────────────────────────────────
        document.getElementById('vgAdjustBtn').addEventListener('click', async function () {
            const instruction = document.getElementById('vgAdjustInput').value.trim();
            if (!instruction) return;

            const currentPrompt = document.getElementById('vgPrompt').value.trim();
            if (!currentPrompt) return;

            const apiKey = getStoredGeminiKey();
            if (!apiKey) {
                document.getElementById('vgStep3Status').textContent = 'Gemini key not configured.';
                document.getElementById('vgStep3Status').style.display = '';
                return;
            }

            this.textContent = 'Applying...';
            this.disabled = true;
            setStatus('Adjusting prompt...', 'busy');

            try {
                const body = JSON.stringify({
                    contents: [{ parts: [{ text:
                        'You are adjusting a video generation prompt for an AI video tool.\n\n' +
                        'Current prompt:\n"""\n' + currentPrompt + '\n"""\n\n' +
                        'User instruction: "' + instruction + '"\n\n' +
                        'Rewrite the prompt incorporating the instruction naturally. ' +
                        'Keep all technical details (camera position, preserve elements, etc). ' +
                        'Return ONLY the updated prompt, no explanation, no quotes.'
                    }] }],
                    generationConfig: { maxOutputTokens: 1024 },
                });

                // free-tier Gemini is 20 req/min — 429 clears in seconds, so retry
                let res;
                for (let att = 0; ; att++) {
                    res = await fetch(
                        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
                        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
                    );
                    if (res.ok) break;
                    if ((res.status === 429 || res.status === 503) && att < 3) {
                        const wait = 3000 * (att + 1);
                        setStatus('Gemini rate limit — retrying in ' + (wait / 1000) + 's...', 'busy');
                        await new Promise(r => setTimeout(r, wait));
                        continue;
                    }
                    throw new Error(res.status === 429
                        ? 'Gemini rate limit (20/min on free tier) — wait a minute and try again'
                        : 'Gemini API ' + res.status);
                }
                const data = await res.json();
                const newPrompt = ((data.candidates[0].content.parts[0].text) || '').trim();
                if (newPrompt) {
                    document.getElementById('vgPrompt').value = newPrompt;
                    state.prompt = newPrompt;
                    document.getElementById('vgAdjustInput').value = '';
                    setStatus('Prompt updated', 'success');
                }
            } catch (e) {
                document.getElementById('vgStep3Status').textContent = 'Error: ' + e.message;
                document.getElementById('vgStep3Status').style.display = '';
                setStatus('Adjust failed: ' + e.message, 'error');
            }

            this.textContent = 'Apply';
            this.disabled = false;
        });

        // Cmd/Ctrl+Enter submits the adjust input
        document.getElementById('vgAdjustInput').addEventListener('keydown', function (e) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('vgAdjustBtn').click();
            }
        });

        document.getElementById('vgReanalyseBtn').addEventListener('click', async function () {
            const s3msg = document.getElementById('vgStep3Status');
            s3msg.style.display = 'none';
            if (!state.template || !state.base64) {
                s3msg.textContent = 'No image or template — go back and start again.';
                s3msg.style.display = '';
                return;
            }
            this.textContent = 'Analysing...';
            this.disabled = true;
            setStatus('Analysing image...', 'busy');
            try {
                state.analysis = await queuedAnalyse(() => analyseImage(state.template));
                state.prompt   = TEMPLATES[state.template].fill(state.analysis);
                document.getElementById('vgPrompt').value = state.prompt;
                setStatus('Analysis complete', 'success');
            } catch (e) {
                s3msg.textContent = e.message;
                s3msg.style.display = '';
                setStatus('Analysis failed: ' + e.message, 'error');
            }
            this.textContent = 'Re-analyse';
            this.disabled = false;
        });

        document.getElementById('vgGenerateEndBtn').addEventListener('click', generateEndImage);
        document.getElementById('vgRegenerateEndBtn').addEventListener('click', generateEndImage);
        document.getElementById('vgSwapFramesBtn').addEventListener('click', swapFrames);

        document.querySelectorAll('.vg-preset-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const isActive = btn.classList.contains('active');
                document.querySelectorAll('.vg-preset-btn').forEach(function (b) { b.classList.remove('active'); });
                if (!isActive) {
                    btn.classList.add('active');
                    document.getElementById('vgEndPrompt').value = SE_PRESETS[btn.dataset.preset] || '';
                } else {
                    document.getElementById('vgEndPrompt').value = '';
                }
            });
        });

        document.getElementById('vgCameraSelect').addEventListener('change', function () {
            state.cameraType   = this.value;
            state.cameraDetail = '';
            state.prompt       = buildStartEndPrompt(state.cameraType, state.cameraDetail);
            document.getElementById('vgPrompt').value = state.prompt;
        });

        document.getElementById('vgActionGenerate').addEventListener('click', async function () {
            if (this.disabled) return;
            this.disabled = true;
            try { await runGenerate(); } finally { this.disabled = false; }
        });

        // Higgsfield auth (step-1 button + header button share the same handler)
        async function runHfAuth(btn) {
            const orig = btn.textContent;
            btn.textContent = 'Opening browser...';
            btn.disabled    = true;
            try {
                await doOAuth();
                updateAuthUI();
                setStatus('Higgsfield authenticated', 'success');
            } catch (e) {
                setStatus(`Auth failed: ${e.message}`, 'error');
            }
            btn.textContent = orig;
            btn.disabled    = false;
        }
        document.getElementById('vgAuthBtn').addEventListener('click', function () {
            runHfAuth(this);
        });
        document.getElementById('vgHfAuthBtn').addEventListener('click', function () {
            runHfAuth(this);
        });
        const discBtn = document.getElementById('vgDisconnectBtn');
        if (discBtn) discBtn.addEventListener('click', function () {
            try { DmSecureStore.remove('higgsfield'); } catch (_) {}
            updateAuthUI();
            setStatus('Disconnected from Higgsfield — click Authenticate to sign in again', 'success');
        });
    }

    async function handleFile(file) {
        state.file   = file;
        state.base64 = await fileToBase64Jpeg(file);
        const dataUrl = URL.createObjectURL(file);
        document.getElementById('vgPreviewImg').src = dataUrl;
        document.getElementById('vgPreviewMeta').textContent =
            `${state.width} x ${state.height}  --  ${state.aspectRatio}`;
        document.getElementById('vgMeta').textContent = state.aspectRatio;

        if (state.mode === 'start_end') {
            document.getElementById('vgSeStartPreview').src = dataUrl;
            document.getElementById('vgSeStartMeta').textContent =
                `${state.width} x ${state.height}  --  ${state.aspectRatio}`;
            state.startMediaId  = null;
            state.endImageJobId = null;
            state.endMediaId    = null;
            state.swapped       = false;
            state.cameraType    = null;
            state.cameraDetail  = '';
            state.prompt        = '';
            document.getElementById('vgEndPrompt').value              = '';
            document.querySelectorAll('.vg-preset-btn').forEach(function (b) { b.classList.remove('active'); });
            document.getElementById('vgEndPreviewWrap').style.display = 'none';
            document.getElementById('vgEndFrameStatus').style.display = 'none';
            document.getElementById('vgActionNext').disabled = true;
        } else {
            state.template = null; state.analysis = null; state.prompt = '';
            document.querySelectorAll('.vg-tmpl-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('vgAnalyseStatus').style.display = 'none';
            document.getElementById('vgActionNext').disabled = true;
        }
        showStep(2);
    }

    // Boot after DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
