/**
 * Copyright 2019 The AMP HTML Authors. All Rights Reserved.
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

const colors = require('ansi-colors');
const file = require('gulp-file');
const fs = require('fs-extra');
const gulp = require('gulp');
const log = require('fancy-log');
const {
  bootstrapThirdPartyFrames,
  compileAllJs,
  compileCoreRuntime,
  compileJs,
  endBuildStep,
  maybeToEsmName,
  mkdirSync,
  printConfigHelp,
  printNobuildHelp,
  toPromise,
} = require('./helpers');
const {
  createCtrlcHandler,
  exitCtrlcHandler,
} = require('../common/ctrlcHandler');
const {
  displayLifecycleDebugging,
} = require('../compile/debug-compilation-lifecycle');
const {
  distNailgunPort,
  startNailgunServer,
  stopNailgunServer,
} = require('./nailgun');
const {buildExtensions, parseExtensionFlags} = require('./extension-helpers');
const {cleanupBuildDir} = require('../compile/compile');
const {compileCss, cssEntryPoints} = require('./css');
const {compileJison} = require('./compile-jison');
const {formatExtractedMessages} = require('../compile/log-messages');
const {maybeUpdatePackages} = require('./update-packages');
const {VERSION} = require('../compile/internal-version');

const {green, cyan} = colors;
const argv = require('minimist')(process.argv.slice(2));

/**
 * Files that must be built for amp-web-push
 */
const WEB_PUSH_PUBLISHER_FILES = [
  'amp-web-push-helper-frame',
  'amp-web-push-permission-dialog',
];

/**
 * Versions that must be built for amp-web-push
 */
const WEB_PUSH_PUBLISHER_VERSIONS = ['0.1'];

/**
 * Used while building the experiments page.
 */
const hostname = argv.hostname || 'cdn.ampproject.org';

/**
 * Prints a useful help message prior to the gulp dist task
 */
function printDistHelp() {
  let cmd = 'gulp dist';
  if (argv.fortesting) {
    cmd = cmd + ' --fortesting';
  }
  if (argv.single_pass) {
    cmd = cmd + ' --single_pass';
  }
  printConfigHelp(cmd);
  if (argv.single_pass) {
    log(
      green('Building all AMP extensions in'),
      cyan('single_pass'),
      green('mode.')
    );
  } else {
    parseExtensionFlags();
  }
}

/**
 * Perform the prerequisite steps before starting the minified build.
 * Used by `gulp` and `gulp dist`.
 *
 * @param {boolean} watch
 */
async function runPreDistSteps(watch) {
  cleanupBuildDir();
  await prebuild();
  await compileCss(watch);
  await compileJison();
  await copyCss();
  await copyParsers();
  await bootstrapThirdPartyFrames(watch, /* minify */ true);
  await startNailgunServer(distNailgunPort, /* detached */ false);
  displayLifecycleDebugging();
}

/**
 * Dist Build
 * @return {!Promise}
 */
async function dist() {
  maybeUpdatePackages();
  const handlerProcess = createCtrlcHandler('dist');
  process.env.NODE_ENV = 'production';
  printNobuildHelp();
  printDistHelp();

  await runPreDistSteps(argv.watch);

  // Steps that use closure compiler. Small ones before large (parallel) ones.
  if (argv.core_runtime_only) {
    await compileCoreRuntime(argv.watch, /* minify */ true);
  } else {
    await buildExperiments();
    await buildLoginDone('0.1');
    await buildWebPushPublisherFiles();
    await compileAllJs(/* minify */ true);
    await buildExtensions({minify: true, watch: argv.watch});
  }
  if (!argv.watch) {
    await stopNailgunServer(distNailgunPort);
  }

  if (!argv.core_runtime_only) {
    await formatExtractedMessages();
    await generateFileListing();
  }
  if (!argv.watch) {
    exitCtrlcHandler(handlerProcess);
  }
}

/**
 * Build AMP experiments.js.
 *
 * @return {!Promise}
 */
function buildExperiments() {
  return compileJs(
    './build/experiments/',
    'experiments.max.js',
    './dist.tools/experiments/',
    {
      watch: argv.watch,
      minify: true,
      includePolyfills: true,
      minifiedName: maybeToEsmName('experiments.js'),
      esmPassCompilation: argv.esm || false,
    }
  );
}

/**
 * Build amp-login-done-${version}.js file.
 *
 * @param {string} version
 * @return {!Promise}
 */
function buildLoginDone(version) {
  const buildDir = `build/all/amp-access-${version}/`;
  const builtName = `amp-login-done-${version}.max.js`;
  const minifiedName = `amp-login-done-${version}.js`;
  const latestName = 'amp-login-done-latest.js';
  return compileJs('./' + buildDir, builtName, './dist/v0/', {
    watch: argv.watch,
    includePolyfills: true,
    minify: true,
    minifiedName,
    latestName,
    esmPassCompilation: argv.esm || false,
    extraGlobs: [
      buildDir + 'amp-login-done-0.1.max.js',
      buildDir + 'amp-login-done-dialog.js',
    ],
  });
}

/**
 * Build amp-web-push publisher files HTML page.
 */
async function buildWebPushPublisherFiles() {
  const distDir = 'dist/v0';
  const promises = [];
  WEB_PUSH_PUBLISHER_VERSIONS.forEach((version) => {
    WEB_PUSH_PUBLISHER_FILES.forEach((fileName) => {
      const tempBuildDir = `build/all/amp-web-push-${version}/`;
      const builtName = fileName + '.js';
      const minifiedName = maybeToEsmName(fileName + '.js');
      const p = compileJs('./' + tempBuildDir, builtName, './' + distDir, {
        watch: argv.watch,
        includePolyfills: true,
        minify: true,
        esmPassCompilation: argv.esm || false,
        minifiedName,
        extraGlobs: [tempBuildDir + '*.js'],
      });
      promises.push(p);
    });
  });
  await Promise.all(promises);
  await postBuildWebPushPublisherFilesVersion();
}

async function prebuild() {
  await preBuildExperiments();
  await preBuildLoginDone();
  await preBuildWebPushPublisherFiles();
}

/**
 * Copies the css from the build folder to the dist folder
 * @return {!Promise}
 */
function copyCss() {
  const startTime = Date.now();

  cssEntryPoints.forEach(({outCss}) => {
    fs.copySync(`build/css/${outCss}`, `dist/${outCss}`);
  });

  return toPromise(
    gulp
      .src('build/css/amp-*.css', {base: 'build/css/'})
      .pipe(gulp.dest('dist/v0'))
  ).then(() => {
    endBuildStep('Copied', 'build/css/*.css to dist/v0/*.css', startTime);
  });
}

/**
 * Copies parsers from the build folder to the dist folder
 * @return {!Promise}
 */
function copyParsers() {
  const startTime = Date.now();
  return fs.copy('build/parsers', 'dist/v0').then(() => {
    endBuildStep('Copied', 'build/parsers/ to dist/v0', startTime);
  });
}

/**
 * Obtain a recursive file listing of a directory
 * @param {string} dest - Directory to be scanned
 * @return {Array} - All files found in directory
 */
async function walk(dest) {
  const filelist = [];
  const files = await fs.readdir(dest);

  for (let i = 0; i < files.length; i++) {
    const file = `${dest}/${files[i]}`;

    fs.statSync(file).isDirectory()
      ? Array.prototype.push.apply(filelist, await walk(file))
      : filelist.push(file);
  }

  return filelist;
}

/**
 * Generate a listing of all files in dist/ and save as dist/files.txt
 */
async function generateFileListing() {
  const startTime = Date.now();
  const distDir = 'dist';
  const filesOut = `${distDir}/files.txt`;
  fs.writeFileSync(filesOut, '');
  const files = (await walk(distDir)).map((f) => f.replace(`${distDir}/`, ''));
  fs.writeFileSync(filesOut, files.join('\n') + '\n');
  endBuildStep('Generated', filesOut, startTime);
}

/**
 * Build amp-web-push publisher files HTML page.
 *
 * @return {!Promise<!Array>}
 */
async function preBuildWebPushPublisherFiles() {
  mkdirSync('dist');
  mkdirSync('dist/v0');
  const promises = [];

  WEB_PUSH_PUBLISHER_VERSIONS.forEach((version) => {
    WEB_PUSH_PUBLISHER_FILES.forEach((fileName) => {
      const basePath = `extensions/amp-web-push/${version}/`;
      const tempBuildDir = `build/all/amp-web-push-${version}/`;

      // Build Helper Frame JS
      const js = fs.readFileSync(basePath + fileName + '.js', 'utf8');
      const builtName = fileName + '.js';
      const promise = toPromise(
        gulp
          .src(basePath + '/*.js', {base: basePath})
          .pipe(file(builtName, js))
          .pipe(gulp.dest(tempBuildDir))
      );
      promises.push(promise);
    });
  });
  return Promise.all(promises);
}

/**
 * post Build amp-web-push publisher files HTML page.
 */
function postBuildWebPushPublisherFilesVersion() {
  const distDir = 'dist/v0';
  WEB_PUSH_PUBLISHER_VERSIONS.forEach((version) => {
    const basePath = `extensions/amp-web-push/${version}/`;
    WEB_PUSH_PUBLISHER_FILES.forEach((fileName) => {
      const minifiedName = maybeToEsmName(fileName + '.js');
      if (!fs.existsSync(distDir + '/' + minifiedName)) {
        throw new Error(`Cannot find ${distDir}/${minifiedName}`);
      }

      // Build Helper Frame HTML
      let fileContents = fs.readFileSync(basePath + fileName + '.html', 'utf8');
      fileContents = fileContents.replace(
        '<!-- [GULP-MAGIC-REPLACE ' + fileName + '.js] -->',
        '<script>' +
          fs.readFileSync(distDir + '/' + minifiedName, 'utf8') +
          '</script>'
      );

      fs.writeFileSync('dist/v0/' + fileName + '.html', fileContents);
    });
  });
}

/**
 * Precompilation steps required to build experiment js binaries.
 * @return {!Promise}
 */
async function preBuildExperiments() {
  const path = 'tools/experiments';
  const htmlPath = path + '/experiments.html';
  const jsPath = path + '/experiments.js';

  // Build HTML.
  const html = fs.readFileSync(htmlPath, 'utf8');
  const minHtml = html
    .replace(
      '/dist.tools/experiments/experiments.js',
      `https://${hostname}/v0/experiments.js`
    )
    .replace(/\$internalRuntimeVersion\$/g, VERSION);

  await toPromise(
    gulp
      .src(htmlPath)
      .pipe(file('experiments.cdn.html', minHtml))
      .pipe(gulp.dest('dist.tools/experiments/'))
  );

  // Build JS.
  const js = fs.readFileSync(jsPath, 'utf8');
  const builtName = 'experiments.max.js';
  return toPromise(
    gulp
      .src(path + '/*.js')
      .pipe(file(builtName, js))
      .pipe(gulp.dest('build/experiments/'))
  );
}

/**
 * Build "Login Done" page.
 * @return {!Promise}
 */
function preBuildLoginDone() {
  return preBuildLoginDoneVersion('0.1');
}

/**
 * Build "Login Done" page for the specified version.
 *
 * @param {string} version
 * @return {!Promise}
 */
function preBuildLoginDoneVersion(version) {
  const path = `extensions/amp-access/${version}/`;
  const buildDir = `build/all/amp-access-${version}/`;
  const htmlPath = path + 'amp-login-done.html';
  const jsPath = path + 'amp-login-done.js';

  // Build HTML.
  const html = fs.readFileSync(htmlPath, 'utf8');
  const minJs = `https://${hostname}/v0/amp-login-done-${version}.js`;
  const minHtml = html
    .replace(`../../../dist/v0/amp-login-done-${version}.max.js`, minJs)
    .replace(`../../../dist/v0/amp-login-done-${version}.js`, minJs);
  if (minHtml.indexOf(minJs) == -1) {
    throw new Error('Failed to correctly set JS in login-done.html');
  }

  mkdirSync('dist');
  mkdirSync('dist/v0');

  fs.writeFileSync('dist/v0/amp-login-done-' + version + '.html', minHtml);

  // Build JS.
  const js = fs.readFileSync(jsPath, 'utf8');
  const builtName = 'amp-login-done-' + version + '.max.js';
  return toPromise(
    gulp
      .src(path + '/*.js', {base: path})
      .pipe(file(builtName, js))
      .pipe(gulp.dest(buildDir))
  );
}

module.exports = {
  dist,
  runPreDistSteps,
};

/* eslint "google-camelcase/google-camelcase": 0 */

dist.description =
  'Compiles AMP production binaries and applies AMP_CONFIG to runtime files';
dist.flags = {
  pseudo_names:
    '  Compiles with readable names. ' +
    'Great for profiling and debugging production code.',
  pretty_print:
    '  Outputs compiled code with whitespace. ' +
    'Great for debugging production code.',
  fortesting: '  Compiles production binaries for local testing',
  noconfig: '  Compiles production binaries without applying AMP_CONFIG',
  config: '  Sets the runtime\'s AMP_CONFIG to one of "prod" or "canary"',
  single_pass: "Compile AMP's primary JS bundles in a single invocation",
  extensions: '  Builds only the listed extensions.',
  extensions_from: '  Builds only the extensions from the listed AMP(s).',
  noextensions: '  Builds with no extensions.',
  core_runtime_only: '  Builds only the core runtime.',
  single_pass_dest:
    '  The directory closure compiler will write out to ' +
    'with --single_pass mode. The default directory is `dist`',
  full_sourcemaps: '  Includes source code content in sourcemaps',
  disable_nailgun:
    "  Doesn't use nailgun to invoke closure compiler (much slower)",
  sourcemap_url: '  Sets a custom sourcemap URL with placeholder {version}',
  type: '  Points sourcemap to fetch files from the correct GitHub tag',
  esm: '  Does not transpile down to ES5',
  version_override: '  Override the version written to AMP_CONFIG',
  custom_version_mark: '  Set final digit (0-9) on auto-generated version',
  watch: '  Watches for changes in files, re-compiles when detected',
  closure_concurrency: '  Sets the number of concurrent invocations of closure',
  debug: '  Outputs the file contents during compilation lifecycles',
  define_experiment_constant:
    '  Builds runtime with the EXPERIMENT constant set to true',
};
