// src/components/chat/ChatComposer.test.jsx — the chat's input row, rendered bare (it reads no context) under a host
// that holds the value as the shell does: typing reports each value and fits the textarea to its text, 120 px at most;
// Enter sends the value and stays out of the text, Shift+Enter breaks the line; Send is live only for more than
// whitespace and submits the value as typed (the shell trims it); while a reply streams the textarea is disabled and
// Stop takes Send's node, and only a fresh click stops, so a double-click on Send sends once and leaves its reply
// running; the suggest button sits between the textarea and Send only once the chat holds a reply and not while
// sending, and asks without submitting; the ref the shell passes reaches the textarea.
import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatComposer from './ChatComposer.js';

const SUGGEST = 'Suggest updates to Strategic Context';

const box = () => screen.getByPlaceholderText('Ask about the flow...');
const sendButton = () => screen.getByRole('button', { name: 'Send message' });
const stopButton = () => screen.getByRole('button', { name: 'Stop generating' });

/** The four callbacks as spies. */
const spies = () => ({ onChange: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onSuggest: vi.fn() });

/** The composer under a host that holds its value, as the shell does: onChange reports each value, then it is kept. */
function Host({ initial = '', onChange, ...props }) {
  const [value, setValue] = useState(initial);
  return <ChatComposer {...props} value={value} onChange={(next) => { onChange(next); setValue(next); }} />;
}

/** The host with the spies, idle and with no reply yet; `props` overrides initial, sending and canSuggest. */
const composer = (fns, props = {}) => <Host {...fns} sending={false} canSuggest={false} {...props} />;

describe('ChatComposer', () => {
  it('Enter sends the value and stays out of the text; Shift+Enter breaks the line instead', async () => {
    const user = userEvent.setup();
    const fns = spies();
    render(composer(fns));

    await user.type(box(), 'Q1{Shift>}{Enter}{/Shift}');
    expect(fns.onSend).not.toHaveBeenCalled();
    expect(box()).toHaveValue('Q1\n');

    await user.type(box(), 'more{Enter}');
    expect(fns.onSend.mock.calls).toEqual([['Q1\nmore']]);
    expect(box()).toHaveValue('Q1\nmore');
  });

  it('reports each value and fits the textarea to its text, 120 px at most', () => {
    const fns = spies();
    render(composer(fns));
    const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(64);

    fireEvent.change(box(), { target: { value: 'a' } });
    expect(fns.onChange.mock.calls).toEqual([['a']]);
    expect(box()).toHaveValue('a');
    expect(box().style.height).toBe('64px');

    scrollHeight.mockReturnValue(300);
    fireEvent.change(box(), { target: { value: 'a\nb' } });
    expect(fns.onChange).toHaveBeenLastCalledWith('a\nb');
    expect(box().style.height).toBe('120px');
  });

  it('Send is live only for more than whitespace, and submits the value as typed', async () => {
    const user = userEvent.setup();
    const fns = spies();
    render(composer(fns));
    expect(sendButton()).toBeDisabled();

    await user.type(box(), '   ');
    expect(sendButton()).toBeDisabled();
    await user.type(box(), 'Q2');
    expect(sendButton()).toBeEnabled();

    await user.click(sendButton());
    expect(fns.onSend.mock.calls).toEqual([['   Q2']]);
    // The submit's default is prevented: one that went through would leave the page.
    expect(fireEvent.submit(box().closest('form'))).toBe(false);
  });

  it("while a reply streams, the textarea is disabled and Stop takes Send's node", () => {
    const fns = spies();
    const { rerender } = render(composer(fns, { initial: 'Q3' }));
    const send = sendButton();
    expect(box()).toBeEnabled();

    rerender(composer(fns, { initial: 'Q3', sending: true }));
    expect(box()).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
    expect(stopButton()).toBe(send);

    rerender(composer(fns, { initial: 'Q3' }));
    expect(box()).toBeEnabled();
    expect(sendButton()).toBe(send);
  });

  it('Stop stops on a fresh click (detail 1), not on the second click of a double-click (detail 2)', () => {
    const fns = spies();
    render(composer(fns, { sending: true }));

    fireEvent.click(stopButton(), { detail: 2 });
    expect(fns.onStop).not.toHaveBeenCalled();
    fireEvent.click(stopButton(), { detail: 1 });
    expect(fns.onStop).toHaveBeenCalledTimes(1);
    expect(fns.onSend).not.toHaveBeenCalled();
  });

  it('a double-click on Send sends once and leaves the reply it started running', async () => {
    const user = userEvent.setup();
    const fns = spies();
    function Shell() {
      const [sending, setSending] = useState(false);
      const onSend = (text) => { fns.onSend(text); setSending(true); };
      return composer({ ...fns, onSend }, { initial: 'Q4', sending });
    }
    render(<Shell />);

    await user.dblClick(sendButton());
    expect(fns.onSend.mock.calls).toEqual([['Q4']]);
    expect(fns.onStop).not.toHaveBeenCalled();
    expect(stopButton()).toBeInTheDocument();
  });

  it('the suggest button sits between the textarea and Send once the chat holds a reply, not while sending', async () => {
    const user = userEvent.setup();
    const fns = spies();
    const { rerender } = render(composer(fns, { initial: 'draft' }));
    expect(screen.queryByRole('button', { name: SUGGEST })).toBeNull();

    rerender(composer(fns, { initial: 'draft', canSuggest: true }));
    const suggest = screen.getByRole('button', { name: SUGGEST });
    expect([...box().closest('form').children]).toEqual([box(), suggest, sendButton()]);
    await user.click(suggest);
    expect(fns.onSuggest).toHaveBeenCalledTimes(1);
    expect(fns.onSend).not.toHaveBeenCalled();

    rerender(composer(fns, { initial: 'draft', canSuggest: true, sending: true }));
    expect(screen.queryByRole('button', { name: SUGGEST })).toBeNull();
  });

  it('passes the ref to the textarea, so the shell can focus it', () => {
    const ref = createRef();
    render(<ChatComposer ref={ref} value="" sending={false} canSuggest={false} {...spies()} />);
    expect(ref.current).toBe(box());

    ref.current.focus();
    expect(document.activeElement).toBe(box());
  });
});
