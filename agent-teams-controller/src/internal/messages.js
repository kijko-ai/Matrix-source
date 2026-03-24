const messageStore = require('./messageStore.js');

function sendMessage(context, flags) {
  return messageStore.sendInboxMessage(context.paths, flags);
}

function appendSentMessage(context, flags) {
  return messageStore.appendSentMessage(context.paths, flags);
}

function lookupMessage(context, messageId) {
  return messageStore.lookupMessage(context.paths, messageId);
}

module.exports = {
  appendSentMessage,
  lookupMessage,
  sendMessage,
};
