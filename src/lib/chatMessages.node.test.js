// src/lib/chatMessages.node.test.js — the chat's message helpers (src/lib/chatMessages.ts), the pure parts of the
// stream and history machines: the stop markers and the settle, the reducer a streamed chunk goes through and the
// buffered text a save mid-reply adds (both on the last assistant message, pending or not), what a history stores,
// and the turns a request sends. Every message is a literal built here, so nothing is stubbed.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  CONVERSATION_WINDOW, appendReplyText, conversationWindow, isTurn, settleReply, stopMarker, storableMessages,
  withBufferedText,
} from './chatMessages.js';
import { STOP_REASON } from './sse.js';

const user = (content) => ({ role: 'user', content });
const reply = (content) => ({ role: 'assistant', content });
const streaming = (content) => ({ role: 'assistant', content, pending: true });
const failure = (content) => ({ role: 'error', content });
const Q = user('Q1');
/** A history as the store keeps it: storableMessages' output, JSON-encoded. */
const stored = (msgs) => JSON.stringify(storableMessages(msgs));

describe('chatMessages', () => {
  describe('stopMarker', () => {
    it('END: no note; MAX_TOKENS, no reason (null) and any other normalised reason each get one', () => {
      assert.equal(stopMarker(STOP_REASON.END), '');
      assert.equal(stopMarker(STOP_REASON.MAX_TOKENS), '*(cut off at the token limit)*');
      assert.equal(stopMarker(null), '*(response ended early)*');
      assert.equal(stopMarker(STOP_REASON.OTHER), '*(the model stopped here: other)*');
      assert.equal(stopMarker(STOP_REASON.REFUSAL), '*(the model stopped here: refusal)*');
    });
  });

  describe('settleReply', () => {
    it("a tail that is not the assistant's: the same array, whatever the marker", () => {
      for (const msgs of [[], [Q], [Q, failure('Failed to get analysis: Boom')]]) {
        for (const marker of ['', '*(stopped)*']) {
          assert.equal(settleReply(msgs, marker), msgs, `${JSON.stringify(msgs)} with '${marker}'`);
        }
      }
    });

    it('a settled reply and no marker: the same array (how a reply re-created after a delete ends)', () => {
      const msgs = [Q, reply(' world')];
      assert.equal(settleReply(msgs, ''), msgs);
    });

    it('an empty pending reply and no marker: removed', () => {
      const msgs = [Q, streaming('')];
      assert.deepEqual(settleReply(msgs, ''), [Q]);
      assert.deepEqual(msgs, [Q, streaming('')], 'the input is not mutated');
    });

    it('a reply and a marker: joined by a blank line, the pending flag dropped, settled or not', () => {
      const msgs = [Q, streaming('Partial')];
      assert.deepEqual(settleReply(msgs, '*(stopped)*'), [Q, reply('Partial\n\n*(stopped)*')]);
      assert.deepEqual(msgs, [Q, streaming('Partial')], 'the input is not mutated');
      assert.deepEqual(settleReply([Q, reply(' world')], '*(stopped)*'), [Q, reply(' world\n\n*(stopped)*')]);
    });

    it('a pending reply and no marker loses only the flag; an empty pending reply takes the marker alone', () => {
      assert.deepEqual(settleReply([Q, streaming('Hello')], ''), [Q, reply('Hello')]);
      assert.deepEqual(settleReply([Q, streaming('')], '*(stopped)*'), [Q, reply('*(stopped)*')]);
    });
  });

  describe('appendReplyText', () => {
    it('a chunk joins the pending reply, which stays pending; the input is not mutated', () => {
      const msgs = [Q, streaming('Hel')];
      const next = appendReplyText(msgs, 'lo');
      assert.deepEqual(next, [Q, streaming('Hello')]);
      assert.deepEqual(msgs, [Q, streaming('Hel')], 'a new array and a new reply: state is never mutated');
      assert.equal(next[0], Q, 'the messages before the reply are the same objects');
    });

    it('a chunk joins a settled reply too: once the streaming bubble is deleted, the rest stays one turn', () => {
      assert.deepEqual(appendReplyText([Q, reply(' world')], ' more'), [Q, reply(' world more')]);
    });

    it('after a user turn: a new assistant message, not pending', () => {
      assert.deepEqual(appendReplyText([Q], ' world'), [Q, reply(' world')]);
    });
  });

  describe('withBufferedText', () => {
    it('what a save mid-reply stores, through storableMessages: only role and content, one reply turn', () => {
      const save = (msgs, buf) => stored(withBufferedText(msgs, buf));
      assert.equal(save([Q, streaming('')], ''), '[{"role":"user","content":"Q1"}]');
      assert.equal(
        save([Q, streaming('He')], 'llo'),
        '[{"role":"user","content":"Q1"},{"role":"assistant","content":"Hello"}]',
      );
      assert.equal(save([Q], 'tail'), '[{"role":"user","content":"Q1"},{"role":"assistant","content":"tail"}]');
      assert.equal(
        save([Q, reply(' world')], ' more'),
        '[{"role":"user","content":"Q1"},{"role":"assistant","content":" world more"}]',
        'the buffer joins a reply re-created without the pending flag',
      );
      assert.equal(
        save([Q, streaming('x'), failure('e')], ''),
        '[{"role":"user","content":"Q1"},{"role":"assistant","content":"x"}]',
      );
    });

    it('the buffer joins the reply as a flush would, pending kept; a placeholder still empty is dropped', () => {
      const first = withBufferedText([Q, streaming('')], 'Hello');
      assert.deepEqual(first, [Q, streaming('Hello')], 'the first chunk, before its frame');
      assert.deepEqual(withBufferedText([Q, streaming('He')], 'llo'), [Q, streaming('Hello')]);
      assert.deepEqual(withBufferedText([Q, streaming('')], ''), [Q]);
    });

    it('an empty buffer adds nothing: the same array unless an empty placeholder is dropped', () => {
      for (const msgs of [[], [Q], [Q, reply('A1')], [Q, streaming('Partial')], [Q, reply('x'), failure('e')]]) {
        assert.equal(withBufferedText(msgs, ''), msgs, JSON.stringify(msgs));
      }
    });
  });

  describe('storableMessages', () => {
    it('error bubbles dropped, the pending flag stripped, an empty pending reply dropped', () => {
      assert.deepEqual(storableMessages([Q, streaming('Hello')]), [Q, reply('Hello')]);
      assert.deepEqual(storableMessages([Q, streaming('')]), [Q]);
      assert.deepEqual(
        storableMessages([Q, reply('Partial'), failure('Failed to get analysis: Overloaded (ref req-9)')]),
        [Q, reply('Partial')],
      );
      assert.deepEqual(
        storableMessages([Q, failure('Failed to get analysis: Boom'), user('Q2'), reply('A2')]),
        [Q, user('Q2'), reply('A2')],
      );
    });

    it('the same array when there is nothing to drop or strip', () => {
      for (const msgs of [[], [Q], [Q, reply('A1'), user('Q2'), reply('A2')]]) {
        assert.equal(storableMessages(msgs), msgs, JSON.stringify(msgs));
      }
    });
  });

  describe('isTurn and conversationWindow', () => {
    it('isTurn as a filter: the user and assistant messages, as the same objects, and no error bubble', () => {
      const turns = [Q, reply('A1'), failure('Failed to get analysis: Boom'), user('Q2')];
      const kept = turns.filter(isTurn);
      assert.deepEqual(kept, [Q, reply('A1'), user('Q2')]);
      [turns[0], turns[1], turns[3]].forEach((m, i) => assert.equal(kept[i], m, `turn ${i} is the message itself`));
    });

    it('12 alternating turns and a question: the last 10 open on the assistant, so 9 go, from the user', () => {
      const history = [];
      for (let i = 0; i < 6; i += 1) history.push(user(`u${i}`), reply(`a${i}`));
      const sent = conversationWindow([...history, user('Q')]);
      assert.equal(CONVERSATION_WINDOW, 10);
      assert.deepEqual(sent.map((m) => m.content), ['u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5', 'Q']);
      assert.equal(sent[0], history[4], 'the same objects: the request carries the messages as they are');
      const ten = history.slice(2);
      assert.deepEqual(conversationWindow(ten), ten, 'ten turns opening on the user go whole');
    });

    it('a shorter window opening on the assistant starts at its first user turn; one on the user is kept', () => {
      // A reply stored alone (the history cleared mid-reply), then a question.
      assert.deepEqual(conversationWindow([reply(' world'), Q]), [Q]);
      assert.deepEqual(conversationWindow([reply('A0'), Q, reply('A1'), user('Q2')]), [Q, reply('A1'), user('Q2')]);
      const whole = [Q, reply('A1'), user('Q2')];
      assert.deepEqual(conversationWindow(whole), whole);
    });
  });
});
