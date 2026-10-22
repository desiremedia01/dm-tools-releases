/* Gemini API key in Settings — stored only in this Mac's Keychain (ai-config.gemini_key).
   Used by AI Video: Timelapse analysis/Adjust prompt, O1 prompt refine and driveway
   detection, Staging. Never bundled with the plugin or sent anywhere except Gemini. */
(function(){
'use strict';
var form=document.getElementById('settingsForm');if(!form||typeof DmSecureStore==='undefined')return;
var section=document.createElement('div');section.style.cssText='border-top:1px solid #444;margin-top:12px;padding-top:12px';
var label=document.createElement('label');label.className='pd-label';
var caption=document.createElement('span');caption.textContent='Gemini API key';label.appendChild(caption);
var input=document.createElement('input');input.type='password';input.autocomplete='new-password';input.placeholder='Paste key to save or replace';input.style.cssText='display:block;width:100%;box-sizing:border-box;margin:8px 0';input.setAttribute('aria-label','Gemini API key');input.id='settingGeminiKey';label.appendChild(input);section.appendChild(label);
var note=document.createElement('p');note.style.cssText='font-size:11px;color:#aaa';section.appendChild(note);
var remove=document.createElement('button');remove.type='button';remove.className='btn';remove.textContent='Remove Gemini key';section.appendChild(remove);
form.querySelector('.pd-body').appendChild(section);
function hasKey(){try{return !!((DmSecureStore.get('ai-config')||{}).gemini_key);}catch(e){return null;}}
function refresh(msg){input.value='';var s=hasKey();remove.style.display=s?'':'none';
 note.textContent=msg||(s===null?'Unlock your macOS Keychain to manage the Gemini key.':s?'Saved in this Mac’s Keychain. Used by AI Video prompts (Timelapse adjust, O1 refine).':'Optional. When you are signed in, AI Video uses the Desire Gemini service automatically. Add your own key only to use it instead.');}
refresh();
document.getElementById('settingsBtn').addEventListener('click',function(){refresh();});
form.addEventListener('submit',function(e){try{
 if(!form.checkValidity())return;
 var key=input.value.trim();if(!key)return;
 if(!/^AIza[0-9A-Za-z_-]{30,}$/.test(key))throw new Error('Enter a valid Gemini API key (starts with AIza).');
 var config=DmSecureStore.get('ai-config')||{};config.gemini_key=key;DmSecureStore.set('ai-config',config);refresh();
}catch(err){e.preventDefault();e.stopImmediatePropagation();document.getElementById('settingsError').textContent=err.message;}},true);
remove.addEventListener('click',function(){try{var config=DmSecureStore.get('ai-config')||{};delete config.gemini_key;DmSecureStore.set('ai-config',config);refresh('Gemini key removed from this Mac.');}catch(e){document.getElementById('settingsError').textContent=e.message;}});
document.getElementById('settingsClose').addEventListener('click',function(){input.value='';});
document.getElementById('settingsOverlay').addEventListener('keydown',function(e){if(e.key==='Escape')input.value='';});
})();
