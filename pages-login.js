import {apiFetch,appUrl,backendApiUrl,getBackendUrl,hasRemoteSession,loginUrl,setBackendUrl} from './connection.js';
const backend=document.getElementById('backend-url');backend.value=getBackendUrl();
const form = document.getElementById('login-form');
const username = document.getElementById('username'), password = document.getElementById('password');
const nextPassword = document.getElementById('new-password'), confirmation = document.getElementById('confirm-password');
const message = document.getElementById('form-message'), submit = document.getElementById('submit-button');
let mode = 'login', busy = false, epoch = 0;
const showError = text => {message.textContent = text; message.hidden = !text;};
function setMode(value, initial = false) {
  mode = value;backend.disabled=mode==='password';
  const changing = mode === 'password';
  document.getElementById('login-title').textContent = changing ? initial ? '设置你的登录密码' : '修改登录密码' : '登录后台管理';
  document.title = (changing ? '修改密码' : '登录') + ' · 留座中转站';
  document.getElementById('login-description').textContent = changing ? initial ? '首次登录，请先替换初始密码再进入后台。' : '保存后，其他设备的登录会话将失效。' : '连接这台 Mac 上的助手后，进入日常工作台。';
  document.getElementById('username-field').hidden = changing;
  username.required = !changing;
  document.getElementById('new-password-field').hidden = !changing;
  document.getElementById('confirm-password-field').hidden = !changing;
  document.getElementById('initial-hint').hidden = changing;
  document.getElementById('back-login').hidden = !changing;
  document.getElementById('password-label').textContent = changing ? '当前密码' : '密码';
  nextPassword.required = confirmation.required = changing;
  submit.textContent = changing ? '保存密码并进入' : '连接并登录';
  form.action = backendApiUrl(changing ? '/api/auth/password' : '/api/auth/login');
  showError('');
}
async function request(path, body) {
  const response = await apiFetch(path, {method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? {'content-type': 'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000)});
  let data; try {data = await response.json();} catch {throw new Error('本机服务没有返回有效数据，请重试');}
  if (!response.ok) throw Object.assign(new Error(data.error || '操作未完成'), {status: response.status, code: data.code, retryAfter: response.headers.get('retry-after')});
  return data;
}
const enter = () => {password.value = nextPassword.value = confirmation.value = ''; location.replace(appUrl() + location.hash);};
document.getElementById('toggle-password').addEventListener('click', event => {
  const show = password.type === 'password'; password.type = show ? 'text' : 'password';
  event.currentTarget.textContent = show ? '隐藏' : '显示'; event.currentTarget.setAttribute('aria-label', show ? '隐藏密码' : '显示密码'); event.currentTarget.setAttribute('aria-pressed', String(show));
});
form.addEventListener('input', () => {epoch++; showError('');});
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;try{setBackendUrl(backend.value);}catch(error){showError(error.message);backend.focus();return;}
  if (mode === 'password' && nextPassword.value !== confirmation.value) {showError('两次输入的新密码不一致'); confirmation.focus(); return;}
  busy = true; epoch++; submit.disabled = true; submit.textContent = mode === 'password' ? '正在保存…' : '正在登录…'; form.setAttribute('aria-busy', 'true'); showError('');
  const submittedMode = mode;
  try {
    if (mode === 'password') {await request('/api/auth/password', {currentPassword: password.value, newPassword: nextPassword.value}); enter();}
    else {
      const data = await request('/api/auth/login', {username: username.value.trim(), password: password.value});
      if (data.mustChangePassword) {setMode('password', true); nextPassword.focus();} else enter();
    }
  } catch (error) {
    if (submittedMode === 'password' && (error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_CHANGED')) {password.value = nextPassword.value = confirmation.value = ''; setMode('login');}
    showError(error.status === 429 ? `${error.message}（约 ${Math.max(1, Math.ceil(Number(error.retryAfter || 900) / 60))} 分钟）` : error.name === 'TimeoutError' ? '登录请求超时，请重试' : error.message || '无法连接本机服务，请重试');
  } finally {busy = false; submit.disabled = false; submit.textContent = mode === 'password' ? '保存密码并进入' : '连接并登录'; form.removeAttribute('aria-busy');}
});
document.getElementById('back-login').addEventListener('click', async () => {
  if (busy) return; busy = true; epoch++;
  try {await request('/api/auth/logout', {}); password.value = nextPassword.value = confirmation.value = ''; location.replace(loginUrl() + location.hash);}
  catch (error) {showError(error.message || '退出未完成，请重试');} finally {busy = false;}
});
const bootEpoch = epoch;
if(hasRemoteSession())request('/api/auth/session').then(data => {if (epoch !== bootEpoch || busy) return; if (data.authenticated) {if (data.mustChangePassword || new URL(location.href).searchParams.get('password') === 'change') setMode('password', data.mustChangePassword); else enter();}}).catch(() => {});
