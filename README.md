# Recipe Costs

Import recipes, cost them with live prices from your local Pak'nSave and New World, plan your week, and shop the cheapest way.

- `index.html` – the app (served by the Worker)
- `worker.js` – Cloudflare Worker: household data (D1), store lists, live product search, recipe import, hourly price refresh
- `schema.sql` – database tables
- `wrangler.jsonc` – Cloudflare configuration

Hosted free on Cloudflare Workers at https://recipe-costs.recipecosts-nz.workers.dev
