(function(){
'use strict';
var form=document.getElementById('settingsForm');if(!form)return;
var section=document.createElement('div');section.style.cssText='border-top:1px solid #444;margin-top:12px;padding-top:12px';
var title=document.createElement('label');title.textContent='Transcription provider';section.appendChild(title);
var provider=document.createElement('select');provider.setAttribute('aria-label','Transcription provider');provider.style.cssText='display:block;width:100%;margin:8px 0';
[['local','Local · no API key'],['groq','Groq · free tier available'],['openai','OpenAI']].forEach(function(v){var o=document.createElement('option');o.value=v[0];o.textContent=v[1];provider.appendChild(o);});provider.value=localStorage.getItem('dm-transcription-provider')||'local';if(!provider.value)provider.value='local';section.appendChild(provider);
var label=document.createElement('label');label.className='pd-label';var caption=document.createElement('span');label.appendChild(caption);
var input=document.createElement('input');input.type='password';input.autocomplete='new-password';input.placeholder='Paste key to save or replace';input.style.cssText='display:block;width:100%;box-sizing:border-box;margin:8px 0';input.setAttribute('aria-label','Transcription API key');label.appendChild(input);section.appendChild(label);
var note=document.createElement('p');note.style.cssText='font-size:11px;color:#aaa';section.appendChild(note);
var remove=document.createElement('button');remove.type='button';remove.className='btn';remove.textContent='Remove selected provider key';section.appendChild(remove);form.querySelector('.pd-body').appendChild(section);
function clear(){input.value='';}
function refresh(){clear();label.style.display=provider.value==='local'?'none':'';remove.style.display=provider.value==='local'?'none':'';caption.textContent=(provider.value==='groq'?'Groq':'OpenAI')+' API key';note.textContent=provider.value==='local'?'Runs on your Mac. Downloads a 148 MB multilingual model once, then works offline. No API key or usage charges.':'Personal key stored in macOS Keychain. Audio is sent only to the selected provider when you click Transcribe. Free tier limits or API charges apply.';}
provider.addEventListener('change',refresh);refresh();
document.getElementById('settingsBtn').addEventListener('click',function(){provider.value=localStorage.getItem('dm-transcription-provider')||'local';refresh();});
form.addEventListener('submit',function(e){try{
 if(!form.checkValidity())return;
 var key=input.value.trim(),name=provider.value;if(['local','groq','openai'].indexOf(name)<0)throw new Error('Choose a transcription provider.');
 if(key&&name!=='local'){var pattern=name==='groq'?/^gsk_[A-Za-z0-9_-]{10,}$/:/^sk-[A-Za-z0-9_-]{10,}$/;if(!pattern.test(key))throw new Error('Enter a valid '+(name==='groq'?'Groq':'OpenAI')+' API key.');var config=DmSecureStore.get('ai-config')||{};config[name+'_transcription_key']=key;DmSecureStore.set('ai-config',config);clear();}
 localStorage.setItem('dm-transcription-provider',name);
 }catch(err){e.preventDefault();e.stopImmediatePropagation();document.getElementById('settingsError').textContent=err.message;}},true);
remove.addEventListener('click',function(){try{var config=DmSecureStore.get('ai-config')||{};delete config[provider.value+'_transcription_key'];DmSecureStore.set('ai-config',config);clear();note.textContent='Selected provider key removed.';}catch(e){document.getElementById('settingsError').textContent=e.message;}});
document.getElementById('settingsClose').addEventListener('click',clear);
document.getElementById('settingsOverlay').addEventListener('keydown',function(e){if(e.key==='Escape')clear();});
})();
