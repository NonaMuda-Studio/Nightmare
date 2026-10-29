'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PermissionFlagsBits}=require('discord.js');
const {TEMPLATE_KEYS,TEMPLATES,createAnnouncementDraftStore,validateHttpsUrl,handleAnnouncementCreate,handleAnnouncementComponent,handleAnnouncementModal}=require('../announcement-studio');

const guildId='12345678901234567',ownerId='12345678901234568',channelId='12345678901234569',roleId='12345678901234570';
function makeInteraction({userId=ownerId,permission=true,subcommand='create',template='update',role=null,channel=null}={}) {
  return {guildId,user:{id:userId},guild:{id:guildId},inGuild:()=>true,memberPermissions:{has:value=>permission&&value===PermissionFlagsBits.ManageGuild},options:{getSubcommand:()=>subcommand,getString:()=>template,getChannel:()=>channel,getRole:()=>role},calls:[],async deferReply(value){this.calls.push(['defer',value]);},async editReply(value){this.calls.push(['edit',value]);this.payload=value;return value;},async reply(value){this.calls.push(['reply',value]);this.payload=value;return value;},async followUp(value){this.calls.push(['followUp',value]);this.payload=value;return value;},async update(value){this.calls.push(['update',value]);this.payload=value;return value;},async deferUpdate(){this.calls.push(['deferUpdate']);},async showModal(value){this.calls.push(['modal',value]);this.modal=value;}};
}
function channel({guild=guildId,permissions=true,send=async()=>({id:'sent'})}={}) {
  return {id:channelId,guildId:guild,type:0,isTextBased:()=>true,permissionsFor:()=>({has:bits=>permissions&&Array.isArray(bits)?bits.every(bit=>permissions):permissions}),send};
}
function guildFor(ch,{role=null}={}) {
  return {id:guildId,channels:{cache:new Map([[ch.id,ch]]),async fetch(){return ch;}},roles:{cache:new Map(role?[[role.id,role]]:[]),async fetch(){return role;}},members:{me:{id:'12345678901234571'}}};
}
function component(action,id,{userId=ownerId,permission=true,guild=null}={}) {
  const it=makeInteraction({userId,permission});it.customId=`nightmare_announce:${action}:${id}`;it.guild=guild;return it;
}
function draft(store,extra={}) {return store.create({guildId,ownerId,channelId,template:'update',...extra});}

test('all five announcement templates create valid private drafts with correct template values',()=>{
  const store=createAnnouncementDraftStore();assert.deepEqual(TEMPLATE_KEYS,['update','info','event','announcement','maintenance']);
  for(const template of TEMPLATE_KEYS){const item=draft(store,{template});assert.equal(item.title,TEMPLATES[template].title);assert.equal(item.status,'draft');assert.ok(item.expiresAt>item.createdAt);}
});

test('draft fields, HTTPS image URLs, ownership, guild binding, expiry, and cancellation are validated',()=>{
  let time=1_000;const store=createAnnouncementDraftStore({now:()=>time,ttlMs:60_000});const item=draft(store);
  assert.throws(()=>validateHttpsUrl('http://example.com/image.png','image'),/HTTPS/);assert.throws(()=>validateHttpsUrl('https://user:pass@example.com/x','image'),/HTTPS/);assert.throws(()=>validateHttpsUrl('https://localhost/x','image'),/HTTPS/);assert.equal(validateHttpsUrl('https://cdn.example.org/image.png','image'),'https://cdn.example.org/image.png');
  assert.equal(store.get(item.id,guildId,'12345678901234572'),null);assert.equal(store.get(item.id,'12345678901234573',ownerId),null);
  assert.throws(()=>store.update(item.id,guildId,ownerId,{color:'red'}),/hex/);assert.throws(()=>store.update(item.id,guildId,ownerId,{imageUrl:'http://bad.test/a'}),/HTTPS/);assert.throws(()=>store.update(item.id,guildId,ownerId,{description:'x'.repeat(4097)}),/description/);
  const edited=store.update(item.id,guildId,ownerId,{title:'Valid title',description:'Valid description',color:'#aabbcc',message:'No implicit @everyone ping',imageUrl:'https://cdn.example.org/main.png',thumbnailUrl:'https://cdn.example.org/thumb.png'});assert.equal(edited.color,'#aabbcc');
  time+=60_001;assert.equal(store.get(item.id,guildId,ownerId),null);const cancelled=draft(store);assert.equal(store.cancel(cancelled.id,guildId,ownerId),true);assert.equal(store.get(cancelled.id,guildId,ownerId),null);
});

test('announcement creation validates Manage Guild, same-guild channel/role, and replies ephemerally',async()=>{
  const store=createAnnouncementDraftStore();const dest=channel();const role={id:roleId,guild:{id:guildId}};
  const denied=makeInteraction({permission:false,channel:dest});await handleAnnouncementCreate(denied,store);assert.equal(denied.calls[0][1].flags,64);assert.match(denied.payload,/Manage Server/);assert.equal(store.size(),0);
  const badChannel=makeInteraction({channel:channel({guild:'12345678901234572'})});await handleAnnouncementCreate(badChannel,store);assert.match(badChannel.payload,/server ini/);assert.equal(store.size(),0);
  const badRole=makeInteraction({channel:dest,role:{id:roleId,guild:{id:'12345678901234572'}}});await handleAnnouncementCreate(badRole,store);assert.match(badRole.payload,/Role mention/);
  const good=makeInteraction({channel:dest,role});await handleAnnouncementCreate(good,store);assert.equal(good.calls[0][1].flags,64);assert.match(good.payload.content,/terlihat olehmu/);assert.equal(good.payload.components[0].components.length,5);assert.equal(store.size(),1);
});

test('announcement editor modal updates fields and private preview never publishes',async()=>{
  const store=createAnnouncementDraftStore(),item=draft(store),dest=channel(),guild=guildFor(dest);
  const edit=component('edit',item.id,{guild});await handleAnnouncementComponent(edit,store);assert.equal(edit.calls[0][0],'modal');assert.equal(edit.modal.components.length,5);
  const modal=makeInteraction();modal.customId=`nightmare_announce_modal:edit:${item.id}`;modal.fields={getTextInputValue:name=>({title:'Launch',description:'New feature',color:'#123abc',footer:'Nightmare',message:'Text'}[name]??'')};await handleAnnouncementModal(modal,store);assert.equal(modal.payload.embeds[0].data.title,'Launch');
  const preview=component('preview',item.id,{guild});await handleAnnouncementComponent(preview,store);assert.match(preview.payload.content,/Preview privat/);assert.equal(preview.payload.embeds[0].data.title,'Launch');assert.equal(preview.calls[0][0],'update');assert.equal(store.get(item.id,guildId,ownerId).status,'draft');
  const images=component('images',item.id,{guild});await handleAnnouncementComponent(images,store);const imageModal=images.modal;const invalid=makeInteraction();invalid.customId=imageModal.data.custom_id;invalid.fields={getTextInputValue:name=>name==='imageUrl'?'https://example.org/img.png':'http://insecure.test/img.png'};await handleAnnouncementModal(invalid,store);assert.match(invalid.payload.content,/HTTPS/);assert.equal(store.get(item.id,guildId,ownerId).imageUrl,'');
});

test('send requires explicit confirmation, bot permissions, role allowlist, and cannot publish twice',async()=>{
  const store=createAnnouncementDraftStore(),item=draft(store,{roleId}),sends=[];store.update(item.id,guildId,ownerId,{title:'Update',description:'Body',message:'Text @everyone'});const role={id:roleId,guild:{id:guildId},mentionable:true};const dest=channel({send:async payload=>{sends.push(payload);return {id:'sent-id'};}});const guild=guildFor(dest,{role});
  const send=component('send',item.id,{guild});await handleAnnouncementComponent(send,store);assert.equal(sends.length,0);assert.match(send.payload.content,/Konfirmasi/);const confirm=component('confirm',item.id,{guild});await handleAnnouncementComponent(confirm,store);assert.equal(sends.length,1);assert.deepEqual(sends[0].allowedMentions,{parse:[],users:[],roles:[roleId],repliedUser:false});assert.match(sends[0].content,/<@&12345678901234570>/);assert.match(sends[0].content,/@everyone/);assert.equal(store.get(item.id,guildId,ownerId).status,'sent');assert.match(confirm.payload.content,/berhasil dikirim/);
  const repeated=component('confirm',item.id,{guild});await handleAnnouncementComponent(repeated,store);assert.equal(sends.length,1);assert.match(repeated.payload.content,/sudah dikirim/);
});

test('public send confirmation acknowledges before REST channel/role cache fetches',async()=>{
  const store=createAnnouncementDraftStore(),item=draft(store),events=[],dest=channel();const guild={id:guildId,channels:{cache:new Map(),async fetch(){events.push('channel-fetch');return dest;}},roles:{cache:new Map(),async fetch(){events.push('role-fetch');return null;}},members:{me:{id:'12345678901234571'}}};
  const confirm=component('confirm',item.id,{guild});const defer=confirm.deferUpdate.bind(confirm);confirm.deferUpdate=async()=>{events.push('defer-update');return defer();};
  await handleAnnouncementComponent(confirm,store);assert.equal(events[0],'defer-update');assert.equal(events[1],'channel-fetch');assert.ok(confirm.calls.some(([method])=>method==='edit'));
});

test('announcement send enforces component ownership and bot channel permissions',async()=>{
  const store=createAnnouncementDraftStore(),item=draft(store),bad=channel(),guild=guildFor(bad);bad.permissionsFor=member=>({has:()=>member?.id!=='12345678901234571'});
  const outsider=component('preview',item.id,{userId:'12345678901234572',guild});await handleAnnouncementComponent(outsider,store);assert.match(outsider.payload.content,/bukan milikmu/);
  const denied=component('confirm',item.id,{guild});await handleAnnouncementComponent(denied,store);assert.match(denied.payload.content,/ViewChannel/);assert.equal(store.get(item.id,guildId,ownerId).status,'draft');
  const userDenied=component('preview',item.id,{permission:false,guild:guildFor(channel())});await handleAnnouncementComponent(userDenied,store);assert.match(userDenied.payload.content,/Manage Server/);
});

test('non-mentionable role requires bot mention permission and concurrent confirms send at most once',async()=>{
  const store=createAnnouncementDraftStore(),item=draft(store,{roleId}),role={id:roleId,guild:{id:guildId},mentionable:false};const blocked=channel(),blockedGuild=guildFor(blocked,{role});blocked.permissionsFor=member=>({has:bits=>Array.isArray(bits)?!(member?.id==='12345678901234571'&&bits.includes(PermissionFlagsBits.MentionEveryone)):!(member?.id==='12345678901234571'&&bits===PermissionFlagsBits.MentionEveryone)});
  const denied=component('confirm',item.id,{guild:blockedGuild});await handleAnnouncementComponent(denied,store);assert.match(denied.payload.content,/MentionEveryone/);assert.equal(store.get(item.id,guildId,ownerId).status,'draft');
  let release;let sends=0;const gate=new Promise(resolve=>{release=resolve;});const dest=channel({send:async()=>{sends++;await gate;return {id:'sent'};}}),guild=guildFor(dest,{role:{...role,mentionable:true}});const pending=component('send',item.id,{guild});await handleAnnouncementComponent(pending,store);
  const confirmA=component('confirm',item.id,{guild}),confirmB=component('confirm',item.id,{guild});const first=handleAnnouncementComponent(confirmA,store),second=handleAnnouncementComponent(confirmB,store);for(let i=0;i<20&&sends===0;i++)await Promise.resolve();assert.equal(sends,1);release();await Promise.all([first,second]);assert.equal(sends,1);assert.equal(store.get(item.id,guildId,ownerId).status,'sent');
});

test('expired Discord component acknowledgements are ignored safely',async()=>{
  const store=createAnnouncementDraftStore(),item=draft(store),it=component('preview',item.id,{guild:guildFor(channel())});it.update=async()=>{const error=new Error('expired interaction');error.code=10062;throw error;};await handleAnnouncementComponent(it,store);assert.equal(it.calls.some(call=>call[0]==='reply'||call[0]==='followUp'),false);
});

test('ambiguous Discord send failure is reported accurately and permanently locks the draft',async()=>{
  const store=createAnnouncementDraftStore(),item=draft(store),dest=channel({send:async()=>{throw new Error('timeout after request');}}),guild=guildFor(dest);
  const pending=component('send',item.id,{guild});await handleAnnouncementComponent(pending,store);const confirm=component('confirm',item.id,{guild});await handleAnnouncementComponent(confirm,store);assert.equal(store.get(item.id,guildId,ownerId).status,'uncertain');assert.match(confirm.payload.content,/tidak dapat dipastikan/);
  const retry=component('confirm',item.id,{guild});await handleAnnouncementComponent(retry,store);assert.match(retry.payload.content,/sudah dikirim|sedang diproses/);
});

test('cancel button deletes draft; expired component reports an expired draft privately',async()=>{
  let time=5_000;const store=createAnnouncementDraftStore({now:()=>time,ttlMs:60_000}),item=draft(store),dest=channel(),guild=guildFor(dest);
  const cancel=component('cancel',item.id,{guild});await handleAnnouncementComponent(cancel,store);assert.equal(store.get(item.id,guildId,ownerId),null);assert.equal(cancel.payload.content,'Draft dibatalkan.');
  const old=draft(store);time+=60_001;const late=component('preview',old.id,{guild});await handleAnnouncementComponent(late,store);assert.match(late.payload.content,/kedaluwarsa/);
});
