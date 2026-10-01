
    /* Reveal AI Video section in Premiere Pro only */
    (function revealAI() {
        function check() {
            try {
                var env  = (typeof cs !== 'undefined' && cs) ? cs.getHostEnvironment() : null;
                var host = env ? env.appName : (typeof HOST !== 'undefined' ? HOST : '');
                if (host === 'PPRO') {
                    var sec = document.getElementById('aiSection');
                    if (sec) { sec.style.display = ''; return true; }
                }
            } catch (e) {}
            return false;
        }
        if (!check()) {
            setTimeout(function(){ if (!check()) setTimeout(check, 500); }, 100);
        }
    })();
    