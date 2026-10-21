/* Independent DM Tools motion controls. */
(function(){
'use strict';
var host=document.getElementById('aeSection');if(!host)return;
var panel=document.createElement('section');panel.className='section dm-motion';
panel.innerHTML='<div class="section-header"><span class="section-title">Motion shortcuts</span></div><div class="dm-motion-layout"><div class="dm-motion-ease"><div class="dm-motion-head"><span>Easing</span><div class="dm-motion-types"></div></div></div><div class="dm-motion-bottom"><div class="dm-motion-anchor" aria-label="Anchor point"></div><div class="dm-motion-null"><button type="button">+ Null</button></div></div></div>';
var speedSection=document.getElementById('speedRampSection');
if(speedSection)speedSection.appendChild(panel);else host.appendChild(panel);
var busy=false;
function run(call){if(busy)return;if(typeof HOST!=='undefined'&&HOST!=='AEFT')return;busy=true;var controls=panel.querySelectorAll('button,input');Array.prototype.forEach.call(controls,function(e){e.disabled=true;});
try{evalScript('$.evalFile('+JSON.stringify(cs.getSystemPath('extension')+'/jsx/motion-tools.jsx')+');'+call+';',function(result){busy=false;Array.prototype.forEach.call(controls,function(e){e.disabled=false;});var error=!result||/^(Error|EvalScript error)/.test(result);setStatus(result||'Could not complete this action.',error?'error':'success');});}catch(e){busy=false;Array.prototype.forEach.call(controls,function(e){e.disabled=false;});setStatus(e.message,'error');}}
function button(parent,text,title,fn){var b=document.createElement('button');b.type='button';b.textContent=text;b.title=title;b.setAttribute('aria-label',title);b.onclick=fn;parent.appendChild(b);return b;}
var ease=panel.querySelector('.dm-motion-ease');
[['out','Out'],['in','In'],['both','Both']].forEach(function(item){var row=document.createElement('div');row.className='dm-motion-row';ease.appendChild(row);var label=document.createElement('span');label.textContent=item[1];row.appendChild(label);var slider=document.createElement('input');slider.type='range';slider.min=0;slider.max=100;slider.value=33;slider.setAttribute('aria-label',item[1]+' influence');row.appendChild(slider);var number=document.createElement('input');number.type='number';number.min=0;number.max=100;number.value=33;number.setAttribute('aria-label',item[1]+' influence value');row.appendChild(number);
function apply(value){value=Math.max(0,Math.min(100,Number(value)));if(!isFinite(value))return;slider.value=number.value=value;run('dmMotionEase('+JSON.stringify(item[0])+','+value+',"ease")');}
slider.oninput=function(){number.value=slider.value;};slider.onchange=function(){apply(slider.value);};number.onchange=function(){apply(number.value);};});
var types=panel.querySelector('.dm-motion-types');[['hold','Hold'],['linear','Linear'],['bezier','Bezier']].forEach(function(item){var b=button(types,'','Set selected keyframes to '+item[1],function(){run('dmMotionEase("both",33,'+JSON.stringify(item[0])+')');});var paths={hold:'<rect x="5" y="5" width="10" height="10" rx="1"/>',linear:'<path d="M10 3L17 10L10 17L3 10Z"/>',bezier:'<circle cx="10" cy="10" r="6"/>'};b.innerHTML='<svg viewBox="0 0 20 20" aria-hidden="true">'+paths[item[0]]+'</svg>';});
var grid=panel.querySelector('.dm-motion-anchor');var rows=['Top','Middle','Bottom'],cols=['left','center','right'];for(var r=0;r<3;r++)for(var c=0;c<3;c++)(function(y,x){var b=button(grid,'',rows[y]+' '+cols[x]+' anchor',function(){run('dmMotionAnchor('+y+','+x+')');});var dot=document.createElement('span');dot.style.top=(20+y*30)+'%';dot.style.left=(20+x*30)+'%';b.appendChild(dot);})(r,c);
panel.querySelector('.dm-motion-null button').title='Create a parent Null for selected layers';
panel.querySelector('.dm-motion-null button').onclick=function(){run('dmMotionAddNull()');};
})();
