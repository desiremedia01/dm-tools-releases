/* DM Tools Text Presets — independent gallery and native AE bridge. */
window.DmTextPresetEditor = function (container, onChange) {
    'use strict';
    var suppress = false, enabled = true, previewContent = 'Your text';
    var model = window.DMTextPresets, current = model.presets[0], group = 0, family = -1, busy = false;
    var tiles = [], running = [];
    function el(tag, cls, text) { var e = document.createElement(tag); e.className = cls || ''; if (text !== undefined) e.textContent = text; return e; }
    function button(parent, label, action, cls) { var b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', action); parent.appendChild(b); return b; }
    var overlay = el('div', 'dm-tp dm-tp-inline');
    var panel = el('div', 'dm-tp-panel'); overlay.appendChild(panel); container.appendChild(overlay);
    var groups = el('div', 'dm-tp-tabs'); groups.setAttribute('aria-label', 'Animate by'); panel.appendChild(groups);
    var groupButtons = model.groups.map(function (name, i) { return button(groups, name, function () { group = i; draw(); }); });
    var filters = el('div', 'dm-tp-filters'); panel.appendChild(filters);
    var filterButtons = [button(filters, 'All', function () { family = -1; draw(); })];
    model.families.forEach(function (name, i) { filterButtons.push(button(filters, name, function () { family = i; draw(); })); });
    var grid = el('div', 'dm-tp-grid'); panel.appendChild(grid);
    var selected = el('div', 'dm-tp-selected'); panel.appendChild(selected);
    var speedBar = el('div', 'dm-tp-speed'), speedHead = el('div', 'dm-tp-speed-head');
    var speedLabel = el('label', '', 'Speed'), speedValue = el('output', '', '1×');
    var speed = el('input'); speed.type = 'range'; speed.min = .25; speed.max = 4; speed.step = .05; speed.value = 1;
    speed.setAttribute('aria-label', 'Animation speed');
    speedLabel.appendChild(speedValue); speedHead.appendChild(speedLabel);
    var speedShortcuts = el('div', 'dm-tp-speed-shortcuts'); speedHead.appendChild(speedShortcuts);
    [[.5, 'Slow'], [1, 'Normal'], [2, 'Fast']].forEach(function (item) {
        button(speedShortcuts, item[1], function () { speed.value = item[0]; updateSpeedLabel(); notify(); });
    });
    speedBar.appendChild(speedHead); speedBar.appendChild(speed); panel.appendChild(speedBar);
    function updateSpeedLabel() {
        var value = Number(speed.value);
        speedValue.textContent = Number(value.toFixed(2)) + '×';
        speed.setAttribute('aria-valuetext', value + ' times normal speed');
        speed.disabled = !enabled;
    }
    speed.addEventListener('input', updateSpeedLabel);
    // Commit on release/key change, keeping one sync/Undo step per adjustment.
    speed.addEventListener('change', function () { updateSpeedLabel(); notify(); });
    var advanced = el('details', 'dm-tp-advanced'); advanced.appendChild(el('summary', '', 'Timing & motion settings')); panel.appendChild(advanced);
    var controls = el('div', 'dm-tp-controls'); advanced.appendChild(controls);
    function number(label, value, min, max, step) {
        var wrap = el('label', '', label), input = el('input'); input.type = 'number'; input.value = value; input.min = min; input.max = max; input.step = step; wrap.appendChild(input); controls.appendChild(wrap); return input;
    }
    function select(label, values) {
        var wrap = el('label', '', label), input = el('select');
        values.forEach(function (s, i) { var option = el('option', '', s); option.value = i; input.appendChild(option); });
        wrap.appendChild(input); controls.appendChild(wrap); return input;
    }
    var mode = select('Animation', ['In + Out', 'In only', 'Out only']);
    var duration = number('Duration (s)', .5, .05, 5, .05);
    var delay = number('Stagger (s)', .04, 0, .5, .01);
    var amount = number('Amount (%)', 100, 0, 500, 5);
    var direction = select('Direction', ['From below', 'From right', 'From above', 'From left']);
    var easing = number('Easing', 3, 1, 5, .5);
    var spring = number('Spring', 35, 0, 100, 5);
    var seed = number('Random seed', 1, 0, 9999, 1);
    advanced.appendChild(el('p', 'dm-tp-hint', 'Duration is per element. Stagger delays each letter, word or line. Entry and exit follow the layer edges; short layers fit automatically. Previews are illustrative.'));
    function options() {
        if (!enabled) return null;
        return model.validate({id: current.id, speed: speed.value, duration: duration.value, delay: delay.value,
            amount: amount.value, direction: direction.value, mode: mode.value, easing: easing.value,
            spring: spring.value, seed: seed.value});
    }
    function notify() { if (suppress) return; try { onChange(options()); } catch (e) { /* Invalid input is reported by the editor on Apply. */ } }
    function choose(p) {
        current = p; selected.textContent = p.name;updateSpeedLabel();
        tiles.forEach(function (t) { t.button.setAttribute('aria-pressed', String(t.preset.id === p.id)); });
        spring.disabled = p.variant !== 2; seed.disabled = p.variant !== 3;
        direction.disabled = p.family !== 1;
        amount.disabled = p.family === 0 && p.variant !== 2;
        amount.parentNode.firstChild.textContent = p.family === 1 ? 'Distance (px)' : p.family === 2 ? 'Rotation (°)' : 'Scale offset (%)';
        if (!suppress) { enabled = true; updateSpeedLabel(); notify(); }
    }
    function stopPreviews() { running.forEach(function (a) { a.cancel(); }); running = []; }
    function animate(tile) {
        if (!tile.sample.firstChild || typeof tile.sample.firstChild.animate !== 'function') return;
        var p = tile.preset, nodes = tile.sample.children, total = nodes.length;
        for (var i = 0; i < total; i++) {
            var k = p.variant === 1 ? total - 1 - i : p.variant === 3 ? ((i * 7 + 3) % total) : i;
            var transform = p.family === 1 ? 'translateY(22px)' : p.family === 2 ? 'rotate(-32deg)' : p.family === 3 || p.variant === 2 ? 'scale(.2)' : 'none';
            var a = nodes[i].animate([{opacity: 0, transform: transform}, {opacity: 1, transform: 'none', offset: .48}, {opacity: 1, transform: 'none', offset: .72}, {opacity: 0, transform: transform}],
                {duration: 2100 / Number(speed.value), delay: k * 60 / Number(speed.value), easing: p.variant === 2 ? 'cubic-bezier(.2,.8,.3,1.25)' : 'ease-out', fill: 'both'});
            a.onfinish = function () { this.cancel(); };
            running.push(a);
        }
    }
    function previews() { stopPreviews(); tiles.forEach(animate); }
    function fitSamples() {
        tiles.forEach(function (tile) {
            var sample = tile.sample, nodes = Array.prototype.slice.call(sample.children);
            sample.style.fontSize = '15px';
            var widths = nodes.map(function (n) { return n.getBoundingClientRect().width; });
            var width = tile.preset.group === 2 ? Math.max.apply(Math, widths.concat([1])) : widths.reduce(function (a, b) { return a + b; }, 0) + (tile.preset.group === 1 ? Math.max(0, nodes.length - 1) * 3 : 0);
            var fit = Math.min(1, Math.max(1, sample.clientWidth - 8) / Math.max(1, width));
            if (tile.preset.group === 2) fit = Math.min(fit, Math.max(1, sample.clientHeight - 4) / (Math.max(1, nodes.length) * 18));
            sample.style.fontSize = (15 * fit) + 'px';
            if (tile.preset.group === 1) sample.style.gap = (3 * fit) + 'px';
        });
    }
    function draw() {
        stopPreviews(); grid.textContent = ''; tiles = [];
        groupButtons.forEach(function (b, i) { b.setAttribute('aria-pressed', String(i === group)); });
        filterButtons.forEach(function (b, i) { b.setAttribute('aria-pressed', String(i === family + 1)); });
        var list = model.presets.filter(function (p) { return p.group === group && (family < 0 || p.family === family); });
        if (!list.some(function (p) { return p.id === current.id; })) current = list[0];
        list.forEach(function (p) {
            var b = button(grid, '', function () { choose(p); }); b.className = 'dm-tp-tile'; b.setAttribute('aria-label', p.name);
            var sample = el('div', 'dm-tp-sample'); sample.setAttribute('aria-hidden', 'true');
            var text = previewContent.replace(/\r\n?/g, '\n');
            var bits = p.group === 0 ? Array.from(text.replace(/\n/g, ' ')) : p.group === 1 ? text.trim().split(/\s+/) : text.split('\n');
            sample.style.gap = p.group === 1 ? '3px' : '0';
            sample.style.whiteSpace = 'pre';
            b.title = previewContent;
            bits.forEach(function (s) { sample.appendChild(el('span', '', s)); });
            if (p.group === 2) sample.classList.add('dm-tp-lines');
            b.appendChild(sample); b.appendChild(el('strong', '', model.families[p.family])); b.appendChild(el('small', '', model.variants[p.variant]));
            var tile = {button: b, sample: sample, preset: p};
            b.addEventListener('mouseenter', function () { animate(tile); });
            b.addEventListener('focus', function () { animate(tile); });
            tiles.push(tile);
        });
        fitSamples();
        choose(current); if ((container.tagName !== 'DETAILS' || container.open) && enabled) previews();
    }
    window.addEventListener('resize', fitSamples);
    controls.addEventListener('change', notify);
    container.addEventListener('toggle', function () { if ((container.tagName !== 'DETAILS' || container.open) && enabled) previews(); else stopPreviews(); });
    var fields = { duration: duration, delay: delay, amount: amount, direction: direction, mode: mode, easing: easing, spring: spring, seed: seed };
    return {
        set: function (value, text) {
            if (text !== undefined) previewContent = String(text) || 'Your text';
            suppress = true;
            enabled = value !== null;speed.value = value && value.speed !== undefined ? value.speed : 1;updateSpeedLabel();
            if (value) {
                current = model.get(value.id); group = current.group;
                Object.keys(fields).forEach(function (k) { fields[k].value = value[k]; });
            }
            draw(); suppress = false;
        },
        get: options,
        stop: stopPreviews
    };
};
