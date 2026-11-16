// src/lib/chatMessages.retry.node.test.js — what a failed request leaves and what its Retry asks again, as pure
// functions (src/lib/chatMessages.ts): failReply, the fail sink's update (the reply settled as far as it got, then the
// error bubble with its retry record { kind, partials, at }); retryBase, which says whether the last message can be
// retried and on which turns; retryPlaceholder, the retry's first update on the messages as they stand when it lands.
// Every bubble here is made by failReply from the messages a fail sink receives, and every chain of attempts goes
// through the helpers the chat runs: the send's placeholder, the stream's appendReplyText, failReply, retryPlaceholder
// and settleReply. The rules: every request passes failReply its anchor, the message it was asked after (a send's
// question, the suggestions' last message at the click, a retry's last message of its base); while that object is in
// the chat followed by replies alone, those are the request's partial replies, every attempt's, and the bubble carries
// a retry record; otherwise (no anchor, the anchor deleted, the chat cleared or reloaded, a question after it) it
// carries none and is never retryable; the bubble is retryable only while it is the last message and still at its
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
/** An expected bubble that carries no retry record: shown, never retryable. */
const bare = (content) => ({ role: 'error', content });

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
    const next = failReply(msgs, FAILED, 'send', Q);
    assert.deepEqual(next, [u0, a0, Q, bubble(FAILED, 'send', 0, 3)]);
    assert.deepEqual(msgs, [u0, a0, Q, placeholder()], 'the input is not mutated');
    [u0, a0, Q].forEach((m, i) => assert.equal(next[i], m, `message ${i} is the same object`));
    assert.deepEqual(storableMessages(next), [u0, a0, Q]);
    assert.ok(nothingUnstorable(storableMessages(next)), 'what the fail stores holds no bubble and no record');
  });

  it('a partial reply is settled as far as it got and kept before the bubble, which counts it', () => {
    const next = failReply(streamed(asked([u0, a0], Q), 'Part'), FAILED, 'send', Q);
    assert.deepEqual(next, [u0, a0, Q, reply('Part'), bubble(FAILED, 'send', 1, 4)]);
    assert.deepEqual(storableMessages(next), [u0, a0, Q, reply('Part')], 'the question and the partial are stored');
  });

  it("the kind is the caller's: a suggestions request that streamed nothing leaves the previous reply where it was", () => {
    const next = failReply(suggested([u0, a0]), FAILED_SUGGESTIONS, 'suggest', a0);
    assert.deepEqual(next, [u0, a0, bubble(FAILED_SUGGESTIONS, 'suggest', 0, 2)]);
    assert.equal(next[1], a0, 'the previous reply is untouched');
    assert.deepEqual(storableMessages(next), [u0, a0]);
  });

  it('a reply re-created after its streaming bubble was deleted is pending, and counts as the partial after the anchor', () => {
    const recreated = streamed(streamed(asked([u0, a0], Q), 'Part').slice(0, -1), 'ial');
    assert.deepEqual(recreated, [u0, a0, Q, streaming('ial')]);
    assert.deepEqual(failReply(recreated, FAILED, 'send', Q), [u0, a0, Q, reply('ial'), bubble(FAILED, 'send', 1, 4)]);
  });

  it('no retry record once the anchor is gone, missing, or followed by more than replies; nothing else changes', () => {
    // The question deleted while its reply waited for text, and while it streamed.
    const waiting = asked([u0, a0], Q).filter((m) => m !== Q);
    assert.deepEqual(failReply(waiting, FAILED, 'send', Q), [u0, a0, bare(FAILED)]);
    const streamingOn = streamed(asked([u0, a0], Q), 'Xx').filter((m) => m !== Q);
    assert.deepEqual(failReply(streamingOn, FAILED, 'send', Q), [u0, a0, reply('Xx'), bare(FAILED)]);
    // A Clear while the reply waited for text, and while it streamed (the next chunk re-creates the reply).
    assert.deepEqual(failReply([], FAILED_SUGGESTIONS, 'suggest', a0), [bare(FAILED_SUGGESTIONS)]);
    assert.deepEqual(failReply(streamed([], 'Sy'), FAILED_SUGGESTIONS, 'suggest', a0), [reply('Sy'), bare(FAILED_SUGGESTIONS)]);
    // No anchor: the suggestions asked on an empty chat.
    assert.deepEqual(failReply(suggested([]), FAILED_SUGGESTIONS, 'suggest', undefined), [bare(FAILED_SUGGESTIONS)]);
    // A reload from the store: equal messages, other objects.
    assert.deepEqual(failReply(asked([u0, a0], user('Q')), FAILED, 'send', Q), [u0, a0, user('Q'), bare(FAILED)]);
    // A question after the anchor.
    assert.deepEqual(failReply([Q, user('Q2'), placeholder()], FAILED, 'send', Q), [Q, user('Q2'), bare(FAILED)]);
  });
});

describe('retryBase', () => {
  it('a send that streamed nothing: the chat before the bubble, which ends on the question', () => {
    const r = retryBase(failReply(asked([u0, a0], Q), FAILED, 'send', Q));
    assert.deepEqual(r, { base: [u0, a0, Q], kind: 'send' });
    [u0, a0, Q].forEach((m, i) => assert.equal(r.base[i], m, `base ${i} is the message itself`));
  });

  it('a send with a partial reply: the partial stays in the chat and is left out of the base', () => {
    const msgs = failReply(streamed(asked([u0, a0], Q), 'Part'), FAILED, 'send', Q);
    assert.deepEqual(retryBase(msgs), { base: [u0, a0, Q], kind: 'send' });
    assert.deepEqual(msgs.slice(0, -1), [u0, a0, Q, reply('Part')], 'retryBase removes nothing');
  });

  it('a suggestions request that streamed nothing: the previous reply stays in the base', () => {
    const msgs = failReply(suggested([u0, a0]), FAILED_SUGGESTIONS, 'suggest', a0);
    assert.deepEqual(retryBase(msgs), { base: [u0, a0], kind: 'suggest' });
  });

  it('a suggestions request with a partial reply: the base is the chat before the partial', () => {
    const msgs = failReply(streamed(suggested([u0, a0]), 'Sugg'), FAILED_SUGGESTIONS, 'suggest', a0);
    assert.deepEqual(msgs, [u0, a0, reply('Sugg'), bubble(FAILED_SUGGESTIONS, 'suggest', 1, 3)]);
    assert.deepEqual(retryBase(msgs), { base: [u0, a0], kind: 'suggest' });
  });

  it("null when a send's request would not end on the user's turn: the deletes and the Clear made mid-reply", () => {
    const sending = asked([u0, a0], Q);
    const cases = [
      ['the question deleted mid-reply', sending.filter((m) => m !== Q)],
      ['the question deleted after text', streamed(sending, 'Xx').filter((m) => m !== Q)],
      ['the only question deleted mid-reply', asked([], Q).slice(1)],
      ['a Clear mid-reply', []],
      ['a Clear mid-reply, then text that re-created the reply', streamed([], 'x')],
    ];
    for (const [name, received] of cases) {
      assert.equal(retryBase(failReply(received, FAILED, 'send', Q)), null, name);
    }
  });

  it('null when a suggestions request has no reply left to review', () => {
    const replyDeleted = suggested([u0, a0]).filter((m) => m !== a0);
    assert.equal(retryBase(failReply(replyDeleted, FAILED_SUGGESTIONS, 'suggest', a0)), null, 'its reply deleted');
    assert.equal(retryBase(failReply([], FAILED_SUGGESTIONS, 'suggest', a0)), null, 'a Clear mid-request');
  });

  it('null once the bubble is not the last message, and retryable again once what followed it is deleted', () => {
    const failed = failReply(asked([u0, a0], Q), FAILED, 'send', Q);
    const Q2 = user('Q2');
    const answered = settleReply(streamed(asked(failed, Q2), 'A2'), '');
    assert.equal(retryBase(asked(failed, Q2)), null);
    assert.equal(retryBase(answered), null);
    assert.deepEqual(retryBase(answered.slice(0, 4)), { base: [u0, a0, Q], kind: 'send' });
  });

  it('null once a message before the bubble is deleted: it is no longer at its index', () => {
    const failed = failReply(streamed(asked([u0, a0], Q), 'Part'), FAILED, 'send', Q);
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
    // A send record whose base would end on a reply: failReply writes none (its anchor is the question), and the guard
    // keeps it unaskable if one ever came.
    assert.equal(retryBase([u0, a0, bubble(FAILED, 'send', 0, 2)]), null, "a send's base that ends on a reply");
  });

  it("an older error bubble before the question stays in the base; the request's turns leave it out", () => {
    const older = failReply(asked([], u0), FAILED, 'send', u0); // u0 failed and was never retried
    const r = retryBase(failReply(asked(older, Q), FAILED, 'send', Q));
    assert.deepEqual(r.base, [u0, older[1], Q]);
    assert.deepEqual(r.base.filter(isTurn), [u0, Q]);
  });
});

describe('retryPlaceholder', () => {
  it('while the bubble is still retryable, it gives way to the pending reply; a partial before it stays', () => {
    assert.deepEqual(retried(failReply(asked([u0, a0], Q), FAILED, 'send', Q)).shown, [u0, a0, Q, placeholder()]);
    assert.deepEqual(
      retried(failReply(streamed(asked([u0, a0], Q), 'Part'), FAILED, 'send', Q)).shown,
      [u0, a0, Q, reply('Part'), placeholder()],
    );
    assert.deepEqual(
      retried(failReply(suggested([u0, a0]), FAILED_SUGGESTIONS, 'suggest', a0)).shown,
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
        const failedOnce = failReply(streamed(asked([u0, a0], Q), firstText), FAILED, 'send', Q);
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
    const first = retried(failReply(streamed(suggested([u0, a0]), 'Sp'), FAILED_SUGGESTIONS, 'suggest', a0));
    assert.deepEqual(first.turns, [u0, a0, user(CONTEXT_UPDATE_PROMPT)]);
    const failedTwice = failReply(first.shown, FAILED_SUGGESTIONS, 'suggest', first.after);
    const second = retried(failedTwice);
    assert.equal(second.kind, 'suggest');
    assert.deepEqual(second.turns, [u0, a0, user(CONTEXT_UPDATE_PROMPT)], 'the first attempt\'s partial stays out');
    const answered = settleReply(streamed(second.shown, 'S'), '');
    assert.deepEqual(storableMessages(answered), [u0, a0, reply('Sp'), reply('S')]);
  });

  it('the question deleted while the retry streams: the next bubble offers no Retry, and nothing else is removed', () => {
    const first = retried(failReply(streamed(asked([u0, a0], Q), 'Par'), FAILED, 'send', Q));
    const questionDeleted = streamed(first.shown, 'Xx').filter((m) => m !== Q);
    const failed = failReply(questionDeleted, FAILED, 'send', first.after);
    assert.equal(retryBase(failed), null);
    assert.deepEqual(storableMessages(failed), [u0, a0, reply('Par'), reply('Xx')]);
  });

  it('another message deleted while the retry streams: the base follows the chat as it stands', () => {
    const first = retried(failReply(streamed(asked([u0, a0], Q), 'Par'), FAILED, 'send', Q));
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

  it('a request asked after a message that is gone, or followed by more than replies, leaves a bubble with no record', () => {
    // The store's copy of the chat: the same text in new objects is not the message the request was asked after.
    const reloaded = [user('u0'), reply('a0')];
    const fromStore = failReply(streamed(suggested(reloaded), 'S'), FAILED_SUGGESTIONS, 'suggest', a0);
    assert.deepEqual(fromStore, [...reloaded, reply('S'), bare(FAILED_SUGGESTIONS)]);
    assert.equal(retryBase(fromStore), null);
    // A user turn after it, whatever follows.
    const questionAfter = failReply(asked([u0, Q], user('x')), FAILED, 'send', Q);
    assert.deepEqual(questionAfter, [u0, Q, user('x'), bare(FAILED)]);
    assert.equal(retryBase(questionAfter), null);
    // A retry's anchor deleted with an earlier attempt's partial still in the chat: that partial is never sent.
    const first = retried(failReply(streamed(suggested([u0, a0]), 'Sp'), FAILED_SUGGESTIONS, 'suggest', a0));
    const failed = failReply(first.shown.filter((m) => m !== a0), FAILED_SUGGESTIONS, 'suggest', first.after);
    assert.deepEqual(failed, [u0, reply('Sp'), bare(FAILED_SUGGESTIONS)]);
    assert.equal(retryBase(failed), null);
  });
});

describe('storableMessages and the retry record', () => {
  it('Pin: storableMessages drops an error bubble whole, its retry record with it', () => {
    const msgs = [u0, a0, Q, reply('Part'), bubble(FAILED, 'send', 1, 4)];
    assert.deepEqual(storableMessages(msgs), [u0, a0, Q, reply('Part')]);
    assert.ok(nothingUnstorable(storableMessages(msgs)));
  });
});
