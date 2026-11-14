// src/components/chat/ChatComposer.a11y.test.jsx — the chat's input row for a screen reader and a keyboard. The
// textarea has a label that is not its placeholder ("Message the AI Co-Pilot", named on the element itself: the form's
// children are the textarea, the suggest button and Send or Stop, in that order, and nothing else), and the placeholder
// stays as the hint. Pins on what must not move: Enter sends and Shift+Enter breaks the line; Send and Stop keep their
// names and their place after the textarea, Stop taking Send's node while a reply streams, so the second click of a
// double-click on Send lands on Stop and is ignored. axe finds nothing idle or while sending. Rendered bare under a host
// that holds the value, as ChatComposer.test.jsx does.
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatComposer from './ChatComposer.js';
import { expectLabelledControls, expectNoAxeViolations } from '../../test/a11y.js';

const LABEL = 'Message the AI Co-Pilot';

const box = () => screen.getByRole('textbox', { name: LABEL });

/** The four callbacks as spies. */
const spies = () => ({ onChange: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onSuggest: vi.fn() });

/** The composer under a host that holds its value, as the shell does. */
function Host({ initial = '', onChange, ...props }) {
  const [value, setValue] = useState(initial);
  return <ChatComposer {...props} value={value} onChange={(next) => { onChange(next); setValue(next); }} />;
}

const composer = (fns, props = {}) => <Host {...fns} sending={false} canSuggest={false} {...props} />;

describe('ChatComposer: the label', () => {
  it('names the textarea with a label that is not its placeholder, and keeps the placeholder as the hint', () => {
    const { container } = render(composer(spies()));
    expectLabelledControls(container);
    expect(box()).toHaveAttribute('placeholder', 'Ask about the flow...');
    expect(screen.getByLabelText(LABEL)).toBe(container.querySelector('textarea'));
  });
});

describe('ChatComposer: what must not move', () => {
  it('Pin: Enter sends the value; Shift+Enter breaks the line and sends nothing', async () => {
    const user = userEvent.setup();
    const fns = spies();
    render(composer(fns));

    await user.type(screen.getByPlaceholderText('Ask about the flow...'), 'Q1{Shift>}{Enter}{/Shift}');
    expect(fns.onSend).not.toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText('Ask about the flow...'), 'more{Enter}');
    expect(fns.onSend.mock.calls).toEqual([['Q1\nmore']]);
  });

  it('Pin: Send and Stop keep their names and their place after the textarea, Stop on Send\'s node', () => {
    const fns = spies();
    const { container, rerender } = render(composer(fns, { initial: 'Q2', canSuggest: true }));
    const form = container.querySelector('form');
    const textarea = container.querySelector('textarea');
    const send = screen.getByRole('button', { name: 'Send message' });
    expect([...form.children]).toEqual([
      textarea, screen.getByRole('button', { name: 'Suggest updates to Strategic Context' }), send,
    ]);

    rerender(composer(fns, { initial: 'Q2', canSuggest: true, sending: true }));
    const stop = screen.getByRole('button', { name: 'Stop generating' });
    expect(stop).toBe(send);
    expect([...form.children]).toEqual([textarea, stop]);
  });

  it('Pin: while a reply streams, Stop ignores the second click of a double-click and stops on a fresh one', () => {
    const fns = spies();
    render(composer(fns, { sending: true }));
    const stop = screen.getByRole('button', { name: 'Stop generating' });

    fireEvent.click(stop, { detail: 2 });
    expect(fns.onStop).not.toHaveBeenCalled();
    fireEvent.click(stop, { detail: 1 });
    expect(fns.onStop).toHaveBeenCalledTimes(1);
  });
});

describe('ChatComposer: axe', () => {
  it('Pin: finds nothing while idle, with a draft and the suggest button', async () => {
    const { container } = render(composer(spies(), { initial: 'draft', canSuggest: true }));
    await expectNoAxeViolations(container);
  });

  it('Pin: finds nothing while a reply streams', async () => {
    const { container } = render(composer(spies(), { initial: 'draft', sending: true }));
    await expectNoAxeViolations(container);
  });
});
