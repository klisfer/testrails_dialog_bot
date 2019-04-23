const dotenv = require("dotenv");
const Bot = require("@dlghq/dialog-bot-sdk");
const Rpc = require("@dlghq/dialog-bot-sdk");
const {
  MessageAttachment,
  ActionGroup,
  Action,
  Button,
  Select,
  SelectOption
} = require("@dlghq/dialog-bot-sdk");
const { flatMap } = require("rxjs/operators");
const axios = require("axios");
const { merge } = require("rxjs");
const moment = require("moment");
var _ = require("lodash");
var Testrail = require("testrail-api");

var currentTestCaseCounter = 0;
var currentProjectId = "";
const currentUser = { name: "", peer: "" };
var availableSuites = [];
var availableTestCases = [];
var availableStatuses = [];
var availableProjects = [];
var testrail = new Testrail({
  host: process.env.TEST_RAILS_HOST,
  user: process.env.TEST_RAILS_USER,
  password: process.env.TEST_RAILS_PASS
});

dotenv.config();
const stasusesButtonOptions = [];

//token to connect to the bot
const token = process.env.BOT_TOKEN;
if (typeof token !== "string") {
  throw new Error("BOT_TOKEN env variable not configured");
}

//bot endpoint
const endpoint =
  process.env.BOT_ENDPOINT || "https://grpc-test.transmit.im:9443";

// async function run(token, endpoint) {
const bot = new Bot.default({
  token,
  endpoints: [endpoint]
});

//fetching bot name
const self = bot
  .getSelf()
  .then(response => {
    console.log(`I've started, post me something @${response.nick}`);
  })
  .catch(err => console.log(err));

bot.updateSubject.subscribe({
  next(update) {
    // console.log(JSON.stringify({ update }, null, 2));
  }
});

bot.ready.then(response => {
  //mapping the current user
  response.dialogs.forEach(peer => {
    if (peer.type === "private") {
      getCurrentUser(bot, peer);
    }
  });
  getAvailableStatuses();
});

/*  -----


subscribing to incoming messages


------ */

const messagesHandle = bot.subscribeToMessages().pipe(
  flatMap(async message => {
    if (message.content.text === "/start") {
      await testrail
        .getProjects()
        .then(function(result) {
          console.log(result.body);
          sendTextMessage("Available Projects", projectsToAction(result.body));
        })
        .catch(function(error) {
          console.log(error.message);
        });
    }
    console.log("Bot has been connected");
  })
);

//creating action handle
const actionsHandle = bot.subscribeToActions().pipe(
  flatMap(async event => {
    console.log("event", event);
    if (event.id === "projects") {
      console.log("EVENT", event);
      const projectId = _.find(availableProjects, ["name", event.value]);
      currentProjectId = projectId.id;
      getSuites();
    } else if (event.id === "suites") {
      const suiteId = _.find(availableSuites, ["name", event.value]);
      const addRunData = { suite_id: suiteId.id, name: "test_run" };
      testrail
        .addRun(currentProjectId, addRunData)
        .then(function(result) {
          getTestCases(result);
        })
        .catch(function(error) {
          console.log("error", error.message);
        });
    } else {
      const testId = availableTestCases[currentTestCaseCounter - 1].id;
      availableTestCases[currentTestCaseCounter - 1].status_id = Number(
        event.id
      );
      await testrail
        .addResult(testId, { status_id: Number(event.id) })
        .then(function(result) {
          sendTextMessage(
            `Status Updated for Test Case ${
              availableTestCases[currentTestCaseCounter - 1].title
            }`
          );
        })
        .catch(function(error) {
          console.log(error.message);
        });
      if (currentTestCaseCounter < availableTestCases.length) {
        addResult(availableTestCases[currentTestCaseCounter]);
      } else {
        testrail
          .closeRun(currentProjectId)
          .then(function(result) {
            console.log("Run Closed");
          })
          .catch(function(error) {
            console.log(error.message);
          });
      }
    }
  })
);

// merging actionHandle with messageHandle
new Promise((resolve, reject) => {
  merge(messagesHandle, actionsHandle).subscribe({
    error: reject,
    complete: resolve
  });
})
  .then(response => console.log(response))
  .catch(err => console.log(err));

/* -------

action handle functions

------ */

function getTestCases(result) {
  testrail
    .getTests(result.body.suite_id)
    .then(result => {
      availableTestCases = result.body;
      if (availableTestCases.length !== 0) addResult(availableTestCases[0]);
      console.log("availableTestCases", availableTestCases);
    })
    .catch(function(error) {
      console.log("error", error.message);
    });
}

function addResult(test) {
  console.log(test);
  console.log("reached 2");
  sendTextMessage(
    `Select result to add for ${test.title}`,
    stasusesButtonOptions
  );
  currentTestCaseCounter += 1;
  // sendTextMessage("Step Added");
}

async function getAvailableStatuses() {
  await testrail
    .getStatuses()
    .then(result => {
      availableStatuses = result.body;
      console.log("statuses", result.body);
    })
    .catch(function(error) {
      console.log("error", error.message);
    });

  availableStatuses.map(status => {
    const buttonOption = { type: "button", id: status.id, label: status.label };
    stasusesButtonOptions.push(buttonOption);
  });
}

/* -------

message handle functions

------ */

//general functions
function selectOptionFormat(options) {
  var selectOptions = [];
  options.map(option => {
    selectOptions.push(new SelectOption(option.label, option.value));
  });

  return selectOptions;
}

//actionOptions is an array of format [{type:"", id: "", label: "", options: ""}]
function actionFormat(actionOptions) {
  var actions = [];
  actionOptions.map(options => {
    if (options.type === "select") {
      const selectOptions = selectOptionFormat(options.options);

      var action = Action.create({
        id: options.id,
        widget: Select.create({
          label: options.label,
          options: selectOptions
        })
      });

      actions.push(action);
    } else if (options.type === "button") {
      var action = Action.create({
        id: options.id,
        widget: Button.create({ label: options.label })
      });

      actions.push(action);
    }
  });

  return actions;
}

//actions is an array of format [{type:"" , id: "" , label: "" , options: ""}]
function sendTextMessage(text, actions) {
  var messageToSend = messageformat(currentUser.peer, text);
  var action = actions || null;
  var actionGroup = null;
  if (action !== null) {
    actionGroup = ActionGroup.create({
      actions: actionFormat(action)
    });
  }
  sendTextToBot(bot, messageToSend, actionGroup);
}

function messageformat(peers, texts) {
  var message = { peer: peers, text: texts };
  return message;
}

function sendTextToBot(bot, message, actionGroup) {
  console.log(actionGroup);
  var actionGroups = actionGroup || null;
  bot
    .sendText(
      message.peer,
      message.text,
      MessageAttachment.reply(null),
      actionGroups
    )
    .then(response => console.log(response))
    .catch(err => console.log("err", err));
}

async function getCurrentUser(bot, peer) {
  const user = await bot.getUser(peer.id);
  currentUser.name = user.name;
  currentUser.peer = peer;
}

function suitesToAction(suites) {
  var suiteActions = {
    type: "select",
    id: "suites",
    label: "suite",
    options: []
  };
  suites.map(suite => {
    availableSuites.push(suite);
    suiteActions.options.push({ label: suite.name, value: suite.name });
  });
  const suiteActionsArray = [suiteActions];
  return suiteActionsArray;
}

function projectsToAction(projects) {
  var projectActions = {
    type: "select",
    id: "projects",
    label: "projects",
    options: []
  };
  projects.map(project => {
    availableProjects.push(project);
    projectActions.options.push({ label: project.name, value: project.name });
  });
  const projectsActionsArray = [projectActions];
  return projectsActionsArray;
}

function getSuites() {
  const project = _.find(availableProjects, ["id", currentProjectId]);
  console.log("PROJECT ID", availableProjects, project);
  testrail
    .getSuites(currentProjectId)
    .then(function(result) {
      sendTextMessage(
        `Available Suites in ${project.name}`,
        suitesToAction(result.body)
      );
    })
    .catch(function(error) {
      console.log("error", error.message);
    });
}
