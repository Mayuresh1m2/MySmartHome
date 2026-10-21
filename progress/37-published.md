# 37: the repo is public

Owner's go-ahead: "let's publish the repo".

## Before pushing

- `CONTRIBUTING.md`: the project's philosophy (nothing inbound, local first, the model chooses and code acts, deny by
  default, per-person data stays private, cheap to run), local testing, observability, evidence in pull requests, and
  safety around real homes.
- README **Wishlist** (owner's ideas, no implementation): more assistants (Google Home), many more devices, an adapter
  marketplace, setup in minutes, outbound-traffic visibility, smaller hubs, more languages, announcements, a home
  dashboard, sleep-friendly.
- Journal index brought up to entry 36.
- Rescan of the new commits: account ID, skill ID, endpoint, email, home path, hostname, device brands → 0.

## Publish

```text
gh repo create Mayuresh1m2/MySmartHome --public → https://github.com/Mayuresh1m2/MySmartHome
git push -u origin hearth-setup:main             → * [new branch] hearth-setup -> main
git ls-remote origin                             → HEAD, refs/heads/main   (no backup branches, no refs/original)
gh repo view                                     → PUBLIC, default=main
```

Local only, never to be pushed: `backup/pre-email-rewrite`, `backup/pre-publish-scrub`, `refs/original/…`.
There is no LICENSE yet; until there is one, others can read the code but have no licence to reuse it.
