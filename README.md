# Backed

Backed keeps track of receipts, warranties and return deadlines. Photograph
a receipt, confirm the details it read, and the item's warranty end date and
return deadline are on file — with a reminder before either lapses.

- **Capture** — take a photo of a receipt (or enter the details by hand).
  Receipt OCR runs through the platform's LLM proxy, billed to your own AI
  grant, and prefills store, item name, purchase date and price.
- **Item cards** — each item holds the receipt photo, store, purchase date,
  price, category, warranty length, warranty end date, return deadline and
  an optional serial number.
- **Status list** — every item carries a color-coded status: Return window
  (open now), Warranty ending soon (within 30 days), Covered, or Expired.
  Search by name or store and filter to what's expiring.
- **Reminders** — 30 and 7 days before warranty expiration, and 3 days
  before the return deadline, the item appears in the Reminders section on
  Home.

## How it's put together

- **Sign-in** — the server verifies the platform-issued user token (an RS256
  JWT) on every request; visitors without an account can browse read-only.
- **Database** — the app's own Postgres database stores items in an `items`
  table (marked `staging:private`: receipts are personal data). Prices are
  integer cents; dates are `DATE` columns read in UTC.
- **Live API** — `/api/items` (list, create, detail, delete) and
  `/api/items/scan` (receipt OCR). Status and reminders are computed at read
  time, never stored.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme.

## Staging demo data

The `items` table is private, so a staging preview starts empty: open
`/?demo=1` (or `/item/900001?demo=1`) for read-only "Staging demo …" rows
covering every status and reminder, with dates computed relative to "now"
so the preview always shows the same picture.
