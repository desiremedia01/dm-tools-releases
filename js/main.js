/* ── CSInterface Init ─────────────────────────────── */
var cs = (typeof CSInterface !== 'undefined') ? new CSInterface() : null;

/* ── Host Detection ───────────────────────────────── */
var HOST = 'unknown';

function detectHost() {
    if (!cs) return;
    var env = cs.getHostEnvironment();
    HOST = env.appName; // "AEFT" or "PPRO"

    var badge = document.getElementById('hostBadge');
    var aeSection = document.getElementById('aeSection');
    var speedRampSection = document.getElementById('speedRampSection');
    var prSection = document.getElementById('prSection');

    if (HOST === 'AEFT') {
        badge.textContent = 'AE';
        badge.style.color = '#0693e3';
        aeSection.style.display = '';
        speedRampSection.style.display = '';
        prSection.style.display = 'none';
        document.getElementById('collectBar').style.display = '';
    } else if (HOST === 'PPRO') {
        badge.textContent = 'PR';
        badge.style.color = '#9b51e0';
        badge.style.background = 'rgba(155, 81, 224, 0.15)';
        badge.style.borderColor = 'rgba(155, 81, 224, 0.3)';
        aeSection.style.display = 'none';
        speedRampSection.style.display = 'none';
        prSection.style.display = '';
        document.getElementById('collectBar').style.display = '';
    }
}

/* ── evalScript Helper ────────────────────────────── */
function evalScript(script, callback) {
    if (cs) {
        cs.evalScript(script, callback || function() {});
    } else {
        console.log('[DEV] evalScript:', script);
        if (callback) callback('__dev__');
    }
}

/* ── Status ───────────────────────────────────────── */
var statusTimeout = null;

function setStatus(msg, type) {
    // type: 'idle' | 'busy' | 'success' | 'error'
    var dot = document.getElementById('statusDot');
    var msgEl = document.getElementById('statusMsg');

    dot.className = 'status-dot' + (type ? ' status-dot--' + type : '');
    msgEl.className = 'status-msg' + (type ? ' status-msg--' + type : '');
    msgEl.textContent = msg;

    if (statusTimeout) clearTimeout(statusTimeout);
    if (type === 'success' || type === 'error') {
        statusTimeout = setTimeout(function() {
            setStatus('Ready', 'idle');
        }, 3500);
    }
}

/* ── Slider ───────────────────────────────────────── */
var intensitySlider = document.getElementById('intensitySlider');

function getIntensity() {
    return parseFloat(intensitySlider.value);
}

// Update slider track fill
intensitySlider.addEventListener('input', function() {
    var pct = (this.value / 100) * 100;
    this.style.background = 'linear-gradient(to right, #0693e3 ' + pct + '%, #2a2a2a ' + pct + '%)';
});

// Init slider fill
(function() {
    var pct = (intensitySlider.value / 100) * 100;
    intensitySlider.style.background = 'linear-gradient(to right, #0693e3 ' + pct + '%, #2a2a2a ' + pct + '%)';
})();

/* ── Button Actions ───────────────────────────────── */
var actions = {
    // ── Tools ────────────────────────────────────────
    warpComp: function() {
        setStatus('Applying Warp / Comp...', 'busy');
        evalScript('$.evalFile("' + getJsxPath() + '"); warpComp();', function(res) {
            handleResult(res);
        });
    },
    motionBlur: function() {
        setStatus('Applying Motion Blur...', 'busy');
        evalScript('$.evalFile("' + getJsxPath() + '"); motionBlur();', function(res) {
            handleResult(res);
        });
    },
    dayToNight: function() {
        setStatus('Applying Day to Night...', 'busy');
        evalScript('$.evalFile("' + getJsxPath() + '"); dayToNight();', function(res) {
            handleResult(res);
        });
    },
    pinDrop: function() {
        pinDropOpen();
    },
    trackCamera: function() {
        setStatus('Tracking Camera...', 'busy');
        evalScript('$.evalFile("' + getJsxPath() + '"); trackCamera();', function(res) {
            handleResult(res);
        });
    },
    stabilize: function() {
        setStatus('Stabilizing...', 'busy');
        evalScript('$.evalFile("' + getJsxPath() + '"); stabilizeMotion();', function(res) {
            handleResult(res);
        });
    },
    ccRepetile: function() {
        setStatus('Applying CC RepeTile...', 'busy');
        evalScript('$.evalFile("' + getJsxPath() + '"); ccRepetile();', function(res) {
            handleResult(res);
        });
    },
    keyStroke: function() {
        setStatus('Applying Key + Stroke...', 'busy');
        evalScript('$.evalFile("' + getJsxPath() + '"); keyStroke();', function(res) {
            handleResult(res);
        });
    },

    // ── Premiere Tools ───────────────────────────────
    prWarpStabilizer: function() {
        setStatus('Applying Warp Stabilizer...', 'busy');
        evalScript('$.evalFile("' + getPrJsxPath() + '"); prWarpStabilizer();', function(res) {
            handleResult(res, 'Warp Stabilizer applied!');
        });
    },
    collectFiles: function() {
        setStatus('Collecting files...', 'busy');
        if (HOST === 'PPRO') {
            evalScript('$.evalFile("' + getPrJsxPath() + '"); prCollectFiles();', function(res) {
                handleResult(res, 'Files collected!');
            });
        } else {
            evalScript('$.evalFile("' + getJsxPath() + '"); aeCollectFiles();', function(res) {
                handleResult(res, 'Files collected!');
            });
        }
    },
    soundboard: function() {
        sbOpen();
    },
    prColorGrade: function() {
        setStatus('Loading LUTs...', 'busy');
        evalScript('$.evalFile("' + getPrJsxPath() + '"); prGetAGItems();', function(res) {
            if (!res || res.indexOf('Error') === 0) { setStatus(res || 'Error scanning project', 'error'); return; }
            if (res === 'EMPTY') { setStatus('No AG items found in project', 'error'); return; }
            if (res.indexOf('DEBUG|') === 0) { setStatus('Found: ' + res.replace('DEBUG|','').split('|').join(', '), 'error'); return; }
            try {
                var data = JSON.parse(res);
                cgPopulateSelects(data.drone, data.camera, data.creative);
                colorGradeOverlay.classList.add('visible');
                setStatus('Ready', 'idle');
            } catch(e) { setStatus('Error: ' + e, 'error'); }
        });
    },

    // ── Speed Ramp ────────────────────────────────────
    introRamp: function() {
        setStatus('Applying Intro Ramp...', 'busy');
        var intensity = getIntensity();
        evalScript('$.evalFile("' + getJsxPath() + '"); introRamp(' + intensity + ');', function(res) {
            handleResult(res, 'Intro Ramp applied!');
        });
    },
    middleRamp: function() {
        setStatus('Applying Middle Ramp...', 'busy');
        var intensity = getIntensity();
        evalScript('$.evalFile("' + getJsxPath() + '"); middleRamp(' + intensity + ');', function(res) {
            handleResult(res, 'Middle Ramp applied!');
        });
    },
    outroRamp: function() {
        setStatus('Applying Outro Ramp...', 'busy');
        var intensity = getIntensity();
        evalScript('$.evalFile("' + getJsxPath() + '"); outroRamp(' + intensity + ');', function(res) {
            handleResult(res, 'Outro Ramp applied!');
        });
    }
};

/* ── Result Handler ───────────────────────────────── */
function handleResult(res, successMsg) {
    if (!res || res === 'undefined' || res === '__dev__') {
        setStatus(successMsg || 'Done!', 'success');
        return;
    }
    if (res.indexOf('Error') === 0 || res.indexOf('error') === 0) {
        setStatus(res, 'error');
    } else {
        setStatus(res || successMsg || 'Done!', 'success');
    }
}

/* ── JSX Paths ────────────────────────────────────── */
function getJsxPath() {
    if (cs) {
        return cs.getSystemPath('extension') + '/jsx/ae-tools.jsx';
    }
    return './jsx/ae-tools.jsx';
}

function getPrJsxPath() {
    if (cs) {
        return cs.getSystemPath('extension') + '/jsx/pr-tools.jsx';
    }
    return './jsx/pr-tools.jsx';
}

function getLutsPath(subfolder) {
    var base = cs ? cs.getSystemPath('extension') : '.';
    return base + '/assets/luts/' + subfolder + '/';
}

/* ── Event Listeners ──────────────────────────────── */
document.querySelectorAll('[data-action]').forEach(function(btn) {
    btn.addEventListener('click', function() {
        var action = this.getAttribute('data-action');
        if (actions[action]) {
            actions[action]();
        }
    });
});

/* ── Pin Drop Form ────────────────────────────────── */
var pinDropOverlay    = document.getElementById('pinDropOverlay');
var pinDropAddressEl  = document.getElementById('pinDropAddress');
var pinDropFontSearch = document.getElementById('pinDropFontSearch');
var pinDropFontEl     = document.getElementById('pinDropFont');
var pinDropCreateBtn  = document.getElementById('pinDropCreateBtn');
var pinDropCancelBtn  = document.getElementById('pinDropCancelBtn');
var pdModeAddress     = document.getElementById('pdModeAddress');
var pdModeKollosche   = document.getElementById('pdModeKollosche');
var pdAddressFields   = document.getElementById('pdAddressFields');
var pdLogoFields      = document.getElementById('pdLogoFields');
var pdMode = 'address'; // 'address' | 'kollosche'

var pdAllFonts = [
    'Montserrat-Thin','Montserrat-ThinItalic','Montserrat-ExtraLight','Montserrat-ExtraLightItalic',
    'Montserrat-Light','Montserrat-LightItalic','Montserrat-Regular','Montserrat-Italic',
    'Montserrat-Medium','Montserrat-MediumItalic','Montserrat-SemiBold','Montserrat-SemiBoldItalic',
    'Montserrat-Bold','Montserrat-BoldItalic','Montserrat-ExtraBold','Montserrat-ExtraBoldItalic',
    'Montserrat-Black','Montserrat-BlackItalic',
    'Gellix-Thin','Gellix-ThinItalic','Gellix-Light','Gellix-LightItalic',
    'Gellix-Regular','Gellix-RegularItalic','Gellix-Medium','Gellix-MediumItalic',
    'Gellix-SemiBold','Gellix-SemiBoldItalic','Gellix-Bold','Gellix-BoldItalic',
    'Gellix-ExtraBold','Gellix-ExtraBoldItalic','Gellix-Black','Gellix-BlackItalic',
    'FuturaPT-Light','FuturaPT-LightObl','FuturaPT-Book','FuturaPT-BookObl',
    'FuturaPT-Medium','FuturaPT-MediumObl','FuturaPT-Demi','FuturaPT-DemiObl',
    'FuturaPT-Heavy','FuturaPT-HeavyObl','FuturaPT-Bold','FuturaPT-BoldObl',
    'FuturaPT-ExtraBold','FuturaPT-ExtraBoldObl',
    'Avenir-Light','Avenir-LightOblique','Avenir-Book','Avenir-BookOblique',
    'Avenir-Roman','Avenir-Oblique','Avenir-Medium','Avenir-MediumOblique',
    'Avenir-Heavy','Avenir-HeavyOblique','Avenir-Black','Avenir-BlackOblique',
    'AvenirNext-Regular','AvenirNext-Italic','AvenirNext-Medium','AvenirNext-MediumItalic',
    'AvenirNext-DemiBold','AvenirNext-DemiBoldItalic','AvenirNext-Bold','AvenirNext-BoldItalic',
    'AvenirNext-Heavy','AvenirNext-HeavyItalic'
];

function pdPopulateSelect(query, selectedFont) {
    var q = (query || '').toLowerCase();
    var prev = selectedFont || pinDropFontEl.value || 'FuturaPT-Book';
    pinDropFontEl.innerHTML = '';
    var firstOpt = null;
    for (var i = 0; i < pdAllFonts.length; i++) {
        var f = pdAllFonts[i];
        if (q && f.toLowerCase().indexOf(q) === -1) continue;
        var opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        pinDropFontEl.appendChild(opt);
        if (!firstOpt) firstOpt = opt;
    }
    // Restore selection or fall back to first visible
    pinDropFontEl.value = prev;
    if (!pinDropFontEl.value && firstOpt) pinDropFontEl.value = firstOpt.value;
}

// Initial populate
pdPopulateSelect('', 'FuturaPT-Book');

pinDropFontSearch.addEventListener('input', function() {
    pdPopulateSelect(this.value);
});

function pdSetMode(mode) {
    pdMode = mode;
    if (mode === 'address') {
        pdModeAddress.classList.add('active');
        pdModeKollosche.classList.remove('active');
        pdAddressFields.style.display = 'flex';
        pdLogoFields.style.display = 'none';
        setTimeout(function() { pinDropAddressEl.focus(); }, 50);
    } else {
        pdModeKollosche.classList.add('active');
        pdModeAddress.classList.remove('active');
        pdAddressFields.style.display = 'none';
        pdLogoFields.style.display = '';
    }
}

pdModeAddress.addEventListener('click', function() { pdSetMode('address'); });
pdModeKollosche.addEventListener('click', function() { pdSetMode('kollosche'); });

function pinDropOpen() {
    pinDropAddressEl.value = '';
    pinDropFontSearch.value = '';
    pdPopulateSelect('', 'FuturaPT-Book');
    pdSetMode('address');
    pinDropOverlay.classList.add('visible');
}

pinDropCancelBtn.addEventListener('click', function() {
    pinDropOverlay.classList.remove('visible');
});

pinDropCreateBtn.addEventListener('click', function() {
    if (pdMode === 'kollosche') {
        pinDropOverlay.classList.remove('visible');
        setStatus('Creating Kollosche Pin Drop...', 'busy');
        var logoPath = (cs ? cs.getSystemPath('extension') : '.') + '/assets/kollosche-pin.png';
        evalScript('$.evalFile("' + getJsxPath() + '"); pinDropLogo("' + logoPath + '");', function(res) {
            handleResult(res, 'Kollosche Pin Drop created!');
        });
        return;
    }
    var address = pinDropAddressEl.value.trim();
    if (!address) { pinDropAddressEl.focus(); return; }
    var font = pinDropFontEl.value;
    pinDropOverlay.classList.remove('visible');
    setStatus('Creating Pin Drop...', 'busy');
    var safeAddress = address.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    evalScript('$.evalFile("' + getJsxPath() + '"); pinDrop("' + safeAddress + '", "' + font + '");', function(res) {
        handleResult(res, 'Pin Drop created!');
    });
});

pinDropAddressEl.addEventListener('keydown', function(e) {
    if (e.keyCode === 13) pinDropCreateBtn.click();
    if (e.keyCode === 27) pinDropCancelBtn.click();
});


/* ── Color Grade Overlay ──────────────────────────── */
var colorGradeOverlay = document.getElementById('colorGradeOverlay');
var cgDroneSelect     = document.getElementById('cgDroneSelect');
var cgCameraSelect    = document.getElementById('cgCameraSelect');
var cgCreativeSelect  = document.getElementById('cgCreativeSelect');
var cgCancelBtn       = document.getElementById('cgCancelBtn');
var cgApplyBtn        = document.getElementById('cgApplyBtn');

function cgPopulateSelects(droneList, cameraList, creativeList) {
    cgDroneSelect.innerHTML    = '';
    cgCameraSelect.innerHTML   = '';
    cgCreativeSelect.innerHTML = '';

    for (var i = 0; i < droneList.length; i++) {
        var opt = document.createElement('option');
        opt.value = droneList[i];
        opt.textContent = droneList[i].replace('AG_Conversion_Drone_', '').replace('AG_Conversion_', '');
        cgDroneSelect.appendChild(opt);
    }
    var sortedCamera = cameraList.slice().sort(function(a, b) {
        var aS = a.indexOf('Slog3') !== -1 ? 0 : 1;
        var bS = b.indexOf('Slog3') !== -1 ? 0 : 1;
        return aS - bS;
    });
    for (var i = 0; i < sortedCamera.length; i++) {
        var opt = document.createElement('option');
        opt.value = sortedCamera[i];
        opt.textContent = sortedCamera[i].replace('AG_Conversion_Camera_', '').replace('AG_Conversion_', '');
        cgCameraSelect.appendChild(opt);
    }
    for (var i = 0; i < creativeList.length; i++) {
        var opt = document.createElement('option');
        opt.value = creativeList[i];
        opt.textContent = creativeList[i].replace('AG_Creative_', '');
        cgCreativeSelect.appendChild(opt);
    }

    if (cgDroneSelect.options.length    > 0) cgDroneSelect.selectedIndex    = 0;
    if (cgCameraSelect.options.length   > 0) cgCameraSelect.selectedIndex   = 0;
    if (cgCreativeSelect.options.length > 0) cgCreativeSelect.selectedIndex = 0;
}

cgCancelBtn.addEventListener('click', function() {
    colorGradeOverlay.classList.remove('visible');
});

cgApplyBtn.addEventListener('click', function() {
    var drone    = cgDroneSelect.value;
    var camera   = cgCameraSelect.value;
    var creative = cgCreativeSelect.value;
    if (!drone || !camera || !creative) { setStatus('Seleciona todos os LUTs', 'error'); return; }
    colorGradeOverlay.classList.remove('visible');
    setStatus('Applying Color Grade...', 'busy');
    evalScript('$.evalFile("' + getPrJsxPath() + '"); prColorGrade("' + drone + '", "' + camera + '", "' + creative + '");', function(res) {
        handleResult(res, 'Color Grade applied!');
    });
});

/* ── Soundboard Data ──────────────────────────────── */
var SOUND_LIBRARY = [
    {
        id: "transitions",
        label: "Transitions",
        sounds: [
            { id: "day_to_night_long",  label: "Day to Night (Long)",  file: "assets/sounds/transitions/day_to_night_long.mp3" },
            { id: "day_to_night_short", label: "Day to Night (Short)", file: "assets/sounds/transitions/day_to_night_short.mp3" },
            { id: "metallic_riser",     label: "Metallic Riser",       file: "assets/sounds/transitions/metallic_riser.mp3" },
            { id: "riser_to_sub_drop",  label: "Riser to Sub Drop",    file: "assets/sounds/transitions/riser_to_sub_drop.mp3" },
            { id: "shake",              label: "Shake",                file: "assets/sounds/transitions/shake.mp3" },
            { id: "whoosh_long",        label: "Whoosh (Long)",        file: "assets/sounds/transitions/whoosh_long.mp3" },
            { id: "whoosh_short",       label: "Whoosh (Short)",       file: "assets/sounds/transitions/whoosh_short.mp3" }
        ]
    },
    {
        id: "nature",
        label: "Nature & Ambience",
        sounds: [
            { id: "beach",          label: "Beach",          file: "assets/sounds/nature/beach.mp3" },
            { id: "birds",          label: "Birds",          file: "assets/sounds/nature/birds.mp3" },
            { id: "construction",   label: "Construction",   file: "assets/sounds/nature/construction.mp3" },
            { id: "crackling_fire", label: "Crackling Fire", file: "assets/sounds/nature/crackling_fire.mp3" },
            { id: "crickets",       label: "Crickets",       file: "assets/sounds/nature/crickets.mp3" },
            { id: "pool",           label: "Pool",           file: "assets/sounds/nature/pool.mp3" },
            { id: "timelapse",      label: "Timelapse",      file: "assets/sounds/nature/timelapse.mp3" },
            { id: "winds",          label: "Winds",          file: "assets/sounds/nature/winds.mp3" }
        ]
    },
    {
        id: "sold-reel",
        label: "Sold Reel",
        sounds: [
            { id: "cash_register",  label: "Cash Register",  file: "assets/sounds/sold-reel/cash_register.mp3" },
            { id: "number_counter", label: "Number Counter", file: "assets/sounds/sold-reel/number_counter.mp3" }
        ]
    }
];

/* ── Soundboard Overlay ───────────────────────────── */
var sbOverlay = document.getElementById('sbOverlay');
var sbContent = document.getElementById('sbContent');
var sbBackBtn = document.getElementById('sbBackBtn');

function sbOpen() {
    sbBuildUI();
    sbPreload();
    sbOverlay.classList.add('visible');
}

function sbClose() {
    sbOverlay.classList.remove('visible');
}

sbBackBtn.addEventListener('click', sbClose);

function sbBuildUI() {
    sbContent.innerHTML = '';
    SOUND_LIBRARY.forEach(function(category) {
        var catEl = document.createElement('div');
        catEl.className = 'sb-category';
        catEl.innerHTML =
            '<div class="sb-category-header">' +
                '<span class="section-title">' + category.label + '</span>' +
                '<span class="sb-category-chevron">&#9662;</span>' +
            '</div>' +
            '<div class="btn-grid"></div>';

        var grid = catEl.querySelector('.btn-grid');
        category.sounds.forEach(function(sound) {
            var btn = document.createElement('button');
            btn.className = 'btn';
            btn.textContent = sound.label;
            btn.title = sound.label;
            btn.addEventListener('click', function() { sbPlaceSound(sound, btn); });
            grid.appendChild(btn);
        });

        catEl.querySelector('.sb-category-header').addEventListener('click', function() {
            catEl.classList.toggle('collapsed');
        });

        sbContent.appendChild(catEl);
    });
}

function sbPlaceSound(sound, btn) {
    var extensionRoot = cs ? cs.getSystemPath('extension') : '.';
    var safePath = (extensionRoot + '/' + sound.file).replace(/\\/g, '/');
    var safeLabel = sound.label.replace(/"/g, '\\"');
    setStatus('Placing ' + sound.label + '...', 'busy');
    evalScript(
        '$.evalFile("' + getPrJsxPath() + '"); placeSoundAtPlayhead("' + safePath + '", "' + safeLabel + '");',
        function(res) {
            if (!res || res === 'false' || res === 'EvalScript error.') {
                handleResult('Error: could not place clip — check timeline');
            } else {
                handleResult(res, sound.label + ' placed');
            }
        }
    );
}

function sbPreload() {
    var extensionRoot = cs ? cs.getSystemPath('extension') : '.';
    var paths = [];
    SOUND_LIBRARY.forEach(function(cat) {
        cat.sounds.forEach(function(sound) {
            paths.push((extensionRoot + '/' + sound.file).replace(/\\/g, '/'));
        });
    });
    var escapedJSON = JSON.stringify(paths).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    evalScript('$.evalFile("' + getPrJsxPath() + '"); preloadSounds(\'' + escapedJSON + '\');');
}

/* ── Auth ─────────────────────────────────────────── */
var authOverlay   = document.getElementById('authOverlay');
var authLoginBtn  = document.getElementById('authLoginBtn');
var authStatus    = document.getElementById('authStatus');
var authLogoutBtn = document.getElementById('authLogoutBtn');

function authShowLogin() {
    authOverlay.classList.add('visible');
    authLogoutBtn.classList.remove('visible');
    authStatus.textContent = '';
}

function authShowApp(email) {
    authOverlay.classList.remove('visible');
    authLogoutBtn.classList.add('visible');
    authLogoutBtn.title = 'Sign out (' + email + ')';
}

authLoginBtn.addEventListener('click', function() {
    authLoginBtn.disabled = true;
    authStatus.style.color = 'var(--text-2)';
    authStatus.textContent = 'Opening Google...';

    DmAuth.login(function(email) {
        authShowApp(email);
        setStatus('Welcome, ' + email.split('@')[0] + '!', 'success');
    }, function(err) {
        authLoginBtn.disabled = false;
        authStatus.style.color = 'var(--error)';
        authStatus.textContent = err;
    });
});

authLogoutBtn.addEventListener('click', function() {
    DmAuth.logout();
    authShowLogin();
    setStatus('Ready', 'idle');
});

/* ── Updater ───────────────────────────────────────── */
function runUpdateCheck() {
    DmUpdater.check(
        function(newVersion, failed) {
            if (failed > 0) {
                setStatus('Update v' + newVersion + ' partial (' + failed + ' error(s)) — reopen panel', 'error');
            } else {
                setStatus('\u2605 Updated to v' + newVersion + ' — please reopen the panel', 'success');
            }
        },
        function() { /* already up to date — silent */ },
        function(err) { console.log('[Updater]', err); /* network error — silent */ }
    );
}

/* ── Init ─────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
    detectHost();
    DmAuth.checkAuth(function(email) {
        authShowApp(email);
        setStatus('Ready', 'idle');
        runUpdateCheck();
    }, function() {
        authShowLogin();
    });
});
