/* ── Quick Still ──────────────────────────────────────────────────────
   Same method as Quick Export, but grabs a SINGLE frame at the playhead
   from the rendered Premiere sequence (Program Monitor),
   optionally bakes in a conversion LUT, and saves a PNG into the project's
   "assets" folder (one level above the .prproj), then reveals it in Finder.
   Great for grabbing a reference still for Higgsfield jobs. */
(function () {
    if (typeof document === 'undefined') return;

    var FFMPEG_PATHS = ['/Applications/Wavdrop.app/Contents/Resources/ffmpeg',
        '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg',
        '/Users/desiremedia/Library/Python/3.9/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg'];

    function extRoot() { try { return (typeof cs !== 'undefined' && cs) ? cs.getSystemPath('extension') : '.'; } catch (e) { return '.'; } }
    function lutsPath() { return extRoot() + '/assets/luts/conversion/'; }
    function ffmpegCandidates() {
        var out = [];
        try { var b = window.DM_BUNDLED_FFMPEG && window.DM_BUNDLED_FFMPEG(); if (b) out.push(b); } catch (e) {}
        try { var fs = require('fs'); for (var i = 0; i < FFMPEG_PATHS.length; i++) { if (fs.existsSync(FFMPEG_PATHS[i]) && out.indexOf(FFMPEG_PATHS[i]) === -1) out.push(FFMPEG_PATHS[i]); } } catch (e) {}
        return out;
    }
    function listLuts() {
        try { return require('fs').readdirSync(lutsPath()).filter(function (f) { return /\.cube$/i.test(f); }).map(function (f) { return f.replace(/\.cube$/i, ''); }); }
        catch (e) { return []; }
    }
    function revealInFinder(p) { try { require('child_process').execFile('/usr/bin/open', ['-R', p]); } catch (e) {} }

    var btn = document.getElementById('prQuickStill');
    if (!btn) return;

    // Read sequence metadata only; never resolve back to the landscape source.
    var jsxRead = '(function(){try{var s=app.project.activeSequence;if(!s)return "ERR:No active sequence";return "OK\\t"+(app.project.path||"")+"\\t"+(s.name||"Sequence");}catch(e){return "ERR:"+e;}}())';

    btn.addEventListener('click', function () {
        if (HOST !== 'PPRO') { setStatus('Quick Still only works in Premiere', 'error'); return; }
        var ffList = ffmpegCandidates();

        evalScript(jsxRead, function (res) {
            if (!res || res.indexOf('ERR:') === 0) { setStatus(res ? res.replace('ERR:', '') : 'Could not read timeline', 'error'); return; }
            var p = res.split('\t');
            var info = {projPath:p[1]||'',name:p[2]||'Sequence'};
            showLutPicker(info);
        });
    });

    function showLutPicker(info) {
        var luts = listLuts();
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = '<div style="background:#1e1e1e;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:18px 20px;min-width:240px">' +
            '<div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:10px">Quick Still — LUT</div>' +
            '<select id="qsLutPick" style="width:100%;background:#2a2a2a;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:7px;font-size:12px;margin-bottom:14px">' +
            '<option value="" style="background:#2a2a2a;color:#fff">— No LUT —</option>' + luts.map(function (l) { var sel = ''; return '<option value="' + l + '"' + sel + ' style="background:#2a2a2a;color:#fff">' + l + '</option>'; }).join('') + '</select>' +
            '<div style="display:flex;gap:8px"><button id="qsCancel" class="btn" style="flex:1">Cancel</button>' +
            '<button id="qsGo" class="btn btn--accent" style="flex:1">Grab Still</button></div></div>';
        document.body.appendChild(overlay);
        document.getElementById('qsCancel').onclick = function () { overlay.remove(); };
        document.getElementById('qsGo').onclick = function () {
            var lut = document.getElementById('qsLutPick').value;
            overlay.remove();
            runStill(info, lut, ffmpegCandidates());
        };
    }

    // Target dir: the project's "assets" folder — a sibling of the project folder
    // (one level above where the .prproj lives, matching the /job/assets convention).
    function assetsDir(projPath) {
        var path = require('path'), fs = require('fs');
        if (!projPath) return process.env.HOME + '/Desktop';
        var projDir = path.dirname(projPath);
        var parent = path.dirname(projDir);
        var candidates = [path.join(parent, 'assets'), path.join(projDir, 'assets')];
        for (var i = 0; i < candidates.length; i++) {
            try { if (fs.existsSync(candidates[i]) && fs.statSync(candidates[i]).isDirectory()) return candidates[i]; } catch (e) {}
        }
        return path.join(parent, 'assets');
    }

    function lutFile(lutName) {
        if (!lutName) return '';
        try { var tl = require('os').tmpdir() + '/dm_qs_lut.cube'; require('fs').copyFileSync(lutsPath() + lutName + '.cube', tl); return tl; } catch (e) { return ''; }
    }
    function finishStill(outPath) {
        revealInFinder(outPath);
        setStatus('Still saved ✓ ' + require('path').basename(outPath), 'success');
        btn.disabled = false;
    }

    // Next free integer name in the folder (max existing number + 1, else 1),
    // considering both .png and .jpg so numbers never collide.
    function nextNumber(outDir) {
        var max = 0;
        try {
            require('fs').readdirSync(outDir).forEach(function (f) {
                var m = f.match(/^(\d+)\.(png|jpe?g)$/i);
                if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
            });
        } catch (e) {}
        return max + 1;
    }

    function runStill(info, lutName, ffList) {
        var fs = require('fs'), path = require('path'), cp = require('child_process');
        var outDir = assetsDir(info.projPath);
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
        var num = nextNumber(outDir);
        var outPath = path.join(outDir, num + '.png');
        var tmpPath = path.join(outDir, '.tmp_still_' + Date.now() + '.png');
        var vf = ''; var lf = lutFile(lutName); if (lf) vf = 'lut3d=' + lf;

        setStatus('Grabbing still' + (lutName ? ' (' + lutName + ')' : '') + '...', 'busy');
        btn.disabled = true;

        renderViaPremiere(lutName, vf, outDir, ffList, outPath);
    }

    // Export the composited Program Monitor frame, including sequence dimensions.
    function renderViaPremiere(lutName, vf, outDir, ffList, outPath) {
        var fs=require('fs'),cp=require('child_process'),path=require('path');
        var tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'dm-still-')),base=path.join(tmp,'frame');
        function clean(){try{fs.readdirSync(tmp).forEach(function(f){fs.unlinkSync(path.join(tmp,f));});fs.rmdirSync(tmp);}catch(e){}}
        function fail(message){clean();setStatus(message,'error');btn.disabled=false;}
        var jsx='(function(){try{var s=app.project.activeSequence;if(!s)return "ERR:No active sequence";app.enableQE();var q=qe.project.getActiveSequence();if(!q)return "ERR:Activate the timeline first";var settings=s.getSettings();q.exportFramePNG(q.CTI.timecode,'+JSON.stringify(base)+');return "OK|"+settings.videoFrameWidth+"|"+settings.videoFrameHeight;}catch(e){return "ERR:"+e;}}())';
        evalScript(jsx,function(res){
            if(!res||res.indexOf('OK|')!==0){fail('Timeline frame export failed: '+(res||'No response from Premiere'));return;}
            var meta=res.split('|'),width=Number(meta[1]),height=Number(meta[2]),deadline=Date.now()+30000,last=-1,stable=0;
            function wait(){
                var file=fs.existsSync(base+'.png')?base+'.png':base;
                try{var stat=fs.statSync(file);if(stat.size>24&&stat.size===last)stable++;else stable=0;last=stat.size;
                    if(stable>=2){var data=fs.readFileSync(file);
                        if(data.readUInt32BE(0)!==0x89504e47||data.readUInt32BE(4)!==0x0d0a1a0a)throw new Error('Premiere returned an invalid PNG.');
                        if(width>0&&height>0&&(data.readUInt32BE(16)!==width||data.readUInt32BE(20)!==height))throw new Error('The exported frame does not match the sequence dimensions.');
                        if(!vf){fs.writeFileSync(outPath,data,{flag:'wx'});clean();finishStill(outPath);return;}
                        convert(file,0);return;
                    }
                }catch(e){if(e.code!=='ENOENT'){fail('Timeline frame export failed: '+e.message);return;}}
                if(Date.now()>deadline){fail('Premiere did not export the timeline frame. Try again with the Program Monitor active.');return;}
                setTimeout(wait,250);
            }
            function convert(file,i){if(i>=ffList.length){fail('Could not apply the selected LUT to the timeline frame.');return;}
                cp.execFile(ffList[i],['-n','-i',file,'-frames:v','1','-vf',vf,outPath],{timeout:120000},function(err){if(err){try{fs.unlinkSync(outPath);}catch(e){}convert(file,i+1);return;}clean();finishStill(outPath);});
            }
            wait();
        });
    }
})();
