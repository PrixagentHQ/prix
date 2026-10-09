/**
 * Moving between a board and an agent's page is one motion: the mark and the name of the agent
 * travel from the card to the head of its page, and back.
 *
 *   import '../design/motion/carry.ts';        // on a page that shows cards
 *
 * It needs nothing on the agent's page but `<AgentMark carry />` and `data-carry="name"` on the
 * name. Only one card may carry the two names at a time, so this module marks the card a person
 * leaves from, or comes back to, with `data-carried`; motion.css does the rest. It works where
 * the browser has cross-document view transitions and does nothing elsewhere. The link is a
 * plain link either way.
 */
import { inBrowser } from './shared.ts';

interface Activation {
  entry?: { url?: string | null } | null;
  from?: { url?: string | null } | null;
}
interface SwapEvent extends Event {
  activation?: Activation | null;
  viewTransition?: { finished: Promise<unknown> } | null;
}

/** The agent a page address belongs to: /agents/<id> and /listed/<id>. */
function agentOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const match = /^\/(?:agents|listed)\/([^/]+)/.exec(new URL(url, window.location.href).pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function clear(): void {
  for (const card of document.querySelectorAll('[data-carried]')) card.removeAttribute('data-carried');
}

function carry(agentId: string | null): boolean {
  clear();
  if (!agentId) return false;
  for (const card of document.querySelectorAll<HTMLElement>('[data-agent]')) {
    if (card.dataset.agent !== agentId || !card.querySelector('[data-carry-source]')) continue;
    card.setAttribute('data-carried', '');
    return true;
  }
  return false;
}

if (inBrowser) {
  // Leaving for an agent's page: its card gives up its mark and name.
  window.addEventListener('pageswap', (event: SwapEvent) => {
    if (event.viewTransition) carry(agentOf(event.activation?.entry?.url));
  });
  // Coming back from one: its card takes them again, then lets go.
  window.addEventListener('pagereveal', (event: SwapEvent) => {
    if (!event.viewTransition) return;
    const activation = (window as { navigation?: { activation?: Activation | null } }).navigation?.activation;
    if (carry(agentOf(activation?.from?.url))) event.viewTransition.finished.then(clear, clear);
  });
}
