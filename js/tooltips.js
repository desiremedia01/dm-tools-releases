/* Render approved button help inside CEP, where native title tips may not appear. */
(function () {
    'use strict';
    var bubble = document.createElement('div');
    bubble.id = 'dmToolTip';
    bubble.className = 'dm-tool-tip';
    bubble.setAttribute('role', 'tooltip');
    bubble.hidden = true;
    document.body.appendChild(bubble);
    var target = null, timer = null;
    function button(node) {
        return node && node.closest ? node.closest('button[data-help]') : null;
    }
    function hide() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (target) {
            var ids = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (id) { return id && id !== bubble.id; });
            if (ids.length) target.setAttribute('aria-describedby', ids.join(' '));
            else target.removeAttribute('aria-describedby');
        }
        target = null; bubble.hidden = true;
    }
    function show(next) {
        if (target === next) return;
        hide(); target = next;
        timer = setTimeout(function () {
            timer = null;
            if (target !== next || !next.isConnected) return;
            bubble.textContent = next.getAttribute('data-help');
            bubble.style.maxWidth = Math.max(1, Math.min(280, window.innerWidth - 20)) + 'px';
            bubble.hidden = false;
            var r = next.getBoundingClientRect(), b = bubble.getBoundingClientRect();
            var left = Math.max(10, Math.min(r.left + r.width / 2 - b.width / 2, window.innerWidth - b.width - 10));
            var top = r.bottom + 8;
            if (top + b.height > window.innerHeight - 10) top = Math.max(10, r.top - b.height - 8);
            bubble.style.left = left + 'px'; bubble.style.top = top + 'px';
            var ids = next.getAttribute('aria-describedby') || '';
            next.setAttribute('aria-describedby', (ids ? ids + ' ' : '') + bubble.id);
        }, 1000);
    }
    document.addEventListener('mouseover', function (e) { var next = button(e.target); if (next) show(next); });
    document.addEventListener('mouseout', function (e) { if (button(e.target) === target && button(e.relatedTarget) !== target) hide(); });
    document.addEventListener('focusin', function (e) { var next = button(e.target); if (next) show(next); });
    document.addEventListener('focusout', function (e) { if (button(e.target) === target) hide(); });
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
}());
