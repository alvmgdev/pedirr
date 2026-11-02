const {test, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
const {EmailChannel, DiscordChannel, renderNotice} = require('../dist/notifications/channels');
const {Notifications} = require('../dist/notifications/service');
const {discordUrl} = require('../dist/settings/notifications');
const originalFetch = global.fetch, originalTransport = nodemailer.createTransport;
afterEach(()=>{global.fetch=originalFetch;nodemailer.createTransport=originalTransport;});
const config = {smtpHost:'smtp.example.invalid',smtpPort:587,smtpSecurity:'starttls',smtpUser:'user',smtpPassword:'secret',emailFrom:'pedirr@example.invalid',discordWebhook:'https://discord.com/api/webhooks/123/secret',emailEnabled:true,discordEnabled:true,emailSince:'2020-01-01',discordSince:'2020-01-01',discordLocale:'es'};
test('notices use the selected language and plain text content',()=>{
 assert.match(renderNotice('es','Game','AVAILABLE','https://example.invalid').text,/Disponible/);
 assert.match(renderNotice('en','Game','PENDING','https://example.invalid').text,/Pending approval/);
});
test('SMTP uses TLS policy, a stable message ID, no HTML and a single recipient',async()=>{
 let closed=false;
 nodemailer.createTransport=options=>{
  assert.equal(options.requireTLS,true);assert.equal(options.secure,false);
  assert.equal(options.disableFileAccess,true);assert.equal(options.disableUrlAccess,true);
  return {sendMail:async message=>{assert.equal(message.to,'one@example.invalid');assert.equal(message.html,undefined);assert.equal(message.messageId,'<delivery-id@pedirr.local>');return {accepted:[message.to],rejected:[]};},close:()=>{closed=true;}};
 };
 await new EmailChannel().send(config,'one@example.invalid',renderNotice('en','<script>','AVAILABLE','https://example.invalid'),'delivery-id');
 assert.equal(closed,true);
});
test('Discord waits for confirmation, disables mentions, and honors fractional Retry-After',async()=>{
 global.fetch=async(url,options)=>{
  assert.equal(url.searchParams.get('wait'),'true');assert.equal(options.redirect,'error');
  assert.deepEqual(JSON.parse(options.body).allowed_mentions,{parse:[]});
  return new Response('',{status:429,headers:{'Retry-After':'1.5'}});
 };
 await assert.rejects(new DiscordChannel().send(config,'',renderNotice('es','@everyone','AVAILABLE','https://example.invalid')),error=>error.getResponse().retryAfterSeconds===2);
 for(const url of ['http://discord.com/api/webhooks/123/token','https://evil.example/api/webhooks/123/token','https://discord.com/api/webhooks/123/token?other=1'])assert.throws(()=>discordUrl(url));
});
test('successful deliveries are skipped on retry while failed recipients are retried',async()=>{
 process.env.APP_ORIGIN='https://pedirr.example.invalid';
 const records=new Map();let emailCount=0,discordCount=0,fail=true;
 const db={
  outboxEvent:{findUnique:async()=>({id:'event',type:'request.status',createdAt:new Date('2026-01-01'),payload:{requestId:'request',status:'AVAILABLE'}})},
  request:{findUnique:async()=>({id:'request',entity:{title:'Game'},scope:{kind:'event'},subscribers:[{user:{email:'user@example.invalid',locale:'es'}}]})},
  notificationDelivery:{
   upsert:async({create})=>{const key=create.channel;if(!records.has(key))records.set(key,{...create,id:key,status:'pending',attempts:0});return records.get(key);},
   findUnique:async({where})=>records.get(where.id),
   update:async({where,data})=>{const record=records.get(where.id);Object.assign(record,{...data,attempts:data.attempts?record.attempts+1:record.attempts});return record;},
  },
 };
 const redis={set:async()=> 'OK',eval:async()=>1};
 const worker=new Notifications({db,redis},{configuration:async()=>config},
  {send:async(_config,_recipient,notice)=>{emailCount++;assert.match(notice.text,/Disponible/);}},
  {send:async()=>{discordCount++;if(fail)throw new Error('secret webhook URL');}});
 await assert.rejects(worker.run('event'));
 assert.equal(records.get('email').status,'sent');
 assert.equal(records.get('discord').lastError,'INTEGRATION_FAILED');
 fail=false;await worker.run('event');
 assert.equal(emailCount,1);assert.equal(discordCount,2);
 assert.equal(records.get('discord').status,'sent');
});
test('enabling channels does not send historical events',async()=>{
 process.env.APP_ORIGIN='https://pedirr.example.invalid';
 const db={outboxEvent:{findUnique:async()=>({type:'request.status',createdAt:new Date('2020-01-01'),payload:{requestId:'request',status:'AVAILABLE'}})},request:{findUnique:async()=>({id:'request',entity:{title:'Game'},scope:{kind:'event'},subscribers:[]})},notificationDelivery:{upsert:async()=>assert.fail('No old delivery should be created')}};
 const worker=new Notifications({db,redis:{}},{configuration:async()=>({...config,emailSince:'2026-01-01',discordSince:'2026-01-01'})});
 await worker.run('event');
});
test('email transport delivers a localized message to a local SMTP fixture',async()=>{
 const net=require('node:net');
 const messages=[];const sockets=new Set();
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
  socket.write('220 local-fixture ESMTP\r\n');
  let buffer='',inData=false,body=[];
  socket.on('data',chunk=>{
   buffer+=chunk.toString();
   while(buffer.includes('\r\n')){
    const end=buffer.indexOf('\r\n');const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
    if(inData){if(line==='.') {messages.push(body.join('\r\n'));body=[];inData=false;socket.write('250 accepted\r\n');}else body.push(line);continue;}
    if(line.startsWith('EHLO'))socket.write('250 local-fixture\r\n');
    else if(line==='DATA'){inData=true;socket.write('354 end with dot\r\n');}
    else if(line==='QUIT')socket.end('221 bye\r\n');
    else socket.write('250 OK\r\n');
   }
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  await new EmailChannel().send({...config,smtpHost:'127.0.0.1',smtpPort:server.address().port,smtpSecurity:'plain',smtpUser:''},'fixture@example.invalid',renderNotice('es','Final','AVAILABLE','https://example.invalid'),'smtp-fixture');
  assert.equal(messages.length,1);assert.match(messages[0],/Disponible/);assert.match(messages[0],/Message-ID: <smtp-fixture@pedirr.local>/i);
 }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
