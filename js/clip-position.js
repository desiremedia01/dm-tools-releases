/* Drag X/Y horizontally in sequence pixels; double-click for optional typing.
   Reads, scrub writes, Align and guarded Position history share one CEP queue.
   Each drag is one panel history entry; this is independent of Premiere's Undo. */
(function () {
    'use strict';
    function init() {
        var row = document.getElementById('prPosition');
        if (!row || HOST !== 'PPRO' || !cs) return;
        var inputs = [document.getElementById('prPositionX'), document.getElementById('prPositionY'), document.getElementById('prScale')];
        var controlAxes = { prPositionX: 'x', prPositionY: 'y', prScale: 'scale' };
        function controlAxis(input) { return controlAxes[input.id] || null; }
        var note = document.getElementById('prPositionNote');
        // macOS CEP reserves Cmd+Z inside text widgets, even readonly inputs.
        // End each Position gesture on a non-editable focus target.
        row.tabIndex = -1;
        var state = null, busy = false, pending = null, activeWrite = null, gesture = null, editing = null, dragRead = null;
        var timer = null, lastWrite = 0, readWanted = false, alignWanted = false;
        var past = [], future = [], historyWanted = [], historyState = null, historyEpoch = 0;
        var ownsHistory = false, keysRegistered = null;
        var nativeCommits = [], nativeBusy = false, blurTimer = null, lastTransformError = null;
        var isMac = /Mac/i.test(navigator.platform), nativeZ = isMac ? 6 : 90;
        function script(args) {
            return 'if(typeof prTransformSelected!=="function"||prTransformSelected.dmHistoryVersion!==7){$.evalFile(' + JSON.stringify(getPrJsxPath()) + ');}prTransformSelected(' + args + ');';
        }
        function number(value) { return String(Math.round(value * 100) / 100); }
        function message(text) { note.textContent = text || ''; note.hidden = !text; }
        function parse(result) {
            var parts = String(result || '').split('|');
            if ((parts.length !== 6 && parts.length !== 9) || parts[0] !== 'OK' || !parts[1]) return null;
            function values(offset) {
                var v = [Number(parts[offset]), Number(parts[offset + 1]), parts[offset + 2] === 'NA' ? null : Number(parts[offset + 2])];
                return isFinite(v[0]) && isFinite(v[1]) && (v[2] === null || isFinite(v[2])) ? v : null;
            }
            var current = values(2), previous = parts.length === 9 ? values(6) : null;
            if (!current || (parts.length === 9 && !previous)) return null;
            return { key: parts[1], values: current, previous: previous, scaleReason: decodeURIComponent(parts[5]) };
        }
        function same(a, b) {
            return a && b && a.length === b.length && a.every(function (value, index) {
                return value === null || b[index] === null ? value === b[index] : Math.abs(value - b[index]) < 0.01;
            });
        }
        function updateUndoButton() {
            var button = document.getElementById('undoBtn');
            var localUndo = document.getElementById('prTransformUndo');
            if (localUndo) localUndo.disabled = !past.length || busy || !!pending || !!gesture || !!editing || !!historyWanted.length;
            if (past.length) {
                trackEffect('Position', null, null);
                if (button) button.title = 'Undo Position / Scale';
            } else if (_lastEffect && _lastEffect.type === 'Position') {
                _lastEffect = null;
                if (button) { button.style.display = 'none'; button.title = 'Undo last effect'; }
            }
        }
        function clearHistory() {
            past = []; future = []; historyWanted = []; nativeCommits = []; historyState = null;
            ownsHistory = false; historyEpoch++; updateUndoButton();
        }
        function changeFor(key) { return { key: key, epoch: historyEpoch, before: null, after: null, complete: false, nativeQueued: false }; }
        function recordChange(job, next) {
            var change = job.change;
            if (change.epoch !== historyEpoch) return;
            if (!change.before) change.before = next.previous.slice();
            change.after = next.values.slice();
            if (!same(next.previous, next.values)) { future = []; ownsHistory = true; }
            if (!same(change.before, change.after)) {
                if (past.indexOf(change) < 0) past.push(change);
                if (past.length > 100) past.shift();
            } else if (past[past.length - 1] === change) past.pop();
            if (ownsHistory) historyState = { key: next.key, values: next.values.slice() };
            if (change.complete && !change.nativeQueued && !same(change.before,change.after)) {
                change.axis = job.axis; change.nativeQueued = true; nativeCommits.push(change);
            }
            updateUndoButton();
        }
        // Leave Cmd/Ctrl+Z with Premiere: completed gestures now create native Undo.
        function updateKeyInterest() {}
        if (typeof cs.registerKeyEventsInterest === 'function') cs.registerKeyEventsInterest('');
        function render() {
            inputs.forEach(function (input, index) {
                var blocked = nativeBusy || alignWanted || historyWanted.length > 0 || (!gesture && !editing && (!!activeWrite || !!pending)) ||
                    (dragRead && dragRead.index !== index) ||
                    (gesture && gesture.index !== index) || (editing && editing.index !== index);
                // Keep an in-progress text edit stable. Committed edits and drags
                // move focus to the group so CEP can deliver registered shortcuts.
                input.disabled = (index === 2 && state && state.values[2] === null) || (!!blocked && document.activeElement !== input);
                input.setAttribute('aria-disabled', input.disabled ? 'true' : 'false');
                if (index === 2) input.title = state && state.scaleReason ? state.scaleReason : 'Scale in %. Drag to adjust; double-click to type.';
                input.readOnly = !editing || editing.index !== index;
                if (editing && editing.index === index) return;
                var value = state ? state.values[index] : null;
                if (activeWrite && activeWrite.index === index) value = activeWrite.value;
                if (pending && pending.index === index) value = pending.value;
                if (gesture && gesture.index === index) value = gesture.value;
                input.value = value === null ? '' : number(value);
            });
            row.classList.toggle('is-scrubbing', !!gesture && gesture.moved);
            document.documentElement.classList.toggle('dm-position-dragging', !!gesture && gesture.moved);
            updateKeyInterest();
            updateUndoButton();
        }
        function stopDrag() {
            gesture = null; dragRead = null;
            if (timer) { clearTimeout(timer); timer = null; }
            row.classList.remove('is-scrubbing');
            document.documentElement.classList.remove('dm-position-dragging');
        }
        function failed(result, notify) {
            lastTransformError = {time:Date.now(), result:String(result), axis:activeWrite ? activeWrite.axis : gesture ? gesture.axis : null,
                values:state ? state.values.slice() : null, nativeBusy:nativeBusy};
            console.warn('DM Tools transform',lastTransformError);
            pending = null; editing = null; state = null; stopDrag(); clearHistory(); render();
            var text = String(result || 'Could not read Position.').replace(/^Error: /, '');
            message(text);
            if (notify) setStatus(text, 'error');
        }
        function pump() {
            if (busy) return;
            if (dragRead) {
                var start = dragRead;
                busy = true;
                evalScript(script(''), function (result) {
                    busy = false;
                    if (dragRead !== start) { pump(); return; }
                    var next = parse(result);
                    if (!next || next.values[start.index] === null) { failed(next ? next.scaleReason : result, true); return; }
                    if (historyState && (historyState.key !== next.key || !same(historyState.values, next.values))) clearHistory();
                    state = next; dragRead = null;
                    gesture = { key: next.key, index: start.index, axis: start.axis, startX: start.startX,
                        startValue: next.values[start.index], value: next.values[start.index], moved: false, change: changeFor(next.key) };
                    queueDrag(start.latestX);
                    if (start.released) { gesture.change.complete = true; stopDrag(); }
                    message(next.scaleReason); render(); pump();
                });
                return;
            }
            if (alignWanted) {
                alignWanted = false; busy = true; render();
                evalScript('$.evalFile(' + JSON.stringify(getPrJsxPath()) + ');prFrameSelected("align");', function (result) {
                    busy = false; handleResult(result); readWanted = true; pump();
                });
                return;
            }
            if (pending) {
                var delay = 100 - (Date.now() - lastWrite);
                if (gesture && delay > 0) {
                    if (!timer) timer = setTimeout(function () { timer = null; pump(); }, delay);
                    return;
                }
                var job = pending; pending = null;
                if (!job.axis || controlAxis(inputs[job.index]) !== job.axis) { failed('Unknown transform control. Reopen DM Tools.', true); return; }
                activeWrite = job; busy = true; lastWrite = Date.now();
                render();
                evalScript(script(JSON.stringify(job.axis) + ',' + job.value + ',' + JSON.stringify(job.key) + ',' + JSON.stringify(state.values)), function (result) {
                    busy = false; activeWrite = null;
                    var next = parse(result);
                    if (!next || !next.previous || next.key !== job.key) failed(next ? 'Selection changed. Adjust the current clip again.' : result, true);
                    else { recordChange(job, next); state = next; message(next.scaleReason); render(); }
                    pump();
                });
                return;
            }
            if (nativeCommits.length) {
                var change = nativeCommits.shift();
                busy = true; nativeBusy = true; render();
                var args = JSON.stringify(change.axis)+','+JSON.stringify(change.before)+','+JSON.stringify(change.after)+','+JSON.stringify(change.key);
                evalScript('$.evalFile('+JSON.stringify(getPrJsxPath())+');prTransformNativeCommit('+args+');',function(result){
                    busy = false; nativeBusy = false;
                    var parts=String(result||'').split('|'), next=parts[0]==='NATIVE'?parse(parts.slice(3).join('|')):parts[0]==='SYNC'?parse(parts.slice(1).join('|')):null;
                    if(!next) failed(result,true);
                    else {
                        if(parts[0]==='SYNC')clearHistory();
                        else {
                            change.native={before:Number(parts[1]),after:Number(parts[2])};
                            change.after=next.values.slice();
                            historyState={key:next.key,values:next.values.slice()};
                        }
                        state=next; message(next.scaleReason); render();
                    }
                    pump();
                });
                return;
            }
            if (historyWanted.length) {
                var direction = historyWanted.shift(), undo = direction === 'undo';
                var from = undo ? past : future, to = undo ? future : past;
                var entry = from[from.length - 1];
                if (!entry) {
                    setStatus(undo ? 'No earlier Position / Scale changes in this panel.' : 'No Position / Scale changes to redo.', 'info');
                    render(); pump(); return;
                }
                var target = undo ? entry.before : entry.after;
                var expected = undo ? entry.after : entry.before;
                var epoch = historyEpoch;
                busy = true; render();
                var historyScript = entry.native ? '$.evalFile('+JSON.stringify(getPrJsxPath())+');prTransformNativeHistory('+JSON.stringify(direction)+','+JSON.stringify(entry.key)+','+JSON.stringify(expected)+','+JSON.stringify(target)+','+(undo?entry.native.after:entry.native.before)+');' : script('"restore",' + JSON.stringify(target) + ',' + JSON.stringify(entry.key) + ',' + JSON.stringify(expected));
                evalScript(historyScript, function (result) {
                    busy = false;
                    var next = parse(result);
                    if (!next || next.key !== entry.key || !same(next.values, target)) failed(next ? 'Could not restore the previous Position.' : result, true);
                    else {
                        if (epoch === historyEpoch) {
                            from.pop(); to.push(entry);
                            historyState = { key: next.key, values: next.values.slice() };
                            updateUndoButton();
                        }
                        state = next; message(next.scaleReason); render();
                        setStatus(undo ? 'Position / Scale undone.' : 'Position / Scale redone.', 'success');
                    }
                    readWanted = true; pump();
                });
                return;
            }
            if (!readWanted || gesture || editing || document.hidden) { render(); return; }
            readWanted = false; busy = true;
            evalScript(script(''), function (result) {
                busy = false;
                var next = parse(result), context = gesture || editing || pending;
                if (!next) failed(result, !!context);
                else if (context && context.key !== next.key) failed('Selection changed. Adjust the current clip again.', true);
                else {
                    if (!context && historyState && (historyState.key !== next.key || !same(historyState.values, next.values))) clearHistory();
                    state = next; message(next.scaleReason); render();
                }
                pump();
            });
        }
        function refresh() { readWanted = true; pump(); }
        function requestHistory(direction) {
            editing = null; stopDrag(); historyWanted.push(direction); render(); pump();
        }
        function queueDrag(clientX) {
            if (!gesture) return;
            var delta = clientX - gesture.startX;
            if (!gesture.moved && Math.abs(delta) < 3) return;
            gesture.moved = true;
            gesture.value = Math.round((gesture.startValue + delta) * 100) / 100;
            if (gesture.index === 2) gesture.value = Math.max(0, Math.min(10000, gesture.value));
            pending = { key: gesture.key, index: gesture.index, axis: gesture.axis, value: gesture.value, change: gesture.change };
        }
        function finishDrag(event) {
            if (dragRead) {
                if (event && event.type === 'mouseup' && typeof event.clientX === 'number') dragRead.latestX = event.clientX;
                dragRead.released = true;
                pump(); return;
            }
            if (!gesture) return;
            // Include the release coordinate if the browser coalesced the last move.
            if (event && event.type === 'mouseup' && typeof event.clientX === 'number') {
                var delta = event.clientX - gesture.startX;
                if (gesture.moved || Math.abs(delta) >= 3) {
                    gesture.value = Math.round((gesture.startValue + delta) * 100) / 100;
                    if (gesture.index === 2) gesture.value = Math.max(0, Math.min(10000, gesture.value));
                    pending = { key: gesture.key, index: gesture.index, axis: gesture.axis, value: gesture.value, change: gesture.change };
                }
            }
            // Mouseup flushes the final preview, then commits one native Undo step.
            gesture.change.complete = true;
            if (gesture.change.before && !gesture.change.nativeQueued && !same(gesture.change.before,gesture.change.after)) {
                gesture.change.axis=gesture.axis; gesture.change.nativeQueued=true; nativeCommits.push(gesture.change);
            }
            stopDrag(); pump();
        }
        function commit(input, index) {
            if (!editing || editing.index !== index) return;
            var edit = editing; editing = null; input.readOnly = true;
            var text = input.value.trim().replace(',', '.');
            if (document.activeElement === input) row.focus();
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !isFinite(Number(text))) {
                render(); message('Enter a valid Position value in pixels.');
                setStatus('Enter a valid Position value in pixels.', 'error'); return;
            }
            if (index === 2 && (Number(text) < 0 || Number(text) > 10000)) { render(); message('Scale must be between 0 and 10000%.'); return; }
            if (Number(text) !== edit.value) {
                var typedChange=changeFor(edit.key); typedChange.complete=true;
                pending = { key: edit.key, index: index, axis: edit.axis, value: Number(text), change: typedChange };
            }
            pump();
        }
        inputs.forEach(function (input, index) {
            input.readOnly = true;
            input.title = 'Drag left or right to adjust. Double-click to type.';
            input.addEventListener('mousedown', function (event) {
                if (event.button !== 0 || nativeBusy || nativeCommits.length || editing || gesture || dragRead || activeWrite || pending || alignWanted || historyWanted.length || input.disabled) return;
                event.preventDefault();
                dragRead = { index: index, axis: controlAxis(input), startX: event.clientX, latestX: event.clientX, released: false };
                render(); row.focus(); pump();
            });
            input.addEventListener('dblclick', function (event) {
                if (!state || input.disabled || busy || activeWrite || pending || alignWanted || historyWanted.length) return;
                event.preventDefault(); stopDrag();
                editing = { key: state.key, index: index, axis: controlAxis(input), value: Number(input.value) };
                render(); input.focus(); input.select();
            });
            input.addEventListener('change', function () { commit(input, index); });
            input.addEventListener('blur', function () { commit(input, index); });
            input.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    if (editing) { if (editing.index === index) commit(input, index); }
                    else if (state && !busy && !activeWrite && !pending && !alignWanted && !historyWanted.length) {
                        editing = { key: state.key, index: index, axis: controlAxis(input), value: Number(input.value) };
                        render(); input.select();
                    }
                }
                if (event.key === 'Escape' && editing) {
                    event.preventDefault(); editing = null; input.readOnly = true; row.focus(); render(); refresh();
                }
            });
        });
        document.addEventListener('mousemove', function (event) {
            if (dragRead) {
                dragRead.latestX = event.clientX;
                if (event.buttons === 0) finishDrag();
                else event.preventDefault();
                return;
            }
            if (!gesture) return;
            if (event.buttons === 0) { finishDrag(); return; }
            event.preventDefault(); queueDrag(event.clientX); render(); pump();
        });
        document.addEventListener('mouseup', finishDrag);
        // Only claim shortcuts while Position owns the panel history. Other tools
        // release the registration, and editable text keeps the browser's text undo.
        document.addEventListener('click', function (event) {
            var button = event.target.closest ? event.target.closest('[data-action]') : null;
            if (!button) return;
            pending = null; editing = null; stopDrag(); clearHistory(); render();
        }, true);
        // CEP can briefly blur while activating the panel on the first click.
        // Keep the gesture through that transition; real focus loss still ends it.
        window.addEventListener('blur', function () {
            if(blurTimer)clearTimeout(blurTimer);
            blurTimer=setTimeout(function(){
                blurTimer=null;
                if(!document.hasFocus())finishDrag();
            },120);
        });
        window.addEventListener('focus', function(){
            if(blurTimer){clearTimeout(blurTimer);blurTimer=null;}
            refresh();
        });
        document.addEventListener('visibilitychange', function () { if (document.hidden) finishDrag(); else refresh(); });
        document.getElementById('prTransformUndo').addEventListener('click', function () { requestHistory('undo'); row.focus(); });
        window.DmClipPosition = {
            getDiagnostics:function(){return lastTransformError;},
            refresh: refresh,
            undo: function () { requestHistory('undo'); },
            align: function () {
                pending = null; editing = null; stopDrag(); clearHistory(); alignWanted = true;
                setStatus('Centring clips...', 'busy'); render(); pump();
            }
        };
        render(); refresh(); setInterval(refresh, 800);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
}());
