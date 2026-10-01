/* Local defaults; host scripts receive only validated numeric values. */
var DmSettings = (function () {
    var key = 'dm-tools.settings.v1';
    var defaults = {intro:100, middle:100, outro:75, shakeIntensity:100, shakeDuration:0.28, compact:true};
    var limits = {intro:[0,100], middle:[0,100], outro:[0,100], shakeIntensity:[0,500], shakeDuration:[0.05,5]};
    function normalise(raw) {
        var result = {};
        Object.keys(limits).forEach(function (k) {
            var n = raw && raw[k];
            result[k] = typeof n === 'number' && isFinite(n) && n >= limits[k][0] && n <= limits[k][1] ? n : defaults[k];
        });
        result.compact = raw && typeof raw.compact === 'boolean' ? raw.compact : defaults.compact;
        return result;
    }
    var current = normalise(null);
    try { current = normalise(JSON.parse(localStorage.getItem(key))); } catch (e) {}
    // Adopt the new compact default once, preserving all effect defaults.
    // Later explicit layout choices remain saved normally.
    try {
        if (localStorage.getItem('dm-tools.compact-default.v2') !== 'applied') {
            current.compact = true;
            localStorage.setItem(key, JSON.stringify(current));
            localStorage.setItem('dm-tools.compact-default.v2', 'applied');
        }
    } catch (e) {}
    function apply() { document.body.classList.toggle('compact-layout', current.compact); }
    function fill(values) {
        Object.keys(defaults).forEach(function (k) {
            var el = document.getElementById('setting-' + k);
            if (k === 'compact') el.checked = values[k]; else el.value = values[k];
        });
    }
    var overlay = document.getElementById('settingsOverlay');
    function close() { overlay.classList.remove('visible'); document.getElementById('settingsBtn').focus(); }
    document.getElementById('settingsBtn').addEventListener('click', function () {
        fill(current);
        document.getElementById('settingsError').textContent = '';
        overlay.classList.add('visible');
        document.getElementById('settingsClose').focus();
    });
    document.getElementById('settingsClose').addEventListener('click', close);
    document.getElementById('settingsReset').addEventListener('click', function () { fill(defaults); });
    document.getElementById('settingsForm').addEventListener('submit', function (e) {
        e.preventDefault();
        if (!this.checkValidity()) { this.reportValidity(); return; }
        var next = {};
        Object.keys(limits).forEach(function (k) { next[k] = Number(document.getElementById('setting-' + k).value); });
        next.compact = document.getElementById('setting-compact').checked;
        try { localStorage.setItem(key, JSON.stringify(normalise(next))); }
        catch (err) { document.getElementById('settingsError').textContent = 'Could not save settings. Please try again.'; return; }
        current = normalise(next); apply(); close();
        if (typeof setStatus === 'function') setStatus('Settings saved', 'success');
    });
    overlay.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Tab') {
            var items = Array.prototype.filter.call(overlay.querySelectorAll('button,input'), function(el) { return el.offsetParent !== null && !el.disabled; });
            var first = items[0], last = items[items.length-1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
    apply();
    return {get:function () { return normalise(current); }};
})();
