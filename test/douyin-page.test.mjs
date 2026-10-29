import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { Douyin, StopRequired } from '../src/douyin.mjs';

function pageFixture(title = '抖音-记录美好生活') {
  const video = { duration: 12, parentElement: null, getBoundingClientRect: () => ({ width: 500, height: 600, top: 0, bottom: 600 }) };
  const active = { querySelector: () => video, getAttribute: key => key === 'data-e2e-vid' ? '7400000000000000001' : null };
  const document = { title, querySelector: selector => selector === '[data-e2e="feed-active-video"]' ? active : null, querySelectorAll: selector => selector === 'video' ? [video] : [] };
  const page = { ev: async code => runInNewContext(code, { document, location: { pathname: '/' }, innerHeight: 1000 }), send: async () => ({}) };
  const browser = { page: async () => page, navigate: async () => {} };
  return new Douyin('/unused-test-directory', browser);
}
test('推荐页 DOM 提取稳定视频 ID，再补充该 ID 的真实详情', async () => {
  const dy = pageFixture();
  dy.detail = async id => ({ id, desc: '这条视频的真实文案', author: '作者' });
  const items = await dy.feedFromPage({ limit: 1 });
  assert.equal(items[0].id, '7400000000000000001');
  assert.equal(items[0].desc, '这条视频的真实文案');
});
test('详情不可用时标记元数据不足，不拼接其他视频的文案', async () => {
  const dy = pageFixture();
  dy.detail = async () => { throw new Error('接口没有返回详情'); };
  const items = await dy.feedFromPage({ limit: 1 });
  assert.equal(items[0].desc, '');
  assert.equal(items[0].metadataLimited, true);
});
test('验证码页面明确中止，不尝试解题或签名绕过', async () => {
  const dy = pageFixture('验证码中间页');
  await assert.rejects(dy.feedFromPage({ limit: 1 }), error => error instanceof StopRequired && error.message.includes('验证码'));
});
test('推荐接口可用时直接使用；空响应时才读取页面', async () => {
  const dy = pageFixture();
  let fallbacks = 0;
  dy.feedFromPage = async options => { fallbacks++; return [{ id: 'fallback', options }]; };
  dy.fetchInPage = async () => ({ aweme_list: [{ aweme_id: '7400000000000000001', desc: '正常候选' }] });
  assert.equal((await dy.feed())[0].id, '7400000000000000001');
  assert.equal(fallbacks, 0);
  dy.fetchInPage = async () => { throw new Error('空响应'); };
  assert.equal((await dy.feed({ limit: 1 }))[0].id, 'fallback');
  assert.equal(fallbacks, 1);
});
