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
    startAutoCollect();
}

/* ── Auto Collect on new items ────────────────────── */
var _autoCollectTimer = null;
var _lastItemCount    = -1;

/* ── Undo tracking ────────────────────────────────── */
var _lastEffect = null; // { type, compName, layerName, timestamp }

function trackEffect(type, compName, layerName) {
    _lastEffect = { type, compName, layerName, timestamp: Date.now() };
    var undoBtn = document.getElementById('undoBtn');
    if (undoBtn) undoBtn.style.display = '';
}

function _itemCountScript() {
    if (HOST === 'PPRO') {
        // Recursively count all items in the project bin tree
        return '(function(){var n=0;function c(i){n++;if(i.children&&i.children.numItems>0)for(var j=0;j<i.children.numItems;j++)c(i.children[j]);}var r=app.project.rootItem;if(r.children)for(var j=0;j<r.children.numItems;j++)c(r.children[j]);return String(n);})()';
    } else {
        return 'String(app.project.numItems)';
    }
}

function startAutoCollect() {
    if (_autoCollectTimer) return;
    _autoCollectTimer = setInterval(function() {
        if (HOST !== 'AEFT' && HOST !== 'PPRO') return;
        evalScript(_itemCountScript(), function(res) {
            var count = parseInt(res, 10);
            if (isNaN(count)) return;
            if (_lastItemCount < 0) { _lastItemCount = count; return; } // baseline
            if (count > _lastItemCount) {
                _lastItemCount = count;
                var script = HOST === 'PPRO'
                    ? '$.evalFile("' + getPrJsxPath() + '"); prCollectFiles();'
                    : '$.evalFile("' + getJsxPath() + '"); aeCollectFiles();';
                evalScript(script, function(collectRes) {
                    if (collectRes && collectRes.indexOf('Error') === -1 && collectRes !== '__dev__') {
                        setStatus('Auto-collect: ' + collectRes, 'success');
                    }
                });
            } else {
                _lastItemCount = count;
            }
        });
    }, 30 * 60 * 1000); // check every 30min — lightweight, no file I/O unless count grew
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
            if (!res || res === 'undefined' || res === '__dev__' || (res && res.indexOf('Error') !== 0 && res.indexOf('error') !== 0)) {
                trackEffect('Warp / Comp', null, null);
            }
            handleResult(res);
        });
    },
    motionBlur: function() {
        setStatus('Applying Motion Blur...', 'busy');
        evalScript('$.evalFile("' + getJsxPath() + '"); motionBlur();', function(res) {
            if (!res || res === 'undefined' || res === '__dev__' || (res && res.indexOf('Error') !== 0 && res.indexOf('error') !== 0)) {
                trackEffect('Motion Blur', null, null);
            }
            handleResult(res);
        });
    },
    dayToNight: function() {
        setStatus('Applying Day to Night...', 'busy');
        evalScript('$.evalFile("' + getJsxPath() + '"); dayToNight();', function(res) {
            if (!res || res === 'undefined' || res === '__dev__' || (res && res.indexOf('Error') !== 0 && res.indexOf('error') !== 0)) {
                trackEffect('Day to Night', null, null);
            }
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
            if (!res || res === 'undefined' || res === '__dev__' || (res && res.indexOf('Error') !== 0 && res.indexOf('error') !== 0)) {
                trackEffect('Intro Ramp', null, null);
            }
            handleResult(res, 'Intro Ramp applied!');
        });
    },
    middleRamp: function() {
        setStatus('Applying Middle Ramp...', 'busy');
        var intensity = getIntensity();
        evalScript('$.evalFile("' + getJsxPath() + '"); middleRamp(' + intensity + ');', function(res) {
            if (!res || res === 'undefined' || res === '__dev__' || (res && res.indexOf('Error') !== 0 && res.indexOf('error') !== 0)) {
                trackEffect('Middle Ramp', null, null);
            }
            handleResult(res, 'Middle Ramp applied!');
        });
    },
    outroRamp: function() {
        setStatus('Applying Outro Ramp...', 'busy');
        var intensity = getIntensity();
        evalScript('$.evalFile("' + getJsxPath() + '"); outroRamp(' + intensity + ');', function(res) {
            if (!res || res === 'undefined' || res === '__dev__' || (res && res.indexOf('Error') !== 0 && res.indexOf('error') !== 0)) {
                trackEffect('Outro Ramp', null, null);
            }
            handleResult(res, 'Outro Ramp applied!');
        });
    },


    // ── Direction Shake ───────────────────────────────
    directionShake: function() {
        setStatus('Applying Direction Shake...', 'busy');
        evalScript('$.evalFile("' + getJsxPath() + '"); applyDirectionShake();', function(res) {
            if (!res || res === 'undefined' || res === '__dev__' || (res && res.indexOf('Error') !== 0 && res.indexOf('error') !== 0)) {
                trackEffect('Direction Shake', null, 'DM Shake');
            }
            handleResult(res, 'Direction Shake applied!');
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

/* ── Undo Button ──────────────────────────────────── */
document.getElementById('undoBtn').addEventListener('click', function() {
    if (!_lastEffect) return;
    setStatus('Undoing ' + _lastEffect.type + '...', 'busy');
    var undoScript = HOST === 'PPRO'
        ? '$.evalFile("' + getPrJsxPath() + '"); undoLastEffect("' + (_lastEffect.compName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '", "' + (_lastEffect.layerName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '");'
        : '$.evalFile("' + getJsxPath() + '"); undoLastEffect("' + (_lastEffect.compName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '", "' + (_lastEffect.layerName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '");';
    evalScript(undoScript, function(res) {
        if (!res || res === 'undefined' || res === '__dev__') {
            setStatus('Effect undone!', 'success');
            _lastEffect = null;
            document.getElementById('undoBtn').style.display = 'none';
        } else if (res.indexOf('Error') === 0 || res.indexOf('error') === 0) {
            setStatus(res, 'error');
        } else {
            setStatus(res || 'Effect undone!', 'success');
            _lastEffect = null;
            document.getElementById('undoBtn').style.display = 'none';
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
var pdModeTown        = document.getElementById('pdModeTown');
var pdAddressFields   = document.getElementById('pdAddressFields');
var pdLogoFields      = document.getElementById('pdLogoFields');
var pdTownFields      = document.getElementById('pdTownFields');
var pdMode = 'address'; // 'address' | 'kollosche' | 'town'

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
    pdModeAddress.classList.toggle('active',   mode === 'address');
    pdModeKollosche.classList.toggle('active', mode === 'kollosche');
    pdModeTown.classList.toggle('active',      mode === 'town');
    pdAddressFields.style.display = mode === 'address'   ? 'flex' : 'none';
    pdLogoFields.style.display    = mode === 'kollosche' ? ''     : 'none';
    pdTownFields.style.display    = mode === 'town'      ? ''     : 'none';
    if (mode === 'address') setTimeout(function() { pinDropAddressEl.focus(); }, 50);
}

pdModeAddress.addEventListener('click',   function() { pdSetMode('address'); });
pdModeKollosche.addEventListener('click', function() { pdSetMode('kollosche'); });
pdModeTown.addEventListener('click',      function() { pdSetMode('town'); });

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
    if (pdMode === 'town') {
        pinDropOverlay.classList.remove('visible');
        setStatus('Creating Town Pin Drop...', 'busy');
        var townMp4 = '/Volumes/SSD NAS - WIP/Media Resources/Assets_icons and logos/Real Estate and Developers/Town Real Estate/Drone Pin.mp4';
        evalScript('$.evalFile("' + getJsxPath() + '"); pinDropTown("' + townMp4.replace(/\\/g, '\\\\') + '");', function(res) {
            handleResult(res, 'Town Pin Drop created!');
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
            var msg = failed > 0
                ? 'Update v' + newVersion + ' partial — reopen panel'
                : '\u2605 Updated to v' + newVersion + ' — please reopen the panel';
            // Persist update message — do not auto-clear
            if (statusTimeout) clearTimeout(statusTimeout);
            var dot   = document.getElementById('statusDot');
            var msgEl = document.getElementById('statusMsg');
            if (dot)   dot.className   = 'status-dot status-dot--success';
            if (msgEl) msgEl.textContent = msg;
            var vb = document.getElementById('versionBadge');
            if (vb) vb.textContent = 'v' + newVersion + ' ↑';
        },
        function() { /* already up to date — silent */ },
        function(err) { setStatus('Update check failed: ' + err, 'error'); }
    );
}

/* ── Init ─────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
    detectHost();
    var vb = document.getElementById('versionBadge');
    if (vb) vb.textContent = 'v' + DmUpdater.version;
    DmAuth.checkAuth(function(email) {
        authShowApp(email);
        setStatus('Ready', 'idle');
        runUpdateCheck();
    }, function() {
        authShowLogin();
    });
});

/* ── Music Drop Align ─────────────────────────────── */
(function() {
    var FFMPEG_PATHS = ['ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg',
        '/Users/desiremedia/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg',
        '/Applications/Wavdrop.app/Contents/Resources/ffmpeg'];

    function findFfmpeg() {
        var fs = require('fs');
        for (var i = 1; i < FFMPEG_PATHS.length; i++) {
            try { if (fs.existsSync(FFMPEG_PATHS[i])) return FFMPEG_PATHS[i]; } catch (_) {}
        }
        return FFMPEG_PATHS[0];
    }

    // Decode to mono 11025Hz PCM and analyze: returns {bpm, dropTime}
    function analyzeMusic(srcPath) {
        var os = require('os'), fs = require('fs'), cp = require('child_process');
        var raw = os.tmpdir() + '/dm_music_' + Date.now() + '.pcm';
        cp.execFileSync(findFfmpeg(), ['-y', '-i', srcPath, '-ac', '1', '-ar', '11025', '-f', 's16le', raw],
            { timeout: 120000 });
        var buf = fs.readFileSync(raw);
        try { fs.unlinkSync(raw); } catch (_) {}

        var SR = 11025, HOP = 110, WIN = 441;           // ~10ms hop, 40ms window
        var hopSec = HOP / SR;
        var n = Math.floor((buf.length / 2 - WIN) / HOP);
        if (n < 500) throw new Error('Music too short to analyze');

        var env = new Float64Array(n);
        for (var i = 0; i < n; i++) {
            var acc = 0, base = i * HOP;
            for (var j = 0; j < WIN; j += 3) {           // stride 3 for speed
                var s = buf.readInt16LE((base + j) * 2) / 32768;
                acc += s * s;
            }
            env[i] = Math.sqrt(acc / (WIN / 3));
        }

        // Onset envelope
        var onset = new Float64Array(n);
        for (var k = 1; k < n; k++) onset[k] = Math.max(0, env[k] - env[k - 1]);

        // BPM via autocorrelation of onsets: 60-180 BPM -> lag 100..33 frames
        var bestLag = 0, bestScore = -1;
        for (var lag = 33; lag <= 100; lag++) {
            var sc = 0;
            for (var m = lag; m < n; m++) sc += onset[m] * onset[m - lag];
            if (sc > bestScore) { bestScore = sc; bestLag = lag; }
        }
        var bpm = 60 / (bestLag * hopSec);
        if (bpm < 85) bpm *= 2;   // half-time correction

        // Drop: biggest sustained energy jump (2s windows), search 5s..90s
        var W = Math.round(2 / hopSec);
        var from = Math.round(5 / hopSec);
        var to = Math.min(n - W - 1, Math.round(90 / hopSec));
        var dropFrame = from, bestJump = -1;
        for (var t = from; t < to; t++) {
            var b = 0, a = 0;
            for (var q = 0; q < W; q++) { b += env[t - q]; a += env[t + q]; }
            var jump = (a - b) / W;
            if (jump > bestJump) { bestJump = jump; dropFrame = t; }
        }
        // Snap to strongest onset within ±0.25s
        var rad = Math.round(0.25 / hopSec);
        var snap = dropFrame, snapVal = -1;
        for (var r = Math.max(1, dropFrame - rad); r <= Math.min(n - 1, dropFrame + rad); r++) {
            if (onset[r] > snapVal) { snapVal = onset[r]; snap = r; }
        }
        return { bpm: Math.round(bpm * 10) / 10, dropTime: snap * hopSec };
    }

    var mdBtn = document.getElementById('prMusicDrop');
    if (!mdBtn) return;
    mdBtn.addEventListener('click', function() {
        if (HOST !== 'PPRO') { setStatus('Music Drop only works in Premiere', 'error'); return; }
        mdBtn.disabled = true;
        setStatus('Finding music on timeline...', 'busy');

        var jsxFind = '(function(){' +
            'var seq=app.project.activeSequence;' +
            'if(!seq)return JSON.stringify({error:"No active sequence"});' +
            'var vEnd=0;' +
            'for(var v=0;v<seq.videoTracks.numTracks;v++){var vt=seq.videoTracks[v];' +
            'for(var c=0;c<vt.clips.numItems;c++){var e=vt.clips[c].end.seconds;if(e>vEnd)vEnd=e;}}' +
            'var pick=null;' +
            'for(var a=0;a<seq.audioTracks.numTracks&&!pick;a++){var at=seq.audioTracks[a];' +
            'for(var c2=0;c2<at.clips.numItems;c2++){var cl=at.clips[c2];' +
            'if(cl.isSelected()){pick={t:a,c:c2,cl:cl};break;}}}' +
            'if(!pick){for(var a2=0;a2<seq.audioTracks.numTracks&&!pick;a2++){var at2=seq.audioTracks[a2];' +
            'if(at2.clips.numItems>0)pick={t:a2,c:0,cl:at2.clips[0]};}}' +
            'if(!pick)return JSON.stringify({error:"No audio clip found on timeline"});' +
            'var p="";try{p=pick.cl.projectItem.getMediaPath();}catch(e){}' +
            'if(!p)return JSON.stringify({error:"Could not read music file path"});' +
            'return JSON.stringify({path:p,track:pick.t,clip:pick.c,videoEnd:vEnd});}())';

        evalScript(jsxFind, function(res) {
            var info;
            try { info = JSON.parse(res); } catch (_) { info = { error: 'JSX parse failed' }; }
            if (info.error) { setStatus(info.error, 'error'); mdBtn.disabled = false; return; }

            setStatus('Analyzing music (BPM + drop)...', 'busy');
            setTimeout(function() {
                var a;
                try { a = analyzeMusic(info.path); }
                catch (e) { setStatus('Analyze failed: ' + e.message, 'error'); mdBtn.disabled = false; return; }

                // Pick drop target: multiple of one bar (4 beats) inside 10-15s, closest to 12.5s
                var bar = 240 / a.bpm;
                var target = null, bestDist = 1e9;
                for (var k = 1; k * bar <= 20; k++) {
                    var t = k * bar;
                    if (t >= 10 && t <= 15 && Math.abs(t - 12.5) < bestDist) { bestDist = Math.abs(t - 12.5); target = t; }
                }
                if (target === null) { target = Math.max(10, Math.min(15, Math.round(12.5 / bar) * bar)); }

                var trimIn = a.dropTime - target;
                if (trimIn < 0) { target = a.dropTime; trimIn = 0; }  // drop earlier than target: keep from 0

                setStatus('BPM ' + a.bpm + ', drop @' + a.dropTime.toFixed(1) + 's -> placing at ' + target.toFixed(1) + 's...', 'busy');

                var jsxApply = '(function(){' +
                    'var seq=app.project.activeSequence;' +
                    'var tr=seq.audioTracks[' + info.track + '];' +
                    'var cl=tr.clips[' + info.clip + '];' +
                    'var pi=cl.projectItem;' +
                    'try{pi.setInPoint(' + trimIn.toFixed(4) + ',4);}catch(e){return JSON.stringify({error:"setInPoint: "+e.message});}' +
                    'try{pi.setOutPoint(' + (trimIn + info.videoEnd).toFixed(4) + ',4);}catch(e){}' +
                    'try{cl.remove(false,false);}catch(e){return JSON.stringify({error:"remove: "+e.message});}' +
                    'try{tr.overwriteClip(pi,0);}catch(e){return JSON.stringify({error:"overwrite: "+e.message});}' +
                    'try{pi.clearInPoint(4);pi.clearOutPoint(4);}catch(e){}' +
                    'return JSON.stringify({ok:1});}())';

                evalScript(jsxApply, function(res2) {
                    var r;
                    try { r = JSON.parse(res2); } catch (_) { r = { error: 'apply parse failed: ' + res2 }; }
                    if (r.error) setStatus('Apply failed: ' + r.error, 'error');
                    else setStatus('Music aligned: drop @' + target.toFixed(1) + 's (BPM ' + a.bpm + ')', 'success');
                    mdBtn.disabled = false;
                });
            }, 50);
        });
    });
})();
