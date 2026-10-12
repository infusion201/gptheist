import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
const COOKIE='gptheist_v5_session';
const TTL=8*3600_000;
function equal(a:string,b:string) {const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);}
export function exportPasswordMatches(supplied:string) {const secret=process.env.PAPER_EXPORT_TOKEN;return !!secret && equal(supplied,secret);}
function signature(value:string,secret:string) {return createHmac('sha256',secret).update(`v5-export-session:${value}`).digest('base64url');}
export function exportAuthenticated(request:IncomingMessage,now=Date.now()) {
  const secret=process.env.PAPER_EXPORT_TOKEN;if(!secret)return false;
  if(equal(request.headers.authorization??'',`Bearer ${secret}`))return true;
  if(request.headers['sec-fetch-site']==='cross-site')return false;
  const value=(request.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
  if(!value)return false;
  const parts=value.split('.');if(parts.length!==3)return false;
  const [expires,nonce,mac]=parts as [string,string,string];
  const end=Number(expires);
  return /^\d{13}$/.test(expires) && /^[a-f0-9]{32}$/.test(nonce) && Number.isSafeInteger(end) && end>now && end<=now+TTL && equal(mac,signature(`${expires}.${nonce}`,secret));
}
export function exportSessionCookie(request:IncomingMessage,now=Date.now()) {
  const secret=process.env.PAPER_EXPORT_TOKEN;if(!secret)throw Error('Export disabled');
  const payload=`${now+TTL}.${randomBytes(16).toString('hex')}`;
  const local=/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(request.headers.host??'');
  return `${COOKIE}=${payload}.${signature(payload,secret)}; Path=/api/paper; HttpOnly; SameSite=Strict; Max-Age=${TTL/1000}${local?'':'; Secure'}`;
}
