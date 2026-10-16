import { HOLDER_POLLS, HOLDERS_COPY, HOLDERS_FORBIDDEN_WORDS } from '@prix/contracts';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import PollVoteControl from './PollVoteControl.astro';
import PollVoteOption from './PollVoteOption.astro';

/**
 * The vote control as the server renders it (docs/contracts/phase-6-holders.md section 4.5): the words are the
 * contract's, every state starts hidden so that nothing claims a state before GET /api/polls/me has answered,
 * the vote buttons start hidden, and nothing runs inline under the CSP.
 */

const POLL = HOLDER_POLLS[0];
let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
});

function render(component: Parameters<AstroContainer['renderToString']>[0], props: Record<string, unknown>) {
  return container.renderToString(component, {
    props,
    request: new Request('https://prixagent.com/polls'),
  });
}

describe('the vote control', () => {
  it('renders the contract words, with the amount from the API', async () => {
    if (!POLL) throw new Error('no poll');
    const html = await render(PollVoteControl, { pollId: POLL.id, minTokens: 7_000 });
    expect(html).toContain('data-poll-vote="model-war-2-strategy"');
    expect(html).toContain(HOLDERS_COPY['polls.changeNote']);
    expect(html).toContain(HOLDERS_COPY['polls.signIn']);
    expect(html).toContain(HOLDERS_COPY['polls.needTokens'].replace('{amount}', '7,000'));
    expect(html).toContain(HOLDERS_COPY['polls.gateOff']);
    expect(html).toContain(HOLDERS_COPY['polls.prixWallets'].replace("'", '&#39;'));
    expect(html).toContain(HOLDERS_COPY['polls.saved']);
    for (const key of [
      'refusedClosed',
      'refusedNotOpen',
      'refusedFull',
      'refusedUnknownOption',
      'refusedRateLimited',
      'failed',
    ]) {
      expect(html).toContain(`data-message="${key}"`);
    }
  });

  it('starts with every state hidden and marked busy, so nothing claims a state before the read', async () => {
    const html = await render(PollVoteControl, { pollId: 'model-war-2-strategy', minTokens: 10_000 });
    const states = html.match(/<p[^>]*data-poll-state="[a-zA-Z]+"[^>]*>/g) ?? [];
    expect(states).toHaveLength(6);
    for (const state of states) expect(state).toMatch(/\shidden/);
    expect(html).toMatch(/data-poll-states[^>]*aria-busy="true"/);
  });

  it('sends a signed-out visitor to sign in and back to the poll', async () => {
    const html = await render(PollVoteControl, { pollId: 'model-war-2-strategy', minTokens: 10_000 });
    expect(html).toMatch(/href="\/sign-in\?next=%2Fpolls"|href="[^"]*sign-in[^"]*polls/);
  });

  it('runs nothing inline: no event handler attribute and no inline script', async () => {
    const html = await render(PollVoteControl, { pollId: 'model-war-2-strategy', minTokens: 10_000 });
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*[^<\s]/);
  });

  it('never says a forbidden word', async () => {
    const html = await render(PollVoteControl, { pollId: 'model-war-2-strategy', minTokens: 10_000 });
    const words = html.replace(/<[^>]+>/g, ' ');
    expect(words).not.toMatch(HOLDERS_FORBIDDEN_WORDS);
  });
});

describe('one option of the control', () => {
  it('hides the button and "Your vote" until the read, and names the option for the button', async () => {
    const html = await render(PollVoteOption, { optionId: 'index-core', optionName: 'Index Core' });
    expect(html).toContain('data-poll-option="index-core"');
    expect(html).toContain('data-poll-vote-button="index-core"');
    expect(html).toContain(HOLDERS_COPY['polls.vote']);
    expect(html).toContain(HOLDERS_COPY['polls.yourVote']);
    expect(html).toMatch(/<span[^>]*data-poll-vote-action[^>]*hidden/);
    expect(html).toMatch(/<span[^>]*data-poll-yours[^>]*hidden/);
    expect(html).toMatch(/id="poll-option-index-core-name"[^>]*>Index Core</);
  });
});
