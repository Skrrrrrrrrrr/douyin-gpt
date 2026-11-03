import assert from 'node:assert/strict';
export async function dashboardAccess(base){
  assert.equal((await fetch(base+'/api/state')).status,200);
  return '';
}
