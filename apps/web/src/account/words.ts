import type { ModelKeyPublic } from '@prix/contracts';
import { PROMPT_MAX, PROMPT_MIN, PROVIDERS } from '@prix/contracts';
import { formatCount } from '../content/format.ts';
import { text } from '../content/index.ts';

/**
 * Words that more than one account screen uses, so that each key has one draft.
 * Server only: this file reads the copy deck and must not reach a browser script.
 */

export const goToAccountLabel = (): string => text('account.linkLabel', 'Go to your account');

/** The label, the running count and the messages of the strategy prompt field, in the builder and on the account page. */
export function promptWords() {
  const max = formatCount(PROMPT_MAX);
  return {
    label: text('builder.promptLabel', 'Strategy prompt'),
    count: {
      max: PROMPT_MAX,
      template: text('builder.promptCount', '{count} of {max} characters', { max }),
      overTemplate: text('builder.promptOver', 'Over the limit of {max} characters by {over}. Shorten the prompt.', {
        max,
      }),
    },
    tooShort: text(
      'builder.promptTooShort',
      'That prompt is too short to describe a strategy. Write at least {min} characters.',
      { min: PROMPT_MIN },
    ),
  };
}

/** What a prompt form's own checks say, for its script. */
export function promptCheckWords() {
  return {
    promptShort: promptWords().tooShort,
    promptRejected: text('builder.promptRejected', 'That prompt was not accepted. {message}'),
    rejected: text('builder.fieldRejected', 'That entry was not accepted. {message}'),
  };
}

/** Under every form that needs a script: what to do when scripts are off. */
export function noScriptWords() {
  return {
    title: text('signIn.noScriptTitle', 'JavaScript is off'),
    body: text(
      'account.noScriptBody',
      'Building and changing an agent needs JavaScript. Turn it on and reload the page.',
    ),
  };
}

/** The name of a provider as the contract's allowlist spells it. */
export function providerLabel(id: string): string {
  return PROVIDERS.find((provider) => provider.id === id)?.label ?? id;
}

/** One saved key in a list to choose from. It shows the last four characters and nothing more of the key. */
export function keyOptionLabel(key: ModelKeyPublic): string {
  return text('modelKey.optionLabel', '{provider}, {model}, key ending in {last4}', {
    provider: providerLabel(key.provider),
    model: key.model,
    last4: key.last4,
  });
}
