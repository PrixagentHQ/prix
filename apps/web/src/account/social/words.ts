import { AGENT_NAME_MAX, AGENT_NAME_MIN } from '@prix/contracts';
import { text } from '../../content/index.ts';

/**
 * Every sentence of the three signed-in Phase 6 screens, in one place, each under a key of the copy
 * area `social` (docs/CONTRACTS.md section 18.5); the copy deck (content/deck-social.ts) holds the
 * final wording. Server only: this file reads the copy deck and must not reach a browser script,
 * which holds no sentence of its own and receives the ones it needs in `data-words`.
 *
 * No sentence here uses a word of SOCIAL_FORBIDDEN_WORDS or ADVICE_WORDS. A paper manager is always
 * a "paper manager", and the measured profile is always a "strategy profile".
 */

// --- shared -----------------------------------------------------------------------------------------

export const noScript = () => ({
  title: text('social.noScriptTitle', 'JavaScript is off'),
  body: text('social.noScriptBody', 'This page needs JavaScript. Turn it on and reload the page.'),
});

export const unreadable = (what: string) => ({
  title: text('social.unreadableTitle', '{what} could not be read', { what }),
  body: text('social.unreadableBody', 'Reload the page to try again. If it keeps failing, come back in a few minutes.'),
  action: text('common.reloadPage', 'Reload the page'),
});

// --- the fork builder -------------------------------------------------------------------------------

export function forkWords(parentName: string) {
  return {
    title: text('social.forkTitle', 'Fork {name}', { name: parentName }),
    intro: text(
      'social.forkIntro',
      'Start from a public agent and make it your own. A fork is a new agent with its own name, its own prompt and its own record.',
    ),
    back: text('social.forkBack', 'Back to {name}', { name: parentName }),
    signInTitle: text('social.forkSignInTitle', 'Sign in to fork {name}', { name: parentName }),
    signInBody: text(
      'social.forkSignInBody',
      'A fork belongs to a wallet. Sign in to build it. The sign-in signature is the only thing Prix asks of your wallet.',
    ),
    parentTitle: text('social.forkParentTitle', 'The agent you are forking'),
    summaryTitle: text('social.forkSummaryTitle', 'What it does'),
    summaryPending: text('social.forkSummaryPending', 'The summary of this agent is not ready yet.'),
    summaryFailed: text('social.forkSummaryFailed', 'This agent has no summary.'),
    divisionNote: text(
      'social.forkDivisionNote',
      'Division: {division}. A fork joins the division of its parent, and the division cannot be changed later.',
      { division: '{division}' },
    ),
    nameLabel: text('builder.nameLabel', 'Agent name'),
    nameHint: text('social.forkNameHint', 'The name is public, and it cannot contain {parent}.', {
      parent: '{parent}',
    }),
    publishedLabel: text('social.forkPublishedLabel', 'Published by its owner. Make it yours.'),
    privateNote: text(
      'social.forkPrivateNote',
      'The owner keeps this prompt private. Write your own in the box. The summary and the strategy profile show what the agent does.',
    ),
    sameHint: text(
      'social.forkSameHint',
      'Change the prompt to build the fork. A fork cannot repeat the published prompt word for word.',
    ),
    keyLabel: text('builder.keyLabel', 'Model key'),
    keyHint: text(
      'social.forkKeyHint',
      'This is a Pro agent, so your fork runs on one of your model keys. You can add or delete keys on your account page.',
    ),
    keyNone: text('social.forkKeyNone', 'A Pro fork needs a model key, and this wallet has none saved.'),
    keyAdd: text('builder.addKeyLink', 'Add a model key on your account page'),
    publishLabel: text('builder.publishLabel', 'Publish the full prompt'),
    publishHint: text(
      'social.forkPublishHint',
      'Your prompt stays private unless you publish it. Once it is published, anyone can read it on your agent’s page and copy it into a fork, and a copy stays in that fork even if you unpublish.',
    ),
    notes: text(
      'social.forkNotes',
      'A fork starts with 10,000 virtual USD and no record. Nothing of the parent’s results carries over.',
    ),
    submit: text('social.forkSubmit', 'Build the fork'),
    busy: text('social.forkBusy', 'Building the fork'),
    failedTitle: text('social.forkFailedTitle', 'The fork was not built'),
    nameContains: text(
      'social.forkNameContains',
      'A fork cannot use the name of its parent, {parent}, inside its own. Choose another name.',
      { parent: '{parent}' },
    ),
    nameShort: text('builder.nameTooShort', 'That name is too short. Use at least {min} characters.', {
      min: AGENT_NAME_MIN,
    }),
    nameLong: text('builder.nameTooLong', 'That name is too long. Use at most {max} characters.', {
      max: AGENT_NAME_MAX,
    }),
    nameReserved: text(
      'builder.nameReserved',
      'That name is reserved, because it could pass for Prix, its staff or a partner. Choose another name.',
    ),
    nameRejected: text('builder.nameRejected', 'That name was not accepted. {message}'),
    keyMissing: text('builder.keyMissing', 'A Pro agent needs a model key. Choose one of your saved keys.'),
    fullOpen: text(
      'errors.leagueFullOpen',
      'The Open division is full. For now it takes at most 200 agents. If the Pro division has room, you can build a Pro agent, which runs on your own model key.',
    ),
    fullPro: text(
      'errors.leagueFullPro',
      'The Pro division is full. For now it takes at most 50 agents. If the Open division has room, you can build an Open agent, which runs on the house model.',
    ),
    linkTitle: text('social.forkLinkTitle', 'Your agent was built, but it is not linked to {parent}', {
      parent: '{parent}',
    }),
    linkBody: text(
      'social.forkLinkBody',
      'Your agent exists and trades as an ordinary agent. The link shows it as a fork of {parent} on both pages. {message}',
      { parent: '{parent}', message: '{message}' },
    ),
    linkAgain: text('social.forkLinkAgain', 'Link to {parent}', { parent: '{parent}' }),
    linkBusy: text('social.forkLinkBusy', 'Linking'),
    linkLater: text('social.forkLinkLater', 'Go to your account'),
    linkWindowClosed: text(
      'social.forkLinkWindowClosed',
      'A fork can be linked for ten minutes after it is built, and that time has passed. Your agent keeps trading as an ordinary agent.',
    ),
    linkRefused: text(
      'social.forkLinkRefused',
      'Prix did not accept the link. Your agent keeps trading as an ordinary agent.',
    ),
    linkNameRefused: text(
      'social.forkLinkNameRefused',
      'The name of your agent contains the name of the agent it came from, so Prix did not link it. Its name cannot be changed.',
    ),
    linkPromptRefused: text(
      'social.forkLinkPromptRefused',
      'The prompt of your agent is the published prompt word for word, so Prix did not link it.',
    ),
    linkCapped: text(
      'social.forkLinkCapped',
      'This agent has reached its limit of forks for today. Try the link again in a few minutes.',
    ),
  };
}

// --- paper managers ---------------------------------------------------------------------------------

/** The sentence the contract orders for every place that names a paper manager (section 5.5). */
export const managersDefinition = () =>
  text(
    'social.managerDefinition',
    'A paper manager is a simulated allocation across public agents. No money is involved, nobody can put money into it, and it is not advice.',
  );

export function managerWords() {
  return {
    title: text('social.managersTitle', 'Paper managers'),
    back: text('nav.account', 'Account'),
    signInTitle: text('social.myManagersSignInTitle', 'Sign in to see your paper managers'),
    signInBody: text(
      'social.myManagersSignInBody',
      'Paper managers belong to a wallet. Sign in to see yours. The sign-in signature is the only thing Prix asks of your wallet.',
    ),
    slotsFull: text(
      'social.myManagersSlotsFull',
      'Every slot is in use. A paused paper manager keeps its slot; close one to free it.',
    ),
    slotsTokenLink: text('social.myManagersSlotsTokenLink', 'See the slots each tier gives'),
    emptyTitle: text('social.myManagersEmptyTitle', 'No paper manager yet'),
    emptyBody: text(
      'social.myManagersEmptyBody',
      'Pick two to five public agents, give each a weight and name it. It is valued once a day, and whatever the weights leave over stays in cash.',
    ),
    emptyAction: text('social.myManagersEmptyAction', 'Create a paper manager'),
    createTitle: text('social.myManagersCreateTitle', 'Create a paper manager'),
    nameLabel: text('social.myManagersNameLabel', 'Name'),
    nameHint: text(
      'social.myManagersNameHint',
      'Public. 3 to 32 characters. Not the name of an agent, a listing or another paper manager.',
    ),
    agentPlaceholder: text('social.myManagersAgentPlaceholder', 'Choose an agent'),
    weightLabel: text('social.myManagersWeightLabel', 'Weight, in percent'),
    rowLabel: text('social.myManagersRowLabel', 'Agent {n}', { n: '{n}' }),
    addRow: text('social.myManagersAddRow', 'Add an agent'),
    removeRow: text('social.myManagersRemoveRow', 'Remove agent {n}', { n: '{n}' }),
    allocationLegend: text('social.myManagersAllocationLegend', 'Agents and weights'),
    pickerNone: text(
      'social.myManagersPickerNone',
      'No public agent can be chosen yet. A paper manager needs public agents that hold a paper portfolio. Come back after the next round.',
    ),
    cashLine: text('social.myManagersCashLine', 'Weights add up to {sum}%. Cash is {cash}%.', {
      sum: '{sum}',
      cash: '{cash}',
    }),
    cashOver: text(
      'social.myManagersCashOver',
      'Weights add up to {sum}%, which is over 100%. Lower the weights by {over}% in all.',
      { sum: '{sum}', over: '{over}' },
    ),
    serverDecides: text('social.myManagersServerDecides', 'Prix checks the weights again when you save.'),
    scheduleLegend: text('social.myManagersScheduleLegend', 'Schedule'),
    scheduleWeekly: text('social.myManagersScheduleWeekly', 'Weekly'),
    scheduleWeeklyHint: text(
      'social.myManagersScheduleWeeklyHint',
      'Goes back to these weights on the first valued day of each week.',
    ),
    scheduleHold: text('social.myManagersScheduleHold', 'Hold'),
    scheduleHoldHint: text(
      'social.myManagersScheduleHoldHint',
      'Keeps its starting allocation and lets the weights drift as the agents’ values move.',
    ),
    effectNote: text(
      'social.myManagersEffectNote',
      'A new allocation takes effect on the first valued day after you save it, and an allocation can be changed once a day.',
    ),
    createSubmit: text('social.myManagersCreateSubmit', 'Create the paper manager'),
    createBusy: text('social.myManagersCreateBusy', 'Creating the paper manager'),
    createFailed: text('social.myManagersCreateFailed', 'The paper manager was not created'),
    created: text('social.myManagersCreatedTitle', 'Paper manager created'),
    createdBody: text(
      'social.myManagersCreatedBody',
      'It starts with 10,000 virtual USD on the first valued day after today.',
    ),
    yoursTitle: text('social.myManagersYoursTitle', 'Your paper managers'),
    statusActive: text('social.myManagersStatusActive', 'Active'),
    statusPaused: text('social.myManagersStatusPaused', 'Paused'),
    statusClosed: text('social.myManagersStatusClosed', 'Closed'),
    hiddenNote: text('social.myManagersHiddenNote', 'Prix has hidden this paper manager from the public pages.'),
    figuresNone: text(
      'social.myManagersFiguresNone',
      'No figures yet. A paper manager is first valued on the day after it is created.',
    ),
    figureReturn: text('social.myManagersFigureReturn', 'Return'),
    figureDrawdown: text('social.myManagersFigureDrawdown', 'Max drawdown'),
    figureDays: text('social.myManagersFigureDays', 'Valued days'),
    allocationTitle: text('social.myManagersAllocationTitle', 'Allocation'),
    unknownAgent: text('social.myManagersUnknownAgent', 'Agent {id}', { id: '{id}' }),
    cashRow: text('social.myManagersCashRow', 'Cash'),
    changedToday: text(
      'social.myManagersChangedToday',
      'You changed this allocation today. The next change can be made after 00:00 UTC.',
    ),
    changeLeft: text('social.myManagersChangeLeft', 'You can change this allocation once today.'),
    closedNote: text(
      'social.myManagersClosedNote',
      'This paper manager is closed. It keeps its public record and does not change.',
    ),
    edit: text('social.myManagersEdit', 'Edit the allocation'),
    editTitle: text('social.myManagersEditTitle', 'Edit {name}', { name: '{name}' }),
    editSubmit: text('social.myManagersEditSubmit', 'Save the allocation'),
    editBusy: text('social.myManagersEditBusy', 'Saving the allocation'),
    editCancel: text('common.cancel', 'Cancel'),
    editFailed: text('social.myManagersEditFailed', 'The allocation was not saved'),
    pause: text('social.myManagersPause', 'Pause'),
    pauseBusy: text('social.myManagersPauseBusy', 'Pausing'),
    pauseNote: text('social.myManagersPauseNote', 'A paused paper manager is not valued and keeps its slot.'),
    resume: text('social.myManagersResume', 'Resume'),
    resumeBusy: text('social.myManagersResumeBusy', 'Resuming'),
    close: text('social.myManagersClose', 'Close the paper manager'),
    closeBusy: text('social.myManagersCloseBusy', 'Closing the paper manager'),
    closeQuestion: text('social.myManagersCloseQuestion', 'Close {name}?', { name: '{name}' }),
    closeConsequence: text(
      'social.myManagersCloseConsequence',
      'A closed paper manager keeps its public record, cannot be changed or reopened, and frees one slot.',
    ),
    statusFailed: text('social.myManagersStatusFailed', 'The status was not changed'),
    // The checks of the form itself. The server checks every one of them again.
    nameShort: text('social.myManagersNameShort', 'That name is too short. Use at least {min} characters.'),
    nameLong: text('social.myManagersNameLong', 'That name is too long. Use at most {max} characters.'),
    nameRejected: text('social.myManagersNameRejected', 'That name was not accepted. {message}'),
    agentMissing: text('social.myManagersAgentMissing', 'Choose an agent for this row.'),
    agentTwice: text('social.myManagersAgentTwice', 'This agent is chosen twice. Choose each agent once.'),
    weightsOver: text(
      'social.myManagersWeightsOver',
      'The weights add up to more than 100%. Lower one or more of them.',
    ),
    weightsRejected: text('social.myManagersWeightsRejected', 'The allocation was not accepted. {message}'),
    nameTaken: text(
      'social.myManagersNameTaken',
      'That name is already used by an agent, a listing or a paper manager. Choose another.',
    ),
    nameNotAllowed: text(
      'social.myManagersNameNotAllowed',
      'That name is not allowed for a paper manager. Choose another.',
    ),
    slotLimit: text(
      'social.myManagersSlotLimit',
      'This wallet uses all of its slots. Close a paper manager to free one, or see the slots each tier gives.',
    ),
    totalFull: text(
      'social.myManagersTotalFull',
      'Prix has reached its limit of open paper managers. Try again after one is closed.',
    ),
    changeLimit: text(
      'social.myManagersChangeLimit',
      'This allocation was already changed today. The next change can be made after 00:00 UTC.',
    ),
    createdTodayLimit: text(
      'social.myManagersCreatedTodayLimit',
      'Too many paper managers were created today. Try again after 00:00 UTC.',
    ),
  };
}

// --- model wars -------------------------------------------------------------------------------------

export function warWords() {
  return {
    title: text('social.adminWarsTitle', 'Model wars'),
    back: text('nav.admin', 'Admin'),
    intro: text(
      'social.adminWarsIntro',
      'A model war runs one public strategy on two to four models that passed the check, under the same conditions. One war is open at a time.',
    ),
    openTitle: text('social.adminWarsOpenTitle', 'The open war'),
    openNone: text('social.adminWarsOpenNone', 'No war is open'),
    openNoneLine: text('social.adminWarsOpenNoneLine', 'No war is open. Create one with the form below.'),
    openNoneBody: text(
      'social.adminWarsOpenNoneBody',
      'A war that is scheduled or running shows here. Create one below.',
    ),
    openLine: text('social.adminWarsOpenLine', 'Starts {startsOn}. {done} of {days} trading days done.', {
      startsOn: '{startsOn}',
      done: '{done}',
      days: '{days}',
    }),
    statusScheduled: text('social.adminWarsStatusScheduled', 'Scheduled'),
    statusRunning: text('social.adminWarsStatusRunning', 'Running'),
    viewWar: text('social.adminWarsViewWar', 'Open the war page'),
    stop: text('social.adminWarsStop', 'Stop the war'),
    stopBusy: text('social.adminWarsStopBusy', 'Stopping the war'),
    stopQuestion: text('social.adminWarsStopQuestion', 'Stop {title}?', { title: '{title}' }),
    stopConsequence: text(
      'social.adminWarsStopConsequence',
      'A stopped war cannot be restarted. The days already run stay on its public page.',
    ),
    stopFailed: text('social.adminWarsStopFailed', 'The war was not stopped'),
    stoppedTitle: text('social.adminWarsStoppedTitle', 'War stopped'),
    stoppedBody: text('social.adminWarsStoppedBody', 'The war is closed. You can create the next one.'),
    listOffTitle: text('social.adminWarsListOffTitle', 'The open war cannot be listed'),
    listOffBody: text(
      'social.adminWarsListOffBody',
      'The public pages of model wars are switched off, so this page cannot show which war is open. Creating a war still works.',
    ),
    createTitle: text('social.adminWarsCreateTitle', 'Create a model war'),
    createIntro: text(
      'social.adminWarsCreateIntro',
      'The strategy is public text written by Prix. It is shown on the war page beside the models, never a user’s prompt.',
    ),
    titleLabel: text('social.adminWarsTitleLabel', 'Title'),
    titleHint: text(
      'social.adminWarsTitleHint',
      '3 to 80 characters. Name what is tested, not a result. Words that promise or rank are refused.',
    ),
    strategyLabel: text('social.adminWarsStrategyLabel', 'Strategy'),
    strategyHint: text(
      'social.adminWarsStrategyHint',
      'Public, 20 to 2,000 characters. Every model gets this same text. Never paste a private prompt.',
    ),
    startsLabel: text('social.adminWarsStartsLabel', 'First day'),
    startsHint: text(
      'social.adminWarsStartsHint',
      'A UTC day from today. The first war-day is the first daily round on or after it.',
    ),
    daysLabel: text('social.adminWarsDaysLabel', 'Trading days'),
    daysHint: text('social.adminWarsDaysHint', 'From 5 to 20. The war ends when every model has run this many days.'),
    modelsLegend: text('social.adminWarsModelsLegend', 'Models'),
    modelsHint: text('social.adminWarsModelsHint', 'Choose from 2 to 4. Each runs once, in the order chosen.'),
    modelProbe: text(
      'social.adminWarsModelProbe',
      '{maker}, {provider}. Checked {on}: {valid} valid decisions of {of}.',
      { maker: '{maker}', provider: '{provider}', on: '{on}', valid: '{valid}', of: '{of}' },
    ),
    providerWorkersAi: text('social.providerWorkersAi', 'Workers AI'),
    providerGroq: text('social.providerGroq', 'Groq'),
    noModelsTitle: text('social.adminWarsNoModelsTitle', 'No model has passed the check yet'),
    noModelsBody: text(
      'social.adminWarsNoModelsRecorded',
      'A model can be chosen once it has passed the house probe. Until then a war cannot be created.',
    ),
    submit: text('social.adminWarsSubmit', 'Create the model war'),
    busy: text('social.adminWarsBusy', 'Creating the model war'),
    failedTitle: text('social.adminWarsFailedTitle', 'The model war was not created'),
    createdTitle: text('social.adminWarsCreatedTitle', 'Model war created'),
    createdBody: text('social.adminWarsCreatedBody', 'It is scheduled, and it shows above as the open war.'),
    titleShort: text('social.adminWarsTitleShort', 'Use a title of at least {min} characters.'),
    titleLong: text('social.adminWarsTitleLong', 'Use a title of at most {max} characters.'),
    strategyShort: text('social.adminWarsStrategyShort', 'Write at least {min} characters of strategy.'),
    strategyLong: text('social.adminWarsStrategyLong', 'Shorten the strategy to at most {max} characters.'),
    modelsCount: text('social.adminWarsModelsCount', 'Choose from {min} to {max} models.'),
    fieldRejected: text('social.adminWarsFieldRejected', 'That was not accepted. {message}'),
    warOpen: text(
      'social.adminWarsWarOpen',
      'A war is already scheduled or running. Stop it first, or wait until it ends.',
    ),
    gone: text('social.adminWarsGone', 'This war is not open any more. Reload the page.'),
    forbidden: text('admin.forbidden', 'This wallet is not an administrator any more. Sign in with a wallet that is.'),
  };
}
