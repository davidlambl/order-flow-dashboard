// src/lib/chatMessages.retry.node.test.js — what a failed request leaves and what its Retry asks again, as pure
// functions (src/lib/chatMessages.ts): failReply, the fail sink's update (the reply settled as far as it got, then the
// error bubble with its retry record { kind, partials, at }); retryBase, which says whether the last message can be
// retried and on which turns; retryPlaceholder, the retry's first update on the messages as they stand when it lands.
// Every bubble here is made by failReply from the messages a fail sink receives, and every chain of attempts goes
// through the helpers the chat runs: the send's placeholder, the stream's appendReplyText, failReply, retryPlaceholder
// and settleReply. The rules: a request's own partial reply counts only when the fail sink's last message is the
// pending reply with text; a retried request also counts its earlier attempts' partial replies, found after the last
// message of the chat it was asked on; the bubble is retryable only while it is the last message and still at its
// index; a send's request must end on the user's turn and a suggestions request needs a reply to review; the partial
// replies stay in the chat and in what is stored, and are left out of every request; the retry's placeholder removes
// the error bubble alone, and never puts a reply up without its question.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  CONTEXT_UPDATE_PROMPT, appendReplyText, conversationWindow, failReply, isTurn, retryBase, retryPlaceholder,
  settleReply, storableMessages,
} from './chatMessages.js';

const user = (content) => ({ role: 'user', content });
const reply = (content) => ({ role: 'assistant', content });
const streaming = (content) => ({ role: 'assistant', content, pending: true });
const placeholder = () => streaming('');
/** An expected bubble, for deepEqual only: every bubble a test judges is made by failReply. */
const bubble = (content, kind, partials, at) => ({ role: 'error', content, retry: { kind, partials, at } });

const u0 = user('u0');
const a0 = reply('a0');
const Q = user('Q');
const FAILED = 'Failed to get analysis: Overloaded (ref r1)';
const FAILED_SUGGESTIONS = 'Failed to get suggestions: Overloaded (ref r2)';

/** ChatBot's send placeholder: the question, then the empty pending reply. */
const asked = (msgs, question) => [...msgs, question, placeholder()];
/** ChatBot's suggestions placeholder: the pending reply alone (the prompt is never shown). */
const suggested = (msgs) => [...msgs, placeholder()];
/** Text a frame hands on, through the stream's reducer. */
const streamed = (msgs, text) => (text ? appendReplyText(msgs, text) : msgs);
/** What the chat's Retry sends and where its reply goes (ChatBot's retry): the turns, and the placeholder's update. */
function retried(msgs) {
  const r = retryBase(msgs);
  assert.ok(r, 'the last message can be retried');
  const recent = conversationWindow(r.base.filter(isTurn));
  const turns = r.kind === 'send' ? recent : [...recent, user(CONTEXT_UPDATE_PROMPT)];
  const lead = r.kind === 'send' ? r.base.slice(-1) : [];
  return { turns, after: r.base[r.base.length - 1], kind: r.kind, shown: retryPlaceholder(msgs, lead) };
}

/** True when nothing would reach the store as an error bubble, with a retry record or with the pending flag. */
const nothingUnstorable = (msgs) => msgs.every((m) => m.role !== 'error' && !('retry' in m) && !('pending' in m));

describe('failReply', () => {
  it('a request that streamed nothing: its empty placeholder goes, and the bubble follows the question', () => {
    const msgs = asked([u0, a0], Q);
    const next = failReply(msgs, FAILED, 'send');
    assert.deepEqual(next, [u0, a0, Q, bubble(FAILED, 'send', 0, 3)]);
    assert.deepEqual(msgs, [u0, a0, Q, placeholder()], 'the input is not mutated');
    [u0, a0, Q].forEach((m, i) => assert.equal(next[i], m, `message ${i} is the same object`));
    assert.deepEqual(storableMessages(next), [u0, a0, Q]);
    assert.ok(nothingUnstorable(storableMessages(next)), 'what the fail stores holds no bubble and no record');
  });

  it('a partial reply is settled as far as it got and kept before the bubble, which counts it', () => {
    const next = failReply(streamed(asked([u0, a0], Q), 'Part'), FAILED, 'send');
    assert.deepEqual(next, [u0, a0, Q, reply('Part'), bubble(FAILED, 'send', 1, 4)]);
    assert.deepEqual(storableMessages(next), [u0, a0, Q, reply('Part')], 'the question and the partial are stored');
  });

  it("the kind is the caller's: a suggestions request that streamed nothing leaves the previous reply where it was", () => {
    const next = failReply(suggested([u0, a0]), FAILED_SUGGESTIONS, 'suggest');
    assert.deepEqual(next, [u0, a0, bubble(FAILED_SUGGESTIONS, 'suggest', 0, 2)]);
    assert.equal(next[1], a0, 'the previous reply is untouched');
    assert.deepEqual(storableMessages(next), [u0, a0]);
  });

  it('a partial counts only when the last message received is the pending reply with text, nothing else', () => {
    // The streaming bubble deleted, then re-created by the next chunk: appendReplyText gives it no pending flag.
    const recreated = streamed(streamed(asked([u0, a0], Q), 'Part').slice(0, -1), 'ial');
    assert.deepEqual(failReply(recreated, FAILED, 'send'), [u0, a0, Q, reply('ial'), bubble(FAILED, 'send', 0, 4)]);
    // The question deleted while its reply waited for text: the reply before it is an older one, not this request's.
    const noQuestion = asked([u0, a0], Q).filter((m) => m !== Q);
    assert.deepEqual(failReply(noQuestion, FAILED, 'send'), [u0, a0, bubble(FAILED, 'send', 0, 2)]);
    // A Clear while the reply waited for text.
    assert.deepEqual(failReply([], FAILED, 'send'), [bubble(FAILED, 'send', 0, 0)]);
  });
});

describe('retryBase', () => {
  it('a send that streamed nothing: the chat before the bubble, which ends on the question', () => {
    const r = retryBase(failReply(asked([u0, a0], Q), FAILED, 'send'));
    assert.deepEqual(r, { base: [u0, a0, Q], kind: 'send' });
    [u0, a0, Q].forEach((m, i) => assert.equal(r.base[i], m, `base ${i} is the message itself`));
  });

  it('a send with a partial reply: the partial stays in the chat and is left out of the base', () => {
    const msgs = failReply(streamed(asked([u0, a0], Q), 'Part'), FAILED, 'send');
    assert.deepEqual(retryBase(msgs), { base: [u0, a0, Q], kind: 'send' });
    assert.deepEqual(msgs.slice(0, -1), [u0, a0, Q, reply('Part')], 'retryBase removes nothing');
  });

  it('a suggestions request that streamed nothing: the previous reply stays in the base', () => {
    const msgs = failReply(suggested([u0, a0]), FAILED_SUGGESTIONS, 'suggest');
    assert.deepEqual(retryBase(msgs), { base: [u0, a0], kind: 'suggest' });
  });

  it('a suggestions request with a partial reply: the base is the chat before the partial', () => {
    const msgs = failReply(streamed(suggested([u0, a0]), 'Sugg'), FAILED_SUGGESTIONS, 'suggest');
    assert.deepEqual(msgs, [u0, a0, reply('Sugg'), bubble(FAILED_SUGGESTIONS, 'suggest', 1, 3)]);
    assert.deepEqual(retryBase(msgs), { base: [u0, a0], kind: 'suggest' });
  });

  it("null when a send's request would not end on the user's turn: the deletes and the Clear made mid-reply", () => {
    const sending = asked([u0, a0], Q);
    const cases = [
      ['the streaming bubble deleted and re-created by the next chunk',
        streamed(streamed(sending, 'Part').slice(0, -1), 'ial')],
      ['the question deleted mid-reply', sending.filter((m) => m !== Q)],
      ['the only question deleted mid-reply', asked([], Q).slice(1)],
      ['a Clear mid-reply', []],
      ['a Clear mid-reply, then text that re-created the reply', streamed([], 'x')],
    ];
    for (const [name, received] of cases) {
      assert.equal(retryBase(failReply(received, FAILED, 'send')), null, name);
    }
  });

  it('null when a suggestions request has no reply left to review', () => {
    const replyDeleted = suggested([u0, a0]).filter((m) => m !== a0);
    assert.equal(retryBase(failReply(replyDeleted, FAILED_SUGGESTIONS, 'suggest')), null, 'its reply deleted');
    assert.equal(retryBase(failReply([], FAILED_SUGGESTIONS, 'suggest')), null, 'a Clear mid-request');
  });

  it('null once the bubble is not the last message, and retryable again once what followed it is deleted', () => {
    const failed = failReply(asked([u0, a0], Q), FAILED, 'send');
    const Q2 = user('Q2');
    const answered = settleReply(streamed(asked(failed, Q2), 'A2'), '');
    assert.equal(retryBase(asked(failed, Q2)), null);
    assert.equal(retryBase(answered), null);
    assert.deepEqual(retryBase(answered.slice(0, 4)), { base: [u0, a0, Q], kind: 'send' });
  });

  it('null once a message before the bubble is deleted: it is no longer at its index', () => {
    const failed = failReply(streamed(asked([u0, a0], Q), 'Part'), FAILED, 'send');
    assert.equal(retryBase(failed.filter((m) => m !== u0)), null, 'an earlier message');
    assert.equal(retryBase(failed.filter((m) => m.content !== 'Part')), null, 'the partial reply');
  });

  it('null for a last message that is not an error bubble with a record, and for an empty chat', () => {
    assert.equal(retryBase([]), null);
    assert.equal(retryBase([u0, a0]), null);
    assert.equal(retryBase(asked([], Q).slice(0, 1)), null);
    assert.equal(retryBase([Q, { role: 'error', content: FAILED }]), null, 'a bubble without a retry record');
    // A record no failReply makes (more partials than messages before it): slice(0, -2) would leave [Q].
    assert.equal(retryBase([Q, a0, bubble(FAILED, 'send', 4, 2)]), null, 'more partials than precede the bubble');
  });

  it("an older error bubble before the question stays in the base; the request's turns leave it out", () => {
    const older = failReply(asked([], u0), FAILED, 'send'); // u0 failed and was never retried
    const r = retryBase(failReply(asked(older, Q), FAILED, 'send'));
    assert.deepEqual(r.base, [u0, older[1], Q]);
    assert.deepEqual(r.base.filter(isTurn), [u0, Q]);
  });
});

describe('retryPlaceholder', () => {
  it('while the bubble is still retryable, it gives way to the pending reply; a partial before it stays', () => {
    assert.deepEqual(retried(failReply(asked([u0, a0], Q), FAILED, 'send')).shown, [u0, a0, Q, placeholder()]);
    assert.deepEqual(
      retried(failReply(streamed(asked([u0, a0], Q), 'Part'), FAILED, 'send')).shown,
      [u0, a0, Q, reply('Part'), placeholder()],
    );
    assert.deepEqual(
      retried(failReply(suggested([u0, a0]), FAILED_SUGGESTIONS, 'suggest')).shown,
      [u0, a0, placeholder()],
    );
  });

  it("on a chat reloaded before it landed, a send's placeholder: the clicked question, then the pending reply", () => {
    assert.deepEqual(retryPlaceholder([], [Q]), [Q, placeholder()], 'never the reply without its question');
    assert.deepEqual(retryPlaceholder([u0, a0], [Q]), [u0, a0, Q, placeholder()]);
    assert.deepEqual(retryPlaceholder([u0, a0], []), [u0, a0, placeholder()], 'the suggestions add no question');
    const reloaded = [user('u0'), reply('a0')]; // the store's copy: the same text in new objects
    const shown = retryPlaceholder(reloaded, [Q]);
    assert.equal(shown[2], Q, 'the question is the clicked one, so a failure finds the request asked after it');
    assert.deepEqual(retryBase(failReply(shown, FAILED, 'send', Q)), { base: [...reloaded, Q], kind: 'send' });
  });
});

describe('a retry that fails again', () => {
  // Each chain: the request fails (with text or without), Retry, the retry fails (with text or without), Retry, the
  // reply ends. What is stored after each step is what storableMessages keeps of the messages.
  const outcomes = [['with text', 'Par', 'Xx'], ['without text', '', '']];
  for (const [firstLabel, firstText] of outcomes) {
    for (const [secondLabel, , secondText] of outcomes) {
      it(`a send, the first failure ${firstLabel}, the second ${secondLabel}: two retryable bubbles in turn, every request ending on the question, nothing stored removed`, () => {
        const failedOnce = failReply(streamed(asked([u0, a0], Q), firstText), FAILED, 'send');
        const first = retried(failedOnce);
        assert.deepEqual(first.turns, [u0, a0, Q], 'the second request: the question, no partial');
        assert.equal(first.after, Q);

        const failedTwice = failReply(streamed(first.shown, secondText), FAILED, 'send', first.after);
        assert.equal(failedTwice.filter((m) => m.role === 'error').length, 1, 'one bubble');
        const second = retried(failedTwice); // the second bubble is retryable
        assert.deepEqual(second.turns, [u0, a0, Q], 'the third request: the question, no partial');
        assert.deepEqual(
          storableMessages(failedTwice),
          [u0, a0, Q, ...[firstText, secondText].filter(Boolean).map(reply)],
          'stored after the second failure: the question once and every partial that arrived',
        );

        const answered = settleReply(streamed(second.shown, 'Final'), '');
        assert.deepEqual(
          storableMessages(answered),
          [u0, a0, Q, ...[firstText, secondText].filter(Boolean).map(reply), reply('Final')],
          'stored at the end: the question once, every partial, the reply',
        );
        assert.equal(retryBase(answered), null);
      });
    }
  }

  it('a suggestions request, the first failure with text, the second without: every request ends on the prompt with no partial', () => {
    const first = retried(failReply(streamed(suggested([u0, a0]), 'Sp'), FAILED_SUGGESTIONS, 'suggest'));
    assert.deepEqual(first.turns, [u0, a0, user(CONTEXT_UPDATE_PROMPT)]);
    const failedTwice = failReply(first.shown, FAILED_SUGGESTIONS, 'suggest', first.after);
    const second = retried(failedTwice);
    assert.equal(second.kind, 'suggest');
    assert.deepEqual(second.turns, [u0, a0, user(CONTEXT_UPDATE_PROMPT)], 'the first attempt\'s partial stays out');
    const answered = settleReply(streamed(second.shown, 'S'), '');
    assert.deepEqual(storableMessages(answered), [u0, a0, reply('Sp'), reply('S')]);
  });

  it('the question deleted while the retry streams: the next bubble offers no Retry, and nothing else is removed', () => {
    const first = retried(failReply(streamed(asked([u0, a0], Q), 'Par'), FAILED, 'send'));
    const questionDeleted = streamed(first.shown, 'Xx').filter((m) => m !== Q);
    const failed = failReply(questionDeleted, FAILED, 'send', first.after);
    assert.equal(retryBase(failed), null);
    assert.deepEqual(storableMessages(failed), [u0, a0, reply('Par'), reply('Xx')]);
  });

  it('another message deleted while the retry streams: the base follows the chat as it stands', () => {
    const first = retried(failReply(streamed(asked([u0, a0], Q), 'Par'), FAILED, 'send'));
    assert.deepEqual(
      retryBase(failReply(first.shown.filter((m) => m !== u0), FAILED, 'send', first.after)),
      { base: [a0, Q], kind: 'send' },
      'an earlier message',
    );
    assert.deepEqual(
      retryBase(failReply(streamed(first.shown, 'Xx').filter((m) => m.content !== 'Par'), FAILED, 'send', first.after)),
      { base: [u0, a0, Q], kind: 'send' },
      "the first attempt's partial",
    );
  });

  it('a request asked after a message that is gone, or followed by more than replies, counts its own partial alone', () => {
    // The store's copy of the chat: the same text in new objects is not the message the request was asked after.
    const reloaded = [user('u0'), reply('a0')];
    assert.deepEqual(
      failReply(streamed(suggested(reloaded), 'S'), FAILED_SUGGESTIONS, 'suggest', a0),
      [...reloaded, reply('S'), bubble(FAILED_SUGGESTIONS, 'suggest', 1, 3)],
    );
    // A user turn after it: the fresh rule, whatever follows.
    assert.deepEqual(
      failReply(asked([u0, Q], user('x')), FAILED, 'send', Q),
      [u0, Q, user('x'), bubble(FAILED, 'send', 0, 3)],
    );
  });
});

describe('storableMessages and the retry record', () => {
  it('Pin: storableMessages drops an error bubble whole, its retry record with it', () => {
    const msgs = [u0, a0, Q, reply('Part'), bubble(FAILED, 'send', 1, 4)];
    assert.deepEqual(storableMessages(msgs), [u0, a0, Q, reply('Part')]);
    assert.ok(nothingUnstorable(storableMessages(msgs)));
  });
});
