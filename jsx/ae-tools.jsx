/**
 * DM Tools — After Effects ExtendScript (CEP port)
 * Each function returns a string: success message or "Error: ..."
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function getComp() {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) return null;
    return comp;
}

// ── Warp / Comp ───────────────────────────────────────────────────────────────

function warpComp() {
    app.beginUndoGroup("Warp Stabilizer & Pre-compose");
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) throw "Please open a composition.";

        var selLayers = comp.selectedLayers;
        if (selLayers.length < 1) throw "Please select at least one layer.";

        var layersToProcess = [];
        for (var i = 0; i < selLayers.length; i++) layersToProcess.push(selLayers[i]);

        for (var i = 0; i < layersToProcess.length; i++) {
            var layer = layersToProcess[i];
            var layerIn, layerOut;
            if (layer.stretch < 0) { layerIn = layer.outPoint; layerOut = layer.inPoint; }
            else                   { layerIn = layer.inPoint;  layerOut = layer.outPoint; }
            var layerDuration = layerOut - layerIn;

            layer.property("ADBE Effect Parade").addProperty("Warp Stabilizer");

            for (var j = 1; j <= comp.numLayers; j++) comp.layer(j).selected = false;
            layer.selected = true;

            var precompName = layer.name;
            var newComp = comp.layers.precompose([layer.index], precompName, true);

            for (var j = 1; j <= newComp.numLayers; j++) newComp.layer(j).startTime -= layerIn;
            newComp.duration = layerDuration;

            var precompLayer = comp.selectedLayers[0];
            if (precompLayer.stretch < 0) {
                precompLayer.inPoint  = layerOut;
                precompLayer.outPoint = layerIn;
            } else {
                precompLayer.startTime = layerIn;
                precompLayer.inPoint   = layerIn;
                precompLayer.outPoint  = layerOut;
            }
        }
        app.endUndoGroup();
        return "Warp / Comp applied!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

// ── Motion Blur ───────────────────────────────────────────────────────────────

function motionBlur() {
    app.beginUndoGroup("Adj. Layer with Motion Blur");
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) throw "Please open a composition.";

        var adjLayer = comp.layers.addSolid([1,1,1], "Adjustment Layer", comp.width, comp.height, comp.pixelAspect, comp.duration);
        adjLayer.adjustmentLayer = true;
        adjLayer.property("ADBE Effect Parade").addProperty("CC Force Motion Blur");

        app.endUndoGroup();
        return "Motion Blur applied!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

// ── Day to Night ──────────────────────────────────────────────────────────────

function dayToNight() {
    app.beginUndoGroup("Apply Gradient Wipe Automation");
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) throw "Please open a composition.";

        var selectedLayer = comp.selectedLayers[0];
        if (!selectedLayer) throw "Please select a layer.";

        var selectedLayerIndex = selectedLayer.index;

        var nullLayer = comp.layers.addNull();
        var gcCount = 0;
        for (var n = 1; n <= comp.numLayers; n++) {
            if (comp.layer(n).name.indexOf("Gradient Controller") === 0) gcCount++;
        }
        nullLayer.name = "Gradient Controller " + selectedLayerIndex + "_" + gcCount;
        nullLayer.moveBefore(selectedLayer);

        var sliderEffect  = nullLayer.Effects.addProperty("ADBE Slider Control");
        sliderEffect.name = "Wipe Control";
        var sliderProperty = sliderEffect.property("Slider");

        var gradientWipe = selectedLayer.Effects.addProperty("ADBE Gradient Wipe");
        gradientWipe.property("Transition Softness").setValue(0.8);

        var currentTime     = comp.time;
        var frameRate       = comp.frameRate;
        var animationDuration = 1 + (12 / frameRate);
        var halfDuration    = animationDuration / 2;
        var inPoint         = currentTime - halfDuration;
        var outPoint        = currentTime + halfDuration;

        sliderProperty.setValueAtTime(inPoint,  100);
        sliderProperty.setValueAtTime(outPoint, 0);

        var marker = new MarkerValue("Midpoint");
        nullLayer.marker.setValueAtTime(currentTime, marker);

        nullLayer.inPoint  = inPoint;
        nullLayer.outPoint = outPoint;

        var nullLayerName        = nullLayer.name;
        var transitionProperty   = gradientWipe.property("Transition Completion");
        transitionProperty.expression = 'thisComp.layer("' + nullLayerName + '").effect("Wipe Control")("Slider")';

        app.endUndoGroup();
        return "Day to Night applied!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

// ── Pin Drop ──────────────────────────────────────────────────────────────────

function pinDrop(addressText, fontName) {
    app.beginUndoGroup("Pin Drop");
    try {
        var proj = app.project || app.newProject();
        var host = (proj.activeItem instanceof CompItem) ? proj.activeItem : null;
        if (!host) throw "Open a composition first.";
        if (!addressText || addressText === "") throw "No address entered.";
        if (!fontName || fontName === "") fontName = "FuturaPT-Book";

        var selectedNull = null;
        var preDlgLayers = host.selectedLayers;
        for (var si = 0; si < preDlgLayers.length; si++) {
            if (preDlgLayers[si] instanceof AVLayer && preDlgLayers[si].nullLayer) {
                selectedNull = preDlgLayers[si];
                break;
            }
        }

        var beforeCount = proj.numItems;

        (function(addressText, fontName, hostDuration, hostWidth, hostHeight, hostPAR) {
            app.beginUndoGroup("Rebuild address");
            var proj = app.project || app.newProject();
            var cmp  = proj.items.addComp(addressText, hostWidth, hostHeight, hostPAR, hostDuration, 25);
            var scaleX = hostWidth  / 1920;
            var scaleY = hostHeight / 1080;

            function setValOrKeys(p, data, offset) {
                if (!p || data == null) return;
                var off = (typeof offset === "number") ? offset : 0;
                if (typeof data === "string") { try { data = eval("(" + data + ")"); } catch(e) { data = {}; } }
                if (data.keys && data.keys.length) {
                    for (var i = 0; i < data.keys.length; i++) {
                        var k = data.keys[i]; var t = off + Number(k.t); var v = k.v;
                        try { p.setValueAtTime(t, v); } catch(e) { var idxTmp = p.addKey(t); p.setValueAtKey(idxTmp, v); }
                        var idx = p.nearestKeyIndex(t);
                        if (Math.abs(p.keyTime(idx) - t) > 1e-6) { idx = p.addKey(t); p.setValueAtKey(idx, v); }
                        try { if (k.it !== undefined && k.ot !== undefined) p.setInterpolationTypeAtKey(idx, k.it, k.ot); } catch(e) {}
                        try {
                            var dim = (p.value instanceof Array) ? p.value.length : 1;
                            var ie = [], oe = [];
                            var infIn  = (k.ie != null) ? k.ie : 33.3333;
                            var infOut = (k.oe != null) ? k.oe : 33.3333;
                            for (var d = 0; d < dim; d++) { ie.push(new KeyframeEase(0, infIn)); oe.push(new KeyframeEase(0, infOut)); }
                            p.setTemporalEaseAtKey(idx, ie, oe);
                        } catch(e) {}
                    }
                } else if (typeof data.v !== "undefined") { try { p.setValue(data.v); } catch(e) {} }
                if (data.expr) { try { p.expression = data.expr; p.expressionEnabled = true; } catch(e) {} }
            }

            var SL = cmp.layers.addShape(); SL.name = "Shape Layer 2";
            (function() {
                var root = SL.property("ADBE Root Vectors Group");
                var g    = root.addProperty("ADBE Vector Group");
                try { g.name = "Shape 1"; } catch(e) {}
                var contents = g.property("ADBE Vectors Group");
                var sh = new Shape();
                sh.closed      = false;
                sh.vertices    = [[Math.round(-345*scaleX), Math.round(89*scaleY)], [Math.round(-344*scaleX), Math.round(-290*scaleY)]];
                sh.inTangents  = [[0,0],[0,0]];
                sh.outTangents = [[0,0],[0,0]];
                contents.addProperty("ADBE Vector Shape - Group").property("ADBE Vector Shape").setValue(sh);
                var st = contents.addProperty("ADBE Vector Graphic - Stroke");
                try { st.property("ADBE Vector Stroke Color").setValue([1,1,1]); } catch(e) {}
                try { st.property("ADBE Vector Stroke Width").setValue(Math.round(4 * scaleX)); } catch(e) {}
            })();
            SL.startTime = -2.36; SL.inPoint = 0; SL.outPoint = hostDuration;
            SL.blendingMode = 5212;
            var offS = SL.inPoint;
            setValOrKeys(SL.property("ADBE Transform Group").property("ADBE Position"), {v:[958.75*scaleX, 542.5*scaleY, 0]}, offS);
            setValOrKeys(SL.property("ADBE Transform Group").property("ADBE Opacity"),  {v:100}, offS);
            (function() {
                var eff = SL.property("ADBE Effect Parade").addProperty("ADBE Linear Wipe"); if (!eff) return;
                try { (eff.property("Wipe Angle")||eff.property(1)).setValue(180); } catch(e) {}
                try { (eff.property("Feather")||eff.property(2)).setValue(Math.round(25 * scaleX)); } catch(e) {}
                setValOrKeys((eff.property("Transition Completion")||eff.property(3)), {keys:[{t:0, v:65.2, it:6613, ot:6613, ie:33.333333, oe:33.333333},{t:1.32, v:25.4, it:6613, ot:6613, ie:60.570205, oe:33.333333}]}, offS);
            })();

            var TL = cmp.layers.addText(addressText); TL.name = addressText;
            (function() {
                var p = TL.property("ADBE Text Properties").property("ADBE Text Document"); var d = p.value;
                d.text = addressText; d.font = fontName; d.fontSize = Math.round(40 * scaleX); d.justification = 7415;
                d.applyFill = true; try { d.fillColor = [0.92157, 0.92157, 0.92157]; } catch(e) {}
                d.applyStroke = false; try { d.strokeColor = [0,0,0]; d.strokeWidth = 0; } catch(e) {}
                p.setValue(d);
            })();
            TL.startTime = -2.36; TL.inPoint = 0; TL.outPoint = hostDuration;
            TL.blendingMode = 5212;
            var offT = TL.inPoint;
            setValOrKeys(TL.property("ADBE Transform Group").property("ADBE Position"), {keys:[{t:0, v:[614.75*scaleX, 575.25*scaleY, 0], it:6612, ot:6613, ie:16.666667, oe:33.333333},{t:1, v:[614.75*scaleX, 221.25*scaleY, 0], it:6613, ot:6612, ie:60.639058, oe:16.666667}]}, offT);
            setValOrKeys(TL.property("ADBE Transform Group").property("ADBE Opacity"),  {keys:[{t:0, v:0, it:6612, ot:6612, ie:16.666667, oe:16.666667},{t:1, v:100, it:6612, ot:6612, ie:16.666667, oe:16.666667}]},  offT);
            app.endUndoGroup();
        })(addressText, fontName, host.duration, host.width, host.height, host.pixelAspect);

        var cmp = null;
        for (var i = proj.numItems; i > beforeCount; i--) {
            var it = proj.item(i);
            if (it instanceof CompItem && it.name === addressText) { cmp = it; break; }
        }
        if (!cmp) {
            for (var j = proj.numItems; j >= 1; j--) {
                var it2 = proj.item(j);
                if (it2 instanceof CompItem && it2.name === addressText) { cmp = it2; break; }
            }
        }
        if (!cmp) throw "Could not find address comp \"" + addressText + "\".";

        var addressLayer = host.layers.add(cmp);
        var scaleX = host.width  / 1920;
        var scaleY = host.height / 1080;
        var anchorProp = addressLayer.property("ADBE Transform Group").property("ADBE Anchor Point");
        anchorProp.setValue([613.75 * scaleX, 631.5 * scaleY]);

        var targetNullName = "Track Null 1";
        if (selectedNull) {
            var baseName = addressText + " Null";
            var pinCount = 0;
            for (var ni = 1; ni <= host.numLayers; ni++) {
                if (host.layer(ni).name.indexOf(baseName) === 0) pinCount++;
            }
            var uniqueName = baseName + " " + (pinCount + 1);
            selectedNull.name = uniqueName;
            targetNullName    = uniqueName;
        }

        try {
            var posProp = addressLayer.property("ADBE Transform Group").property("ADBE Position");
            posProp.expression = 'thisComp.layer("' + targetNullName + '").toComp([0,0,0]);';
            posProp.expressionEnabled = true;
        } catch(e) {}

        app.endUndoGroup();
        return "Pin Drop created!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

// ── 3D Track Camera ───────────────────────────────────────────────────────────

function trackCamera() {
    app.beginUndoGroup("3D Camera Tracking");
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) throw "Please open a composition.";
        if (!comp.selectedLayers[0]) throw "Please select a layer to track.";

        var cmdId = app.findMenuCommandId("Track Camera");
        if (!cmdId) throw "Menu command 'Track Camera' not found.";
        app.executeCommand(cmdId);

        app.endUndoGroup();
        return "3D Camera Tracker started!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

// ── Stabilize Motion ──────────────────────────────────────────────────────────

function stabilizeMotion() {
    app.beginUndoGroup("Stabilize Motion");
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) throw "Please open a composition.";
        if (!comp.selectedLayers[0]) throw "Please select a layer.";

        var trackerCmdId = app.findMenuCommandId("Tracker");
        if (!trackerCmdId) throw "Tracker panel command not found.";
        app.executeCommand(trackerCmdId);

        var stabilizeCmdId = app.findMenuCommandId("Stabilize Motion");
        if (stabilizeCmdId) app.executeCommand(stabilizeCmdId);

        app.endUndoGroup();
        return "Tracker opened in Stabilize Motion mode.";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

// ── CC RepeTile ───────────────────────────────────────────────────────────────

function ccRepetile() {
    app.beginUndoGroup("Apply CC RepeTile");
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) throw "Please open a composition.";
        var selLayer = comp.selectedLayers[0];
        if (!selLayer) throw "Please select a layer.";

        var repeTile = selLayer.property("ADBE Effect Parade").addProperty("CC RepeTile");
        repeTile.property("Expand Right").setValue(1000);
        repeTile.property("Expand Left").setValue(1000);
        repeTile.property("Expand Down").setValue(1000);
        repeTile.property("Expand Up").setValue(1000);
        repeTile.property("Tiling").setValue(4);

        app.endUndoGroup();
        return "CC RepeTile applied!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

// ── Key + Stroke ──────────────────────────────────────────────────────────────

function keyStroke() {
    app.beginUndoGroup("Key + Stroke");
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) throw "Please open a composition.";
        var layer = comp.selectedLayers[0];
        if (!layer) throw "Please select a layer.";
        if (!(layer instanceof AVLayer)) throw "Selected item is not an AV layer.";

        var fx = layer.property("ADBE Effect Parade");
        if (!fx) throw "Effects group not available.";

        function addEffect(names) {
            for (var i = 0; i < names.length; i++) {
                try { var e = fx.addProperty(names[i]); if (e) return e; } catch(err) {}
            }
            throw "Effect not found: " + names.join(" | ");
        }
        function findPropByName(effect, cand) {
            for (var i = 0; i < cand.length; i++) {
                var p = effect.property(cand[i]); if (p) return p;
            }
            for (var j = 1; j <= effect.numProperties; j++) {
                var pj = effect.property(j);
                var n  = (pj && pj.name) ? pj.name.toLowerCase() : "";
                for (var i2 = 0; i2 < cand.length; i2++) {
                    if (n === cand[i2].toLowerCase()) return pj;
                }
            }
            return null;
        }
        function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
        function easyEaseBoth(prop, keyIndex) {
            var e = new KeyframeEase(0, 33.3333);
            prop.setInterpolationTypeAtKey(keyIndex, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
            prop.setTemporalEaseAtKey(keyIndex, [e], [e]);
        }

        var colorKey  = addEffect(["ADBE Color Key", "Color Key"]);
        var solidColor = null;
        try {
            if (layer.source && layer.source.mainSource && (typeof layer.source.mainSource.color !== "undefined"))
                solidColor = layer.source.mainSource.color;
        } catch(e) {}
        if (!solidColor) {
            try {
                var s = layer.sampleImage([layer.width/2, layer.height/2], [1,1], false);
                solidColor = [s[0], s[1], s[2]];
            } catch(e) { solidColor = [1,1,1]; }
        }
        var ckColorProp = findPropByName(colorKey, ["Color","Cor","Key Color","Cor da chave"]);
        if (ckColorProp) ckColorProp.setValue(solidColor);
        else if (colorKey.property(1)) { try { colorKey.property(1).setValue(solidColor); } catch(_) {} }

        var stroke = addEffect(["ADBE Stroke", "Stroke"]);
        try {
            var pathProp = findPropByName(stroke, ["Path","Caminho"]);
            if (pathProp) pathProp.setValue(1);
        } catch(e) {}

        var pStart = findPropByName(stroke, ["Start","Início","Inicio"]);
        var pEnd   = findPropByName(stroke, ["End","Fim"]);
        if (!pStart || !pEnd) throw "Stroke Start/End not found. Check the layer masks.";

        var frame = 1 / comp.frameRate, eps = frame;
        var inT = layer.inPoint, outT = layer.outPoint;
        var t0  = 1.0, t1 = 2.5;

        if (t1 > outT - eps) { var sl = t1 - (outT - eps); t0 -= sl; t1 -= sl; }
        if (t0 < inT + eps)  { var sr = (inT + eps) - t0;  t0 += sr; t1 += sr; }
        if (t1 > outT - eps || t0 < inT + eps) {
            var spanAvail = Math.max((outT - eps) - (inT + eps), frame * 2);
            t0 = (inT + eps) + spanAvail * 0.40;
            t1 = (inT + eps) + spanAvail * 1.00;
            t0 = clamp(t0, inT + eps, outT - 2*eps);
            t1 = clamp(t1, t0 + eps, outT - eps);
        }

        var kS1 = pStart.addKey(t0); pStart.setValueAtKey(kS1,  50);
        var kS2 = pStart.addKey(t1); pStart.setValueAtKey(kS2, 100);
        var kE1 = pEnd.addKey(t0);   pEnd.setValueAtKey(kE1,    50);
        var kE2 = pEnd.addKey(t1);   pEnd.setValueAtKey(kE2,     0);
        easyEaseBoth(pStart, kS1); easyEaseBoth(pStart, kS2);
        easyEaseBoth(pEnd,   kE1); easyEaseBoth(pEnd,   kE2);

        var matteCopy = layer.duplicate();
        matteCopy.name = layer.name + " (Matte)";
        var copyFx = matteCopy.property("ADBE Effect Parade");
        while (copyFx.numProperties > 0) { try { copyFx.property(1).remove(); } catch(e) { break; } }
        matteCopy.moveAfter(layer);

        var blackSolid = comp.layers.addSolid([0,0,0], "Black Solid (Vignette)", comp.width, comp.height, comp.pixelAspect);
        blackSolid.moveAfter(matteCopy);
        blackSolid.inPoint  = layer.inPoint;
        blackSolid.outPoint = layer.outPoint;
        blackSolid.trackMatteType = TrackMatteType.ALPHA_INVERTED;

        var opProp = blackSolid.property("ADBE Transform Group").property("ADBE Opacity");
        var kO1 = opProp.addKey(t0); opProp.setValueAtKey(kO1,  0);
        var kO2 = opProp.addKey(t1); opProp.setValueAtKey(kO2, 25);
        easyEaseBoth(opProp, kO1);
        easyEaseBoth(opProp, kO2);

        app.endUndoGroup();
        return "Key + Stroke applied!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

// ── Speed Ramp ────────────────────────────────────────────────────────────────

// Helper: move keyframe at keyIndex to the inPoint of the layer directly above.
// Returns the new key index, or null if the layer is at the top.
function _adjustKeyframeForLayer(layer, keyIndex) {
    var comp = app.project.activeItem;
    if (layer.index === 1) return null;
    var layerAbove = comp.layer(layer.index - 1);
    var remapProp  = layer.property("ADBE Time Remapping");
    var keyValue   = remapProp.keyValue(keyIndex);
    remapProp.removeKey(keyIndex);
    var newTime    = layerAbove.inPoint;
    var newKeyIdx  = remapProp.addKey(newTime);
    remapProp.setValueAtKey(newKeyIdx, keyValue);
    return newKeyIdx;
}

function introRamp(intensity) {
    app.beginUndoGroup("Intro Speed Ramp");
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) throw "Please open a composition.";
        var selLayers = comp.selectedLayers;
        if (selLayers.length < 1) throw "Please select at least one layer.";

        for (var i = 0; i < selLayers.length; i++) {
            var layer = selLayers[i];

            // Reset TR for clean state
            if (layer.timeRemapEnabled) { layer.timeRemapEnabled = false; }
            layer.timeRemapEnabled = true;

            var remapProp    = layer.property("ADBE Time Remapping");
            var duration     = layer.outPoint - layer.inPoint;
            remapProp.setValueAtKey(1, 0);
            var sourceDuration = remapProp.keyValue(remapProp.numKeys);

            // Key 2: 3% comp time
            var key2Time  = layer.inPoint + 0.03 * duration;
            var key2Index = remapProp.addKey(key2Time);
            remapProp.setValueAtKey(key2Index, 0.03 * sourceDuration);
            remapProp.setInterpolationTypeAtKey(key2Index, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);

            // Key 3: 90% comp time, intensity-driven source value
            var key3Time  = layer.inPoint + 0.9 * duration;
            var key3Index = remapProp.addKey(key3Time);
            var introKey3Pct = 0.80 + (intensity / 100) * 0.17;
            remapProp.setValueAtKey(key3Index, introKey3Pct * sourceDuration);
            remapProp.setInterpolationTypeAtKey(key3Index, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);

            // Move key 3 to the inPoint of the layer above
            var adjustedIdx = _adjustKeyframeForLayer(layer, key3Index);
            if (adjustedIdx === null) {
                // layer is at top — skip easing for this layer
                continue;
            }

            // Apply easing to all 4 keys
            remapProp = layer.property("ADBE Time Remapping");
            if (remapProp.numKeys !== 4) continue;

            var iT1 = remapProp.keyTime(1),  iV1 = remapProp.keyValue(1);
            var iT2 = remapProp.keyTime(2),  iV2 = remapProp.keyValue(2);
            var iT3 = remapProp.keyTime(3),  iV3 = remapProp.keyValue(3);
            var iT4 = remapProp.keyTime(4),  iV4 = remapProp.keyValue(4);

            var iAvg12 = (iV2 - iV1) / (iT2 - iT1);
            var iAvg23 = (iV3 - iV2) / (iT3 - iT2);
            var iAvg34 = (iV4 - iV3) / (iT4 - iT3);

            var key3InMult = Math.min(6.25, (1 - 0.50 / iAvg23) / 0.10 * 0.95);

            var preset = {
                1: { inI: KeyframeInterpolationType.LINEAR,  outI: KeyframeInterpolationType.LINEAR,
                     inE: [new KeyframeEase(0, 33.33)],           outE: [new KeyframeEase(iAvg12, 33.33)] },
                2: { inI: KeyframeInterpolationType.LINEAR,  outI: KeyframeInterpolationType.BEZIER,
                     inE: [new KeyframeEase(iAvg12, 33.33)],      outE: [new KeyframeEase(iAvg12, 50.0)] },
                3: { inI: KeyframeInterpolationType.BEZIER,  outI: KeyframeInterpolationType.BEZIER,
                     inE: [new KeyframeEase(iAvg23 * key3InMult, 10.0)], outE: [new KeyframeEase(iAvg34 * 0.15, 16.67)] },
                4: { inI: KeyframeInterpolationType.BEZIER,  outI: KeyframeInterpolationType.BEZIER,
                     inE: [new KeyframeEase(iAvg34 * 0.164, 16.67)],    outE: [new KeyframeEase(0, 16.67)] }
            };

            for (var k = 1; k <= 4; k++) {
                remapProp.setInterpolationTypeAtKey(k, preset[k].inI, preset[k].outI);
                remapProp.setTemporalEaseAtKey(k, preset[k].inE, preset[k].outE);
            }
        }

        app.endUndoGroup();
        return "Intro Ramp applied!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

function middleRamp(intensity) {
    app.beginUndoGroup("Middle Speed Ramp");
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) throw "Please open a composition.";
        var selLayers = comp.selectedLayers;
        if (selLayers.length < 1) throw "Please select at least one layer.";

        for (var i = 0; i < selLayers.length; i++) {
            try {
                var layer = selLayers[i];

                // Reset TR for clean state
                if (layer.timeRemapEnabled) { layer.timeRemapEnabled = false; }
                layer.timeRemapEnabled = true;

                var remapProp    = layer.property("ADBE Time Remapping");
                var duration     = layer.outPoint - layer.inPoint;
                remapProp.setValueAtKey(1, 0);
                var sourceDuration = remapProp.keyValue(remapProp.numKeys);

                // Key 2: 90% comp time, intensity-driven source value
                var key2Time  = layer.inPoint + 0.9 * duration;
                var key2Index = remapProp.addKey(key2Time);
                var middleKey2Pct = 0.70 + (intensity / 100) * 0.27;
                remapProp.setValueAtKey(key2Index, middleKey2Pct * sourceDuration);
                remapProp.setInterpolationTypeAtKey(key2Index, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);

                // Move key 2 to the inPoint of the layer above
                var adjustedIdx = _adjustKeyframeForLayer(layer, key2Index);
                if (adjustedIdx === null) continue;

                // Apply easing to all 3 keys
                remapProp = layer.property("ADBE Time Remapping");
                if (remapProp.numKeys < 3) continue;

                var t1 = remapProp.keyTime(1), v1 = remapProp.keyValue(1);
                var t2 = remapProp.keyTime(2), v2 = remapProp.keyValue(2);
                var t3 = remapProp.keyTime(3), v3 = remapProp.keyValue(3);
                var avgSpeed12 = (v2 - v1) / (t2 - t1);
                var avgSpeed23 = (v3 - v2) / (t3 - t2);

                var middlePreset = [
                    { inI: KeyframeInterpolationType.BEZIER, outI: KeyframeInterpolationType.BEZIER,
                      inE: [new KeyframeEase(0, 33.333333)],             outE: [new KeyframeEase(avgSpeed12 * 3.0, 15.0)] },
                    { inI: KeyframeInterpolationType.BEZIER, outI: KeyframeInterpolationType.BEZIER,
                      inE: [new KeyframeEase(avgSpeed12 * 3.0, 15.0)],   outE: [new KeyframeEase(avgSpeed23 * 1.0, 33.333333)] },
                    { inI: KeyframeInterpolationType.BEZIER, outI: KeyframeInterpolationType.BEZIER,
                      inE: [new KeyframeEase(avgSpeed23 * 1.0, 33.333333)], outE: [new KeyframeEase(0, 33.333333)] }
                ];

                for (var k = 0; k < 3; k++) {
                    remapProp.setInterpolationTypeAtKey(k + 1, middlePreset[k].inI, middlePreset[k].outI);
                    remapProp.setTemporalEaseAtKey(k + 1, middlePreset[k].inE, middlePreset[k].outE);
                }
            } catch (layerErr) {
                // continue to next layer
            }
        }

        app.endUndoGroup();
        return "Middle Ramp applied!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

function outroRamp(intensity) {
    app.beginUndoGroup("Outro Speed Ramp");
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) throw "Please open a composition.";
        var selLayers = comp.selectedLayers;
        if (selLayers.length < 1) throw "Please select at least one layer.";

        for (var i = 0; i < selLayers.length; i++) {
            var layer    = selLayers[i];

            // Reset TR for clean state
            if (layer.timeRemapEnabled) { layer.timeRemapEnabled = false; }
            layer.timeRemapEnabled = true;

            var remapProp      = layer.property("ADBE Time Remapping");
            var duration       = layer.outPoint - layer.inPoint;
            var sourceDuration = remapProp.keyValue(remapProp.numKeys);

            // Add key at 80% comp time = 80% source time
            var keyTime80  = layer.inPoint + 0.8 * duration;
            var key80Index = remapProp.addKey(keyTime80);
            remapProp.setValueAtKey(key80Index, 0.8 * sourceDuration);

            if (remapProp.numKeys < 3) continue;

            // Shift key2 and key3 so key2 lands at intensity-driven position
            var outroKey2Pct = 0.50 - (intensity / 100) * 0.35;
            var newKey2Time  = layer.inPoint + outroKey2Pct * duration;
            var oldKey2Time  = remapProp.keyTime(2);
            var oldKey3Time  = remapProp.keyTime(3);
            var gap          = oldKey3Time - oldKey2Time;
            var newKey3Time  = newKey2Time + gap;

            // Store key2 properties
            var key2Val        = remapProp.keyValue(2);
            var key2InEase     = remapProp.keyInTemporalEase(2);
            var key2OutEase    = remapProp.keyOutTemporalEase(2);
            var key2InterpIn   = remapProp.keyInInterpolationType(2);
            var key2InterpOut  = remapProp.keyOutInterpolationType(2);

            // Store key3 properties
            var key3Val        = remapProp.keyValue(3);
            var key3InEase     = remapProp.keyInTemporalEase(3);
            var key3OutEase    = remapProp.keyOutTemporalEase(3);
            var key3InterpIn   = remapProp.keyInInterpolationType(3);
            var key3InterpOut  = remapProp.keyOutInterpolationType(3);

            // Remove and re-add at new times
            remapProp.removeKey(3);
            remapProp.removeKey(2);

            var newKey2Index = remapProp.addKey(newKey2Time);
            remapProp.setValueAtKey(newKey2Index, key2Val);
            remapProp.setTemporalEaseAtKey(newKey2Index, key2InEase, key2OutEase);
            remapProp.setInterpolationTypeAtKey(newKey2Index, key2InterpIn, key2InterpOut);

            var newKey3Index = remapProp.addKey(newKey3Time);
            remapProp.setValueAtKey(newKey3Index, key3Val);
            remapProp.setTemporalEaseAtKey(newKey3Index, key3InEase, key3OutEase);
            remapProp.setInterpolationTypeAtKey(newKey3Index, key3InterpIn, key3InterpOut);

            // Normalized key1 outgoing speed
            var outroV1 = remapProp.keyValue(1), outroT1 = remapProp.keyTime(1);
            var outroV2 = remapProp.keyValue(2), outroT2 = remapProp.keyTime(2);
            var outroAvgSpeed12 = (outroV2 - outroV1) / (outroT2 - outroT1);

            var outroPreset = [
                { inI: 6612, outI: 6613,
                  inE:  [new KeyframeEase(0, 16.666667)],
                  outE: [new KeyframeEase(outroAvgSpeed12 * 4.0, 15.0)] },
                { inI: 6613, outI: 6612,
                  inE:  [new KeyframeEase(1.01229012874915, 61.6799805702239)],
                  outE: [new KeyframeEase(0.99999155265422, 16.666667)] },
                { inI: 6612, outI: 6612,
                  inE:  [new KeyframeEase(0.99999155265422, 16.666667)],
                  outE: [new KeyframeEase(0, 16.666667)] }
            ];

            for (var k = 0; k < 3; k++) {
                remapProp.setInterpolationTypeAtKey(k + 1, outroPreset[k].inI, outroPreset[k].outI);
                remapProp.setTemporalEaseAtKey(k + 1, outroPreset[k].inE, outroPreset[k].outE);
            }
        }

        app.endUndoGroup();
        return "Outro Ramp applied!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

// ── Pin Drop — Logo (Kollosche) ───────────────────────────────────────────────

function pinDropLogo(logoPath) {
    app.beginUndoGroup("Pin Drop Logo");
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) throw "Open a composition first.";

        // Find selected null
        var selectedNull = null;
        var selLayers = comp.selectedLayers;
        for (var si = 0; si < selLayers.length; si++) {
            if (selLayers[si] instanceof AVLayer && selLayers[si].nullLayer) {
                selectedNull = selLayers[si];
                break;
            }
        }

        // Import logo (or reuse if already in project)
        var logoFile = new File(logoPath);
        if (!logoFile.exists) throw "Logo file not found: " + logoPath;

        var logoItem = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FootageItem && it.file && it.file.fsName === logoFile.fsName) {
                logoItem = it; break;
            }
        }
        if (!logoItem) {
            logoItem = app.project.importFile(new ImportOptions(logoFile));
        }

        // Add to comp
        var logoLayer = comp.layers.add(logoItem);
        logoLayer.inPoint  = comp.time;
        logoLayer.outPoint = comp.duration;

        var scaleX = comp.width  / 1920;
        var scaleY = comp.height / 1080;

        // Scale to match comp
        var scalePct = Math.min(scaleX, scaleY) * 100 * 0.25;
        logoLayer.property("ADBE Transform Group").property("ADBE Scale").setValue([scalePct, scalePct]);

        // Anchor point at bottom-center of visible content (1884px = last content row, trimming 36px whitespace)
        var imgW = logoItem.width;
        logoLayer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([imgW / 2, 1884]);

        // Apply Linear Wipe (same animation as address pin drop)
        var eff = logoLayer.property("ADBE Effect Parade").addProperty("ADBE Linear Wipe");
        if (eff) {
            try { (eff.property("Wipe Angle") || eff.property(1)).setValue(180); } catch(e) {}
            try { (eff.property("Feather")    || eff.property(2)).setValue(Math.round(25 * scaleX)); } catch(e) {}
            var tcProp = eff.property("Transition Completion") || eff.property(3);
            if (tcProp) {
                var t0 = comp.time;
                tcProp.setValueAtTime(t0,        100);
                tcProp.setValueAtTime(t0 + 1.32, 0);
            }
        }

        // Rename null and link position
        if (selectedNull) {
            var baseName  = "Kollosche Null";
            var pinCount  = 0;
            for (var ni = 1; ni <= comp.numLayers; ni++) {
                if (comp.layer(ni).name.indexOf(baseName) === 0) pinCount++;
            }
            var uniqueName = baseName + " " + (pinCount + 1);
            selectedNull.name = uniqueName;

            var posProp = logoLayer.property("ADBE Transform Group").property("ADBE Position");
            posProp.expression = 'thisComp.layer("' + uniqueName + '").toComp([0,0,0]);';
            posProp.expressionEnabled = true;
        }

        app.endUndoGroup();
        return "Kollosche Pin Drop created!";
    } catch (err) {
        app.endUndoGroup();
        return "Error: " + err;
    }
}

// ── Collect Files ─────────────────────────────────────────────────────────────

function aeCollectFiles() {
    try {
        var projFile = app.project.file;
        if (!projFile) throw "Save your project first.";

        var projFilesFolder = projFile.parent;
        var rootFolder      = projFilesFolder.parent;
        var rootPath        = rootFolder.fsName;

        var assetsFolder = new Folder(rootPath + "/Assets");
        if (!assetsFolder.exists) assetsFolder.create();

        var count  = 0;
        var errors = 0;

        for (var i = 1; i <= app.project.numItems; i++) {
            try {
                var item = app.project.item(i);
                if (!(item instanceof FootageItem)) continue;
                var source = item.mainSource;
                if (!(source instanceof FileSource)) continue;

                var srcFile = source.file;
                if (!srcFile || !srcFile.exists) continue;

                var srcPath = srcFile.fsName;
                if (srcPath.indexOf(rootPath) === 0)    continue;
                if (srcPath.indexOf("/Volumes/") === 0) continue;

                var destFile = new File(assetsFolder.fsName + "/" + srcFile.name);
                if (srcPath !== destFile.fsName) srcFile.copy(destFile.fsName);
                item.replace(destFile);
                count++;
            } catch(e) { errors++; }
        }

        app.project.save();
        var msg = count + " file(s) collected to Assets/";
        if (errors > 0) msg += " (" + errors + " skipped)";
        return msg;

    } catch(e) { return "Error: " + e; }
}

