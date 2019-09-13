/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const argv = require('minimist')(process.argv.slice(2));
const BBPromise = require('bluebird');
const brotliSize = require('brotli-size');
const colors = require('ansi-colors');
const fs = require('fs');
const log = require('fancy-log');
const path = require('path');
const requestPost = BBPromise.promisify(require('request').post);
const url = require('url');
const {
  isTravisPullRequestBuild,
  isTravisPushBuild,
  travisRepoSlug,
} = require('../travis');
const {getStdout} = require('../exec');
const {gitCommitHash, gitTravisMasterBaseline, shortSha} = require('../git');
const {VERSION: internalRuntimeVersion} = require('../internal-version');

const runtimeFile = './dist/v0.js';
const normalizedRtvNumber = '1234567890123';

const expectedGitHubRepoSlug = 'ampproject/amphtml';
const bundleSizeAppBaseUrl = 'https://amp-bundle-size-bot.appspot.com/v0/';

const {red, cyan, yellow} = colors;

/**
 * Get the gzipped bundle size of the current build.
 *
 * @return {string} the bundle size in KB rounded to 2 decimal points.
 */
function getGzippedBundleSize() {
  const cmd = `npx bundlesize -f "${runtimeFile}"`;
  log('Running', cyan(cmd) + '...');
  const output = getStdout(cmd).trim();

  const bundleSizeOutputMatches = output.match(/PASS .*: (\d+.?\d*KB) .*/);
  if (bundleSizeOutputMatches) {
    const bundleSize = parseFloat(bundleSizeOutputMatches[1]);
    log('Bundle size', cyan('(gzipped)'), 'is', cyan(`${bundleSize}KB`));
    return bundleSize;
  }
  throw Error('could not infer bundle size from output.');
}

/**
 * Get the brotli bundle size of the current build.
 *
 * @return {string} the bundle size in KB rounded to 2 decimal points.
 */
function getBrotliBundleSize() {
  // Brotli compressed size fluctuates because of changes in the RTV number, so
  // normalize this across pull requests by replacing that RTV with a constant.
  const normalizedFileContents = fs
    .readFileSync(runtimeFile, 'utf8')
    .replace(new RegExp(internalRuntimeVersion, 'g'), normalizedRtvNumber);
  const bundleSize = parseFloat(
    (brotliSize.sync(normalizedFileContents) / 1024).toFixed(2)
  );
  log('Bundle size', cyan('(brotli)'), 'is', cyan(`${bundleSize}KB`));
  return bundleSize;
}

/**
 * Store the bundle size of a commit hash in the build artifacts storage
 * repository to the passed value.
 */
async function storeBundleSize() {
  if (!isTravisPushBuild()) {
    log(
      yellow('Skipping'),
      cyan('--on_push_build') + ':',
      'this action can only be performed on `push` builds on Travis'
    );
    return;
  }

  if (travisRepoSlug() !== expectedGitHubRepoSlug) {
    log(
      yellow('Skipping'),
      cyan('--on_push_build') + ':',
      'this action can only be performed on Travis builds on the',
      cyan(expectedGitHubRepoSlug),
      'repository'
    );
    return;
  }

  const commitHash = gitCommitHash();
  try {
    const response = await requestPost({
      uri: url.resolve(
        bundleSizeAppBaseUrl,
        path.join('commit', commitHash, 'report')
      ),
      json: true,
      body: {
        token: process.env.BUNDLE_SIZE_TOKEN,
        // TODO(#21275): replace the gzippedBundleSize value once the
        // bundle-size app prefers Brotli.
        gzippedBundleSize: `${getGzippedBundleSize()}KB`,
        brotliBundleSize: `${getBrotliBundleSize()}KB`,
      },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `${response.statusCode} ${response.statusMessage}: ` + response.body
      );
    }
  } catch (error) {
    log(red('Could not store the bundle size'));
    log(red(error));
    process.exitCode = 1;
    return;
  }
}

/**
 * Mark a pull request on Travis as skipped, via the AMP bundle-size GitHub App.
 */
async function skipBundleSize() {
  if (isTravisPullRequestBuild()) {
    const commitHash = gitCommitHash();
    try {
      const response = await requestPost(
        url.resolve(
          bundleSizeAppBaseUrl,
          path.join('commit', commitHash, 'skip')
        )
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(
          `${response.statusCode} ${response.statusMessage}: ` + response.body
        );
      }
    } catch (error) {
      log(red('Could not report a skipped pull request'));
      log(red(error));
      process.exitCode = 1;
      return;
    }
  } else {
    log(
      yellow(
        'Not marking this pull request to skip because that can only be ' +
          'done on Travis'
      )
    );
  }
}

/**
 * Report the size to the bundle-size GitHub App, to determine size changes.
 */
async function reportBundleSize() {
  if (isTravisPullRequestBuild()) {
    const baseSha = gitTravisMasterBaseline();
    // TODO(#21275): remove gzipped reporting within ~1 month.
    const gzippedBundleSize = getGzippedBundleSize();
    const brotliBundleSize = getBrotliBundleSize();
    const commitHash = gitCommitHash();
    try {
      const response = await requestPost({
        uri: url.resolve(
          bundleSizeAppBaseUrl,
          path.join('commit', commitHash, 'report')
        ),
        json: true,
        body: {
          baseSha,
          // TODO(#21275): replace the default bundleSize value from the gzipped
          // to the brotli value, once the bundle-size app prefers those.
          bundleSize: gzippedBundleSize,
          gzippedBundleSize,
          brotliBundleSize,
        },
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(
          `${response.statusCode} ${response.statusMessage}: ` + response.body
        );
      }
    } catch (error) {
      log(red('Could not report the bundle size of this pull request'));
      log(red(error));
      process.exitCode = 1;
      return;
    }
  } else {
    log(
      yellow(
        'Not reporting the bundle size of this pull request because ' +
          'that can only be done on Travis'
      )
    );
  }
}

function getLocalBundleSize() {
  if (!fs.existsSync(runtimeFile)) {
    log('Could not find', cyan(runtimeFile) + '.');
    log('Run', cyan('gulp dist --noextensions'), 'and re-run this task.');
    return;
  } else {
    log(
      'Computing bundle size for version',
      cyan(internalRuntimeVersion),
      'at commit',
      cyan(shortSha(gitCommitHash())) + '.'
    );
  }
  getGzippedBundleSize();
  getBrotliBundleSize();
}

async function bundleSize() {
  if (argv.on_skipped_build) {
    return await skipBundleSize();
  } else if (argv.on_push_build) {
    return await storeBundleSize();
  } else if (argv.on_pr_build) {
    return await reportBundleSize();
  } else if (argv.on_local_build) {
    return getLocalBundleSize();
  } else {
    log(red('Called'), cyan('gulp bundle-size'), red('with no task.'));
    process.exitCode = 1;
  }
}

module.exports = {
  bundleSize,
};

bundleSize.description =
  'Checks if the minified AMP binary has exceeded its size cap';
bundleSize.flags = {
  'on_push_build':
    '  Store bundle size in AMP build artifacts repo ' +
    '(also implies --on_pr_build)',
  'on_pr_build': '  Report the bundle size of this pull request to GitHub',
  'on_skipped_build':
    "  Set the status of this pull request's bundle " +
    'size check in GitHub to `skipped`',
  'on_local_build': '  Compute the bundle size of the locally built runtime',
};
