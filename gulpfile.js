/*eslint-env node */
"use strict";

// npm install --save-dev gulp gulp-util chalk gulp-replace-task gulp-cleanhtml gulp-strip-debug gulp-concat gulp-uglify gulp-rm gulp-zip gulp-eslint through2 gulp-minify-css gulp-load-plugins chai gulp-mocha sinon sinon-chai jsdom

var chalk = require('chalk');
var cleanhtml = require('gulp-cleanhtml');
var concat = require('gulp-concat');
var eslint = require('gulp-eslint');
var gulp = require('gulp');
var gulpUtil = require('gulp-util');
var minifyCSS = require('gulp-minify-css');
var mocha = require('gulp-spawn-mocha');
var replace = require('gulp-replace-task');
var rm = require('gulp-rm');
var stripdebug = require('gulp-strip-debug');
var uglify = require('gulp-uglify');
var zip = require('gulp-zip');
var argv = require('yargs').argv;

// this can be used to debug gulp runs
// .pipe(debug({verbose: true}))
/*eslint-disable no-unused-vars */
var debug = require('gulp-debug');
/*eslint-enable no-unused-vars */

// Small webserver for testing with protractor
var connect = require('gulp-connect');

// End to End testing
var protractor = require("gulp-protractor").protractor;
var webdriverUpdate = require('gulp-protractor').webdriver_update;

// Load the manifest as JSON
var manifest = require('./src/manifest');

// The final .zip filename that gets uploaded to https://chrome.google.com/webstore/developer/dashboard
var distFilename = manifest.name.replace(/[ ]/g, "_").toLowerCase() + "-v-" + manifest.version + ".zip";

// Configuration for the testserver
var serverConfig = {
  port: 8888,
  root: "testcases/docroot-for-testing"
};

var serverConfigIntegration = {
  port: 8889,
  root: "testcases/docroot-for-testing"
};

//
// Replacements config for gulp-replace
//
// 1.  Sets debug: false (in utils.js)
// 2.  Removes Logger statements
// 3.  Remove everything in .js files between "// REMOVE START" and "REMOVE END"
//     These blocks contain development code that gets optimized away
// 4.  Remove everything in .html files between "<!-- REMOVE START" and "REMOVE END -->"
//     These blocks contain development code that gets optimized away
// 5.  Activate blocks between "<!-- BUILD START" and "BUILD END -->"
//     These contain the optimized files for the final build
// 6.  Remove the "js:" array from the manifest
//     These blocks contain development code that gets optimized away
// 7.  Remove the "scripts:" array from the manifest
//     These blocks contain development code that gets optimized away
// 8.  Rename the "jsBuild" part in the manifest to be the "js" part
//     These contain the optimized files for the final build
// 9.  Rename the "scriptsBuild" part in the manifest to be the "scripts" part
//     These contain the optimized files for the final build
// 10. Replace ##VERSION## with the correct version string from the manifest
var replaceOpts = {
  preserveOrder: true,
  patterns: [
    {
      match: /debug\s*:\s*true,/g,
      replacement: "debug: false,"
    },
    {
      match: /.*Logger.*/g,
      replacement: ""
    },
    {
      match: /^.*\/\/ REMOVE START[\s\S]*?\/\/ REMOVE END.*$/gm,
      replacement: ""
    },
    {
      match: /<!-- REMOVE START[\s\S]*?REMOVE END -->/gm,
      replacement: ""
    },
    {
      match: /<!-- BUILD START/g,
      replacement: ""
    },
    {
      match: /BUILD END -->/g,
      replacement: ""
    },
    {
      match: /^.*"js":[\s\S]*?\],.*$/gm,
      replacement: ""
    },
    {
      match: /^.*"scripts"[\s\S]*?\],.*$/gm,
      replacement: ""
    },
    {
      match: /"jsBuild"/g,
      replacement: "\"js\""
    },
    {
      match: /"scriptsBuild"/g,
      replacement: "\"scripts\""
    },
    {
      match: /##VERSION##/g,
      replacement: manifest.version
    }
  ]
};

var runTests = function() {
 return gulp.src(['test/**/*_spec.js'], {read: false}).pipe(mocha({
    R: 'dot',
    c: true,
    debug: true
  })).on('error', console.warn.bind(console));
};

// Output which version to build where to
gulp.task('announce', function() {
  gulpUtil.log(
    'Building version', chalk.cyan(manifest.version),
    'of', chalk.cyan(manifest.name),
    'as', chalk.cyan("dist/" + distFilename)
  );
});

// Cleans build and dist dirs
// I sense a bug here!
gulp.task('clean', ["announce"], function() {
  return gulp.src(['build/**'], {read: false})
  .pipe(rm({async: false}));
});

// ESLINT the javascript BEFORE uglifier ran over them
gulp.task('lint', function () {
  return gulp.src(['src/js/**/*.js'])
  .pipe(eslint())
  .pipe(eslint.format())
  .pipe(eslint.failOnError());
});

// Optimize CSS
gulp.task('css', ['clean'], function () {
  return gulp.src(["src/css/*.css", "!src/css/content.css", "!src/css/popup.css"])
  .pipe(replace(replaceOpts))
  .pipe(concat('formofill.css'))
  .pipe(minifyCSS())
  .pipe(gulp.dest('build/css/'));
});

// Build global.js
// Sadly until I use require.js here the order is important :(
gulp.task('globalJs', ['clean'], function () {
  return gulp.src([
    "src/js/global/utils.js",
    "src/js/global/jsonf.js",
    "src/js/global/storage.js",
    "src/js/global/rule.js",
    "src/js/global/rules.js",
    "src/js/global/i18n.js",
    "src/js/global/libs.js"
  ])
  .pipe(replace(replaceOpts))
  .pipe(concat('global.js'))
  .pipe(stripdebug())
  .pipe(uglify())
  .pipe(gulp.dest('build/js/'));
});

// Build background.js
gulp.task('backgroundJs', ['clean'], function () {
  return gulp.src("src/js/background/*.js")
  .pipe(replace(replaceOpts))
  .pipe(concat('background.js'))
  .pipe(stripdebug())
  .pipe(uglify())
  .pipe(gulp.dest('build/js/'));
});

// Build content.js
gulp.task('contentJs', ['clean'], function () {
  return gulp.src("src/js/content/*.js")
  .pipe(replace(replaceOpts))
  .pipe(concat('content.js'))
  .pipe(stripdebug())
  .pipe(uglify())
  .pipe(gulp.dest('build/js/'));
});

// Build options.js
gulp.task('optionsJs', ['clean'], function () {
  return gulp.src(["src/js/options/*.js", "!src/js/options/logs.js"])
  .pipe(replace(replaceOpts))
  .pipe(concat('options.js'))
  .pipe(stripdebug())
  .pipe(uglify())
  .pipe(gulp.dest('build/js/'));
});

// Build popup.js
gulp.task('popupJs', ['clean'], function () {
  return gulp.src("src/js/popup.js")
  .pipe(replace(replaceOpts))
  .pipe(stripdebug())
  .pipe(uglify())
  .pipe(gulp.dest('build/js'));
});

// Copies files that can be copied without changes
gulp.task('copyUnchanged', ['clean'],  function() {
  ["fonts", "images", "vendor", "_locales"].forEach(function (dir) {
    gulp.src('src/' + dir + '/**/*')
    .pipe(gulp.dest('build/' + dir));
  });

  return gulp.src(['src/css/content.css', 'src/css/popup.css'])
  .pipe(minifyCSS())
  .pipe(replace(replaceOpts))
  .pipe(gulp.dest('build/css'));
});

// Copies HTML files and removes comment and blocks (see above)
gulp.task('copyHtml', ['copyUnchanged'],  function() {
  return gulp.src(['src/html/**/*.html', '!src/html/option/_logs_*.html'])
  .pipe(replace(replaceOpts))
  .pipe(cleanhtml())
  .pipe(gulp.dest('build/html'));
});

// Copies and replaces the manifest.json file (see above)
gulp.task('mangleManifest', [ 'clean' ], function() {
  return gulp.src('src/manifest.json')
  .pipe(replace(replaceOpts))
  .pipe(gulp.dest('build'));
});

// Build a distribution
gulp.task('build', ['announce', 'clean', 'test', 'lint', 'copyHtml', 'css', 'globalJs', 'backgroundJs', 'contentJs', 'optionsJs', 'popupJs', 'mangleManifest'], function() {
  gulp.src(['build/**'])
  .pipe(zip(distFilename))
  .pipe(gulp.dest('dist'));
});

// Run tests
gulp.task('test', function () {
  gulpUtil.log('Running tests');
  return runTests().on('error', function (e) {
    throw e;
  });
});

// Run tests through watching
gulp.task('watch', function () {
  gulp.watch(['src/js/**/*.js', 'test/**/*.js'], runTests);
});


// Integration testing(end-to-end)
// Uses protractor as an abstraction layer over chromedriver
// Chromedriver can be used without a running selenium server
// Starts a simple webserver on port 8888
//
// You can specify a single spec to run via:
// gulp integration --spec test/integration/some_spec_scene.js
gulp.task('integration', function () {

  gulpUtil.log(
    "If this fails with",
    chalk.cyan("[launcher] Error: Could not find chromedriver"),
    "run",
    chalk.cyan("node_modules/protractor/bin/webdriver-manager update")
  );

  // Start a small webserver
  connect.server(serverConfigIntegration);

  var specs = [argv.spec || argv.s || "./test/integration/*_scene.js"];

  return gulp.src(["./test/support/integration_helper.js"].concat(specs))
  .pipe(protractor({
      configFile: "test/support/protractor.config.js",
      args: ['--baseUrl', 'http://127.0.0.1:' + serverConfigIntegration.port]
  }))
  .on('error', function(e) {
    throw e
  })
  .on('end', function() {
    connect.serverClose();
  });
});

// Start server for testing purposes
gulp.task('server', function() {
  connect.server(serverConfig);
});

// Updates the selenium stuff in node_modules
gulp.task('webdriver_update', webdriverUpdate);

// running "gulp" will execute this
gulp.task('default', function () {
  runTests();
});
