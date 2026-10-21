/* DM Tools text motion. Original, self-contained ES3-compatible model. */
(function (root) {
    var api = {};
    api.groups = ['Letters', 'Words', 'Lines'];
    api.families = ['Fade', 'Position', 'Rotate', 'Scale'];
    api.variants = ['Smooth', 'Reverse', 'Spring', 'Scatter'];
    api.presets = [];
    for (var g = 0; g < 3; g++) for (var f = 0; f < 4; f++) for (var v = 0; v < 4; v++) {
        api.presets.push({ id: g + '-' + f + '-' + v, group: g, family: f, variant: v,
            name: api.groups[g] + ' ' + api.families[f] + ' · ' + api.variants[v] });
    }
    api.get = function (id) {
        for (var i = 0; i < api.presets.length; i++) if (api.presets[i].id === id) return api.presets[i];
        throw new Error('Choose a valid text preset.');
    };
    api.number = function (n, low, high, label) {
        n = Number(n);
        if (!isFinite(n) || n < low || n > high) throw new Error(label + ' must be between ' + low + ' and ' + high + '.');
        return n;
    };
    api.validate = function (o) {
        api.get(o.id);
        return { id: o.id, speed: api.number(o.speed === undefined ? 1 : o.speed, .25, 4, 'Speed'), duration: api.number(o.duration, .05, 5, 'Duration'),
            delay: api.number(o.delay, 0, .5, 'Stagger'), amount: api.number(o.amount, 0, 500, 'Amount'),
            spring: api.number(o.spring, 0, 100, 'Spring'), seed: api.number(o.seed, 0, 9999, 'Seed'),
            direction: api.number(o.direction, 0, 3, 'Direction'),
            mode: api.number(o.mode, 0, 2, 'Animation'), easing: api.number(o.easing, 1, 5, 'Easing') };
    };
    // Expression selector: textIndex/textTotal refer to the chosen grouping in AE.
    // In and Out share one fitted timeline, so short layers cannot have overlapping windows.
    api.expression = function (phase, opacity) {
        return [
            'function ctl(n){return effect("DM Text - "+n)(1);}',
            'var n=Math.max(1,textTotal), k=textIndex-1;',
            'var order=Math.round(ctl("Order"));',
            'if(order===2)k=n-1-k;',
            'if(order===3){seedRandom(Math.floor(ctl("Seed"))+textIndex,true);k=random(0,Math.max(0,n-1));}',
            'var di=Math.max(.05,ctl("In Duration")),do_=Math.max(.05,ctl("Out Duration"));',
            'var lag=Math.max(0,ctl("Stagger")),span=(n-1)*lag;',
            'var mode=Math.round(ctl("Mode")),hasIn=mode!==3,hasOut=mode!==2;',
            'var life=Math.max(thisComp.frameDuration,outPoint-inPoint);',
            'var fit=Math.min(1,Math.max(thisComp.frameDuration,life-thisComp.frameDuration)/((hasIn?di+span:0)+(hasOut?do_+span:0)));',
            'var enabled=' + (phase === 'in' ? 'hasIn' : 'hasOut') + ';',
            'var d=' + (phase === 'in' ? 'di' : 'do_') + '*fit;',
            'var t=' + (phase === 'in' ? '(time-inPoint)' : '(outPoint-time)') + '-k*lag*fit;',
            'var x=Math.max(0,Math.min(1,t/Math.max(.001,d)));',
            'var power=Math.max(1,Math.min(5,ctl("Easing")));',
            'var progress=1-Math.pow(1-x,power);',
            'if(ctl("Spring")>0 && x>0 && x<1){var z=x-1;var s=ctl("Spring")*.035;progress=1+(s+1)*z*z*z+s*z*z;}',
            'var amount=enabled?(1-progress)*100:0;',
            opacity ? 'amount=Math.max(0,Math.min(100,amount));' : '',
            '[amount,amount,amount];'
        ].join('\n');
    };
    api.motionExpression = function (kind, phase) {
        var sign = phase === 'in' ? 1 : -1;
        var base = 'function c(n){return effect("DM Text - "+n)(1);}\nvar a=c("Amount");\n';
        if (kind === 'position') return base + 'var d=Math.round(c("Direction"));var xy=[[0,a],[a,0],[0,-a],[-a,0]][d-1]||[0,a];['+sign+'*xy[0],'+sign+'*xy[1],0];';
        if (kind === 'rotation') return base + sign + '*a;';
        return base + 'var s=100-Math.min(100,a);[s,s,s];';
    };
    root.DMTextPresets = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(this);
