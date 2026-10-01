/* Desktop OAuth: PKCE, loopback-only callback and live identity validation.
   Requires a newly configured Google Desktop OAuth client (oauth-client.json).
   A local UI gate is not a license server or a security boundary for copied code. */
(function () {
    'use strict';
    var fs=require('fs'), path=require('path'), http=require('http'), https=require('https'), crypto=require('crypto'), cp=require('child_process');
    var activeCancel=null, email='';
    var root=new CSInterface().getSystemPath('extension');
    function config() {
        var c;
        try { c=JSON.parse(fs.readFileSync(path.join(root,'oauth-client.json'),'utf8')); }
        catch (_) { throw new Error('Secure sign-in needs Google Desktop OAuth setup. Contact your administrator.'); }
        if (c.type!=='desktop' || typeof c.client_id!=='string' || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(c.client_id)) throw new Error('Invalid Desktop OAuth configuration.');
        var credential=DmSecureStore.get('google-client');
        if(!credential||credential.client_id!==c.client_id||typeof credential.client_secret!=='string'||!credential.client_secret)
            {var setupError=new Error('Select the DM Tools login setup file supplied by your administrator.');setupError.code='DM_SETUP_REQUIRED';throw setupError;}
        c.client_secret=credential.client_secret;
        return c;
    }
    function request(url, form, token) {
        return new Promise(function(resolve,reject) {
            var u=new URL(url), data=form?new URLSearchParams(form).toString():null, size=0, chunks=[];
            var headers={};if(data){headers['Content-Type']='application/x-www-form-urlencoded';headers['Content-Length']=Buffer.byteLength(data);}if(token)headers.Authorization='Bearer '+token;
            var req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:data?'POST':'GET',headers:headers},function(res){
                res.on('data',function(b){size+=b.length;if(size>1048576){req.destroy(new Error('Identity response too large.'));return;}chunks.push(b);});
                res.on('error',reject);res.on('end',function(){if(res.statusCode!==200){
                    var stage=u.hostname==='oauth2.googleapis.com'?'Google token exchange':'Google account verification';
                    var providerCode='',description='';
                    try{var failure=JSON.parse(Buffer.concat(chunks).toString('utf8'));providerCode=typeof failure.error==='string'?failure.error:'';description=typeof failure.error_description==='string'?failure.error_description:'';}catch(_){}
                    var known=['invalid_request','invalid_client','invalid_grant','unauthorized_client','access_denied','redirect_uri_mismatch'];
                    var detail=known.indexOf(providerCode)>=0?' ('+providerCode+')':'';
                    if(/client_secret/i.test(description)&&/missing|required/i.test(description))detail+=': this Desktop client requires its client secret';
                    return reject(new Error(stage+' failed: HTTP '+res.statusCode+detail+'.'));
                }try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(_){reject(new Error('Invalid identity response.'));}});
            });req.setTimeout(15000,function(){req.destroy(new Error('Identity request timed out.'));});req.on('error',reject);if(data)req.write(data);req.end();
        });
    }
    function validate(token) {
        return request('https://www.googleapis.com/oauth2/v2/userinfo',null,token).then(function(user){
            if (user.verified_email!==true || typeof user.email!=='string' || !/^[^@\s]+@desiremedia\.com\.au$/i.test(user.email)) throw new Error('Only verified Desire Media accounts are allowed.');
            email=user.email;return email;
        });
    }
    function clearLegacy(){['dm_access_token','dm_refresh_token','dm_email','dm_expiry'].forEach(function(k){localStorage.removeItem(k);});}
    window.DmAuth={
        getEmail:function(){return email;},
        importClientConfig:function(){
            if(!window.cep||!window.cep.fs)throw new Error('Open DM Tools inside Adobe to import your login setup.');
            var choice=window.cep.fs.showOpenDialogEx(false,false,'Select DM Tools login setup JSON','',['json'],'','Select');
            if(!choice||choice.err||!choice.data||choice.data.length!==1)throw new Error('Login setup cancelled. Select the setup file to continue.');
            var selected=choice.data[0],stat=fs.lstatSync(selected);
            if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error('Invalid login setup file.');
            var parsed;try{parsed=JSON.parse(fs.readFileSync(selected,'utf8'));}catch(_){throw new Error('The selected file is not valid login setup JSON.');}
            var expected=JSON.parse(fs.readFileSync(path.join(root,'oauth-client.json'),'utf8'));
            var client=parsed.installed;
            if(!client||client.client_id!==expected.client_id||typeof client.client_secret!=='string'||!client.client_secret||client.client_secret.length>4096)throw new Error('This setup file belongs to a different Google client. Ask your administrator for the current DM Tools setup file.');
            DmSecureStore.set('google-client',{client_id:client.client_id,client_secret:client.client_secret});
        },
        logout:function(){if(activeCancel)activeCancel();email='';clearLegacy();DmSecureStore.remove('google');},
        checkAuth:function(valid,invalid){
            email='';clearLegacy();
            Promise.resolve().then(function(){var c=config(),t=DmSecureStore.get('google');if(!t||t.client_id!==c.client_id)throw new Error('Sign in again.');
                if(t.expires_at>Date.now()+30000)return t;
                if(!t.refresh_token)throw new Error('Sign in again.');
                return request('https://oauth2.googleapis.com/token',{client_id:c.client_id,client_secret:c.client_secret,refresh_token:t.refresh_token,grant_type:'refresh_token'}).then(function(n){n.refresh_token=n.refresh_token||t.refresh_token;n.client_id=c.client_id;n.expires_at=Date.now()+(Number(n.expires_in)||3600)*1000;DmSecureStore.set('google',n);return n;});
            }).then(function(t){return validate(t.access_token);}).then(valid,function(){email='';invalid();});
        },
        login:function(success,error){
            if(activeCancel)activeCancel();
            var c;try{c=config();}catch(e){if(e.code!=='DM_SETUP_REQUIRED'){error(e.message);return;}try{window.DmAuth.importClientConfig();c=config();}catch(setup){error(setup.message);return;}}
            var verifier=crypto.randomBytes(48).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''),state=crypto.randomBytes(32).toString('hex');
            var challenge=crypto.createHash('sha256').update(verifier).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
            var done=false, processing=false,redirect,timer;
            function finish(err,value){if(done)return;done=true;clearTimeout(timer);server.close();activeCancel=null;if(err)error(err.message);else success(value);}
            var server=http.createServer(function(req,res){
                var u;try{u=new URL(req.url,redirect);}catch(_){res.writeHead(400);res.end();return;}
                if(req.method!=='GET'||u.pathname!=='/callback'||u.searchParams.get('state')!==state||processing){res.writeHead(400);res.end('Invalid sign-in callback.');return;}
                var code=u.searchParams.get('code');if(!code){res.writeHead(400);res.end('Sign-in cancelled.');finish(new Error('Sign-in cancelled.'));return;}
                processing=true;res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('Return to DM Tools to finish sign-in.');
                request('https://oauth2.googleapis.com/token',{client_id:c.client_id,client_secret:c.client_secret,code:code,grant_type:'authorization_code',redirect_uri:redirect,code_verifier:verifier}).then(function(t){
                    if(typeof t.access_token!=='string')throw new Error('Invalid token response.');
                    return validate(t.access_token).then(function(e){if(done)return;t.client_id=c.client_id;t.expires_at=Date.now()+(Number(t.expires_in)||3600)*1000;DmSecureStore.set('google',t);clearLegacy();finish(null,e);});
                }).catch(function(e){finish(e);});
            });
            server.on('error',function(){finish(new Error('Could not start local sign-in callback.'));});
            activeCancel=function(){finish(new Error('Sign-in cancelled.'));};timer=setTimeout(function(){finish(new Error('Sign-in timed out.'));},120000);
            server.listen(0,'127.0.0.1',function(){redirect='http://127.0.0.1:'+server.address().port+'/callback';var u='https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:c.client_id,redirect_uri:redirect,response_type:'code',scope:'openid email profile',access_type:'offline',prompt:'consent',state:state,code_challenge:challenge,code_challenge_method:'S256'}).toString();cp.execFile('/usr/bin/open',[u],function(e){if(e)finish(new Error('Could not open sign-in in your browser.'));});});
        }
    };
})();
