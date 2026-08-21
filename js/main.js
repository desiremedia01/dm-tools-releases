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
        var dlSection = document.getElementById('downloadSection');
        if (dlSection) dlSection.style.display = '';
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
var intensitySlider = document.getElementById('intensitySlider'); // removed from UI

function getIntensity() {
    return 100;
}

// Update slider track fill
if (intensitySlider) intensitySlider.addEventListener('input', function() {
    var pct = (this.value / 100) * 100;
    this.style.background = 'linear-gradient(to right, #0693e3 ' + pct + '%, #2a2a2a ' + pct + '%)';
});

// Init slider fill
(function() {
    if (!intensitySlider) return;
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
        var intensity = 100;
        evalScript('$.evalFile("' + getJsxPath() + '"); introRamp(' + intensity + ');', function(res) {
            if (!res || res === 'undefined' || res === '__dev__' || (res && res.indexOf('Error') !== 0 && res.indexOf('error') !== 0)) {
                trackEffect('Intro Ramp', null, null);
            }
            handleResult(res, 'Intro Ramp applied!');
        });
    },
    middleRamp: function() {
        setStatus('Applying Middle Ramp...', 'busy');
        var intensity = 100;
        evalScript('$.evalFile("' + getJsxPath() + '"); middleRamp(' + intensity + ');', function(res) {
            if (!res || res === 'undefined' || res === '__dev__' || (res && res.indexOf('Error') !== 0 && res.indexOf('error') !== 0)) {
                trackEffect('Middle Ramp', null, null);
            }
            handleResult(res, 'Middle Ramp applied!');
        });
    },
    outroRamp: function() {
        setStatus('Applying Outro Ramp...', 'busy');
        var intensity = 75;
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
    if (!drone || !camera || !creative) { setStatus('Select all three LUTs', 'error'); return; }
    colorGradeOverlay.classList.remove('visible');
    setStatus('Applying Color Grade...', 'busy');
    // colorGrade.js le os comps .aep e cobre eles na track de conversao;
    // sem o modulo, cai no caminho antigo (comps pulados)
    if (window.DM_applyColorGrade) { window.DM_applyColorGrade(drone, camera, creative); return; }
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
            { id: "reverse_cymbal_riser", label: "Reverse Cymbal Riser", file: "assets/sounds/transitions/reverse_cymbal_riser.mp3" },
            { id: "riser_to_sub_drop",  label: "Riser to Sub Drop",    file: "assets/sounds/transitions/riser_to_sub_drop.mp3" },
            { id: "shake",              label: "Shake",                file: "assets/sounds/transitions/shake.mp3" },
            { id: "sunlight",           label: "Sunlight",             file: "assets/sounds/transitions/sunlight.mp3" },
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
            { id: "nature_timelapse", label: "Nature Timelapse", file: "assets/sounds/nature/nature_timelapse.mp3" },
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
    },
    {
        id: "others",
        label: "Others",
        sounds: [
            { id: "camera_shutter", label: "Camera Shutter", file: "assets/sounds/others/camera_shutter.mp3" },
            { id: "click",          label: "Click",          file: "assets/sounds/others/click.mp3" },
            { id: "door_open",      label: "Door Open",      file: "assets/sounds/others/door_open.mp3" },
            { id: "plop",           label: "Plop",           file: "assets/sounds/others/plop.mp3" }
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
            btn.title = 'Click to place at playhead, or drag to the timeline';
            var extensionRoot = cs ? cs.getSystemPath('extension') : '.';
            var filePath = (extensionRoot + '/' + sound.file).replace(/\\/g, '/');
            btn.style.cursor = 'grab';
            btn.setAttribute('draggable', 'true');
            btn._dragged = false;
            btn.addEventListener('dragstart', function(e) {
                btn._dragged = true;
                try {
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('com.adobe.cep.dnd.file.0', filePath);
                } catch (err) {}
            });
            btn.addEventListener('click', function() {
                if (btn._dragged) { btn._dragged = false; return; }   // click fired after a drag — ignore
                sbPlaceSound(sound, btn);
            });
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
        function(newVersion, failed, notes) {
            if (notes && notes.length) {
                var ov = document.createElement('div');
                ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
                var items = '';
                for (var ni = 0; ni < notes.length; ni++) {
                    items += '<li style="margin-bottom:7px;line-height:1.45">' + notes[ni] + '</li>';
                }
                ov.innerHTML = '<div style="background:#1e1e1e;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:18px 20px;max-width:340px;max-height:70%;overflow-y:auto">' +
                    '<div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">\u2728 DM Tools v' + newVersion + '</div>' +
                    '<div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:12px">What\u2019s new</div>' +
                    '<ul style="font-size:12px;color:rgba(255,255,255,0.85);padding-left:18px;margin:0 0 14px 0">' + items + '</ul>' +
                    '<button id="dmWhatsNewOk" class="btn btn--accent" style="width:100%">OK \u2014 reopen panel to apply</button></div>';
                document.body.appendChild(ov);
                document.getElementById('dmWhatsNewOk').onclick = function() { ov.remove(); };
            }
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
/* ── Sound Sync ───────────────────────────────────────────────────────
   Keeps assets/sounds in sync with the release repo. Runs in the background
   on panel load: fetches sounds.json, downloads any missing / size-mismatched
   audio as binary (base64) — code updates can't ship binaries, so this does. */
var DmSoundSync = (function () {
    var SOUNDS_URL = 'https://raw.githubusercontent.com/desiremedia01/dm-tools-releases/main/sounds.json';
    var RAW_BASE   = 'https://raw.githubusercontent.com/desiremedia01/dm-tools-releases/main/';

    function root() {
        try { return (typeof cs !== 'undefined' && cs) ? cs.getSystemPath('extension') : '.'; }
        catch (e) { return '.'; }
    }
    function localSize(relPath) {
        try {
            var r = window.cep.fs.stat(root() + '/' + relPath);
            return (r && r.err === 0 && r.data) ? r.data.size : -1;
        } catch (e) { return -1; }
    }
    function fetchTextS(url, cb) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url + '?t=' + Date.now(), true);
            xhr.timeout = 15000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                cb(xhr.status === 200 ? null : 'HTTP ' + xhr.status, xhr.responseText);
            };
            xhr.ontimeout = function () { cb('timeout'); };
            xhr.onerror = function () { cb('network'); };
            xhr.send();
        } catch (e) { cb('exc'); }
    }
    function fetchBinB64(url, cb) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url + '?t=' + Date.now(), true);
            xhr.responseType = 'arraybuffer';
            xhr.timeout = 60000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status !== 200) { cb('HTTP ' + xhr.status); return; }
                try {
                    var b = new Uint8Array(xhr.response), s = '';
                    for (var i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
                    cb(null, btoa(s));
                } catch (e) { cb('decode'); }
            };
            xhr.ontimeout = function () { cb('timeout'); };
            xhr.onerror = function () { cb('network'); };
            xhr.send();
        } catch (e) { cb('exc'); }
    }
    function writeBin(relPath, b64) {
        try {
            var parts = relPath.split('/'), dir = root();
            for (var i = 0; i < parts.length - 1; i++) { dir += '/' + parts[i]; try { window.cep.fs.makedir(dir); } catch (e) {} }
            var res = window.cep.fs.writeFile(root() + '/' + relPath, b64, cep.encoding.Base64);
            return res && res.err === 0;
        } catch (e) { return false; }
    }

    function run() {
        if (!(window.cep && window.cep.fs)) return; // dev mode / no CEP fs
        fetchTextS(SOUNDS_URL, function (err, txt) {
            if (err) return; // no manifest yet — silent
            var list;
            try { list = JSON.parse(txt).sounds || []; } catch (e) { return; }
            var missing = list.filter(function (s) {
                var sz = localSize(s.path);
                return sz < 0 || (s.size && Math.abs(sz - s.size) > 16);
            });
            if (!missing.length) return;
            var pending = missing.length, done = 0, failed = 0;
            setStatus('Syncing ' + missing.length + ' sound' + (missing.length > 1 ? 's' : '') + '...', 'busy');
            missing.forEach(function (s) {
                fetchBinB64(RAW_BASE + s.path, function (e2, b64) {
                    if (e2 || !writeBin(s.path, b64)) failed++; else done++;
                    if (--pending === 0) {
                        if (failed) setStatus('Sounds synced (' + done + ' ok, ' + failed + ' failed)', done ? 'success' : 'error');
                        else setStatus('Sounds synced: ' + done + ' added \u2713', 'success');
                    }
                });
            });
        });
    }
    return { run: run };
})();

/* ── Binary Sync (bundled ffmpeg) ─────────────────────────────────────
   Ships a modern ffmpeg (8.1) so every machine can process any camera,
   not just those with Wavdrop/static installed. Downloads binaries.json
   entries as base64, writes them, and sets the exec bit. */
var DmBinSync = (function () {
    var BIN_URL  = 'https://raw.githubusercontent.com/desiremedia01/dm-tools-releases/main/binaries.json';
    var RAW_BASE = 'https://raw.githubusercontent.com/desiremedia01/dm-tools-releases/main/';

    function root() { try { return (typeof cs !== 'undefined' && cs) ? cs.getSystemPath('extension') : '.'; } catch (e) { return '.'; } }
    function localSize(rel) { try { var r = window.cep.fs.stat(root() + '/' + rel); return (r && r.err === 0 && r.data) ? r.data.size : -1; } catch (e) { return -1; } }
    function fetchTextS(url, cb) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url + '?t=' + Date.now(), true); xhr.timeout = 15000;
            xhr.onreadystatechange = function () { if (xhr.readyState === 4) cb(xhr.status === 200 ? null : 'HTTP ' + xhr.status, xhr.responseText); };
            xhr.ontimeout = function () { cb('timeout'); }; xhr.onerror = function () { cb('network'); }; xhr.send();
        } catch (e) { cb('exc'); }
    }
    function fetchBinB64(url, cb) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url + '?t=' + Date.now(), true); xhr.responseType = 'arraybuffer'; xhr.timeout = 300000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status !== 200) { cb('HTTP ' + xhr.status); return; }
                try { var b = new Uint8Array(xhr.response), s = ''; for (var i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); cb(null, btoa(s)); }
                catch (e) { cb('decode'); }
            };
            xhr.ontimeout = function () { cb('timeout'); }; xhr.onerror = function () { cb('network'); }; xhr.send();
        } catch (e) { cb('exc'); }
    }
    function writeBin(rel, b64, exec) {
        try {
            var parts = rel.split('/'), dir = root();
            for (var i = 0; i < parts.length - 1; i++) { dir += '/' + parts[i]; try { window.cep.fs.makedir(dir); } catch (e) {} }
            var full = root() + '/' + rel;
            var res = window.cep.fs.writeFile(full, b64, cep.encoding.Base64);
            if (!res || res.err !== 0) return false;
            if (exec) { try { require('fs').chmodSync(full, 0o755); } catch (e) {} }
            return true;
        } catch (e) { return false; }
    }

    function ffmpegPath() {
        try {
            var full = root() + '/bin/ffmpeg';
            if (require('fs').existsSync(full)) return full;
        } catch (e) {}
        return null;
    }

    function run() {
        if (!(window.cep && window.cep.fs)) return;
        fetchTextS(BIN_URL, function (err, txt) {
            if (err) return;
            var list; try { list = JSON.parse(txt).binaries || []; } catch (e) { return; }
            var missing = list.filter(function (b) { var sz = localSize(b.path); return sz < 0 || (b.size && Math.abs(sz - b.size) > 64); });
            if (!missing.length) { // ensure exec bit even if already present
                list.forEach(function (b) { if (b.exec) { try { require('fs').chmodSync(root() + '/' + b.path, 0o755); } catch (e) {} } });
                return;
            }
            var pending = missing.length, ok = 0;
            setStatus('Downloading ffmpeg (one-time, ~80MB)...', 'busy');
            missing.forEach(function (b) {
                fetchBinB64(RAW_BASE + b.path, function (e2, b64) {
                    if (!e2 && writeBin(b.path, b64, b.exec)) ok++;
                    if (--pending === 0) setStatus(ok ? 'ffmpeg installed \u2713' : 'ffmpeg download failed', ok ? 'success' : 'error');
                });
            });
        });
    }
    return { run: run, ffmpegPath: ffmpegPath };
})();
// Global resolver: bundled ffmpeg first, used by all features
window.DM_BUNDLED_FFMPEG = function () { try { return DmBinSync.ffmpegPath(); } catch (e) { return null; } };

document.addEventListener('DOMContentLoaded', function() {
    detectHost();
    var vb = document.getElementById('versionBadge');
    if (vb) vb.textContent = 'v' + DmUpdater.version;
    DmAuth.checkAuth(function(email) {
        authShowApp(email);
        setStatus('Ready', 'idle');
        runUpdateCheck();
        setTimeout(function(){ try { DmBinSync.run(); } catch(e){} }, 3000);
        setTimeout(function(){ try { DmSoundSync.run(); } catch(e){} }, 6000);
    }, function() {
        authShowLogin();
    });
});
