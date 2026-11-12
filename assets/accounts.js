'use strict';
(() => {
  const $=selector=>document.querySelector(selector);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cloud=$('meta[name="troika-api"]')?.content.startsWith('/api/');
  const dialog=$('#account-dialog'),content=$('#account-content');
  if(!dialog||!content)return;
  let conductTimer,avatarDraft,avatarGeneration=0,avatarLoading=false,profileDirty=false;
  const avatarColors=['gold','coral','mint','sky','violet'];
  let user=null,view='login',pending=false,claimToken='',resetToken='',message='',error=false,players=[],matches=[],users=[],selectedUser=null,resetLink='';
  const rank=elo=>elo>=2000?'Grandmaster':elo>=1800?'Master':elo>=1600?'Diamond':elo>=1400?'Platinum':elo>=1200?'Gold':elo>=1000?'Silver':elo>=800?'Bronze':elo>=600?'Rookie':'Trash';
  const amount=n=>Number.isFinite(Number(n))?Number(n):0;
  const sign=n=>amount(n)>0?'+'+amount(n):String(amount(n));
  const date=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});};
  function conductPanel(person,policy=true) {
    const conduct=person.rankedStatus||{},strikes=Math.max(0,amount(conduct.strikes)),allowed=conduct.rankedAllowed!==false;
    let until='';if(conduct.cooldownUntil){const d=new Date(conduct.cooldownUntil);if(!Number.isNaN(d.getTime()))until=d.toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});}
    const state=allowed?'Ranked play available':until?'Ranked cooldown until '+until:'Ranked play temporarily unavailable';
    return `<section class="account-conduct ${allowed?'':'account-conduct-limited'}" aria-label="Ranked conduct"><h3>Ranked access</h3><strong class="account-conduct-state">${esc(state)}</strong><p>${strikes} ${strikes===1?'abandonment':'abandonments'} in the last 7 days · Next: ${esc(conduct.nextPenalty||'warning')}</p>${policy?'<p>Unfinished ranked departures: warning → 30 minutes → 60 minutes → 7 days. A lost connection gets 5 minutes to reconnect. Leaving after finishing your cards or being kicked does not count.</p>':''}<small>Casual games remain available during a ranked cooldown.</small>${policy?'<button class="text-button" type="button" id="account-conduct-refresh">Refresh ranked access</button>':''}</section>`;
  }
  async function request(action,data={},endpoint='/api/account') {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try{
      const response=await fetch(endpoint,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...data}),signal:controller.signal});
      let result;try{result=await response.json();}catch{throw new Error('The account service is not responding. Try again.');}
      if(!response.ok||result.error)throw new Error(result.error||'The request could not be completed.');
      return result;
    }catch(e){if(e.name==='AbortError')throw new Error('The request took too long. Try again.');throw e;}
    finally{clearTimeout(timer);}
  }
  function announce(next) {
    if(user?.id!==next?.id){players=[];matches=[];users=[];selectedUser=null;resetLink='';resetAvatarEditor();}
    user=next||null;
    clearTimeout(conductTimer);
    if(user?.rankedStatus?.rankedAllowed===false&&user.rankedStatus.cooldownUntil){const delay=new Date(user.rankedStatus.cooldownUntil).getTime()-Date.now()+250;if(Number.isFinite(delay))conductTimer=setTimeout(()=>refresh().catch(()=>{}),Math.max(1000,Math.min(delay,2147483647)));}
    const button=$('#account-button');if(button){button.textContent=user?user.nickname+' · '+amount(user.elo):'Account';button.setAttribute('aria-label',user?'Open account for '+user.nickname:'Sign in or create an account');}
    document.dispatchEvent(new CustomEvent('troika-account-change',{detail:{user}}));
  }
  async function refresh() {
    if(!cloud)return null;
    const result=await request('me');const previous=user?.id;announce(result.user);
    if(dialog.open&&!claimToken&&!resetToken&&!profileDirty&&!avatarLoading&&(previous!==user?.id||view==='profile')){view=user?'profile':'login';render();}
    return user;
  }
  function status(text,isError=false){message=text;error=isError;const el=$('#account-message');if(el){el.textContent=text;el.classList.toggle('account-error',isError);el.hidden=!text;}}
  function resetAvatarEditor(){avatarDraft=undefined;avatarGeneration++;avatarLoading=false;profileDirty=false;}
  function currentAvatar(){return avatarDraft===undefined?user?.avatar:avatarDraft;}
  function safeAvatarImage(value){return typeof value==='string'&&value.length<=24000&&/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);}
  function avatarText(useEditedName=true){const a=currentAvatar(),nickname=(useEditedName?$('#account-dialog [name="nickname"]')?.value:null)||user?.nickname||'?';return a?.kind==='initial'&&a.text?Array.from(a.text).slice(0,2).join(''):Array.from(nickname)[0]?.toUpperCase()||'?';}
  function avatarEditor(){
    const a=currentAvatar(),color=avatarColors.includes(a?.color)?a.color:'gold';
    return `<fieldset class="account-avatar-editor"><legend>Your table avatar</legend><div class="account-avatar-layout"><div id="account-avatar-preview" class="account-avatar-preview" data-color="${color}" role="img" aria-label="Your avatar preview"><span>${esc(avatarText(false))}</span>${a?.kind==='image'&&safeAvatarImage(a.dataUrl)?`<img src="${esc(a.dataUrl)}" alt="">`:''}</div><div class="account-avatar-options"><label class="account-field" for="account-avatar-initial">Custom initial · up to 2 characters<input id="account-avatar-initial" type="text" maxlength="4" value="${esc(a?.kind==='initial'?a.text||'':'')}" placeholder="Nickname initial" autocomplete="off"></label><div class="account-avatar-colors" role="group" aria-label="Initial color">${avatarColors.map(c=>`<button type="button" data-avatar-color="${c}" data-color="${c}" aria-label="${c[0].toUpperCase()+c.slice(1)} initial" aria-pressed="${a?.kind!=='image'&&c===color}"><span aria-hidden="true">${a?.kind!=='image'&&c===color?'✓':''}</span></button>`).join('')}</div></div></div><label class="account-avatar-upload" for="account-avatar-file">Upload a picture<input type="file" id="account-avatar-file" accept="image/png,image/jpeg,image/webp"></label><button class="text-button" type="button" id="account-avatar-reset">Reset to nickname initial</button><p class="account-help">Your avatar is visible to everyone at the table. PNG, JPEG or WebP · up to 5 MB · cropped to a square.</p><p id="account-avatar-status" class="account-help" role="status" hidden></p></fieldset>`;
  }
  function paintAvatar(){
    const preview=$('#account-avatar-preview');if(!preview)return;
    const a=currentAvatar(),color=avatarColors.includes(a?.color)?a.color:'gold';preview.dataset.color=color;
    preview.innerHTML=`<span>${esc(avatarText())}</span>${a?.kind==='image'&&safeAvatarImage(a.dataUrl)?`<img src="${esc(a.dataUrl)}" alt="">`:''}`;
    document.querySelectorAll('#account-dialog [data-avatar-color]').forEach(button=>{const chosen=a?.kind!=='image'&&button.dataset.avatarColor===color;button.setAttribute('aria-pressed',String(chosen));button.querySelector('span').textContent=chosen?'✓':'';});
  }
  function avatarStatus(text,isError=false){const el=$('#account-avatar-status');if(el){el.textContent=text;el.hidden=!text;el.classList.toggle('account-avatar-error',isError);}}
  async function prepareAvatar(file){
    if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose a PNG, JPEG or WebP image.');
    if(file.size>5*1024*1024)throw new Error('Choose an image smaller than 5 MB.');
    if(typeof URL.createObjectURL!=='function')throw new Error('This browser cannot process avatar uploads. Try an updated browser.');
    const url=URL.createObjectURL(file);
    try{
      const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('That image could not be opened. Try another picture.'));img.src=url;});
      const width=image.naturalWidth,height=image.naturalHeight;
      if(!width||!height||width*height>25000000)throw new Error('Choose an image with smaller dimensions.');
      const canvas=document.createElement('canvas');canvas.width=canvas.height=96;const context=canvas.getContext('2d');
      if(!context)throw new Error('This browser cannot process avatar uploads. Try an updated browser.');
      const size=Math.min(width,height);context.drawImage(image,(width-size)/2,(height-size)/2,size,size,0,0,96,96);
      for(const quality of [.78,.64,.48,.3])for(const mime of ['image/webp','image/jpeg']){const dataUrl=canvas.toDataURL(mime,quality);if(safeAvatarImage(dataUrl))return {kind:'image',dataUrl};}
      throw new Error('That picture is too detailed to save as an avatar. Try a simpler image.');
    }finally{URL.revokeObjectURL(url);}
  }
  async function selectAvatarFile(input){
    const file=input.files?.[0];if(!file)return;
    const generation=++avatarGeneration;avatarLoading=true;avatarStatus('Preparing your picture…');
    const save=$('#account-dialog form[data-account-form="profile"] button[type="submit"]');if(save)save.disabled=true;
    try{const next=await prepareAvatar(file);if(generation!==avatarGeneration)return;avatarDraft=next;profileDirty=true;paintAvatar();avatarStatus('Picture ready. Save your profile to use it.');}
    catch(e){if(generation===avatarGeneration)avatarStatus(e.message,true);}
    finally{if(generation===avatarGeneration){avatarLoading=false;if(save)save.disabled=false;}input.value='';}
  }
  function field(label,name,{type='text',value='',required=false,autocomplete='',max=100,min=null}={}) {
    return `<label class="account-field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} maxlength="${max}" ${min!==null?'minlength="'+min+'"':''} ${autocomplete?'autocomplete="'+autocomplete+'"':''}></label>`;
  }
  const passwordField=(name='password',label='Password',current=false)=>field(label,name,{type:'password',required:true,min:current?1:10,max:128,autocomplete:current?'current-password':'new-password'});
  const submit=(text)=>`<button class="primary" type="submit">${text}</button>`;
  function tabs() {
    const list=user?[['profile','My profile'],['history','Match history'],['ladder','Rankings'],...(user.role==='admin'?[['admin','Admin']]:[])]:[['login','Sign in'],['register','Create account'],['ladder','Rankings']];
    return `<nav class="account-tabs" aria-label="Account sections">${list.map(([id,label])=>`<button type="button" data-account-view="${id}" ${view===id?'aria-current="page"':''}>${label}</button>`).join('')}</nav>`;
  }
  function body() {
    if(view==='login')return `<p class="account-intro">Sign in for ranked tables and a place on the ladder. Casual games still work without an account.</p><form data-account-form="login">${field('Email','email',{type:'email',required:true,autocomplete:'email',max:254})}${passwordField('password','Password',true)}${submit('Sign in')}</form><button class="text-button" data-account-view="forgot">Forgot your password?</button>`;
    if(view==='register')return `<p class="account-intro">${claimToken?'Create your owner account to unlock the admin controls. Use the email address you gave for setup.':'Your nickname appears at the table. Your email and optional real name stay private.'}</p><form data-account-form="register">${field('Nickname','nickname',{required:true,max:20,autocomplete:'nickname'})}${field('Email','email',{type:'email',required:true,max:254,autocomplete:'email'})}<div class="account-two-fields">${field('First name · optional','firstName',{max:60,autocomplete:'given-name'})}${field('Last name · optional','lastName',{max:60,autocomplete:'family-name'})}</div>${passwordField()}<p class="account-help">Use at least 10 characters. Nobody, including the administrator, can read your password.</p>${submit(claimToken?'Create owner account':'Create account')}</form>`;
    if(view==='forgot')return `<p class="account-intro">The table administrator can give you a private password-reset link. Your password is never shown to anyone.</p><form data-account-form="forgot">${field('Your account email','email',{type:'email',required:true,autocomplete:'email',max:254})}${submit('Recovery instructions')}</form>`;
    if(view==='reset')return `<p class="account-intro">Choose a new password. This private link can be used once and expires after 15 minutes.</p><form data-account-form="reset">${passwordField('password','New password')}${submit('Set new password')}</form>`;
    if(view==='password')return `<form data-account-form="password">${passwordField('currentPassword','Current password',true)}${passwordField('password','New password')}${submit('Change password')}</form><button class="text-button" data-account-view="profile">Back to my profile</button>`;
    if(view==='profile'&&user){const played=amount(user.ratedGames),avg=played?(amount(user.placementSum)/played).toFixed(1):'—';return `<div class="account-rating"><span class="account-tier">${esc(rank(user.elo))}</span><strong>${amount(user.elo)}</strong><small>ELO · ${played<10?(10-played)+' placement matches left':'Established rating'}</small></div><div class="account-stats"><span><strong>${played}</strong>Matches</span><span><strong>${amount(user.wins)}</strong>Wins</span><span><strong>${amount(user.lastPlaces)}</strong>Last place</span><span><strong>${avg}</strong>Avg. place</span><span><strong>${amount(user.peakElo)}</strong>Peak Elo</span></div>${conductPanel(user)}<form data-account-form="profile">${avatarEditor()}${field('Nickname','nickname',{value:user.nickname,required:true,max:20,autocomplete:'nickname'})}<p class="account-private">${esc(user.email)} · Private account email</p><div class="account-two-fields">${field('First name · optional','firstName',{value:user.firstName,max:60,autocomplete:'given-name'})}${field('Last name · optional','lastName',{value:user.lastName,max:60,autocomplete:'family-name'})}</div>${submit('Save profile')}</form><div class="account-footer-actions"><button class="text-button" data-account-view="password">Change password</button><button class="text-button" id="account-logout">Sign out</button></div>`;}
    if(view==='ladder')return `<p class="account-intro">Ranked games compare your finishing position with every opponent. Stronger opponents mean bigger rewards. New players start at 500 Elo.</p><div class="account-table-scroll"><table class="account-table"><thead><tr><th>#</th><th>Player</th><th>Tier</th><th>Elo</th><th>Played</th><th>Wins</th></tr></thead><tbody>${players.map((p,i)=>`<tr><td>${i+1}</td><th scope="row">${esc(p.nickname)}</th><td>${esc(p.tier||rank(p.elo))}</td><td>${amount(p.elo)}</td><td>${amount(p.ratedGames)}</td><td>${amount(p.wins)}</td></tr>`).join('')}</tbody></table></div>${players.length?'':'<p class="account-empty">No players on the ladder yet. Create an account and play your first ranked game.</p>'}`;
    if(view==='history')return `<p class="account-intro">Your completed ranked rounds. Casual games do not change Elo.</p><div class="account-history">${matches.map(renderMatch).join('')||'<p class="account-empty">No ranked results yet. Your first result will appear here.</p>'}</div>`;
    if(view==='admin'&&user?.role==='admin')return `<p class="account-intro">Manage player access, create private reset links, and record rating corrections. First and last names are private.</p><div class="account-admin-users">${users.map(u=>`<button class="account-admin-person ${selectedUser?.id===u.id?'selected':''}" data-manage-account="${esc(u.id)}"><span><strong>${esc(u.nickname)}</strong><small>${esc(u.email)}${u.firstName||u.lastName?' · '+esc([u.firstName,u.lastName].filter(Boolean).join(' ')):''}</small></span><span>${amount(u.elo)} Elo${u.suspended?' · Suspended':u.role==='admin'?' · Admin':''}</span></button>`).join('')}</div>${selectedUser?adminDetail():''}`;
    return '<p class="account-empty">Sign in to view your account.</p>';
  }
  function renderMatch(m) {
    const place=m.place??m.placement??m.result?.place??m.results?.find(p=>p.accountId===user?.id)?.place;
    const change=m.change??m.delta??m.result?.change??m.results?.find(p=>p.accountId===user?.id)?.change??0;
    const rated=m.status!=='void';
    const opponents=m.players||m.opponents||m.results||m.participants||[];
    return `<article class="account-match"><div><strong>${rated?'Place '+esc(place??'—'):'Unrated round'}</strong><small>${esc(date(m.finishedAt||m.finished||m.created||m.createdAt))}${m.room?' · Table '+esc(m.room):''}</small></div><span class="account-match-change ${amount(change)>0?'positive':amount(change)<0?'negative':''}">${rated?sign(change)+' Elo':'No change'}</span>${opponents.length?`<p>${opponents.map(p=>esc(typeof p==='string'?p:p.nickname||p.name||'Player')).join(' · ')}</p>`:''}${!rated?`<p>${esc(m.voidReason||m.reason||'The round was voided; ratings stayed unchanged.')}</p>`:''}</article>`;
  }
  function adminDetail(){return `<section class="account-admin-detail"><h3>${esc(selectedUser.nickname)}</h3>${conductPanel(selectedUser,false)}<div class="account-admin-actions"><button class="secondary" id="account-admin-reset" ${selectedUser.id===user.id?'disabled':''}>Create password-reset link</button><button class="secondary" id="account-admin-suspend" ${selectedUser.id===user.id||selectedUser.role==='admin'?'disabled':''}>${selectedUser.suspended?'Restore access':'Suspend account'}</button></div>${resetLink?`<label class="account-field">Private reset link<input readonly id="account-reset-link" value="${esc(resetLink)}"></label><button class="text-button" id="account-copy-reset">Copy link</button><p class="account-help">Share this privately with this player. It expires in 15 minutes and can be used once.</p>`:''}<form data-account-form="admin_correct"><h4>Correct a rating</h4>${field('New Elo','newRating',{type:'number',required:true,value:selectedUser.elo,max:10})}${field('Reason for the correction','reason',{required:true,max:300})}${submit('Record rating correction')}</form><form data-account-form="admin_forgive"><h4>Ranked penalties</h4><p class="account-help">Clear this player’s ranked cooldown and current abandonment strikes. The audit history is kept.</p>${field('Reason for clearing penalties','reason',{required:true,max:500,min:5})}<button class="secondary" type="submit">Clear ranked penalties</button></form></section>`;}
  function render(){
    content.innerHTML=`<div class="dialog-heading"><div><div class="eyebrow">THE TROIKA CLUB</div><h2 id="account-title">${view==='reset'?'Reset password':view==='register'&&claimToken?'Owner setup':view==='ladder'?'Rankings':view==='admin'?'Admin controls':'Your clubhouse'}</h2></div><button class="icon-button" type="button" id="account-close" aria-label="Close account">×</button></div>${tabs()}<p id="account-message" class="account-message ${error?'account-error':''}" role="status" ${message?'':'hidden'}>${esc(message)}</p>${body()}`;
  }
  async function loadView(next){
    if(pending)return;resetAvatarEditor();view=next;message='';error=false;render();
    if(next==='ladder'||next==='history'||next==='admin'){
      pending=true;status('Loading…');
      try{
        if(next==='ladder')players=(await request('leaderboard',{},'/api/ladder')).players||[];
        if(next==='history')matches=(await request('history',{},'/api/ladder')).matches||[];
        if(next==='admin'){users=(await request('admin_users')).users||[];selectedUser=users.find(u=>u.id===selectedUser?.id)||null;}
        message='';render();
      }catch(e){status(e.message,true);}finally{pending=false;}
    }
  }
  function open(next){loadView(next);if(!dialog.open)dialog.showModal();}
  async function formSubmit(form){
    if(pending||avatarLoading||!form.reportValidity())return;
    const action=form.dataset.accountForm,data=Object.fromEntries(new FormData(form));pending=true;
    const controls=[...form.querySelectorAll('button,input')];controls.forEach(el=>el.disabled=true);status('');
    try{
      if(action==='profile'&&avatarDraft!==undefined)data.avatar=avatarDraft;
      if(action==='register'&&claimToken)data.claimToken=claimToken;
      if(action==='reset')data.resetToken=resetToken;
      if(action==='admin_correct'||action==='admin_forgive'){data.userId=selectedUser.id;if(action==='admin_correct')data.newRating=Number(data.newRating);}
      const result=await request(action,data,action==='admin_correct'?'/api/ladder':'/api/account');
      if(action==='forgot'){status(result.message||'Ask the table administrator for a private password-reset link.');return;}
      if(action==='admin_correct'||action==='admin_forgive'){
        users=(await request('admin_users')).users||[];selectedUser=users.find(u=>u.id===selectedUser.id)||null;const updatedSelf=users.find(u=>u.id===user.id);if(updatedSelf)announce(updatedSelf);message=action==='admin_correct'?'Rating correction recorded.':'Ranked penalties cleared. The audit history is kept.';error=false;render();return;
      }
      if(action==='register')claimToken='';if(action==='reset')resetToken='';if(action==='profile')resetAvatarEditor();
      if(Object.hasOwn(result,'user'))announce(result.user);else await refresh();
      if(action==='register'||action==='profile'){
        view='profile';message='';error=false;render();dialog.close();
        document.dispatchEvent(new CustomEvent('troika-toast',{detail:{message:'Profile saved. Happy gaming!'}}));
        return;
      }
      view=user?'profile':'login';message=action==='password'||action==='reset'?'Password updated.':'You’re signed in.';error=false;render();
    }catch(e){status(e.message,true);}finally{pending=false;controls.forEach(el=>el.disabled=false);}
  }
  document.addEventListener('input',event=>{
    const input=event.target;if(!input.closest?.('#account-dialog form[data-account-form="profile"]'))return;profileDirty=true;
    if(input.id==='account-avatar-initial'){input.value=Array.from(input.value).slice(0,2).join('');const a=currentAvatar();avatarDraft={kind:'initial',text:input.value,color:avatarColors.includes(a?.color)?a.color:'gold'};paintAvatar();avatarStatus('Save your profile to use this initial.');}
    else if(input.name==='nickname')paintAvatar();
  });
  document.addEventListener('change',event=>{if(event.target.id==='account-avatar-file')selectAvatarFile(event.target);});
  document.addEventListener('submit',event=>{const form=event.target.closest?.('#account-dialog form[data-account-form]');if(form){event.preventDefault();formSubmit(form);}});
  document.addEventListener('click',async event=>{
    const button=event.target.closest?.('button');if(!button)return;
    if(button.id==='account-button'){open(user?'profile':claimToken?'register':resetToken?'reset':'login');return;}
    if(button.id==='ladder-button'){open('ladder');return;}
    if(button.id==='account-close'){resetAvatarEditor();dialog.close();return;}
    if(button.id==='account-conduct-refresh'){try{await refresh();status('Ranked access updated.');}catch(e){status(e.message,true);}return;}
    if(!dialog.contains(button)||pending)return;
    if(button.dataset.avatarColor){const color=button.dataset.avatarColor;if(!avatarColors.includes(color))return;avatarDraft={kind:'initial',text:$('#account-avatar-initial')?.value||'',color};profileDirty=true;paintAvatar();avatarStatus('Save your profile to use this color.');return;}
    if(button.id==='account-avatar-reset'){avatarGeneration++;avatarLoading=false;avatarDraft=null;profileDirty=true;const input=$('#account-avatar-initial');if(input)input.value='';const save=$('#account-dialog form[data-account-form="profile"] button[type="submit"]');if(save)save.disabled=false;paintAvatar();avatarStatus('Nickname initial restored. Save your profile to apply it.');return;}
    if(button.dataset.accountView){await loadView(button.dataset.accountView);return;}
    if(button.dataset.manageAccount){selectedUser=users.find(u=>u.id===button.dataset.manageAccount);resetLink='';render();return;}
    if(button.id==='account-copy-reset'){
      try{await navigator.clipboard.writeText(resetLink);status('Private reset link copied.');}catch{$('#account-reset-link').select();status('Select and copy the private link above.');}return;
    }
    if(button.id==='account-logout'){
      pending=true;try{await request('logout');announce(null);view='login';message='You’re signed out.';render();}catch(e){status(e.message,true);}finally{pending=false;}return;
    }
    if(button.id==='account-admin-reset'||button.id==='account-admin-suspend'){
      pending=true;
      try{
        if(button.id==='account-admin-reset'){
          const result=await request('admin_reset',{userId:selectedUser.id});const url=new URL(location.href);url.hash='reset='+encodeURIComponent(result.resetToken);url.searchParams.delete('room');resetLink=url.toString();message='Private reset link created. Copy it and share it with this player.';
        }else{
          await request('admin_suspend',{userId:selectedUser.id,suspended:!selectedUser.suspended});users=(await request('admin_users')).users||[];selectedUser=users.find(u=>u.id===selectedUser.id)||null;message='Account access updated.';
        }
        error=false;render();
      }catch(e){status(e.message,true);}finally{pending=false;}
    }
  });
  window.TroikaAccounts={user:()=>user,refresh};
  if(!cloud){if($('#account-button'))$('#account-button').hidden=true;if($('#ladder-button'))$('#ladder-button').hidden=true;return;}
  if($('#account-button'))$('#account-button').hidden=false;if($('#ladder-button'))$('#ladder-button').hidden=false;
  const fragment=new URLSearchParams(location.hash.slice(1));claimToken=fragment.get('owner-setup')||'';resetToken=fragment.get('reset')||'';
  if(claimToken||resetToken){const clean=new URL(location.href);clean.hash='';history.replaceState(null,'',clean);view=claimToken?'register':'reset';render();dialog.showModal();}
  refresh().catch(()=>{if($('#account-button'))$('#account-button').title='Account service unavailable. Try signing in again.';});
})();
