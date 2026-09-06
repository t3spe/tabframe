# WP9.10 — The leak audit

**Status:** done 2026-09-06.

## What

One pass over the whole repository, working tree and every commit, for anything that should not be
public: credentials, account identifiers, endpoints and tokens, presigned URLs, and personal data.
The public page's CloudFront domain is fine; anything that names or opens the AWS account is not.

## How

A script scanned every tracked text file and then every blob that ever existed in the history
(3131 of them) plus every commit message, for: access-key shapes, secret-key variable names,
12-digit numbers and ARNs carrying them, email addresses, MicroVM endpoints and ids, Lambda
function URLs, presigned-URL fragments, JWE-shaped tokens, private-key headers, IP addresses,
home-directory paths, bucket-shaped names, secret-like assignments, and the operator's own list of
personal words. The account id, the budget address, and the operator's IAM identifiers were
compared as exact strings, never printed. The six tracked screenshots were viewed. The author
identities of all 306 commits were listed.

## Found

- No credential, token, presigned URL, account id, bucket name, budget address, or personal word,
  in the tree or in any commit. Every 12-digit number is a placeholder (`000000000000`,
  `123456789012`) or a fragment of a hash. Every email is `example.invalid` or GitHub's noreply.
- Three identifiers that are internal rather than secret, all fixed in the tree: a test fixture
  that used a real IAM unique id where a synthetic one does the same job; a scaffold note that
  showed the last four digits of the account id the way the operator scripts mask it; and a local
  filesystem path in the extraction note.
- The commits stay signed by the repository's GitHub identity throughout; the first commit carries
  the account's display name, as GitHub wrote it.

## Verified

- `bun test ./packages/fleet/test/mask.test.ts` and the link test pass.
- The scan over the tree reports nothing but placeholders and documentation of the masking rules.
