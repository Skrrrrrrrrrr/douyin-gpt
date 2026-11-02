import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export function initialPassword(home) {
  const match = readFileSync(join(home, 'dashboard-initial-password.txt'), 'utf8').match(/^初始密码：(.+)$/m);
  assert.ok(match, '本机初始密码文件已生成');
  return match[1];
}
export async function loginDashboard(base, home) {
  const password = initialPassword(home), headers = {'content-type': 'application/json'};
  const login = await fetch(base + '/api/auth/login', {method: 'POST', headers, body: JSON.stringify({username: 'admin', password})});
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const changed = await fetch(base + '/api/auth/password', {method: 'POST', headers: {...headers, cookie}, body: JSON.stringify({currentPassword: password, newPassword: 'test-only-dashboard-password-42'})});
  assert.equal(changed.status, 200);
  return changed.headers.get('set-cookie').split(';')[0];
}
