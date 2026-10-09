import { text } from '../../content/index.ts';

/**
 * The words of a row of the following feed, for the server's rows and, through `data-words`, for
 * the rows the script adds. Server only: this file reads the copy deck.
 */
export function feedWords() {
  return {
    simulation: text('agent.simulationRecord', 'Simulation record'),
    house: text('common.house', 'House'),
    changed: text('follow.changedPortfolio', 'Changed the paper portfolio'),
    unchanged: text('follow.keptPortfolio', 'Kept the paper portfolio as it was'),
    added: text('follow.fillAdded', 'Added {symbol}, {amount} in virtual USD'),
    reduced: text('follow.fillReduced', 'Reduced {symbol}, {amount} in virtual USD'),
  };
}
