#!/usr/bin/env bash
# Resolve one PR to a remotely addressable merge of pinned main/head inputs.
set -euo pipefail

fail() { echo "::error title=pull request::$*" >&2; exit 1; }
pr="${1:-}"
[[ "$pr" =~ ^[1-9][0-9]*$ ]] || fail 'give a positive PR number'
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

# The PR's cached mergeability does not prove its candidate includes main.
# Pin main independently; later pushes require another dispatch.
base="$(gh api "repos/$repository/git/ref/heads/main" --jq '.object.sha')"
[[ "$base" =~ ^[0-9a-f]{40}$ ]] || fail "main returned an invalid SHA: $base"
fields=state,baseRefName,headRefOid,isCrossRepository,mergeable,potentialMergeCommit
pr_json="$(gh pr view "$pr" --repo "$repository" --json "$fields")"
head="$(jq -r '.headRefOid' <<<"$pr_json")"
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || fail "#$pr returned an invalid head SHA: $head"

for attempt in 1 2 3 4 5; do
  state="$(jq -r '.state' <<<"$pr_json")"
  target="$(jq -r '.baseRefName' <<<"$pr_json")"
  current_head="$(jq -r '.headRefOid' <<<"$pr_json")"
  [ "$state" = 'OPEN' ] || fail "#$pr is $state, not open"
  [ "$target" = 'main' ] || fail "#$pr targets $target, not main"
  [ "$current_head" = "$head" ] || fail "#$pr head changed from $head to $current_head; re-dispatch"

  mergeable="$(jq -r '.mergeable' <<<"$pr_json")"
  sha="$(jq -r '.potentialMergeCommit.oid // empty' <<<"$pr_json")"
  [ "$mergeable" != 'CONFLICTING' ] || fail "#$pr conflicts with main; resolve and re-dispatch"
  parents=''
  if [ "$mergeable" = 'MERGEABLE' ] && [ -n "$sha" ]; then
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "#$pr returned an invalid merge SHA: $sha"
    parents="$(gh api "repos/$repository/git/commits/$sha" --jq '[.parents[].sha] | join(" ")')"
    # Equality also refuses missing, reversed or additional parents.
    if [ "$parents" = "$base $head" ]; then
      fork="$(jq -r '.isCrossRepository' <<<"$pr_json")"
      echo "PR #$pr ($([ "$fork" = 'true' ] && echo fork || echo same-repo)) main is $base; head is $head; deploying merge $sha"
      printf 'sha=%s\n' "$sha" >> "$GITHUB_OUTPUT"
      exit 0
    fi
  fi
  if [ "$attempt" -lt 5 ]; then
    sleep 5
    pr_json="$(gh pr view "$pr" --repo "$repository" --json "$fields")"
  fi
done

fail "#$pr has no current merge after 5 attempts: expected parents [$base $head], got [${parents:-none}] for ${sha:-none} (mergeable=$mergeable); re-dispatch"
