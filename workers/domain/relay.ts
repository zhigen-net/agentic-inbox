// This source runs in the domain's Cloudflare account. No API token is deployed to it.
export function relaySource() {
	return `
const enc = new TextEncoder();
const hex = v => Array.from(new Uint8Array(v),x=>x.toString(16).padStart(2,'0')).join('');
export default {
 async email(message, env) {
  if(!message.to.toLowerCase().endsWith('@'+env.INBOX_DOMAIN)) { message.setReject('Domain mismatch'); return; }
  if(message.rawSize > 25*1024*1024) {message.setReject('Message too large');return;}
  const raw=await new Response(message.raw).arrayBuffer();
  const timestamp=String(Math.floor(Date.now()/1000)), id=crypto.randomUUID();
  const hash=hex(await crypto.subtle.digest('SHA-256',raw));
  const payload=[timestamp,id,message.from,message.to,hash].join('\\n');
  const key=await crypto.subtle.importKey('raw',enc.encode(env.BRIDGE_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=hex(await crypto.subtle.sign('HMAC',key,enc.encode(payload)));
  const r=await fetch(env.INBOX_ORIGIN+'/ingress/email/'+env.INBOX_DOMAIN,{method:'POST',redirect:'error',headers:{'Content-Type':'application/octet-stream','X-Inbox-Time':timestamp,'X-Inbox-Id':id,'X-Inbox-From':message.from,'X-Inbox-To':message.to,'X-Inbox-Signature':signature},body:raw,signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('Inbox relay failed: HTTP '+r.status);
 },
 fetch(){return new Response('Email relay only',{status:404});}
};`;
}
