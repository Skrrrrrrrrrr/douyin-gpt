import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readMessages, currentConvId, messageIdentity, normalizeEditorText } from '../vendor/newjo/im-send.mjs';

test('EditorKit 的零宽占位不是草稿；真实文字和 emoji 保持有效', () => {
  assert.equal(normalizeEditorText('\u200b'), '');
  assert.equal(normalizeEditorText('\u200b\n\ufeff\r'), '');
  assert.equal(normalizeEditorText('\u200b未发送的草稿\u200b'), '未发送的草稿');
  assert.equal(normalizeEditorText('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦');
});

function fixtureMessage(id, text, side) {
  const message = { serverId: id, isMyMessage: true, parsedContent: { text } };
  const images = side ? [{ getBoundingClientRect: () => ({ left: side === 'them' ? 100 : 850, width: 36, height: 36, top: 100 }) }] : [];
  return {
    __reactFiber$fixture: { memoizedProps: { message } },
    getBoundingClientRect: () => ({ top: 90, bottom: 150 }),
    querySelectorAll: () => images,
  };
}
test('发送方由头像位置判断；连发继承方向正确，忽略恒为 true 的 isMyMessage', async () => {
  const nodes = [fixtureMessage('3', '新消息', null), fixtureMessage('2', '同一人前一句', 'them'), fixtureMessage('1', '我发的', 'me')];
  const list = { getBoundingClientRect: () => ({ left: 0, width: 1000 }) };
  const document = { querySelector: () => list, querySelectorAll: () => nodes };
  const messages = await readMessages(async expression => runInNewContext(expression, { document }));
  assert.deepEqual(messages.map(m => [m.id, m.from]), [['3', 'them'], ['2', 'them'], ['1', 'me']]);
});
test('不安全的数值消息 ID 不被当作稳定 ID', async () => {
  const node = fixtureMessage(9007199254740994, '消息', 'them');
  const document = { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, width: 1000 }) }), querySelectorAll: () => [node] };
  const messages = await readMessages(async expression => runInNewContext(expression, { document }));
  assert.equal(messages[0].id, '');
});
test('最终发送快照能识别新消息与主人回复，不能只比较相同正文', () => {
  const before = [{ id: '1', from: 'them', text: '你好' }];
  assert.notEqual(messageIdentity(before), messageIdentity([...before, { id: '2', from: 'me', text: '你好' }]));
  assert.notEqual(messageIdentity(before), messageIdentity([{ id: '2', from: 'them', text: '你好' }]));
});
test('会话账号核对忽略隐藏的旧消息节点', async () => {
  const node = (id, visible) => ({
    __reactFiber$fixture: { memoizedProps: { conversation: { toParticipantSecUserId: id } } },
    getBoundingClientRect: () => ({ width: visible ? 500 : 0, height: visible ? 60 : 0 }),
  });
  const document = { querySelector: () => ({ querySelectorAll: () => [node('stale-id', false), node('correct-id', true)] }) };
  const id = await currentConvId(async expression => runInNewContext(expression, { document }));
  assert.equal(id, 'correct-id');
});
