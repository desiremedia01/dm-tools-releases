/* macOS Keychain storage. No plaintext fallback and no secrets in process arguments. */
(function () {
    'use strict';
    var cp = require('child_process');
    var service = 'com.desiremedia.dmtools.secure.v1';
    function account(name) {
        if (!/^(google|google-client|higgsfield|ai-config)$/.test(name)) throw new Error('Unknown credential store.');
        return name;
    }
    var migrated=false;
    window.DmSecureStore = {
        get: function (name) {
            var result = cp.spawnSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account(name), '-w'], {encoding:'utf8',timeout:15000,maxBuffer:1048576});
            if (result.status === 44) return null;
            if (result.status !== 0) throw new Error('Unlock your macOS Keychain to continue.');
            try { return JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8')); }
            catch (_) { throw new Error('Invalid Keychain entry. Sign in again.'); }
        },
        set: function (name, data) {
            var value = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
            var result = cp.spawnSync('/usr/bin/security', ['-i'], {input:'add-generic-password -U -s '+service+' -a '+account(name)+' -w '+value+'\n',encoding:'utf8',timeout:15000,maxBuffer:1048576});
            if (result.status !== 0 || /SecKeychain|error|failed/i.test(result.stderr || '')) throw new Error('Could not save credentials in macOS Keychain.');
            var saved = this.get(name);
            if (JSON.stringify(saved) !== JSON.stringify(data)) throw new Error('Could not verify Keychain storage.');
        },
        migrateLegacy: function () {
            if(migrated)return;
            var fs=require('fs'),os=require('os'),path=require('path'),self=this;
            function readOwned(file){
                try{var stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576||stat.uid!==os.userInfo().uid)return null;return JSON.parse(fs.readFileSync(file,'utf8'));}
                catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e;}
            }
            var configPath=path.join(os.homedir(),'.dm-tools.json'),cfg=readOwned(configPath),secure=self.get('ai-config')||{},changed=false;
            if(cfg){['anthropic_key','gemini_key'].forEach(function(k){if(cfg[k]&&!secure[k]){secure[k]=cfg[k];changed=true;}});}
            var oldKey=localStorage.getItem('vg_anthropic_key');if(oldKey&&!secure.anthropic_key){secure.anthropic_key=oldKey;changed=true;}
            if(changed)self.set('ai-config',secure);
            if(cfg&&(cfg.anthropic_key||cfg.gemini_key)){
                delete cfg.anthropic_key;delete cfg.gemini_key;
                var tmp=configPath+'.secure-'+require('crypto').randomBytes(8).toString('hex');
                fs.writeFileSync(tmp,JSON.stringify(cfg,null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,configPath);
            }
            localStorage.removeItem('vg_anthropic_key');
            var tokenPath=path.join(os.homedir(),'.higgsfield_token'),legacy=readOwned(tokenPath);
            if(legacy&&legacy.access_token){
                if(!self.get('higgsfield'))self.set('higgsfield',legacy);
                // Other applications share this file; do not delete their session.
                fs.chmodSync(tokenPath,0o600);
            }
            migrated=true;
        },
        remove: function (name) {
            var result = cp.spawnSync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account(name)], {encoding:'utf8',timeout:15000});
            if (result.status !== 0 && result.status !== 44) throw new Error('Could not remove Keychain credentials.');
        }
    };
})();
