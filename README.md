# Recipe Costs

Import recipes, cost them with official Stats NZ average food prices (updated monthly) and the prices you pay, plan your week and build your shopping list.

Price data: Stats NZ Food Price Index selected weighted average prices, licensed under CC BY 4.0. Live supermarket price feeds are switched off (`LIVE = false`) until a permitted data source is available.

- `index.html` – the app (served by the Worker)
- `worker.js` – Cloudflare Worker: household data (D1), store lists, live product search, recipe import, hourly price refresh
- `schema.sql` – database tables
- `wrangler.jsonc` – Cloudflare configuration

Hosted free on Cloudflare Workers at https://recipe-costs.recipecosts-nz.workers.dev
