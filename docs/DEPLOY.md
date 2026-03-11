# Docs site deployment (docs.neurosim.fun)

## Rollout

1. **DNS / Cloudflare**
   - Add CNAME or ALIAS record for `docs.neurosim.fun` pointing to the Pages/Workers host (or Cloudflare Workers custom domain target).
   - Validate TLS is issued for the domain.
   - Update zone if needed so `docs.neurosim.fun` resolves correctly.

2. **Wrangler route**
   - `wrangler.jsonc` has `"routes": [{ "pattern": "docs.neurosim.fun", "custom_domain": true }]`.
   - Run `npm run docs:deploy` (builds and deploys via wrangler).

3. **Validation**
   - After deployment: verify `https://docs.neurosim.fun` loads.
   - Check DNS propagation if needed.
   - Confirm TLS cert is valid.

## Rollback

1. Revert the route in `wrangler.jsonc` or remove the custom domain from Cloudflare.
2. Revert DNS changes (remove or point CNAME elsewhere).
3. Redeploy a previous version if necessary.
4. Invalidate caches if applicable.
