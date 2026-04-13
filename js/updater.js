/* ── DM Tools Auto-Updater ────────────────────────────────────────────────
 *  Checks desiremedia01/dm-tools-releases on GitHub for a newer version.
 *  If found, downloads every file listed in the remote version.json and
 *  writes them to the extension folder via cep.fs.
 *  The caller is notified so it can prompt the user to reopen the panel.
 * ─────────────────────────────────────────────────────────────────────── */

var DmUpdater = (function () {

    /* ── Config ─────────────────────────────────────────────────────── */
    var LOCAL_VERSION  = '1.1.0';
    var VERSION_URL    = 'https://raw.githubusercontent.com/desiremedia01/dm-tools-releases/main/version.json';

    /* ── Helpers ─────────────────────────────────────────────────────── */
    function compareVersions(a, b) {
        var pa = a.split('.').map(Number);
        var pb = b.split('.').map(Number);
        for (var i = 0; i < 3; i++) {
            var na = pa[i] || 0, nb = pb[i] || 0;
            if (na > nb) return  1;
            if (na < nb) return -1;
        }
        return 0;
    }

    function getRoot() {
        try {
            var cs = (typeof CSInterface !== 'undefined') ? new CSInterface() : null;
            return cs ? cs.getSystemPath('extension') : '.';
        } catch (e) { return '.'; }
    }

    /* Fetch a URL, return text via callback(err, text) */
    function fetchText(url, callback) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url + '?t=' + Date.now(), true);
        xhr.timeout = 15000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                callback(null, xhr.responseText);
            } else {
                callback('HTTP ' + xhr.status);
            }
        };
        xhr.ontimeout = function () { callback('timeout'); };
        xhr.onerror   = function () { callback('network error'); };
        xhr.send();
    }

    /* Write a file relative to the extension root */
    function writeFile(relPath, content) {
        try {
            var fullPath = getRoot() + '/' + relPath;
            if (window.cep && window.cep.fs) {
                var res = window.cep.fs.writeFile(fullPath, content, cep.encoding.UTF8);
                return (res.err === 0);
            }
        } catch (e) {}
        return false;
    }

    /* ── Public API ──────────────────────────────────────────────────── */

    /**
     * check(onUpdate, onUpToDate, onError)
     *   onUpdate(newVersion, failedCount)  — called after files are written
     *   onUpToDate()                       — called if already on latest
     *   onError(msg)                       — called on network/parse failure
     */
    function check(onUpdate, onUpToDate, onError) {
        fetchText(VERSION_URL, function (err, data) {
            if (err) {
                if (onError) onError(err);
                return;
            }

            var manifest;
            try { manifest = JSON.parse(data); } catch (e) {
                if (onError) onError('Bad manifest: ' + e);
                return;
            }

            var remoteVersion = manifest.version || '0.0.0';

            if (compareVersions(remoteVersion, LOCAL_VERSION) <= 0) {
                if (onUpToDate) onUpToDate();
                return;
            }

            /* Newer version found — download all files */
            var files   = manifest.files || [];
            var pending = files.length;
            var failed  = 0;

            if (pending === 0) {
                if (onUpdate) onUpdate(remoteVersion, 0);
                return;
            }

            files.forEach(function (f) {
                fetchText(f.url, function (err2, content) {
                    if (err2) {
                        failed++;
                    } else {
                        var ok = writeFile(f.path, content);
                        if (!ok) failed++;
                    }
                    pending--;
                    if (pending === 0) {
                        if (onUpdate) onUpdate(remoteVersion, failed);
                    }
                });
            });
        });
    }

    return {
        check:   check,
        version: LOCAL_VERSION
    };

})();
