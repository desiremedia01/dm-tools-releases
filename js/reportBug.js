/* ── Report Bug ─────────────────────────────────────────────────────────
   Small button in the status bar → overlay with a textarea → POST to a
   Google Apps Script Web App that emails the report (MailApp) to Matheus.
   Automatic payload: plugin version, Mac username, host (PPRO/AEFT), open
   project name, last status line. Network failure = error in the status
   bar, never blocks the panel. */
(function () {
    if (typeof document === 'undefined') return; /* panel only */

    /* Web App URL (script.google.com → Deploy → Web App → Anyone).
       Empty = feature not configured yet. */
    var REPORT_URL = 'https://script.google.com/macros/s/AKfycbxhCjifvRUgwCDp88KuefRUJi20IiAgkIaHNgptwQCU_8-h7fmT_-4YFl2dF_MLs1drow/exec';

    function nodeReq(m) {
        return (typeof window !== 'undefined' && window.cep_node) ? window.cep_node.require(m) : require(m);
    }

    function gatherContext(cb) {
        var ctx = { version: '', user: '', host: '', project: '', lastStatus: '' };
        try { ctx.version = (typeof DmUpdater !== 'undefined' && DmUpdater.version) ? DmUpdater.version : ''; } catch (e) {}
        try { ctx.user = nodeReq('os').userInfo().username; } catch (e) {}
        try { ctx.host = (typeof HOST !== 'undefined' && HOST) ? HOST : ''; } catch (e) {}
        try { var el = document.getElementById('statusMsg'); ctx.lastStatus = el ? el.textContent : ''; } catch (e) {}
        try {
            var cs = new CSInterface();
            cs.evalScript('(function(){try{return app.project.name||"";}catch(e){return "";}}())', function (r) {
                ctx.project = (r && r !== 'EvalScript error.') ? r : '';
                cb(ctx);
            });
            /* never hang if evalScript doesn't answer */
            setTimeout(function () { if (!ctx._done) { ctx._done = true; } }, 3000);
        } catch (e) { cb(ctx); }
    }

    /* POST JSON via Node https — no CORS; Apps Script replies 302 after the
       mail is sent, so 2xx/3xx both count as success. */
    function postReport(url, payload, cb) {
        var done = false;
        function finish(err) { if (!done) { done = true; cb(err); } }
        try {
            var u = new URL(url);
            var https = nodeReq('https');
            var body = JSON.stringify(payload);
            var req = https.request({
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
                timeout: 15000
            }, function (res) {
                res.resume();
                if (res.statusCode >= 200 && res.statusCode < 400) finish(null);
                else finish('HTTP ' + res.statusCode);
            });
            req.on('timeout', function () { try { req.destroy(); } catch (e) {} finish('timeout'); });
            req.on('error', function (e) { finish(e.message || 'network error'); });
            req.write(body);
            req.end();
        } catch (e) { finish(e.message || 'request failed'); }
    }

    function closeOverlay() {
        var ov = document.getElementById('dmBugOverlay');
        if (ov) ov.remove();
    }

    function openOverlay() {
        if (document.getElementById('dmBugOverlay')) return;
        var ov = document.createElement('div');
        ov.id = 'dmBugOverlay';
        ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
        ov.innerHTML =
            '<div style="background:#1e1e1e;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:18px 20px;width:100%;max-width:340px">' +
            '<div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">🐞 Report a bug</div>' +
            '<div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:10px">What happened? What did you expect? Plugin version, user, host and project are attached automatically.</div>' +
            '<textarea id="dmBugText" rows="5" placeholder="e.g. Auto SFX put a whoosh in the wrong spot at 0:28 in the Cintra project..." style="width:100%;box-sizing:border-box;background:#141414;color:#eee;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:8px;font-size:12px;font-family:inherit;resize:vertical"></textarea>' +
            '<div style="display:flex;gap:8px;margin-top:12px">' +
            '<button id="dmBugCancel" class="btn" style="flex:1">Cancel</button>' +
            '<button id="dmBugSend" class="btn btn--accent" style="flex:1">Send</button>' +
            '</div></div>';
        document.body.appendChild(ov);
        document.getElementById('dmBugCancel').onclick = closeOverlay;
        document.getElementById('dmBugText').focus();

        document.getElementById('dmBugSend').onclick = function () {
            var txt = (document.getElementById('dmBugText').value || '').trim();
            if (!txt) { document.getElementById('dmBugText').focus(); return; }
            if (!REPORT_URL) {
                closeOverlay();
                if (typeof setStatus === 'function') setStatus('Report Bug: not configured yet (missing endpoint URL)', 'error');
                return;
            }
            var sendBtn = document.getElementById('dmBugSend');
            sendBtn.disabled = true; sendBtn.textContent = 'Sending...';
            gatherContext(function (ctx) {
                var payload = {
                    text: txt,
                    version: ctx.version,
                    user: ctx.user,
                    host: ctx.host,
                    project: ctx.project,
                    lastStatus: ctx.lastStatus,
                    at: new Date().toISOString()
                };
                postReport(REPORT_URL, payload, function (err) {
                    closeOverlay();
                    if (typeof setStatus === 'function') {
                        if (err) setStatus('Report Bug: send failed (' + err + ') — try again later', 'error');
                        else setStatus('Bug report sent — thank you! 🐞', 'success');
                    }
                });
            });
        };
    }

    var btn = document.getElementById('reportBugBtn');
    if (btn) btn.addEventListener('click', openOverlay);
})();
