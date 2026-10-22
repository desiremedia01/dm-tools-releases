/* Gemini transport for AI Video. A Gemini key saved in this Mac's Keychain is
   used directly; otherwise requests go through the Desire Gemini proxy
   (Google Apps Script), authorised by the editor's DM Tools Google sign-in.
   The proxy holds the key — it is never shipped with the plugin. */
(function () {
    'use strict';
    var PROXY_URL = 'https://script.google.com/macros/s/AKfycbyFPDWr5v7lHgGS9yeMEw8rcVxfK7E75kmTuqQ5PFZdrTzSRZzKpzh2v3XiHHjs10PQAA/exec';
    var https = require('https');
    function post(urlStr, bodyStr, signal, hops) {
        return new Promise(function (resolve, reject) {
            var u = new URL(urlStr), isPost = bodyStr != null;
            if (!/^(script\.google\.com|script\.googleusercontent\.com)$/.test(u.hostname)) return reject(new Error('Unexpected proxy host.'));
            var buf = isPost ? Buffer.from(bodyStr, 'utf8') : null;
            var req = https.request({ method: isPost ? 'POST' : 'GET', hostname: u.hostname, path: u.pathname + u.search,
                headers: isPost ? { 'Content-Type': 'text/plain;charset=utf-8', 'Content-Length': buf.length } : {} }, function (res) {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume(); if ((hops || 0) >= 5) return reject(new Error('Proxy redirect loop.'));
                    return resolve(post(new URL(res.headers.location, urlStr).toString(), null, signal, (hops || 0) + 1));
                }
                var chunks = []; res.on('data', function (d) { chunks.push(d); });
                res.on('end', function () { resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }); });
            });
            req.setTimeout(120000, function () { req.destroy(new Error('Gemini proxy timed out.')); });
            req.on('error', reject);
            if (signal) { if (signal.aborted) { req.destroy(); var a = new Error('Aborted'); a.name = 'AbortError'; return reject(a); }
                signal.addEventListener('abort', function () { var e = new Error('Aborted'); e.name = 'AbortError'; req.destroy(e); }); }
            if (buf) req.write(buf); req.end();
        });
    }
    function response(status, text) {
        return { ok: status >= 200 && status < 300, status: status,
            json: function () { return Promise.resolve().then(function () { return JSON.parse(text); }); },
            text: function () { return Promise.resolve(text); } };
    }
    window.DmGemini = {
        proxyAvailable: function () { return !!PROXY_URL && typeof DmAuth !== 'undefined' && !!DmAuth.getEmail(); },
        /* Same contract as fetch(url, init) for a generateContent call. */
        proxyFetch: function (model, init) {
            if (!PROXY_URL) return Promise.reject(new Error('Gemini proxy is not set up yet.'));
            return DmAuth.getAccessToken().then(function (token) {
                return post(PROXY_URL, JSON.stringify({ token: token, model: model, body: init && init.body }), init && init.signal);
            }).then(function (r) {
                var o; try { o = JSON.parse(r.text); } catch (_) { return response(502, '{"error":{"message":"Gemini proxy returned an invalid response."}}'); }
                if (o.error) return response(o.error === 'unauthorized' ? 401 : 502, JSON.stringify({ error: { message: 'Gemini proxy: ' + o.error } }));
                if (typeof o.status !== 'number' || typeof o.body !== 'string') return response(502, '{"error":{"message":"Gemini proxy returned an unexpected response. Try again."}}');
                return response(o.status, o.body);
            });
        }
    };
})();
