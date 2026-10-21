/* DM Tools native text animators. No external assets or presets required. */
function dmTextPresetsRun(options, removeOnly, targetLayers, withinUndo) {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) return 'Error: Open a composition and select text layers.';
    var layers = targetLayers || comp.selectedLayers, targets = [], i, j;
    for (i = 0; i < layers.length; i++) if (layers[i].property('ADBE Text Properties')) {
        if (layers[i].locked) return 'Error: Unlock the selected text layers first.';
        targets.push(layers[i]);
    }
    if (!targets.length) return 'Error: Select one or more text layers first.';
    var o, preset;
    try { if (!removeOnly) { o = DMTextPresets.validate(options); preset = DMTextPresets.get(o.id); } }
    catch (e) { return 'Error: ' + e.message; }
    var commitStarted = false;
    var prefix = 'DM Text - ', staged = [], old = [], expressions = [], token = '__DMTP_' + (new Date().getTime()) + '_';
    function isOwned(name) { return /^DM Text - (In|Out) (Motion|Opacity)$/.test(name) || /^DM Text - (In Duration|Out Duration|Stagger|Amount|Direction|Order|Spring|Seed|Mode|Easing)$/.test(name); }
    function collect(layer) {
        var groups = [layer.property('ADBE Text Properties').property('ADBE Text Animators'), layer.property('ADBE Effect Parade')];
        for (var g = 0; g < groups.length; g++) for (var n = 1; n <= groups[g].numProperties; n++) {
            var p = groups[g].property(n);
            if (isOwned(p.name)) old.push({layer: layer, group: g, index: n, name: p.name});
        }
    }
    function group(layer, g) { return g === 0 ? layer.property('ADBE Text Properties').property('ADBE Text Animators') : layer.property('ADBE Effect Parade'); }
    function slider(layer, name, value) {
        var fx = layer.property('ADBE Effect Parade').addProperty('ADBE Slider Control');
        fx.name = token + name; var idx = fx.propertyIndex;
        staged.push({layer: layer, group: 1, index: idx, name: prefix + name});
        layer.property('ADBE Effect Parade').property(idx).property(1).setValue(value);
    }
    function animator(layer, phase, opacity) {
        var anims = layer.property('ADBE Text Properties').property('ADBE Text Animators');
        var a = anims.addProperty('ADBE Text Animator');
        var idx = a.propertyIndex;
        a.name = token + phase + (opacity ? 'Opacity' : 'Motion');
        var finalName = prefix + (phase === 'in' ? 'In' : 'Out') + (opacity ? ' Opacity' : ' Motion');
        staged.push({layer: layer, group: 0, index: idx, name: finalName});
        function current() { return layer.property('ADBE Text Properties').property('ADBE Text Animators').property(idx); }
        var propName, expr;
        if (opacity) {
            current().property('ADBE Text Animator Properties').addProperty('ADBE Text Opacity').setValue(0);
        } else {
            if (preset.family === 1) { propName = 'ADBE Text Position 3D'; expr = DMTextPresets.motionExpression('position', phase); }
            else if (preset.family === 2) { propName = 'ADBE Text Rotation'; expr = DMTextPresets.motionExpression('rotation', phase); }
            else { propName = 'ADBE Text Scale 3D'; expr = DMTextPresets.motionExpression('scale', phase); }
            current().property('ADBE Text Animator Properties').addProperty(propName);
            expressions.push({layer: layer, name: finalName, property: propName, source: expr});
        }
        var selectors = current().property('ADBE Text Selectors');
        while (selectors.numProperties) selectors.property(selectors.numProperties).remove();
        selectors.addProperty('ADBE Text Expressible Selector');
        var selector = current().property('ADBE Text Selectors').property(1);
        selector.property('ADBE Text Range Type2').setValue([1,3,4][preset.group]);
        selector.property('ADBE Text Expressible Amount').expressionEnabled = false;
        expressions.push({layer: layer, name: finalName, property: null, source: DMTextPresets.expression(phase, opacity)});
    }
    if (!withinUndo) app.beginUndoGroup(removeOnly ? 'Remove DM Text Presets' : 'DM Text Presets');
    try {
        for (i = 0; i < targets.length; i++) collect(targets[i]);
        if (!removeOnly) for (i = 0; i < targets.length; i++) {
            var layer = targets[i];
            slider(layer, 'In Duration', o.duration / o.speed); slider(layer, 'Out Duration', o.duration / o.speed);
            slider(layer, 'Stagger', o.delay / o.speed); slider(layer, 'Amount', o.amount);
            slider(layer, 'Direction', o.direction + 1);
            slider(layer, 'Order', preset.variant === 1 ? 2 : preset.variant === 3 ? 3 : 1);
            slider(layer, 'Spring', preset.variant === 2 ? o.spring : 0);
            slider(layer, 'Seed', o.seed); slider(layer, 'Mode', o.mode + 1); slider(layer, 'Easing', o.easing);
            animator(layer, 'in', true); animator(layer, 'out', true);
            if (preset.family !== 0 || preset.variant === 2) { animator(layer, 'in', false); animator(layer, 'out', false); }
        }
        // Publish only after all layers have been built. References are reacquired because
        // addProperty rebuilds indexed groups and invalidates earlier Property objects.
        commitStarted = true;
        // AE evaluates assigned expressions immediately. Disable old DM expressions before
        // renaming their controls, and assign new expressions only after the final controls exist.
        function disableExpressions(p) {
            if (p.canSetExpression && p.expressionEnabled) p.expressionEnabled = false;
            for (var n = 1; n <= (p.numProperties || 0); n++) disableExpressions(p.property(n));
        }
        for (i = 0; i < old.length; i++) if (old[i].group === 0) disableExpressions(group(old[i].layer, 0).property(old[i].index));
        for (i = 0; i < old.length; i++) group(old[i].layer, old[i].group).property(old[i].index).name = token + 'old_' + i;
        for (i = 0; i < staged.length; i++) group(staged[i].layer, staged[i].group).property(staged[i].index).name = staged[i].name;
        for (i = old.length - 1; i >= 0; i--) group(old[i].layer, old[i].group).property(old[i].index).remove();
        for (i = 0; i < expressions.length; i++) {
            var pending = expressions[i], published = group(pending.layer, 0).property(pending.name);
            if (!published) throw new Error('Could not locate the new text animator.');
            var destination = pending.property ? published.property('ADBE Text Animator Properties').property(pending.property) : published.property('ADBE Text Selectors').property(1).property('ADBE Text Expressible Amount');
            destination.expression = pending.source;
            destination.expressionEnabled = true;
            if (destination.expressionError) throw new Error(destination.expressionError);
        }
        if (!removeOnly) {
            for (i = 0; i < targets.length; i++) {
                var animators = group(targets[i], 0);
                for (j = 1; j <= animators.numProperties; j++) {
                    var generated = animators.property(j);
                    if (!/^DM Text - (In|Out) (Motion|Opacity)$/.test(generated.name)) continue;
                    var amountProp = generated.property('ADBE Text Selectors').property(1).property('ADBE Text Expressible Amount');
                    if (amountProp.expressionError) throw new Error(amountProp.expressionError);
                    var properties = generated.property('ADBE Text Animator Properties');
                    for (var z = 1; z <= properties.numProperties; z++) {
                        var property = properties.property(z);
                        if (property.expressionEnabled && property.expressionError) throw new Error(property.expressionError);
                    }
                }
            }
        }
        return (removeOnly ? 'Removed DM text animations from ' : 'Applied ' + preset.name + ' to ') + targets.length + ' text layer(s).';
    } catch (e) {
        // Keep the previous animation if preparation fails; remove only this operation's additions.
        if (commitStarted) return 'Error: ' + (e.message || e.toString()).replace(/^(Error:\s*)+/, '') + '. Use Edit > Undo to restore the previous animation.';
        for (i = staged.length - 1; i >= 0; i--) {
            try { var p = group(staged[i].layer, staged[i].group).property(staged[i].index); if (p) p.remove(); } catch (ignore) {}
        }
        for (i = 0; i < old.length; i++) { try { group(old[i].layer, old[i].group).property(old[i].index).name = old[i].name; } catch (ignore2) {} }
        return 'Error: ' + (e.message || e.toString()).replace(/^(Error:\s*)+/, '') + '. If the layer changed, use Edit > Undo.';
    } finally { if (!withinUndo) app.endUndoGroup(); }
}
