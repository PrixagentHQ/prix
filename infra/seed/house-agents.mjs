/**
 * Creates the house agents of Prix (docs/DECISIONS.md D-090, docs/CONTRACTS.md section 17).
 * infra/README.md, "House agents", says how the operator runs it for production.
 *
 *   node infra/seed/house-agents.mjs --wallets
 *   node infra/seed/house-agents.mjs --origin http://localhost:8640
 *
 * `--wallets` makes a wallet for every agent of infra/seed/house-agents.json that has none yet
 * and prints the addresses in the form the Worker variable HOUSE_OWNERS takes. The keys are kept
 * in .artifacts/house-agents/wallets.json of the main checkout, which git ignores, and are never
 * printed or logged. The main checkout is found through git, so a run from a worktree uses the
 * same keys and never leaves new ones in a folder that is deleted with the worktree. One run at a
 * time makes wallets: it holds wallets.json.lock beside the file while it reads and writes it.
 * The wallets hold nothing and never will: a key signs a sign-in message and nothing else.
 *
 * `--origin <url>` creates the agents through the public API of that origin, as any person
 * would: for each wallet it asks for a nonce, signs the sign-in message, and creates the agent
 * unless `GET /api/me` already shows one. It writes to no database and uses no admin route.
 *
 * It is safe to run twice: a wallet is made once, and an agent that exists is left as it is.
 * It stops at the first answer it does not expect, says which request got it, and changes
 * nothing after that.
 *
 * The wallets must be in HOUSE_OWNERS of the API before the agents are created. A wallet that is
 * not is held to the limits of everyone: ten minutes after its first sign-in, and three new
 * agents a day from one network. The script then stops at the first refusal.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const AGENTS_FILE = join(ROOT, 'infra', 'seed', 'house-agents.json');
/** Set by `findKeys` before any key is read or written. */
let KEYS_ROOT = ROOT;
let WALLETS_DIR = join(ROOT, '.artifacts', 'house-agents');
let WALLETS_FILE = join(WALLETS_DIR, 'wallets.json');
let LOCK_FILE = `${WALLETS_FILE}.lock`;
/** True while this run holds LOCK_FILE, so that only this run's lock is ever removed. */
let holdsLock = false;
/** `SESSION_COOKIE` and `CHAIN_ID` of packages/contracts. */
const SESSION_COOKIE = '__Host-prix_session';
const CHAIN_ID = 4663;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Seconds between two wallets. Signing in is two requests, and one address may make twenty of
 * them a minute (apps/api/wrangler.jsonc, RATE_SIGN_IN), so eight wallets a minute stay under it
 * even when the script is run twice in a row.
 */
const DEFAULT_PACE_SECONDS = 7;

const USAGE = `Usage:
  node infra/seed/house-agents.mjs --wallets
  node infra/seed/house-agents.mjs --origin <url> [--pace <seconds>]

  --wallets       Make a wallet for every house agent that has none yet, and print the addresses
                  as HOUSE_OWNERS takes them. The keys stay in .artifacts/house-agents/wallets.json
                  of the main checkout, also when this runs from a worktree.
  --origin <url>  Create the agents through the public API of this origin, for example
                  http://localhost:8640 or https://prixagent.com. An agent that exists is kept.
  --pace <n>      Seconds to wait between two wallets. Default ${DEFAULT_PACE_SECONDS}.`;

class UsageError extends Error {}
/** An answer the script did not expect. The message names the request and never a secret. */
class Stop extends Error {}

function readArgs() {
  let values;
  try {
    values = parseArgs({
      options: {
        wallets: { type: 'boolean', default: false },
        origin: { type: 'string' },
        pace: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'The arguments could not be read.');
  }
  if (values.help) return { help: true };
  if (!values.wallets && values.origin === undefined) throw new UsageError('Give --wallets, --origin <url>, or both.');
  const pace = values.pace === undefined ? DEFAULT_PACE_SECONDS : Number(values.pace);
  if (!Number.isFinite(pace) || pace < 0 || pace > 600) throw new UsageError('--pace takes seconds, from 0 to 600.');
  return { help: false, wallets: values.wallets, origin: values.origin, pace };
}

/** The bare origin of `--origin`. Plain http is allowed for this machine only. */
function readOrigin(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new UsageError(`--origin is not a URL: "${text}".`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new UsageError('--origin must be https, or http on localhost.');
  }
  const bare =
    url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
  if (!bare) throw new UsageError('--origin is an origin only, without a path: for example https://prixagent.com.');
  return url.origin;
}

function readAgents() {
  const file = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'));
  const agents = Array.isArray(file.agents) ? file.agents : [];
  if (agents.length === 0) throw new Stop('infra/seed/house-agents.json lists no agent.');
  const names = new Set();
  for (const agent of agents) {
    const ok =
      typeof agent.name === 'string' &&
      agent.name !== '' &&
      typeof agent.prompt === 'string' &&
      agent.prompt !== '' &&
      (agent.division === 'open' || agent.division === 'pro');
    if (!ok) throw new Stop('An entry of infra/seed/house-agents.json has no name, no prompt or no division.');
    // A house agent uses the house model. A Pro agent would need a model key, which this script never handles.
    if (agent.division !== 'open') throw new Stop(`${agent.name}: a house agent is in the Open division.`);
    if (names.has(agent.name)) throw new Stop(`${agent.name} is listed twice in infra/seed/house-agents.json.`);
    names.add(agent.name);
  }
  return agents;
}

/**
 * The wallet functions of viem, which is a dependency of apps/api and of nothing at the root.
 * It is loaded from there, so this script adds no dependency of its own.
 */
function loadAccounts() {
  const require = createRequire(join(ROOT, 'apps', 'api', 'package.json'));
  let accounts;
  try {
    accounts = require('viem/accounts');
  } catch {
    throw new Stop('viem is not installed. Run `pnpm install --frozen-lockfile` first.');
  }
  return { generatePrivateKey: accounts.generatePrivateKey, privateKeyToAccount: accounts.privateKeyToAccount };
}

const shownPath = (file) => relative(KEYS_ROOT, file).replaceAll('\\', '/');

/**
 * Points the key paths at the main checkout: the parent of git's common directory, which every
 * worktree shares. A checkout git cannot describe stops the script before any key is touched.
 */
function findKeys() {
  const asked = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  });
  const common = asked.status === 0 ? asked.stdout.trim() : '';
  if (common === '' || basename(common) !== '.git') {
    throw new Stop('git could not name the main checkout of this repository. No key was read or written.');
  }
  KEYS_ROOT = dirname(resolve(common));
  WALLETS_DIR = join(KEYS_ROOT, '.artifacts', 'house-agents');
  WALLETS_FILE = join(WALLETS_DIR, 'wallets.json');
  LOCK_FILE = `${WALLETS_FILE}.lock`;
  if (resolve(KEYS_ROOT) !== resolve(ROOT)) console.log(`The keys are those of the main checkout, ${KEYS_ROOT}.`);
}

/** Takes the lock, or stops if another run holds it. Opened with 'wx': it fails if the file exists. */
function takeLock() {
  mkdirSync(WALLETS_DIR, { recursive: true });
  try {
    closeSync(openSync(LOCK_FILE, 'wx', 0o600));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Stop(
        `${shownPath(LOCK_FILE)} exists: another run is making wallets. Wait for it. If none is running, remove that file and run this again.`,
      );
    }
    throw new Stop(`${shownPath(LOCK_FILE)} could not be made. No wallet was made.`);
  }
  holdsLock = true;
}

function releaseLock() {
  if (!holdsLock) return;
  holdsLock = false;
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // Already gone. Nothing else holds this run's lock.
  }
}
process.on('exit', releaseLock);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

/** The wallets made so far, by agent name. A file that cannot be read stops the script: it holds keys. */
function readWallets() {
  if (!existsSync(WALLETS_FILE)) return [];
  let file;
  try {
    file = JSON.parse(readFileSync(WALLETS_FILE, 'utf8'));
  } catch {
    throw new Stop(`${shownPath(WALLETS_FILE)} cannot be read as JSON. It was left as it is.`);
  }
  const wallets = Array.isArray(file.wallets) ? file.wallets : null;
  const valid = wallets?.every(
    (wallet) =>
      typeof wallet.agent === 'string' &&
      /^0x[0-9a-f]{40}$/.test(wallet.address) &&
      /^0x[0-9a-f]{64}$/.test(wallet.privateKey),
  );
  if (!valid) throw new Stop(`${shownPath(WALLETS_FILE)} is not a list of wallets. It was left as it is.`);
  return wallets;
}

/** Refuses to keep keys in a place that git would pick up. */
function assertIgnoredByGit() {
  const check = spawnSync('git', ['check-ignore', '-q', WALLETS_FILE], { cwd: KEYS_ROOT, timeout: 20_000 });
  if (check.status !== 0) {
    throw new Stop(
      `${shownPath(WALLETS_FILE)} is not ignored by git, or git could not be asked. No wallet was made: keys are kept only where git cannot pick them up.`,
    );
  }
}

/** Makes the missing wallets and prints the addresses. A wallet that exists is never replaced. */
async function makeWallets(agents) {
  const { generatePrivateKey, privateKeyToAccount } = loadAccounts();
  // Checked before the lock is made, so that not even the lock lands where git would pick it up.
  assertIgnoredByGit();
  takeLock();
  try {
    reportWallets(agents, writeMissing(agents, readWallets(), generatePrivateKey, privateKeyToAccount));
  } finally {
    releaseLock();
  }
}

/** Adds a wallet for each agent without one, and writes the file if any was made. */
function writeMissing(agents, wallets, generatePrivateKey, privateKeyToAccount) {
  let made = 0;
  for (const agent of agents) {
    if (wallets.some((wallet) => wallet.agent === agent.name)) continue;
    const privateKey = generatePrivateKey();
    wallets.push({ agent: agent.name, address: privateKeyToAccount(privateKey).address.toLowerCase(), privateKey });
    made += 1;
  }
  if (made > 0) {
    // Written beside the file and moved over it, so a run that is cut off cannot leave half a file of keys.
    const draft = `${WALLETS_FILE}.new`;
    writeFileSync(draft, `${JSON.stringify({ wallets }, null, 2)}\n`, { mode: 0o600 });
    renameSync(draft, WALLETS_FILE);
  }
  return { wallets, made };
}

function reportWallets(agents, { wallets, made }) {
  const listed = agents.map((agent) => wallets.find((wallet) => wallet.agent === agent.name));
  console.log(`${listed.length} house wallets, ${made} of them new. The keys are in ${shownPath(WALLETS_FILE)},`);
  console.log('which git ignores. Keep that file: without it nobody can change these agents again.');
  console.log('');
  for (const wallet of listed) console.log(`  ${wallet.address}  ${wallet.agent}`);
  console.log('');
  console.log('The value of the Worker variable HOUSE_OWNERS:');
  console.log(listed.map((wallet) => wallet.address).join(','));
}

/** One request to the API. Returns the status, the parsed body and the cookies it set. */
async function request(origin, label, method, path, { body, cookie } = {}) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') {
    // A request that changes state must come from the site and say it is JSON, as a browser's does.
    headers.origin = origin;
    headers['content-type'] = 'application/json';
  }
  if (cookie) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  let response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Stop(`${label}: ${method} ${path} got no answer (${error instanceof Error ? error.name : 'error'}).`);
  }
  let json = null;
  try {
    const text = await response.text();
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, setCookies: response.headers.getSetCookie(), label, method, path };
}

/** Stops unless the answer has the expected status. Says what the API said, in the API's own words. */
function expectStatus(answer, status) {
  if (answer.status === status) return;
  const error = answer.json && typeof answer.json === 'object' ? answer.json.error : undefined;
  const said =
    error && typeof error.code === 'string'
      ? ` The API said ${error.code}: ${typeof error.message === 'string' ? error.message : ''}`
      : '';
  throw new Stop(
    `${answer.label}: ${answer.method} ${answer.path} answered ${answer.status}, not ${status}.${said}`.trim(),
  );
}

/** The value of the session cookie in a verify answer. It is used for this wallet's requests and never shown. */
function sessionOf(answer) {
  for (const line of answer.setCookies) {
    const [pair = ''] = line.split(';');
    const at = pair.indexOf('=');
    if (at > 0 && pair.slice(0, at).trim() === SESSION_COOKIE && pair.slice(at + 1).trim() !== '') {
      return pair.slice(at + 1).trim();
    }
  }
  throw new Stop(`${answer.label}: the sign-in set no session cookie.`);
}

/** An EIP-4361 message, line for line as the standard writes it and as the site's own sign-in builds it. */
function signInMessage({ domain, address, statement, uri, chainId, nonce, issuedAt }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    statement,
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

/** Signs one wallet in, creates its agent unless it has one, and signs it out. Returns what happened. */
async function createOne(origin, agent, wallet, privateKeyToAccount) {
  const label = agent.name;
  const account = privateKeyToAccount(wallet.privateKey);
  if (account.address.toLowerCase() !== wallet.address) {
    throw new Stop(`${label}: the address in ${shownPath(WALLETS_FILE)} does not belong to its key.`);
  }

  const nonce = await request(origin, label, 'GET', '/api/siwe/nonce');
  expectStatus(nonce, 200);
  const asked = nonce.json ?? {};
  // The wallet signs only a message for the origin it was pointed at, on the chain of Prix.
  if (asked.uri !== origin || asked.domain !== new URL(origin).host || asked.chainId !== CHAIN_ID) {
    throw new Stop(`${label}: the API at ${origin} asks for a sign-in to another site or chain. Nothing was signed.`);
  }
  if (typeof asked.nonce !== 'string' || typeof asked.statement !== 'string') {
    throw new Stop(`${label}: GET /api/siwe/nonce did not answer with a nonce and a statement.`);
  }
  const message = signInMessage({
    domain: asked.domain,
    address: account.address,
    statement: asked.statement,
    uri: asked.uri,
    chainId: asked.chainId,
    nonce: asked.nonce,
    issuedAt: new Date().toISOString(),
  });
  const signature = await account.signMessage({ message });
  const verified = await request(origin, label, 'POST', '/api/siwe/verify', { body: { message, signature } });
  expectStatus(verified, 200);
  const cookie = sessionOf(verified);

  const me = await request(origin, label, 'GET', '/api/me', { cookie });
  expectStatus(me, 200);
  if (typeof me.json?.address !== 'string' || me.json.address.toLowerCase() !== wallet.address) {
    throw new Stop(`${label}: GET /api/me answered for another wallet.`);
  }

  let outcome;
  const existing = me.json.agent;
  if (existing !== null && existing !== undefined) {
    if (existing.name !== agent.name) {
      throw new Stop(`${label}: its wallet already has another agent, "${existing.name}". Nothing was changed.`);
    }
    outcome = { state: 'kept', id: existing.id };
  } else {
    const created = await request(origin, label, 'POST', '/api/agents', {
      cookie,
      body: { name: agent.name, prompt: agent.prompt, division: agent.division },
    });
    expectStatus(created, 201);
    if (typeof created.json?.agent?.id !== 'string')
      throw new Stop(`${label}: POST /api/agents answered without an agent.`);
    outcome = { state: 'created', id: created.json.agent.id };
  }

  // The session is ended at once: nothing needs it any more.
  expectStatus(await request(origin, label, 'POST', '/api/siwe/logout', { cookie }), 204);
  return outcome;
}

async function createAgents(origin, agents, paceSeconds) {
  const { privateKeyToAccount } = loadAccounts();
  const wallets = readWallets();
  const missing = agents.filter((agent) => !wallets.some((wallet) => wallet.agent === agent.name));
  if (missing.length > 0) {
    throw new Stop(
      `No wallet for ${missing.map((agent) => agent.name).join(', ')}. Run with --wallets first, and put the addresses into HOUSE_OWNERS.`,
    );
  }
  console.log(`Creating ${agents.length} house agents at ${origin}, as their wallets would in a browser.`);
  let created = 0;
  let kept = 0;
  for (const [index, agent] of agents.entries()) {
    if (index > 0 && paceSeconds > 0) await new Promise((done) => setTimeout(done, paceSeconds * 1000));
    const wallet = wallets.find((entry) => entry.agent === agent.name);
    const outcome = await createOne(origin, agent, wallet, privateKeyToAccount);
    if (outcome.state === 'created') created += 1;
    else kept += 1;
    const what = outcome.state === 'created' ? 'created' : 'already there, left as it is';
    console.log(`  ${agent.name}: ${what}. ${origin}/agents/${outcome.id}`);
  }
  console.log(`Done: ${created} created, ${kept} already there.`);
}

async function main() {
  const args = readArgs();
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const origin = args.origin === undefined ? null : readOrigin(args.origin);
  const agents = readAgents();
  findKeys();
  if (args.wallets) await makeWallets(agents);
  if (origin !== null) {
    if (args.wallets) console.log('');
    await createAgents(origin, agents, args.pace);
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  // Only the text of a stop written in this file is printed. Anything else is named by its kind:
  // an error from deeper down could quote what it was given, and that could be a key.
  console.error(error instanceof Stop ? error.message : `Stopped: ${error instanceof Error ? error.name : 'error'}.`);
  if (error instanceof Stop) console.error('Stopped. Nothing further was changed. It is safe to run this again.');
  process.exit(1);
});
