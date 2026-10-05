# Backed — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## About Backed

Backed keeps track of receipts, warranties and return deadlines. The core
workflow: photograph a receipt, OCR (through the platform LLM proxy) prefills
store, item name, purchase date and price, the user confirms on one screen
(correct anything wrong, pick a category, approve the suggested warranty
length) and saves an item card. The item list carries a color-coded status
per item — Return window, Warranty ending soon, Covered, Expired — plus
search, an "Expiring soon" filter, and fixed-schedule reminders (30 and 7
days before warranty expiration, 3 days before the return deadline),
delivered in-app: a Reminders section on Home and a line on the item detail.

MVP scope decisions made with the user: one receipt creates one item card;
reminders are in-app only (no notification channel exists on the platform);
export, product manuals, per-item reminder configuration and editing an item
after save are deferred.

## Design

- **Palette:** accent teal (stone-warm neutrals; `warn` amber is the one
  "act soon" colour). Token values live in `styles/tailwind-input.css`.
- **Signature element:** the status chip and receipt thumbnail on each item
  row — the colored badge that tells you at a glance what's still covered.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  (unchanged from the kit; do not add sizes).

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `chip`, `skeleton`, `state-empty`, `state-error`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, `bg-warn` with `text-on-warn`, ...): never a raw hex
  value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Statuses use fixed chip pairs: `bg-accent text-on-accent` (Return window),
  `bg-warn text-on-warn` (Warranty ending soon), `bg-accent/10 text-accent`
  (Covered), `bg-raised text-muted` (Expired).
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- **The `items` table is `staging:private`** — receipts, prices and serial
  numbers are personal purchase data. Staging starts with an empty table;
  demo state is request-time only, behind `?demo=1` (see the demo block in
  `server.js`), never boot-seeded and never attributed to the visitor.
- **Money is integer cents** (`price_cents`), never floats.
- **The app reasons about dates in UTC.** Day arithmetic runs on
  `YYYY-MM-DD` strings; date columns are read as text (`::text`) so no
  timezone shifts a deadline by a day. "Now" is `req.now` on the server and
  `usernode.now()` in the page, never `new Date()` or SQL's `NOW()`.
- **Status is computed at read time**, never stored: return window open →
  return-window; warranty ended → expired; ends within 30 days →
  expiring-soon; else covered. Reminders fire on exact day-counts only
  (30, 7, 0 for warranty; 3, 0 for returns).
- **Receipt photos are stored platform-side** (`usernode.uploadFile`,
  `visibility: 'private'`); the DB keeps only `receipt_url` +
  `receipt_file_id`, never image bytes.
- **No new npm dependencies** unless a request truly needs one.

