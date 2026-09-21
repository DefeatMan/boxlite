/*
 * The one dispatch, and the only one: `mdeploy-all.yml` is how a stage is
 * rolled out, and `mdeploy.yml` and `mrunner.yml` are gone into it.
 *
 * What it owns is not work but sequence, and the two mistakes a sequence makes
 * are invisible in a diff: a job that changes something before the reads that
 * decide whether it should, and a dependency that skips its dependents when it
 * had nothing to do. Both are asserted here as ordering rather than presence.
 *
 * The third thing it owns is which line a run is on. A commit rollout builds
 * for dev; a release rollout moves the bytes a version was cut from, and is the
 * only thing prod accepts.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const workflow = readFileSync(
  fileURLToPath(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url)),
  'utf8',
)

/** What the jobs run, with the commentary that discusses them removed. */
const commands = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const jobAt = (name: string) => {
  const start = commands.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `there is no ${name} job`)
  const rest = commands.slice(start + 1)
  const next = rest.search(/\n {2}[a-z][a-z-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next)
}

/** Every job that acts on the answer the plan gave. */
const ACTING = ['release-publish', 'release-promote', 'build-images', 'build-runner', 'deploy']

test('everything that decides is a read, and every read comes first', () => {
  // The plan asks two questions and answers four ways; nothing it runs changes
  // anything, which is what makes it safe to run before the confirm gates below.
  const plan = jobAt('plan')
  assert.match(plan, /mbuild verify/, 'the images are not asked about')
  assert.match(plan, /runner:build -- --stage "\$STAGE" --check/, 'the runner is asked about by building it')
  assert.doesNotMatch(plan, /mbuild publish|mbuild promote|npm run mdeploy/, 'the plan must not change anything')

  for (const job of ACTING) {
    assert.match(jobAt(job), /needs: \[[^\]]*plan[^\]]*\]/, `${job} runs without a plan`)
  }
})

test('the ref is refused before a single Environment is bound', () => {
  /*
   * Every refusal about the ref — a shape that is neither a tag nor a commit, a
   * commit aimed at prod, a tag nobody released — is about this repository's
   * own refs. A job that bound a stage's Environment to ask them would cost an
   * approval before the run could say the input was a typo.
   */
  const resolve = jobAt('resolve')
  assert.doesNotMatch(resolve, /^ {4}environment:/m, 'a typo must not cost an approval to report')
  assert.match(resolve, /gh release view/, 'a tag is taken as a release')
  for (const job of ACTING) {
    assert.match(jobAt(job), /needs: \[[^\]]*resolve[^\]]*\]/, `${job} acts on a ref nothing resolved`)
  }
})

test('each component takes exactly one of the plan’s answers', () => {
  // The three image routes are the same artifact by three means; a component
  // that could take two would publish over what it had just promoted.
  assert.match(jobAt('release-publish'), /needs\.plan\.outputs\.api == 'release-publish'/)
  assert.match(jobAt('release-promote'), /needs\.plan\.outputs\.api == 'release-promote'/)
  assert.match(jobAt('build-images'), /needs\.plan\.outputs\.api == 'build'/)
  assert.match(jobAt('build-runner'), /needs\.plan\.outputs\.runner == 'build'/)
})

test('the release line goes through the workflow that refuses a version twice', () => {
  // `mbuild.yml` skips an artifact already in the registry, which is right for
  // a commit and wrong for a release. Both release routes call the workflow
  // that refuses instead, and the commit route is the only caller of the other.
  assert.match(jobAt('release-publish'), /uses: \.\/\.github\/workflows\/mbuild-release\.yml/)
  assert.match(jobAt('release-promote'), /uses: \.\/\.github\/workflows\/mbuild-release\.yml/)
  assert.match(jobAt('build-images'), /uses: \.\/\.github\/workflows\/mbuild\.yml/)
  // And each is handed the version it is about, plus the commit this run
  // already resolved it to — mbuild-release compares the two rather than
  // resolving the tag a second time and hoping they agree.
  for (const job of ['release-publish', 'release-promote']) {
    assert.match(jobAt(job), /tag: \$\{\{ needs\.resolve\.outputs\.version \}\}/, `${job} names no version`)
    assert.match(jobAt(job), /sha: \$\{\{ needs\.resolve\.outputs\.sha \}\}/, `${job} hands over no commit to agree on`)
  }
})

test('prod deploys released versions and refuses a bare commit', () => {
  /*
   * The property the release line exists for. Written as a refusal on the
   * absence of a version rather than as a test naming prod, so a stage added to
   * the choice list later has to say for itself that a commit may reach it.
   */
  const classify = jobAt('resolve')
  assert.match(classify, /if \[ "\$STAGE" != 'dev' \] && \[ -z "\$version" \]; then/)
  assert.doesNotMatch(classify, /"\$STAGE" = 'prod'/, 'a deny-list on prod admits the next stage silently')
  // And the plan routes dev to the cut and everything else to the move.
  assert.match(jobAt('plan'), /\[ "\$STAGE" = 'dev' \] && echo release-publish \|\| echo release-promote/)
})

test('an image address carries the version when there is one', () => {
  // A release build and a commit build of one commit are different bytes, so
  // they are different addresses; prod can be narrowed to the release line only
  // because of that. Composed once, in the job that resolved the ref.
  assert.match(jobAt('resolve'), /printf 'image=%s\\n' "\$\{VERSION:\+\$\{VERSION\}-\}\$\{SHA\}"/)
  assert.match(jobAt('plan'), /mbuild verify -- --tag "\$IMAGE_TAG"/, 'the plan asks about a different address')
  assert.match(jobAt('deploy'), /BOXLITE_IMAGE_TAG=%s\\n' "\$IMAGE_TAG"/, 'the apply installs a different address')
})

test('a stage that already holds everything still deploys', () => {
  /*
   * The whole point of the plan: when nothing has to be built, every artifact
   * job is skipped — and a skipped dependency skips its dependents unless the
   * condition says otherwise. Without this the common case, redeploying a ref a
   * stage already holds, would silently do nothing.
   */
  const deploy = jobAt('deploy')
  for (const job of ACTING.filter((name) => name !== 'deploy')) {
    assert.match(deploy, new RegExp(`needs: \\[[^\\]]*${job}[^\\]]*\\]`), `the deploy does not wait for ${job}`)
  }
  assert.match(deploy, /!cancelled\(\) && !failure\(\)/, 'a skipped artifact job would skip the deploy')
})
