/*global jQuery, Utils, Logger */
var logsInterval;

var displayLogs = function() {
  var showLastEntries = 25;
  var logTable = document.querySelector(".log-entries table");
  var logRow = document.querySelector("#logEntryTpl");
  var logCells = logRow.content.querySelectorAll("td");
  var logBody = logTable.querySelector("tbody");
  var clone;

  Logger.load().then(function (logEntries) {
    logTable.querySelector("tbody").textContent = "";
    logEntries.slice(showLastEntries * -1).reverse().forEach(function (logEntry) {
      logCells[0].textContent = logEntry.createdAt;
      logCells[1].textContent = logEntry.location;
      logCells[2].textContent = logEntry.message;
      clone = document.importNode(logRow.content, true);
      logBody.appendChild(clone);
    });
  });
};
