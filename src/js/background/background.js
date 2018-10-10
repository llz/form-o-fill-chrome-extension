/*global Rules Logger Utils FormUtil Notification JSONF Storage Testing createCurrentPopupInIframe Workflows Libs RemoteImport Alarm state Badge Screenshooter */
/* eslint complexity:0, max-nested-callbacks: [1,6] */
var lastMatchingRules = [];
var totalMatchesCount = 0;
var runWorkflowOrRule;
var recheckInterval = null;
var badge = new Badge();
var screenshooter = new Screenshooter();
var badgeInterval = null;

// Testcode: Fill testing HTML with macthing rules
var reportMatchingRulesForTesting = function(matchingRules, lastMatchingWorkflows) {
  /*eslint-disable max-nested-callbacks*/
  var mRule = matchingRules
    .map(function(rule) {
      return rule.prettyPrint();
    })
    .join(",");
  /*eslint-enable max-nested-callbacks*/
  Testing.setVar("matching-rules-count", matchingRules.length, "Matching rule #");
  Testing.setVar("matching-rules-text", "[" + mRule + "]", "Matching rules JSON");
  Testing.setVar("settings", JSONF.stringify(state.optionSettings), "Current settings");

  // If there is only one match we need something in the testpage to click on
  if (matchingRules.length + lastMatchingWorkflows.length === 1) {
    Testing.setVar(
      "popup-html",
      "<li class='select-rule' data-rule-name='" +
        matchingRules[0].name.replace(/[^a-zA-Z-]/g, "-").toLowerCase() +
        "'>" +
        matchingRules[0].name +
        "</li>",
      "Popup HTML (one match)"
    );
  }
};

// When the user changes a tab, search for matching rules for that url
// or matching rules for that content
var onTabReadyRules = function(tabId) {
  lastMatchingRules = [];

  // Clear popup HTML
  chrome.browserAction.setPopup({ tabId: tabId, popup: "" });
  Logger.info("[bg.js] onTabReadyRules on Tab " + tabId);

  chrome.tabs.get(tabId, function(tab) {
    // return if the tab isn't active anymore
    if (chrome.runtime.lastError || !tab.active || tab.url.indexOf("chrome") === 0) {
      return;
    }

    state.lastActiveTab = tab;
    Logger.info("[bg.js] Setting active tab", tab);

    // This is a little bit complicated.
    // I wish the chromium API would implement Promises for all that.
    Rules.all().then(function(rules) {
      // This happens only on the very first install:
      if (rules.length === 0) {
        // No rules present!
        Promise.all([Rules.lastMatchingRules([]), Workflows.saveMatches([])]).then(function() {
          chrome.browserAction.setPopup({ tabId: tab.id, popup: "html/popup.html" });
          badge.refreshMatchCounter(0);
          return;
        });
      }

      // First filter all rules that have content matchers
      var relevantRules = rules.filter(function(rule) {
        return typeof rule.content !== "undefined";
      });

      // Send these rules to the content script so it can return the matching
      // rules based on the regex and the pages content
      var message = { action: "matchContent", rules: JSONF.stringify(relevantRules) };
      chrome.tabs.sendMessage(tabId, message, function(matchingContentRulesIds) {
        var matchingContentRules = [];

        // If we found rules that match by content ...
        if (typeof matchingContentRulesIds !== "undefined") {
          // ... select rules that match those ids
          matchingContentRulesIds = JSONF.parse(matchingContentRulesIds);
          if (
            typeof matchingContentRulesIds !== "undefined" &&
            matchingContentRulesIds.length > 0
          ) {
            matchingContentRules = rules.filter(function(rule) {
              return matchingContentRulesIds.indexOf(rule.id) > -1;
            });

            // Add the rules to the rule that matches by url
            lastMatchingRules = lastMatchingRules.concat(matchingContentRules);
          }
        }
        Logger.info("[bg.js] Got " + matchingContentRules.length + " rules matching the content of the page");

        // Now match those rules that have a "url" matcher
        Rules.match(tab.url).then(function(matchingRules) {
          Logger.info("[bg.js] Got " + matchingRules.length + " rules matching the url of the page");

          // Concatenate matched rules by CONTENT and URL
          lastMatchingRules = Rules.unique(lastMatchingRules.concat(matchingRules));

          // Save rules to localStorage for popup to load
          Rules.lastMatchingRules(lastMatchingRules);

          // Now find and save the matching workflows for those rules
          Workflows.matchesForRules(lastMatchingRules).then(function prMatchingWfs(matchingWfs) {
            Workflows.saveMatches(matchingWfs);

            // Show matches in badge
            totalMatchesCount = lastMatchingRules.length + matchingWfs.length;
            badge.refreshMatchCounter(tab, totalMatchesCount);

            // TESTING
            if (!Utils.isLiveExtension()) {
              reportMatchingRulesForTesting(lastMatchingRules, matchingWfs);
            }

            // No matches? Multiple Matches? Show popup when the user clicks on the icon
            // A single match should just fill the form if "always show popup" is off (see below)
            if (
              totalMatchesCount !== 1 ||
              (typeof state.optionSettings !== "undefined" && state.optionSettings.alwaysShowPopup)
            ) {
              chrome.browserAction.setPopup({ tabId: tab.id, popup: "html/popup.html" });
              if (!Utils.isLiveExtension()) {
                createCurrentPopupInIframe(tab.id);
              }
            } else if (
              (lastMatchingRules[0].autorun === true ||
                parseInt(lastMatchingRules[0].autorun, 10) > 0) &&
              state.optionSettings.reevalRules
            ) {
              FormUtil.displayMessage(
                chrome.i18n.getMessage("bg_rule_reeval_autorun"),
                state.lastActiveTab
              );
            } else if (lastMatchingRules[0].autorun === true && !state.optionSettings.reevalRules) {
              // If the rule is marked as "autorun", execute the rule if only one was found.
              Logger.info("[bj.js] Rule is set to autorun true");

              // Set state -> rule was triggered via autorun
              state.ruleRuntime.triggered = "autorun";

              FormUtil.applyRule(lastMatchingRules[0], state.lastActiveTab);
            } else if (
              parseInt(lastMatchingRules[0].autorun, 10) > 0 &&
              !state.optionSettings.reevalRules
            ) {
              //
              // The autorun execution may be delayed by <param> msecs
              //

              // Set state -> rule was triggered via autorun
              state.ruleRuntime.triggered = "autorun";

              //TODO: Extract the autorun stuff to a function and make it available for workflow step delay (#107) (FS, 2018-10-04)
              var timeout = parseInt(lastMatchingRules[0].autorun, 10);
              Logger.info("[bj.js] Rule is set to autorun delay: " + timeout + " msec");

              // If the delay is more than 2 second show countdown.
              if (timeout >= 2000) {
                var badgeDelayMsec = timeout;
                if (badgeInterval !== null) {
                  clearInterval(badgeInterval);
                }
                badgeInterval = setInterval(function() {
                  badge.setText(
                    chrome.i18n.getMessage("bg_autorun_countdown", [
                      Math.ceil(badgeDelayMsec / 1000),
                    ]),
                    state.lastActiveTab.id
                  );
                  badgeDelayMsec -= 500;
                  if (badgeDelayMsec <= 0) {
                    clearInterval(badgeInterval);
                  }
                }, 500);
              }

              setTimeout(function() {
                // restore old badge text
                badge.refreshMatchCounter(tab, totalMatchesCount);
                // if interval is still set, clear it.
                if (badgeInterval !== null) {
                  clearInterval(badgeInterval);
                }
                FormUtil.applyRule(lastMatchingRules[0], state.lastActiveTab);
              }, timeout);
            }
          });
        });
      });
    });
  });
};

// Ends the current workflow
var endCurrentWorkflow = function(runningWorkflow, resolve) {
  FormUtil.displayMessage(chrome.i18n.getMessage("bg_workflow_finished"), state.lastActiveTab);
  Logger.info("[bg.js] workflow finished on rule " + (runningWorkflow.currentStep + 1) + " of " + runningWorkflow.steps.length);
  Storage.delete(Utils.keys.runningWorkflow);

  // Search for matching rules and workflows
  // to fill the icon again
  runWorkflowOrRule(state.lastActiveTab.id);
  state.forceRunOnLoad = false;

  resolve({ status: "finished", runRule: false });
};

// Load running workflow storage
// and run the next step
var onTabReadyWorkflow = function() {
  return new Promise(function(resolve) {
    Storage.load(Utils.keys.runningWorkflow).then(function prOnTabReadyWf(runningWorkflow) {
      // No running workflow?
      if (typeof runningWorkflow === "undefined" || !state.lastActiveTab) {
        resolve({ status: "not_running", runRule: true });
        return;
      }
      // Set state -> rule is running as part of workflow
      state.ruleRuntime.partOfWorkflow = true;

      // load rule for workflow step
      var ruleNameToRun = runningWorkflow.steps[runningWorkflow.currentStep];
      Logger.info("[background.js] Using workflow step # " + (runningWorkflow.currentStep + 1) + " (" + ruleNameToRun + ")");
      badge.setText("#" + (runningWorkflow.currentStep + 1), state.lastActiveTab.id);

      Rules.findByName(ruleNameToRun).then(function prExecWfStep(rule) {
        if (typeof rule === "undefined") {
          // report not found rule in options, cancel workflow
          FormUtil.displayMessage(chrome.i18n.getMessage("bg_workflow_error"), state.lastActiveTab);
          Storage.delete(Utils.keys.runningWorkflow);

          // Search for matching rules and workflows
          runWorkflowOrRule(state.lastActiveTab.id);

          resolve({ status: "rule_not_found", runRule: false });
        } else {
          // Should a screenshot be taken?
          if (runningWorkflow.flags && runningWorkflow.flags.screenshot === true) {
            Logger.info("[bg.js] setting rule.screenshot = true because Wf config said so");
            rule.screenshot = true;
          }

          // How long should we delay the execution of the workflow step
          var delayWorkflowStep = typeof runningWorkflow.delays === "undefined" ? 0 : parseInt(runningWorkflow.delays[runningWorkflow.currentStep] || 0, 10);
          var delayText = delayWorkflowStep > 0 ? "<br />Delaying " + delayWorkflowStep + " milliseconds" : "";

          // Fill with this rule
          FormUtil.displayMessage(
            chrome.i18n.getMessage("bg_workflow_step", [
              runningWorkflow.currentStep + 1,
              runningWorkflow.steps.length,
              delayText,
            ]),
            state.lastActiveTab
          );

          // Delay the execution of the step
          if (delayWorkflowStep > 0) {
            setTimeout(function() {
              FormUtil.applyRule(rule, state.lastActiveTab);
            }, delayWorkflowStep);
          } else {
            FormUtil.applyRule(rule, state.lastActiveTab);
          }

          // End of workflow reached?
          if (runningWorkflow.currentStep + 1 >= runningWorkflow.steps.length) {
            endCurrentWorkflow(runningWorkflow, resolve);
            return;
          }

          // Save workflow state so we can continue even after a page reload
          Storage.save(
            {
              currentStep: runningWorkflow.currentStep + 1,
              steps: runningWorkflow.steps,
              flags: runningWorkflow.flags,
              delays: runningWorkflow.delays,
            },
            Utils.keys.runningWorkflow
          ).then(function() {
            resolve({ status: "running_workflow", runRule: false });
          });
        }
      });

      // Running workflow! Don't run normal rules.
      resolve({ status: "running_workflow", runRule: false });
    });
  });
};

// Searches for workflows or rules to run
// Workflows steps are then run and subsequent matching rules are ignored
runWorkflowOrRule = function(tabId) {
  // First check (and run) workflows
  return onTabReadyWorkflow().then(function prOnTabReadyWf(workflowStatus) {
    // If a workflow step has been run, don't run rules
    // otherwise do run
    if (workflowStatus.runRule) {
      onTabReadyRules(tabId);
    }
  });
};

// This function manages the interval that is used if
// the user has "reeval-rules" checked in settings.
// It executes the rules matching every two seconds
var setCyclicRulesRecheck = function(shouldCheck) {
  if (recheckInterval) {
    clearInterval(recheckInterval);
    recheckInterval = null; // Collect it
    Logger.info("[bg.js] Deactivate interval for rule rechecking");
    badge.useBadgeBgColor = badge.defaultBadgeBgColor;
  }

  if (shouldCheck) {
    recheckInterval = setInterval(function() {
      if (state.lastActiveTab !== null) {
        runWorkflowOrRule(state.lastActiveTab.id);
      }
    }, Utils.reevalRulesInterval);
    Logger.info("[bg.js] Activate interval for rule rechecking");
    badge.useBadgeBgColor = badge.intervalBadgeBgColor;
  }

  // Set BG color now even if not rematching has been done
  if (state.lastActiveTab !== null) {
    badge.setBgColor(badge.useBadgeBgColor, state.lastActiveTab.id);
  }
};

// Fires when a tab becomes active (https://developer.chrome.com/extensions/tabs#event-onActivated)
chrome.tabs.onActivated.addListener(function(activeInfo) {
  if (state.optionSettings.dontMatchOnTabSwitch === false) {
    runWorkflowOrRule(activeInfo.tabId);
  }
});

// Fires when the URL changes (https://developer.chrome.com/extensions/tabs#event-onUpdated)
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo) {
  var checkOn = "loading";
  // May be set by options or running workflow
  if (state.optionSettings.matchOnLoad === true || state.forceRunOnLoad) {
    checkOn = "complete";
  }
  Logger.info("[bg.js] Matching rules/workflows on state " + checkOn + "(state.forceRunOnLoad = )" + state.forceRunOnLoad);

  // "complete" => onload event
  // "loading" => DOMContentLoader event
  if (changeInfo.status) {
    if (changeInfo.status === checkOn) {
      runWorkflowOrRule(tabId);
    } else if (changeInfo.status === "loading" && state.optionSettings.matchOnLoad === true) {
      // Waiting from DOMCOntentLoaded -> load event => show WAIT so the user knows FoF is working
      badge.setText(chrome.i18n.getMessage("bg_wait_until_load_event"), tabId);
    }
  }
});

// This event will only fire if NO POPUP is set
// This is the case when only one rule matches
chrome.browserAction.onClicked.addListener(function() {
  // Set state -> rule is triggered manually
  state.ruleRuntime.triggered = "manual";
  state.ruleRuntime.partOfWorkflow = false;

  FormUtil.applyRule(lastMatchingRules[0], state.lastActiveTab);
});

// Listen for messages from other background/popup scripts
// Also listens to messages from testcases
chrome.extension.onMessage.addListener(function(message, sender, sendResponse) {
  Logger.info("[bj.js] Received message " + JSONF.stringify(message));

  // From popup.js:
  // This receives the index of the rule to apply when there is more than one match
  if (message.action === "fillWithRule") {
    // Set state -> rule is triggered manually
    state.ruleRuntime.triggered = "manual";
    state.ruleRuntime.partOfWorkflow = false;

    Logger.info("[bg.js] called by popup.js with rule index " + message.index + ", id = " + message.id);
    // Find the rule by id
    var rules = lastMatchingRules.filter(function(rule) {
      return rule.id === message.id;
    });

    FormUtil.applyRule(rules[0], state.lastActiveTab);
    sendResponse(true);
  }

  // From popup.js:
  // Apply a workflow starting at the first step / rule
  if (message.action === "fillWithWorkflow") {
    // Set state -> rule is running as part of workflow
    state.ruleRuntime.triggered = "manual";
    state.ruleRuntime.partOfWorkflow = true;

    // Load previously saved matching workflows
    Workflows.findById(message.id).then(function prLoadMatches(matchingWf) {
      // Workflow steps can only run on "load" event
      // otherwise they will trigger when the page hasn't changed yet
      state.forceRunOnLoad = true;

      // Now save the steps of that workflow to the storage and
      // mark the current running workflow
      Storage.save(
        {
          currentStep: 0,
          steps: matchingWf.steps,
          flags: matchingWf.flags,
          delays: matchingWf.delays,
        },
        Utils.keys.runningWorkflow
      ).then(function() {
        onTabReadyWorkflow();
      });
    });
    sendResponse(true);
  }

  // Open an intern URL (aka. options).
  // Callable by content script that otherwise isn't allowed to open intern urls.
  if (message.action === "openIntern" && message.url) {
    Logger.info("[bg.js] received 'openIntern' with url '" + message.url + "'");
    chrome.tabs.create({ active: true, url: message.url });
  }

  // Display a notification to the user that the extract has finished
  if (message.action === "extractFinishedNotification") {
    Logger.info("[bg.js] received 'extractFinishedNotification'");
    Notification.create(
      chrome.i18n.getMessage("notification_form_extraction_done"),
      null,
      Utils.openOptions
    );
  }

  // Return the last active tab id
  if (message.action === "lastActiveTabId" && state.lastActiveTab !== null) {
    Logger.info("[bg.js] received 'lastActiveTabId'. Sending tabId " + state.lastActiveTab.id);
    sendResponse(state.lastActiveTab.id);
  }

  // received from options.js to reload Libs
  if (message.action === "reloadLibs") {
    // Why reload libs? If the user changes a tab containing a library definition
    // we must update it before the user executes a rule
    // Otherwise the new function won't be found
    // This is only useful for library functions used in before functions since those are
    // evaluated in the context of the background page
    Logger.info("[bg.js] received reloadLibs from content.js");
    Libs.import();
  }

  // Toggle rematch mode on/off
  if (message.action === "testToggleRematch") {
    state.optionSettings.reevalRules = !state.optionSettings.reevalRules;
    setCyclicRulesRecheck(state.optionSettings.reevalRules);
  }
});

// Saves settings changed by popup or settings page
// See calls there (bgWindow.setSettings)
/*eslint-disable no-unused-vars */
var setSettings = function(settings, value) {
  // First form key => value
  if (typeof value !== "undefined") {
    state.optionSettings[settings] = value;
  } else {
    // Second form: set all
    state.optionSettings = settings;
  }

  // Save settings
  Storage.save(state.optionSettings, Utils.keys.settings);

  // Set cyclic refresh if neccessary
  setCyclicRulesRecheck(state.optionSettings.reevalRules);

  Testing.setVar("settings", JSONF.stringify(state.optionSettings), "Current settings");
  Logger.info("[bg.js] Settings set to " + JSONF.stringify(state.optionSettings));

  // Tell options page to reload the settings
  chrome.runtime.sendMessage({ action: "reloadSettings" });
};
/*eslint-enable no-unused-vars */

// Loads settings from storage
var loadSettings = function() {
  // Load the settings and default them if not saved before
  Storage.load(Utils.keys.settings).then(function(settings) {
    Logger.info("[bg.js] loading settings : " + JSONF.stringify(settings));
    if (typeof settings === "undefined") {
      settings = Utils.defaultSettings;
    }

    state.optionSettings = settings;

    // Turn rematch on/off
    setCyclicRulesRecheck(state.optionSettings.reevalRules);
  });
};

// Triggered when update of remote rules was successful
var remoteRulesImportSuccess = function(resolved) {
  Logger.info("[bg.js] Updating remote rules SUCCEEDED");
  RemoteImport.save(resolved.data);
};

// Triggered when update of remote rules was failed
var remoteRulesImportFail = function() {
  Logger.warn("[bg.js] Updating remote rules FAILED");
  Notification.create(
    chrome.i18n.getMessage("notification_remote_import_failed"),
    null,
    function() {
      Utils.openOptions("#settings");
    }
  );
};

// Update remote rules if options are set correctly
var executeRemoteImport = function() {
  if (
    typeof state.optionSettings !== "undefined" &&
    state.optionSettings.importActive === true &&
    state.optionSettings.importUrl.indexOf("http") > -1
  ) {
    Logger.info("[bg.js] Alarm triggered update of remote rules");
    RemoteImport.import(state.optionSettings.importUrl)
      .then(remoteRulesImportSuccess)
      .catch(remoteRulesImportFail);
  }
};

// This is triggered when the set interval (eg. every 15 minutes) has expired
var alarmListener = function(alarm) {
  if (alarm.name !== Utils.alarmName) {
    return;
  }
  Logger.info("[bg.js] Alarm triggered");
  executeRemoteImport();
};

// Initializes extension
var initializeExtension = function() {
  loadSettings();

  // This will trigger a re-import of the remote rules set in settings
  Alarm.create();

  // re-import remote rules
  executeRemoteImport();
};

// REMOVE START
// Debug Messages from content.js
chrome.runtime.onConnect.addListener(function(port) {
  port.onMessage.addListener(function(message) {
    if (message.action === "log" && message.message) {
      Logger.store(message.message);
    }
  });
});
// REMOVE END

// Listen for messages from content.js
chrome.runtime.onMessage.addListener(function(message) {
  // REMOVE START
  if (message.action === "log" && message.message) {
    Logger.store(message.message);
  }
  // REMOVE END

  // The content page (form_filler.js) requests a screenshot to be taken
  // the message.flag can be the filename or true/false
  if (message.action === "takeScreenshot" && typeof message.flag !== "undefined") {
    Logger.info("[bg.js] Request from content.js to take a screenshot of windowId " + state.lastActiveTab.windowId);
    screenshooter.takeScreenshot(state.lastActiveTab.windowId, message.value, message.flag);
  }
});

// When the extension is activated:
chrome.runtime.onStartup.addListener(function() {
  Logger.info("[bg.js] chrome.runtime.onStartup triggered");
  initializeExtension();
});

// Listen to alarms (import remote rules)
chrome.alarms.onAlarm.addListener(alarmListener);

// install listener for remote rules import requests
RemoteImport.listenToExternal();

// install listener for messages from content page while filling forms
FormUtil.listenForContentMessages();

// Initialize extension
// Needs to be here so chrome can safely unload and restore the extensions BG script
initializeExtension();
