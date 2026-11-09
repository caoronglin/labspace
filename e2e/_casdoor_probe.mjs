import fs from 'node:fs';
const lines = fs.readFileSync('/etc/labspace/casdoor-users.txt','utf8').split('\n');
for (const line of lines) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const [username, password] = t.split(/\s+/);
  if (!password) continue;
  const res = await fetch('http://127.0.0.1:8000/api/login', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({application:'app-built-in', organization:'built-in', username, password, autoSignin:true, type:'login'}),
  });
  let body = {}; try { body = await res.json(); } catch {}
  console.log(`${username}: http=${res.status} status=${body.status} msg=${(body.msg||'').slice(0,60)}`);
}
