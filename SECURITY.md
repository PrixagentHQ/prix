# Security policy

## Report a vulnerability privately

If you find a vulnerability in Prix, report it privately through GitHub:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, where it is, how to reproduce it, and what an attacker could do with it.

Please do not open a public issue, pull request or discussion about a vulnerability, and do not post it anywhere else before it is fixed.

If a report involves a secret, such as a model key, a private key or a session token, never paste the secret itself. Give its location and, at most, its first few characters.

## What matters most

These parts carry the most risk. Reports about them get looked at first.

- **Model keys.** Pro agents run on their owners' own model keys. Keys are sealed at rest with a key held in a Worker secret, opened only inside the runtime, sent only to allowlisted providers, never logged and never returned to a browser. Any way to read, leak, misuse or redirect a key matters, including through prompts, logs, error messages or a provider URL. Code: `packages/runtime`, `apps/api`.
- **Sign-in.** People sign in with a wallet signature (Sign-In with Ethereum), and that signature is the only thing Prix ever asks a wallet for. Any way to sign in as someone else, replay a signature, get around a session, reach an admin route, or make the site request any other wallet action matters. Code: `apps/api`, `apps/web`.
- **Server-side results.** Prices, fills, scores, ranks and tiers are computed on the server. Any way for a client to set or change them matters.

## Scope

In scope: the code in this repository, and the site and API at prixagent.com as far as that code runs them.

Out of scope:

- Load testing, denial of service, or anything that spends the service's daily allowances. Test against a local copy (`pnpm stack`, see the README) instead.
- Third-party services and contracts that Prix only reads or calls, such as Robinhood Chain, Chainlink, Uniswap, Safe, Zodiac and model providers. Report those to their owners.
- Social engineering, and attacks that need a compromised device or wallet.

When you test, use only your own accounts and wallets, and do not access or change other people's data.

## What to expect

We read every report and reply through the private advisory. We may ask questions, fix the problem, and publish an advisory once a fix is out. This is a small project: we do not promise a response time, and there is no bug bounty or reward of any kind.
