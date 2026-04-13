/* ── DM Tools — Google Auth ──────────────────────── */
(function () {

    var CLIENT_ID      = atob('MjY0NTU3MjI2MjcwLW41dHBsams3Z2V1NTcyNW5ubnJhNzFpdGVxZm9wZHNiLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t');
    var CLIENT_SECRET  = atob('R09DU1BYLVhKSkVrcGY4QzdVdkFPRXpSaDNyd2xrRndSR2o=');
    var REDIRECT_URI   = 'https://desiremedia01.github.io/dm-tools-auth/';
    var RELAY_URL      = 'https://script.google.com/macros/s/AKfycbw0LNLiy2Zgn5cQ0qIFDQ_e-x0Jjd2QT3pvxHNt9s2qEbOyINYGv5G3ERS6Dwgy3MvV/exec';
    var ALLOWED_DOMAIN = 'desiremedia.com.au';

    var TOKEN_KEY   = 'dm_access_token';
    var REFRESH_KEY = 'dm_refresh_token';
    var EMAIL_KEY   = 'dm_email';
    var EXPIRY_KEY  = 'dm_expiry';

    var _pollInterval = null;

    function randomState() {
        var s = '';
        var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (var i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
        return s;
    }

    function stopPolling() {
        if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
    }

    window.DmAuth = {

        getEmail: function () {
            return localStorage.getItem(EMAIL_KEY) || '';
        },

        logout: function () {
            stopPolling();
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(REFRESH_KEY);
            localStorage.removeItem(EMAIL_KEY);
            localStorage.removeItem(EXPIRY_KEY);
        },

        /* ── Check auth state (async — handles token refresh) ── */
        checkAuth: function (onValid, onInvalid) {
            var token   = localStorage.getItem(TOKEN_KEY);
            var refresh = localStorage.getItem(REFRESH_KEY);
            var email   = localStorage.getItem(EMAIL_KEY) || '';
            var expiry  = parseInt(localStorage.getItem(EXPIRY_KEY) || '0', 10);

            if (!email || email.indexOf('@' + ALLOWED_DOMAIN) === -1) {
                DmAuth.logout(); onInvalid(); return;
            }

            /* Token still valid */
            if (token && Date.now() < expiry) {
                onValid(email); return;
            }

            /* Token expired — try refresh */
            if (refresh) {
                DmAuth._refreshToken(refresh, onValid, onInvalid);
                return;
            }

            onInvalid();
        },

        /* ── Refresh access token ── */
        _refreshToken: function (refreshToken, onValid, onInvalid) {
            var body = [
                'client_id='     + encodeURIComponent(CLIENT_ID),
                'client_secret=' + encodeURIComponent(CLIENT_SECRET),
                'refresh_token=' + encodeURIComponent(refreshToken),
                'grant_type=refresh_token'
            ].join('&');

            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'https://oauth2.googleapis.com/token', true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            xhr.onload = function () {
                if (xhr.status === 200) {
                    try {
                        var data       = JSON.parse(xhr.responseText);
                        var expiresIn  = data.expires_in || 3600;
                        var email      = localStorage.getItem(EMAIL_KEY) || '';
                        localStorage.setItem(TOKEN_KEY,  data.access_token);
                        localStorage.setItem(EXPIRY_KEY, String(Date.now() + expiresIn * 1000));
                        onValid(email);
                    } catch (e) { DmAuth.logout(); onInvalid(); }
                } else {
                    /* Refresh failed — account likely deleted/deactivated */
                    DmAuth.logout(); onInvalid();
                }
            };
            xhr.onerror = function () { DmAuth.logout(); onInvalid(); };
            xhr.send(body);
        },

        /* ── Start OAuth login flow ── */
        login: function (onSuccess, onError) {
            stopPolling();

            var state = randomState();

            var params = [
                'client_id='    + encodeURIComponent(CLIENT_ID),
                'redirect_uri=' + encodeURIComponent(REDIRECT_URI),
                'response_type=code',
                'scope='        + encodeURIComponent('email profile'),
                'access_type=offline',
                'prompt=consent',
                'state='        + encodeURIComponent(state)
            ].join('&');

            var authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params;

            try {
                if (typeof CSInterface !== 'undefined') {
                    new CSInterface().openURLInDefaultBrowser(authUrl);
                } else {
                    window.open(authUrl, '_blank');
                }
            } catch (e) {
                onError('Error opening browser: ' + e); return;
            }

            /* Poll relay every 2s for up to 3 minutes */
            var attempts = 0;
            var maxAttempts = 90;

            _pollInterval = setInterval(function () {
                attempts++;
                if (attempts > maxAttempts) {
                    stopPolling();
                    onError('Login timed out. Please try again.');
                    return;
                }

                var xhr = new XMLHttpRequest();
                xhr.open('GET', RELAY_URL + '?state=' + encodeURIComponent(state), true);
                xhr.onload = function () {
                    if (xhr.status === 200) {
                        try {
                            var data = JSON.parse(xhr.responseText);
                            if (data.code) {
                                stopPolling();
                                DmAuth._exchangeCode(data.code, onSuccess, onError);
                            }
                        } catch (e) { /* keep polling */ }
                    }
                };
                xhr.send();
            }, 2000);
        },

        /* ── Exchange auth code for tokens ── */
        _exchangeCode: function (code, onSuccess, onError) {
            var body = [
                'code='          + encodeURIComponent(code),
                'client_id='     + encodeURIComponent(CLIENT_ID),
                'client_secret=' + encodeURIComponent(CLIENT_SECRET),
                'redirect_uri='  + encodeURIComponent(REDIRECT_URI),
                'grant_type=authorization_code'
            ].join('&');

            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'https://oauth2.googleapis.com/token', true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            xhr.onload = function () {
                if (xhr.status === 200) {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        if (data.refresh_token) {
                            localStorage.setItem(REFRESH_KEY, data.refresh_token);
                        }
                        DmAuth._getUserInfo(data.access_token, data.expires_in || 3600, onSuccess, onError);
                    } catch (e) { onError('Error processing token: ' + e); }
                } else {
                    onError('Error getting token (' + xhr.status + '): ' + xhr.responseText);
                }
            };
            xhr.onerror = function () { onError('Network error getting token.'); };
            xhr.send(body);
        },

        /* ── Get user email and validate domain ── */
        _getUserInfo: function (accessToken, expiresIn, onSuccess, onError) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', 'https://www.googleapis.com/oauth2/v2/userinfo', true);
            xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
            xhr.onload = function () {
                if (xhr.status === 200) {
                    try {
                        var user  = JSON.parse(xhr.responseText);
                        var email = user.email || '';

                        if (email.indexOf('@' + ALLOWED_DOMAIN) === -1) {
                            onError('Access denied. Only @' + ALLOWED_DOMAIN + ' accounts are allowed.');
                            return;
                        }

                        localStorage.setItem(TOKEN_KEY,  accessToken);
                        localStorage.setItem(EMAIL_KEY,  email);
                        localStorage.setItem(EXPIRY_KEY, String(Date.now() + expiresIn * 1000));

                        onSuccess(email);
                    } catch (e) { onError('Error processing user data: ' + e); }
                } else {
                    onError('Error getting user data (' + xhr.status + ').');
                }
            };
            xhr.onerror = function () { onError('Network error getting user data.'); };
            xhr.send();
        }
    };

})();
