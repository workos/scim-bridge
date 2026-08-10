# Contributing

Thanks for taking the time. This tool moves a company's employee directory
between two systems, so a bug here can leave a terminated employee with a live
account. That shapes everything below.

## Getting set up

```bash
git clone https://github.com/workos/scim-bridge.git
cd scim-bridge
npm install
npm test
```

`npm test` should pass on a clean checkout. If it doesn't, that's a bug worth an
issue on its own — say what OS and Node version you're on.

To see it working end to end with no WorkOS account and no real IdP:

```bash
docker build -t scim-bridge . && \
docker run -p 8080:8080 -e DEMO_MODE=true -e PANEL_AUTH_DISABLED=true scim-bridge
```

Then open <http://localhost:8080/panel>. The **Live state** tab drives a simulated
IdP, a simulated native application, and a mock WorkOS side by side, so you can
walk the whole migration without touching anything real.

The commands you'll use while working are in the
[Development](./README.md#development) section of the README — including how to
run the suite against Postgres, which CI does and which catches a class of bug
SQLite doesn't.

## Opening a pull request

1. **Branch from `main`.**
2. **Write the test first when you can, and always write one that fails without
   your change.** See below — this is the one thing we're strict about.
3. **Run the same checks CI runs**, so you find out on your machine and not
   twenty minutes later:

   ```bash
   npm run lint
   npm run format:check
   npm run typecheck
   npm run typecheck:gate
   npm test
   npm run build
   ```

4. **Say what changed for an operator** in the PR description, not just what
   changed in the code. If the answer is "nothing", say that too.

Title format is `area: Imperative summary` — for example
`proxy: Mirror a dual-write DELETE the native app reports already gone`. Areas in
use: `proxy`, `panel`, `listener`, `docs`, `ci`, `all`.

## Prove your test would fail

A test written alongside the code it tests has a habit of passing whether or not
the code is right. Before you open the PR, **break your change on purpose and
confirm the test goes red** — then say in the description which tests fired.

This is not ceremony. A guard that was never seen to fail is indistinguishable
from a guard that does nothing, and both look the same in a green build. Several
of the bugs in this repository's history were found exactly this way, and at
least one was *introduced* by a change whose adjacent behaviour was reviewed by
description instead of by mutation.

If you break your change and nothing goes red, that is the most useful thing you
can report. Write the test that kills it, and mention it.

## What we look for in review

- **Comments explain why, not what.** The code says what. If a line is subtle,
  the comment should say what goes wrong without it — ideally naming the failure
  it prevents.
- **Narrow conditions stay narrow.** If you special-case `DELETE` on a `404`,
  add the test that fails when someone later widens it to all 4xx.
- **A number an operator reads must be actionable.** A count that only ever grows
  trains people to ignore it, and then it hides the real thing when it appears.
- **No new dependency without a reason in the PR body.** This image runs inside
  customer infrastructure.

## Reporting a security issue

Please don't open a public issue. See [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT
License, the same as the rest of the project — see [LICENSE](./LICENSE).
