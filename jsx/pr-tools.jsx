/* ── DM Tools — Premiere Pro Tools ───────────────── */

/* ── Warp Stabilizer ─────────────────────────────── */
function prWarpStabilizer() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) throw "No active sequence.";

        var sel = seq.getSelection();
        if (!sel || sel.length === 0) throw "Select a clip first.";

        // ── Look up Warp Stabilizer effect once ──
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) throw "Could not access QE sequence.";

        var wsName = null;
        var fxList = qe.project.getVideoEffectList();
        for (var fi = 0; fi < fxList.length; fi++) {
            if (fxList[fi].toLowerCase().indexOf("warp stabilizer") !== -1) {
                wsName = fxList[fi]; break;
            }
        }
        if (!wsName) throw "Warp Stabilizer not found in effect list.";

        var wsEffect = qe.project.getVideoEffectByName(wsName);
        if (!wsEffect) throw "Could not get effect object for: " + wsName;

        // ── Apply to every selected clip ──
        var applied = 0, skipped = 0;

        for (var s = 0; s < sel.length; s++) {
            var clip = sel[s];
            var clipStartTicks = clip.start.ticks;
            var clipEndTicks   = clip.end.ticks;

            // Find track index
            var trackIdx = -1;
            for (var t = 0; t < seq.videoTracks.numTracks; t++) {
                var tr = seq.videoTracks[t];
                for (var c = 0; c < tr.clips.numItems; c++) {
                    var tc = tr.clips[c];
                    if (tc.start.ticks === clipStartTicks && tc.end.ticks === clipEndTicks) {
                        trackIdx = t; break;
                    }
                }
                if (trackIdx !== -1) break;
            }
            if (trackIdx === -1) { skipped++; continue; }

            // Find QE clip
            var qeTrack = qeSeq.getVideoTrackAt(trackIdx);
            if (!qeTrack) { skipped++; continue; }

            var qeClip = null;
            for (var i = 0; i < qeTrack.numItems; i++) {
                var item = qeTrack.getItemAt(i);
                if (item && item.start && item.start.ticks === clipStartTicks) {
                    qeClip = item; break;
                }
            }
            if (!qeClip) { skipped++; continue; }

            try { qeClip.addVideoEffect(wsEffect); applied++; } catch(e) { skipped++; }
        }

        if (applied === 0) throw "Could not apply Warp Stabilizer to any clip.";
        var msg = "Warp Stabilizer applied to " + applied + " clip" + (applied > 1 ? "s" : "") + "!";
        if (skipped > 0) msg += " (" + skipped + " skipped)";
        return msg;

    } catch(e) { return "Error: " + e; }
}

/* ── Collect Files ───────────────────────────────── */
function prCollectFiles() {
    try {
        var projPath = app.project.path;
        if (!projPath || projPath === "") throw "Save your project first.";

        // .prproj lives in "Project Files/" — go up 2 levels to reach root
        var projFile        = new File(projPath);
        var projFilesFolder = projFile.parent;       // …/Project Files/
        var rootFolder      = projFilesFolder.parent; // …/[Root]/
        var rootPath        = rootFolder.fsName;

        var assetsFolder = new Folder(rootPath + "/Assets");
        if (!assetsFolder.exists) assetsFolder.create();

        var count  = 0;
        var errors = 0;

        function collectItem(item) {
            if (!item) return;
            if (item.type === ProjectItemType.CLIP || item.type === ProjectItemType.FILE) {
                try {
                    var mediaPath = item.getMediaPath();
                    if (mediaPath && mediaPath !== "") {
                        var srcFile = new File(mediaPath);
                        var srcPath = srcFile.fsName;

                        // Skip: already inside the project root
                        if (srcPath.indexOf(rootPath) === 0) return;
                        // Skip: on any mounted volume (NAS, external drives)
                        if (srcPath.indexOf("/Volumes/") === 0) return;
                        // Skip: file doesn't exist on disk
                        if (!srcFile.exists) return;

                        var destFile = new File(assetsFolder.fsName + "/" + srcFile.name);
                        if (srcPath !== destFile.fsName) {
                            srcFile.copy(destFile.fsName);
                        }
                        item.changeMediaPath(destFile.fsName, false);
                        count++;
                    }
                } catch(e) { errors++; }
            }
            if (item.children && item.children.numItems > 0) {
                for (var i = 0; i < item.children.numItems; i++) {
                    collectItem(item.children[i]);
                }
            }
        }

        collectItem(app.project.rootItem);

        app.project.save();
        var msg = count + " file(s) collected to Assets/";
        if (errors > 0) msg += " (" + errors + " skipped)";
        return msg;

    } catch(e) { return "Error: " + e; }
}

/* ── Soundboard ───────────────────────────────────── */
function preloadSounds(pathsJSON) {
    try {
        var paths   = JSON.parse(pathsJSON);
        var project = app.project;
        var sfxBin  = getOrCreateBin(project.rootItem, "sfx");
        var toImport = [];
        for (var i = 0; i < paths.length; i++) {
            if (!findClipByPath(project.rootItem, paths[i])) {
                toImport.push(paths[i]);
            }
        }
        if (toImport.length > 0) {
            project.importFiles(toImport, true, sfxBin, false);
        }
        return "true";
    } catch(e) { return "false"; }
}

function placeSoundAtPlayhead(filePath, soundLabel) {
    try {
        var project  = app.project;
        var sequence = project.activeSequence;
        if (!sequence) return "false";

        var playheadTime = sequence.getPlayerPosition();
        var clip = findClipByPath(project.rootItem, filePath);

        if (!clip) {
            var sfxBin = getOrCreateBin(project.rootItem, "sfx");
            project.importFiles([filePath], true, sfxBin, false);
            clip = findClipByPath(project.rootItem, filePath);
        }
        if (!clip) return "false";

        /* Get sound duration */
        var soundDuration = 60;
        try {
            var outPt = clip.getOutPoint();
            var inPt  = clip.getInPoint();
            if (outPt && inPt) soundDuration = outPt.seconds - inPt.seconds;
        } catch(e) {}

        var phStart = playheadTime.seconds;
        var phEnd   = phStart + soundDuration;

        var audioTracks = sequence.audioTracks;
        var targetTrack = null;
        for (var i = 0; i < audioTracks.numTracks; i++) {
            if (isTrackFreeFor(audioTracks[i], phStart, phEnd)) {
                targetTrack = audioTracks[i];
                break;
            }
        }
        if (!targetTrack) {
            sequence.audioTracks.add();
            targetTrack = audioTracks[audioTracks.numTracks - 1];
        }

        targetTrack.overwriteClip(clip, playheadTime);
        return "true";
    } catch(e) { return "false"; }
}

function isTrackFreeFor(track, startSeconds, endSeconds) {
    var clips = track.clips;
    for (var i = 0; i < clips.numItems; i++) {
        var c = clips[i];
        if (!(c.end.seconds <= startSeconds || c.start.seconds >= endSeconds)) return false;
    }
    return true;
}

function findClipByPath(rootItem, filePath) {
    for (var i = 0; i < rootItem.children.numItems; i++) {
        var item = rootItem.children[i];
        if (item.type === ProjectItemType.CLIP) {
            var itemPath = item.getMediaPath().replace(/\\/g, "/");
            if (itemPath === filePath) return item;
        }
        if (item.type === ProjectItemType.BIN) {
            var found = findClipByPath(item, filePath);
            if (found) return found;
        }
    }
    return null;
}

function getOrCreateBin(parentItem, name) {
    for (var i = 0; i < parentItem.children.numItems; i++) {
        var item = parentItem.children[i];
        if (item.type === ProjectItemType.BIN && item.name === name) return item;
    }
    return parentItem.createBin(name);
}

/* ── Color Grade — Scan AG Items ─────────────────── */
var DRONE_SUFFIXES  = ['Air3','Avata','Mavic3','Mavic4','Dlog','Mini3','Mini4'];
var CAMERA_SUFFIXES = ['Slog3','Slog2','Clog2','Clog3','Flog2','Flog','RED','Braw','Vlog'];

function classifyConversion(name) {
    // Explicit prefixes (new naming)
    if (name.indexOf('AG_Conversion_Drone_') === 0)  return 'drone';
    if (name.indexOf('AG_Conversion_Camera_') === 0) return 'camera';
    // Fallback: match by known suffixes (old naming e.g. AG_Conversion_Air3)
    if (name.indexOf('AG_Conversion_') === 0) {
        var suffix = name.replace('AG_Conversion_', '');
        var i;
        for (i = 0; i < DRONE_SUFFIXES.length; i++) {
            if (suffix === DRONE_SUFFIXES[i] || suffix.indexOf(DRONE_SUFFIXES[i]) === 0) return 'drone';
        }
        for (i = 0; i < CAMERA_SUFFIXES.length; i++) {
            if (suffix === CAMERA_SUFFIXES[i] || suffix.indexOf(CAMERA_SUFFIXES[i]) === 0) return 'camera';
        }
    }
    return null;
}

function prGetAGItems() {
    try {
        var drone = [], camera = [], creative = [], debug = [];
        function searchBin(bin) {
            if (!bin || !bin.children) return;
            for (var i = 0; i < bin.children.numItems; i++) {
                var item = bin.children[i];
                try {
                    var n = item.name;
                    if (n.indexOf('AG_') === 0) debug.push(n);
                    var kind = classifyConversion(n);
                    if      (kind === 'drone')  drone.push(n);
                    else if (kind === 'camera') camera.push(n);
                    else if (n.indexOf('AG_Creative_') === 0) creative.push(n);
                } catch(e) {}
                try { searchBin(item); } catch(e) {}
            }
        }
        searchBin(app.project.rootItem);
        if (drone.length === 0 && camera.length === 0 && creative.length === 0) return 'EMPTY';
        if (drone.length === 0 && camera.length === 0) return 'DEBUG|' + debug.join('|');
        var droneStr  = drone.length    ? '"' + drone.join('","')    + '"' : '';
        var cameraStr = camera.length   ? '"' + camera.join('","')   + '"' : '';
        var creaStr   = creative.length ? '"' + creative.join('","') + '"' : '';
        return '{"drone":[' + droneStr + '],"camera":[' + cameraStr + '],"creative":[' + creaStr + ']}';
    } catch(e) { return 'Error: ' + e; }
}

/* ── Color Grade ─────────────────────────────────── */
function prColorGrade(convDroneName, convCameraName, creativeName) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) throw "Nenhuma sequência ativa.";

        // 1. Find AG project items
        function findProjectItem(exactName) {
            var found = null;
            function searchBin(bin) {
                if (found) return;
                for (var i = 0; i < bin.children.numItems; i++) {
                    var item = bin.children[i];
                    if (item.type === ProjectItemType.BIN) { searchBin(item); }
                    else if (item.name === exactName) { found = item; }
                }
            }
            searchBin(app.project.rootItem);
            return found;
        }

        var convDroneItem  = findProjectItem(convDroneName  || 'AG_Conversion');
        var convCameraItem = findProjectItem(convCameraName || 'AG_Conversion');
        var gradeItem      = findProjectItem('AG_Grade');
        var creativeItem   = findProjectItem(creativeName   || 'AG_Creative');

        var missing = [];
        if (!convDroneItem)  missing.push(convDroneName  || 'AG_Conversion');
        if (!convCameraItem) missing.push(convCameraName || 'AG_Conversion');
        if (!gradeItem)      missing.push('AG_Grade');
        if (!creativeItem)   missing.push(creativeName   || 'AG_Creative');
        if (missing.length > 0) throw "Items não encontrados: " + missing.join(', ');

        // Set label colors on project items
        var COLOR_ROSE      = 6;
        var COLOR_CARIBBEAN = 2;
        var COLOR_VIOLET    = 0;
        try { convDroneItem.setColorLabel(COLOR_ROSE);      } catch(e) {}
        try { convCameraItem.setColorLabel(COLOR_CARIBBEAN); } catch(e) {}
        try { creativeItem.setColorLabel(COLOR_VIOLET);     } catch(e) {}

        function isAGClip(clip) {
            return clip.name.indexOf('AG_Conversion') !== -1 ||
                   clip.name.indexOf('AG_Grade')      !== -1 ||
                   clip.name.indexOf('AG_Creative')   !== -1;
        }

        // Still-image extensions to skip
        var STILL_EXTS = {
            'jpg':1,'jpeg':1,'png':1,'gif':1,'bmp':1,
            'tif':1,'tiff':1,'psd':1,'psb':1,'ai':1,
            'eps':1,'svg':1,'webp':1,'ico':1
        };

        function isNestedSequence(clip) {
            // Compare by nodeId (string UID) — reference equality fails in ExtendScript
            try {
                var clipId = clip.projectItem.nodeId;
                if (!clipId) return false;
                var seqs = app.project.sequences;
                for (var i = 0; i < seqs.numSequences; i++) {
                    try {
                        if (seqs[i].projectItem.nodeId === clipId) return true;
                    } catch(e) {}
                }
            } catch(e) {}
            return false;
        }

        function isFootageClip(clip) {
            // Returns false for text/title clips and still images; true for video + nests
            try {
                var path = '';
                try { path = clip.projectItem.getMediaPath(); } catch(e) {
                    return isNestedSequence(clip);
                }
                if (!path || path === '') {
                    // Empty path = synthetic (title/matte) OR nested sequence
                    return isNestedSequence(clip);
                }
                var ext = path.split('.').pop().toLowerCase();
                if (STILL_EXTS[ext]) return false; // still image
                return true;
            } catch(e) { return false; }
        }

        // 2. Clear existing AG clips
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var tr = seq.videoTracks[t];
            for (var c = tr.clips.numItems - 1; c >= 0; c--) {
                try { if (isAGClip(tr.clips[c])) tr.clips[c].remove(false, false); } catch(e) {}
            }
        }

        // 3. Collect source footage clips only (skip text, images, AG layers)
        var allClips = [];
        var highestOccupied = -1;
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var tr = seq.videoTracks[t];
            for (var c = 0; c < tr.clips.numItems; c++) {
                var clip = tr.clips[c];
                if (isAGClip(clip))      continue;
                if (!isFootageClip(clip)) continue; // skip text / images
                var clipMediaPath = '';
                try { clipMediaPath = clip.projectItem.getMediaPath(); } catch(e2) {}
                var clipIsAE = clipMediaPath.split('.').pop().toLowerCase() === 'aep';
                allClips.push({
                    trackIdx:   t,
                    startTicks: parseInt(clip.start.ticks),
                    endTicks:   parseInt(clip.end.ticks),
                    startS:     clip.start.seconds,
                    endS:       clip.end.seconds,
                    isDrone:    !clipIsAE && clip.name.toUpperCase().indexOf('DJI') === 0,
                    isAEComp:   clipIsAE
                });
                if (t > highestOccupied) highestOccupied = t;
            }
        }
        if (highestOccupied === -1) throw "Nenhum clip de footage encontrado na timeline.";

        // 4. Ensure 3 dedicated AG tracks above all content
        var convIdx     = highestOccupied + 2;
        var gradeIdx    = highestOccupied + 3;
        var creativeIdx = highestOccupied + 4;
        while (seq.videoTracks.numTracks <= creativeIdx) {
            try {
                app.enableQE();
                qe.project.getActiveSequence().addVideoTrack();
            } catch(e) {
                try { seq.videoTracks.addTrack(); } catch(e2) { break; }
            }
        }
        try { seq.videoTracks[convIdx].name     = '[AG] Conversion'; } catch(e) {}
        try { seq.videoTracks[gradeIdx].name    = '[AG] Grade';      } catch(e) {}
        try { seq.videoTracks[creativeIdx].name = '[AG] Creative';   } catch(e) {}

        // 5. Build event-point array from clip boundaries (ticks, exact)
        var tpMap = {};
        for (var i = 0; i < allClips.length; i++) {
            tpMap[allClips[i].startTicks] = allClips[i].startS;
            tpMap[allClips[i].endTicks]   = allClips[i].endS;
        }

        // Collect AE comp windows + extra split times (music/markers) within them
        var aeWindows    = [];
        var aeSplitTimes = [];
        for (var i = 0; i < allClips.length; i++) {
            if (allClips[i].isAEComp) {
                aeWindows.push({ s: allClips[i].startTicks, e: allClips[i].endTicks,
                                 sS: allClips[i].startS, eS: allClips[i].endS });
            }
        }
        if (aeWindows.length > 0) {
            var isInAEWindow = function(ticks) {
                for (var w = 0; w < aeWindows.length; w++) {
                    if (ticks > aeWindows[w].s && ticks < aeWindows[w].e) return true;
                }
                return false;
            };
            // Music: audio clip start boundaries on A1 (track index 0) inside AE comp regions
            if (seq.audioTracks.numTracks > 0) {
                var a1 = seq.audioTracks[0];
                for (var ac = 0; ac < a1.clips.numItems; ac++) {
                    var aC = a1.clips[ac];
                    var sT = parseInt(aC.start.ticks);
                    if (isInAEWindow(sT)) aeSplitTimes.push(aC.start.seconds);
                }
            }
            // Markers: Premiere sequence markers inside AE comp regions
            var seqMarkers = seq.markers;
            for (var m = 0; m < seqMarkers.numMarkers; m++) {
                var mk = seqMarkers[m];
                var mkT = parseInt(mk.start.ticks);
                if (isInAEWindow(mkT)) aeSplitTimes.push(mk.start.seconds);
            }
            aeSplitTimes.sort(function(a, b) { return a - b; });
        }

        var tpArr = [];
        for (var tk in tpMap) tpArr.push({ ticks: parseInt(tk), s: tpMap[tk] });
        tpArr.sort(function(a, b) { return a.ticks - b.ticks; });

        // 6. Dominant-clip sweep — upper track commands, gaps produce no segment
        var segments    = [];
        var segStartS   = null;
        var segIsDrone  = false;
        var segIsAE     = false;
        var prevDomId   = null;

        for (var ti = 0; ti < tpArr.length - 1; ti++) {
            var midTicks  = Math.floor((tpArr[ti].ticks + tpArr[ti + 1].ticks) / 2);
            var domTrack  = -1, domStartTicks = -1, domId = null, domIsDrone = false, domIsAE = false;

            for (var i = 0; i < allClips.length; i++) {
                if (allClips[i].startTicks <= midTicks && allClips[i].endTicks > midTicks) {
                    if (allClips[i].trackIdx > domTrack ||
                       (allClips[i].trackIdx === domTrack && allClips[i].startTicks > domStartTicks)) {
                        domTrack      = allClips[i].trackIdx;
                        domStartTicks = allClips[i].startTicks;
                        domId         = allClips[i].trackIdx + '_' + allClips[i].startTicks;
                        domIsDrone    = allClips[i].isDrone;
                        domIsAE       = allClips[i].isAEComp;
                    }
                }
            }

            if (domId === null) {
                // Real gap — close current segment
                if (segStartS !== null) {
                    segments.push({ startS: segStartS, endS: tpArr[ti].s, isDrone: segIsDrone, isAEComp: segIsAE });
                    segStartS = null;
                    prevDomId = null;
                }
            } else if (domId !== prevDomId) {
                // Dominant clip changed — cut here
                if (segStartS !== null) {
                    segments.push({ startS: segStartS, endS: tpArr[ti].s, isDrone: segIsDrone, isAEComp: segIsAE });
                }
                segStartS  = tpArr[ti].s;
                segIsDrone = domIsDrone;
                segIsAE    = domIsAE;
                prevDomId  = domId;
            }
        }
        if (segStartS !== null) {
            segments.push({ startS: segStartS, endS: tpArr[tpArr.length - 1].s, isDrone: segIsDrone, isAEComp: segIsAE });
        }
        if (segments.length === 0) throw "Nenhum segmento detectado.";

        // Post-process: subdivide AE comp segments at music/marker cut points
        if (aeSplitTimes.length > 0) {
            var finalSegments = [];
            for (var s = 0; s < segments.length; s++) {
                if (!segments[s].isAEComp) { finalSegments.push(segments[s]); continue; }
                var splits = [];
                for (var sp = 0; sp < aeSplitTimes.length; sp++) {
                    if (aeSplitTimes[sp] > segments[s].startS && aeSplitTimes[sp] < segments[s].endS) {
                        splits.push(aeSplitTimes[sp]);
                    }
                }
                if (splits.length === 0) { finalSegments.push(segments[s]); continue; }
                splits.sort(function(a, b) { return a - b; });
                var pts = [segments[s].startS].concat(splits).concat([segments[s].endS]);
                for (var sp = 0; sp < pts.length - 1; sp++) {
                    finalSegments.push({ startS: pts[sp], endS: pts[sp + 1], isDrone: false, isAEComp: true });
                }
            }
            segments = finalSegments;
        }

        // Helper: set Scale to 200% via Motion component
        function setClipScale(clip, scaleVal) {
            try {
                for (var i = 0; i < clip.components.numItems; i++) {
                    var comp = clip.components[i];
                    if (comp.displayName === "Motion") {
                        for (var p = 0; p < comp.properties.numItems; p++) {
                            var prop = comp.properties[p];
                            if (prop.displayName === "Scale") {
                                prop.setValue(scaleVal, true);
                                break;
                            }
                        }
                        break;
                    }
                }
            } catch(e) {}
        }

        // 7. Target AG_Grade track + set it as the source patch destination
        try {
            // Enable track targeting on AG_Grade (deselect all others first)
            for (var t = 0; t < seq.videoTracks.numTracks; t++) {
                try { seq.videoTracks[t].setTargeted(false, false); } catch(e) {}
            }
            seq.videoTracks[gradeIdx].setTargeted(true, false);
        } catch(e) {}
        try {
            // Set source patch to AG_Grade (clear all, then patch grade track)
            for (var t = 0; t < seq.videoTracks.numTracks; t++) {
                try { seq.videoTracks[t].isSourcePatchSelected = false; } catch(e) {}
            }
            seq.videoTracks[gradeIdx].isSourcePatchSelected = true;
        } catch(e) {}

        // 8. Waterfall placement — no clip.end needed
        //    Each overwriteClip auto-trims the previous clip on that track.
        //    Final clip trimmed via temp clip at last segment end.
        var fixedLayers = [
            { track: seq.videoTracks[gradeIdx],    item: gradeItem    },
            { track: seq.videoTracks[creativeIdx], item: creativeItem }
        ];

        // Grade + Creative: same item for all segments
        for (var l = 0; l < fixedLayers.length; l++) {
            var agTrack = fixedLayers[l].track;
            var agItem  = fixedLayers[l].item;
            for (var s = 0; s < segments.length; s++) {
                var t0 = new Time(); t0.seconds = segments[s].startS;
                agTrack.overwriteClip(agItem, t0);
            }
            var tEnd = new Time(); tEnd.seconds = segments[segments.length - 1].endS;
            agTrack.overwriteClip(agItem, tEnd);
            try { agTrack.clips[agTrack.clips.numItems - 1].remove(false, false); } catch(e) {}
            for (var s = 0; s < segments.length; s++) {
                var segEnd = new Time(); segEnd.seconds = segments[s].endS;
                for (var c = 0; c < agTrack.clips.numItems; c++) {
                    if (Math.abs(agTrack.clips[c].start.seconds - segments[s].startS) < 0.1) {
                        try { agTrack.clips[c].end = segEnd; } catch(e) {}
                        setClipScale(agTrack.clips[c], 200);
                        break;
                    }
                }
            }
        }

        // Conversion: per-segment drone vs camera item (AE comp segments skipped)
        var convTrack = seq.videoTracks[convIdx];
        var convSegs  = [];
        for (var s = 0; s < segments.length; s++) {
            if (!segments[s].isAEComp) convSegs.push(segments[s]);
        }
        if (convSegs.length > 0) {
            for (var s = 0; s < convSegs.length; s++) {
                var t0 = new Time(); t0.seconds = convSegs[s].startS;
                convTrack.overwriteClip(convSegs[s].isDrone ? convDroneItem : convCameraItem, t0);
            }
            var tEnd = new Time(); tEnd.seconds = convSegs[convSegs.length - 1].endS;
            convTrack.overwriteClip(convSegs[convSegs.length - 1].isDrone ? convDroneItem : convCameraItem, tEnd);
            try { convTrack.clips[convTrack.clips.numItems - 1].remove(false, false); } catch(e) {}
            for (var s = 0; s < convSegs.length; s++) {
                var segEnd = new Time(); segEnd.seconds = convSegs[s].endS;
                for (var c = 0; c < convTrack.clips.numItems; c++) {
                    if (Math.abs(convTrack.clips[c].start.seconds - convSegs[s].startS) < 0.1) {
                        try { convTrack.clips[c].end = segEnd; } catch(e) {}
                        setClipScale(convTrack.clips[c], 200);
                        break;
                    }
                }
            }
        }

        return "OK: " + segments.length + " segmento(s) × 3 layers";

    } catch(e) { return "Error: " + e; }
}

